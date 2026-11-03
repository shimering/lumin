const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const patientId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const token = 'header.' + Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url') + '.signature';

class Bucket {
  rows = new Map();
  async put(key,body,options={}) {
    const existing = this.rows.get(key);
    if (options.onlyIf?.etagDoesNotMatch === '*' && existing || options.onlyIf?.etagMatches && existing?.etag !== options.onlyIf.etagMatches) return null;
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    const row = {key,bytes,size:bytes.length,uploaded:new Date(),etag:randomUUID(),httpMetadata:options.httpMetadata || {},customMetadata:options.customMetadata || {}};
    this.rows.set(key,row); return this.object(row);
  }
  object(row) {
    return {...row,httpEtag:`"${row.etag}"`,body:new Response(row.bytes).body,
      arrayBuffer:async()=>row.bytes.buffer.slice(row.bytes.byteOffset,row.bytes.byteOffset+row.bytes.byteLength),
      json:async()=>JSON.parse(new TextDecoder().decode(row.bytes)),text:async()=>new TextDecoder().decode(row.bytes),
      writeHttpMetadata(headers) { if (row.httpMetadata.contentType) headers.set('Content-Type',row.httpMetadata.contentType); }};
  }
  async get(key) { const row = this.rows.get(key); return row ? this.object(row) : null; }
  async head(key) { return this.get(key); }
  async delete(key) { this.rows.delete(key); }
  async list({prefix='',delimiter,limit=1000,cursor}={}) {
    const rows = [...this.rows.values()].filter(r=>r.key.startsWith(prefix)).sort((a,b)=>a.key.localeCompare(b.key));
    const prefixes = new Set();
    const filtered = rows.filter(row=>{const part=row.key.slice(prefix.length);if (delimiter && part.includes(delimiter)) {prefixes.add(prefix+part.split(delimiter)[0]+delimiter);return false;}return true;});
    const start = Number(cursor || 0), objects = filtered.slice(start,start+limit);
    return {objects,truncated:start+limit<filtered.length,cursor:String(start+limit),delimitedPrefixes:[...prefixes]};
  }
}
async function fixture(driveFetch) {
  const {handleR2Request} = await import('../workers/r2-storage.mjs');
  const bucket = new Bucket(), state={active:true,admin:true,patients:true,patientName:'Test patient'}, calls=[];
  const fetcher = async (input,init) => {
    const url = new URL(input); calls.push(url.pathname);
    if (url.pathname.startsWith('/functions/v1/google-drive') && driveFetch) return driveFetch(url,init);
    if (init.headers.Authorization !== `Bearer ${token}`) return Response.json({}, {status:401});
    if (url.pathname === '/auth/v1/user') return Response.json({id:userId});
    if (url.pathname === '/rest/v1/user_profiles') return Response.json([{active:state.active,access_roles:{is_admin:state.admin,role_permissions:[{page_key:'patients',can_view:state.patients}]}}]);
    if (url.pathname === '/rest/v1/patients') return Response.json(url.searchParams.get('id') && url.searchParams.get('id') !== `eq.${patientId}` ? [] : [{id:patientId,name:state.patientName,patient_number:1}]);
    throw new Error('Unexpected auth endpoint');
  };
  return {bucket,state,calls,request(path,options={}) {
    const {anonymous=false,...init}=options;
    return handleR2Request(new Request('https://clinic.test/r2'+path,{...init,headers:{...(!anonymous?{'x-lumin-key':token}:{}),...init.headers}}),{LUMIN_MEDIA:bucket},fetcher);
  }};
}
async function upload(app,category='Panoramic',name='xray.png') {
  const form = new FormData(); form.set('patientId',patientId);form.set('category',category);
  form.set('image',new File(['sample media'],name,{type:'image/png'}));
  const response = await app.request('/api/upload',{method:'POST',body:form});
  assert.equal(response.status,200,await response.clone().text());return response.json();
}

test('private storage rejects anonymous, invalid, inactive and unauthorized callers',async()=>{
  const app = await fixture();
  assert.equal((await app.request('/api/health',{anonymous:true})).status,401);
  assert.equal((await app.request('/api/health',{headers:{'x-lumin-key':'wrong'}})).status,401);
  app.state.active=false; assert.equal((await app.request('/api/health')).status,403);
  app.state.active=true; app.state.admin=false;app.state.patients=false;
  assert.equal((await app.request('/api/health')).status,403);
  app.state.patients=true; assert.equal((await app.request('/api/health')).status,200);
  assert.equal((await app.request('/api/self-test',{method:'POST'})).status,403);
});
test('upload, tooth assignments, Arabic notes, preview, move and delete preserve patient identity',async()=>{
  const app = await fixture(), file = await upload(app);
  let response = await app.request(`/api/patient/${patientId}/media-details`,{method:'POST',body:JSON.stringify({relativePath:file.relativePath,details:{display_name:'أشعة أسنان',note:'ملاحظة للمراجعة',tooth_ids:['8','9']}})});
  assert.equal(response.status,200,await response.clone().text());
  let listing = await (await app.request(`/api/patient/${patientId}/files`)).json();
  assert.equal(listing.metadataSource,'r2');assert.equal(listing.metadataUnavailable,false);
  assert.equal(listing.files[0].mediaDetails.note,'ملاحظة للمراجعة');
  const index = await (await app.request('/api/xray-index')).json();
  assert.deepEqual(index.countsByPatient[patientId],{'8':1,'9':1});
  response = await app.request('/files/'+file.relativePath);assert.equal(await response.text(),'sample media');
  assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  response = await app.request('/api/thumbnail/'+file.relativePath);assert.equal(response.status,200);
  response = await app.request('/api/file/move',{method:'POST',body:JSON.stringify({relativePath:file.relativePath,targetCategory:'Intraoral'})});
  const moved = await response.json();assert.equal(response.status,200);
  assert.equal((await app.request('/files/'+file.relativePath)).status,404);
  listing = await (await app.request(`/api/patient/${patientId}/files`)).json();
  assert.equal(listing.total,1);assert.equal(listing.files[0].category,'Intraoral');
  assert.equal(listing.files[0].mediaDetails.note,'ملاحظة للمراجعة');
  response = await app.request('/api/file',{method:'DELETE',body:JSON.stringify({relativePath:moved.newRelativePath})});
  assert.equal(response.status,200);assert.equal((await (await app.request(`/api/patient/${patientId}/files`)).json()).total,0);
});
test('media URL grants are short-lived, read-only, revocable, and recheck current permissions',async()=>{
  const app = await fixture(), file = await upload(app);
  const grantResponse = await app.request('/api/media-grant',{method:'POST'}), grant = await grantResponse.json();
  assert.equal(grantResponse.status,200);assert.equal(grant.mediaGrant.length,64);
  assert.ok(grant.expiresAt<=Date.now()+15*60000);
  const url = '/files/'+file.relativePath+'?media='+grant.mediaGrant;
  assert.equal((await app.request(url,{anonymous:true})).status,200);
  assert.equal((await app.request('/api/health?media='+grant.mediaGrant,{anonymous:true})).status,401);
  assert.equal((await app.request('/api/file?media='+grant.mediaGrant,{anonymous:true,method:'DELETE',body:'{}'})).status,401);
  app.state.active=false; assert.equal((await app.request(url,{anonymous:true})).status,403);app.state.active=true;
  await app.request('/api/media-grant/revoke',{method:'POST',body:JSON.stringify({mediaGrant:grant.mediaGrant})});
  assert.equal((await app.request(url,{anonymous:true})).status,401);
});
test('patient mismatch, traversal, active file types, invalid metadata and oversize bodies are rejected',async()=>{
  const app = await fixture(), file = await upload(app);
  for (const details of [{tooth_ids:['99']},{scan_date:'2026-02-31'},{note:'x'.repeat(65537)}]) {
    assert.equal((await app.request(`/api/patient/${patientId}/media-details`,{method:'POST',body:JSON.stringify({relativePath:file.relativePath,details})})).status,400);
  }
  assert.equal((await app.request(`/api/patient/${otherId}/media-details`,{method:'POST',body:JSON.stringify({relativePath:file.relativePath,details:{}})})).status,404);
  assert.equal((await app.request('/api/file',{method:'DELETE',body:JSON.stringify({relativePath:'../General/test.png'})})).status,400);
  const form = new FormData();form.set('patientId',patientId);form.set('category','General');form.set('file',new File(['bad'],'script.html'));
  assert.equal((await app.request('/api/upload',{method:'POST',body:form})).status,400);
  assert.equal((await app.request('/api/upload',{method:'POST',headers:{'Content-Length':String(70*1048576)},body:'x'})).status,413);
  assert.equal((await app.request('/api/health',{headers:{Origin:'https://evil.test'}})).status,403);
});
test('ZIP scans retain their filenames and scan settings; storage self-test leaves no objects',async()=>{
  const app = await fixture(), scan = await upload(app,'3D-Scans','upper-lower.zip');
  assert.equal(scan.filename,'upper-lower.zip');assert.equal(scan.relativePath.split('/').length,4);
  const response = await app.request(`/api/patient/${patientId}/media-details`,{method:'POST',body:JSON.stringify({relativePath:scan.relativePath,details:{scan_date:'2026-11-03',scan_config:{upper:'upper.obj',lower:'lower.obj'}}})});
  assert.equal(response.status,200);
  const before=app.bucket.rows.size;
  assert.deepEqual(await (await app.request('/api/self-test',{method:'POST'})).json(),{success:true,verified:['write','read','delete']});
  assert.equal(app.bucket.rows.size,before);
});
test('frontend exposes a keyless preset without persisting session tokens',async()=>{
  const source=fs.readFileSync(require.resolve('../lumin-r2.js'),'utf8');
  const context=vm.createContext({window:{},location:{origin:'https://clinic.test'},currentUiLanguage:'en',db:{auth:{getSession:async()=>({data:{session:{access_token:token,user:{id:userId}}}})}},escapeHtml:String});
  vm.runInContext(source,context);const r2=context.window.LuminR2;
  await r2.ensure();assert.equal(r2.config('https://clinic.test/r2').key,token);
  assert.equal(r2.presets([])[0].provider,'r2');assert.equal(r2.presets(r2.presets([])).length,1);
  assert.match(r2.card(r2.preset(),false,false,false),/Use Cloudflare R2/);
  r2.reset();assert.equal(r2.config('https://clinic.test/r2').key,'');
});

function driveFixture() {
  const rows=new Map(),details=new Map(),nodeId=otherId;
  let pair=null,failNextUpload=false;
  const record=path=>rows.get(path)?.record||null;
  const fetcher=async(url,init)=>{
    const route=url.pathname.replace('/functions/v1/google-drive/',''),method=init.method||'GET';
    if(route==='api/sync/info')return Response.json({nodeId,protocol:1,fileScope:'patient-files-v1',clinicalMetadataVersion:2,pair:pair?{peerId:pair.peerId,role:'replica'}:null});
    if(route==='api/sync/pair/accept'){pair=JSON.parse(init.body);return Response.json({paired:true});}
    assert.equal(init.headers['x-lumin-sync-key'],pair.secret);
    assert.equal(init.headers['x-lumin-sync-node'],pair.peerId);
    if(route==='api/sync/peer/manifest')return Response.json({nodeId,files:Object.fromEntries([...rows].map(([k,v])=>[k.toLowerCase(),v.record]))});
    if(route==='api/sync/peer/metadata')return Response.json({snapshot:{version:2,patients:[{id:patientId,name:'Test patient',patient_number:'1'}],files:[...details.values()]}});
    const path=url.searchParams.get('path');
    if(route==='api/sync/peer/review-record')return Response.json({nodeId,record:record(path),details:details.get(path)||{relative_path:path,metadata_available:false}});
    if(route==='api/sync/peer/file'&&method==='GET') {
      const row=rows.get(path);assert.ok(row&&!row.record.deleted);assert.equal(url.searchParams.get('sha256'),row.record.sha256);return new Response(row.bytes,{headers:{'Content-Type':'image/png'}});
    }
    if(route==='api/sync/peer/file'&&method==='PUT') {
      const meta=JSON.parse(Buffer.from(init.headers['x-lumin-sync-meta'],'base64').toString());
      rows.set(meta.record.path,{record:meta.record,bytes:new Uint8Array(init.body)});return Response.json({success:true});
    }
    if(route==='api/sync/peer/record') {
      const data=JSON.parse(init.body);assert.deepEqual(record(data.record.path),data.expected);rows.set(data.record.path,{...rows.get(data.record.path),record:data.record});return Response.json({success:true});
    }
    if(route==='api/sync/peer/review-resolution') {
      if(failNextUpload){failNextUpload=false;return Response.json({error:'Transfer interrupted',code:'drive_unavailable'},{status:503});}
      const bytes=new Uint8Array(init.body),length=new DataView(bytes.buffer,bytes.byteOffset).getUint32(0),data=JSON.parse(new TextDecoder().decode(bytes.subarray(4,4+length)));
      assert.deepEqual(record(data.record.path),data.expected);
      rows.set(data.record.path,{record:data.record,bytes:bytes.length>4+length?bytes.slice(4+length):rows.get(data.record.path).bytes});
      details.set(data.record.path,data.details);return Response.json({success:true});
    }
    throw new Error('Unexpected Drive request: '+route);
  };
  return {rows,details,fetcher,failUpload(){failNextUpload=true;},async add(path,text,annotation={}){
    const bytes=new TextEncoder().encode(text),hash=await crypto.subtle.digest('SHA-256',bytes);
    rows.set(path,{bytes,record:{path,sha256:Buffer.from(hash).toString('hex'),size:bytes.length,deleted:false,clock:{[nodeId]:1}}});
    details.set(path,{patient_id:patientId,relative_path:path,patient_name:'Test patient',patient_number:'1',metadata_available:true,display_name:'Clinical image',note:'Drive note',tooth_ids:['8'],scan_date:null,scan_config:null,...annotation});
  }};
}
async function pairCloud(app) {
  const response=await app.request('/api/cloud-sync/pair',{method:'POST',body:JSON.stringify({url:'https://pqbayjkypzfxvnksgwwf.supabase.co/functions/v1/google-drive'})});
  assert.equal(response.status,200,await response.clone().text());
}
async function synchronize(app) {
  let response=await app.request('/api/cloud-sync/jobs',{method:'POST'});
  assert.equal(response.status,200,await response.clone().text());let job=await response.json();
  for(let limit=0;job.status==='running'&&limit<100;limit++) {
    response=await app.request(`/api/cloud-sync/jobs/${job.id}/step`,{method:'POST'});
    assert.equal(response.status,200,await response.clone().text());job=await response.json();
  }
  return job;
}
test('cloud sync copies both directions, verifies files and notes, and remains idempotent',async()=>{
  const drive=driveFixture(),app=await fixture(drive.fetcher);
  await drive.add('Test_patient/Panoramic/original.png','Drive original');
  const r2=await upload(app,'Intraoral','r2.png');await pairCloud(app);
  let job=await synchronize(app);assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(job.verifiedFiles,2);
  let listing=await (await app.request(`/api/patient/${patientId}/files`)).json();
  assert.equal(listing.total,2);assert.equal(listing.files.find(f=>f.filename==='original.png').mediaDetails.note,'Drive note');
  assert.equal([...drive.rows.values()].filter(r=>!r.record.deleted).length,2);
  const remote=[...drive.details.values()].find(d=>d.relative_path.endsWith(r2.filename));assert.ok(remote);
  const count=app.bucket.rows.size;job=await synchronize(app);assert.equal(job.status,'completed');assert.equal(app.bucket.rows.size,count);
  await app.request(`/api/patient/${patientId}/media-details`,{method:'POST',body:JSON.stringify({relativePath:r2.relativePath,details:{note:'R2 edited note',tooth_ids:['12','13']}})});
  job=await synchronize(app);assert.equal(job.status,'completed',JSON.stringify(job));
  assert.equal(drive.details.get(remote.relative_path).note,'R2 edited note');
  const original=drive.details.get('Test_patient/Panoramic/original.png');original.note='Updated on Drive';original.tooth_ids=['20'];
  job=await synchronize(app);assert.equal(job.status,'completed',JSON.stringify(job));
  listing=await (await app.request(`/api/patient/${patientId}/files`)).json();
  assert.equal(listing.files.find(f=>f.filename==='original.png').mediaDetails.note,'Updated on Drive');
  await drive.add('Test_patient/Panoramic/original.png','Updated Drive binary',{note:'Updated on Drive',tooth_ids:['20']});
  job=await synchronize(app);assert.equal(job.status,'completed',JSON.stringify(job));
  assert.equal(await (await app.request(`/files/${patientId}/Panoramic/original.png`)).text(),'Updated Drive binary');
  const r2Key=[...app.bucket.rows.keys()].find(key=>key.startsWith('Lumin Clinic/')&&key.endsWith(r2.relativePath.split('/').slice(1).join('/')));
  await app.bucket.put(r2Key,'Changed R2 binary',{httpMetadata:{contentType:'image/png'}});
  job=await synchronize(app);assert.equal(job.status,'completed',JSON.stringify(job));
  assert.equal(new TextDecoder().decode(drive.rows.get(remote.relative_path).bytes),'Changed R2 binary');
  assert.ok([...app.bucket.rows.keys()].some(key=>key.startsWith('_recovery/')),'replaced R2 originals are preserved');
});
test('cloud sync preserves conflicting edits, stale reviews, deleted copies and supports explicit resolution',async()=>{
  const drive=driveFixture(),app=await fixture(drive.fetcher),path='Test_patient/Panoramic/original.png';
  await drive.add(path,'original');await pairCloud(app);await synchronize(app);
  const local=`${patientId}/Panoramic/original.png`;
  await app.request(`/api/patient/${patientId}/media-details`,{method:'POST',body:JSON.stringify({relativePath:local,details:{note:'Edited R2'}})});
  drive.details.get(path).note='Edited Drive';
  let job=await synchronize(app);assert.equal(job.status,'completed_with_conflicts');assert.equal(job.conflicts[0].kind,'metadata');
  let route=`/api/cloud-sync/jobs/${job.id}/conflicts/0`,review=await (await app.request(route)).json();
  assert.ok(review.actions.includes('keep_local'));
  let response=await app.request(route,{method:'POST',body:JSON.stringify({action:'keep_local',revision:'stale'})});assert.equal(response.status,409);
  response=await app.request(route,{method:'POST',body:JSON.stringify({action:'keep_local',revision:review.revision})});assert.equal(response.status,200,await response.clone().text());
  assert.equal(drive.details.get(path).note,'Edited R2');
  await app.request('/api/file',{method:'DELETE',body:JSON.stringify({relativePath:local})});
  job=await synchronize(app);assert.equal(job.conflicts[0].kind,'delete_modified');assert.equal(drive.rows.get(path).record.deleted,false);
  route=`/api/cloud-sync/jobs/${job.id}/conflicts/0`;review=await (await app.request(route)).json();
  response=await app.request(route,{method:'POST',body:JSON.stringify({action:'keep_remote',revision:review.revision})});assert.equal(response.status,200,await response.clone().text());
  assert.equal((await app.request('/files/'+local)).status,200);
});
test('cloud sync recovers interrupted uploads and verifies an isolated round trip without patient records',async()=>{
  const drive=driveFixture(),app=await fixture(drive.fetcher);await upload(app);await pairCloud(app);
  drive.failUpload();let job=await synchronize(app);assert.equal(job.status,'failed');
  job=await synchronize(app);assert.equal(job.status,'completed',JSON.stringify(job));
  const before=[...drive.rows.values()].filter(r=>!r.record.deleted).length;
  const response=await app.request('/api/cloud-sync/verify',{method:'POST'}),result=await response.json();
  assert.equal(response.status,200,JSON.stringify(result));assert.deepEqual(result.directions,['r2_to_drive','drive_to_r2']);
  assert.equal([...drive.rows.values()].filter(r=>!r.record.deleted).length,before);
  assert.equal([...app.bucket.rows.keys()].some(k=>k.startsWith('_checks/')),false);
});

test('retry resumes after the last verified file instead of restarting a failed cloud sync',async()=>{
  const drive=driveFixture(),app=await fixture(drive.fetcher);
  await upload(app,'Panoramic','first.png');await upload(app,'Panoramic','second.png');await pairCloud(app);
  let job=await (await app.request('/api/cloud-sync/jobs',{method:'POST'})).json();
  job=await (await app.request(`/api/cloud-sync/jobs/${job.id}/step`,{method:'POST'})).json();
  assert.equal(job.completedFiles,1);drive.failUpload();
  job=await (await app.request(`/api/cloud-sync/jobs/${job.id}/step`,{method:'POST'})).json();
  assert.equal(job.status,'failed');assert.equal(job.completedFiles,1);
  const failedId=job.id;
  job=await (await app.request('/api/cloud-sync/jobs',{method:'POST'})).json();
  assert.equal(job.id,failedId);assert.equal(job.status,'running');assert.equal(job.completedFiles,1);assert.equal(job.error,undefined);
  job=await synchronize(app);assert.equal(job.id,failedId);assert.equal(job.status,'completed');assert.equal(job.verifiedFiles,2);
});
test('unassigned legacy Drive files remain untouched and do not block identified patient files',async()=>{
  const drive=driveFixture(),app=await fixture(drive.fetcher);
  await drive.add('Known/Panoramic/known.png','known');
  await drive.add('Unknown/Panoramic/unknown.png','unassigned');drive.details.delete('Unknown/Panoramic/unknown.png');
  await app.bucket.put('Lumin Clinic/Unknown/Panoramic/unknown.png','unassigned',{httpMetadata:{contentType:'image/png'}});
  await pairCloud(app);const job=await synchronize(app);
  assert.equal(job.status,'completed');assert.equal(job.verifiedFiles,1);assert.equal(job.unassignedFiles.length,1);
  assert.equal(drive.rows.get('Unknown/Panoramic/unknown.png').record.deleted,false);
  assert.equal((await (await app.request(`/api/patient/${patientId}/files`)).json()).total,1);
  let response=await app.request('/api/cloud-sync/unassigned/delete',{method:'POST',body:JSON.stringify({paths:['Known/Panoramic/known.png']})});
  assert.equal(response.status,409,'assigned files cannot be removed by legacy cleanup');
  response=await app.request('/api/cloud-sync/unassigned/delete',{method:'POST',body:JSON.stringify({paths:['Unknown/Panoramic/unknown.png']})});
  assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).removed,1);
  assert.equal(drive.rows.get('Unknown/Panoramic/unknown.png').record.deleted,true);
  assert.equal(drive.rows.get('Known/Panoramic/known.png').record.deleted,false);
  assert.equal(await app.bucket.get('Lumin Clinic/Unknown/Panoramic/unknown.png'),null);
  const recovery=[...app.bucket.rows.keys()].find(key=>key.startsWith('_recovery/unassigned-')&&key.endsWith('/original'));
  assert.equal(await (await app.bucket.get(recovery)).text(),'unassigned');
  assert.equal((await (await app.bucket.get(recovery.replace('/original','/details.json'))).json()).sourceKey,'Lumin Clinic/Unknown/Panoramic/unknown.png');
});

test('unassigned cleanup preserves copied files that differ or gain a patient assignment',async()=>{
  const drive=driveFixture(),app=await fixture(drive.fetcher),path='Unknown/Panoramic/unknown.png',key='Lumin Clinic/'+path;
  await drive.add(path,'original');drive.details.delete(path);
  await app.bucket.put(key,'different copy');await pairCloud(app);await synchronize(app);
  let response=await app.request('/api/cloud-sync/unassigned/delete',{method:'POST',body:JSON.stringify({paths:[path]})});
  assert.equal(response.status,409);assert.equal(drive.rows.get(path).record.deleted,false);
  assert.equal(await (await app.bucket.get(key)).text(),'different copy');
  await app.bucket.put(key,'original');
  await app.bucket.put('_layout/patients.json',JSON.stringify({version:2,patients:{[patientId]:{folder:'Unknown',patientName:'Test patient',aliases:[]}}}));
  response=await app.request('/api/cloud-sync/unassigned/delete',{method:'POST',body:JSON.stringify({paths:[path]})});
  assert.equal(response.status,409);assert.equal(drive.rows.get(path).record.deleted,false);
  assert.equal(await (await app.bucket.get(key)).text(),'original');
});

async function organize(app) {
  let response=await app.request('/api/cloud-sync/layout/jobs',{method:'POST'});
  assert.equal(response.status,200,await response.clone().text());let job=await response.json();
  for(let limit=0;job.status==='running'&&limit<100;limit++) {
    response=await app.request(`/api/cloud-sync/layout/jobs/${job.id}/step`,{method:'POST'});
    assert.equal(response.status,200,await response.clone().text());job=await response.json();
  }
  return job;
}
test('legacy coded folders migrate to exact readable Drive names without changing links, metadata or sync',async()=>{
  const drive=driveFixture(),app=await fixture(drive.fetcher);
  await drive.add('المريض_أحمد/Panoramic/original.png','Patient image',{note:'ملاحظة محفوظة',tooth_ids:['8','9']});
  await pairCloud(app);await synchronize(app);
  const named='Lumin Clinic/المريض_أحمد/Panoramic/original.png',legacy=`patients/${patientId}/Panoramic/original.png`;
  assert.ok(app.bucket.rows.has(named));
  await app.bucket.put(legacy,app.bucket.rows.get(named).bytes,{httpMetadata:{contentType:'image/png'}});
  await app.bucket.delete(named);await app.bucket.delete('_layout/patients.json');
  assert.equal((await app.request(`/files/${patientId}/Panoramic/original.png`)).status,200,'legacy links work before migration');
  const job=await organize(app);assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(job.movedFiles,1);
  assert.ok(app.bucket.rows.has(named));assert.equal(app.bucket.rows.has(legacy),false);
  const listing=await (await app.request(`/api/patient/${patientId}/files`)).json();
  assert.equal(listing.total,1);assert.equal(listing.files[0].mediaDetails.note,'ملاحظة محفوظة');assert.deepEqual(listing.files[0].mediaDetails.tooth_ids,['8','9']);
  assert.equal(await (await app.request(`/files/${patientId}/Panoramic/original.png`)).text(),'Patient image');
  assert.equal((await synchronize(app)).status,'completed');
  assert.equal((await organize(app)).movedFiles,0,'repeating organization does not duplicate files');
  app.state.patientName='اسم المريض الجديد';await app.request(`/api/patient/${patientId}/rename`,{method:'POST'});
  assert.equal((await app.request(`/files/${patientId}/Panoramic/original.png`)).status,200,'renames retain working links');
  assert.equal((await organize(app)).status,'completed');assert.ok(app.bucket.rows.has('Lumin Clinic/اسم_المريض_الجديد/Panoramic/original.png'));
});
test('folder migration preserves both copies when the destination differs or the source changes',async()=>{
  const app=await fixture(),file=await upload(app),named=[...app.bucket.rows.keys()].find(k=>k.startsWith('Lumin Clinic/'));
  const legacy='patients/'+file.relativePath;await app.bucket.put(legacy,'different original',{httpMetadata:{contentType:'image/png'}});
  const job=await organize(app);assert.equal(job.status,'failed');
  assert.ok(app.bucket.rows.has(legacy));assert.ok(app.bucket.rows.has(named));
  assert.equal(new TextDecoder().decode(app.bucket.rows.get(legacy).bytes),'different original');
});
test('copied named folders are discovered from saved Drive identities after coded folders and the index are removed',async()=>{
  const drive=driveFixture(),app=await fixture(drive.fetcher),path='أحمد_محمد/Panoramic/copied.png';
  await drive.add(path,'original Drive image',{note:'Saved clinical note',tooth_ids:['8','9']});await pairCloud(app);await synchronize(app);
  await app.bucket.delete('_layout/patients.json');
  for(const key of [...app.bucket.rows.keys()])if(key.startsWith('patients/'))await app.bucket.delete(key);
  let listing=await (await app.request(`/api/patient/${patientId}/files`)).json();
  assert.equal(listing.total,1);assert.equal(listing.files[0].mediaDetails.note,'Saved clinical note');
  assert.equal(await (await app.request('/files/'+listing.files[0].relativePath)).text(),'original Drive image');
  const fresh=await upload(app,'Periapical','new-xray.png');
  assert.ok(app.bucket.rows.has('Lumin Clinic/أحمد_محمد/'+fresh.relativePath.split('/').slice(1).join('/')),'new uploads keep the recorded patient-name folder');
  assert.equal([...app.bucket.rows.keys()].some(key=>key.startsWith('patients/')),false);
  assert.equal((await synchronize(app)).status,'completed');
  assert.ok([...drive.rows.keys()].some(key=>key.startsWith('أحمد_محمد/Periapical/')&&key.endsWith('new-xray.png')));
  listing=await (await app.request(`/api/patient/${patientId}/files`)).json();assert.equal(listing.total,2);
});
test('refresh recognizes a direct Drive folder copy with no prior R2 index or metadata and restores clinical details',async()=>{
  const drive=driveFixture(),app=await fixture(drive.fetcher),path='مريض_من_Drive/Periapical/xray.png';
  await drive.add(path,'manually copied X-ray',{display_name:'X-ray label',note:'Original Drive note',tooth_ids:['12'],scan_date:'2026-11-03'});
  await pairCloud(app);
  const key='Lumin Clinic/'+path;
  await app.bucket.put(key,drive.rows.get(path).bytes,{httpMetadata:{contentType:'image/png'}});
  const before=app.bucket.rows.get(key).etag,job=await organize(app);
  assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(job.restoredDetails,1);assert.equal(job.movedFiles,0);
  assert.equal(app.bucket.rows.get(key).etag,before,'repair preserves the uploaded image bytes');
  const listing=await (await app.request(`/api/patient/${patientId}/files`)).json();
  assert.equal(listing.total,1);assert.equal(listing.metadataUnavailable,false);
  assert.equal(listing.files[0].mediaDetails.note,'Original Drive note');assert.deepEqual(listing.files[0].mediaDetails.tooth_ids,['12']);
  assert.equal((await synchronize(app)).status,'completed');
  await app.request(`/api/patient/${patientId}/media-details`,{method:'POST',body:JSON.stringify({relativePath:listing.files[0].relativePath,details:{note:'Later R2 edit'}})});
  assert.equal((await organize(app)).status,'completed');
  const kept=await (await app.request(`/api/patient/${patientId}/files`)).json();assert.equal(kept.files[0].mediaDetails.note,'Later R2 edit','refresh preserves saved R2 edits');
});
test('refresh preserves R2 notes and does not apply Drive annotations to different copied content',async()=>{
  const drive=driveFixture(),app=await fixture(drive.fetcher),path='Known/Panoramic/image.png';
  await drive.add(path,'Drive bytes');await pairCloud(app);
  await app.bucket.put('Lumin Clinic/'+path,'different bytes',{httpMetadata:{contentType:'image/png'}});
  const job=await organize(app);assert.equal(job.status,'failed');
  assert.equal(app.bucket.rows.has(`metadata/${patientId}/Panoramic/image.png.json`),false,'annotations are not attached to a different X-ray');
  assert.equal(new TextDecoder().decode(app.bucket.rows.get('Lumin Clinic/'+path).bytes),'different bytes');
});
test('unknown copied folders are not attached to a new patient just because the names match',async()=>{
  const app=await fixture();
  await app.bucket.put('Lumin Clinic/Test_patient/Panoramic/unassigned.png','unknown owner',{httpMetadata:{contentType:'image/png'}});
  const file=await upload(app);
  const listing=await (await app.request(`/api/patient/${patientId}/files`)).json();
  assert.equal(listing.total,1);assert.equal(listing.files[0].relativePath,file.relativePath);
  assert.ok(app.bucket.rows.has('Lumin Clinic/Test_patient_1/'+file.relativePath.split('/').slice(1).join('/')));
});
test('a first upload to R2 creates the same readable patient folder in Drive without adding an ID suffix',async()=>{
  const drive=driveFixture(),app=await fixture(drive.fetcher),file=await upload(app,'Panoramic','first-xray.png');
  const tail=file.relativePath.split('/').slice(1).join('/');
  assert.ok(app.bucket.rows.has('Lumin Clinic/Test_patient/'+tail));
  await pairCloud(app);assert.equal((await synchronize(app)).status,'completed');
  assert.ok(drive.rows.has('Test_patient/'+tail));
  assert.ok(app.bucket.rows.has('Lumin Clinic/Test_patient/'+tail));
  assert.equal([...app.bucket.rows.keys()].some(key=>key.startsWith('patients/')),false);
});
