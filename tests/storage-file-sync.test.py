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
            module._mapping_writer = module.update_storage_mapping_files
            module.update_storage_mapping_files = lambda: {}

            def auth_json(url, method='GET', headers=None, data=None, timeout=25):
                if (headers or {}).get('Authorization') != 'Bearer admin':
                    raise SyncError('Expired token', 401)
                if '/auth/v1/user' in url:
                    return {'id': 'admin-user'}
                if '/rest/v1/user_profiles?' in url:
                    return [{'active': True, 'access_roles': {'is_admin': True}}]
                if '/rest/v1/patients?' in url or '/rest/v1/patient_media_details?' in url:
                    raise AssertionError('Sync must use local annotations, not Supabase media records')
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

    def resolve(self, job, action, index=0):
        route = self.urls[0] + '/api/sync/jobs/%s/conflicts/%s' % (job['id'], index)
        review = json_request(route, headers=self.headers)
        return json_request(route, 'POST', self.headers, dict(action=action, revision=review['revision']))['job']

    def clinical_fixture(self):
        return dict(version=1, patients=[dict(id='12345678-1234-4234-8234-123456789abc',
                    name='مريض تجريبي', patient_number=1042, phone='01000000000')], files=[dict(
                    patient_id='12345678-1234-4234-8234-123456789abc', relative_path='مريض_تجريبي/Periapical/photo.png',
                    display_name='فحص الأسنان', note="Follow-up 'note' <script>example</script>", tooth_id='14',
                    tooth_ids=['14', '15', '14'], scan_date='2026-10-07', scan_config={'rotation': 90})])

    def seed_local_details(self, snapshot=None):
        self.engines[0].clinical.replace(snapshot or self.clinical_fixture())

    def test_patient_ids_teeth_notes_and_scan_settings_sync_and_export_on_both_pcs(self):
        import sqlite3
        fixture = self.clinical_fixture()
        rel = fixture['files'][0]['relative_path']
        self.write(0, rel, b'clinical image')
        self.seed_local_details(fixture)
        for module in self.modules:
            module.update_storage_mapping_files = module._mapping_writer
            module.fetch_all_patients_metadata_from_supabase = lambda: self.fail('Must use caller-scoped cache')
        self.pair()
        job = self.run_sync()
        self.assert_completed(job)
        self.assertEqual(job['metadataStatus'], 'current')
        self.assertEqual(job['metadataPatients'], 1)
        for engine in self.engines:
            tag = json.loads((engine.root / 'مريض_تجريبي/.patient_id').read_text(encoding='utf-8'))
            self.assertEqual(tag['patient_id'], fixture['patients'][0]['id'])
            data = json.loads((engine.root / 'patients_mapping.json').read_text(encoding='utf-8'))
            media = data['files'][0]
            self.assertEqual(media['patient_id'], fixture['patients'][0]['id'])
            self.assertEqual(media['patient_number'], '1042')
            self.assertEqual(media['tooth_ids'], ['14', '15'])
            self.assertEqual(media['note'], fixture['files'][0]['note'])
            self.assertEqual(media['scan_config'], {'rotation': 90})
            sql = (engine.root / 'patients_mapping.sql').read_text(encoding='utf-8')
            self.assertIn('patient_media_details_mapping', sql)
            self.assertIn("Follow-up \\'note\\'", sql)
            from contextlib import closing
            with closing(sqlite3.connect(engine.root / 'patients_mapping.sqlite')) as db:
                row = db.execute('SELECT patient_id,tooth_ids,scan_date,scan_config FROM patient_media_details_mapping').fetchone()
            self.assertEqual(row[0], fixture['patients'][0]['id'])
            self.assertEqual(json.loads(row[1]), ['14', '15'])
            self.assertEqual(row[2], '2026-10-07')
            self.assertEqual(json.loads(row[3]), {'rotation': 90})
        self.assertEqual(self.run_sync()['copiedFiles'], 0)

    def test_metadata_changes_and_cleared_teeth_update_without_retransferring_files(self):
        fixture = self.clinical_fixture()
        rel = fixture['files'][0]['relative_path']
        self.write(0, rel, b'image unchanged')
        self.seed_local_details(fixture)
        self.pair()
        self.assert_completed(self.run_sync())
        self.engines[1].clinical.upsert(rel, fixture['patients'][0]['id'],
            dict(tooth_ids=[], tooth_id=None, note='', display_name='Updated label', scan_config=None))
        job = self.run_sync()
        self.assert_completed(job)
        self.assertEqual(job['copiedFiles'], 0)
        for engine in self.engines:
            details = engine.clinical.details(rel)
            self.assertEqual(details['tooth_ids'], [])
            self.assertEqual(details['note'], '')
            self.assertEqual(details['display_name'], 'Updated label')
            with engine.database() as db:
                self.assertNotIn('Bearer admin', json.dumps(db.execute('SELECT value FROM meta').fetchall()))

    def test_review_and_preserved_conflict_copies_retain_clinical_annotations(self):
        fixture = self.clinical_fixture()
        rel = fixture['files'][0]['relative_path']
        for index in range(2):
            self.write(index, rel, b'first image' if index == 0 else b'second image')
        self.seed_local_details(fixture)
        self.engines[1].clinical.replace(fixture)
        self.pair()
        job = self.run_sync()
        self.assertEqual(job['status'], 'completed_with_conflicts', job)
        route = self.urls[0] + '/api/sync/jobs/%s/conflicts/0' % job['id']
        review = json_request(route, headers=self.headers)
        for side in ('local', 'remote'):
            self.assertEqual(review['details'][side]['patient_id'], fixture['patients'][0]['id'])
            self.assertEqual(review['details'][side]['tooth_ids'], ['14', '15'])
        json_request(route, 'POST', self.headers, dict(action='keep_both', revision=review['revision']))
        for engine in self.engines:
            copies = [r['path'] for r in engine.scan().values() if '__conflict-' in r['path']]
            self.assertEqual(len(copies), 2)
            for path in copies:
                self.assertEqual(engine.clinical.details(path)['source_relative_path'], rel)
                self.assertEqual(engine.clinical.details(path)['tooth_ids'], ['14', '15'])

    def test_sync_uses_local_annotations_without_cloud_metadata_reads(self):
        fixture = self.clinical_fixture()
        rel = fixture['files'][0]['relative_path']
        self.write(0, rel, b'image')
        self.seed_local_details(fixture)
        self.pair()
        self.assert_completed(self.run_sync())
        self.write(0, rel, b'updated offline')
        job = self.run_sync()
        self.assert_completed(job)
        self.assertEqual(job['metadataStatus'], 'current')
        self.assertNotIn('metadataWarning', job)
        for engine in self.engines:
            self.assertEqual(engine.clinical.details(rel)['tooth_ids'], ['14', '15'])
        restarted = SyncEngine(self.engines[1].root, self.engines[1].state_root, ['png'])
        self.assertEqual(restarted.clinical.details(rel)['note'], fixture['files'][0]['note'])

    def test_clinical_snapshot_is_validated_before_replacing_the_cache_and_requires_pair_credentials(self):
        fixture = self.clinical_fixture()
        self.pair()
        self.engines[1].clinical.replace(fixture)
        original = self.engines[1].clinical.snapshot()
        route = self.urls[1] + '/api/sync/peer/metadata'
        with self.assertRaises(SyncError) as unauthorized:
            json_request(route, 'POST', {'x-lumin-key': self.keys[1]}, fixture)
        self.assertEqual(unauthorized.exception.status, 401)
        invalid = copy.deepcopy(fixture)
        invalid['files'][0]['patient_id'] = '99999999-1234-4234-8234-123456789abc'
        with self.assertRaises(SyncError) as rejected:
            json_request(route, 'POST', self.engines[0].peer_headers(), dict(snapshot=invalid, expected=self.engines[1].clinical.digest(original)))
        self.assertEqual(rejected.exception.code, 'invalid_clinical_metadata')
        self.assertEqual(self.engines[1].clinical.snapshot(), original)

    def save_details(self, index, rel, details, pid=None):
        pid = pid or self.clinical_fixture()['patients'][0]['id']
        return json_request(self.urls[index] + '/api/patient/' + pid + '/media-details', 'POST',
                            {'x-lumin-key': self.keys[index]},
                            dict(relativePath=rel, patientName='مريض تجريبي', patientNumber=1042, details=details))

    def test_local_legacy_json_load_save_move_delete_and_restart_without_cloud(self):
        fixture = self.clinical_fixture()
        pid, rel = fixture['patients'][0]['id'], fixture['files'][0]['relative_path']
        photo = self.write(0, rel, b'image')
        (photo.parent.parent / 'patient_media_details.json').write_text(json.dumps(dict(
            patient_id=pid, patient_name='مريض تجريبي', patient_number=1042,
            files={'Periapical/photo.png':dict(display_name='Local original',note='Local note',tooth_id='A',tooth_ids=['3','A'],scan_config={'rotation':90})})), encoding='utf-8')
        route = self.urls[0] + '/api/patient/' + pid + '/files'
        listing = json_request(route, headers={'x-lumin-key':self.keys[0]})
        self.assertEqual(listing['metadataSource'], 'local')
        self.assertEqual(listing['files'][0]['mediaDetails']['tooth_ids'], ['3','A'])
        saved = self.save_details(0, rel, dict(note='',tooth_ids=[]))
        self.assertEqual(saved['details']['tooth_ids'], [])
        self.assertEqual(saved['details']['scan_config'], {'rotation':90})
        self.assertEqual(saved['details']['display_name'], 'Local original')
        backup = json.loads((photo.parent.parent / 'patient_media_details.json').read_text(encoding='utf-8'))
        self.assertEqual(backup['files']['Periapical/photo.png']['note'], '')
        moved = json_request(self.urls[0] + '/api/file/move', 'POST', {'x-lumin-key':self.keys[0]},dict(relativePath=rel,targetCategory='Panoramic'))
        new_rel = moved['newRelativePath']
        restarted = SyncEngine(self.engines[0].root, self.engines[0].state_root, ['png'])
        self.assertEqual(restarted.clinical.details(new_rel)['display_name'], 'Local original')
        json_request(self.urls[0] + '/api/file', 'DELETE', {'x-lumin-key':self.keys[0]},dict(relativePath=new_rel))
        self.assertFalse(self.engines[0].clinical.details(new_rel)['metadata_available'])

    def test_image_rotation_persists_after_restart_and_sync_with_existing_annotations(self):
        from PIL import Image
        fixture = self.clinical_fixture()
        pid, rel = fixture['patients'][0]['id'], fixture['files'][0]['relative_path']
        buffer = io.BytesIO()
        Image.new('RGB', (12, 8), (15, 23, 42)).save(buffer, 'PNG')
        original_image = buffer.getvalue()
        self.write(0, rel, original_image)
        self.save_details(0, rel, dict(display_name='UR6', note='Preserve clinical note', tooth_ids=['3', 'A']))
        self.save_details(0, rel, dict(scan_config=dict(image_rotation=90, other='Preserve setting')))
        listing = json_request(self.urls[0] + '/api/patient/' + pid + '/files', headers={'x-lumin-key': self.keys[0]})
        self.assertEqual(listing['files'][0]['mediaDetails']['scan_config']['image_rotation'], 90)
        restarted = SyncEngine(self.engines[0].root, self.engines[0].state_root, ['png'])
        self.assertEqual(restarted.clinical.details(rel)['scan_config']['image_rotation'], 90)
        self.pair()
        self.assert_completed(self.run_sync())
        for engine in self.engines:
            details = engine.clinical.details(rel)
            self.assertEqual(details['scan_config'], dict(image_rotation=90, other='Preserve setting'))
            self.assertEqual(details['note'], 'Preserve clinical note')
            self.assertEqual(details['tooth_ids'], ['3', 'A'])
            self.assertEqual((engine.root / rel).read_bytes(), original_image)

    def test_simultaneous_local_annotation_edits_are_reviewable_and_keep_both_on_each_server(self):
        fixture = self.clinical_fixture()
        pid, rel = fixture['patients'][0]['id'], fixture['files'][0]['relative_path']
        self.write(0, rel, b'same image')
        self.save_details(0, rel, dict(note='Original',tooth_ids=['3','A']))
        self.pair();self.assert_completed(self.run_sync())
        for index in range(2):
            self.save_details(index, rel, dict(note='Edit on PC %s' % index,tooth_ids=['3'] if index==0 else ['A']))
        job=self.run_sync()
        self.assertEqual(job['status'],'completed_with_conflicts',job)
        self.assertEqual(job['conflicts'][0]['kind'],'metadata')
        route=self.urls[0]+'/api/sync/jobs/%s/conflicts/0' % job['id']
        review=json_request(route,headers=self.headers)
        self.assertEqual(review['details']['local']['note'],'Edit on PC 0')
        self.assertEqual(review['details']['remote']['note'],'Edit on PC 1')
        self.save_details(1,rel,dict(note='Changed during review'))
        with self.assertRaises(SyncError) as stale:
            json_request(route,'POST',self.headers,dict(action='keep_both',revision=review['revision']))
        self.assertEqual(stale.exception.status,409)
        review=json_request(route,headers=self.headers)
        json_request(route,'POST',self.headers,dict(action='keep_both',revision=review['revision']))
        for engine in self.engines:
            copies=[r['path'] for r in engine.scan().values() if '__conflict-' in r['path']]
            self.assertEqual(len(copies),2)
            self.assertEqual({engine.clinical.details(path)['note'] for path in copies},{'Edit on PC 0','Changed during review'})
            self.assertEqual((engine.root/rel).read_bytes(),b'same image')
        self.assert_completed(self.run_sync())
        self.save_details(1,rel,dict(note='New annotation conflict'))
        self.assertEqual(self.run_sync()['status'],'completed')
        self.assertEqual(self.engines[0].clinical.details(rel)['note'],'New annotation conflict')

    def test_peer_snapshot_rejects_overwriting_a_new_local_edit(self):
        fixture=self.clinical_fixture();rel=fixture['files'][0]['relative_path']
        self.write(1,rel,b'image');self.pair()
        peer=self.urls[1]+'/api/sync/peer/metadata'
        before=json_request(peer,headers=self.engines[0].peer_headers())
        self.save_details(1,rel,dict(note='New local edit',tooth_ids=['A']))
        with self.assertRaises(SyncError) as stale:
            json_request(peer,'POST',self.engines[0].peer_headers(),dict(snapshot=fixture,expected=before['digest']))
        self.assertEqual(stale.exception.status,409)
        self.assertEqual(self.engines[1].clinical.details(rel)['note'],'New local edit')

    def test_local_annotations_reject_foreign_patient_and_invalid_tooth_assignments(self):
        fixture=self.clinical_fixture();pid=fixture['patients'][0]['id'];rel=fixture['files'][0]['relative_path']
        self.write(0,rel,b'image');self.save_details(0,rel,dict(note='Original',tooth_ids=['32','T']))
        for details in (dict(tooth_ids=['33']),dict(tooth_ids=['a']),dict(tooth_ids=[['3']])):
            with self.assertRaises(SyncError) as invalid:self.save_details(0,rel,details)
            self.assertEqual(invalid.exception.status,400)
        with self.assertRaises(SyncError) as foreign:
            self.save_details(0,rel,dict(note='Wrong patient'),'99999999-1234-4234-8234-123456789abc')
        self.assertEqual(foreign.exception.status,409)
        self.assertEqual(self.engines[0].clinical.details(rel)['note'],'Original')

    def test_independent_annotation_edits_on_different_files_merge_in_both_directions(self):
        fixture=self.clinical_fixture();rel=fixture['files'][0]['relative_path'];other=rel.replace('photo.png','second.png')
        for path in (rel,other):
            self.write(0,path,b'image');self.save_details(0,path,dict(note='Initial',tooth_ids=['3']))
        self.pair();self.assert_completed(self.run_sync())
        self.save_details(0,rel,dict(note='PC change',tooth_ids=['A']))
        self.save_details(1,other,dict(note='Laptop change',tooth_ids=['T']))
        job=self.run_sync();self.assert_completed(job)
        self.assertEqual(job['copiedFiles'],0)
        for engine in self.engines:
            self.assertEqual(engine.clinical.details(rel)['note'],'PC change')
            self.assertEqual(engine.clinical.details(other)['note'],'Laptop change')

    def test_local_move_and_delete_sync_annotation_paths_without_reviving_old_details(self):
        fixture=self.clinical_fixture();rel=fixture['files'][0]['relative_path']
        self.write(0,rel,b'image');self.save_details(0,rel,dict(note='Portable note',tooth_ids=['A']))
        self.pair();self.assert_completed(self.run_sync())
        moved=json_request(self.urls[1]+'/api/file/move','POST',{'x-lumin-key':self.keys[1]},dict(relativePath=rel,targetCategory='Panoramic'))
        new_rel=moved['newRelativePath'];self.resolve(self.run_sync(), 'delete_both')
        for engine in self.engines:
            self.assertFalse(engine.clinical.details(rel)['metadata_available'])
            self.assertEqual(engine.clinical.details(new_rel)['note'],'Portable note')
        json_request(self.urls[1]+'/api/file','DELETE',{'x-lumin-key':self.keys[1]},dict(relativePath=new_rel))
        self.resolve(self.run_sync(), 'delete_both');self.assert_completed(self.run_sync())
        for engine in self.engines:
            self.assertFalse(engine.clinical.details(new_rel)['metadata_available'])

    def test_local_patient_rename_preserves_annotations_without_cloud_requests(self):
        fixture=self.clinical_fixture();pid=fixture['patients'][0]['id'];rel=fixture['files'][0]['relative_path']
        self.write(0,rel,b'image');self.save_details(0,rel,dict(note='After rename',tooth_ids=['3','A']))
        result=json_request(self.urls[0]+'/api/patient/'+pid+'/rename','POST',{'x-lumin-key':self.keys[0]},
                            dict(oldName='مريض تجريبي',newName='Updated Patient'))
        self.assertTrue(result['success'])
        listing=json_request(self.urls[0]+'/api/patient/'+pid+'/files?name=Updated%20Patient',headers={'x-lumin-key':self.keys[0]})
        self.assertEqual(listing['files'][0]['mediaDetails']['note'],'After rename')
        self.assertEqual(listing['files'][0]['mediaDetails']['tooth_ids'],['3','A'])
        self.assertEqual(listing['files'][0]['relativePath'],'Updated_Patient/Periapical/photo.png')

    def test_existing_untagged_folder_can_be_associated_locally_after_index_regeneration(self):
        fixture=self.clinical_fixture();pid=fixture['patients'][0]['id'];rel='Existing_Patient/Periapical/photo.png'
        photo=self.write(0,rel,b'image')
        self.modules[0]._mapping_writer()
        self.assertFalse((photo.parent.parent/'.patient_id').exists())
        route=self.urls[0]+'/api/patient/'+pid+'/files?name=Existing%20Patient'
        listing=json_request(route,headers={'x-lumin-key':self.keys[0]})
        self.assertEqual(len(listing['files']),1)
        saved=self.save_details(0,rel,dict(note='Local association',tooth_ids=['3','A']))
        self.assertEqual(saved['details']['tooth_ids'],['3','A'])

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

    def test_revision_history_after_reinstall_merges_without_http400_or_losing_causality(self):
        import uuid
        rel = 'P/Panoramic/history.png'
        revisions = {}
        for index, engine in enumerate(self.engines):
            self.write(index, rel, b'same original image')
            record = engine.observe(rel)
            record['clock'][str(uuid.uuid4())] = 3
            engine.save_record(record)
            revisions.update(record['clock'])
        self.pair()
        job = self.run_sync()
        self.assert_completed(job)
        self.assertEqual(job['copiedFiles'], 0)
        for engine in self.engines:
            self.assertEqual(engine.record(rel)['clock'], revisions)
            self.assertEqual((engine.root / rel).read_bytes(), b'same original image')
        self.write(0, rel, b'new image after reinstall')
        self.assert_completed(self.run_sync())
        for engine in self.engines:
            current = engine.record(rel)
            self.assertEqual(set(current['clock']), set(revisions))
            self.assertEqual((engine.root / rel).read_bytes(), b'new image after reinstall')
        with self.assertRaises(SyncError):
            self.engines[0].validate_record(dict(current, clock={str(uuid.uuid4()): 1 for _ in range(65)}))

    def test_peer_upload_rejects_nonobject_metadata_with_specific_safe_error(self):
        import base64
        self.pair()
        headers = {**self.engines[0].peer_headers(), 'x-lumin-sync-meta': base64.b64encode(b'[]').decode()}
        response = self.modules[1].app.test_client().put('/api/sync/peer/file', headers=headers, data=b'')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()['code'], 'invalid_transfer')

    def test_updates_archive_previous_copy_and_track_deletions_both_directions(self):
        self.write(0, 'P/General/edit.pdf', b'old')
        self.write(1, 'P/General/remove.pdf', b'remove')
        self.pair(); self.assert_completed(self.run_sync())
        self.write(0, 'P/General/edit.pdf', b'new')
        self.engines[1].delete_local('P/General/remove.pdf')
        job = self.run_sync()
        self.assertEqual(job['status'], 'completed_with_conflicts')
        self.assertEqual(job['deletedFiles'], 0)
        self.resolve(job, 'delete_both')
        self.assertEqual((self.engines[1].root / 'P/General/edit.pdf').read_bytes(), b'new')
        self.assertFalse((self.engines[0].root / 'P/General/remove.pdf').exists())
        self.assertTrue(any(p.read_bytes() == b'old' for p in self.engines[1].state_root.glob('archive/**/*.pdf')))
        self.assertTrue(any(p.read_bytes() == b'remove' for p in self.engines[0].state_root.glob('archive/**/*.pdf')))
        self.assertEqual(self.run_sync()['copiedFiles'], 0, 'deletions do not resurrect files')

    def test_file_explorer_deletion_and_deletion_only_progress(self):
        file = self.write(0, 'P/General/one.pdf', b'one')
        self.pair(); self.assert_completed(self.run_sync())
        file.unlink()
        job = self.run_sync()
        self.assertEqual((job['totalBytes'], job['totalFiles'], job['deletedFiles']), (0, 0, 0))
        self.assertTrue((self.engines[1].root / 'P/General/one.pdf').exists())
        self.resolve(job, 'delete_both')
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
        self.assertFalse((self.engines[0].root / 'P/General/edit.pdf').exists())
        self.resolve(job, 'keep_remote')
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
        self.resolve(self.run_sync(), 'delete_both')
        self.assertFalse((self.engines[1].root / old).exists())
        self.assertTrue((self.engines[1].root / new).exists())
        deleted = client.delete('/api/file', headers={'x-lumin-key': self.keys[0]}, json={'relativePath': new})
        self.assertEqual(deleted.status_code, 200)
        self.resolve(self.run_sync(), 'delete_both')
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

    def test_peer_errors_report_safe_reasons_and_never_forward_arbitrary_response_bodies(self):
        from file_sync import open_request
        import urllib.error
        safe_error = urllib.error.HTTPError('http://peer.test', 409, 'Conflict', {},
                         io.BytesIO(b'{"error":"A file changed during synchronization. Retry sync."}'))
        with patch('file_sync.urllib.request.OpenerDirector.open', side_effect=safe_error):
            with self.assertRaises(SyncError) as raised:
                open_request('http://peer.test')
        self.assertEqual(raised.exception.code, 'file_changed')
        self.assertEqual(raised.exception.status, 409)
        private_error = urllib.error.HTTPError('http://peer.test', 409, 'Conflict', {},
                            io.BytesIO(b'{"error":"secret-key-and-patient-path","code":"file_changed"}'))
        with patch('file_sync.urllib.request.OpenerDirector.open', side_effect=private_error):
            with self.assertRaises(SyncError) as raised:
                open_request('http://peer.test')
        self.assertEqual(str(raised.exception), 'Server request failed (HTTP 409).')
        self.assertIsNone(raised.exception.code)

    def test_pair_and_background_job_errors_keep_the_specific_reason(self):
        client = self.modules[0].app.test_client()
        result = client.post('/api/sync/pair', headers=self.headers,
                             json={'url': self.urls[0], 'key': self.keys[0]})
        self.assertEqual(result.status_code, 409)
        self.assertEqual(result.get_json()['code'], 'same_server')
        self.pair()
        with patch.object(self.engines[0], 'scan', side_effect=SyncError('A file changed during scanning. Retry sync.', 409)):
            job = self.run_sync()
        self.assertEqual(job['errorCode'], 'file_changed')
        self.assertEqual(job['errorStatus'], 409)

    def test_wrong_clinic_key_is_distinguished_from_an_admin_session_failure(self):
        client = self.modules[0].app.test_client()
        result = client.get('/api/sync/info', headers={**self.headers, 'x-lumin-key': 'wrong-key'})
        self.assertEqual(result.status_code, 401)
        self.assertEqual(result.get_json()['code'], 'invalid_clinic_key')
        result = client.get('/api/sync/info', headers={'x-lumin-key': self.keys[0]})
        self.assertEqual(result.status_code, 401)
        self.assertNotEqual(result.get_json().get('code'), 'invalid_clinic_key')

    def test_peer_pairing_rejections_keep_the_recovery_reason_without_secret_data(self):
        from file_sync import open_request
        import urllib.error
        for message, code in [
                ('This server is already paired with another computer.', 'already_paired'),
                ('Select the existing dedicated PC as the coordinator.', 'wrong_coordinator'),
                ('Invalid peer manifest.', 'invalid_manifest'),
                ('Invalid sync peer credentials.', 'invalid_peer_credentials')]:
            response = urllib.error.HTTPError('http://peer.test', 409, 'Conflict', {},
                       io.BytesIO(json.dumps({'error': message}).encode()))
            with patch('file_sync.urllib.request.OpenerDirector.open', side_effect=response):
                with self.assertRaises(SyncError) as raised:
                    open_request('http://peer.test')
            self.assertEqual(raised.exception.code, code)

    def test_explicit_admin_pair_repair_reconnects_reinstalled_servers_and_preserves_files(self):
        self.write(0, 'P/General/a.pdf', b'clinic original')
        self.write(1, 'P/General/b.pdf', b'laptop original')
        self.pair()
        originals = [e.scan() for e in self.engines]
        old_secret = self.engines[0].meta('pair')['secret']
        import uuid
        old_node = str(uuid.uuid4())
        prior = self.engines[1].meta('pair')
        self.engines[1].meta('pair', {**prior, 'peerId': old_node})
        request = {'url':self.urls[1], 'key':self.keys[1]}
        client = self.modules[0].app.test_client()
        rejected = client.post('/api/sync/pair', headers=self.headers, json=request)
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.get_json()['code'], 'already_paired')
        denied = client.post('/api/sync/pair', headers={'x-lumin-key':self.keys[0]},
                             json={**request, 'replacePair':True})
        self.assertEqual(denied.status_code, 401)
        self.assertEqual(self.engines[1].meta('pair')['peerId'], old_node)
        repaired = client.post('/api/sync/pair', headers=self.headers, json={**request, 'replacePair':True})
        self.assertEqual(repaired.status_code, 200)
        self.assertNotEqual(self.engines[0].meta('pair')['secret'], old_secret)
        self.assertEqual(self.engines[1].meta('pair')['peerId'], self.engines[0].node_id)
        for engine, records in zip(self.engines, originals):
            self.assertEqual(engine.scan(), records)
        job = self.run_sync()
        self.assert_completed(job)
        for engine in self.engines:
            self.assertEqual((engine.root/'P/General/a.pdf').read_bytes(), b'clinic original')
            self.assertEqual((engine.root/'P/General/b.pdf').read_bytes(), b'laptop original')

    def test_pair_repair_cannot_replace_a_busy_replica_or_accept_a_stale_peer(self):
        self.pair()
        replica = self.engines[1]
        original_pair = replica.meta('pair')
        replica.update_job({'id':'busy-fixture','status':'running'})
        result = self.modules[0].app.test_client().post('/api/sync/pair', headers=self.headers,
                 json={'url':self.urls[1], 'key':self.keys[1], 'replacePair':True})
        self.assertEqual(result.status_code, 409)
        self.assertEqual(result.get_json()['code'], 'sync_busy')
        self.assertEqual(replica.meta('pair'), original_pair)


    def review_fixture(self, case_only=False):
        paths = ['مريض/Panoramic/scan.PNG', 'مريض/panoramic/scan.png'] if case_only else ['مريض/3D-Scans/scan.zip'] * 2
        for i, path in enumerate(paths):
            self.write(i, path, b'same' if case_only else [b'PC original', b'laptop original'][i])
        self.pair()
        job = self.run_sync()
        self.assertEqual(job['status'], 'completed_with_conflicts', job)
        route = '/api/sync/jobs/%s/conflicts/0' % job['id']
        client = self.modules[0].app.test_client()
        response = client.get(route, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.get_json())
        return paths, job, route, client, response.get_json()

    def assert_chosen_image(self, paths, expected):
        for engine, path in zip(self.engines, paths):
            self.assertEqual((engine.root / path).read_bytes(), expected)
            self.assertEqual(list(engine.root.rglob('*__conflict-*.zip')), [])
        self.assertEqual(self.engines[0].record(paths[0]), self.engines[1].record(paths[1]))
        self.assert_completed(self.run_sync())

    def test_review_can_keep_dedicated_pc_image_only_on_both_servers(self):
        paths, job, _, _, snapshot = self.review_fixture()
        self.assertIn('keep_local', snapshot['actions'])
        self.resolve(job, 'keep_local')
        self.assert_chosen_image(paths, b'PC original')
        self.assertTrue(any(p.read_bytes() == b'laptop original'
                            for p in self.engines[1].state_root.glob('archive/**/*.zip')))

    def test_review_can_keep_laptop_image_only_on_both_servers(self):
        paths, job, _, _, _ = self.review_fixture()
        self.resolve(job, 'keep_remote')
        self.assert_chosen_image(paths, b'laptop original')

    def test_review_choice_keeps_selected_annotations_and_next_edit_is_one_sided(self):
        fixture = self.clinical_fixture(); rel = fixture['files'][0]['relative_path']
        for index in range(2):
            self.write(index, rel, b'PC image' if index == 0 else b'laptop image')
            local = copy.deepcopy(fixture)
            local['files'][0].update(note='PC notes' if index == 0 else 'Laptop notes', tooth_ids=['3'] if index == 0 else ['A'])
            self.engines[index].clinical.replace(local)
        self.pair(); job = self.run_sync()
        self.resolve(job, 'keep_remote')
        for engine in self.engines:
            self.assertEqual((engine.root / rel).read_bytes(), b'laptop image')
            self.assertEqual(engine.clinical.details(rel)['note'], 'Laptop notes')
            self.assertEqual(engine.clinical.details(rel)['tooth_ids'], ['A'])
            self.assertFalse(list(engine.root.rglob('*__conflict-*.png')))
        self.save_details(0, rel, dict(note='Next ordinary edit', tooth_ids=[]))
        self.assert_completed(self.run_sync())
        self.assertEqual(self.engines[1].clinical.details(rel)['note'], 'Next ordinary edit')
        self.assertEqual(self.engines[1].clinical.details(rel)['tooth_ids'], [])

    def test_metadata_review_can_choose_one_set_without_creating_extra_images(self):
        fixture = self.clinical_fixture(); rel = fixture['files'][0]['relative_path']
        self.write(0, rel, b'image'); self.save_details(0, rel, dict(note='Original'))
        self.pair(); self.assert_completed(self.run_sync())
        self.save_details(0, rel, dict(note='Keep PC', tooth_ids=['3']))
        self.save_details(1, rel, dict(note='Discard laptop', tooth_ids=['A']))
        job = self.run_sync(); self.assertEqual(job['conflicts'][0]['kind'], 'metadata')
        self.resolve(job, 'keep_local')
        for engine in self.engines:
            self.assertEqual(engine.clinical.details(rel)['note'], 'Keep PC')
            self.assertEqual(list(engine.root.rglob('*.png')), [engine.root / rel])
        self.assert_completed(self.run_sync())

    def deletion_fixture(self, deleted_side):
        fixture = self.clinical_fixture(); rel = fixture['files'][0]['relative_path']
        self.write(0, rel, b'image'); self.save_details(0, rel, dict(note='Retain me', tooth_ids=['A']))
        self.pair(); self.assert_completed(self.run_sync())
        json_request(self.urls[deleted_side] + '/api/file', 'DELETE', {'x-lumin-key': self.keys[deleted_side]}, dict(relativePath=rel))
        job = self.run_sync()
        self.assertEqual(job['status'], 'completed_with_conflicts', job)
        self.assertFalse((self.engines[deleted_side].root / rel).exists())
        self.assertTrue((self.engines[1 - deleted_side].root / rel).exists())
        self.assertEqual(self.engines[1 - deleted_side].clinical.details(rel)['note'], 'Retain me')
        return rel, job

    def test_deleted_dedicated_pc_copy_can_be_restored_with_annotations(self):
        rel, job = self.deletion_fixture(0)
        self.resolve(job, 'keep_remote')
        for engine in self.engines:
            self.assertEqual((engine.root / rel).read_bytes(), b'image')
            self.assertEqual(engine.clinical.details(rel)['note'], 'Retain me')
            self.assertEqual(engine.clinical.details(rel)['tooth_ids'], ['A'])
        self.assert_completed(self.run_sync())

    def test_deleted_laptop_copy_can_be_restored_with_annotations(self):
        rel, job = self.deletion_fixture(1)
        self.resolve(job, 'keep_local')
        for engine in self.engines:
            self.assertEqual((engine.root / rel).read_bytes(), b'image')
            self.assertEqual(engine.clinical.details(rel)['note'], 'Retain me')
        self.assert_completed(self.run_sync())

    def test_deletion_review_can_delete_both_and_remove_annotations_without_resurrection(self):
        rel, job = self.deletion_fixture(0)
        resolved = self.resolve(job, 'delete_both')
        self.assertEqual(resolved['conflicts'][0]['resolution'], 'delete_both')
        for engine in self.engines:
            self.assertFalse((engine.root / rel).exists())
            self.assertFalse(engine.clinical.details(rel)['metadata_available'])
            self.assertTrue(any(p.read_bytes() == b'image' for p in engine.state_root.glob('archive/**/*.png')))
        self.assert_completed(self.run_sync()); self.assert_completed(self.run_sync())

    def test_independent_deletions_on_both_servers_remove_only_the_deleted_files_metadata(self):
        fixture = self.clinical_fixture(); rel = fixture['files'][0]['relative_path']
        retained = rel.replace('photo.png', 'retained.png')
        fixture['files'].append(dict(fixture['files'][0], relative_path=retained, note='Keep this note'))
        self.write(0, rel, b'delete me'); self.write(0, retained, b'keep me')
        for module in self.modules:
            module.update_storage_mapping_files = module._mapping_writer
            module.fetch_all_patients_metadata_from_supabase = lambda: self.fail('Must use caller-scoped cache')
        self.seed_local_details(fixture); self.pair(); self.assert_completed(self.run_sync())
        for i, engine in enumerate(self.engines):
            (engine.root / rel).unlink()  # Outside-app deletions leave annotations behind.
        job = self.run_sync(); self.assert_completed(job)
        self.assertEqual(job['conflicts'], [])
        for engine in self.engines:
            self.assertTrue(engine.record(rel)['deleted'])
            self.assertNotIn(rel.casefold(), engine.clinical.files)
            self.assertEqual(engine.clinical.details(retained)['note'], 'Keep this note')
            self.assertEqual((engine.root / retained).read_bytes(), b'keep me')
            details = json.loads((engine.root / rel.split('/')[0] / 'patient_media_details.json').read_text(encoding='utf-8'))
            self.assertNotIn('Periapical/photo.png', details['files'])
            mapping = json.loads((engine.root / 'patients_mapping.json').read_text(encoding='utf-8'))
            self.assertEqual([row['relative_path'] for row in mapping['files']], [retained])
        self.assert_completed(self.run_sync())
        self.assertEqual(len(self.engines[0].clinical.snapshot()['patients']), 1)

    def test_deleted_case_aliases_leave_no_review_or_metadata_and_do_not_resurrect(self):
        fixture = self.clinical_fixture(); original = fixture['files'][0]['relative_path']
        paths = [original, original.replace('Periapical/photo.png', 'periapical/PHOTO.PNG')]
        for i, path in enumerate(paths):
            self.write(i, path, b'image')
            data = copy.deepcopy(fixture); data['files'][0]['relative_path'] = path
            self.engines[i].clinical.replace(data)
        self.pair(); old_job = self.run_sync()
        self.assertEqual(old_job['conflicts'][0]['kind'], 'path_case')
        for i, path in enumerate(paths):
            self.engines[i].delete_local(path)
        job = self.run_sync(); self.assert_completed(job)
        self.assertEqual(job['conflicts'], [])
        for i, engine in enumerate(self.engines):
            self.assertEqual(engine.clinical.snapshot()['files'], [])
            self.assertTrue(engine.record(paths[i])['deleted'])
            self.assertEqual(engine.record(paths[i])['path'], paths[i])
            self.assertFalse((engine.root / paths[i]).exists())
            details = json.loads((engine.root / paths[i].split('/')[0] / 'patient_media_details.json').read_text(encoding='utf-8'))
            self.assertEqual(details['files'], {})
        self.assert_completed(self.run_sync()); self.assert_completed(self.run_sync())

    def test_new_review_actions_reject_stale_files_missing_winner_and_edited_copies(self):
        paths, job, route, client, snapshot = self.review_fixture()
        self.write(1, paths[1], b'changed')
        response = client.post(route, headers=self.headers, json=dict(action='keep_local', revision=snapshot['revision']))
        self.assertEqual(response.status_code, 409)
        self.assertEqual((self.engines[0].root / paths[0]).read_bytes(), b'PC original')
        snapshot = client.get(route, headers=self.headers).get_json()
        copy_path = next(self.engines[0].root.rglob('*__conflict-*.zip'))
        copy_path.write_bytes(b'edited separate copy')
        response = client.post(route, headers=self.headers, json=dict(action='keep_local', revision=snapshot['revision']))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()['code'], 'conflict_copy_changed')
        self.assertEqual(copy_path.read_bytes(), b'edited separate copy')
        self.assertNotIn('pendingAction', self.engines[0].jobs()[0]['conflicts'][0])

    def test_review_resolution_resumes_after_lost_response_and_server_restart(self):
        paths, job, route, client, snapshot = self.review_fixture()
        engine = self.engines[0]; original = engine.send_review_resolution
        def disconnected(destination, data, source=None):
            original(destination, data, source)
            if destination == 'remote':
                raise SyncError('Synchronization failed. Check both servers and retry.', 503)
        with patch.object(engine, 'send_review_resolution', side_effect=disconnected):
            response = client.post(route, headers=self.headers, json=dict(action='keep_local', revision=snapshot['revision']))
        self.assertEqual(response.status_code, 503)
        self.assertFalse(engine.jobs()[0]['conflicts'][0].get('reviewed'))
        with self.assertRaises(SyncError) as busy:
            engine.start()
        self.assertEqual(busy.exception.code, 'review_pending')
        restarted = SyncEngine(engine.root, engine.state_root, engine.extensions)
        latest = restarted.review_snapshot(job['id'], 0)
        self.assertEqual(latest['actions'], ['keep_local'])
        restarted.resolve_review(job['id'], 0, latest['revision'], 'keep_local')
        self.assert_chosen_image(paths, b'PC original')

    def test_deletion_review_rejects_a_missing_winner_and_keep_both(self):
        _, job = self.deletion_fixture(0)
        route = self.urls[0] + '/api/sync/jobs/%s/conflicts/0' % job['id']
        snapshot = json_request(route, headers=self.headers)
        self.assertEqual(snapshot['actions'], ['keep_remote', 'delete_both'])
        for action in ('keep_local', 'keep_both'):
            with self.assertRaises(SyncError) as invalid:
                json_request(route, 'POST', self.headers, dict(action=action, revision=snapshot['revision']))
            self.assertEqual(invalid.exception.status, 400)

    def test_resolution_checks_annotation_changes_before_overwriting_image(self):
        fixture = self.clinical_fixture(); rel = fixture['files'][0]['relative_path']
        for index in range(2):
            self.write(index, rel, b'PC image' if index == 0 else b'laptop image')
            self.engines[index].clinical.replace(fixture)
        self.pair(); job = self.run_sync()
        engine = self.engines[0]; original = engine.send_review_resolution
        def edit_during_save(destination, data, source=None):
            if destination == 'remote' and data['record']['path'] == rel:
                self.save_details(1, rel, dict(note='New note while saving'))
            return original(destination, data, source)
        with patch.object(engine, 'send_review_resolution', side_effect=edit_during_save), self.assertRaises(SyncError) as changed:
            self.resolve(job, 'keep_local')
        self.assertEqual(changed.exception.code, 'review_changed')
        self.assertEqual((self.engines[1].root / rel).read_bytes(), b'laptop image')
        self.assertEqual(self.engines[1].clinical.details(rel)['note'], 'New note while saving')
        self.assertFalse(engine.jobs()[0]['conflicts'][0].get('reviewed'))

    def test_resolution_streams_long_notes_and_preserves_missing_annotations(self):
        fixture = self.clinical_fixture(); rel = fixture['files'][0]['relative_path']
        self.write(0, rel, b'image'); self.save_details(0, rel, dict(note='Long note ' * 6500, tooth_ids=['A']))
        self.pair(); self.assert_completed(self.run_sync())
        for index in range(2):
            self.write(index, rel, b'changed PC' if index == 0 else b'changed laptop')
        job = self.run_sync(); self.resolve(job, 'keep_local')
        self.assertEqual(self.engines[1].clinical.details(rel)['note'], 'Long note ' * 6500)
        self.engines[1].clinical.remove(rel)
        self.write(0, rel, b'PC again'); self.write(1, rel, b'laptop again')
        job = self.run_sync(); self.resolve(job, 'keep_remote')
        for engine in self.engines:
            self.assertFalse(engine.clinical.details(rel)['metadata_available'])
            self.assertEqual((engine.root / rel).read_bytes(), b'laptop again')

    def test_peer_resolution_requires_pair_auth_and_valid_envelope(self):
        self.pair(); client = self.modules[1].app.test_client()
        for data in (b'', b'\x00\x00\x00\x02{}', b'\x00\x10\x00\x01'):
            self.assertEqual(client.put('/api/sync/peer/review-resolution', data=data).status_code, 401)
            response = client.put('/api/sync/peer/review-resolution', headers=self.engines[0].peer_headers(), data=data)
            self.assertEqual(response.status_code, 400)
        self.assertEqual(self.engines[1].scan(), {})

    def test_review_compares_originals_and_keeps_both_on_both_servers_durably(self):
        paths, job, route, client, snapshot = self.review_fixture()
        self.assertNotIn('secret', json.dumps(snapshot))
        self.assertNotEqual(snapshot['versions']['local']['sha256'], snapshot['versions']['remote']['sha256'])
        for side, expected in [('local', b'PC original'), ('remote', b'laptop original')]:
            response = client.get(route + '/file', headers=self.headers,
                                  query_string={'side': side, 'revision': snapshot['revision']})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data, expected)
            self.assertIn('no-store', response.headers['Cache-Control'])
            response.close()
        response = client.post(route, headers=self.headers, json={'action': 'keep_both', 'revision': snapshot['revision']})
        self.assertEqual(response.status_code, 200, response.get_json())
        resolved = response.get_json()['job']
        self.assertEqual(resolved['status'], 'completed')
        self.assertTrue(resolved['conflicts'][0]['reviewed'])
        for i, engine in enumerate(self.engines):
            self.assertEqual((engine.root / paths[i]).read_bytes(), [b'PC original', b'laptop original'][i])
            copies = list(engine.root.rglob('*__conflict-*.zip'))
            self.assertEqual(len(copies), 2)
            self.assertEqual({p.read_bytes() for p in copies}, {b'PC original', b'laptop original'})
        self.assert_completed(self.run_sync())
        self.assertTrue(client.get(route, headers=self.headers).get_json()['reviewed'])
        # The decision survives a server restart and does not hide later changes.
        e = self.engines[0]
        restarted = SyncEngine(e.root, e.state_root, e.extensions, e.thumbnail)
        self.assertEqual(restarted.meta('reviewedConflicts'), e.meta('reviewedConflicts'))
        self.write(1, paths[1], b'new laptop edit')
        changed = self.run_sync()
        self.assertEqual(changed['status'], 'completed_with_conflicts')
        self.assertFalse(changed['conflicts'][0].get('reviewed', False))

    def test_case_only_names_can_be_reviewed_without_replacing_or_duplicating_originals(self):
        paths, _, route, client, snapshot = self.review_fixture(case_only=True)
        self.assertEqual(snapshot['kind'], 'path_case')
        self.assertEqual(snapshot['versions']['local']['sha256'], snapshot['versions']['remote']['sha256'])
        response = client.post(route, headers=self.headers, json={'action': 'keep_both', 'revision': snapshot['revision']})
        self.assertEqual(response.status_code, 200, response.get_json())
        for i, engine in enumerate(self.engines):
            self.assertEqual([p.relative_to(engine.root).as_posix() for p in engine.root.rglob('*') if p.is_file()], [paths[i]])
        self.assert_completed(self.run_sync())
        self.write(1, paths[1], b'changed')
        self.assertEqual(self.run_sync()['status'], 'completed_with_conflicts')

    def test_case_only_names_offer_either_image_and_preserve_each_servers_path(self):
        paths, job, route, client, snapshot = self.review_fixture(case_only=True)
        self.write(0, paths[0], b'PC choice')
        self.write(1, paths[1], b'laptop choice')
        snapshot = client.get(route, headers=self.headers).get_json()
        self.assertEqual(snapshot['actions'], ['keep_both', 'keep_local', 'keep_remote'])
        self.resolve(job, 'keep_local')
        for i, engine in enumerate(self.engines):
            self.assertEqual((engine.root / paths[i]).read_bytes(), b'PC choice')
            self.assertEqual([r['path'] for r in engine.scan().values() if not r['deleted']], [paths[i]])
        self.assert_completed(self.run_sync())
        self.write(1, paths[1], b'new laptop choice')
        self.resolve(self.run_sync(), 'keep_remote')
        for i, engine in enumerate(self.engines):
            self.assertEqual((engine.root / paths[i]).read_bytes(), b'new laptop choice')
        self.assert_completed(self.run_sync())

    def test_case_only_names_choose_annotations_and_accept_later_one_sided_edits(self):
        fixture = self.clinical_fixture(); original = fixture['files'][0]['relative_path']
        paths = [original, original.replace('Periapical/photo.png', 'periapical/PHOTO.PNG')]
        for i in range(2):
            self.write(i, paths[i], b'PC' if i == 0 else b'laptop')
            row = copy.deepcopy(fixture); row['files'][0].update(relative_path=paths[i], note='PC' if i == 0 else 'laptop')
            self.engines[i].clinical.replace(row)
        self.pair(); job = self.run_sync(); self.assertEqual(job['conflicts'][0]['kind'], 'path_case')
        self.resolve(job, 'keep_remote')
        for i, engine in enumerate(self.engines):
            self.assertEqual((engine.root / paths[i]).read_bytes(), b'laptop')
            self.assertEqual(engine.clinical.details(paths[i])['note'], 'laptop')
            self.assertEqual(engine.clinical.files[paths[i].casefold()]['relative_path'], paths[i])
        self.assert_completed(self.run_sync())
        self.save_details(0, paths[0], dict(note='Next local note'))
        self.assert_completed(self.run_sync())
        self.assertEqual(self.engines[1].clinical.details(paths[1])['note'], 'Next local note')

    def test_case_only_names_offer_deletion_or_restoration_when_one_copy_is_deleted(self):
        paths, _, _, _, _ = self.review_fixture(case_only=True)
        self.engines[0].delete_local(paths[0])
        job = self.run_sync()
        self.resolve(job, 'keep_remote')
        for i, engine in enumerate(self.engines):
            self.assertEqual((engine.root / paths[i]).read_bytes(), b'same')
        self.assert_completed(self.run_sync())
        self.engines[1].delete_local(paths[1])
        self.resolve(self.run_sync(), 'delete_both')
        for i, engine in enumerate(self.engines):
            self.assertFalse((engine.root / paths[i]).exists())
        self.assert_completed(self.run_sync())

    def test_stale_review_and_file_requests_reject_changes_without_accepting_them(self):
        paths, _, route, client, snapshot = self.review_fixture()
        self.write(1, paths[1], b'edited after comparison')
        for response in [client.post(route, headers=self.headers, json={'action': 'keep_both', 'revision': snapshot['revision']}),
                         client.get(route + '/file', headers=self.headers, query_string={'side': 'remote', 'revision': snapshot['revision']})]:
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.get_json()['code'], 'review_changed')
        self.assertFalse(client.get(route, headers=self.headers).get_json()['reviewed'])
        self.assertEqual((self.engines[1].root / paths[1]).read_bytes(), b'edited after comparison')

    def test_review_requires_clinic_key_admin_current_peer_and_supported_action(self):
        _, job, route, client, snapshot = self.review_fixture()
        for headers in [{}, {'x-lumin-key': self.keys[0]}, {'Authorization': 'Bearer admin'}]:
            for method, endpoint in [('get', route), ('get', route + '/file'), ('post', route)]:
                response = getattr(client, method)(endpoint, headers=headers)
                self.assertIn(response.status_code, (401, 403))
        self.assertEqual(client.post(route, headers=self.headers, json={'action': 'overwrite'}).status_code, 400)
        self.assertEqual(client.get(route.replace('/0', '/999'), headers=self.headers).status_code, 404)
        job['peerId'] = 'different-computer'
        self.engines[0].update_job(job)
        response = client.get(route, headers=self.headers)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()['code'], 'peer_changed')

    def test_review_during_sync_and_edited_preserved_copy_cannot_be_accepted(self):
        _, job, route, client, snapshot = self.review_fixture()
        copy_path = next(self.engines[0].root.rglob('*__conflict-*.zip'))
        copy_path.write_bytes(b'edited preserved version')
        response = client.post(route, headers=self.headers, json={'action': 'keep_both', 'revision': snapshot['revision']})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()['code'], 'conflict_copy_changed')
        self.assertFalse(self.engines[0].jobs()[0]['conflicts'][0].get('reviewed', False))
        job['status'] = 'running'
        self.engines[0].update_job(job)
        for response in [client.get(route, headers=self.headers),
                         client.post(route, headers=self.headers, json={'action': 'keep_both', 'revision': snapshot['revision']})]:
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.get_json()['code'], 'sync_busy')

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
        self.resolve(self.run_sync(), 'delete_both')
        self.assertFalse((self.engines[1].root / paths[0]).exists())



    def test_metadata_regeneration_and_legacy_records_do_not_interrupt_file_sync(self):
        """Generated metadata must never be transferred, verified or deleted."""
        import hashlib
        import zipfile
        original = io.BytesIO()
        with zipfile.ZipFile(original, 'w') as archive:
            archive.writestr('upper.obj', 'v 0 0 1\n')
        zip_bytes = original.getvalue()
        image_path = 'Ahmed_Ali/Periapical/xray.png'
        scan_path = 'Patient_B/3D-Scans/visit/Original Scan.ZIP'
        metadata_path = 'Ahmed_Ali/patient_media_details.json'
        self.write(0, image_path, b'png-binary-data')
        self.write(1, scan_path, zip_bytes)
        caches = [metadata_path, 'Ahmed_Ali/patient_media_details__conflict-old.json',
                  'Ahmed_Ali/patient_media_details.conflict-old.json',
                  'patients_mapping.json', 'patients_mapping.sql',
                  'Ahmed_Ali/patient_mapping.json', 'Ahmed_Ali/notes.db',
                  'Ahmed_Ali/index.sqlite3']
        # Simulate sync history created by the previous server version.
        for index, engine in enumerate(self.engines):
            for path in caches:
                content = ('local cache %s: %s' % (index, path)).encode()
                self.write(index, path, content)
                if Path(path).name.startswith('patient_media_details'):
                    record = dict(path=path, deleted=False, size=len(content),
                                  sha256=hashlib.sha256(content).hexdigest(),
                                  clock={engine.node_id: 1})
                    with engine.database() as db:
                        db.execute('INSERT INTO records VALUES (?,?)',
                                   (path.casefold(), json.dumps(record)))
        def regenerate(index):
            self.write(index, metadata_path, ('regenerated on node %s' % index).encode())
        for index, engine in enumerate(self.engines):
            engine.on_change = lambda index=index: regenerate(index)
        self.pair()
        job = self.run_sync()
        self.assert_completed(job)
        self.assertEqual(job['conflicts'], [])
        self.assertEqual(job['copiedFiles'], 2)
        self.assertEqual((self.engines[1].root / image_path).read_bytes(), b'png-binary-data')
        self.assertEqual((self.engines[0].root / scan_path).read_bytes(), zip_bytes)
        for index, engine in enumerate(self.engines):
            for path in caches:
                self.assertIsNone(engine.record(path))
                self.assertTrue((engine.root / path).is_file())
                expected = ('regenerated on node %s' % index) if path == metadata_path else ('local cache %s: %s' % (index, path))
                self.assertEqual((engine.root / path).read_bytes(), expected.encode())
            self.assertNotIn('json', engine.extensions)
            self.assertIn('zip', engine.extensions)
        self.assertEqual(self.run_sync()['copiedFiles'], 0)

    def test_incompatible_scope_requires_update_before_any_patient_file_changes(self):
        self.write(0, 'P/Panoramic/xray.png', b'original image')
        self.pair()
        engine = self.engines[0]
        legacy = {'nodeId': self.engines[1].node_id, 'fileScope': 'incompatible-files', 'files': {}}
        with patch.object(engine, 'peer_json', return_value=legacy):
            job = self.run_sync()
        self.assertEqual(job['status'], 'failed')
        self.assertIn('Update and restart', job['error'])
        self.assertEqual(job['copiedFiles'], 0)
        self.assertFalse((self.engines[1].root / 'P/Panoramic/xray.png').exists())
        with patch('file_sync.json_request', return_value={'nodeId': self.engines[1].node_id, 'protocol': 1,
                                                        'fileScope': 'incompatible-files'}):
            result = self.modules[0].app.test_client().post('/api/sync/pair', headers=self.headers,
                         json={'url': self.urls[1], 'key': self.keys[1]})
        self.assertEqual(result.status_code, 426)

    def test_zip_is_included_with_image_only_config_and_metadata_is_rejected(self):
        engine = SyncEngine(self.engines[0].root, self.base / 'image-only-state', ['png', 'JSON', 'sqlite3'])
        self.assertEqual(engine.extensions, {'png', 'zip', 'dcm', 'dicom'})
        self.write(0, 'P/3D-Scans/original.ZIP', b'original archive')
        self.write(0, 'P/patient_media_details.json', b'{}')
        self.assertEqual(set(engine.scan()), {'p/3d-scans/original.zip'})
        with self.assertRaises(SyncError):
            engine.observe('P/patient_media_details.json')



    def test_review_and_original_downloads_check_only_the_selected_file(self):
        _, _, route, client, snapshot = self.review_fixture()
        self.write(0, 'Another_Patient/3D-Scans/unrelated.zip', b'unrelated large scan')
        self.write(1, 'Another_Patient/3D-Scans/unrelated.zip', b'other unrelated scan')
        with patch.object(self.engines[0], 'scan', side_effect=AssertionError('review rescanned the clinic')), \
             patch.object(self.engines[1], 'scan', side_effect=AssertionError('review rescanned the peer')):
            response = client.get(route, headers=self.headers)
            self.assertEqual(response.status_code, 200, response.get_json())
            self.assertEqual(response.get_json()['revision'], snapshot['revision'])
            for side, expected in [('local', b'PC original'), ('remote', b'laptop original')]:
                response = client.get(route + '/file', headers=self.headers,
                    query_string={'side': side, 'revision': snapshot['revision']})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.data, expected)
                response.close()


    def test_targeted_review_requires_peer_auth_and_handles_older_peer(self):
        paths, _, route, client, snapshot = self.review_fixture()
        remote = self.modules[1].app.test_client()
        endpoint = '/api/sync/peer/review-record'
        self.assertEqual(remote.get(endpoint, query_string={'path': paths[1]}).status_code, 401)
        headers = self.engines[0].peer_headers()
        self.assertEqual(remote.get(endpoint, headers=headers, query_string={'path': '../outside.pdf'}).status_code, 403)
        self.assertEqual(remote.get(endpoint, headers=headers, query_string={'path': 'P/patient_media_details.json'}).status_code, 400)
        peer_json = self.engines[0].peer_json
        def older_peer(route, *args, **kwargs):
            if route.startswith('review-record?'):
                raise SyncError('Older peer endpoint unavailable', 404)
            return peer_json(route, *args, **kwargs)
        with patch.object(self.engines[0], 'peer_json', side_effect=older_peer):
            response = client.get(route, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json()['revision'], snapshot['revision'])


if __name__ == '__main__':
    import logging
    logging.getLogger('werkzeug').setLevel(logging.ERROR)
    unittest.main()
