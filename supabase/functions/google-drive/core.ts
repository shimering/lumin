// Pure helpers shared with contract/security tests. No credentials or DB access.
import {caseFold} from "./casefold.ts";
export {caseFold};
export function compareText(a: string, b: string) {
  const x = Array.from(a), y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) { const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!; if (d) return d; }
  return x.length - y.length;
}
export class DriveError extends Error {
  constructor(message: string, public status = 400, public code = "drive_error") { super(message); }
}
export const MAX_UPLOAD = 24 * 1024 * 1024;
export const EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "pdf", "dcm", "dicom", "zip"]);
export function cleanName(value: string) {
  return value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[\s_]+/g, "_").replace(/^[ ._]+|[ ._]+$/g, "");
}
export function safePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || value.includes("\\") || /[\u0000-\u001f]/.test(value)) throw new DriveError("Invalid patient file path.");
  const parts = value.split("/");
  if (parts.length < 3 || parts.some(p => !p || p.startsWith(".") || /[<>:"|?*]/.test(p) || /[ .]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new DriveError("Invalid patient file path.");
  if (!EXTENSIONS.has(parts.at(-1)!.split(".").at(-1)!.toLowerCase())) throw new DriveError("File is excluded from synchronization.");
  return value;
}
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new DriveError("Invalid patient or server identifier.");
  return value.toLowerCase();
}
export type RecordEntry = {path: string; sha256: string | null; size: number; deleted: boolean; clock: Record<string, number>};
export function validateRecord(value: any): RecordEntry {
  safePath(value?.path);
  const clock = value?.clock;
  if (typeof value.deleted !== "boolean" || !Number.isSafeInteger(value.size) || value.size < 0 || !clock || typeof clock !== "object" || Array.isArray(clock)
    || !Object.keys(clock).length || Object.keys(clock).length > 128 || Object.entries(clock).some(([k, v]) => !k || k.length > 128 || !Number.isSafeInteger(v) || Number(v) < 1)
    || (value.deleted ? value.sha256 !== null || value.size !== 0 : !/^[0-9a-f]{64}$/.test(value.sha256))) throw new DriveError("Invalid sync record.");
  return {path: value.path, sha256: value.sha256, size: value.size, deleted: value.deleted, clock: {...clock}};
}
export function sameContent(a: any, b: any) { return Boolean(a && b && a.deleted === b.deleted && (a.deleted || a.size === b.size && a.sha256 === b.sha256)); }
// Python's json.dumps(sort_keys=True, ensure_ascii=False) is the sync wire format.
export function pythonJson(value: any): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}: ${pythonJson(value[k])}`).join(", ")}}`;
  return JSON.stringify(value);
}
export function equal(a: any, b: any) { return pythonJson(a) === pythonJson(b); }
// IEEE-754 tags make integral floats, exponents and scan matrices identical
// across Python and JavaScript. PC-to-PC sync keeps its existing digest format.
export async function metadataDigest(value: any) {
  function tagged(v: any): any {
    if (v === null) return ["null"];
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new DriveError("Invalid clinical number.");
      // JSON and PostgreSQL collapse negative zero to zero on the wire.
      const bytes = new Uint8Array(8); new DataView(bytes.buffer).setFloat64(0, v === 0 ? 0 : v);
      return ["number", Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")];
    }
    if (typeof v === "boolean") return ["boolean", v];
    if (typeof v === "string") return ["string", v];
    if (Array.isArray(v)) return ["array", v.map(tagged)];
    return ["object", Object.keys(v).sort(compareText).map(k => [k, tagged(v[k])])];
  }
  return sha256(JSON.stringify(tagged(value)));
}
export function annotationSignature(row: any) {
  if (!row?.metadata_available) return null;
  return Object.fromEntries(["patient_id", "relative_path", "display_name", "note", "tooth_ids", "scan_date", "scan_config"].map(k => [k, row[k] ?? null]));
}
export function base64(bytes: Uint8Array) {
  let value = ""; for (const b of bytes) value += String.fromCharCode(b); return btoa(value);
}
export function unbase64(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export async function sha256(value: string | Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", typeof value === "string" ? new TextEncoder().encode(value) : value as BufferSource))).map(v => v.toString(16).padStart(2, "0")).join("");
}
async function cryptoKey(secret: string) {
  if (secret.length < 32) throw new DriveError("Drive encryption is not configured.", 503, "not_configured");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encrypt(value: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({name: "AES-GCM", iv}, await cryptoKey(secret), new TextEncoder().encode(value));
  return `v1.${base64(iv)}.${base64(new Uint8Array(bytes))}`;
}
export async function decrypt(value: string, secret: string) {
  const [version, iv, bytes] = value.split(".");
  if (version !== "v1" || !iv || !bytes) throw new DriveError("Invalid stored Drive credentials.", 500);
  return new TextDecoder().decode(await crypto.subtle.decrypt({name: "AES-GCM", iv: unbase64(iv) as BufferSource}, await cryptoKey(secret), unbase64(bytes) as BufferSource));
}
export function access(profile: any) {
  const role = Array.isArray(profile?.access_roles) ? profile.access_roles[0] : profile?.access_roles;
  return {admin: Boolean(profile?.active && role?.is_admin === true), media: Boolean(profile?.active && (role?.is_admin === true || role?.role_permissions?.some((p: any) => p.page_key === "patients" && p.can_view === true)))};
}
export function normaliseSnapshot(data: any) {
  if (!data || ![1, 2].includes(data.version) || !Array.isArray(data.patients) || !Array.isArray(data.files) || data.patients.length + data.files.length > 100000 || JSON.stringify(data).length > 16 * 1024 * 1024) throw new DriveError("Invalid clinical metadata.");
  const text = (v: any, n = 1024) => { if (v == null) return ""; if (!["string", "number"].includes(typeof v) || String(v).length > n || String(v).includes("\0")) throw new DriveError("Invalid clinical metadata."); return String(v); };
  const patients = data.patients.map((p: any) => ({id: uuid(p.id), name: text(p.name), patient_number: text(p.patient_number, 64), phone: text(p.phone, 128)})).sort((a: any, b: any) => a.id < b.id ? -1 : 1);
  const ids = new Set(patients.map((p: any) => p.id)), paths = new Set<string>(), folders = new Map<string, string>();
  if (ids.size !== patients.length) throw new DriveError("Duplicate patient metadata.");
  const files = data.files.map((f: any) => {
    const path = safePath(f.relative_path), pid = uuid(f.patient_id), key = caseFold(path);
    if (!ids.has(pid) || paths.has(key)) throw new DriveError("Ambiguous media metadata."); paths.add(key);
    const folder = caseFold(path.split("/")[0]);
    if (folders.has(folder) && folders.get(folder) !== pid) throw new DriveError("Different patients cannot share a media folder.", 409, "patient_changed");
    folders.set(folder, pid);
    const teeth = f.tooth_ids ?? (f.tooth_id ? [f.tooth_id] : []);
    if (!Array.isArray(teeth) || teeth.length > 52 || teeth.some(t => !/^(?:[1-9]|[12][0-9]|3[0-2]|[A-T])$/.test(String(t)))) throw new DriveError("Invalid tooth assignments.");
    const toothIds = [...new Set(teeth.map(String))];
    const scanDate = text(f.scan_date, 10);
    if (scanDate && (!/^\d{4}-\d{2}-\d{2}$/.test(scanDate) || Number.isNaN(Date.parse(scanDate)) || new Date(scanDate).toISOString().slice(0, 10) !== scanDate)) throw new DriveError("Invalid scan date.");
    const scanConfig = f.scan_config ?? null;
    if (scanConfig !== null && (typeof scanConfig !== "object" || Array.isArray(scanConfig) || JSON.stringify(scanConfig).length > 131072)) throw new DriveError("Invalid scan settings.");
    const source = text(f.source_relative_path, 2048); if (source) safePath(source);
    return {patient_id: pid, relative_path: path, display_name: text(f.display_name, 2048), note: text(f.note, 65536), tooth_id: toothIds[0] || "", tooth_ids: toothIds, scan_date: scanDate, scan_config: scanConfig, source_relative_path: source};
  }).sort((a: any, b: any) => compareText(caseFold(a.relative_path), caseFold(b.relative_path)));
  return {version: 2, patients, files};
}
