import {photoFormat} from '../supabase/functions/inventory-images/format.ts';
import {sha256} from '../supabase/functions/google-drive/core.ts';

export async function inventoryImage(request,url,ctx) {
  const {bucket,auth,database,uuid,StorageError,json,headers}=ctx;
  const fail=(message,status=409,code='image_changed')=>{throw new StorageError(message,status,code);};
  const match=url.pathname.match(/^\/r2\/api\/inventory-images\/([^/]+)\/([^/]+)\.(webp|jpg)$/);
  if(!match)fail('Invalid inventory photo path.',400,'image_format');
  const id=uuid(match[1]),revision=uuid(match[2]),extension=match[3];
  const items=await database(auth.token,`/rest/v1/inventory_items?id=eq.${id}&deleted_at=is.null&select=id`);
  if(!items[0])fail('Inventory item not found.',404,'item_missing');
  const rows=await database(auth.token,`/rest/v1/inventory_item_images?item_id=eq.${id}&select=item_id,revision,mime_type,byte_size,width,height`),row=rows[0];
  const key=`Lumin Clinic/Inventory/item-${id}-${revision}.${extension}`,mime=extension==='webp'?'image/webp':'image/jpeg';
  if(['GET','HEAD'].includes(request.method)) {
    if(row?.revision!==revision||row.mime_type!==mime)fail('This photo has changed. Refresh inventory.',404);
    const object=await bucket.get(key);if(!object)fail('Inventory photo is not on R2 yet.',404,'image_missing');
    const bytes=new Uint8Array(await object.arrayBuffer());
    let format;try{format=photoFormat(bytes);}catch(_){fail('The stored inventory photo changed. Restore its original.');}
    if(bytes.length!==row.byte_size||format.mime!==row.mime_type||format.width!==row.width||format.height!==row.height)fail('The stored inventory photo changed. Restore its original.');
    return new Response(request.method==='HEAD'?null:bytes,{headers:{...headers,'Content-Type':mime,'Content-Length':String(bytes.length),'ETag':`"${revision}"`}});
  }
  if(!auth.manageInventory)fail('Inventory management access is required.',403,'access_denied');
  if(request.method==='POST') {
    const bytes=new Uint8Array(await request.arrayBuffer());
    let format;try{format=photoFormat(bytes);}catch(error){fail(error.message,error.status,error.code);}
    if(format.mime!==mime)fail('The image format does not match its filename.',400,'image_format');
    const digest=await sha256(bytes),existing=await bucket.get(key);
    if(existing&&await sha256(new Uint8Array(await existing.arrayBuffer()))!==digest)fail('A different inventory photo already exists at this path. Both originals were preserved.');
    if(!existing) {
      const saved=await bucket.put(key,bytes,{httpMetadata:{contentType:mime},customMetadata:{sha256:digest,inventoryRevision:revision},onlyIf:{etagDoesNotMatch:'*'}});
      if(!saved)fail('This inventory photo changed. Retry the operation.');
    }
    return json({success:true,key,sha256:digest,size:bytes.length});
  }
  if(request.method==='DELETE') {
    if(row?.revision===revision)fail('A current inventory photo must be detached before archiving.');
    const object=await bucket.get(key);
    if(object) {
      const bytes=new Uint8Array(await object.arrayBuffer()),digest=await sha256(bytes),root=`_recovery/inventory-${crypto.randomUUID()}`;
      await bucket.put(root+'/original',bytes,{httpMetadata:object.httpMetadata,customMetadata:{sha256:digest}});
      await bucket.put(root+'/details.json',JSON.stringify({sourceKey:key,sha256:digest,archivedAt:new Date().toISOString()}),{httpMetadata:{contentType:'application/json'}});
      const saved=await bucket.get(root+'/original');
      if(!saved||await sha256(new Uint8Array(await saved.arrayBuffer()))!==digest)fail('The inventory original could not be preserved.');
      if((await bucket.head(key))?.etag!==object.etag)fail('The inventory photo changed during archiving.');
      await bucket.delete(key);
    }
    return json({success:true});
  }
  fail('Unsupported inventory photo operation.',405,'unsupported_operation');
}
