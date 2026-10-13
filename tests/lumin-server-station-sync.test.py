"""Integration test suite for lumin-server-station sync engine and server."""

import atexit
import io
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.parse
from pathlib import Path
from unittest.mock import patch
from werkzeug.serving import make_server

BASE_DIR = Path(__file__).resolve().parents[1] / "lumin-server-station"
import sys
sys.path.insert(0, str(BASE_DIR))

from file_sync import (
    SyncEngine, SyncError, ALLOWED_IMAGE_EXTENSIONS, ALLOWED_SCAN_EXTENSIONS,
    SYNC_ALLOWED_EXTENSIONS, PROTOCOL
)
# Module initialization must never create directories in real clinic storage.
_bootstrap = tempfile.TemporaryDirectory()
atexit.register(_bootstrap.cleanup)
_bootstrap_config = Path(_bootstrap.name) / "config.json"
_bootstrap_config.write_text(json.dumps({"storage_path": str(Path(_bootstrap.name) / "patients"), "clinic_secret_key": "fixture-key-" + "x" * 32}))
with patch.dict(os.environ, {"LUMIN_STORAGE_CONFIG": str(_bootstrap_config)}):
    import server


class TestLuminServerStationSync(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.base = Path(self.temp_dir.name)

    def test_extension_filtering(self):
        root = self.base / "storage"
        root.mkdir()
        state = self.base / "state"

        patient_dir = root / "P100_John_Doe" / "Panoramic"
        patient_dir.mkdir(parents=True)
        (patient_dir / "pano.jpg").write_bytes(b"image-data")
        (patient_dir / "note.json").write_bytes(b"{}")

        scans_dir = root / "P100_John_Doe" / "3D-Scans"
        scans_dir.mkdir(parents=True)
        (scans_dir / "upper.zip").write_bytes(b"scan-zip-data")
        (scans_dir / "loose.stl").write_bytes(b"loose-stl-data")
        (scans_dir / "model.obj").write_bytes(b"loose-obj-data")

        engine = SyncEngine(root, state)
        scanned = engine.scan()
        scanned_paths = [rec["path"] for rec in scanned.values()]

        self.assertIn("P100_John_Doe/Panoramic/pano.jpg", scanned_paths)
        self.assertIn("P100_John_Doe/3D-Scans/upper.zip", scanned_paths)
        self.assertNotIn("P100_John_Doe/Panoramic/note.json", scanned_paths)
        self.assertNotIn("P100_John_Doe/3D-Scans/loose.stl", scanned_paths)
        self.assertNotIn("P100_John_Doe/3D-Scans/model.obj", scanned_paths)

    def test_two_node_peer_replication(self):
        """Simulate two nodes and perform two-way synchronization."""
        node0_root = self.base / "node0" / "patients"
        node0_root.mkdir(parents=True)
        node0_state = self.base / "node0" / "state"

        node1_root = self.base / "node1" / "patients"
        node1_root.mkdir(parents=True)
        node1_state = self.base / "node1" / "state"

        # Create files on Node 0
        p0_pano = node0_root / "P200_Alice" / "Panoramic"
        p0_pano.mkdir(parents=True)
        (p0_pano / "pano_01.jpg").write_bytes(b"patient-alice-pano-bytes")

        p0_scan = node0_root / "P200_Alice" / "3D-Scans"
        p0_scan.mkdir(parents=True)
        (p0_scan / "scan_arch.zip").write_bytes(b"patient-alice-scan-zip-bytes")
        (p0_scan / "loose_ignore.stl").write_bytes(b"should-not-sync")

        # Create file on Node 1
        p1_pa = node1_root / "P201_Bob" / "Periapical"
        p1_pa.mkdir(parents=True)
        (p1_pa / "tooth_14.png").write_bytes(b"patient-bob-pa-bytes")

        # Start two in-process HTTP servers
        engine0 = SyncEngine(node0_root, node0_state)
        engine1 = SyncEngine(node1_root, node1_state)

        # Build two lightweight Flask apps
        from flask import Flask
        app0 = Flask("node0")
        app1 = Flask("node1")

        server.install_sync_routes(app0, lambda: engine0, lambda auth: None)
        server.install_sync_routes(app1, lambda: engine1, lambda auth: None)

        srv0 = make_server("127.0.0.1", 0, app0)
        srv1 = make_server("127.0.0.1", 0, app1)

        t0 = threading.Thread(target=srv0.serve_forever, daemon=True)
        t1 = threading.Thread(target=srv1.serve_forever, daemon=True)
        t0.start()
        t1.start()
        self.addCleanup(srv0.shutdown)
        self.addCleanup(srv1.shutdown)

        url0 = f"http://127.0.0.1:{srv0.server_port}"
        url1 = f"http://127.0.0.1:{srv1.server_port}"

        # Pairing/transport fixture stubs administrator verification; security tests cover the real guard.
        pair_req = urllib.request.Request(
            f"{url0}/api/sync/pair",
            data=json.dumps({"url": url1, "key": "test"}).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-lumin-key": "test"}
        )
        with urllib.request.urlopen(pair_req) as resp:
            data = json.load(resp)
            self.assertTrue(data.get("paired"))

        # Trigger sync job on Node 0
        job_req = urllib.request.Request(
            f"{url0}/api/sync/jobs",
            headers={"Authorization": "Bearer test"},
            method="POST"
        )
        with urllib.request.urlopen(job_req) as resp:
            job = json.load(resp)
            self.assertEqual(job.get("status"), "running")

        # Poll until finished
        for _ in range(50):
            time.sleep(0.1)
            poll_req = urllib.request.Request(
                f"{url0}/api/sync/jobs/latest",
                headers={"Authorization": "Bearer test"}
            )
            with urllib.request.urlopen(poll_req) as resp:
                status = json.load(resp).get("job", {}).get("status")
                if status in ("completed", "completed_with_conflicts", "failed"):
                    break

        self.assertEqual(status, "completed")

        # Verify Node 1 received Node 0's files (pano.jpg and scan.zip)
        self.assertTrue((node1_root / "P200_Alice" / "Panoramic" / "pano_01.jpg").exists())
        self.assertTrue((node1_root / "P200_Alice" / "3D-Scans" / "scan_arch.zip").exists())
        self.assertFalse((node1_root / "P200_Alice" / "3D-Scans" / "loose_ignore.stl").exists())

        # Verify Node 0 received Node 1's file (tooth_14.png)
        self.assertTrue((node0_root / "P201_Bob" / "Periapical" / "tooth_14.png").exists())


if __name__ == "__main__":
    unittest.main()
