from datetime import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / 'storage-server'))


class StorageSecurityTests(unittest.TestCase):
    server_directory = "storage-server"
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'patients'
        self.root.mkdir()
        (self.root / 'film.png').write_bytes(b'fixture-image')
        self.key = 'private-test-key-' + 'x' * 32
        config = Path(self.temp.name) / 'config.json'
        config.write_text(json.dumps({'storage_path': str(self.root), 'clinic_secret_key': self.key}))
        spec = importlib.util.spec_from_file_location('security_storage', BASE / self.server_directory / 'server.py')
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {'LUMIN_STORAGE_CONFIG': str(config)}):
            spec.loader.exec_module(self.module)
        self.client = self.module.app.test_client()
        self.headers = {'x-lumin-key': self.key}

    def tearDown(self):
        self.temp.cleanup()

    def test_blank_default_and_query_keys_are_rejected(self):
        for value in ['', 'LuminClinicKey_2026']:
            self.module.config['clinic_secret_key'] = value
            self.assertEqual(self.client.get('/files/film.png', headers={'x-lumin-key': value}).status_code, 401)
        self.module.config['clinic_secret_key'] = self.key
        self.assertEqual(self.client.get('/files/film.png', query_string={'key': self.key}).status_code, 401)

    def test_grants_expire_revoke_and_authorize_only_media_reads(self):
        self.assertEqual(self.client.post('/api/media-grant').status_code, 401)
        token = self.client.post('/api/media-grant', headers=self.headers).json['mediaGrant']
        response = self.client.get('/files/film.png', query_string={'media': token})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, b'fixture-image')
        self.assertEqual(response.headers['Cache-Control'], 'private, no-store')
        response.close()
        self.assertEqual(self.client.get('/api/storage/location', query_string={'media': token}).status_code, 401)
        self.assertEqual(self.client.post('/api/upload', query_string={'media': token}).status_code, 401)
        expiry, root, key = self.module._media_grants[token]
        self.module._media_grants[token] = (0, root, key)
        self.assertEqual(self.client.get('/files/film.png', query_string={'media': token}).status_code, 401)
        token = self.client.post('/api/media-grant', headers=self.headers).json['mediaGrant']
        self.client.post('/api/media-grant/revoke', headers=self.headers, json={'mediaGrant': token})
        self.assertEqual(self.client.get('/files/film.png', query_string={'media': token}).status_code, 401)

    def test_storage_admin_controls_require_current_admin_role(self):
        self.assertEqual(self.client.get('/api/sync/info', headers=self.headers).status_code, 401)
        self.assertEqual(self.client.get('/api/storage/location', headers=self.headers).status_code, 401)
        def auth(url, **kwargs):
            return {'id': 'fixture-user'} if '/auth/v1/user' in url else [{'active': True, 'access_roles': {'is_admin': False}}]
        self.module.json_request = auth
        headers = {**self.headers, 'Authorization': 'Bearer fixture'}
        self.assertEqual(self.client.get('/api/storage/location', headers=headers).status_code, 403)
        self.module.json_request = lambda url, **kwargs: {'id': 'fixture-user'} if '/auth/v1/user' in url else [{'active': True, 'access_roles': {'is_admin': True}}]
        self.assertEqual(self.client.get('/api/storage/location', headers=headers).status_code, 200)
        self.module.json_request = lambda url, **kwargs: {'id':'fixture-user'} if '/auth/v1/user' in url else [{'active':False,'access_roles':{'is_admin':True}}]
        self.assertEqual(self.client.get('/api/storage/location', headers=headers).status_code, 403)

    def test_cors_allows_clinic_and_rejects_unrelated_origins(self):
        for origin, allowed in [('https://lumin.gazarxperia.workers.dev', True), ('https://unrelated.invalid', False)]:
            response = self.client.options('/api/upload', headers={'Origin': origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-lumin-key'})
            self.assertEqual(bool(response.headers.get('Access-Control-Allow-Origin')), allowed)

    def test_same_name_uploads_in_one_second_preserve_both_originals(self):
        self.module.update_storage_mapping_files = lambda: {}
        paths = []
        with patch.object(self.module, 'datetime') as clock:
            clock.now.return_value = datetime(2026, 10, 13, 12, 0, 0)
            for content in [b'first clinical image', b'second clinical image']:
                response = self.client.post('/api/upload', headers=self.headers, data={
                    'patientId': 'fixture-patient', 'patientName': 'Fixture Patient', 'category': 'Periapical',
                    'file': (io.BytesIO(content), 'same-name.png'),
                })
                self.assertEqual(response.status_code, 200)
                paths.append(response.json['relativePath'])
        self.assertNotEqual(paths[0], paths[1])
        self.assertEqual((self.root / paths[0]).read_bytes(), b'first clinical image')
        self.assertEqual((self.root / paths[1]).read_bytes(), b'second clinical image')


class DedicatedStorageSecurityTests(StorageSecurityTests):
    server_directory = "lumin-dedicated-server-setup"
    test_same_name_uploads_in_one_second_preserve_both_originals = None


class StationStorageSecurityTests(StorageSecurityTests):
    server_directory = "lumin-server-station"
    test_same_name_uploads_in_one_second_preserve_both_originals = None


if __name__ == '__main__':
    unittest.main()
