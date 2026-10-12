import {DriveError, MAX_UPLOAD, annotationSignature, caseFold, cleanName, decrypt, encrypt, equal, normaliseSnapshot, metadataDigest, safePath, sha256, uuid, validateRecord, sameContent, type RecordEntry} from "./core.ts";
import {DriveTokenCache, tokenLifetime} from "./token_cache.ts";

export function driveThumbnailUrl(link: string, maxSide = 160) {
  try {
    const target = new URL(link);
    if (target.protocol !== "https:" || !target.hostname.endsWith(".googleusercontent.com") || target.username || target.password || target.port) return null;
    const limit = (value: string) => String(Number(value) > 0 ? Math.min(Number(value), maxSide) : maxSide);
    if (maxSide > 0) {
      target.pathname = target.pathname.replace(/=s(\d+)(?=-|$)/, (_, side) => "=s" + limit(side));
      const size = target.searchParams.get("sz");
      if (size && /^s?\d+$/.test(size)) target.searchParams.set("sz", (size.startsWith("s") ? "s" : "") + limit(size.replace(/^s/, "")));
    }
    return target;
  } catch (_) { return null; }
}

export type DriveConfig = {supabaseUrl: string; clientId: string; clientSecret: string; encryptionKey: string; redirectUri: string; appUrl: string; rootName: string};
export async function checked(query: any) {
  const {data, error} = await query;
  if (error) throw new DriveError("Drive records could not be saved. Retry the operation.", 503, "database_unavailable");
  return data;
}
export class DriveStore {
  private connectionCache: any;
  private accessToken = "";
  private accessTokenExpiresAt = 0;
  private tokenKey = "";
  private lockOwner = "";
  constructor(public db: any, public config: DriveConfig, public fetcher: typeof fetch = fetch, private tokens = new DriveTokenCache()) {}
  configured() { const c = this.config; return Boolean(c.clientId && c.clientSecret && c.encryptionKey.length >= 32 && c.appUrl); }
  async savedConnection() { return checked(this.db.from("google_drive_connection").select("*").eq("id", 1).maybeSingle()); }
  async connection() {
    if (!this.connectionCache) this.connectionCache = await this.savedConnection();
    if (!this.connectionCache?.refresh_token_encrypted) throw new DriveError("The clinic administrator must connect Google Drive.", 409, "not_connected");
    return this.connectionCache;
  }
  async guard() {
    if (this.lockOwner && !(await checked(this.db.rpc("google_drive_renew_lock", {p_owner: this.lockOwner})))) throw new DriveError("Drive storage lock expired. Retry the operation.", 409, "sync_busy");
  }
  async commit(query: any) { await this.guard(); return checked(query); }
  async rows(table: string) {
    const rows: any[] = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await checked(this.db.from(table).select("*").order("path_key").range(offset, offset + 999));
      rows.push(...page); if (page.length < 1000) return rows;
    }
  }
  async fileRows(paths?: string[]) {
    if (!paths) return this.rows("google_drive_files");
    const keys = [...new Set(paths.map(caseFold))], rows: any[] = [];
    let chunk: string[] = [], encoded = 0;
    for (const key of keys) {
      const size = encodeURIComponent(key).length + 6;
      // Long legacy paths retain the paginated fallback rather than exceeding URL limits.
      if (size > 4000) {
        const wanted = new Set(keys);
        return (await this.rows("google_drive_files")).filter(row => wanted.has(row.path_key));
      }
      if (chunk.length && (chunk.length >= 50 || encoded + size > 5000)) {
        rows.push(...await checked(this.db.from("google_drive_files").select("*").in("path_key", chunk)));
        chunk = []; encoded = 0;
      }
      chunk.push(key); encoded += size;
    }
    if (chunk.length) rows.push(...await checked(this.db.from("google_drive_files").select("*").in("path_key", chunk)));
    return rows;
  }
  async tokenRequest(params: Record<string, string>) {
    const response = await this.fetcher("https://oauth2.googleapis.com/token", {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"}, body: new URLSearchParams(params), signal: AbortSignal.timeout(15000)});
    const result = await response.json();
    if (!response.ok || typeof result.access_token !== "string" || !result.access_token) throw new DriveError("Google Drive needs to be reconnected by the administrator.", 409, "reconnect_required");
    return result;
  }
  async token() {
    if (this.accessToken && this.accessTokenExpiresAt > this.tokens.clock()) return this.accessToken;
    if (!this.configured()) throw new DriveError("Google Drive setup is incomplete.", 503, "not_configured");
    const c = await this.connection();
    this.tokenKey = await sha256(JSON.stringify([this.config.supabaseUrl, this.config.clientId, this.config.clientSecret, this.config.encryptionKey, c.node_id, c.google_email, c.refresh_token_encrypted]));
    const result = await this.tokens.get(this.tokenKey, async () => {
      const refresh = await decrypt(c.refresh_token_encrypted, this.config.encryptionKey);
      return this.tokenRequest({client_id: this.config.clientId, client_secret: this.config.clientSecret, refresh_token: refresh, grant_type: "refresh_token"});
    });
    this.accessToken = result.value; this.accessTokenExpiresAt = result.expiresAt; return this.accessToken;
  }
  invalidateToken(token: string) {
    this.tokens.invalidate(this.tokenKey, token);
    if (this.accessToken === token) { this.accessToken = ""; this.accessTokenExpiresAt = 0; }
  }
  async google(path: string, options: RequestInit = {}, binary = false) {
    await this.guard();
    const send = (token: string) => this.fetcher(`https://www.googleapis.com${path}`, {...options, headers: {Authorization: `Bearer ${token}`, ...(options.body && typeof options.body === "string" ? {"Content-Type": "application/json"} : {}), ...options.headers}, signal: AbortSignal.timeout(45000)});
    const token = await this.token();
    let response = await send(token);
    if (response.status === 401 && this.tokenKey && (!options.method || options.method === "GET")) {
      this.invalidateToken(token); await response.body?.cancel();
      response = await send(await this.token());
    }
    if (!response.ok && response.status !== 308) {
      const body = await response.json().catch(() => ({}));
      const reason = body?.error?.errors?.[0]?.reason;
      throw new DriveError(reason === "storageQuotaExceeded" ? "Google Drive storage is full." : "Google Drive is unavailable or access has changed. No deletion was inferred.", response.status === 404 ? 503 : response.status === 401 ? 409 : 502, response.status === 401 ? "reconnect_required" : "google_unavailable");
    }
    return binary ? response : response.status === 204 ? null : response.json();
  }
  async lock<T>(run: () => Promise<T>): Promise<T> {
    const owner = crypto.randomUUID();
    if (!(await checked(this.db.rpc("google_drive_claim_lock", {p_owner: owner})))) throw new DriveError("Drive is processing another change. Retry shortly.", 409, "sync_busy");
    this.lockOwner = owner;
    try { return await run(); }
    finally { this.lockOwner = ""; await this.db.rpc("google_drive_release_lock", {p_owner: owner}); }
  }
  async metadata() { return checked(this.db.from("google_drive_metadata").select("*").eq("id", 1).single()); }
  async history(path: string | null, row: any, reason: string, snapshot?: any) {
    await this.commit(this.db.from("google_drive_history").insert({relative_path: path, drive_id: row?.drive_id, record: row?.record, snapshot: snapshot ?? null, reason}));
  }
  async saveSnapshot(value: any, previous: any) {
    const snapshot = normaliseSnapshot(value), digest = await metadataDigest(snapshot);
    // Sync can transfer bytes before their annotations. Bind imported folders
    // once the patient UUID is known so later uploads reuse the same hierarchy.
    const folders = new Map<string, string>(snapshot.files.map((f: any) => [caseFold(f.relative_path.split("/")[0]), f.patient_id]));
    for (const [key, patientId] of folders) {
      const folder = await checked(this.db.from("google_drive_folders").select("patient_id").eq("path_key", key).maybeSingle());
      if (folder?.patient_id && folder.patient_id !== patientId) throw new DriveError("A different patient owns this folder.", 409, "patient_changed");
      if (folder && !folder.patient_id) await this.commit(this.db.from("google_drive_folders").update({patient_id: patientId}).eq("path_key", key));
    }
    await this.history(null, null, "annotations", previous.snapshot);
    const result = await this.commit(this.db.from("google_drive_metadata").update({snapshot, digest, revision: crypto.randomUUID()}).eq("id", 1).eq("revision", previous.revision).select("id").maybeSingle());
    if (!result) throw new DriveError("Files changed while reviewing. Reload the comparison.", 409, "file_changed");
    return digest;
  }
  async row(path: string) { safePath(path); return checked(this.db.from("google_drive_files").select("*").eq("path_key", caseFold(path)).maybeSingle()); }
  details(snapshot: any, path: string) {
    const row = snapshot?.files?.find((f: any) => caseFold(f.relative_path) === caseFold(path));
    const patient = snapshot?.patients?.find((p: any) => p.id === row?.patient_id);
    return row ? {...row, patient_name: patient?.name || "", patient_number: patient?.patient_number || "", metadata_available: true} : {relative_path: path, metadata_available: false};
  }
  async folder(path: string, patientId: string | null = null) {
    const key = caseFold(path);
    const existing = await checked(this.db.from("google_drive_folders").select("*").eq("path_key", key).maybeSingle());
    if (existing) {
      if (patientId && existing.patient_id && existing.patient_id !== patientId) throw new DriveError("A different patient already owns this folder.", 409, "patient_changed");
      const info = await this.google(`/drive/v3/files/${encodeURIComponent(existing.drive_id)}?fields=id,trashed`);
      if (info.trashed) throw new DriveError("Restore the patient folder in Google Drive before continuing.", 503);
      return existing.drive_id;
    }
    const parts = path.split("/"), name = parts.pop()!;
    const parent = parts.length ? await this.folder(parts.join("/"), patientId) : (await this.connection()).root_id;
    const folder = await this.google("/drive/v3/files?fields=id", {method: "POST", body: JSON.stringify({name, mimeType: "application/vnd.google-apps.folder", parents: [parent]})});
    await this.commit(this.db.from("google_drive_folders").insert({path_key: key, relative_path: path, drive_id: folder.id, patient_id: patientId}));
    return folder.id;
  }
  async patientFolder(patient: any) {
    const existing = await checked(this.db.from("google_drive_folders").select("*").eq("patient_id", patient.id));
    const top = existing.find((f: any) => !f.relative_path.includes("/"));
    if (top) return top.relative_path;
    let name = cleanName(patient.name || "") || patient.id;
    const same = await checked(this.db.from("google_drive_folders").select("patient_id").eq("path_key", caseFold(name)).maybeSingle());
    if (same && same.patient_id !== patient.id) name += `_${patient.id.slice(0, 8)}`;
    await this.folder(name, patient.id); return name;
  }
  async renamePatient(patient: any) {
    const folders = await checked(this.db.from("google_drive_folders").select("*").eq("patient_id", patient.id));
    const top = folders.find((f: any) => !f.relative_path.includes("/"));
    if (!top) return {success: true};
    const oldName = top.relative_path;
    let newName = cleanName(patient.name) || patient.id;
    safePath(`${newName}/General/check.png`);
    const collision = await checked(this.db.from("google_drive_folders").select("*").eq("path_key", caseFold(newName)).maybeSingle());
    if (collision && collision.drive_id !== top.drive_id) newName += `_${patient.id.slice(0, 8)}`;
    const rows = await this.fileRows(), meta = await this.metadata(), connection = await this.connection();
    const rename = (path: string) => caseFold(path.split("/")[0]) === caseFold(oldName) ? newName + path.slice(oldName.length) : path;
    const snapshot = structuredClone(meta.snapshot || {version: 2, patients: [], files: []});
    snapshot.patients = snapshot.patients.filter((p: any) => p.id !== patient.id); snapshot.patients.push(patient);
    snapshot.files = snapshot.files.map((f: any) => ({...f, relative_path: rename(f.relative_path), source_relative_path: f.source_relative_path ? rename(f.source_relative_path) : ""}));
    const normal = normaliseSnapshot(snapshot), records: any[] = [];
    for (const row of rows) {
      const path = rename(row.record.path);
      if (path === row.record.path || row.record.deleted) continue;
      const target = rows.find(r => r.path_key === caseFold(path));
      if (target && target.path_key !== row.path_key && !target.record.deleted) throw new DriveError("A patient file already exists under the new name.", 409, "patient_changed");
      const clock = {...row.record.clock};
      for (const [node, value] of Object.entries(target?.record.clock || {})) clock[node] = Math.max(clock[node] || 0, Number(value));
      clock[connection.node_id] = (clock[connection.node_id] || 0) + 1;
      if (caseFold(path) !== row.path_key) records.push({path_key: row.path_key, drive_id: row.drive_id, mime_type: row.mime_type, record: {...row.record, deleted: true, sha256: null, size: 0, clock}});
      records.push({path_key: caseFold(path), drive_id: row.drive_id, mime_type: row.mime_type, record: {...row.record, path, clock}});
    }
    const mappings = (await this.rows("google_drive_folders")).filter(f => caseFold(f.relative_path.split("/")[0]) === caseFold(oldName)).map((f: any) => ({old_key: f.path_key, path_key: caseFold(rename(f.relative_path)), relative_path: rename(f.relative_path), drive_id: f.drive_id}));
    await this.google(`/drive/v3/files/${encodeURIComponent(top.drive_id)}?fields=id`, {method: "PATCH", body: JSON.stringify({name: newName})});
    await this.guard();
    await checked(this.db.rpc("google_drive_rename_paths", {p_owner: this.lockOwner, p_revision: meta.revision, p_folders: mappings, p_records: records, p_snapshot: normal, p_digest: await metadataDigest(normal)}));
    return {success: true, oldFolder: oldName, newFolder: newName};
  }
  async createFile(path: string, bytes: Uint8Array, mime: string, patientId: string | null = null) {
    if (bytes.length > MAX_UPLOAD) throw new DriveError("Drive uploads are limited to 24 MB per file.", 413, "file_too_large");
    const parts = safePath(path).split("/"), name = parts.pop()!;
    const parent = await this.folder(parts.join("/"), patientId);
    const start = await this.google("/upload/drive/v3/files?uploadType=resumable&fields=id", {method: "POST", headers: {"X-Upload-Content-Type": mime, "X-Upload-Content-Length": String(bytes.length)}, body: JSON.stringify({name, mimeType: mime, parents: [parent]})}, true) as Response;
    const target = new URL(start.headers.get("Location") || "");
    if (target.protocol !== "https:" || target.hostname !== "www.googleapis.com") throw new DriveError("Invalid Google upload endpoint.", 502);
    await this.guard();
    const upload = await this.fetcher(target, {method: "PUT", headers: {Authorization: `Bearer ${await this.token()}`, "Content-Type": mime}, body: bytes as BodyInit, signal: AbortSignal.timeout(45000)});
    if (upload.status === 401) this.invalidateToken(this.accessToken);
    if (!upload.ok) throw new DriveError("Google Drive upload failed. Retry the operation.", 502);
    const result = await upload.json(); if (!result.id) throw new DriveError("Google did not confirm the upload.", 502);
    return result.id;
  }
  async archive(row: any, reason: string) {
    if (!row) return;
    await this.history(row.record.path, row, reason);
    if (row.drive_id && !row.record.deleted) {
      const destination = await this.folder(".Lumin_Recovery/" + crypto.randomUUID());
      const info = await this.google(`/drive/v3/files/${encodeURIComponent(row.drive_id)}?fields=parents,trashed`);
      if (!info.trashed) await this.google(`/drive/v3/files/${encodeURIComponent(row.drive_id)}?addParents=${encodeURIComponent(destination)}&removeParents=${encodeURIComponent((info.parents || []).join(","))}&fields=id`, {method: "PATCH", body: "{}"});
    }
  }
  async apply(value: any, expected: any, bytes?: Uint8Array, mime = "application/octet-stream") {
    const record = validateRecord(value), old = await this.row(record.path);
    if (equal(old?.record ?? null, record)) return; // Already committed response lost in transit.
    if (!equal(old?.record ?? null, expected ?? null)) throw new DriveError("Source file changed. Retry sync.", 409, "file_changed");
    let id = old?.drive_id || null;
    if (!record.deleted && !sameContent(record, old?.record)) {
      if (!bytes || bytes.length !== record.size || await sha256(bytes) !== record.sha256) throw new DriveError("File verification failed. Retry sync.", 409, "file_changed");
      const meta = await this.metadata(), pid = this.details(meta.snapshot, record.path).patient_id || null;
      id = await this.createFile(record.path, bytes, mime, pid);
      await this.archive(old, "replaced");
    } else if (record.deleted && old && !old.record.deleted) await this.archive(old, "deleted");
    await this.commit(this.db.from("google_drive_files").upsert({path_key: caseFold(record.path), record, drive_id: id, mime_type: bytes ? mime : old?.mime_type || mime, revision: crypto.randomUUID(), modified_at: new Date().toISOString()}));
  }
  async setDetails(path: string, patientId: string, details: any, patient: any) {
    const meta = await this.metadata(), snapshot = structuredClone(meta.snapshot || {version: 2, patients: [], files: []});
    const previous = this.details(snapshot, path);
    if (previous.patient_id && previous.patient_id !== patientId) throw new DriveError("Patient identity does not match media.", 409);
    const oldPatient = snapshot.patients.find((p: any) => p.id === patientId);
    snapshot.patients = snapshot.patients.filter((p: any) => p.id !== patientId);
    snapshot.patients.push({id: patientId, name: patient.name ?? oldPatient?.name ?? "", patient_number: String(patient.patient_number ?? oldPatient?.patient_number ?? ""), phone: patient.phone ?? oldPatient?.phone ?? ""});
    snapshot.files = snapshot.files.filter((f: any) => caseFold(f.relative_path) !== caseFold(path));
    snapshot.files.push({...previous, ...details, patient_id: patientId, relative_path: path});
    await this.saveSnapshot(snapshot, meta); return this.details(normaliseSnapshot(snapshot), path);
  }
  async observe(row: any, observed?: any) {
    if (row.record.deleted) return row;
    const info = observed || await this.google(`/drive/v3/files/${encodeURIComponent(row.drive_id)}?fields=id,size,sha256Checksum,trashed,mimeType,modifiedTime`);
    const next = {...row.record, clock: {...row.record.clock}};
    if (info.trashed) { next.deleted = true; next.sha256 = null; next.size = 0; }
    else {
      let checksum = info.sha256Checksum;
      if (!checksum) {
        if (Number(info.size) > MAX_UPLOAD) throw new DriveError("A Drive file exceeds the 24 MB sync limit.", 413);
        const content = await this.google(`/drive/v3/files/${encodeURIComponent(row.drive_id)}?alt=media`, {}, true) as Response;
        checksum = await sha256(new Uint8Array(await content.arrayBuffer()));
      }
      next.sha256 = checksum; next.size = Number(info.size);
    }
    if (!sameContent(next, row.record)) {
      const connection = await this.connection(); next.clock[connection.node_id] = (next.clock[connection.node_id] || 0) + 1;
      await this.history(row.record.path, row, "external-change");
      const change = {record: validateRecord(next), revision: crypto.randomUUID(), modified_at: info.modifiedTime || new Date().toISOString()};
      const result = await this.commit(this.db.from("google_drive_files").update(change).eq("path_key", row.path_key).eq("revision", row.revision).select("*").maybeSingle());
      if (!result) throw new DriveError("Source file changed. Retry sync.", 409, "file_changed");
      return result;
    }
    return row;
  }
  async reconcile() {
    const connection = await this.connection();
    const root = await this.google(`/drive/v3/files/${encodeURIComponent(connection.root_id)}?fields=id,trashed`);
    if (root.trashed) throw new DriveError("Restore the clinic folder in Drive before syncing.", 503, "storage_unavailable");
    let token = connection.change_token;
    const rows = await this.fileRows();
    const byId = new Map(rows.filter((r: any) => r.drive_id && !r.record.deleted).map((r: any) => [r.drive_id, r]));
    for (let page = 0; page < 100; page++) {
      const changes = await this.google(`/drive/v3/changes?pageToken=${encodeURIComponent(token)}&pageSize=1000&includeRemoved=true&fields=nextPageToken,newStartPageToken,changes(fileId,removed,file(id,size,sha256Checksum,trashed,mimeType,modifiedTime))`);
      for (const change of changes.changes || []) {
        const row = byId.get(change.fileId);
        if (!row) continue;
        // Drive's "removed" can mean revoked access. A missing file is an outage,
        // not a tombstone; only an explicit trashed flag creates a deletion review.
        const current = await this.observe(row, change.removed ? undefined : change.file);
        byId.set(change.fileId, current);
      }
      if (changes.nextPageToken) { token = changes.nextPageToken; continue; }
      token = changes.newStartPageToken || token;
      await this.commit(this.db.from("google_drive_connection").update({change_token: token}).eq("id", 1));
      connection.change_token = token; return;
    }
    throw new DriveError("Drive has many pending changes. Retry synchronization shortly.", 503);
  }
  async download(path: string, checksum?: string, thumbnail = false) {
    const row = await this.row(path); if (!row || row.record.deleted) throw new DriveError("Patient file not found.", 404);
    if (checksum && row.record.sha256 !== checksum) throw new DriveError("Source file changed. Retry sync.", 409, "file_changed");
    if (thumbnail) {
      const info = await this.google(`/drive/v3/files/${encodeURIComponent(row.drive_id)}?fields=thumbnailLink`);
      if (info.thumbnailLink) {
        const small = driveThumbnailUrl(info.thumbnailLink), original = driveThumbnailUrl(info.thumbnailLink, 0);
        const targets = [...new Set([small?.href, original?.href].filter(Boolean))];
        for (const target of targets) {
          try {
            const preview = await this.fetcher(target!, {headers: {Authorization: `Bearer ${await this.token()}`}, redirect: "error", signal: AbortSignal.timeout(15000)});
            if (preview.ok && /^(image\/(?:jpeg|png|webp|gif|bmp|tiff))(?:;|$)/i.test(preview.headers.get("Content-Type") || "")) return preview;
            await preview.body?.cancel();
          } catch (_) { /* An expired or unsupported preview can use the next thumbnail URL. */ }
        }
      }
      // Galleries must not download a full clinical image just because Drive is still preparing its preview.
      throw new DriveError("Preview unavailable. Open the original image.", 404, "preview_unavailable");
    }
    return this.google(`/drive/v3/files/${encodeURIComponent(row.drive_id)}?alt=media`, {}, true) as Promise<Response>;
  }
  async peer(route: string, request: Request, url: URL) {
    if (route === "manifest") {
      return this.lock(async () => {
        await this.reconcile();
        const rows = await this.fileRows();
        const files: Record<string, RecordEntry> = {};
        for (const row of rows) files[row.path_key] = row.record;
        return {nodeId: (await this.connection()).node_id, fileScope: "patient-files-v1", clinicalMetadataVersion: 2, files};
      });
    }
    if (route === "file" && request.method === "GET") return this.download(url.searchParams.get("path") || "", url.searchParams.get("sha256") || "");
    if (route === "review-record") {
      return this.lock(async () => {
        const path = safePath(url.searchParams.get("path")), raw = await this.row(path), row = raw ? await this.observe(raw) : null;
        const details = this.details((await this.metadata()).snapshot, path);
        return {nodeId: (await this.connection()).node_id, record: row?.record || null, details, annotationsStored: Boolean(details.metadata_available), reviewResolutionVersion: 1};
      });
    }
    if (route === "metadata" && request.method === "GET") { const m = await this.metadata(); return {snapshot: m.snapshot, digest: await metadataDigest(m.snapshot)}; }
    if (route === "finalize" && request.method === "POST") return {success: true};
    return this.lock(async () => {
      if (route === "file" && request.method === "PUT") {
        let data; try { data = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(request.headers.get("x-lumin-sync-meta") || ""), c => c.charCodeAt(0)))); } catch { throw new DriveError("Invalid transfer metadata."); }
        const record = validateRecord(data.record); if (record.size > MAX_UPLOAD) throw new DriveError("Drive sync is limited to 24 MB per file.", 413, "file_too_large");
        const bytes = new Uint8Array(await request.arrayBuffer()); await this.apply(record, data.expected, bytes, mimeForPath(record.path)); return {success: true};
      }
      const body = route === "review-resolution" ? await readReview(request) : await request.json();
      if (route === "record" && request.method === "POST") { await this.apply(body.record, body.expected); return {success: true}; }
      if (route === "metadata" && request.method === "POST") {
        const meta = await this.metadata(); if (await metadataDigest(meta.snapshot) !== body.expected) throw new DriveError("Files changed while reviewing. Reload the comparison.", 409, "file_changed");
        return {digest: await this.saveSnapshot(body.snapshot, meta)};
      }
      if (route === "copy-annotations" && request.method === "POST") {
        const row = await this.row(safePath(body.path)), source = safePath(body.sourcePath), meta = await this.metadata();
        if (!row || row.record.deleted || row.record.sha256 !== body.sha256 || !body.path.includes("__conflict-") || body.path.split("/")[0] !== source.split("/")[0]) throw new DriveError("Files changed while reviewing. Reload the comparison.", 409);
        const previous = this.details(meta.snapshot, body.path), desired = {...body.details, relative_path: body.path, source_relative_path: source};
        if (previous.metadata_available && !equal(annotationSignature(previous), annotationSignature(desired))) throw new DriveError("A preserved conflict copy was changed.", 409);
        const patient = {name: desired.patient_name, patient_number: desired.patient_number};
        await this.setDetails(body.path, uuid(desired.patient_id), desired, patient); return {success: true};
      }
      if (route === "review-resolution" && request.method === "PUT") {
        const record = validateRecord(body.record), meta = await this.metadata(), prior = this.details(meta.snapshot, record.path), row = await this.row(record.path);
        if (equal(row?.record, record) && equal(annotationSignature(prior), annotationSignature(body.details))) return {success: true};
        if (!equal(annotationSignature(prior), annotationSignature(body.expectedDetails))) throw new DriveError("Files changed while reviewing. Reload the comparison.", 409, "file_changed");
        const snapshot = structuredClone(meta.snapshot || {version: 2, patients: [], files: []});
        snapshot.files = snapshot.files.filter((f: any) => caseFold(f.relative_path) !== caseFold(record.path));
        if (!record.deleted && body.details?.metadata_available) {
          const d = {...body.details, relative_path: record.path};
          if (!snapshot.patients.some((p: any) => p.id === d.patient_id)) snapshot.patients.push({id: d.patient_id, name: d.patient_name, patient_number: d.patient_number});
          snapshot.files.push(d);
        }
        normaliseSnapshot(snapshot); await this.apply(record, body.expected, body.bytes.length ? body.bytes : undefined, mimeForPath(record.path));
        await this.saveSnapshot(snapshot, meta); return {success: true};
      }
      throw new DriveError("Unsupported Drive sync operation.", 404);
    });
  }
  async completeOAuth(code: string, userId: string) {
    const c = this.config;
    const result = await this.tokenRequest({client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirectUri, code, grant_type: "authorization_code"});
    this.accessToken = result.access_token;
    this.accessTokenExpiresAt = this.tokens.clock() + tokenLifetime(result.expires_in);
    const userResponse = await this.fetcher("https://openidconnect.googleapis.com/v1/userinfo", {headers: {Authorization: `Bearer ${result.access_token}`}, signal: AbortSignal.timeout(15000)});
    if (!userResponse.ok) throw new DriveError("Google identity could not be verified.", 502);
    const googleUser = await userResponse.json(); if (!googleUser.email || !googleUser.email_verified) throw new DriveError("A verified Google account is required.");
    return this.lock(async () => {
      const previous = await this.savedConnection();
      if (previous && previous.google_email !== googleUser.email) throw new DriveError("Reconnect the original Google account to preserve existing patient files.", 409);
      if (!result.refresh_token && !previous?.refresh_token_encrypted) throw new DriveError("Google did not grant offline access. Connect again.");
      let rootId = previous?.root_id;
      if (rootId) { const root = await this.google(`/drive/v3/files/${encodeURIComponent(rootId)}?fields=id,trashed`); if (root.trashed) throw new DriveError("Restore the clinic folder in Google Drive, then reconnect.", 409); }
      else {
        const root = await this.google("/drive/v3/files?fields=id", {method: "POST", body: JSON.stringify({name: c.rootName, mimeType: "application/vnd.google-apps.folder"})}); rootId = root.id;
      }
      const changeToken = previous?.change_token || (await this.google("/drive/v3/changes/startPageToken")).startPageToken;
      await this.commit(this.db.from("google_drive_connection").upsert({id: 1, ...(previous?.node_id ? {node_id: previous.node_id} : {}), google_email: googleUser.email, root_id: rootId, root_name: previous?.root_name || c.rootName, change_token: changeToken, refresh_token_encrypted: result.refresh_token ? await encrypt(result.refresh_token, c.encryptionKey) : previous.refresh_token_encrypted, connected_by: userId, connected_at: new Date().toISOString()}));
    });
  }
}
export function mimeForPath(path: string) {
  return ({jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", pdf: "application/pdf", zip: "application/zip", dcm: "application/dicom", dicom: "application/dicom"} as Record<string, string>)[path.split(".").at(-1)!.toLowerCase()] || "application/octet-stream";
}
async function readReview(request: Request) {
  const all = new Uint8Array(await request.arrayBuffer());
  if (all.length < 4 || all.length > MAX_UPLOAD + 1024 * 1024 + 4) throw new DriveError("Invalid transfer metadata.", 413);
  const length = new DataView(all.buffer).getUint32(0);
  if (!length || length > 1024 * 1024 || all.length < length + 4) throw new DriveError("Invalid transfer metadata.");
  const body = JSON.parse(new TextDecoder().decode(all.subarray(4, length + 4))), record = validateRecord(body.record);
  const bytes = all.subarray(length + 4);
  const size = !record.deleted && !sameContent(record, body.expected) ? record.size : 0;
  if (bytes.length !== size) throw new DriveError("Invalid transfer size.");
  return {...body, bytes};
}
