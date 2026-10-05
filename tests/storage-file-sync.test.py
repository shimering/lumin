"""Disposable two-server integration tests. Never reads real patient storage."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from werkzeug.serving import make_server

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / 'storage-server'))
from file_sync import SyncEngine, SyncError, safe_path, json_request, normalise_url


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.modules, self.engines, self.urls, self.keys = [], [], [], []
        for index in range(2):
            root = self.base / str(index) / 'patients'
            root.mkdir(parents=True)
            config = self.base / ('config%s.json' % index)
            config.write_text(json.dumps({'storage_path': str(root), 'clinic_secret_key': 'key-%s' % index,
                                          'sync_state_path': str(root.parent / 'private')}))
            spec = importlib.util.spec_from_file_location('test_storage_%s' % index, BASE / 'storage-server/server.py')
            module = importlib.util.module_from_spec(spec)
            with patch.dict(os.environ, {'LUMIN_STORAGE_CONFIG': str(config)}):
                spec.loader.exec_module(module)
            # Endpoint tests exercise file/sync behavior without racing background SQL exports.
            module.update_storage_mapping_files = lambda: {}

            def auth_json(url, method='GET', headers=None, data=None):
                if (headers or {}).get('Authorization') != 'Bearer admin':
                    raise SyncError('Expired token', 401)
                if '/auth/v1/user' in url:
                    return {'id': 'admin-user'}
                if '/rest/v1/user_profiles?' in url:
                    return [{'active': True, 'access_roles': {'is_admin': True}}]
                raise AssertionError('Unexpected external request: ' + url)

            module.json_request = auth_json
            server = make_server('127.0.0.1', 0, module.app, threaded=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            self.modules.append(module)
            self.engines.append(module.get_sync_engine())
            self.urls.append('http://127.0.0.1:%s' % server.server_port)
            self.keys.append('key-%s' % index)
        self.headers = {'x-lumin-key': self.keys[0], 'Authorization': 'Bearer admin'}

    def pair(self):
        return json_request(self.urls[0] + '/api/sync/pair', 'POST', self.headers,
                            {'url': self.urls[1], 'key': self.keys[1]})

    def write(self, index, rel, data):
        path = self.engines[index].root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def run_sync(self):
        started = json_request(self.urls[0] + '/api/sync/jobs', 'POST', self.headers)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            job = json_request(self.urls[0] + '/api/sync/jobs/' + started['id'], headers=self.headers)
            if job['status'] != 'running':
                return job
            time.sleep(.02)
        self.fail('Sync timed out')

    def assert_completed(self, job):
        self.assertEqual(job['status'], 'completed', job)
        self.assertEqual(job['completedFiles'], job['totalFiles'])
        self.assertEqual(job['transferredBytes'], job['totalBytes'])

    def test_first_merge_both_directions_preserves_arabic_paths_and_skips_identical(self):
        self.write(0, 'أحمد/أشعة/صورة.pdf', b'PC x-ray')
        self.write(1, 'Patient/Clinical-Photos/laptop.pdf', b'laptop photo')
        for index in range(2):
            self.write(index, 'Patient/General/same.pdf', b'same')
        self.pair()
        job = self.run_sync()
        self.assert_completed(job)
        self.assertEqual(job['copiedFiles'], 2)
        self.assertEqual((self.engines[1].root / 'أحمد/أشعة/صورة.pdf').read_bytes(), b'PC x-ray')
        self.assertEqual((self.engines[0].root / 'Patient/Clinical-Photos/laptop.pdf').read_bytes(), b'laptop photo')
        self.assert_completed(self.run_sync())
        self.assertEqual(self.run_sync()['totalBytes'], 0)

    def test_updates_archive_previous_copy_and_track_deletions_both_directions(self):
        self.write(0, 'P/General/edit.pdf', b'old')
        self.write(1, 'P/General/remove.pdf', b'remove')
        self.pair(); self.assert_completed(self.run_sync())
        self.write(0, 'P/General/edit.pdf', b'new')
        self.engines[1].delete_local('P/General/remove.pdf')
        job = self.run_sync(); self.assert_completed(job)
        self.assertEqual(job['deletedFiles'], 1)
        self.assertEqual((self.engines[1].root / 'P/General/edit.pdf').read_bytes(), b'new')
        self.assertFalse((self.engines[0].root / 'P/General/remove.pdf').exists())
        self.assertTrue(any(p.read_bytes() == b'old' for p in self.engines[1].state_root.glob('archive/**/*.pdf')))
        self.assertTrue(any(p.read_bytes() == b'remove' for p in self.engines[0].state_root.glob('archive/**/*.pdf')))
        self.assertEqual(self.run_sync()['copiedFiles'], 0, 'deletions do not resurrect files')

    def test_file_explorer_deletion_and_deletion_only_progress(self):
        file = self.write(0, 'P/General/one.pdf', b'one')
        self.pair(); self.assert_completed(self.run_sync())
        file.unlink()
        job = self.run_sync(); self.assert_completed(job)
        self.assertEqual((job['totalBytes'], job['totalFiles'], job['deletedFiles']), (0, 1, 1))
        self.assertFalse((self.engines[1].root / 'P/General/one.pdf').exists())

    def test_concurrent_edits_preserve_both_originals_and_deduplicate_conflict_copies(self):
        self.write(0, 'P/General/edit.pdf', b'base')
        self.pair(); self.assert_completed(self.run_sync())
        self.write(0, 'P/General/edit.pdf', b'PC change')
        self.write(1, 'P/General/edit.pdf', b'laptop change')
        job = self.run_sync()
        self.assertEqual(job['status'], 'completed_with_conflicts', job)
        for index, content in enumerate([b'PC change', b'laptop change']):
            self.assertEqual((self.engines[index].root / 'P/General/edit.pdf').read_bytes(), content)
            variants = {p.read_bytes() for p in self.engines[index].root.rglob('*.pdf')}
            self.assertEqual(variants, {b'PC change', b'laptop change'})
        self.run_sync()  # Both deterministic conflict paths become available on both nodes.
        counts = [len(list(e.root.rglob('*.pdf'))) for e in self.engines]
        self.run_sync()
        self.assertEqual(counts, [len(list(e.root.rglob('*.pdf'))) for e in self.engines])

    def test_delete_versus_modify_keeps_edit_and_reports_conflict(self):
        self.write(0, 'P/General/edit.pdf', b'base')
        self.pair(); self.assert_completed(self.run_sync())
        self.engines[0].delete_local('P/General/edit.pdf')
        self.write(1, 'P/General/edit.pdf', b'important change')
        job = self.run_sync()
        self.assertEqual(job['status'], 'completed_with_conflicts', job)
        self.assertEqual(job['conflicts'][0]['kind'], 'delete_modified')
        for e in self.engines:
            self.assertEqual((e.root / 'P/General/edit.pdf').read_bytes(), b'important change')
        self.assert_completed(self.run_sync())

    def test_ordinary_upload_move_and_delete_endpoints_are_tracked(self):
        self.pair()
        client = self.modules[0].app.test_client()
        uploaded = client.post('/api/upload', headers={'x-lumin-key': self.keys[0]}, data={
            'patientId': 'patient', 'patientName': 'Patient', 'category': 'General',
            'file': (io.BytesIO(b'pdf contents'), 'scan.pdf')}).get_json()
        self.assertTrue(uploaded['success'], uploaded)
        old = uploaded['relativePath']
        self.assert_completed(self.run_sync())
        moved = client.post('/api/file/move', headers={'x-lumin-key': self.keys[0]}, json={
            'relativePath': old, 'targetCategory': 'Panoramic'}).get_json()
        self.assertTrue(moved['success'], moved)
        new = moved['newRelativePath']
        self.assert_completed(self.run_sync())
        self.assertFalse((self.engines[1].root / old).exists())
        self.assertTrue((self.engines[1].root / new).exists())
        deleted = client.delete('/api/file', headers={'x-lumin-key': self.keys[0]}, json={'relativePath': new})
        self.assertEqual(deleted.status_code, 200)
        self.assert_completed(self.run_sync())
        self.assertFalse((self.engines[1].root / new).exists())

    def test_byte_progress_stages_and_duplicate_clicks(self):
        self.write(0, 'P/General/large.pdf', b'a' * 1048576)
        self.pair()
        snapshots, original = [], self.engines[0].update_job
        def update(job):
            snapshots.append(copy.deepcopy(job))
            original(job)
        with patch.object(self.engines[0], 'update_job', side_effect=update):
            with patch.object(self.engines[0], 'scan', side_effect=SyncError('Retry test', 409)):
                self.assertEqual(self.run_sync()['status'], 'failed')
            self.assert_completed(self.run_sync())
        phases = [j['phase'] for j in snapshots]
        for phase in ('scanning', 'syncing', 'deleting', 'verifying', 'finished'):
            self.assertIn(phase, phases)
        self.assertTrue(any(0 < j['transferredBytes'] < 1048576 for j in snapshots))
        gate = threading.Event()
        scan = self.engines[0].scan
        with patch.object(self.engines[0], 'scan', side_effect=lambda: (gate.wait(5), scan())[1]):
            first = self.engines[0].start()
            second = self.engines[0].start()
            self.assertEqual(first['id'], second['id'])
            gate.set()
            deadline = time.monotonic() + 5
            while self.engines[0].jobs()[0]['status'] == 'running' and time.monotonic() < deadline:
                time.sleep(.02)

    def test_partial_failure_retry_skips_verified_transfers(self):
        self.write(0, 'P/General/a.pdf', b'a')
        self.write(0, 'P/General/b.pdf', b'b')
        self.pair()
        original = self.engines[0].transfer
        def fail_second(record, *args):
            if record['path'].endswith('b.pdf'):
                raise SyncError('Disconnected', 503)
            return original(record, *args)
        with patch.object(self.engines[0], 'transfer', side_effect=fail_second):
            failed = self.run_sync()
        self.assertEqual(failed['status'], 'failed')
        self.assertEqual(failed['completedFiles'], 1)
        retried = self.run_sync(); self.assert_completed(retried)
        self.assertEqual(retried['copiedFiles'], 1)

    def test_expected_version_and_checksum_rejections_leave_original_intact(self):
        self.write(0, 'P/General/a.pdf', b'old')
        e = self.engines[0]
        old = e.observe('P/General/a.pdf')
        new = dict(old, sha256='0' * 64, size=3)
        with self.assertRaises(SyncError):
            e.apply(new, old, io.BytesIO(b'bad'))
        self.assertEqual((e.root / old['path']).read_bytes(), b'old')
        self.write(0, old['path'], b'changed during sync')
        with self.assertRaises(SyncError):
            e.apply(old, old)
        self.assertEqual((e.root / old['path']).read_bytes(), b'changed during sync')

    def test_archiving_failure_and_missing_root_never_delete_patient_files(self):
        self.write(0, 'P/General/a.pdf', b'old')
        e = self.engines[0]
        with patch('file_sync.shutil.copy2', side_effect=OSError(28, 'disk full')):
            with self.assertRaises(OSError):
                e.delete_local('P/General/a.pdf')
        self.assertEqual((e.root / 'P/General/a.pdf').read_bytes(), b'old')
        with patch.object(e, 'root', self.base / 'unmounted'):
            with self.assertRaises(SyncError):
                e.scan()
        self.assertFalse(e.record('P/General/a.pdf')['deleted'])

    def test_restart_marks_job_failed_and_keeps_node_identity_and_records(self):
        e = self.engines[0]
        self.write(0, 'P/General/a.pdf', b'a'); e.scan()
        e.update_job({'id': 'interrupted', 'status': 'running', 'phase': 'syncing'})
        restarted = SyncEngine(e.root, e.state_root, e.extensions)
        self.assertEqual(restarted.node_id, e.node_id)
        self.assertEqual(restarted.jobs()[0]['status'], 'failed')
        self.assertEqual(restarted.record('P/General/a.pdf'), e.record('P/General/a.pdf'))

    def test_auth_pairing_self_pair_and_private_paths(self):
        client = self.modules[0].app.test_client()
        self.assertEqual(client.get('/api/sync/info', headers={'x-lumin-key': self.keys[0]}).status_code, 401)
        self.assertEqual(client.get('/api/sync/peer/manifest', headers=self.headers).status_code, 401)
        result = client.post('/api/sync/pair', headers=self.headers, json={'url': self.urls[0], 'key': self.keys[0]})
        self.assertEqual(result.status_code, 409)
        self.pair()
        self.assertNotIn('secret', client.get('/api/sync/info', headers=self.headers).get_data(as_text=True))
        for path in ['../outside.pdf', '/outside.pdf', 'C:/outside.pdf', 'P/.thumbnails/a.pdf',
                     'P/General/a.pdf:alternate', 'P/General/NUL.pdf', 'P/General/a.pdf.']:
            with self.assertRaises(SyncError, msg=path):
                safe_path(self.engines[0].root, path)
        self.assertEqual(client.get('/files/.thumbnails/a.pdf', headers={'x-lumin-key': self.keys[0]}).status_code, 403)
        self.assertEqual(client.delete('/api/file', headers={'x-lumin-key': self.keys[0]},
                                       json={'relativePath': '../outside.pdf'}).status_code, 403)

    def test_admin_role_is_checked_and_cannot_come_from_user_metadata(self):
        module = self.modules[0]
        for profile in [{'active': False, 'access_roles': {'is_admin': True}},
                        {'active': True, 'access_roles': {'is_admin': False}}]:
            with patch.object(module, 'json_request', side_effect=[
                    {'id': 'user', 'user_metadata': {'is_admin': True}}, [profile]]):
                with self.assertRaises(SyncError) as raised:
                    module.require_sync_admin('Bearer arbitrary')
                self.assertEqual(raised.exception.status, 403)

    def test_url_validation_and_derived_thumbnail_exclusion(self):
        for value in ['ftp://server', 'https://user:key@host', 'https://host?key=x', 'https://host#fragment']:
            with self.assertRaises(SyncError):
                normalise_url(value)
        self.write(0, '.thumbnails/P/General/a.pdf', b'thumbnail')
        self.assertEqual(self.engines[0].scan(), {})

    def test_original_scan_zip_upload_download_and_two_server_sync(self):
        import zipfile
        original = io.BytesIO()
        with zipfile.ZipFile(original, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('upper.obj', 'v 0 0 1\nv 1 0 1\nv 0 1 1\nf 1 2 3\n')
            archive.writestr('lower.obj', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')
            archive.writestr('original.stl', b'preserved original extra file')
        payload = original.getvalue()
        client = self.modules[0].app.test_client()
        health = client.get('/api/health').get_json()
        self.assertTrue(health['capabilities']['patient3dScans'])
        self.assertTrue(health['capabilities']['scanOriginalFilenames'])
        self.assertIn('zip', self.engines[0].extensions)
        paths = []
        for _ in range(2):
            response = client.post('/api/upload', headers={'x-lumin-key': self.keys[0]}, data={
                'file': (io.BytesIO(payload), 'Original patient scan.zip'),
                'patientId': 'scan-test', 'patientName': 'Scan Test', 'category': '3D-Scans'})
            self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
            self.assertEqual(response.get_json()['filename'], 'Original patient scan.zip')
            paths.append(response.get_json()['relativePath'])
        self.assertNotEqual(paths[0], paths[1])
        self.assertEqual(Path(paths[0]).name, 'Original patient scan.zip')
        self.assertNotEqual(Path(paths[0]).parent, Path(paths[1]).parent)
        import uuid
        upload_id = str(uuid.uuid4())
        retries = []
        for _ in range(2):
            response = client.post('/api/upload', headers={'x-lumin-key': self.keys[0]}, data={
                'file': (io.BytesIO(payload), 'مسح للفكين - زيارة ١.ZIP'), 'scanUploadId': upload_id,
                'patientId': 'scan-test', 'patientName': 'Scan Test', 'category': '3D-Scans'})
            retries.append(response.get_json()['relativePath'])
        self.assertEqual(retries[0], retries[1])
        self.assertEqual(Path(retries[0]).name, 'مسح للفكين - زيارة ١.ZIP')
        paths.append(retries[0])
        for rel in paths:
            response = client.get('/files/' + rel, headers={'x-lumin-key': self.keys[0]})
            self.assertEqual(response.data, payload)
            self.assertEqual(response.headers['Cache-Control'], 'private, no-store')
            response.close()
            self.assertEqual(client.get('/files/' + rel).status_code, 401)
        listing = client.get('/api/patient/scan-test/files?name=Scan%20Test', headers={'x-lumin-key': self.keys[0]}).get_json()
        self.assertEqual(len(listing['files']), 3)
        self.assertTrue(all(file['category'] == '3D-Scans' for file in listing['files']))
        self.pair()
        self.run_sync()
        for rel in paths:
            self.assertEqual((self.engines[1].root / rel).read_bytes(), payload)
        removed = client.delete('/api/file', headers={'x-lumin-key': self.keys[0]}, json={'relativePath': paths[0]})
        self.assertEqual(removed.status_code, 200)
        self.run_sync()
        self.assertFalse((self.engines[1].root / paths[0]).exists())


if __name__ == '__main__':
    import logging
    logging.getLogger('werkzeug').setLevel(logging.ERROR)
    unittest.main()
