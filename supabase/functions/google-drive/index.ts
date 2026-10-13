import "jsr:@supabase/functions-js@2.117.3/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2.117.3";
import {DriveError, MAX_UPLOAD, access, caseFold, cleanName, equal, safePath, sha256, uuid} from "./core.ts";
import {DriveStore, checked, mimeForPath, type DriveConfig} from "./store.ts";
import {DriveTokenCache} from "./token_cache.ts";

const cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type, x-lumin-key, x-lumin-sync-key, x-lumin-sync-node, x-lumin-sync-meta", "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS"};
const noCache = {...cors, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {...noCache, "Content-Type": "application/json"}});
function configuration(): DriveConfig {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  return {supabaseUrl, clientId: Deno.env.get("GOOGLE_DRIVE_CLIENT_ID") || "", clientSecret: Deno.env.get("GOOGLE_DRIVE_CLIENT_SECRET") || "", encryptionKey: Deno.env.get("GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY") || "", redirectUri: Deno.env.get("GOOGLE_DRIVE_REDIRECT_URI") || `${supabaseUrl}/functions/v1/google-drive/callback`, appUrl: Deno.env.get("GOOGLE_DRIVE_APP_URL") || Deno.env.get("CLINIC_APP_URL") || "", rootName: Deno.env.get("GOOGLE_DRIVE_ROOT_NAME") || "Lumin Clinic"};
}
async function profile(db: any, userId: string) {
  const p = await checked(db.from("user_profiles").select("active, access_roles(is_admin, role_permissions(page_key, can_view))").eq("user_id", userId).maybeSingle());
  return access(p);
}
async function caller(request: Request, url: URL, db: any, adminOnly = false) {
  let userId = "";
  const authorization = request.headers.get("Authorization") || "";
  if (authorization.startsWith("Bearer ")) {
    const {data, error} = await db.auth.getUser(authorization.slice(7));
    if (error || !data.user) throw new DriveError("Sign in again to access storage.", 401, "invalid_session");
    userId = data.user.id;
  } else if (!adminOnly) {
    const grant = request.headers.get("x-lumin-key") || url.searchParams.get("key") || "";
    if (grant.length < 32 || grant.length > 128) throw new DriveError("Sign in to access storage.", 401, "invalid_media_grant");
    const saved = await checked(db.from("google_drive_media_grants").select("user_id").eq("token_hash", await sha256(grant)).gt("expires_at", new Date().toISOString()).maybeSingle());
    if (saved) userId = saved.user_id;
  }
  if (!userId) throw new DriveError("Storage authorization has expired. Refresh the page.", 401, "invalid_media_grant");
  const permission = await profile(db, userId);
  if (adminOnly ? !permission.admin : !permission.media) throw new DriveError("You do not have permission to access this storage.", 403, "access_denied");
  return userId;
}
async function peerCaller(request: Request, db: any) {
  const node = uuid(request.headers.get("x-lumin-sync-node")), secret = request.headers.get("x-lumin-sync-key") || "";
  const p = await checked(db.from("google_drive_peers").select("authorized_by").eq("node_id", node).eq("secret_hash", await sha256(secret)).maybeSingle());
  if (!p || !(await profile(db, p.authorized_by)).admin) throw new DriveError("Invalid sync peer credentials.", 401, "invalid_peer_credentials");
}
function redirect(config: DriveConfig, result: string, message = "") {
  const target = new URL(config.appUrl);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && ["localhost", "127.0.0.1"].includes(target.hostname))) throw new DriveError("The Drive application URL must use HTTPS.", 503, "not_configured");
  target.searchParams.set("google_drive", result); if (message) target.searchParams.set("google_drive_message", message.slice(0, 180));
  target.searchParams.set("view", "admin"); target.hash = "admin";
  return new Response(null, {status: 302, headers: {...noCache, Location: target.toString()}});
}
async function callback(url: URL, store: DriveStore) {
  const config = store.config;
  if (!store.configured()) throw new DriveError("Google Drive setup is incomplete.", 503, "not_configured");
  try {
    const raw = url.searchParams.get("state") || "";
    // DELETE RETURNING consumes the state atomically, including cancelled callbacks.
    const state = await checked(store.db.from("google_drive_oauth_states").delete().eq("state_hash", await sha256(raw)).gt("expires_at", new Date().toISOString()).select("user_id").maybeSingle());
    if (!state || !(await profile(store.db, state.user_id)).admin) throw new DriveError("This authorization request expired. Connect again.", 403);
    if (url.searchParams.has("error")) throw new DriveError("Google Drive connection was cancelled.");
    const code = url.searchParams.get("code"); if (!code) throw new DriveError("Google authorization was not completed.");
    await store.completeOAuth(code, state.user_id);
    return redirect(config, "connected");
  } catch (error) { return redirect(config, "error", error instanceof DriveError ? error.message : "Drive connection failed. Please try again."); }
}
async function control(action: string, body: any, request: Request, url: URL, store: DriveStore) {
  const db = store.db;
  const userId = await caller(request, url, db, action !== "status");
  if (action === "status") {
    const connection = await store.savedConnection();
    const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
    const grant = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    await checked(db.from("google_drive_media_grants").delete().lt("expires_at", new Date().toISOString()));
    if (connection?.refresh_token_encrypted) await checked(db.from("google_drive_media_grants").insert({token_hash: await sha256(grant), user_id: userId, expires_at: expiresAt}));
    return {configured: store.configured(), connected: Boolean(connection?.refresh_token_encrypted), email: connection?.google_email || "", rootName: connection?.root_name || store.config.rootName, rootUrl: connection ? `https://drive.google.com/drive/folders/${encodeURIComponent(connection.root_id)}` : "", mediaGrant: connection?.refresh_token_encrypted ? grant : "", expiresAt};
  }
  if (action === "begin-connect") {
    if (!store.configured()) throw new DriveError("Google Drive setup is incomplete. Configure the Google OAuth credentials and application URL first.", 503, "not_configured");
    // Validate the configured callback destination before creating any state.
    redirect(store.config, "connected");
    const state = crypto.randomUUID() + crypto.randomUUID();
    await checked(db.from("google_drive_oauth_states").delete().lt("expires_at", new Date().toISOString()));
    await checked(db.from("google_drive_oauth_states").insert({state_hash: await sha256(state), user_id: userId, expires_at: new Date(Date.now() + 10 * 60000).toISOString()}));
    const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    target.search = new URLSearchParams({client_id: store.config.clientId, redirect_uri: store.config.redirectUri, response_type: "code", access_type: "offline", prompt: "consent", scope: "openid email https://www.googleapis.com/auth/drive.file", state}).toString();
    return {authorization_url: target.toString()};
  }
  if (action === "disconnect") return store.lock(async () => {
    const settings = await checked(db.from("clinic_settings").select("storage_server_url").eq("id", 1).maybeSingle());
    if (String(settings?.storage_server_url || "").replace(/\/+$/, "") === `${store.config.supabaseUrl}/functions/v1/google-drive`) throw new DriveError("Switch clinic storage to a local server before disconnecting Google Drive.", 409, "active_storage");
    // Keep folder mappings, originals, revision clocks and history for reconnection.
    await store.commit(db.from("google_drive_connection").update({refresh_token_encrypted: ""}).eq("id", 1));
    await checked(db.from("google_drive_media_grants").delete().neq("token_hash", ""));
    await checked(db.from("google_drive_peers").delete().neq("secret_hash", ""));
    await checked(db.from("google_drive_oauth_states").delete().neq("state_hash", ""));
    return {success: true};
  });
  throw new DriveError("Unknown Drive action.");
}
async function patient(db: any, id: string) {
  const p = await checked(db.from("patients").select("id, name, patient_number, phone").eq("id", uuid(id)).maybeSingle());
  if (!p) throw new DriveError("Patient not found.", 404); return p;
}
async function mediaRoute(route: string, request: Request, url: URL, store: DriveStore) {
  const db = store.db; await caller(request, url, db);
  const connection = await store.connection();
  if (route === "/api/health") {
    const root = await store.google(`/drive/v3/files/${encodeURIComponent(connection.root_id)}?fields=id,trashed`);
    if (root.trashed) throw new DriveError("Restore the clinic folder in Drive.", 503);
    const meta = await store.metadata();
    return {status: "online", service: "Lumin Google Drive Storage", storageRoot: connection.root_name, totalPatientFolders: meta.snapshot?.patients?.length || 0, maxFileSizeMB: MAX_UPLOAD / 1024 / 1024, capabilities: {patient3dScans: true, scanOriginalFilenames: true, localMediaMetadata: true, syncClinicalMetadata: true}};
  }
  if (route === "/api/xray-index" && request.method === "GET") {
    const meta = await store.metadata();
    const annotations = (meta.snapshot?.files || []).filter((f: any) => /^(Panoramic|Periapical)$/.test(f.relative_path.split("/")[1]) && /\.(?:jpe?g|png|webp|gif|bmp|avif)$/i.test(f.relative_path));
    const rows = await store.fileRows(annotations.map((f: any) => f.relative_path));
    const live = new Set(rows.filter((r: any) => !r.record.deleted).map((r: any) => r.path_key));
    const countsByPatient: Record<string, Record<string, number>> = {};
    for (const file of annotations) {
      if (!live.has(caseFold(file.relative_path))) continue;
      const counts = countsByPatient[file.patient_id] ||= {};
      for (const tooth of new Set<string>(file.tooth_ids ?? (file.tooth_id ? [file.tooth_id] : []))) counts[tooth] = (counts[tooth] || 0) + 1;
    }
    return {metadataSource: "google-drive", revision: meta.revision, countsByPatient};
  }
  const listMatch = route.match(/^\/api\/patient\/([^/]+)\/files$/);
  if (listMatch && request.method === "GET") {
    const [p, meta] = await Promise.all([patient(db, listMatch[1]), store.metadata()]);
    const annotations = (meta.snapshot?.files || []).filter((f: any) => f.patient_id === p.id);
    const paths = annotations.map((f: any) => f.relative_path);
    const rows = await store.fileRows(paths);
    const owner = meta.snapshot?.patients?.find((value: any) => value.id === p.id);
    const details = new Map<string, any>(annotations.map((row: any) => [caseFold(row.relative_path), {...row, patient_name: owner?.name || "", patient_number: owner?.patient_number || "", metadata_available: true}]));
    const files = rows.filter((r: any) => !r.record.deleted && details.get(r.path_key)?.patient_id === p.id).map((r: any) => ({filename: r.record.path.split("/").at(-1), category: r.record.path.split("/")[1], patientFolder: r.record.path.split("/")[0], relativePath: r.record.path, sizeBytes: r.record.size, modifiedAt: r.modified_at, mediaDetails: details.get(r.path_key)})).sort((a: any, b: any) => b.modifiedAt.localeCompare(a.modifiedAt));
    return {patientId: p.id, total: files.length, files, metadataSource: "google-drive", metadataUnavailable: false};
  }
  if (route === "/api/upload" && request.method === "POST") {
    const length = Number(request.headers.get("Content-Length")); if (length > MAX_UPLOAD + 1024 * 1024) throw new DriveError("Drive uploads are limited to 24 MB per file.", 413, "file_too_large");
    // Cached app versions use "image"; local storage accepts both upload fields.
    const form = await request.formData(), file = form.get("file") ?? form.get("image");
    if (!(file instanceof File)) throw new DriveError("Choose a file or paste an image before uploading.", 400, "missing_file");
    if (file.size === 0 || file.size > MAX_UPLOAD) throw new DriveError("Choose a file between 1 byte and 24 MB.", 413, "file_too_large");
    const p = await patient(db, String(form.get("patientId") || form.get("patient_id") || ""));
    const category = cleanName(String(form.get("category") || "General")) || "General", name = cleanName(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    return store.lock(async () => {
      const folder = await store.patientFolder(p), scan = category === "3D-Scans";
      if (scan !== /\.zip$/i.test(name)) throw new DriveError("ZIP files must use the 3D-Scans category.");
      const unique = scan ? uuid(form.get("scanUploadId") || crypto.randomUUID()).replaceAll("-", "") + "/" + file.name : `${new Date().toISOString().slice(0, 10)}_${Date.now()}_${name}`;
      const path = safePath(`${folder}/${category}/${unique}`), old = await store.row(path);
      if (!old) await store.apply({path, sha256: await sha256(bytes), size: bytes.length, deleted: false, clock: {[connection.node_id]: 1}}, null, bytes, mimeForPath(path));
      else if (old.record.sha256 !== await sha256(bytes)) throw new DriveError("The upload identifier was already used for another file.", 409);
      const meta = await store.metadata();
      if (!store.details(meta.snapshot, path).metadata_available) await store.setDetails(path, p.id, {note: String(form.get("note") || ""), display_name: file.name}, p);
      return {success: true, relativePath: path, filename: path.split("/").at(-1), category, patientFolder: folder, sizeBytes: bytes.length};
    });
  }
  const detailsMatch = route.match(/^\/api\/patient\/([^/]+)\/media-details$/);
  if (detailsMatch && request.method === "POST") {
    const p = await patient(db, detailsMatch[1]), body = await request.json(), path = safePath(body.relativePath);
    return store.lock(async () => {
      const row = await store.row(path), meta = await store.metadata();
      if (!row || row.record.deleted || store.details(meta.snapshot, path).patient_id !== p.id) throw new DriveError("Patient identity does not match media.", 409);
      return {success: true, metadataSource: "google-drive", details: await store.setDetails(path, p.id, body.details, p)};
    });
  }
  const renameMatch = route.match(/^\/api\/patient\/([^/]+)\/rename$/);
  if (renameMatch && request.method === "POST") {
    // Use the saved clinic patient identity, never a caller-supplied folder name.
    const p = await patient(db, renameMatch[1]);
    return store.lock(() => store.renamePatient(p));
  }
  const fileMatch = route.match(/^\/(files|api\/thumbnail)\/(.+)$/);
  if (fileMatch && request.method === "GET") return store.download(safePath(decodeURIComponent(fileMatch[2])), undefined, fileMatch[1] !== "files");
  if (route === "/api/file" && request.method === "DELETE") {
    const body = await request.json(), path = safePath(body.relativePath || body.path);
    return store.lock(async () => {
      const row = await store.row(path); if (!row || row.record.deleted) throw new DriveError("Patient file not found.", 404);
      const record = {...row.record, deleted: true, sha256: null, size: 0, clock: {...row.record.clock, [connection.node_id]: (row.record.clock[connection.node_id] || 0) + 1}};
      await store.apply(record, row.record); return {success: true};
    });
  }
  if (route === "/api/file/move" && request.method === "POST") {
    const body = await request.json(), source = safePath(body.relativePath || body.path), category = cleanName(body.targetCategory || body.category || "");
    if (!category) throw new DriveError("Choose a category.");
    return store.lock(async () => {
      const row = await store.row(source); if (!row || row.record.deleted) throw new DriveError("Patient file not found.", 404);
      const parts = source.split("/"), oldCategory = parts[1]; parts[1] = category; const path = safePath(parts.join("/"));
      if (oldCategory === "3D-Scans" || category === "3D-Scans") throw new DriveError("Scan archives must remain in their scan category.");
      if (path === source) return {success: true, newRelativePath: path, newCategory: category};
      const target = await store.row(path);
      if (target && !target.record.deleted) throw new DriveError("A file already exists in that category.", 409);
      const response = await store.download(source), bytes = new Uint8Array(await response.arrayBuffer()), clock = {...row.record.clock};
      for (const [node, revision] of Object.entries(target?.record.clock || {})) clock[node] = Math.max(clock[node] || 0, Number(revision));
      clock[connection.node_id] = (clock[connection.node_id] || 0) + 1;
      await store.apply({...row.record, path, clock}, target?.record || null, bytes, row.mime_type);
      const meta = await store.metadata(), details = store.details(meta.snapshot, source);
      if (details.patient_id) await store.setDetails(path, details.patient_id, details, meta.snapshot.patients.find((p: any) => p.id === details.patient_id));
      await store.apply({...row.record, clock, deleted: true, sha256: null, size: 0}, row.record);
      return {success: true, oldRelativePath: source, newRelativePath: path, newCategory: category};
    });
  }
  throw new DriveError("This operation is not available for Google Drive.", 404, "unsupported_operation");
}
export function createHandler(config: DriveConfig, db: any, fetcher: typeof fetch = fetch) {
 const tokens = new DriveTokenCache();
 return async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, {status: 204, headers: cors});
  try {
    if (request.body) {
      const maximum = MAX_UPLOAD + 1024 * 1024 + 4;
      if (Number(request.headers.get("Content-Length")) > maximum) throw new DriveError("Drive uploads are limited to 24 MB per file.", 413, "file_too_large");
      let received = 0;
      const bounded = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maximum) throw new DriveError("Drive uploads are limited to 24 MB per file.", 413, "file_too_large");
        controller.enqueue(chunk);
      }}));
      request = new Request(request, {body: bounded});
    }
    const store = new DriveStore(db, config, fetcher, tokens);
    const url = new URL(request.url), route = url.pathname.replace(/^.*\/google-drive(?=\/|$)/, "") || "/";
    if (route === "/callback" && request.method === "GET") return await callback(url, store);
    if (route === "/" && request.method === "POST") { const body = await request.json(); return json(await control(String(body.action || "status"), body, request, url, store)); }
    if (route === "/api/revoke-grant" && request.method === "POST") {
      const grant = request.headers.get("x-lumin-key") || ""; await checked(db.from("google_drive_media_grants").delete().eq("token_hash", await sha256(grant))); return json({success: true});
    }
    let result: any;
    if (route.startsWith("/api/sync/peer/")) {
      await peerCaller(request, db); await store.connection();
      const length = Number(request.headers.get("Content-Length")); if (length > MAX_UPLOAD + 1024 * 1024 + 4) throw new DriveError("Drive sync is limited to 24 MB per file.", 413, "file_too_large");
      result = await store.peer(route.slice("/api/sync/peer/".length), request, url);
    } else if (route === "/api/sync/info" && request.method === "GET") {
      await caller(request, url, db, true); const connection = await store.connection();
      const node = url.searchParams.get("peer");
      const paired = node ? await checked(db.from("google_drive_peers").select("node_id").eq("node_id", uuid(node)).maybeSingle()) : null;
      result = {nodeId: connection.node_id, protocol: 1, fileScope: "patient-files-v1", clinicalMetadataVersion: 2, pair: paired ? {peerId: paired.node_id, role: "replica"} : null};
    } else if (route === "/api/sync/pair/accept" && request.method === "POST") {
      const userId = await caller(request, url, db, true), body = await request.json(), connection = await store.connection(), node = uuid(body.peerId);
      if (node === connection.node_id || typeof body.secret !== "string" || body.secret.length < 32 || body.secret.length > 128) throw new DriveError("Invalid pairing request.");
      await store.lock(async () => store.commit(db.from("google_drive_peers").upsert({node_id: node, secret_hash: await sha256(body.secret), authorized_by: userId}))); result = {paired: true};
    } else result = await mediaRoute(route, request, url, store);
    if (result instanceof Response) {
      const headers = new Headers(noCache);
      const rawType = result.headers.get("Content-Type") || "application/octet-stream";
      const safeType = /^(image\/(?:jpeg|png|webp|gif|bmp|tiff)|application\/(?:pdf|zip|dicom|octet-stream))(?:;|$)/i.test(rawType) ? rawType : "application/octet-stream";
      headers.set("Content-Type", safeType);
      headers.set("Content-Disposition", safeType.startsWith("image/") || safeType === "application/pdf" ? "inline" : "attachment");
      return new Response(result.body, {status: result.status, headers});
    }
    return json(result);
  } catch (error) { return json({error: error instanceof DriveError ? error.message : "Drive could not complete this operation. Retry shortly.", code: error instanceof DriveError ? error.code : "drive_error"}, error instanceof DriveError ? error.status : 500); }
}; }
if (import.meta.main) {
  const config = configuration();
  const db = createClient(config.supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", {auth: {persistSession: false, autoRefreshToken: false}, global: {fetch: (input, init) => fetch(input, {...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)})}});
  Deno.serve(createHandler(config, db));
}
