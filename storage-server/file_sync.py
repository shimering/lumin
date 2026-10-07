"""Two-node file replication. Runtime state and recovery archives are never served.

Each path has a two-node version vector, so wall clocks are not used to decide
which file wins. Filesystem changes outside Lumin are discovered during scans.
"""

import base64
from contextlib import contextmanager
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import sqlite3
import stat
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from flask import Response, jsonify, request, send_file
from clinical_metadata import ClinicalMetadata, VERSION as CLINICAL_VERSION, MAX_BYTES as CLINICAL_MAX_BYTES

CHUNK = 256 * 1024
PROTOCOL = 1
MAX_CLOCK_ENTRIES = 64
FILE_SCOPE = 'patient-files-v1'
EXCLUDED_EXTENSIONS = {'json', 'sql', 'sqlite', 'sqlite3', 'db'}
# Only these fixed messages may be forwarded from a peer. Never relay arbitrary
# response bodies, which can contain patient paths, proxy pages or credentials.
KNOWN_SYNC_ERRORS = {
    'Invalid sync record.': 'invalid_record',
    'Invalid transfer metadata.': 'invalid_transfer',
    'Invalid clinical metadata.': 'invalid_clinical_metadata',
    'Patient metadata could not be refreshed. Files were synchronized using cached details.': 'metadata_unavailable',
    'File extension is not permitted.': 'file_excluded',
    'File is excluded from synchronization.': 'file_excluded',
    'A file changed during scanning. Retry sync.': 'file_changed',
    'A file changed during synchronization. Retry sync.': 'file_changed',
    'Source file changed. Retry sync.': 'file_changed',
    'Files changed before final verification. Retry sync.': 'file_changed',
    'Transfer exceeded the expected file size.': 'verification_failed',
    'File verification failed. Retry sync.': 'verification_failed',
    'Storage contains colliding filenames. Review them before syncing.': 'name_collision',
    'A preserved conflict copy was changed. Review it before retrying.': 'conflict_copy_changed',
    'Server redirects are not allowed. Update the saved server URL.': 'server_redirect',
    'Peer identity changed. Pair the servers again.': 'peer_changed',
    'Pair the two servers first.': 'pair_required',
    'Start synchronization on the paired dedicated PC.': 'wrong_coordinator',
    'Wait for the current sync to finish before pairing.': 'sync_busy',
    'Wait for the current sync to finish before unpairing.': 'sync_busy',
    'Choose two different servers with compatible sync support.': 'same_server',
    'Update and restart the storage server on both computers to sync patient files only.': 'update_required',
    'Files changed while reviewing. Reload the comparison.': 'review_changed',
    'Wait for the current sync to finish before reviewing.': 'sync_busy',
    'This server is already paired with another computer.': 'already_paired',
    'Select the existing dedicated PC as the coordinator.': 'wrong_coordinator',
    'Invalid peer manifest.': 'invalid_manifest',
    'Unauthorized. Invalid or missing clinic secret key.': 'invalid_clinic_key',
    'Invalid sync peer credentials.': 'invalid_peer_credentials',
    'Patient storage is unavailable. No deletions were applied.': 'storage_unavailable',
    'Could not read patient storage. No deletions were applied.': 'storage_unreadable',
    'Storage indexes could not be refreshed. Retry synchronization.': 'indexes_unavailable',
}


class SyncError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status
        self.code = KNOWN_SYNC_ERRORS.get(message)


def normalise_url(value):
    parsed = urllib.parse.urlsplit(str(value or '').strip())
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise SyncError('Enter a valid HTTP or HTTPS server URL.')
    try:
        parsed.port
    except ValueError:
        raise SyncError('Invalid server port.')
    return parsed.geturl().rstrip('/')


def safe_path(root, value):
    """Reject Windows aliases, traversal, hidden directories, and reparse points."""
    value = str(value or '').replace('\\', '/')
    parts = value.split('/')
    if (not value or value.startswith('/') or any(
            not p or p.startswith('.') or p.endswith((' ', '.'))
            or re.search(r'[<>:"|?*\x00-\x1f]', p)
            or re.fullmatch(r'(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', p, re.I)
            for p in parts)):
        raise SyncError('Forbidden storage path.', 403)
    root = Path(root).resolve()
    candidate = root.joinpath(*parts)
    for ancestor in [candidate, *candidate.parents]:
        if ancestor == root:
            break
        if ancestor.exists() or ancestor.is_symlink():
            attributes = getattr(ancestor.lstat(), 'st_file_attributes', 0)
            if ancestor.is_symlink() or attributes & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0):
                raise SyncError('Linked storage paths are not supported.', 403)
    try:
        candidate.resolve().relative_to(root)
    except ValueError:
        raise SyncError('Forbidden storage path.', 403)
    return candidate


def digest_file(path):
    before = path.stat()
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(CHUNK), b''):
            digest.update(chunk)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise SyncError('A file changed during scanning. Retry sync.', 409)
    return digest.hexdigest(), after.st_size


IGNORED_SYNC_FILES = {
    'patients_mapping.json',
    'patients_mapping.sql',
    'patients_mapping.sqlite',
    'patients_mapping.db',
    'patient_mapping.json',
    'patient_mapping.sql',
    'sync.sqlite3',
    'desktop.ini',
    'thumbs.db'
}


def merged_clock(*records):
    result = {}
    for record in records:
        for node, revision in (record or {}).get('clock', {}).items():
            result[node] = max(result.get(node, 0), revision)
    return result


def dominates(first, second):
    a, b = (first or {}).get('clock', {}), (second or {}).get('clock', {})
    return all(a.get(k, 0) >= v for k, v in b.items()) and a != b


def live(record):
    return bool(record and not record['deleted'])


def same_content(first, second):
    return bool(first and second and first['deleted'] == second['deleted']
                and first.get('sha256') == second.get('sha256'))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SyncError('Server redirects are not allowed. Update the saved server URL.', 409)


def open_request(url, method='GET', headers=None, body=None, timeout=300):
    try:
        return urllib.request.build_opener(NoRedirect()).open(
            urllib.request.Request(url, data=body, headers=headers or {}, method=method), timeout=timeout)
    except urllib.error.HTTPError as error:
        try:
            with error:
                data = json.loads(error.read(4096))
            message = data.get('error') if isinstance(data, dict) else None
            if isinstance(message, str) and message in KNOWN_SYNC_ERRORS:
                raise SyncError(message, error.code)
        except (ValueError, UnicodeError, OSError):
            pass
        raise SyncError('Server request failed (HTTP %s).' % error.code, error.code)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise SyncError('Could not reach the other server. Check its address and connection.', 503)


def json_request(url, method='GET', headers=None, data=None, timeout=25):
    headers = dict(headers or {})
    body = None
    if data is not None:
        headers['Content-Type'] = 'application/json'
        body = json.dumps(data).encode('utf-8')
    with open_request(url, method, headers, body, timeout=timeout) as response:
        try:
            return json.load(response)
        except (ValueError, UnicodeError):
            raise SyncError('The other server returned an invalid response.', 502)


class SyncEngine:
    def __init__(self, root, state_root, extensions, thumbnail=lambda path: None, on_change=None):
        self.root = Path(root).resolve()
        self.state_root = Path(state_root).resolve()
        if self.state_root == self.root or self.root in self.state_root.parents:
            raise SyncError('Sync state must be outside patient storage.', 500)
        self.state_root.mkdir(parents=True, exist_ok=True)
        self.db_path = self.state_root / 'sync.sqlite3'
        # Metadata backups and generated indexes are local caches, not patient files.
        # ZIP support must also work with older configs that only list image types.
        self.extensions = (set(str(e).lower().lstrip('.') for e in extensions)
                           | {'zip', 'dcm', 'dicom'}) - EXCLUDED_EXTENSIONS
        self.thumbnail = thumbnail
        self.on_change = on_change
        self.lock = threading.RLock()
        self.clinical = ClinicalMetadata(self.root, self.state_root, safe_path)
        with self.database() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS records (path TEXT PRIMARY KEY COLLATE NOCASE, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            ''')
            row = db.execute("SELECT value FROM meta WHERE key='node'").fetchone()
            self.node_id = json.loads(row[0]) if row else str(uuid.uuid4())
            db.execute("INSERT OR IGNORE INTO meta VALUES ('node', ?)", (json.dumps(self.node_id),))
            # A new server process cannot safely resume a half-completed network operation.
            # Revision checks make the next manual run safely skip completed operations.
            for job_id, raw in db.execute('SELECT id,value FROM jobs').fetchall():
                job = json.loads(raw)
                if job['status'] == 'running':
                    job.update(status='failed', error='Server restarted. Retry to finish synchronization.')
                    db.execute('UPDATE jobs SET value=? WHERE id=?', (json.dumps(job), job_id))

    @contextmanager
    def database(self):
        connection = sqlite3.connect(self.db_path, timeout=30)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def meta(self, key, value=None):
        with self.database() as db:
            if value is not None:
                db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (key, json.dumps(value)))
                return value
            row = db.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
            return json.loads(row[0]) if row else None

    def record(self, path):
        with self.database() as db:
            row = db.execute('SELECT value FROM records WHERE path=?', (path.casefold(),)).fetchone()
            return json.loads(row[0]) if row else None

    def save_record(self, record):
        self.validate_record(record)
        with self.database() as db:
            db.execute('INSERT OR REPLACE INTO records VALUES (?,?)',
                       (record['path'].casefold(), json.dumps(record)))
        return record

    def includes(self, path):
        name = Path(str(path)).name.lower()
        return (not name.startswith('.') and name not in IGNORED_SYNC_FILES
                and Path(name).suffix.lstrip('.') in self.extensions)

    def validate_record(self, record):
        if not isinstance(record, dict):
            raise SyncError('Invalid sync record.')
        safe_path(self.root, record.get('path'))
        if not self.includes(record['path']):
            raise SyncError('File is excluded from synchronization.')
        if (type(record.get('deleted')) is not bool or type(record.get('size')) is not int
                or record['size'] < 0 or not isinstance(record.get('clock'), dict)
                # A replacement installation leaves historical node revisions.
                # Keep them to preserve causality when two active peers merge.
                or not record['clock'] or len(record['clock']) > MAX_CLOCK_ENTRIES
                or any(not isinstance(k, str) or not k or len(k) > 128 or type(v) is not int or v < 1
                       for k, v in record['clock'].items())
                or (record['deleted'] and (record.get('sha256') is not None or record['size'] != 0))
                or (not record['deleted'] and not re.fullmatch(r'[0-9a-f]{64}', str(record.get('sha256', ''))))):
            raise SyncError('Invalid sync record.')

    def observe(self, rel):
        path = safe_path(self.root, rel)
        previous = self.record(rel)
        if path.is_file():
            sha, size = digest_file(path)
            if previous and not previous['deleted'] and previous['sha256'] == sha:
                return previous
            current = dict(path=rel, sha256=sha, size=size, deleted=False)
        else:
            if not previous or previous['deleted']:
                return previous
            current = dict(path=rel, sha256=None, size=0, deleted=True)
        current['clock'] = merged_clock(previous)
        current['clock'][self.node_id] = current['clock'].get(self.node_id, 0) + 1
        return self.save_record(current)

    def scan(self):
        with self.lock:
            # A missing/unmounted storage root is an outage, never a mass deletion.
            if not self.root.is_dir():
                raise SyncError('Patient storage is unavailable. No deletions were applied.', 503)
            seen = set()
            def walk_error(error):
                raise SyncError('Could not read patient storage. No deletions were applied.', 503)
            for folder, directories, files in os.walk(self.root, onerror=walk_error, followlinks=False):
                directories[:] = [name for name in directories if not name.startswith('.')]
                for name in directories:
                    safe_path(self.root, (Path(folder) / name).relative_to(self.root).as_posix())
                for name in files:
                    if not self.includes(name):
                        continue
                    rel = (Path(folder) / name).relative_to(self.root).as_posix()
                    if rel.casefold() in seen:
                        raise SyncError('Storage contains colliding filenames. Review them before syncing.', 409)
                    # Reject linked folders rather than interpreting their contents as absent.
                    safe_path(self.root, rel)
                    self.observe(rel)
                    seen.add(rel.casefold())
            with self.database() as db:
                old_paths = [json.loads(r[0])['path'] for r in db.execute('SELECT value FROM records')]
            for rel in old_paths:
                if not self.includes(rel):
                    # Detach old metadata records without touching their files or
                    # creating tombstones that could delete the other server's cache.
                    with self.database() as db:
                        db.execute('DELETE FROM records WHERE path=?', (rel.casefold(),))
                elif rel.casefold() not in seen:
                    self.observe(rel)
            with self.database() as db:
                return {r['path'].casefold(): r for (raw,) in db.execute('SELECT value FROM records')
                        for r in [json.loads(raw)]}

    def archive(self, path):
        """Copy before mutation: failure leaves the original intact."""
        if not path.exists():
            return
        rel = path.relative_to(self.root)
        target = self.state_root / 'archive' / str(uuid.uuid4()) / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)

    def check_expected(self, rel, expected):
        if not self.root.is_dir():
            raise SyncError('Patient storage is unavailable. No files were changed.', 503)
        actual = self.observe(rel)
        if actual != expected:
            raise SyncError('A file changed during synchronization. Retry sync.', 409)
        return safe_path(self.root, rel)

    def apply(self, record, expected, stream=None, progress=lambda count: None):
        self.validate_record(record)
        rel = record['path']
        staging = self.state_root / 'staging'
        staging.mkdir(exist_ok=True)
        temp = staging / str(uuid.uuid4())
        try:
            if not record['deleted'] and not same_content(record, expected):
                if stream is None:
                    raise SyncError('File contents are required.')
                digest, size = hashlib.sha256(), 0
                with temp.open('xb') as output:
                    for chunk in iter(lambda: stream.read(CHUNK), b''):
                        size += len(chunk)
                        if size > record['size']:
                            raise SyncError('Transfer exceeded the expected file size.', 409)
                        output.write(chunk)
                        digest.update(chunk)
                        progress(len(chunk))
                    output.flush()
                    os.fsync(output.fileno())
                if size != record['size'] or digest.hexdigest() != record['sha256']:
                    raise SyncError('File verification failed. Retry sync.', 409)
            with self.lock:
                target = self.check_expected(rel, expected)
                if record['deleted']:
                    if target.exists():
                        self.archive(target)
                        target.unlink()
                elif temp.exists():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    self.archive(target)
                    # Staging can be on another drive; final rename must be on the target drive.
                    adjacent = target.parent / ('.lumin-transfer-' + uuid.uuid4().hex)
                    try:
                        shutil.copyfile(temp, adjacent)
                        with adjacent.open('r+b') as durable:
                            os.fsync(durable.fileno())
                        os.replace(adjacent, target)
                    finally:
                        adjacent.unlink(missing_ok=True)
                self.save_record(record)
                thumb = self.root / '.thumbnails' / rel
                thumb = thumb.with_suffix('.webp')
                thumb.unlink(missing_ok=True)
                if not record['deleted']:
                    self.thumbnail(target)
                return record
        finally:
            temp.unlink(missing_ok=True)

    def delete_local(self, rel):
        with self.lock:
            old = self.observe(rel)
            if not live(old):
                raise SyncError('File not found.', 404)
            deleted = dict(old, deleted=True, sha256=None, size=0, clock=merged_clock(old))
            deleted['clock'][self.node_id] = deleted['clock'].get(self.node_id, 0) + 1
            self.apply(deleted, old)

    def save_upload(self, uploaded, rel):
        """Stage ordinary uploads too, so scans never see an incomplete file."""
        with self.lock:
            staging = self.state_root / 'staging'
            staging.mkdir(exist_ok=True)
            temp = staging / str(uuid.uuid4())
            try:
                uploaded.save(temp)
                sha, size = digest_file(temp)
                old = self.observe(rel)
                record = dict(path=rel, sha256=sha, size=size, deleted=False, clock=merged_clock(old))
                record['clock'][self.node_id] = record['clock'].get(self.node_id, 0) + 1
                with temp.open('rb') as stream:
                    self.apply(record, old, stream)
            finally:
                temp.unlink(missing_ok=True)

    def move_local(self, source, destination):
        with self.lock:
            original = self.observe(source)
            if not live(original):
                raise SyncError('Source file not found.', 404)
            old_dest = self.observe(destination)
            copied = dict(original, path=destination, clock=merged_clock(old_dest))
            copied['clock'][self.node_id] = copied['clock'].get(self.node_id, 0) + 1
            with safe_path(self.root, source).open('rb') as stream:
                self.apply(copied, old_dest, stream)
            self.delete_local(source)

    def peer_headers(self):
        pair = self.meta('pair')
        if not pair:
            raise SyncError('Pair the two servers first.', 409)
        return {'x-lumin-sync-key': pair['secret'], 'x-lumin-sync-node': self.node_id}

    def peer_json(self, route, method='GET', data=None, timeout=60):
        pair = self.meta('pair')
        return json_request(pair['url'] + '/api/sync/peer/' + route, method, self.peer_headers(), data, timeout=timeout)

    def jobs(self):
        with self.database() as db:
            jobs = [json.loads(r[0]) for r in db.execute('SELECT value FROM jobs ORDER BY rowid DESC')]
        return jobs

    def update_job(self, job):
        job['updatedAt'] = time.time()
        with self.database() as db:
            db.execute('INSERT OR REPLACE INTO jobs VALUES (?,?)', (job['id'], json.dumps(job)))

    def conflict_signature(self, kind, a, b, details=None):
        # Ignore revision-only changes when remembering a reviewed difference.
        def content(record):
            return {k: record[k] for k in ('path', 'deleted', 'sha256', 'size')} if record else None
        pair = self.meta('pair') or {}
        raw = dict(kind=kind, local=content(a), remote=content(b), peer=pair.get('peerId'))
        if kind == 'metadata':
            raw['details'] = self.annotation_signature(details or {})
        return hashlib.sha256(json.dumps(raw, sort_keys=True).encode()).hexdigest()

    @staticmethod
    def annotation_signature(details):
        fields = ('patient_id', 'relative_path', 'display_name', 'note', 'tooth_ids', 'scan_date', 'scan_config')
        return {side: {k: row.get(k) for k in fields} for side, row in details.items()}

    def sync_clinical_metadata(self, job, local_files, remote_files):
        """Merge edits from both local stores against the last successful sync.

        Supabase is not an annotation source. The private peer credential is
        already used for binary transfers and protects this local snapshot too.
        """
        self.clinical.import_all()
        local_raw = self.clinical.snapshot()
        response = self.peer_json('metadata')
        remote_raw = response.get('snapshot')
        expected_remote = response.get('digest')
        empty = dict(version=CLINICAL_VERSION, patients=[], files=[])
        local = self.clinical.normalise(local_raw or empty)
        remote = self.clinical.normalise(remote_raw or empty)
        pair = self.meta('pair')
        baseline = self.meta('clinicalBaseline') or {}
        if baseline.get('peerId') != pair['peerId']:
            baseline = {}
        old_local, old_remote = baseline.get('local') or empty, baseline.get('remote') or empty
        maps = [{r['relative_path'].casefold(): r for r in s['files']}
                for s in (local, remote, old_local, old_remote)]
        a_rows, b_rows, a_old, b_old = maps
        patient_maps = [{p['id']: p for p in s['patients']} for s in (local, remote, old_local, old_remote)]
        patients = {}
        for pid in set(patient_maps[0]) | set(patient_maps[1]):
            a, b, prior_a, prior_b = (m.get(pid) for m in patient_maps)
            patients[pid] = b if a == prior_a and b != prior_b else a or b
        output_a, output_b = {}, {}
        reviewed = self.meta('reviewedConflicts') or {}
        for key in sorted(set(a_rows) | set(b_rows)):
            a, b, prior_a, prior_b = (m.get(key) for m in maps)
            known = key in a_old or key in b_old
            if a == b:
                winner = a
            elif known and a == prior_a and b != prior_b:
                winner = b
            elif known and b == prior_b and a != prior_a:
                winner = a
            elif not known and (a is None or b is None):
                winner = a or b
            else:
                # Neither concurrent annotation version is overwritten.
                if a:
                    output_a[key] = a
                if b:
                    output_b[key] = b
                record_a, record_b = local_files.get(key), remote_files.get(key)
                if live(record_a) and live(record_b):
                    details = dict(local=a or {}, remote=b or {})
                    signature = self.conflict_signature('metadata', record_a, record_b, details)
                    if reviewed.get(key) != signature and not any(c['path'].casefold() == key for c in job['conflicts']):
                        job['conflicts'].append(dict(path=(a or b)['relative_path'], kind='metadata'))
                continue
            if winner:
                output_a[key] = output_b[key] = winner
        # Original annotations also accompany automatically preserved byte copies.
        for source, output, records in ((a_rows, output_b, remote_files), (b_rows, output_a, local_files)):
            for record in records.values():
                if not live(record) or '__conflict-' not in record['path'] or record['path'].casefold() in output:
                    continue
                path = Path(record['path'])
                stem = re.sub(r'__conflict-[0-9a-f]{8}-[0-9a-f]{12}$', '', path.stem)
                original = path.with_name(stem + path.suffix).as_posix()
                row = source.get(original.casefold())
                if row:
                    output[record['path'].casefold()] = dict(row, relative_path=record['path'], source_relative_path=original)
        next_a = self.clinical.normalise(dict(version=CLINICAL_VERSION, patients=list(patients.values()), files=list(output_a.values())))
        next_b = self.clinical.normalise(dict(version=CLINICAL_VERSION, patients=list(patients.values()), files=list(output_b.values())))
        with self.clinical.lock:
            if self.clinical.digest(self.clinical.snapshot()) != self.clinical.digest(local_raw):
                raise SyncError('Files changed while reviewing. Reload the comparison.', 409)
            ack = self.peer_json('metadata', 'POST', dict(snapshot=next_b, expected=expected_remote))
            if ack.get('digest') != self.clinical.digest(next_b):
                raise SyncError('Invalid clinical metadata.', 409)
            self.clinical.replace(next_a)
            self.clinical.write_all()
        self.meta('clinicalBaseline', dict(peerId=pair['peerId'], local=next_a, remote=next_b))
        job.update(metadataStatus='current', metadataPatients=len(patients), metadataFiles=len(output_a))

    def review_record(self, path):
        """Refresh the selected original without hashing the whole clinic."""
        with self.lock:
            if not self.root.is_dir():
                raise SyncError('Patient storage is unavailable. No deletions were applied.', 503)
            safe_path(self.root, path)
            if not self.includes(path):
                raise SyncError('File is excluded from synchronization.')
            previous = self.record(path)
            return self.observe(previous['path'] if previous else path)


    def peer_review_record(self, path):
        query = urllib.parse.urlencode({'path': path})
        try:
            return self.peer_json('review-record?' + query, timeout=20)
        except SyncError as error:
            if error.status != 404:
                raise
            # Compatibility with an older peer until its setup EXE is updated.
            manifest = self.peer_json('manifest')
            return dict(nodeId=manifest.get('nodeId'), record=manifest.get('files', {}).get(path.casefold()))


    def review_snapshot(self, job_id, index):
        pair = self.meta('pair')
        if not pair or pair.get('role') != 'coordinator':
            raise SyncError('Start synchronization on the paired dedicated PC.', 409)
        job = next((j for j in self.jobs() if j['id'] == job_id), None)
        if not job or index < 0 or index >= len(job.get('conflicts', [])):
            raise SyncError('Sync review not found.', 404)
        if job['status'] == 'running':
            raise SyncError('Wait for the current sync to finish before reviewing.', 409)
        if job.get('peerId', pair['peerId']) != pair['peerId']:
            raise SyncError('Peer identity changed. Pair the servers again.', 409)
        conflict = job['conflicts'][index]
        key = conflict['path'].casefold()
        local = self.review_record(conflict['path'])
        peer = self.peer_review_record(conflict['path'])
        if peer.get('nodeId') != pair['peerId']:
            raise SyncError('Peer identity changed. Pair the servers again.', 409)
        versions = {'local': local, 'remote': peer.get('record')}
        for record in versions.values():
            if record:
                self.validate_record(record)
                if record['path'].casefold() != key:
                    raise SyncError('Invalid peer manifest.', 409)
        details = {'local': self.clinical.details(conflict['path']), 'remote': peer.get('details') or {}}
        revision_data = dict(versions=versions, peer=pair['peerId'])
        if conflict['kind'] == 'metadata' or any(d.get('metadata_available') for d in details.values()):
            revision_data['details'] = self.annotation_signature(details)
        revision = hashlib.sha256(json.dumps(revision_data,
                                              sort_keys=True).encode()).hexdigest()
        return dict(jobId=job_id, index=index, path=conflict['path'], kind=conflict['kind'],
                    reviewed=bool(conflict.get('reviewed')), revision=revision, versions=versions,
                    details=details)

    def keep_reviewed_versions(self, job_id, index, revision):
        with self.lock:
            if any(j['status'] == 'running' for j in self.jobs()):
                raise SyncError('Wait for the current sync to finish before reviewing.', 409)
            snapshot = self.review_snapshot(job_id, index)
            if not hmac.compare_digest(str(revision or ''), snapshot['revision']):
                raise SyncError('Files changed while reviewing. Reload the comparison.', 409)
            a, b = snapshot['versions']['local'], snapshot['versions']['remote']
            # Preserve distinct contents on BOTH computers without replacing
            # either original. This also handles case-only names in older jobs.
            if live(a) and live(b) and (not same_content(a, b) or snapshot['kind'] == 'metadata'):
                pair = self.meta('pair')
                for original, origin, source in ((a, self.node_id, 'local'), (b, pair['peerId'], 'remote')):
                    path = Path(original['path'])
                    annotation = snapshot['details'][source]
                    copy_revision = (hashlib.sha256(json.dumps(self.annotation_signature({source: annotation}), sort_keys=True).encode()).hexdigest()
                                     if snapshot['kind'] == 'metadata' else original['sha256'])
                    copy_path = path.with_name('%s__conflict-%s-%s%s' % (
                        path.stem, origin[:8], copy_revision[:12], path.suffix)).as_posix()
                    for destination in ('local', 'remote'):
                        if destination == 'local':
                            prior = self.observe(copy_path)
                        else:
                            prior = self.peer_review_record(copy_path).get('record')
                        copied = dict(original, path=copy_path, clock=merged_clock(original, prior))
                        if prior and not same_content(prior, copied):
                            raise SyncError('A preserved conflict copy was changed. Review it before retrying.', 409)
                        if same_content(prior, copied):
                            pass
                        elif source == 'local':
                            with safe_path(self.root, original['path']).open('rb') as stream:
                                if destination == 'local':
                                    self.apply(copied, prior, stream)
                                else:
                                    self.transfer(copied, destination, prior, lambda _: None, original['path'])
                        elif destination == 'local':
                            query = urllib.parse.urlencode({'path': original['path'], 'sha256': original['sha256']})
                            with open_request(pair['url'] + '/api/sync/peer/file?' + query,
                                              headers=self.peer_headers()) as stream:
                                self.apply(copied, prior, stream)
                        else:
                            # The remote version has first been preserved locally.
                            self.transfer(self.record(copy_path), 'remote', prior, lambda _: None, copy_path)
                        if annotation.get('metadata_available'):
                            payload = dict(path=copy_path, sha256=original['sha256'], details=annotation,
                                           sourcePath=snapshot['path'])
                            if destination == 'local':
                                self.save_copy_annotations(payload)
                            else:
                                self.peer_json('copy-annotations', 'POST', payload)
            current = self.review_snapshot(job_id, index)
            if current['revision'] != snapshot['revision']:
                raise SyncError('Files changed while reviewing. Reload the comparison.', 409)
            decisions = self.meta('reviewedConflicts') or {}
            key = snapshot['path'].casefold()
            decisions.pop(key, None)
            decisions[key] = self.conflict_signature(snapshot['kind'], a, b, snapshot['details'])
            self.meta('reviewedConflicts', dict(list(decisions.items())[-512:]))
            job = next(j for j in self.jobs() if j['id'] == job_id)
            job['conflicts'][index].update(reviewed=True, reviewedAt=time.time(), resolution='keep_both')
            if job['status'] == 'completed_with_conflicts' and all(c.get('reviewed') for c in job['conflicts']):
                job['status'] = 'completed'
            self.update_job(job)
            if callable(self.on_change):
                self.on_change()
            if self.clinical.snapshot() is not None:
                self.peer_json('finalize', 'POST', {})
            return job

    def save_copy_annotations(self, data):
        path, source = data.get('path'), data.get('sourcePath')
        safe_path(self.root, source)
        record = self.observe(path)
        if not live(record) or record['sha256'] != data.get('sha256') or path.split('/')[0] != source.split('/')[0] or '__conflict-' not in Path(path).stem:
            raise SyncError('Files changed while reviewing. Reload the comparison.', 409)
        details = data.get('details') or {}
        existing = self.clinical.details(path)
        incoming = dict(details, relative_path=path)
        if path.casefold() in self.clinical.files and self.annotation_signature({'copy': existing}) != self.annotation_signature({'copy': incoming}):
            raise SyncError('A preserved conflict copy was changed. Review it before retrying.', 409)
        self.clinical.upsert(path, details.get('patient_id'), dict(details, source_relative_path=source),
                             dict(name=details.get('patient_name'), patient_number=details.get('patient_number')))


    def start(self):
        with self.lock:
            pair = self.meta('pair')
            if not pair or pair['role'] != 'coordinator':
                raise SyncError('Start synchronization on the paired dedicated PC.', 409)
            active = next((j for j in self.jobs() if j['status'] == 'running'), None)
            if active:
                return active
            job = dict(id=str(uuid.uuid4()), status='running', phase='scanning', totalBytes=0,
                       transferredBytes=0, totalFiles=0, completedFiles=0, copiedFiles=0,
                       deletedFiles=0, conflicts=[], error=None, startedAt=time.time(), fileScope=FILE_SCOPE,
                       peerId=pair['peerId'])
            self.update_job(job)
            threading.Thread(target=self.run, args=(job,),
                             daemon=True, name='lumin-file-sync').start()
            return dict(job)

    def run(self, job):
        try:
            local = self.scan()
            remote_response = self.peer_json('manifest')
            pair = self.meta('pair')
            if remote_response.get('nodeId') != pair['peerId']:
                raise SyncError('Peer identity changed. Pair the servers again.', 409)
            if remote_response.get('fileScope') not in (None, FILE_SCOPE):
                raise SyncError('Update and restart the storage server on both computers to sync patient files only.', 426)
            if remote_response.get('clinicalMetadataVersion') != CLINICAL_VERSION:
                raise SyncError('Update and restart the storage server on both computers to sync patient files only.', 426)
            remote = {key: record for key, record in remote_response['files'].items()
                      if isinstance(record, dict) and self.includes(record.get('path'))}
            for key, record in remote.items():
                self.validate_record(record)
                if key != record['path'].casefold():
                    raise SyncError('Invalid peer manifest.', 409)
            transfers, deletions, metadata = [], [], []
            reviewed = self.meta('reviewedConflicts') or {}

            def flag(kind, a, b):
                path = (a or b)['path']
                if reviewed.get(path.casefold()) != self.conflict_signature(kind, a, b):
                    job['conflicts'].append({'path': path, 'kind': kind})

            def schedule(record, destination, expected, source_path=None):
                op = (record, destination, expected, source_path or record['path'])
                if same_content(record, expected):
                    if record != expected:
                        metadata.append(op)
                elif record['deleted']:
                    deletions.append(op)
                else:
                    transfers.append(op)

            for key in sorted(set(local) | set(remote)):
                a, b = local.get(key), remote.get(key)
                if a and b and a['path'] != b['path']:
                    # A Windows case alias is not two different files. Keep data and ask for review.
                    flag('path_case', a, b)
                    continue
                if same_content(a, b):
                    shared = dict(a, clock=merged_clock(a, b))
                    schedule(shared, 'local', a)
                    schedule(shared, 'remote', b)
                elif not a:
                    schedule(b, 'local', None)
                elif not b:
                    schedule(a, 'remote', None)
                elif dominates(a, b):
                    schedule(a, 'remote', b)
                elif dominates(b, a):
                    schedule(b, 'local', a)
                elif live(a) != live(b):
                    survivor = dict(a if live(a) else b, clock=merged_clock(a, b))
                    schedule(survivor, 'local', a)
                    schedule(survivor, 'remote', b)
                    flag('delete_modified', a, b)
                else:
                    flag('both_modified', a, b)
                    for original, destination, inventory, origin in (
                            (a, 'remote', remote, self.node_id), (b, 'local', local, pair['peerId'])):
                        path = Path(original['path'])
                        conflict_path = path.with_name('%s__conflict-%s-%s%s' % (
                            path.stem, origin[:8], original['sha256'][:12], path.suffix)).as_posix()
                        prior = inventory.get(conflict_path.casefold())
                        copy = dict(original, path=conflict_path, clock=merged_clock(original, prior))
                        if prior and not same_content(prior, copy):
                            raise SyncError('A preserved conflict copy was changed. Review it before retrying.', 409)
                        schedule(copy, destination, prior, original['path'])
            job.update(phase='syncing', totalBytes=sum(r['size'] for r, _, _, _ in transfers),
                       totalFiles=len(transfers) + len(deletions))
            self.update_job(job)
            committed = 0
            for record, destination, expected, source_path in transfers:
                inflight, last_update = 0, 0

                def progress(count):
                    nonlocal inflight, last_update
                    inflight += count
                    job['transferredBytes'] = committed + inflight
                    if time.monotonic() - last_update >= 0.25:
                        self.update_job(job)
                        last_update = time.monotonic()

                self.transfer(record, destination, expected, progress, source_path)
                committed += record['size']
                job.update(transferredBytes=committed, completedFiles=job['completedFiles'] + 1,
                           copiedFiles=job['copiedFiles'] + 1)
                self.update_job(job)
            job['phase'] = 'deleting'
            self.update_job(job)
            for record, destination, expected, _ in deletions:
                self.commit_metadata(record, destination, expected)
                job.update(completedFiles=job['completedFiles'] + 1, deletedFiles=job['deletedFiles'] + 1)
                self.update_job(job)
            for record, destination, expected, _ in metadata:
                self.commit_metadata(record, destination, expected)
            job['phase'] = 'verifying'
            self.update_job(job)
            verified_local, verified_remote = self.scan(), self.peer_json('manifest')['files']
            for record, destination, _, _ in transfers + deletions + metadata:
                actual = (verified_local if destination == 'local' else verified_remote).get(record['path'].casefold())
                if actual != record:
                    raise SyncError('Files changed before final verification. Retry sync.', 409)
            if remote_response.get('clinicalMetadataVersion') == CLINICAL_VERSION:
                job['phase'] = 'metadata'
                self.update_job(job)
                self.sync_clinical_metadata(job, verified_local, verified_remote)
                self.peer_json('finalize', 'POST', {})
            job.update(status='completed_with_conflicts' if job['conflicts'] else 'completed', phase='finished')
            if callable(self.on_change):
                result = self.on_change()
                if isinstance(result, dict) and result.get('error'):
                    raise SyncError('Storage indexes could not be refreshed. Retry synchronization.', 503)
        except Exception as error:
            message = str(error) if isinstance(error, SyncError) else (
                'Not enough disk space. Free space and retry.' if isinstance(error, OSError)
                and error.errno == 28 else 'Synchronization failed. Check both servers and retry.')
            job.update(status='failed', error=message,
                       errorStatus=error.status if isinstance(error, SyncError) else 500,
                       errorCode=error.code if isinstance(error, SyncError) else None)
        finally:
            self.update_job(job)

    def transfer(self, record, destination, expected, progress, source_path):
        pair = self.meta('pair')
        if destination == 'local':
            query = urllib.parse.urlencode({'path': source_path, 'sha256': record['sha256']})
            with open_request(pair['url'] + '/api/sync/peer/file?' + query, headers=self.peer_headers()) as stream:
                self.apply(record, expected, stream, progress)
        else:
            with self.lock:
                source = self.observe(source_path)
                if not source or source.get('sha256') != record['sha256']:
                    raise SyncError('Source file changed. Retry sync.', 409)
                stream = safe_path(self.root, source_path).open('rb')
            def chunks():
                for chunk in iter(lambda: stream.read(CHUNK), b''):
                    progress(len(chunk))
                    yield chunk
            headers = self.peer_headers()
            headers.update({'Content-Type': 'application/octet-stream', 'Content-Length': str(record['size']),
                            'x-lumin-sync-meta': base64.b64encode(json.dumps(
                                {'record': record, 'expected': expected}).encode()).decode()})
            try:
                with open_request(pair['url'] + '/api/sync/peer/file', 'PUT', headers, chunks()) as response:
                    json.load(response)
            finally:
                stream.close()

    def commit_metadata(self, record, destination, expected):
        if destination == 'local':
            self.apply(record, expected)
        else:
            self.peer_json('record', 'POST', {'record': record, 'expected': expected})


def install_sync_routes(app, engine, admin_check):
    """engine is lazy: importing server.py must not scan patient data or start jobs."""
    def require_admin():
        admin_check(request.headers.get('Authorization', ''))

    def require_peer():
        instance = engine()
        pair = instance.meta('pair')
        if (not pair or not hmac.compare_digest(request.headers.get('x-lumin-sync-key', ''), pair['secret'])
                or request.headers.get('x-lumin-sync-node') != pair['peerId']):
            raise SyncError('Invalid sync peer credentials.', 401)
        return instance

    @app.errorhandler(SyncError)
    def sync_error(error):
        return jsonify(error=str(error), code=error.code), error.status

    @app.after_request
    def sync_cache_control(response):
        if request.path.startswith('/api/sync/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.get('/api/sync/info')
    def sync_info():
        require_admin()
        instance = engine()
        pair = instance.meta('pair')
        return jsonify(nodeId=instance.node_id, protocol=PROTOCOL, fileScope=FILE_SCOPE,
                       clinicalMetadataVersion=CLINICAL_VERSION,
                       pair={k: pair[k] for k in ('peerId', 'role')} if pair else None)

    @app.post('/api/sync/pair')
    def sync_pair():
        require_admin()
        instance = engine()
        data = request.get_json() or {}
        url = normalise_url(data.get('url'))
        headers = {'x-lumin-key': str(data.get('key', '')), 'Authorization': request.headers['Authorization']}
        info = json_request(url + '/api/sync/info', headers=headers)
        if info.get('protocol') != PROTOCOL or not info.get('nodeId') or info['nodeId'] == instance.node_id:
            raise SyncError('Choose two different servers with compatible sync support.', 409)
        if info.get('fileScope') not in (None, FILE_SCOPE):
            raise SyncError('Update and restart the storage server on both computers to sync patient files only.', 426)
        replace_pair = data.get('replacePair') is True
        with instance.lock:
            previous = instance.meta('pair')
            if any(job['status'] == 'running' for job in instance.jobs()):
                raise SyncError('Wait for the current sync to finish before pairing.', 409)
            if previous and previous['peerId'] != info['nodeId'] and not replace_pair:
                raise SyncError('This server is already paired with another computer.', 409)
            if previous and previous['role'] != 'coordinator' and not replace_pair:
                raise SyncError('Select the existing dedicated PC as the coordinator.', 409)
            # Explicit repair rotates credentials, invalidating the old peer.
            # File revisions, recovery archives and local annotations stay intact.
            secret = previous['secret'] if previous and not replace_pair else secrets.token_urlsafe(32)
            json_request(url + '/api/sync/pair/accept', 'POST', headers,
                         {'peerId': instance.node_id, 'secret': secret, 'replacePair': replace_pair})
            instance.meta('pair', dict(peerId=info['nodeId'], url=url, secret=secret, role='coordinator'))
        return jsonify(peerId=info['nodeId'], paired=True)

    @app.post('/api/sync/pair/accept')
    def accept_pair():
        require_admin()
        instance = engine()
        data = request.get_json() or {}
        try:
            uuid.UUID(data.get('peerId', ''))
        except (ValueError, TypeError, AttributeError):
            raise SyncError('Invalid peer identity.')
        if data['peerId'] == instance.node_id or len(str(data.get('secret', ''))) < 32:
            raise SyncError('Invalid pairing request.')
        with instance.lock:
            previous = instance.meta('pair')
            if any(job['status'] == 'running' for job in instance.jobs()):
                raise SyncError('Wait for the current sync to finish before pairing.', 409)
            replace_pair = data.get('replacePair') is True
            if previous and previous['peerId'] != data['peerId'] and not replace_pair:
                raise SyncError('This server is already paired with another computer.', 409)
            if previous and previous['role'] != 'replica' and not replace_pair:
                raise SyncError('Select the existing dedicated PC as the coordinator.', 409)
            instance.meta('pair', dict(peerId=data['peerId'], secret=str(data['secret']), role='replica'))
        return jsonify(paired=True)


    @app.post('/api/sync/jobs')
    def start_sync_job():
        require_admin()
        return jsonify(engine().start()), 202

    @app.get('/api/sync/jobs/latest')
    def latest_sync_job():
        require_admin()
        jobs = engine().jobs()
        return jsonify(job=jobs[0] if jobs else None)

    @app.get('/api/sync/jobs/<job_id>')
    def get_sync_job(job_id):
        require_admin()
        job = next((job for job in engine().jobs() if job['id'] == job_id), None)
        if not job:
            raise SyncError('Sync job not found.', 404)
        return jsonify(job)

    @app.get('/api/sync/jobs/<job_id>/conflicts/<int:index>')
    def conflict_review(job_id, index):
        require_admin()
        return jsonify(engine().review_snapshot(job_id, index))

    @app.post('/api/sync/jobs/<job_id>/conflicts/<int:index>')
    def keep_conflict_versions(job_id, index):
        require_admin()
        data = request.get_json() or {}
        if data.get('action') != 'keep_both':
            raise SyncError('Choose a supported review action.')
        return jsonify(job=engine().keep_reviewed_versions(job_id, index, data.get('revision')))

    @app.get('/api/sync/jobs/<job_id>/conflicts/<int:index>/file')
    def conflict_file(job_id, index):
        require_admin()
        instance = engine()
        snapshot = instance.review_snapshot(job_id, index)
        if not hmac.compare_digest(request.args.get('revision', ''), snapshot['revision']):
            raise SyncError('Files changed while reviewing. Reload the comparison.', 409)
        side = request.args.get('side')
        record = snapshot['versions'].get(side)
        if not live(record):
            raise SyncError('File not available on this computer.', 404)
        if side == 'local':
            response = send_file(safe_path(instance.root, record['path']), conditional=False,
                                 as_attachment=True, download_name=Path(record['path']).name)
            response.headers['Cache-Control'] = 'private, no-store'
            response.headers['X-Content-Type-Options'] = 'nosniff'
            return response
        pair = instance.meta('pair')
        query = urllib.parse.urlencode({'path': record['path'], 'sha256': record['sha256']})
        stream = open_request(pair['url'] + '/api/sync/peer/file?' + query, headers=instance.peer_headers())
        def chunks():
            try:
                yield from iter(lambda: stream.read(CHUNK), b'')
            finally:
                stream.close()
        return Response(chunks(), content_type=stream.headers.get('Content-Type', 'application/octet-stream'),
                        headers={'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'})

    @app.get('/api/sync/peer/manifest')
    def peer_manifest():
        instance = require_peer()
        return jsonify(nodeId=instance.node_id, fileScope=FILE_SCOPE, clinicalMetadataVersion=CLINICAL_VERSION,
                       files=instance.scan())


    @app.get('/api/sync/peer/review-record')
    def peer_review_record():
        instance = require_peer()
        path = request.args.get('path', '')
        return jsonify(nodeId=instance.node_id, record=instance.review_record(path), details=instance.clinical.details(path))

    @app.route('/api/sync/peer/metadata', methods=['GET', 'POST'])
    def peer_clinical_metadata():
        instance = require_peer()
        # Only the paired coordinator can commit the merged local snapshots.
        if instance.meta('pair').get('role') != 'replica':
            raise SyncError('Start synchronization on the paired dedicated PC.', 409)
        instance.clinical.import_all()
        if request.method == 'GET':
            snapshot = instance.clinical.snapshot()
            return jsonify(snapshot=snapshot, digest=instance.clinical.digest(snapshot))
        if request.content_length is not None and request.content_length > CLINICAL_MAX_BYTES + 1024:
            raise SyncError('Invalid clinical metadata.', 413)
        data = request.get_json(silent=True)
        try:
            normalised = instance.clinical.normalise(data.get('snapshot'))
            digest = instance.clinical.replace_checked(normalised, data.get('expected'))
        except (ValueError, TypeError, AttributeError):
            if isinstance(data, dict) and data.get('expected') != instance.clinical.digest(instance.clinical.snapshot()):
                raise SyncError('Files changed while reviewing. Reload the comparison.', 409)
            raise SyncError('Invalid clinical metadata.')
        instance.clinical.write_all()
        return jsonify(digest=digest)

    @app.post('/api/sync/peer/copy-annotations')
    def peer_copy_annotations():
        instance = require_peer()
        if instance.meta('pair').get('role') != 'replica':
            raise SyncError('Start synchronization on the paired dedicated PC.', 409)
        try:
            instance.save_copy_annotations(request.get_json() or {})
        except (ValueError, TypeError, AttributeError):
            raise SyncError('Invalid clinical metadata.')
        return jsonify(success=True)

    @app.post('/api/sync/peer/finalize')
    def peer_finalize():
        instance = require_peer()
        if callable(instance.on_change):
            result = instance.on_change()
            if isinstance(result, dict) and result.get('error'):
                raise SyncError('Storage indexes could not be refreshed. Retry synchronization.', 503)
        return jsonify(success=True)

    @app.get('/api/sync/peer/file')
    def peer_download():
        instance = require_peer()
        rel = request.args.get('path', '')
        sha = request.args.get('sha256', '')
        with instance.lock:
            record = instance.observe(rel)
            if not live(record) or record['sha256'] != sha:
                raise SyncError('Source file changed. Retry sync.', 409)
            return send_file(safe_path(instance.root, rel), conditional=False)

    @app.put('/api/sync/peer/file')
    def peer_upload():
        instance = require_peer()
        try:
            data = json.loads(base64.b64decode(request.headers.get('x-lumin-sync-meta', ''), validate=True))
            if not isinstance(data, dict):
                raise ValueError('Transfer metadata must be an object')
        except (ValueError, UnicodeError):
            raise SyncError('Invalid transfer metadata.')
        instance.apply(data.get('record'), data.get('expected'), request.stream)
        return jsonify(success=True)

    @app.post('/api/sync/peer/record')
    def peer_record():
        instance = require_peer()
        data = request.get_json() or {}
        instance.apply(data.get('record'), data.get('expected'))
        if callable(instance.on_change):
            try:
                instance.on_change()
            except Exception:
                pass
        return jsonify(success=True)
