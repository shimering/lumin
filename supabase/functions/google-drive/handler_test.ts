import {assert, rejects} from "./test_helpers.ts";
import {fixture, PID, NODE, DOCTOR} from "./test_fixture.ts";
import {MAX_UPLOAD, caseFold, sha256, metadataDigest, base64} from "./core.ts";
import {DriveStore} from "./store.ts";

Deno.test("doctors use private expiring media grants and cannot authorize the clinic account", async () => {
  const f = await fixture(), status = await f.request("", "doctor", {action: "status"}), text = await status.text(), data = JSON.parse(text);
  assert(data.connected && data.mediaGrant.length === 64);
  assert(!/private-google|private-client|refresh_token|encryption/i.test(text));
  assert((await f.request("", "doctor", {action: "begin-connect"})).status === 403);
  const health = () => f.handler(new Request(f.config.supabaseUrl + "/functions/v1/google-drive/api/health?key=" + data.mediaGrant));
  assert((await health()).status === 200);
  f.db.tables.user_profiles.find(p => p.user_id === DOCTOR).active = false;
  assert((await health()).status === 403);
  f.db.tables.user_profiles.find(p => p.user_id === DOCTOR).active = true;
  const revoke = new Request(f.config.supabaseUrl + "/functions/v1/google-drive/api/revoke-grant", {method: "POST", headers: {"x-lumin-key": data.mediaGrant}});
  assert((await f.handler(revoke)).ok); assert((await health()).status === 401);
});
Deno.test("OAuth state is single-use and reconnect preserves the original Google account and sync identity", async () => {
  const f = await fixture(), started = await (await f.request("", "admin", {action: "begin-connect"})).json();
  const state = new URL(started.authorization_url).searchParams.get("state")!;
  assert(f.db.tables.google_drive_oauth_states[0].state_hash === await sha256(state));
  const callback = () => f.handler(new Request(f.config.redirectUri + "?code=test-code&state=" + state));
  const response = await callback(); assert(response.status === 302 && response.headers.get("Location")!.includes("google_drive=connected"));
  assert(f.db.tables.google_drive_connection[0].node_id === NODE);
  assert(!f.db.tables.google_drive_connection[0].refresh_token_encrypted.includes("private-google-refresh"));
  assert((await callback()).headers.get("Location")!.includes("google_drive=error"));
  f.google.email = "different@example.test";
  const next = await (await f.request("", "admin", {action: "begin-connect"})).json();
  const failed = await f.handler(new Request(f.config.redirectUri + "?code=test-code&state=" + new URL(next.authorization_url).searchParams.get("state")));
  assert(failed.headers.get("Location")!.includes("google_drive=error"));
  assert(f.db.tables.google_drive_connection[0].google_email === "clinic@example.test");
});
Deno.test("uploads preserve Arabic patient/category folders and notes survive partial edits, moves and rollback", async () => {
  const f = await fixture(), upload = await f.upload(), path = upload.relativePath;
  assert(path.startsWith("أحمد_علي/Periapical/"));
  const result = await f.request(`/api/patient/${PID}/media-details`, "doctor", {relativePath: path, details: {note: "أشعة السن", tooth_ids: ["12", "A"]}});
  assert(result.ok, await result.clone().text());
  await f.request(`/api/patient/${PID}/media-details`, "doctor", {relativePath: path, details: {note: ""}});
  const listed = await (await f.request(`/api/patient/${PID}/files`, "doctor", undefined, "GET")).json();
  assert(listed.metadataSource === "google-drive" && listed.total === 1);
  assert(listed.files[0].mediaDetails.note === "" && listed.files[0].mediaDetails.tooth_ids.length === 2);
  const move = await (await f.request("/api/file/move", "doctor", {relativePath: path, targetCategory: "Clinical-Photos"})).json();
  assert(move.newRelativePath.includes("/Clinical-Photos/"));
  const rollback = await f.request("/api/file/move", "doctor", {relativePath: move.newRelativePath, targetCategory: "Periapical"});
  assert(rollback.ok, await rollback.clone().text());
  const restored = await f.request("/files/" + path, "doctor", undefined, "GET");
  assert(restored.ok && await restored.text() === "xray");
  assert((await f.request("/api/file", "doctor", {relativePath: path}, "DELETE")).ok);
  assert((await f.request("/files/" + path, "doctor", undefined, "GET")).status === 404);
  assert([...f.google.files.values()].some(r => r.name === ".Lumin_Recovery"));
});
Deno.test("X-ray uploads accept the app's image field and the shared file field without losing bytes or notes", async () => {
  for (const field of ["image", "file"]) {
    const f = await fixture(), bytes = new Uint8Array(545260).fill(127);
    const name = field === "image" ? "clipboard-2026-10-13T17-51-47-555Z.png" : "selected-xray.png";
    const form = new FormData();
    form.set(field, new File([bytes], name, {type: "image/png"}));
    form.set("patientId", PID); form.set("patientName", "untrusted-name");
    form.set("category", "Periapical"); form.set("note", "أشعة السن");
    const response = await f.request("/api/upload", "doctor", form);
    assert(response.ok, await response.clone().text());
    const uploaded = await response.json();
    assert(uploaded.sizeBytes === bytes.length && uploaded.relativePath.startsWith("أحمد_علي/Periapical/"));
    const downloaded = await f.request("/files/" + uploaded.relativePath, "doctor", undefined, "GET");
    assert(downloaded.ok && downloaded.headers.get("Content-Type") === "image/png");
    assert(await sha256(new Uint8Array(await downloaded.arrayBuffer())) === await sha256(bytes));
    const listed = await (await f.request(`/api/patient/${PID}/files`, "doctor", undefined, "GET")).json();
    assert(listed.total === 1 && listed.files[0].mediaDetails.note === "أشعة السن");
    assert(listed.files[0].mediaDetails.display_name === name && listed.files[0].mediaDetails.patient_id === PID);
  }
});
Deno.test("missing upload files are distinguished from empty or oversized images", async () => {
  const f = await fixture();
  for (const value of [null, "not a file", new File([], "empty.png"), new File([new Uint8Array(MAX_UPLOAD + 1)], "large.png")]) {
    const form = new FormData(); form.set("patientId", PID);
    if (value !== null) form.set("image", value);
    const response = await f.request("/api/upload", "doctor", form), body = await response.json();
    const missing = value === null || typeof value === "string";
    assert(response.status === (missing ? 400 : 413), JSON.stringify(body));
    assert(body.code === (missing ? "missing_file" : "file_too_large"), JSON.stringify(body));
    assert((f.db.tables.google_drive_files || []).length === 0);
  }
});
Deno.test("sync handles checksums, expected revisions, missing Drive files and explicit trash without silent deletions", async () => {
  const f = await fixture(), upload = await f.upload(), store = new DriveStore(f.db, f.config, f.google.fetch);
  const row = await store.row(upload.relativePath);
  await rejects(() => store.lock(() => store.apply({...row.record, sha256: "a".repeat(64)}, row.record, new Uint8Array([1]))));
  assert((await store.row(upload.relativePath)).record.sha256 === row.record.sha256);
  f.google.files.delete(row.drive_id); f.google.changes.push({fileId: row.drive_id, removed: true});
  await rejects(() => store.lock(() => store.reconcile()));
  assert(!(await store.row(upload.relativePath)).record.deleted);
  f.google.files.set(row.drive_id, {id: row.drive_id, trashed: true});
  await store.lock(() => store.reconcile()); assert((await store.row(upload.relativePath)).record.deleted);
});
Deno.test("large manifests include every page and lost leases prevent further writes", async () => {
  const f = await fixture(), store = new DriveStore(f.db, f.config, f.google.fetch);
  f.db.tables.google_drive_files = Array.from({length: 1005}, (_, i) => ({path_key: `P/C/${String(i).padStart(4, "0")}.png`, record: {path: `P/C/${i}.png`, deleted: true, sha256: null, size: 0, clock: {[NODE]: 1}}}));
  const manifest: any = await store.peer("manifest", new Request("https://test/"), new URL("https://test/"));
  assert(Object.keys(manifest.files).length === 1005);
  await rejects(() => store.lock(async () => {
    f.db.lease!.until = 0;
    await store.commit(f.db.from("google_drive_metadata").update({snapshot: "bad"}).eq("id", 1));
  }));
  assert(f.db.tables.google_drive_metadata[0].snapshot === null);
  assert(caseFold("Straße/ΟΣ/ſ.png") === "strasse/οσ/s.png");
});
Deno.test("pair credentials are private, bound to a current admin and independent of media grants", async () => {
  const f = await fixture(), peerId = "40000000-0000-0000-0000-000000000001", secret = "p".repeat(64);
  assert((await f.request("/api/sync/pair/accept", "doctor", {peerId, secret})).status === 403);
  assert((await f.request("/api/sync/pair/accept", "admin", {peerId, secret})).ok);
  assert(f.db.tables.google_drive_peers[0].secret_hash === await sha256(secret));
  const peer = () => f.handler(new Request(f.config.supabaseUrl + "/functions/v1/google-drive/api/sync/peer/metadata", {headers: {"x-lumin-sync-node": peerId, "x-lumin-sync-key": secret}}));
  const response = await peer(); assert(response.ok); assert((await response.json()).digest === await metadataDigest(null));
  f.db.tables.user_profiles[0].active = false; assert((await peer()).status === 401);
});
Deno.test("active clinic storage cannot be disconnected and untrusted MIME cannot execute inline", async () => {
  const f = await fixture(); f.db.tables.clinic_settings = [{id: 1, storage_server_url: f.config.supabaseUrl + "/functions/v1/google-drive"}];
  assert((await f.request("", "admin", {action: "disconnect"})).status === 409);
  const upload = await f.upload(), row = f.db.tables.google_drive_files.find(r => r.path_key === caseFold(upload.relativePath));
  f.google.files.get(row.drive_id).mimeType = "text/html";
  const file = await f.request("/files/" + upload.relativePath, "doctor", undefined, "GET");
  assert(file.headers.get("Content-Type") === "application/octet-stream" && file.headers.get("Content-Disposition") === "attachment");
});
Deno.test("peer file transfer and metadata CAS accept valid bytes and reject stale snapshots", async () => {
  const f = await fixture(), store = new DriveStore(f.db, f.config, f.google.fetch), bytes = new TextEncoder().encode("from-local");
  const record = {path: "PC/Periapical/test.png", sha256: await sha256(bytes), size: bytes.length, deleted: false, clock: {[NODE]: 1}};
  const request = new Request("https://test/", {method: "PUT", headers: {"x-lumin-sync-meta": base64(new TextEncoder().encode(JSON.stringify({record, expected: null})))}, body: bytes});
  await store.peer("file", request, new URL("https://test/"));
  assert(await (await store.download(record.path)).text() === "from-local");
  await rejects(() => store.peer("metadata", new Request("https://test/", {method: "POST", body: JSON.stringify({expected: "wrong", snapshot: {version: 2, patients: [], files: []}})}), new URL("https://test/")));
});
Deno.test("patient rename keeps file IDs and moves folder indexes and annotations together", async () => {
  const f = await fixture(), upload = await f.upload(), oldRow = f.db.tables.google_drive_files[0];
  f.db.tables.patients[0].name = "أحمد سعيد";
  const response = await f.request(`/api/patient/${PID}/rename`, "doctor", {newName: "untrusted-name"});
  assert(response.ok, await response.clone().text());
  const list = await (await f.request(`/api/patient/${PID}/files`, "doctor", undefined, "GET")).json();
  assert(list.total === 1 && list.files[0].relativePath.startsWith("أحمد_سعيد/"));
  const next = f.db.tables.google_drive_files.find(r => !r.record.deleted);
  assert(next.drive_id === oldRow.drive_id && next.record.path !== upload.relativePath);
  assert(f.db.tables.google_drive_folders.every(r => !r.relative_path.startsWith("أحمد_علي")));
  assert((await f.request("/files/" + next.record.path, "doctor", undefined, "GET")).ok);
});
Deno.test("oversized uploads are rejected even when a streaming client omits Content-Length", async () => {
  const f = await fixture();
  const body = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(new Uint8Array(MAX_UPLOAD + 1024 * 1024 + 5)); controller.close();}});
  const result = await f.handler(new Request(f.config.supabaseUrl + "/functions/v1/google-drive", {method: "POST", body}));
  assert(result.status === 413, await result.clone().text());
});
