"""Real Python ↔ TypeScript HTTP sync with disposable folders and mocked Google."""
import copy
import json
import os
from pathlib import Path
import queue
import runpy
import shutil
import subprocess
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
baseline = runpy.run_path(str(ROOT / 'tests/storage-file-sync.test.py'))
json_request = baseline['json_request']
DENO = os.environ.get('LUMIN_TEST_DENO') or shutil.which('deno')
PID = '10000000-0000-0000-0000-000000000001'

@unittest.skipUnless(DENO, 'Set LUMIN_TEST_DENO or install Deno for the Drive integration tests')
class DriveSyncTests(unittest.TestCase):
    def setUp(self):
        self.local = baseline['SyncTests']()
        self.addCleanup(self.local.doCleanups)
        self.local.setUp()
        process = subprocess.Popen([DENO, 'run', '--allow-net=127.0.0.1', str(ROOT / 'supabase/functions/google-drive/test_server.ts')],
                                   cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        def close():
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
            process.stdout.close(); process.stderr.close()
        self.addCleanup(close)
        ready = queue.Queue()
        threading.Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
        try: line = ready.get(timeout=15)
        except queue.Empty:
            process.terminate(); self.fail('Drive test harness did not start')
        if not line: self.fail(process.stderr.read())
        self.cloud = 'http://127.0.0.1:%s/functions/v1/google-drive' % json.loads(line)['port']
        self.module = self.local.modules[0]
        self.engine = self.module.get_drive_sync_engine()
        self.engine.drive_endpoint = self.cloud  # Test-only Google stand-in.
        self.url = self.local.urls[0] + '/api/drive-sync'
        self.headers = self.local.headers
        self.cloud_headers = {'Authorization': 'Bearer admin'}

    def pair(self):
        return json_request(self.url + '/pair', 'POST', self.headers, {'url': self.cloud})

    def sync(self):
        job = json_request(self.url + '/jobs', 'POST', self.headers)
        for _ in range(500):
            job = json_request(self.url + '/jobs/' + job['id'], headers=self.headers)
            if job['status'] != 'running': return job
            time.sleep(.02)
        self.fail('Drive sync did not finish')

    def completed(self, job):
        self.assertEqual(job['status'], 'completed', job)

    def resolve(self, job, action, index=0):
        route = self.url + '/jobs/%s/conflicts/%s' % (job['id'], index)
        review = json_request(route, headers=self.headers)
        return json_request(route, 'POST', self.headers, {'action': action, 'revision': review['revision']})['job']

    def test_drive_pairing_keeps_pc_laptop_pair_and_local_authentication(self):
        self.local.pair()
        original = copy.deepcopy(self.local.engines[0].meta('pair'))
        self.pair()
        self.assertEqual(self.local.engines[0].meta('pair'), original)
        self.assertNotEqual(self.engine.node_id, self.local.engines[0].node_id)
        self.assertIs(self.engine.clinical.local, self.local.engines[0].clinical)
        self.assertIs(self.engine.lock, self.local.engines[0].lock)
        with patch.object(self.engine, 'jobs', return_value=[{'status': 'running'}]):
            with self.assertRaises(baseline['SyncError']) as caught:
                self.local.engines[0].start()
            self.assertEqual(caught.exception.code, 'sync_busy')
        with patch.object(self.local.engines[0], 'jobs', return_value=[{'status': 'running'}]):
            with self.assertRaises(baseline['SyncError']) as caught:
                self.engine.start()
            self.assertEqual(caught.exception.code, 'sync_busy')
        response = self.module.app.test_client().get('/api/drive-sync/info', headers={'x-lumin-key': self.local.keys[0]})
        self.assertEqual(response.status_code, 401)
        response = self.module.app.test_client().post('/api/drive-sync/pair', headers=self.headers, json={'url': 'https://unrelated.test'})
        self.assertEqual(response.status_code, 400)

    def test_local_and_drive_transfer_bytes_and_clinical_notes_in_both_directions(self):
        path = 'أحمد_علي/Periapical/local.png'
        self.local.write(0, path, b'local-xray')
        snapshot = {'version': 2, 'patients': [{'id': PID, 'name': 'أحمد علي', 'patient_number': '1042', 'phone': '01012345678'}],
                    'files': [{'patient_id': PID, 'relative_path': path, 'display_name': 'أشعة', 'note': 'local note',
                               'tooth_ids': ['12', 'A'], 'scan_config': {'rotation': 90.0, 'matrix': [1.0, -0.0, 1e-7]}}]}
        self.engine.clinical.replace(snapshot)
        self.pair(); self.completed(self.sync())
        listing = json_request(self.cloud + '/api/patient/' + PID + '/files', headers=self.cloud_headers)
        self.assertEqual(listing['files'][0]['mediaDetails']['note'], 'local note')
        json_request(self.cloud + '/api/patient/' + PID + '/media-details', 'POST', self.cloud_headers,
                     {'relativePath': path, 'details': {'note': 'Drive note'}})
        self.completed(self.sync())
        self.assertEqual(self.engine.clinical.details(path)['note'], 'Drive note')
        cloud_upload = json_request(self.cloud.split('/functions/')[0] + '/test/upload', headers=self.cloud_headers)
        self.assertTrue(cloud_upload['relativePath'].startswith('أحمد_علي/Periapical/'))
        self.completed(self.sync())
        self.assertEqual((self.engine.root / cloud_upload['relativePath']).read_bytes(), b'cloud-xray')
        self.assertEqual(self.engine.clinical.details(cloud_upload['relativePath'])['patient_id'], PID)

    def test_conflict_review_preserves_copies_then_deletion_requires_a_review(self):
        path = 'أحمد_علي/Periapical/test.png'
        self.local.write(0, path, b'original')
        self.engine.clinical.replace({'version': 2, 'patients': [{'id': PID, 'name': 'أحمد علي'}],
                                     'files': [{'patient_id': PID, 'relative_path': path, 'note': 'baseline'}]})
        self.pair(); self.completed(self.sync())
        self.engine.clinical.upsert(path, PID, {'note': 'local edit'}, {'name': 'أحمد علي'})
        json_request(self.cloud + '/api/patient/' + PID + '/media-details', 'POST', self.cloud_headers,
                     {'relativePath': path, 'details': {'note': 'Drive edit'}})
        job = self.sync(); self.assertEqual(job['status'], 'completed_with_conflicts', job)
        job = self.resolve(job, 'keep_both'); self.completed(job)
        listing = json_request(self.cloud + '/api/patient/' + PID + '/files', headers=self.cloud_headers)
        self.assertEqual({f['mediaDetails']['note'] for f in listing['files']}, {'local edit', 'Drive edit'})
        self.completed(self.sync())
        json_request(self.cloud + '/api/file', 'DELETE', self.cloud_headers, {'relativePath': path})
        job = self.sync(); self.assertEqual(job['status'], 'completed_with_conflicts', job)
        self.assertTrue((self.engine.root / path).exists(), 'Deleting in Drive must leave the local copy until reviewed')
        self.completed(self.resolve(job, 'delete_both'))
        self.assertFalse((self.engine.root / path).exists())

    def test_excluded_annotations_stay_local_when_drive_metadata_is_synced(self):
        path = 'أحمد_علي/Periapical/test.png'
        excluded = 'أحمد_علي/patient_media_details.json'
        self.local.write(0, path, b'original')
        self.local.engines[0].clinical.replace({'version': 2, 'patients': [{'id': PID, 'name': 'أحمد علي'}],
            'files': [{'patient_id': PID, 'relative_path': path, 'note': 'media note'},
                      {'patient_id': PID, 'relative_path': excluded, 'note': 'local-only annotation'}]})
        self.pair(); self.completed(self.sync())
        remote = json_request(self.cloud + '/api/sync/peer/metadata', headers=self.engine.peer_headers())
        self.assertEqual([f['relative_path'] for f in remote['snapshot']['files']], [path])
        self.assertEqual(self.local.engines[0].clinical.details(excluded)['note'], 'local-only annotation')
        json_request(self.cloud + '/api/patient/' + PID + '/media-details', 'POST', self.cloud_headers,
                     {'relativePath': path, 'details': {'note': 'Drive edit'}})
        self.completed(self.sync())
        self.assertEqual(self.local.engines[0].clinical.details(path)['note'], 'Drive edit')
        self.assertEqual(self.local.engines[0].clinical.details(excluded)['note'], 'local-only annotation')
        self.completed(self.sync())

if __name__ == '__main__': unittest.main()
