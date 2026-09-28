"""Offline regression tests: no public tunnel or clinic database writes."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    "tunnel_sync", Path(__file__).resolve().parents[1] / "storage-server" / "tunnel_sync.py")
tunnel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tunnel)

URL = "https://test-clinic.trycloudflare.com"
ORIGIN = "http://127.0.0.1:5055"


def fake_process(lines, exit_code=1):
    process = Mock()
    process.stdout = io.StringIO("".join(lines))
    process.poll.return_value = None
    process.wait.return_value = exit_code
    return process


class StorageTunnelTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        self.base_patch = patch.object(tunnel, "BASE_DIR", self.base)
        self.base_patch.start()
        self.addCleanup(self.base_patch.stop)
        self.output = io.StringIO()
        self.output_patch = contextlib.redirect_stdout(self.output)
        self.output_patch.__enter__()
        self.addCleanup(self.output_patch.__exit__, None, None, None)

    def run_process(self, process, protocol="auto", health=True, sync_url=True, **kwargs):
        with patch.object(tunnel.subprocess, "Popen", return_value=process) as spawn, \
                patch.object(tunnel, "check_server_running", return_value=health) as check, \
                patch.object(tunnel, "sync_url_to_supabase", return_value=True) as sync:
            result = tunnel.run_tunnel(ORIGIN, protocol, sync_url=sync_url, **kwargs)
        return result, spawn, check, sync

    def test_configured_port_is_used(self):
        config_file = self.base / "config.json"
        config_file.write_text('{"port": 5055}', encoding="utf-8")
        with patch.object(tunnel, "CONFIG_FILE", config_file):
            self.assertEqual(tunnel.load_origin_url(), ORIGIN)
            config_file.write_text('{"port": 70000}', encoding="utf-8")
            with self.assertRaises(ValueError):
                tunnel.load_origin_url()

    def test_health_rejects_unrelated_service(self):
        response = Mock(status=200)
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = json.dumps({"status": "online", "service": "Other App"}).encode()
        with patch.object(tunnel.urllib.request, "urlopen", return_value=response):
            self.assertFalse(tunnel.check_server_running(ORIGIN))
            response.read.return_value = json.dumps(
                {"status": "online", "service": "Lumin Local Storage Server"}).encode()
            self.assertTrue(tunnel.check_server_running(ORIGIN))

    def test_allocated_url_is_not_published_before_registration(self):
        process = fake_process([URL + "\n", "ERR failed to connect\n"])
        result, spawn, check, sync = self.run_process(process)
        self.assertEqual(result, 1)
        check.assert_not_called()
        sync.assert_not_called()
        self.assertIn(ORIGIN, spawn.call_args.args[0])
        self.assertIn("ERR failed to connect", (self.base / "tunnel.log").read_text())

    def test_unreachable_registered_tunnel_is_not_published(self):
        process = fake_process([URL + "\n", "INF Registered tunnel connection\n"])
        result, _, check, sync = self.run_process(process, health=False)
        self.assertEqual(result, 1)
        check.assert_called_once_with(URL)
        sync.assert_not_called()

    def test_logs_continue_after_verified_url_is_published(self):
        process = fake_process([URL + "\n", "INF Registered tunnel connection\n",
                                "ERR later connection failure\n"], exit_code=7)
        result, _, check, sync = self.run_process(process)
        self.assertEqual(result, 7)
        check.assert_called_once_with(URL)
        sync.assert_called_once_with(URL)
        self.assertIn("ERR later connection failure", (self.base / "tunnel.log").read_text())
        self.assertIn("exit code 7", self.output.getvalue())
        process.terminate.assert_called_once()

    def test_quic_failure_requests_http2_retry_without_syncing(self):
        process = fake_process([URL + "\n", "ERR Failed to dial a quic connection: timeout\n"])
        result, _, _, sync = self.run_process(process)
        self.assertEqual(result, "http2")
        sync.assert_not_called()
        process.terminate.assert_called_once()

    def test_real_child_output_is_drained_after_startup(self):
        # Enough output to fill a Windows pipe if the reader stops after the URL.
        child_code = (f"print({URL!r}, flush=True); "
                      "print('INF Registered tunnel connection', flush=True); "
                      "[print('INFO after startup ' + 'x' * 100) for _ in range(2000)]; "
                      "print('ERR final failure', flush=True); raise SystemExit(6)")
        real_spawn = subprocess.Popen

        def spawn_child(*args, **kwargs):
            return real_spawn([sys.executable, "-u", "-c", child_code], **kwargs)

        with patch.object(tunnel.subprocess, "Popen", side_effect=spawn_child), \
                patch.object(tunnel, "check_server_running", return_value=True), \
                patch.object(tunnel, "sync_url_to_supabase", return_value=True):
            self.assertEqual(tunnel.run_tunnel(ORIGIN, "auto"), 6)
        self.assertIn("ERR final failure", (self.base / "tunnel.log").read_text())

    def test_http2_failure_is_reported_without_retry_loop(self):
        process = fake_process(["ERR DialContext error: dial tcp :7844 i/o timeout\n"])
        result, spawn, _, sync = self.run_process(process, protocol="http2")
        self.assertEqual(result, 1)
        self.assertIn("http2", spawn.call_args.args[0])
        sync.assert_not_called()

    def test_standalone_tunnel_does_not_write_database(self):
        process = fake_process([URL + "\n", "INF Registered tunnel connection\n"])
        _, _, check, sync = self.run_process(process, sync_url=False)
        check.assert_called_once_with(URL)
        sync.assert_not_called()

    def test_server_crash_prevents_tunnel_start(self):
        server = Mock(returncode=2)
        server.poll.return_value = 2
        with patch.object(tunnel, "check_server_running") as check:
            self.assertFalse(tunnel.wait_for_server(server, ORIGIN))
        check.assert_not_called()
        self.assertIn("server.log", self.output.getvalue())

    def test_startup_timeout_stops_tunnel(self):
        process = fake_process([URL + "\n"])
        result, _, _, sync = self.run_process(process, timeout=0)
        self.assertEqual(result, 1)
        sync.assert_not_called()
        process.terminate.assert_called_once()

    def test_main_retries_once_over_http2_and_preserves_existing_server(self):
        with patch.object(tunnel, "load_origin_url", return_value=ORIGIN), \
                patch.object(tunnel, "load_clinic_key"), \
                patch.object(tunnel, "check_server_running", return_value=True), \
                patch.object(tunnel, "run_tunnel", side_effect=["http2", 4]) as run, \
                patch.object(tunnel.subprocess, "Popen") as spawn:
            self.assertEqual(tunnel.main([]), 4)
        self.assertEqual([call.args[1] for call in run.call_args_list], ["auto", "http2"])
        spawn.assert_not_called()

    def test_tunnel_only_requires_running_storage_server(self):
        with patch.object(tunnel, "load_origin_url", return_value=ORIGIN), \
                patch.object(tunnel, "load_clinic_key"), \
                patch.object(tunnel, "check_server_running", return_value=False), \
                patch.object(tunnel, "run_tunnel") as run, \
                patch.object(tunnel.subprocess, "Popen") as spawn:
            self.assertEqual(tunnel.main(["--tunnel-only"]), 1)
        run.assert_not_called()
        spawn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
