import "jsr:@supabase/functions-js@2.117.3/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2.117.3";
import {DriveError, sha256, uuid} from "../google-drive/core.ts";
import {DriveStore, checked, type DriveConfig} from "../google-drive/store.ts";
import {DriveTokenCache} from "../google-drive/token_cache.ts";
import {PHOTO_LIMIT, photoFormat} from "./format.ts";
import {usesR2,r2,readPhoto,imageKey,uploadDrive,discard,syncPhoto} from "./storage.ts";

const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, x-client-info, content-type","Access-Control-Allow-Methods":"GET, POST, DELETE, OPTIONS"};
const headers = {...cors,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","Vary":"Authorization"};
const json = (body: unknown, status = 200) => Response.json(body,{status,headers});
const metadata = (row: any) => ({image_version:row?.revision || null,image_mime:row?.mime_type || null,image_width:row?.width || null,image_height:row?.height || null,image_bytes:row?.byte_size || null});

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

export function createInventoryImageHandler(config: DriveConfig, db: any, fetcher: typeof fetch = fetch) {
  const tokens = new DriveTokenCache();
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null,{status:204,headers:cors});
    try {
      if (!["GET","POST","DELETE"].includes(request.method)) throw new DriveError("Unsupported photo operation.",405);
      const url = new URL(request.url),sync=url.pathname.endsWith('/sync'),id = uuid(url.pathname.replace(/^.*\/inventory-images\/?/,"").replace(/\/sync$/,''));
      const actor = await authorize(request,db,request.method !== "GET");
      if (!await checked(db.from("inventory_items").select("id").eq("id",id).is("deleted_at",null).maybeSingle())) throw new DriveError("Inventory item not found.",404,"item_missing");
      const store = new DriveStore(db,config,fetcher,tokens);
      if(sync) {
        if(request.method!=='POST')throw new DriveError('Unsupported inventory sync operation.',405);
        return await store.lock(async()=>{
          const row=await checked(db.from('inventory_item_images').select('*').eq('item_id',id).maybeSingle());
          if(!row||url.searchParams.get('v')!==row.revision)throw new DriveError('This photo changed. Refresh inventory.',409,'image_changed');
          return json(await syncPhoto(store,request,row));
        });
      }
      if (request.method === "GET") {
        const row = await checked(db.from("inventory_item_images").select("*").eq("item_id",id).maybeSingle());
        if (!row || url.searchParams.get("v") !== row.revision) throw new DriveError("This photo has changed. Refresh inventory.",404,"image_changed");
        const bytes=await readPhoto(store,request,row,await usesR2(store));
        return new Response(bytes,{headers:{...headers,"Content-Type":row.mime_type,"Content-Length":String(row.byte_size),"Cache-Control":"private, max-age=300","ETag":`"${row.revision}"`}});
      }
      if (request.method === "DELETE") return await store.lock(async () => {
        const row = await checked(db.from("inventory_item_images").select("*").eq("item_id",id).maybeSingle());
        if (!row) return json(metadata(null));
        if (row.revision !== url.searchParams.get("v")) throw new DriveError("This photo changed. Reopen item details.",409,"image_changed");
        await store.commit(db.from("inventory_item_images").delete().eq("item_id",id).eq("revision",row.revision));
        await discard(store,request,row);return json(metadata(null));
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
        const onR2=await usesR2(store);
        const driveId=onR2?null:await uploadDrive(store,id,version,format.mime,bytes);
        const r2Key=onR2?imageKey(id,version,format.mime):null;
        if(onR2)await r2(store,request,id,version,format.mime,'POST',bytes);
        const row = {item_id:id,revision:version,drive_file_id:driveId,r2_key:r2Key,sha256:checksum,mime_type:format.mime,byte_size:bytes.length,width:format.width,height:format.height,updated_at:new Date().toISOString(),updated_by:actor};
        try {
          const saved = old ? await store.commit(db.from("inventory_item_images").update(row).eq("item_id",id).eq("revision",old.revision).select("item_id").maybeSingle()) : await store.commit(db.from("inventory_item_images").insert(row).select("item_id").single());
          if (!saved) throw new DriveError("This photo changed. Reopen item details.",409,"image_changed");
        } catch (error) { await discard(store,request,row);throw error; }
        if (old) await discard(store,request,old);
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
