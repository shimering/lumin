import {fixture,ADMIN,DOCTOR,PID} from "../google-drive/test_fixture.ts";
import {createInventoryImageHandler} from "./index.ts";
import {photoFormat,PHOTO_LIMIT} from "./format.ts";
function assert(value:unknown,message="Assertion failed"){if(!value)throw Error(message);}
// A real browser-encoded 40 x 30 WebP, with its lossless colour-profile chunk removed.
const image=Uint8Array.from(atob("UklGRjQAAABXRUJQVlA4ICgAAADwAgCdASooAB4APm02l0ikIyIhJWgAgA2JaQAAKUNt8AD++5zAAAAAAA=="),c=>c.charCodeAt(0)).slice(0,60);
async function setup(){
  const f=await fixture();f.db.tables.inventory_items=[{id:PID,quantity:3,revision:7}];
  const handle=createInventoryImageHandler(f.config,f.db,f.google.fetch);
  const request=(method:string,token="admin",version="",file:Uint8Array=image,expected="",requestId=crypto.randomUUID())=>{
    const form=new FormData();form.set("image",new File([file as BlobPart],"photo.webp",{type:"image/webp"}));form.set("version",requestId);form.set("expected",expected);
    return handle(new Request(`${f.config.supabaseUrl}/functions/v1/inventory-images/${PID}?v=${version}`,{method,headers:token?{Authorization:`Bearer ${token}`}:{},...(method==='POST'?{body:form}:{})}));
  };return {...f,request};
}
Deno.test("inventory photos are private, revision checked, retry safe and separate from patient sync and stock",async()=>{
  const f=await setup(),requestId=crypto.randomUUID();
  assert(photoFormat(image).width===40&&photoFormat(image).height===30);
  const post=await f.request('POST','admin','',image,'',requestId);assert(post.status===200,await post.clone().text());const first=await post.json();
  assert(first.image_version===requestId&&first.image_bytes===image.length);
  assert(!JSON.stringify(first).includes('drive_file_id')&&!JSON.stringify(first).includes('token'));
  const row={...f.db.tables.inventory_item_images[0]},folder=f.db.tables.inventory_image_storage[0],googlePhoto=f.google.files.get(row.drive_file_id);
  assert(f.google.files.get(folder.drive_folder_id).name==='Inventory');assert(googlePhoto.parents[0]===folder.drive_folder_id);
  assert(!googlePhoto.permissions&&!f.db.tables.google_drive_files?.length&&!f.db.tables.google_drive_folders?.length);
  const snapshot=JSON.stringify(f.db.tables.google_drive_metadata),files=f.google.files.size;
  assert((await f.request('POST','admin','',image,'',requestId)).status===200);assert(f.google.files.size===files,'Lost reply does not upload twice');
  assert((await f.request('GET','',requestId)).status===401);assert((await f.request('GET','doctor',requestId)).status===403,'Patient permissions do not grant inventory photos');
  f.db.tables.user_profiles[1].access_roles={is_admin:false,role_permissions:[{page_key:'inventory',can_view:true}]};
  const get=await f.request('GET','doctor',requestId);assert(get.status===200);assert(get.headers.get('Cache-Control')?.includes('private'));assert((await get.arrayBuffer()).byteLength===image.length);
  assert((await f.request('POST','doctor')).status===403);
  f.db.tables.user_profiles[1].access_roles.role_permissions.push({page_key:'inventory_manage',can_view:true});
  assert((await f.request('POST','doctor')).status===409,'Stale replacement is rejected');
  const replacement=await f.request('POST','doctor','',image,requestId);assert(replacement.status===200);const second=await replacement.json();
  assert(f.google.files.get(row.drive_file_id).trashed===true,'Previous photo is moved to Drive trash');
  assert((await f.request('GET','doctor',requestId)).status===404);
  assert((await f.request('DELETE','doctor',requestId)).status===409);
  f.db.tables.user_profiles[1].active=false;assert((await f.request('GET','doctor',second.image_version)).status===403);f.db.tables.user_profiles[1].active=true;
  const current=f.db.tables.inventory_item_images[0];f.google.files.get(current.drive_file_id).bytes=new Uint8Array([1,2,3]);
  assert((await f.request('GET','doctor',second.image_version)).status===409,'External Drive edits cannot serve mismatched bytes');
  assert((await f.request('DELETE','doctor',second.image_version)).status===200);assert((await f.request('DELETE','doctor',second.image_version)).status===200);
  assert(f.db.tables.inventory_item_images.length===0);assert(f.db.tables.inventory_items[0].quantity===3&&f.db.tables.inventory_items[0].revision===7);
  assert(JSON.stringify(f.db.tables.google_drive_metadata)===snapshot,'Patient synchronization snapshot is unchanged');
  f.db.tables.inventory_items[0].deleted_at=new Date().toISOString();assert((await f.request('POST')).status===404,'Deleted catalog items cannot receive photos');assert((await f.request('GET','admin',requestId)).status===404);
});
Deno.test("photo endpoint rejects unoptimized, oversized and animated payloads before writing Drive",async()=>{
  const f=await setup(),before=f.google.files.size;
  for(const [bytes,status] of [[new Uint8Array(PHOTO_LIMIT+1),413],[new TextEncoder().encode('<svg onload="bad()"/>'),400],[image.slice(0,30),400]] as const){const response=await f.request('POST','admin','',bytes);assert(response.status===status,await response.text());}
  const animated=new Uint8Array(30);animated.set(new TextEncoder().encode('RIFF'),0);new DataView(animated.buffer).setUint32(4,22,true);animated.set(new TextEncoder().encode('WEBPVP8X'),8);animated[20]=2;
  assert((await f.request('POST','admin','',animated)).status===400);assert(f.google.files.size===before);
  f.db.tables.google_drive_connection=[];assert((await f.request('POST')).status===409);
  assert(!f.db.tables.inventory_item_images?.length);
});
