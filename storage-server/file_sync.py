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

from flask import jsonify, request, send_file

CHUNK = 256 * 1024
PROTOCOL = 1


class SyncError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


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


def open_request(url, method='GET', headers=None, body=None, timeout=120):
    try:
        return urllib.request.build_opener(NoRedirect()).open(
            urllib.request.Request(url, data=body, headers=headers or {}, method=method), timeout=timeout)
    except urllib.error.HTTPError as error:
        # Never surface peer response bodies, authentication tokens or keys.
        raise SyncError('Server request failed (HTTP %s).' % error.code, error.code)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise SyncError('Could not reach the other server. Check its address and connection.', 503)


def json_request(url, method='GET', headers=None, data=None):
    headers = dict(headers or {})
    body = None
    if data is not None:
        headers['Content-Type'] = 'application/json'
        body = json.dumps(data).encode('utf-8')
    with open_request(url, method, headers, body) as response:
        try:
            return json.load(response)
        except (ValueError, UnicodeError):
            raise SyncError('The other server returned an invalid response.', 502)


class SyncEngine:
    def __init__(self, root, state_root, extensions, thumbnail=lambda path: None):
        self.root = Path(root).resolve()
        self.state_root = Path(state_root).resolve()
        if self.state_root == self.root or self.root in self.state_root.parents:
            raise SyncError('Sync state must be outside patient storage.', 500)
        self.state_root.mkdir(parents=True, exist_ok=True)
        self.db_path = self.state_root / 'sync.sqlite3'
        self.extensions = set(extensions)
        self.thumbnail = thumbnail
        self.lock = threading.RLock()
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

    def validate_record(self, record):
        if not isinstance(record, dict):
            raise SyncError('Invalid sync record.')
        safe_path(self.root, record.get('path'))
        if (type(record.get('deleted')) is not bool or type(record.get('size')) is not int
                or record['size'] < 0 or not isinstance(record.get('clock'), dict)
                or not record['clock'] or len(record['clock']) > 2
                or any(not isinstance(k, str) or type(v) is not int or v < 1
                       for k, v in record['clock'].items())
                or (record['deleted'] and (record.get('sha256') is not None or record['size'] != 0))
                or (not record['deleted'] and not re.fullmatch(r'[0-9a-f]{64}', str(record.get('sha256', ''))))):
            raise SyncError('Invalid sync record.')
        if Path(record['path']).suffix.lower().lstrip('.') not in self.extensions:
            raise SyncError('File extension is not permitted.')

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
                    if name.startswith('.') or Path(name).suffix.lower().lstrip('.') not in self.extensions:
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
                if rel.casefold() not in seen:
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

    def peer_json(self, route, method='GET', data=None):
        pair = self.meta('pair')
        return json_request(pair['url'] + '/api/sync/peer/' + route, method, self.peer_headers(), data)

    def jobs(self):
        with self.database() as db:
            jobs = [json.loads(r[0]) for r in db.execute('SELECT value FROM jobs ORDER BY rowid DESC')]
        return jobs

    def update_job(self, job):
        job['updatedAt'] = time.time()
        with self.database() as db:
            db.execute('INSERT OR REPLACE INTO jobs VALUES (?,?)', (job['id'], json.dumps(job)))

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
                       deletedFiles=0, conflicts=[], error=None, startedAt=time.time())
            self.update_job(job)
            threading.Thread(target=self.run, args=(job,), daemon=True, name='lumin-file-sync').start()
            return dict(job)

    def run(self, job):
        try:
            local = self.scan()
            remote_response = self.peer_json('manifest')
            pair = self.meta('pair')
            if remote_response.get('nodeId') != pair['peerId']:
                raise SyncError('Peer identity changed. Pair the servers again.', 409)
            remote = remote_response['files']
            for key, record in remote.items():
                self.validate_record(record)
                if key != record['path'].casefold():
                    raise SyncError('Invalid peer manifest.', 409)
            transfers, deletions, metadata = [], [], []

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
                    job['conflicts'].append({'path': a['path'], 'kind': 'path_case'})
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
                    job['conflicts'].append({'path': survivor['path'], 'kind': 'delete_modified'})
                else:
                    job['conflicts'].append({'path': a['path'], 'kind': 'both_modified'})
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
            job.update(status='completed_with_conflicts' if job['conflicts'] else 'completed', phase='finished')
        except Exception as error:
            message = str(error) if isinstance(error, SyncError) else (
                'Not enough disk space. Free space and retry.' if isinstance(error, OSError)
                and error.errno == 28 else 'Synchronization failed. Check both servers and retry.')
            job.update(status='failed', error=message)
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
        return jsonify(error=str(error)), error.status

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
        return jsonify(nodeId=instance.node_id, protocol=PROTOCOL,
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
        with instance.lock:
            previous = instance.meta('pair')
            if any(job['status'] == 'running' for job in instance.jobs()):
                raise SyncError('Wait for the current sync to finish before pairing.', 409)
            if previous and previous['peerId'] != info['nodeId']:
                raise SyncError('This server is already paired with another computer.', 409)
            if previous and previous['role'] != 'coordinator':
                raise SyncError('Select the existing dedicated PC as the coordinator.', 409)
            secret = previous['secret'] if previous else secrets.token_urlsafe(32)
            json_request(url + '/api/sync/pair/accept', 'POST', headers,
                         {'peerId': instance.node_id, 'secret': secret})
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
            if previous and previous['peerId'] != data['peerId']:
                raise SyncError('This server is already paired with another computer.', 409)
            if previous and previous['role'] != 'replica':
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

    @app.get('/api/sync/peer/manifest')
    def peer_manifest():
        instance = require_peer()
        return jsonify(nodeId=instance.node_id, files=instance.scan())

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
        except (ValueError, UnicodeError):
            raise SyncError('Invalid transfer metadata.')
        instance.apply(data.get('record'), data.get('expected'), request.stream)
        return jsonify(success=True)

    @app.post('/api/sync/peer/record')
    def peer_record():
        instance = require_peer()
        data = request.get_json() or {}
        instance.apply(data.get('record'), data.get('expected'))
        return jsonify(success=True)
