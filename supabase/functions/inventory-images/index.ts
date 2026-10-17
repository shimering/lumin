import "jsr:@supabase/functions-js@2.117.3/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2.117.3";
import {DriveError, sha256, uuid} from "../google-drive/core.ts";
import {DriveStore, checked, type DriveConfig} from "../google-drive/store.ts";
import {DriveTokenCache} from "../google-drive/token_cache.ts";
import {PHOTO_LIMIT, photoFormat} from "./format.ts";

const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, x-client-info, content-type","Access-Control-Allow-Methods":"GET, POST, DELETE, OPTIONS"};
const headers = {...cors,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","Vary":"Authorization"};
const json = (body: unknown, status = 200) => Response.json(body,{status,headers});
const metadata = (row: any) => ({image_version:row?.revision || null,image_mime:row?.mime_type || null,image_width:row?.width || null,image_height:row?.height || null,image_bytes:row?.byte_size || null});
async function photoBytes(response: Response) {
  const reader=response.body?.getReader(),parts:Uint8Array[]=[];let length=0;
  if(!reader)throw new DriveError("Photo unavailable.",502,"image_changed");
  try { while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>PHOTO_LIMIT){await reader.cancel();throw new DriveError("Photo changed outside Lumin. Upload it again.",409,"image_changed");}parts.push(value);} }
  finally {reader.releaseLock();}
  const bytes=new Uint8Array(length);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}return bytes;
}

async function authorize(request: Request, db: any, write: boolean) {
  const bearer = request.headers.get("Authorization") || "";
  if (!bearer.startsWith("Bearer ")) throw new DriveError("Sign in to access inventory photos.",401,"invalid_session");
  const {data,error} = await db.auth.getUser(bearer.slice(7));
  if (error || !data?.user) throw new DriveError("Sign in again to access inventory photos.",401,"invalid_session");
  const profile = await checked(db.from("user_profiles").select("active, access_roles(is_admin, role_permissions(page_key, can_view))").eq("user_id",data.user.id).maybeSingle());
  const role = Array.isArray(profile?.access_roles) ? profile.access_roles[0] : profile?.access_roles;
  const has = (key: string) => role?.role_permissions?.some((p: any) => p.page_key === key && p.can_view === true);
  if (!profile?.active || !(role?.is_admin === true || has("inventory") && (!write || has("inventory_manage")))) throw new DriveError("Inventory access is required.",403,"access_denied");
  return data.user.id;
}
async function folder(store: DriveStore) {
  const connection = await store.connection(), saved = await checked(store.db.from("inventory_image_storage").select("*").eq("id",1).maybeSingle());
  if (saved?.drive_root_id === connection.root_id) return saved.drive_folder_id;
  const result = await store.google("/drive/v3/files?fields=id",{method:"POST",body:JSON.stringify({name:"Inventory",mimeType:"application/vnd.google-apps.folder",parents:[connection.root_id],appProperties:{luminScope:"inventory"}})});
  await store.commit(store.db.from("inventory_image_storage").upsert({id:1,drive_root_id:connection.root_id,drive_folder_id:result.id}));
  return result.id;
}
async function upload(store: DriveStore, parent: string, name: string, bytes: Uint8Array, mime: string) {
  const start = await store.google("/upload/drive/v3/files?uploadType=resumable&fields=id",{method:"POST",headers:{"X-Upload-Content-Type":mime,"X-Upload-Content-Length":String(bytes.length)},body:JSON.stringify({name,mimeType:mime,parents:[parent]})},true) as Response;
  const target = new URL(start.headers.get("Location") || "");
  if (target.protocol !== "https:" || target.hostname !== "www.googleapis.com") throw new DriveError("Invalid Google upload endpoint.",502);
  await store.guard();
  const response = await store.fetcher(target,{method:"PUT",headers:{Authorization:`Bearer ${await store.token()}`,"Content-Type":mime},body:bytes as BodyInit,signal:AbortSignal.timeout(45000)});
  if (!response.ok) throw new DriveError("Google Drive upload failed. Retry the photo.",502,"google_unavailable");
  const result = await response.json();if (!result.id) throw new DriveError("Google did not confirm the photo upload.",502);
  return result.id;
}
async function trash(store: DriveStore, id: string) { try { await store.google(`/drive/v3/files/${encodeURIComponent(id)}`,{method:"PATCH",body:JSON.stringify({trashed:true})}); } catch { /* The detached file remains private in Drive if cleanup is unavailable. */ } }

export function createInventoryImageHandler(config: DriveConfig, db: any, fetcher: typeof fetch = fetch) {
  const tokens = new DriveTokenCache();
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null,{status:204,headers:cors});
    try {
      if (!["GET","POST","DELETE"].includes(request.method)) throw new DriveError("Unsupported photo operation.",405);
      const url = new URL(request.url), id = uuid(url.pathname.replace(/^.*\/inventory-images\/?/,""));
      const actor = await authorize(request,db,request.method !== "GET");
      if (!await checked(db.from("inventory_items").select("id").eq("id",id).maybeSingle())) throw new DriveError("Inventory item not found.",404,"item_missing");
      const store = new DriveStore(db,config,fetcher,tokens);
      if (request.method === "GET") {
        const row = await checked(db.from("inventory_item_images").select("*").eq("item_id",id).maybeSingle());
        if (!row || url.searchParams.get("v") !== row.revision) throw new DriveError("This photo has changed. Refresh inventory.",404,"image_changed");
        const image = await store.google(`/drive/v3/files/${encodeURIComponent(row.drive_file_id)}?alt=media`,{},true) as Response;
        const bytes=await photoBytes(image);if(bytes.length!==row.byte_size||await sha256(bytes)!==row.sha256)throw new DriveError("Photo changed outside Lumin. Upload it again.",409,"image_changed");
        return new Response(bytes,{headers:{...headers,"Content-Type":row.mime_type,"Content-Length":String(row.byte_size),"Cache-Control":"private, max-age=300","ETag":`"${row.revision}"`}});
      }
      if (request.method === "DELETE") return await store.lock(async () => {
        const row = await checked(db.from("inventory_item_images").select("*").eq("item_id",id).maybeSingle());
        if (!row) return json(metadata(null));
        if (row.revision !== url.searchParams.get("v")) throw new DriveError("This photo changed. Reopen item details.",409,"image_changed");
        await store.commit(db.from("inventory_item_images").delete().eq("item_id",id).eq("revision",row.revision));
        await trash(store,row.drive_file_id);return json(metadata(null));
      });
      const maximum = PHOTO_LIMIT + 65536;
      if (Number(request.headers.get("Content-Length")) > maximum) throw new DriveError("Photo upload is too large.",413,"image_size");
      let received = 0;
      const bounded = request.body?.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){received+=chunk.byteLength;if(received>maximum)throw new DriveError("Photo upload is too large.",413,"image_size");controller.enqueue(chunk);}}));
      if (bounded) request = new Request(request,{body:bounded});
      const form = await request.formData(), file = form.get("image"), version = uuid(form.get("version")), expected = String(form.get("expected") || "");
      if (expected) uuid(expected);
      if (!(file instanceof File)) throw new DriveError("Choose an image.",400,"image_format");
      const bytes = new Uint8Array(await file.arrayBuffer()), format = photoFormat(bytes), checksum = await sha256(bytes);
      return await store.lock(async () => {
        const old = await checked(db.from("inventory_item_images").select("*").eq("item_id",id).maybeSingle());
        if (old?.revision === version) {
          if (old.sha256 !== checksum || old.updated_by !== actor) throw new DriveError("The upload identifier was reused.",409,"image_changed");
          return json(metadata(old));
        }
        if ((old?.revision || "") !== expected) throw new DriveError("This photo changed. Reopen item details.",409,"image_changed");
        const driveId = await upload(store,await folder(store),`item-${id}-${version}.${format.extension}`,bytes,format.mime);
        const row = {item_id:id,revision:version,drive_file_id:driveId,sha256:checksum,mime_type:format.mime,byte_size:bytes.length,width:format.width,height:format.height,updated_at:new Date().toISOString(),updated_by:actor};
        try {
          const saved = old ? await store.commit(db.from("inventory_item_images").update(row).eq("item_id",id).eq("revision",old.revision).select("item_id").maybeSingle()) : await store.commit(db.from("inventory_item_images").insert(row).select("item_id").single());
          if (!saved) throw new DriveError("This photo changed. Reopen item details.",409,"image_changed");
        } catch (error) { await trash(store,driveId);throw error; }
        if (old) await trash(store,old.drive_file_id);
        return json(metadata(row));
      });
    } catch (error) { return json({error:error instanceof DriveError?error.message:"The photo could not be saved. Retry shortly.",code:error instanceof DriveError?error.code:"image_error"},error instanceof DriveError?error.status:500); }
  };
}
if (import.meta.main) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const config: DriveConfig = {supabaseUrl,clientId:Deno.env.get("GOOGLE_DRIVE_CLIENT_ID") || "",clientSecret:Deno.env.get("GOOGLE_DRIVE_CLIENT_SECRET") || "",encryptionKey:Deno.env.get("GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY") || "",redirectUri:Deno.env.get("GOOGLE_DRIVE_REDIRECT_URI") || "",appUrl:Deno.env.get("GOOGLE_DRIVE_APP_URL") || Deno.env.get("CLINIC_APP_URL") || "",rootName:Deno.env.get("GOOGLE_DRIVE_ROOT_NAME") || "Lumin Clinic"};
  const db = createClient(supabaseUrl,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,options={})=>fetch(input,{...options,signal:options.signal||AbortSignal.timeout(15000)})}});
  Deno.serve(createInventoryImageHandler(config,db));
}
