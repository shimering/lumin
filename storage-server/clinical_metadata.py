"""Local patient/media annotations with validated server synchronization.

SQLite is authoritative; per-patient JSON remains a portable local backup.
Generated indexes are never treated as binary file revisions.
"""
import hashlib
import json
import re
import sqlite3
import threading
import uuid
import os
from contextlib import closing
from datetime import date
from pathlib import Path

VERSION = 2
MAX_BYTES = 32 * 1024 * 1024
MAX_ROWS = 100000
TEETH = {str(n) for n in range(1, 33)} | set('ABCDEFGHIJKLMNOPQRST')


def text(value, limit=1024):
    if value is None:
        return ''
    if not isinstance(value, (str, int)) or isinstance(value, bool):
        raise ValueError('Invalid clinical metadata')
    value = str(value)
    if len(value) > limit or '\x00' in value:
        raise ValueError('Invalid clinical metadata')
    return value


def patient_id(value):
    return str(uuid.UUID(str(value)))


def folder_name(value):
    return re.sub(r'[\s_]+', '_', re.sub(r'[<>:"/\\|?*]+', '_', value.strip())).strip(' ._')


class ClinicalMetadata:
    def __init__(self, root, state_root, validate_path):
        self.root = Path(root)
        self.path = Path(state_root) / 'clinical.sqlite3'
        self.validate_path = validate_path
        self.lock = threading.RLock()
        self._snapshot = None
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS imports (folder TEXT PRIMARY KEY, digest TEXT NOT NULL)')
            row = db.execute('SELECT value FROM snapshot WHERE id=1').fetchone()
        if row:
            self._snapshot = self.normalise(json.loads(row[0]))
        self._index()

    def normalise(self, data):
        if (not isinstance(data, dict) or data.get('version') not in (1, VERSION)
                or not isinstance(data.get('patients'), list) or not isinstance(data.get('files'), list)
                or len(data['patients']) + len(data['files']) > MAX_ROWS
                or len(json.dumps(data, allow_nan=False).encode()) > MAX_BYTES):
            raise ValueError('Invalid clinical metadata')
        patients, files, paths = {}, [], set()
        for row in data['patients']:
            if not isinstance(row, dict):
                raise ValueError('Invalid clinical metadata')
            pid = patient_id(row.get('id'))
            if pid in patients:
                raise ValueError('Duplicate patient metadata')
            patients[pid] = dict(id=pid, name=text(row.get('name')), patient_number=text(row.get('patient_number'), 64),
                                 phone=text(row.get('phone'), 128))
        for row in data['files']:
            if not isinstance(row, dict):
                raise ValueError('Invalid clinical metadata')
            pid, rel = patient_id(row.get('patient_id')), text(row.get('relative_path'), 2048).replace('\\', '/')
            self.validate_path(self.root, rel)
            if pid not in patients or rel.casefold() in paths:
                raise ValueError('Ambiguous media metadata')
            paths.add(rel.casefold())
            ids = row.get('tooth_ids') if row.get('tooth_ids') is not None else ([row.get('tooth_id')] if row.get('tooth_id') else [])
            if not isinstance(ids, list) or len(ids) > 52:
                raise ValueError('Invalid tooth assignments')
            if any(str(x) not in TEETH for x in ids):
                raise ValueError('Invalid tooth assignments')
            ids = list(dict.fromkeys(str(x) for x in ids))
            scan_date = text(row.get('scan_date'), 10)
            if scan_date:
                date.fromisoformat(scan_date)
            scan_config = row.get('scan_config')
            if scan_config is not None and (not isinstance(scan_config, dict)
                    or len(json.dumps(scan_config, allow_nan=False)) > 131072):
                raise ValueError('Invalid scan settings')
            source = text(row.get('source_relative_path'), 2048)
            if source:
                self.validate_path(self.root, source)
            files.append(dict(patient_id=pid, relative_path=rel, display_name=text(row.get('display_name'), 2048),
                              note=text(row.get('note'), 65536), tooth_id=ids[0] if ids else '', tooth_ids=ids,
                              scan_date=scan_date, scan_config=scan_config, source_relative_path=source))
        return dict(version=VERSION, patients=sorted(patients.values(), key=lambda p: p['id']),
                    files=sorted(files, key=lambda f: f['relative_path'].casefold()))

    def _index(self):
        data = self._snapshot or {'patients': [], 'files': []}
        self.patients = {p['id']: p for p in data['patients']}
        self.files = {f['relative_path'].casefold(): f for f in data['files']}
        candidates = {}
        for p in data['patients']:
            for name in (folder_name(p['name']), p['id']):
                if name:
                    candidates.setdefault(name.casefold(), set()).add(p['id'])
        media_folders = {}
        for f in data['files']:
            media_folders.setdefault(f['relative_path'].split('/')[0].casefold(), set()).add(f['patient_id'])
        candidates.update(media_folders)
        self.folders = {name: self.patients[next(iter(ids))] for name, ids in candidates.items() if len(ids) == 1}

    def snapshot(self):
        with self.lock:
            return json.loads(json.dumps(self._snapshot)) if self._snapshot is not None else None

    @staticmethod
    def digest(data):
        return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    def replace(self, data):
        data = self.normalise(data)
        with self.lock:
            with closing(sqlite3.connect(self.path)) as db, db:
                db.execute('INSERT OR REPLACE INTO snapshot VALUES (1,?)', (json.dumps(data, ensure_ascii=False),))
            self._snapshot = data
            self._index()
        return self.digest(data)

    def replace_checked(self, data, expected):
        with self.lock:
            if self.digest(self._snapshot) != expected:
                raise ValueError('Local annotations changed during synchronization')
            return self.replace(data)

    def _tag(self, folder):
        meta = self.root / folder / '.patient_id'
        try:
            if meta.is_symlink() or getattr(meta.lstat(), 'st_file_attributes', 0) & 1024 or meta.stat().st_size > 65536:
                return {}
            raw = meta.read_text(encoding='utf-8')
            data = json.loads(raw) if raw.lstrip().startswith('{') else {'patient_id': raw.strip()}
            if not isinstance(data, dict):
                return {}
            try:
                data['patient_id'] = patient_id(data.get('patient_id'))
            except ValueError:
                data.pop('patient_id', None)
            return data
        except (OSError, ValueError):
            return {}

    def import_folder(self, folder):
        """Import previous local JSON once per content revision, without cloud access."""
        source = self.root / folder / 'patient_media_details.json'
        if not source.is_file():
            return
        if source.is_symlink() or getattr(source.lstat(), 'st_file_attributes', 0) & 1024 or source.stat().st_size > MAX_BYTES:
            raise ValueError('Invalid local metadata file')
        # Unrelated generated JSON in an untagged folder is not a patient store.
        tag = self._tag(folder)
        if not tag.get('patient_id'):
            try:
                data = json.loads(source.read_bytes())
                patient_id(data.get('patient_id'))
            except (ValueError, AttributeError):
                return
        raw = source.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        with self.lock:
            with closing(sqlite3.connect(self.path)) as db:
                prior = db.execute('SELECT digest FROM imports WHERE folder=?', (folder,)).fetchone()
            if prior and prior[0] == digest:
                return
            data = json.loads(raw)
            tag = self._tag(folder)
            pid = patient_id(data.get('patient_id') or tag.get('patient_id'))
            if tag.get('patient_id') and pid != tag['patient_id']:
                raise ValueError('Patient identity does not match local metadata')
            incoming = dict(version=VERSION, patients=[dict(id=pid, name=data.get('patient_name') or tag.get('patient_name') or folder.replace('_', ' '),
                            patient_number=data.get('patient_number') or tag.get('patient_number'), phone=data.get('phone') or tag.get('phone'))], files=[])
            files = data.get('files') or {}
            if not isinstance(files, dict):
                raise ValueError('Invalid local metadata file')
            for key, row in files.items():
                if not isinstance(row, dict):
                    raise ValueError('Invalid local metadata file')
                subpath = str(row.get('subpath') or key).replace('\\', '/')
                if subpath.startswith(folder + '/'):
                    subpath = subpath[len(folder) + 1:]
                incoming['files'].append(dict(row, patient_id=pid, relative_path=folder + '/' + subpath))
            incoming = self.normalise(incoming)
            current = self.snapshot() or dict(version=VERSION, patients=[], files=[])
            patients = {p['id']: p for p in current['patients']}
            files = {f['relative_path'].casefold(): f for f in current['files']
                     if f['relative_path'].split('/')[0].casefold() != folder.casefold()}
            patients.update({p['id']: p for p in incoming['patients']})
            files.update({f['relative_path'].casefold(): f for f in incoming['files']})
            self.replace(dict(version=VERSION, patients=list(patients.values()), files=list(files.values())))
            with closing(sqlite3.connect(self.path)) as db, db:
                db.execute('INSERT OR REPLACE INTO imports VALUES (?,?)', (folder, digest))

    def upsert(self, rel, pid, changes, patient=None):
        with self.lock:
            self.validate_path(self.root, rel)
            pid = patient_id(pid)
            current = self.snapshot() or dict(version=VERSION, patients=[], files=[])
            patients = {p['id']: p for p in current['patients']}
            files = {f['relative_path'].casefold(): f for f in current['files']}
            prior = files.get(rel.casefold()) or {}
            if prior and prior['patient_id'] != pid:
                raise ValueError('Patient identity does not match media')
            patients[pid] = {**(patients.get(pid) or {}), **(patient or {}), 'id': pid}
            files[rel.casefold()] = dict(prior, **{k: v for k, v in changes.items() if k in (
                'display_name', 'note', 'tooth_id', 'tooth_ids', 'scan_date', 'scan_config', 'source_relative_path')}, patient_id=pid, relative_path=rel)
            self.replace(dict(version=VERSION, patients=list(patients.values()), files=list(files.values())))
            self.write_folder(rel.split('/')[0])
            return dict(self.files[rel.casefold()])

    def import_all(self):
        for folder in self.root.iterdir():
            if folder.is_dir() and not folder.name.startswith('.'):
                self.validate_path(self.root, folder.name)
                self.import_folder(folder.name)
                tag = self._tag(folder.name)
                try:
                    pid = patient_id(tag.get('patient_id'))
                except ValueError:
                    continue
                with self.lock:
                    if pid not in self.patients:
                        current = self.snapshot() or dict(version=VERSION, patients=[], files=[])
                        current['patients'].append(dict(id=pid, name=tag.get('patient_name') or folder.name.replace('_', ' '),
                                                       patient_number=tag.get('patient_number'), phone=tag.get('phone')))
                        self.replace(current)

    def write_all(self):
        for folder in self.root.iterdir():
            if folder.is_dir() and not folder.name.startswith('.'):
                self.validate_path(self.root, folder.name)
                self.write_folder(folder.name)

    def rename_folder(self, old, new, pid, name):
        with self.lock:
            current = self.snapshot()
            if not current:
                return
            for row in current['files']:
                if row['relative_path'].startswith(old + '/'):
                    row['relative_path'] = new + row['relative_path'][len(old):]
            for patient in current['patients']:
                if patient['id'] == pid:
                    patient['name'] = name
            self.replace(current)
            self.write_folder(new)

    def remove(self, rel):
        with self.lock:
            current = self.snapshot()
            if current and rel.casefold() in self.files:
                current['files'] = [f for f in current['files'] if f['relative_path'].casefold() != rel.casefold()]
                self.replace(current)
                self.write_folder(rel.split('/')[0])

    def move(self, source, destination):
        with self.lock:
            current = self.snapshot()
            if not current:
                return
            changed = False
            for row in current['files']:
                if row['relative_path'].casefold() == source.casefold():
                    row['relative_path'] = destination
                    changed = True
            if changed:
                self.replace(current)
                self.write_folder(destination.split('/')[0])
                if source.split('/')[0] != destination.split('/')[0]:
                    self.write_folder(source.split('/')[0])

    def write_folder(self, folder):
        with self.lock:
            rows = [f for f in self.files.values() if f['relative_path'].split('/')[0] == folder]
            patient = self.patients.get(rows[0]['patient_id']) if rows else self.patient_for_folder(folder)
            if not patient or not (self.root / folder).is_dir():
                return
            target = self.root / folder / 'patient_media_details.json'
            if target.is_symlink() or (target.exists() and getattr(target.lstat(), 'st_file_attributes', 0) & 1024):
                raise ValueError('Linked metadata files are not supported')
            data = dict(patient_id=patient['id'], patient_name=patient.get('name', ''),
                        patient_number=patient.get('patient_number', ''), phone=patient.get('phone', ''),
                        files={f['relative_path'].split('/', 1)[1]: f for f in rows})
            raw = json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8')
            temporary = target.with_name('.tmp-media-' + uuid.uuid4().hex)
            try:
                temporary.write_bytes(raw)
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
            with closing(sqlite3.connect(self.path)) as db, db:
                db.execute('INSERT OR REPLACE INTO imports VALUES (?,?)', (folder, hashlib.sha256(raw).hexdigest()))

    def patient_for_folder(self, name):
        with self.lock:
            # An existing UUID tag is more reliable than a patient's name.
            pid = self._tag(name).get('patient_id')
            if pid in self.patients:
                return dict(self.patients[pid])
            return dict(self.folders.get(name.casefold()) or {})

    def details(self, rel):
        with self.lock:
            self.validate_path(self.root, rel)
            row = self.files.get(rel.casefold())
            source = rel
            if row is None:
                # Copies created by sync retain the original clinical annotations.
                path = Path(rel)
                stem = re.sub(r'__conflict-[0-9a-f]{8}-[0-9a-f]{12}$', '', path.stem)
                source = path.with_name(stem + path.suffix).as_posix()
                row = self.files.get(source.casefold())
            if row and row.get('source_relative_path'):
                source = row['source_relative_path']
            patient = self.patients.get(row['patient_id']) if row else self.patient_for_folder(rel.split('/')[0])
            if not patient:
                # Offline folders can still show their locally stored identity.
                try:
                    tag = self._tag(rel.split('/')[0])
                    patient = dict(id=text(tag.get('patient_id'), 64), name=text(tag.get('patient_name')),
                                   patient_number=text(tag.get('patient_number'), 64), phone=text(tag.get('phone'), 128))
                except (OSError, ValueError, AttributeError):
                    patient = {}
            result = dict(row or {})
            result.update(patient_id=patient.get('id', ''), patient_number=patient.get('patient_number', ''),
                          patient_name=patient.get('name', ''), relative_path=rel,
                          source_relative_path=source if row else '', metadata_available=bool(row))
            return result


MEDIA_COLUMNS = {
    'relative_path': 'TEXT', 'patient_id': 'TEXT', 'patient_number': 'TEXT', 'display_name': 'TEXT',
    'note': 'TEXT', 'tooth_id': 'TEXT', 'tooth_ids': 'TEXT', 'scan_date': 'TEXT', 'scan_config': 'TEXT',
    'source_relative_path': 'TEXT', 'metadata_available': 'INTEGER'
}


def export_values(record):
    return [json.dumps(record.get(k), ensure_ascii=False) if k in ('tooth_ids', 'scan_config')
            else int(bool(record.get(k))) if k == 'metadata_available' else record.get(k) or '' for k in MEDIA_COLUMNS]


def media_sql(records, quote):
    columns = '`id`, ' + ', '.join('`' + k + '`' for k in MEDIA_COLUMNS)
    result = ['\n-- Local patient/media annotations; shared by authenticated server sync.',
              'CREATE TABLE IF NOT EXISTS `patient_media_details_mapping` (',
              '  `id` char(64) NOT NULL PRIMARY KEY, `relative_path` text NOT NULL,',
              '  `patient_id` varchar(64) NOT NULL, `patient_number` varchar(64),',
              '  `display_name` text, `note` longtext, `tooth_id` varchar(4), `tooth_ids` text,',
              '  `scan_date` varchar(10), `scan_config` longtext, `source_relative_path` text,',
              '  `metadata_available` tinyint NOT NULL DEFAULT 0',
              ') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;']
    for row in records:
        identity = hashlib.sha256(row['relative_path'].casefold().encode()).hexdigest()
        values = quote(identity) + ', ' + ', '.join(str(v) if isinstance(v, int) else quote(v) for v in export_values(row))
        updates = ', '.join('`%s`=VALUES(`%s`)' % (k, k) for k in MEDIA_COLUMNS if k != 'relative_path')
        result.append('INSERT INTO `patient_media_details_mapping` (%s) VALUES (%s) ON DUPLICATE KEY UPDATE %s;' %
                      (columns, values, updates))
    return '\n'.join(result) + '\n'


def media_sqlite(db, records):
    db.execute('CREATE TABLE IF NOT EXISTS patient_media_details_mapping (' +
               ', '.join(k + ' ' + kind + (' PRIMARY KEY' if k == 'relative_path' else '')
                         for k, kind in MEDIA_COLUMNS.items()) + ')')
    db.execute('DELETE FROM patient_media_details_mapping')
    db.executemany('INSERT INTO patient_media_details_mapping (' + ','.join(MEDIA_COLUMNS) + ') VALUES (' +
                   ','.join('?' for _ in MEDIA_COLUMNS) + ')', [export_values(r) for r in records])
