import {assert} from "./test_helpers.ts";
import {fixture, DOCTOR, PID, NODE} from "./test_fixture.ts";
import {createHandler} from "./index.ts";
import {encrypt, caseFold} from "./core.ts";
import {DriveStore} from "./store.ts";

Deno.test("warm and concurrent image retrieval reuses Google tokens but checks current access and file bytes", async () => {
  const f = await fixture(), uploaded = await f.upload(); let exchanges = 0;
  const fetcher: typeof fetch = async (url, options) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/")) exchanges++;
    return f.google.fetch(url, options);
  };
  const handler = createHandler(f.config, f.db, fetcher);
  const image = () => handler(new Request(f.config.supabaseUrl + "/functions/v1/google-drive/files/" + uploaded.relativePath, {headers: {Authorization: "Bearer doctor"}}));
  const first = await Promise.all(Array.from({length: 6}, image));
  for (const response of first) { assert(response.ok); assert(await response.text() === "xray"); assert(response.headers.get("Cache-Control") === "private, no-store"); }
  assert(Number(exchanges) === 1);
  const profile = f.db.tables.user_profiles.find(row => row.user_id === DOCTOR);
  profile.active = false; assert((await image()).status === 403);
  profile.active = true;
  const file = f.db.tables.google_drive_files[0];
  await f.google.change(file.drive_id, new TextEncoder().encode("new-image-bytes"));
  assert(await (await image()).text() === "new-image-bytes", "Image bytes must remain live, not cached.");
  assert(Number(exchanges) === 1);
  f.db.tables.google_drive_connection[0].refresh_token_encrypted = await encrypt("new-refresh", f.config.encryptionKey);
  assert((await image()).ok); assert(Number(exchanges) === 2);
  f.db.tables.google_drive_connection[0].refresh_token_encrypted = "";
  assert((await image()).status === 409);
});

Deno.test("a revoked Google access token refreshes once on read without a reconnect", async () => {
  const f = await fixture(), uploaded = await f.upload(); let exchanges = 0;
  const fetcher: typeof fetch = async (url, options) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/")) return Response.json({access_token: `token-${++exchanges}`, expires_in: 3600});
    if (new Headers(options?.headers).get("Authorization") === "Bearer token-1") return Response.json({error: {}}, {status: 401});
    return f.google.fetch(url, options);
  };
  const handler = createHandler(f.config, f.db, fetcher);
  const image = () => handler(new Request(f.config.supabaseUrl + "/functions/v1/google-drive/files/" + uploaded.relativePath, {headers: {Authorization: "Bearer doctor"}}));
  assert(await (await image()).text() === "xray");
  assert(Number(exchanges) === 2);
  assert(await (await image()).text() === "xray");
  assert(Number(exchanges) === 2);
});

Deno.test("patient retrieval queries only that patient's file keys in a large clinic", async () => {
  const f = await fixture(), uploaded = await f.upload(), batches: string[][] = [];
  const from = f.db.from.bind(f.db);
  f.db.from = table => {
    const query = from(table), scoped = query.in.bind(query);
    if (table === "google_drive_files") {
      query.in = (key, values) => { batches.push(values); return scoped(key, values); };
      query.range = () => { throw new Error("Patient retrieval must not page through the clinic."); };
    }
    return query;
  };
  f.db.tables.google_drive_files.push(...Array.from({length: 2000}, (_, i) => ({path_key: `other/c/${i}.png`, record: {path: `other/c/${i}.png`, deleted: false}})));
  const response = await f.request(`/api/patient/${PID}/files`, "doctor", undefined, "GET");
  assert(response.ok, await response.clone().text());
  const data = await response.json();
  assert(data.total === 1 && data.files[0].relativePath === uploaded.relativePath);
  assert(batches.length === 1 && batches[0].length === 1 && batches[0][0] === caseFold(uploaded.relativePath));
});

Deno.test("scoped file reads include every chunk, Unicode path and deleted revision", async () => {
  const f = await fixture(), store = new DriveStore(f.db, f.config, f.google.fetch);
  const records = Array.from({length: 130}, (_, i) => ({path_key: caseFold(`أحمد_علي/Periapical/${i}.png`), record: {path: `أحمد_علي/Periapical/${i}.png`, deleted: i === 3, clock: {[NODE]: 1}}}));
  f.db.tables.google_drive_files = [...records, {path_key: "other/c/private.png", record: {path: "other/c/private.png"}}];
  const rows = await store.fileRows(records.map(row => row.record.path));
  assert(rows.length === records.length && rows.some(row => row.record.deleted));
  assert(rows.every(row => records.some(record => row.path_key === record.path_key)));
  const long = "患者".repeat(225) + "/Periapical/scan.png";
  f.db.tables.google_drive_files.push({path_key: caseFold(long), record: {path: long}});
  assert((await store.fileRows([long])).length === 1);
});
