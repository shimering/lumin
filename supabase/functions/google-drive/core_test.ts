import {access, cleanName, decrypt, encrypt, metadataDigest, normaliseSnapshot, safePath, sha256, validateRecord} from "./core.ts";
function assert(value: unknown, message = "Assertion failed") { if (!value) throw new Error(message); }
function rejects(run: () => unknown) { try { run(); } catch { return; } throw new Error("Unsafe input was accepted"); }
Deno.test("private tokens encrypt, round-trip and reject tampering", async () => {
  const secret = "a".repeat(64), token = await encrypt("private-google-refresh-token", secret);
  assert(!token.includes("private-google-refresh-token")); assert(await decrypt(token, secret) === "private-google-refresh-token");
  let rejected = false; try { await decrypt(token.slice(0, -4) + "AAAA", secret); } catch { rejected = true; } assert(rejected);
});
Deno.test("only current active clinical roles can access patient media", () => {
  assert(!access({active: true, user_metadata: {is_admin: true}}).media);
  assert(!access({active: false, access_roles: {is_admin: true}}).admin);
  assert(access({active: true, access_roles: {is_admin: true}}).admin);
  assert(access({active: true, access_roles: [{role_permissions: [{page_key: "patients", can_view: true}]}]}).media);
  assert(!access({active: true, access_roles: {role_permissions: [{page_key: "settings", can_view: true}]}}).media);
});
Deno.test("Drive paths preserve Arabic hierarchy and reject traversal and unsafe files", () => {
  assert(cleanName(" أحمد علي ") === "أحمد_علي"); assert(safePath("أحمد_علي/Periapical/xray.png") === "أحمد_علي/Periapical/xray.png");
  for (const path of ["../P/x.png", "P/../x.png", "P\\Category\\x.png", "P/Category/x.html", "P/Category/.patient_id", "P/Category/CON.png", "P/C/x.png/", "P//x.png"]) rejects(() => safePath(path));
});
Deno.test("sync records require valid checksums, clocks and deletion tombstones", () => {
  const record = {path: "P/C/x.png", size: 2, sha256: "a".repeat(64), deleted: false, clock: {pc: 1}};
  assert(validateRecord(record).size === 2);
  rejects(() => validateRecord({...record, clock: {pc: 0}})); rejects(() => validateRecord({...record, size: 1.5})); rejects(() => validateRecord({...record, deleted: true}));
  assert(validateRecord({...record, size: 0, sha256: null, deleted: true}).deleted);
});
Deno.test("clinical metadata clears notes and rejects mismatched patient or tooth identities", () => {
  const pid = "10000000-0000-0000-0000-000000000001", patient = {id: pid, name: "أحمد"};
  const data = {version: 2, patients: [patient], files: [{patient_id: pid, relative_path: "P/C/x.png", note: "", tooth_ids: ["12", "A", "12"]}]};
  const normal = normaliseSnapshot(data); assert(normal.files[0].note === ""); assert(normal.files[0].tooth_ids.length === 2);
  rejects(() => normaliseSnapshot({...data, patients: []})); rejects(() => normaliseSnapshot({...data, files: [{...data.files[0], tooth_ids: ["99"]}]}));
});
Deno.test("metadata digest agrees with Python for Arabic, matrices and integral floats", async () => {
  const value = {version: 2, note: "أشعة\nالسن", numbers: [1, 1.0, -0, 1e-7, 1e20, 0.123456789], nested: {"😀": true, "\uffff": null}};
  // Generated independently by DriveMetadata.digest in storage-server/file_sync.py.
  assert(await metadataDigest(value) === "f9b1d94a3cf4f943c7d2299e5015c19092f8d5d43f22ddc71c747b733a6726ae", await metadataDigest(value));
  assert(await metadataDigest(value) === await metadataDigest(JSON.parse(JSON.stringify(value))));
  assert(await sha256("null") === "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b");
});
