import {DriveError,sha256} from "../google-drive/core.ts";
import {checked,type DriveStore} from "../google-drive/store.ts";
import {PHOTO_LIMIT} from "./format.ts";

export const imageKey=(id:string,revision:string,mime:string)=>`Lumin Clinic/Inventory/item-${id}-${revision}.${mime==='image/webp'?'webp':'jpg'}`;
export async function usesR2(store:DriveStore) {
  const settings=await checked(store.db.from('clinic_settings').select('storage_server_url').eq('id',1).maybeSingle());
  return settings?.storage_server_url?.replace(/\/+$/,'')===new URL('/r2',store.config.appUrl).href;
}
export async function r2(store:DriveStore,request:Request,id:string,revision:string,mime:string,method='GET',bytes?:Uint8Array) {
  const target=new URL(`/r2/api/inventory-images/${id}/${revision}.${mime==='image/webp'?'webp':'jpg'}`,store.config.appUrl);
  if(target.protocol!=='https:'&&!target.hostname.endsWith('.test'))throw new DriveError('The R2 application URL is not configured.',503,'not_configured');
  const response=await store.fetcher(target,{method,headers:{Authorization:request.headers.get('Authorization')||'','Content-Type':mime},...(bytes?{body:bytes as BodyInit}:{}),signal:AbortSignal.timeout(45000)});
  if(!response.ok){const result=await response.json().catch(()=>({}));throw new DriveError(result.error||'R2 could not complete the inventory photo operation.',response.status,result.code||'r2_unavailable');}
  return response;
}
export async function photoBytes(response:Response) {
  const reader=response.body?.getReader(),parts:Uint8Array[]=[];let length=0;
  if(!reader)throw new DriveError('Photo unavailable.',502,'image_changed');
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>PHOTO_LIMIT){await reader.cancel();throw new DriveError('Photo changed outside Lumin. Upload it again.',409,'image_changed');}parts.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}return bytes;
}
export async function readPhoto(store:DriveStore,request:Request,row:any,preferR2:boolean) {
  const response=row.r2_key&&(preferR2||!row.drive_file_id)?await r2(store,request,row.item_id,row.revision,row.mime_type):await store.google(`/drive/v3/files/${encodeURIComponent(row.drive_file_id)}?alt=media`,{},true) as Response;
  const bytes=await photoBytes(response);
  if(bytes.length!==row.byte_size||await sha256(bytes)!==row.sha256)throw new DriveError('Photo changed outside Lumin. Restore its original.',409,'image_changed');
  return bytes;
}
async function folder(store:DriveStore) {
  const connection=await store.connection(),saved=await checked(store.db.from('inventory_image_storage').select('*').eq('id',1).maybeSingle());
  if(saved?.drive_root_id===connection.root_id)return saved.drive_folder_id;
  const result=await store.google('/drive/v3/files?fields=id',{method:'POST',body:JSON.stringify({name:'Inventory',mimeType:'application/vnd.google-apps.folder',parents:[connection.root_id],appProperties:{luminScope:'inventory'}})});
  await store.commit(store.db.from('inventory_image_storage').upsert({id:1,drive_root_id:connection.root_id,drive_folder_id:result.id}));return result.id;
}
export async function uploadDrive(store:DriveStore,id:string,revision:string,mime:string,bytes:Uint8Array) {
  const name=imageKey(id,revision,mime).split('/').at(-1),parent=await folder(store);
  const start=await store.google('/upload/drive/v3/files?uploadType=resumable&fields=id',{method:'POST',headers:{'X-Upload-Content-Type':mime,'X-Upload-Content-Length':String(bytes.length)},body:JSON.stringify({name,mimeType:mime,parents:[parent]})},true) as Response;
  const target=new URL(start.headers.get('Location')||'');
  if(target.protocol!=='https:'||target.hostname!=='www.googleapis.com')throw new DriveError('Invalid Google upload endpoint.',502);
  await store.guard();
  const response=await store.fetcher(target,{method:'PUT',headers:{Authorization:`Bearer ${await store.token()}`,'Content-Type':mime},body:bytes as BodyInit,signal:AbortSignal.timeout(45000)});
  if(!response.ok)throw new DriveError('Google Drive upload failed. Retry the photo.',502,'google_unavailable');
  const result=await response.json();if(!result.id)throw new DriveError('Google did not confirm the photo upload.',502);return result.id;
}
export async function discard(store:DriveStore,request:Request,row:any) {
  if(row.drive_file_id)try{await store.google(`/drive/v3/files/${encodeURIComponent(row.drive_file_id)}`,{method:'PATCH',body:JSON.stringify({trashed:true})});}catch{/* Detached originals stay private if cleanup is unavailable. */}
  if(row.r2_key)try{await r2(store,request,row.item_id,row.revision,row.mime_type,'DELETE');}catch{/* R2 also refuses to archive any still-current revision. */}
}
export async function syncPhoto(store:DriveStore,request:Request,row:any) {
  let bytes:number=0;
  if(!row.r2_key) {
    const original=await readPhoto(store,request,row,false);
    await r2(store,request,row.item_id,row.revision,row.mime_type,'POST',original);
    const next={...row,r2_key:imageKey(row.item_id,row.revision,row.mime_type)};
    await readPhoto(store,request,next,true);bytes+=original.length;
    const saved=await store.commit(store.db.from('inventory_item_images').update({r2_key:next.r2_key}).eq('item_id',row.item_id).eq('revision',row.revision).select('item_id').maybeSingle());
    if(!saved)throw new DriveError('This photo changed during synchronization.',409,'image_changed');row=next;
  }else await readPhoto(store,request,row,true);
  if(!row.drive_file_id) {
    const original=await readPhoto(store,request,row,true),driveId=await uploadDrive(store,row.item_id,row.revision,row.mime_type,original),next={...row,drive_file_id:driveId};
    try{
      await readPhoto(store,request,next,false);
      const saved=await store.commit(store.db.from('inventory_item_images').update({drive_file_id:driveId}).eq('item_id',row.item_id).eq('revision',row.revision).select('item_id').maybeSingle());
      if(!saved)throw new DriveError('This photo changed during synchronization.',409,'image_changed');
    }catch(error){await discard(store,request,{...next,r2_key:null});throw error;}bytes+=original.length;
  }else await readPhoto(store,request,row,false);
  return {success:true,transferredBytes:bytes,revision:row.revision};
}
