// Private R2 storage. Every request uses the caller's Supabase session and RLS.
import '../lumin-public-config.js';
import {cloudSync} from './r2-cloud-sync.mjs';
import {readableKey,mediaObject,mediaRows,patientFolder} from './r2-layout.mjs';
import {caseFold} from '../supabase/functions/google-drive/core.ts';

const config = globalThis.LuminPublicConfig;
export const MAX_UPLOAD = 64 * 1024 * 1024;
const categories = new Set(['Panoramic', 'Periapical', 'Intraoral', 'Facial', 'Lab', 'General', '3D-Scans']);
const types = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',bmp:'image/bmp',tif:'image/tiff',tiff:'image/tiff',avif:'image/avif',pdf:'application/pdf',dcm:'application/dicom',dicom:'application/dicom',zip:'application/zip'};
const privateHeaders = {'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow, noarchive'};
class StorageError extends Error {
  constructor(message, status = 400, code = 'storage_error') { super(message); this.status = status; this.code = code; }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers:{...privateHeaders,'Content-Type':'application/json; charset=utf-8'}});
const uuid = value => {
  if (typeof value !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)) throw new StorageError('Invalid patient identifier.');
  return value.toLowerCase();
};
function safePath(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\\\x00-\x1f<>:"|?*]/.test(value)) throw new StorageError('Invalid patient file path.');
  const parts = value.split('/');
  if (![3,4].includes(parts.length) || parts.some(p => !p || p.startsWith('.') || /[ .]$/.test(p)) || !categories.has(parts[1]) || !types[parts.at(-1).split('.').at(-1).toLowerCase()]) throw new StorageError('Invalid patient file path.');
  uuid(parts[0]);
  if (parts.length === 4 && (parts[1] !== '3D-Scans' || !/^[a-f\d]{32}$/i.test(parts[2]))) throw new StorageError('Invalid scan file path.');
  if ((parts[1] === '3D-Scans') !== /\.zip$/i.test(value)) throw new StorageError('ZIP files must use the 3D-Scans category.');
  return value;
}
const dataKey = (bucket,path,patient,hint) => readableKey(bucket,safePath(path),patient,hint);
const getMedia = (bucket,path,patient,options,hint) => mediaObject(bucket,safePath(path),patient,options,hint);
const listMedia = async (bucket,patientId) => (await mediaRows(bucket,records,patientId)).filter(row=>{try{safePath(row.relativePath);return true;}catch(_){return false;}});
const metaKey = path => `metadata/${safePath(path)}.json`;
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(v=>v.toString(16).padStart(2,'0')).join('');
async function boundedJson(request) {
  const text = await request.text();
  if (text.length > 256 * 1024) throw new StorageError('Clinical details are too large.',413);
  try { return JSON.parse(text); } catch (_) { throw new StorageError('Invalid JSON.'); }
}
function detailsFor(path, patient, incoming = {}, previous = {}) {
  const text = (value, max) => {
    if (value == null) return '';
    if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new StorageError('Invalid clinical details.');
    return value;
  };
  const fields = {...previous,...incoming};
  const teeth = fields.tooth_ids ?? (fields.tooth_id ? [fields.tooth_id] : []);
  if (!Array.isArray(teeth) || teeth.length > 52 || teeth.some(t=>!/^(?:[1-9]|[12]\d|3[0-2]|[A-T])$/.test(String(t)))) throw new StorageError('Invalid tooth assignments.');
  const toothIds = [...new Set(teeth.map(String))];
  const date = text(fields.scan_date,10);
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date)) throw new StorageError('Invalid scan date.');
  const scan = fields.scan_config ?? null;
  if (scan !== null && (typeof scan !== 'object' || Array.isArray(scan) || JSON.stringify(scan).length > 131072)) throw new StorageError('Invalid scan settings.');
  return {patient_id:patient.id,patient_name:patient.name || '',patient_number:String(patient.patient_number || ''),relative_path:path,display_name:text(fields.display_name,2048),note:text(fields.note,65536),tooth_id:toothIds[0] || null,tooth_ids:toothIds,scan_date:date || null,scan_config:scan,metadata_available:true,updated_at:new Date().toISOString()};
}
async function records(bucket,prefix,include) {
  const objects = []; let cursor;
  do {
    const page = await bucket.list({prefix,limit:1000,...(cursor?{cursor}:{}),...(include?{include}: {})});
    objects.push(...page.objects); cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}
async function database(token, path, fetcher) {
  const response = await fetcher(config.supabaseUrl + path,{headers:{apikey:config.supabaseAnonKey,Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000),cache:'no-store'});
  if (!response.ok) throw new StorageError(response.status === 401 ? 'Sign in again to access storage.' : 'Could not verify clinic access.',response.status === 401 ? 401 : 503);
  return response.json();
}
async function caller(request,url,bucket,fetcher,mediaRead) {
  let token = request.headers.get('Authorization')?.replace(/^Bearer /,'') || request.headers.get('x-lumin-key') || '';
  if (!token && mediaRead) {
    const grant = url.searchParams.get('media') || '';
    if (!/^[a-f\d]{64}$/.test(grant)) throw new StorageError('Storage authorization has expired.',401);
    const record = await bucket.get(`_sessions/${await hash(grant)}.json`);
    const saved = record && await record.json();
    if (!saved || saved.expiresAt <= Date.now()) throw new StorageError('Storage authorization has expired.',401);
    token = saved.token;
  }
  if (!token || token.length > 8192) throw new StorageError('Sign in to access storage.',401);
  const user = await database(token,'/auth/v1/user',fetcher);
  if (!user?.id) throw new StorageError('Sign in again to access storage.',401);
  const profiles = await database(token,`/rest/v1/user_profiles?user_id=eq.${uuid(user.id)}&select=active,access_roles(is_admin,role_permissions(page_key,can_view))`,fetcher);
  const profile = profiles[0], role = Array.isArray(profile?.access_roles) ? profile.access_roles[0] : profile?.access_roles;
  if (!profile?.active || !(role?.is_admin === true || role?.role_permissions?.some(p=>p.page_key === 'patients' && p.can_view === true))) throw new StorageError('You do not have permission to access patient storage.',403);
  return {token,userId:user.id,admin:role?.is_admin === true};
}
async function patientFor(token,id,fetcher) {
  const patients = await database(token,`/rest/v1/patients?id=eq.${uuid(id)}&select=id,name,patient_number`,fetcher);
  if (!patients[0]) throw new StorageError('Patient not found.',404);
  return patients[0];
}
async function metadata(bucket,path) {
  const object = await bucket.get(metaKey(path));
  if (!object) throw new StorageError('Clinical details are unavailable. Retry the upload.',409,'metadata_unavailable');
  return {object,details:await object.json()};
}
async function putDetails(bucket,path,details,etag) {
  const result = await bucket.put(metaKey(path),JSON.stringify(details),{httpMetadata:{contentType:'application/json'},customMetadata:{toothIds:JSON.stringify(details.tooth_ids || [])},onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'}});
  if (!result) throw new StorageError('This file changed. Reload it before saving.',409,'file_changed');
}
async function route(request,url,bucket,fetcher) {
  const path = url.pathname.slice('/r2'.length);
  const download = path.match(/^\/(files|api\/thumbnail)\/(.+)$/);
  const auth = await caller(request,url,bucket,fetcher,Boolean(download && ['GET','HEAD'].includes(request.method)));
  if (path.startsWith('/api/cloud-sync/')) {
    const result = await cloudSync(path.slice('/api/cloud-sync/'.length),request,url,{bucket,auth,fetcher,helpers:{StorageError,safePath,detailsFor,patientFor,metadata,putDetails,records,types,database,dataKey,getMedia,listMedia}});
    return result instanceof Response ? result : json(result);
  }
  if (path === '/api/self-test' && request.method === 'POST') {
    if (!auth.admin) throw new StorageError('Administrator access is required.',403);
    const key = `_checks/${crypto.randomUUID()}.txt`, value = 'Lumin R2 connection test';
    try {
      await bucket.put(key,value,{httpMetadata:{contentType:'text/plain'}});
      const object = await bucket.get(key);
      if (!object || await object.text() !== value) throw new StorageError('R2 file verification failed.',503);
    } finally { await bucket.delete(key); }
    return json({success:true,verified:['write','read','delete']});
  }
  if (path === '/api/media-grant' && request.method === 'POST') {
    const grant = crypto.randomUUID().replaceAll('-','') + crypto.randomUUID().replaceAll('-','');
    // Keep browser URL grants short-lived and read-only; the session JWT stays server-side.
    const payload = JSON.parse(atob(auth.token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
    const expiresAt = Math.min(Date.now() + 15 * 60000, Number(payload.exp) * 1000);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new StorageError('Sign in again.',401);
    await bucket.put(`_sessions/${await hash(grant)}.json`,JSON.stringify({token:auth.token,userId:auth.userId,expiresAt}),{httpMetadata:{contentType:'application/json'}});
    // Bounded cleanup; expired grants are rejected even before they are removed.
    const expired = await bucket.list({prefix:'_sessions/',limit:100});
    await Promise.all(expired.objects.filter(o=>o.uploaded.getTime() < Date.now()-15*60000).map(o=>bucket.delete(o.key)));
    return json({mediaGrant:grant,expiresAt});
  }
  if (path === '/api/media-grant/revoke' && request.method === 'POST') {
    const body = await boundedJson(request);
    if (/^[a-f\d]{64}$/.test(body.mediaGrant || '')) {
      const key = `_sessions/${await hash(body.mediaGrant)}.json`, record = await bucket.get(key);
      if (record && (await record.json()).userId === auth.userId) await bucket.delete(key);
    }
    return json({success:true});
  }
  if (path === '/api/health' && request.method === 'GET') {
    const rows = await listMedia(bucket);
    return json({status:'online',service:'Lumin Cloudflare R2 Storage',storageRoot:'Lumin Clinic',totalPatientFolders:new Set(rows.map(row=>row.relativePath.split('/')[0])).size,maxFileSizeMB:MAX_UPLOAD/1048576,capabilities:{patient3dScans:true,scanOriginalFilenames:true,localMediaMetadata:true,syncClinicalMetadata:true}});
  }
  if (path === '/api/xray-index' && request.method === 'GET') {
    const rows = await records(bucket,'metadata/',['customMetadata']), countsByPatient = {};
    const existingPaths=new Set((await listMedia(bucket)).map(row=>caseFold(row.relativePath)));
    const patients = [];
    for (let offset=0;;offset+=1000) {
      const page = await database(auth.token,`/rest/v1/patients?select=id&limit=1000&offset=${offset}`,fetcher);
      patients.push(...page); if (page.length < 1000) break;
    }
    const allowed = new Set(patients.map(p=>p.id));
    for (const row of rows) {
      const parts = row.key.slice(9,-5).split('/');
      if (!existingPaths.has(caseFold(row.key.slice(9,-5))) || !['Panoramic','Periapical'].includes(parts[1]) || !/\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(parts.at(-1)) || !allowed.has(parts[0])) continue;
      const counts = countsByPatient[parts[0]] ||= {};
      for (const tooth of JSON.parse(row.customMetadata?.toothIds || '[]')) counts[tooth] = (counts[tooth] || 0) + 1;
    }
    return json({metadataSource:'r2',countsByPatient});
  }
  const listing = path.match(/^\/api\/patient\/([^/]+)\/files$/);
  if (listing && request.method === 'GET') {
    const patient = await patientFor(auth.token,listing[1],fetcher), rows = await listMedia(bucket,patient.id);
    const files = []; let unavailable = false;
    for (let offset=0;offset<rows.length;offset+=20) await Promise.all(rows.slice(offset,offset+20).map(async row=>{
      const relativePath = row.key.slice(9), parts = relativePath.split('/'); let details;
      try { details = (await metadata(bucket,relativePath)).details; }
      catch (error) { if (error.code !== 'metadata_unavailable') throw error; unavailable = true; }
      files.push({filename:parts.at(-1),category:parts[1],patientFolder:patient.id,relativePath,sizeBytes:row.size,modifiedAt:row.uploaded.toISOString(),mediaDetails:details && {...details,patient_name:patient.name,patient_number:String(patient.patient_number || '')}});
    }));
    files.sort((a,b)=>b.modifiedAt.localeCompare(a.modifiedAt));
    return json({patientId:patient.id,total:files.length,files,metadataSource:'r2',metadataUnavailable:unavailable});
  }
  if (path === '/api/upload' && request.method === 'POST') {
    const form = await request.formData(), file = form.get('file') ?? form.get('image');
    if (!(file instanceof File)) throw new StorageError('Choose a file before uploading.',400,'missing_file');
    if (file.size < 1 || file.size > MAX_UPLOAD) throw new StorageError('Files must be between 1 byte and 64 MB.',413,'file_too_large');
    const patient = await patientFor(auth.token,String(form.get('patientId') || form.get('patient_id') || ''),fetcher);
    const category = String(form.get('category') || 'General');
    if (!categories.has(category)) throw new StorageError('Choose a valid category.');
    const name = file.name.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/^[ .]+|[ .]+$/g,'').slice(-180);
    const scan = category === '3D-Scans';
    const unique = scan ? `${uuid(String(form.get('scanUploadId') || crypto.randomUUID())).replaceAll('-','')}/${name}` : `${new Date().toISOString().slice(0,10)}_${crypto.randomUUID()}_${name}`;
    const relativePath = safePath(`${patient.id}/${category}/${unique}`), mime = types[name.split('.').at(-1).toLowerCase()];
    const details = detailsFor(relativePath,patient,{display_name:file.name.slice(0,2048),note:String(form.get('note') || '')});
    const key = await dataKey(bucket,relativePath,patient);
    const result = await bucket.put(key,file.stream(),{httpMetadata:{contentType:mime},onlyIf:{etagDoesNotMatch:'*'}});
    if (!result) throw new StorageError('This upload identifier is already in use.',409,'file_exists');
    try { await putDetails(bucket,relativePath,details); }
    catch (error) { await bucket.delete(key); throw error; }
    return json({success:true,relativePath,filename:name,category,patientFolder:patient.id,sizeBytes:file.size});
  }
  const detailRoute = path.match(/^\/api\/patient\/([^/]+)\/media-details$/);
  if (detailRoute && request.method === 'POST') {
    const patient = await patientFor(auth.token,detailRoute[1],fetcher), body = await boundedJson(request), relativePath = safePath(body.relativePath);
    if (relativePath.split('/')[0] !== patient.id) throw new StorageError('Patient identity does not match media.',409);
    if (!await getMedia(bucket,relativePath,patient)) throw new StorageError('Patient file not found.',404);
    const old = await metadata(bucket,relativePath), details = detailsFor(relativePath,patient,body.details,old.details);
    await putDetails(bucket,relativePath,details,old.object.etag);
    return json({success:true,metadataSource:'r2',details});
  }
  const rename = path.match(/^\/api\/patient\/([^/]+)\/rename$/);
  if (rename && request.method === 'POST') {
    const patient = await patientFor(auth.token,rename[1],fetcher);
    const folder = await patientFolder(bucket,patient);
    return json({success:true,patientFolder:folder.folder}); // Logical IDs keep existing links stable.
  }
  if (download && ['GET','HEAD'].includes(request.method)) {
    const relativePath = safePath(decodeURIComponent(download[2]));
    const patient = await patientFor(auth.token,relativePath.split('/')[0],fetcher);
    const requestedRange = request.headers.get('Range');
    if (requestedRange && !/^bytes=(?:\d+-\d*|-\d+)$/.test(requestedRange)) throw new StorageError('Invalid byte range.',416);
    const object = await getMedia(bucket,relativePath,patient,requestedRange ? {range:request.headers} : {});
    if (!object) throw new StorageError('Patient file not found.',404);
    const headers = new Headers(privateHeaders); object.writeHttpMetadata(headers);
    headers.set('ETag',object.httpEtag); headers.set('Accept-Ranges','bytes');
    headers.set('Content-Security-Policy',"default-src 'none'; sandbox");
    headers.set('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(relativePath.split('/').at(-1)).replace(/'/g,'%27')}`);
    const range = requestedRange ? object.range : null;
    if (range) { headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${object.size}`); headers.set('Content-Length',String(range.length)); }
    else headers.set('Content-Length',String(object.size));
    return new Response(request.method === 'HEAD' ? null : object.body,{status:range?206:200,headers});
  }
  if (path === '/api/file' && request.method === 'DELETE') {
    const body = await boundedJson(request), relativePath = safePath(body.relativePath || body.path);
    const patient = await patientFor(auth.token,relativePath.split('/')[0],fetcher),object = await getMedia(bucket,relativePath,patient);
    if(object)await bucket.delete(object.key);await bucket.delete(metaKey(relativePath));
    return json({success:true});
  }
  if (path === '/api/file/move' && request.method === 'POST') {
    const body = await boundedJson(request), source = safePath(body.relativePath || body.path), parts = source.split('/'), category = body.targetCategory || body.category;
    if (!categories.has(category) || category === '3D-Scans' || parts[1] === '3D-Scans') throw new StorageError('Choose a valid image category.');
    const patient = await patientFor(auth.token,parts[0],fetcher); parts[1] = category;
    const target = safePath(parts.join('/'));
    if (source === target) return json({success:true,newRelativePath:target,newCategory:category});
    const object = await getMedia(bucket,source,patient); if (!object) throw new StorageError('Patient file not found.',404);
    const old = await metadata(bucket,source), details = detailsFor(target,patient,{},old.details);
    if (await getMedia(bucket,target,patient) || await bucket.head(metaKey(target))) throw new StorageError('A file already exists in this category.',409);
    const targetKey = await dataKey(bucket,target,patient);
    const result = await bucket.put(targetKey,object.body,{httpMetadata:object.httpMetadata,customMetadata:object.customMetadata,onlyIf:{etagDoesNotMatch:'*'}});
    if (!result) throw new StorageError('A file already exists in this category.',409);
    try { await putDetails(bucket,target,details); }
    catch (error) { await bucket.delete(targetKey); throw error; }
    await bucket.delete(object.key); await bucket.delete(metaKey(source));
    return json({success:true,oldRelativePath:source,newRelativePath:target,newCategory:category});
  }
  throw new StorageError('This operation is not available for R2.',404,'unsupported_operation');
}
export async function handleR2Request(request,env,fetcher=fetch) {
  try {
    const url = new URL(request.url), origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) throw new StorageError('Use the clinic application to access storage.',403);
    if (!env.LUMIN_MEDIA) throw new StorageError('R2 storage is not configured.',503,'not_configured');
    if (request.method === 'OPTIONS') return new Response(null,{status:204,headers:privateHeaders});
    if (request.body) {
      const maximum = url.pathname === '/r2/api/upload' ? MAX_UPLOAD+1048576 : 256*1024;
      if (Number(request.headers.get('Content-Length')) > maximum) throw new StorageError('Request exceeds the storage limit.',413,'file_too_large');
      let received=0;
      const body = request.body.pipeThrough(new TransformStream({transform(chunk,controller) {
        received+=chunk.byteLength; if (received>maximum) throw new StorageError('Request exceeds the storage limit.',413,'file_too_large'); controller.enqueue(chunk);
      }}));
      request = new Request(request,{body,duplex:'half'});
    }
    return await route(request,url,env.LUMIN_MEDIA,fetcher);
  } catch (error) {
    if (error instanceof StorageError) return json({error:error.message,code:error.code},error.status);
    return json({error:'Storage could not complete the request. Please retry.',code:'storage_unavailable'},503);
  }
}
