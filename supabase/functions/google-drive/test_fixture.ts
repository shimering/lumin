// In-memory Google and PostgREST stand-ins; never contacts a real account.
import {encrypt, sha256} from "./core.ts";
import {createHandler} from "./index.ts";
import {type DriveConfig} from "./store.ts";
export const PID = "10000000-0000-0000-0000-000000000001";
export const ADMIN = "20000000-0000-0000-0000-000000000001";
export const DOCTOR = "20000000-0000-0000-0000-000000000002";
export const NODE = "30000000-0000-0000-0000-000000000001";
const copy = (value: any) => structuredClone(value);
export class MemoryDB {
  tables: Record<string, any[]> = {};
  lease: {owner: string; until: number} | null = null;
  auth = {getUser: (token: string) => Promise.resolve({data: {user: ["admin", "doctor"].includes(token) ? {id: token === "admin" ? ADMIN : DOCTOR} : null}, error: null})};
  from(table: string) { return new Query(this, table); }
  rpc(name: string, args: any) {
    const {p_owner} = args;
    if (name === "google_drive_claim_lock") {
      if (this.lease && this.lease.until > Date.now()) return Promise.resolve({data: false});
      this.lease = {owner: p_owner, until: Date.now() + 120000}; return Promise.resolve({data: true});
    }
    if (name === "google_drive_release_lock") { if (this.lease?.owner === p_owner) this.lease = null; return Promise.resolve({data: null}); }
    if (name === "google_drive_renew_lock") {
      const valid = Boolean(this.lease && this.lease.owner === p_owner && this.lease.until > Date.now());
      if (valid) this.lease!.until = Date.now() + 120000; return Promise.resolve({data: valid});
    }
    if (name === "google_drive_rename_paths") {
      if (!this.lease || this.lease.owner !== p_owner || this.lease.until <= Date.now() || this.tables.google_drive_metadata[0].revision !== args.p_revision) return Promise.resolve({data: null, error: {message: "stale rename"}});
      for (const folder of args.p_folders) Object.assign(this.tables.google_drive_folders.find(f => f.path_key === folder.old_key), {path_key: folder.path_key, relative_path: folder.relative_path});
      for (const value of args.p_records) {
        const old = this.tables.google_drive_files.find(f => f.path_key === value.path_key);
        if (old) Object.assign(old, copy(value)); else this.tables.google_drive_files.push(copy(value));
      }
      Object.assign(this.tables.google_drive_metadata[0], {snapshot: copy(args.p_snapshot), digest: args.p_digest, revision: crypto.randomUUID()});
      return Promise.resolve({data: null, error: null});
    }
    throw new Error("Unexpected RPC: " + name);
  }
}
class Query implements PromiseLike<any> {
  filters: ((row: any) => boolean)[] = [];
  operation = "select"; values: any; one = false; ordering = ""; bounds = [0, Infinity];
  constructor(public db: MemoryDB, public table: string) {}
  select(_fields = "*") { return this; }
  eq(k: string, v: any) { this.filters.push(r => r[k] === v); return this; }
  neq(k: string, v: any) { this.filters.push(r => r[k] !== v); return this; }
  gt(k: string, v: any) { this.filters.push(r => r[k] > v); return this; }
  lt(k: string, v: any) { this.filters.push(r => r[k] < v); return this; }
  order(k: string) { this.ordering = k; return this; }
  range(a: number, b: number) { this.bounds = [a, b]; return this; }
  single() { this.one = true; return this; }
  maybeSingle() { this.one = true; return this; }
  update(values: any) { this.operation = "update"; this.values = values; return this; }
  insert(values: any) { this.operation = "insert"; this.values = values; return this; }
  upsert(values: any) { this.operation = "upsert"; this.values = values; return this; }
  delete() { this.operation = "delete"; return this; }
  then<T = any, U = never>(resolve?: ((value: any) => T | PromiseLike<T>) | null, reject?: ((reason: any) => U | PromiseLike<U>) | null): Promise<T | U> {
    try {
      const all = this.db.tables[this.table] ||= [];
      let rows = all.filter(r => this.filters.every(f => f(r)));
      if (["insert", "upsert"].includes(this.operation)) {
        const keys: Record<string, string> = {google_drive_files: "path_key", google_drive_folders: "path_key", google_drive_peers: "node_id"};
        const key = keys[this.table] || "id";
        rows = (Array.isArray(this.values) ? this.values : [this.values]).map((value: any) => {
          const old = this.operation === "upsert" ? all.find(r => r[key] === value[key]) : null;
          if (old) { Object.assign(old, copy(value)); return old; }
          const row = {revision: crypto.randomUUID(), ...copy(value)}; all.push(row); return row;
        });
      } else if (this.operation === "update") rows.forEach(r => Object.assign(r, copy(this.values)));
      else if (this.operation === "delete") this.db.tables[this.table] = all.filter(r => !rows.includes(r));
      if (this.ordering) rows.sort((a, b) => a[this.ordering].localeCompare(b[this.ordering]));
      rows = rows.slice(this.bounds[0], Math.min(this.bounds[1] + 1, this.bounds[0] + 1000));
      return Promise.resolve({data: copy(this.one ? rows[0] || null : rows), error: null}).then(resolve, reject);
    } catch (error) { return Promise.reject(error).then(resolve, reject); }
  }
}
export class GoogleMock {
  files = new Map<string, any>(); changes: any[] = []; uploads = new Map<string, any>();
  email = "clinic@example.test";
  constructor() { this.files.set("root", {id: "root", name: "Lumin Clinic", trashed: false, mimeType: "application/vnd.google-apps.folder", parents: []}); }
  async change(id: string, bytes?: Uint8Array, trashed = false) {
    const row = this.files.get(id); if (bytes) { row.bytes = bytes; row.size = bytes.length; row.sha256Checksum = await sha256(bytes); }
    row.trashed = trashed; this.changes.push({fileId: id, file: copy(row)});
  }
  fetch = async (input: RequestInfo | URL, options: RequestInit = {}) => {
    const url = new URL(String(input)), method = options.method || "GET";
    const json = (body: any, status = 200, headers: any = {}) => new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json", ...headers}});
    if (url.hostname === "oauth2.googleapis.com") return json({access_token: "private-google-access", refresh_token: "private-google-refresh"});
    if (url.hostname === "openidconnect.googleapis.com") return json({email: this.email, email_verified: true});
    if (url.pathname === "/drive/v3/changes/startPageToken") return json({startPageToken: String(this.changes.length)});
    if (url.pathname === "/drive/v3/changes") { const index = Number(url.searchParams.get("pageToken")); return json({changes: this.changes.slice(index), newStartPageToken: String(this.changes.length)}); }
    if (url.pathname === "/upload/drive/v3/files" && method === "POST") {
      const id = crypto.randomUUID(); this.uploads.set(id, JSON.parse(String(options.body)));
      return json({}, 200, {Location: "https://www.googleapis.com/test-upload/" + id});
    }
    if (url.pathname.startsWith("/test-upload/") && method === "PUT") {
      const id = url.pathname.split("/").at(-1)!;
      const bytes = options.body as Uint8Array;
      const row = {id, ...this.uploads.get(id), bytes: new Uint8Array(bytes), size: bytes.length, sha256Checksum: await sha256(bytes), trashed: false, modifiedTime: new Date().toISOString()};
      this.files.set(id, row); this.changes.push({fileId: id, file: copy(row)}); return json({id});
    }
    if (url.pathname === "/drive/v3/files" && method === "POST") {
      const id = crypto.randomUUID(), row = {id, ...JSON.parse(String(options.body)), trashed: false}; this.files.set(id, row); return json({id});
    }
    if (url.pathname.startsWith("/drive/v3/files/")) {
      const row = this.files.get(decodeURIComponent(url.pathname.split("/").at(-1)!));
      if (!row) return json({error: {message: "missing"}}, 404);
      if (method === "PATCH") {
        Object.assign(row, JSON.parse(String(options.body)));
        if (url.searchParams.has("addParents")) row.parents = [url.searchParams.get("addParents")];
        return json({id: row.id});
      }
      if (url.searchParams.get("alt") === "media") return new Response(row.bytes, {headers: {"Content-Type": row.mimeType}});
      const {bytes: _, ...info} = row; return json(info);
    }
    throw new Error("Unexpected Google request: " + url);
  };
}
export async function fixture() {
  const config: DriveConfig = {supabaseUrl: "https://project.supabase.test", clientId: "fixture-client", clientSecret: "private-client-secret", encryptionKey: "test-encryption-key-with-at-least-32-characters", appUrl: "https://lumin.test/", redirectUri: "https://project.supabase.test/functions/v1/google-drive/callback", rootName: "Lumin Clinic"};
  const db = new MemoryDB(), google = new GoogleMock();
  db.tables.user_profiles = [
    {user_id: ADMIN, active: true, access_roles: {is_admin: true}},
    {user_id: DOCTOR, active: true, access_roles: {is_admin: false, role_permissions: [{page_key: "patients", can_view: true}]}},
  ];
  db.tables.patients = [{id: PID, name: "أحمد علي", patient_number: 1042, phone: "01012345678"}];
  db.tables.google_drive_connection = [{id: 1, node_id: NODE, google_email: google.email, root_id: "root", root_name: config.rootName, change_token: "0", refresh_token_encrypted: await encrypt("private-google-refresh", config.encryptionKey), connected_by: ADMIN}];
  db.tables.google_drive_metadata = [{id: 1, snapshot: null, revision: crypto.randomUUID()}];
  const handler = createHandler(config, db, google.fetch);
  async function request(route: string, token = "admin", body?: any, method = "POST") {
    return handler(new Request(config.supabaseUrl + "/functions/v1/google-drive" + route, {method, headers: {Authorization: "Bearer " + token, ...(body instanceof FormData ? {} : {"Content-Type": "application/json"})}, ...(body === undefined ? {} : {body: body instanceof FormData ? body : JSON.stringify(body)})}));
  }
  async function upload(bytes = new TextEncoder().encode("xray"), category = "Periapical") {
    const form = new FormData(); form.set("patientId", PID); form.set("category", category); form.set("file", new File([bytes as BlobPart], "film.png"));
    const response = await request("/api/upload", "doctor", form);
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }
  return {config, db, google, handler, request, upload};
}
