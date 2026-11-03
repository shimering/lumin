import '../lumin-public-config.js';
import {sha256,caseFold,annotationSignature,equal,pythonJson,safePath as drivePath} from '../supabase/functions/google-drive/core.ts';
import {MEDIA_ROOT,layoutRoute,seedKnownFolders,patientFolder} from './r2-layout.mjs';

const DRIVE = `${globalThis.LuminPublicConfig.supabaseUrl}/functions/v1/google-drive`;
const LIMIT = 24 * 1048576;
const CONFIG = '_cloud-sync/config.json', JOB = '_cloud-sync/job.json', BASE = '_cloud-sync/baselines.json', LEASE = '_cloud-sync/lease.json';
const clinical = value => ({display_name:value?.display_name || '',note:value?.note || '',tooth_ids:value?.tooth_ids || (value?.tooth_id?[value.tooth_id]:[]),scan_date:value?.scan_date || null,scan_config:value?.scan_config || null});
const signature = value => pythonJson(clinical(value));
const publicJob = job => { if (!job) return null; const {items,...view}=job;return view; };
const bytes64 = value => {let s='';for(const b of value)s+=String.fromCharCode(b);return btoa(s);};

export async function cloudSync(route,request,url,ctx) {
  const {bucket,auth,fetcher,helpers:h} = ctx;
  const fail = (message,status=409,code='file_changed') => {throw new h.StorageError(message,status,code);};
  if (!auth.admin) fail('Administrator access is required.',403,'access_denied');
  const read = async key => {const object=await bucket.get(key);return object?{object,value:await object.json()}:null;};
  const save = (key,value) => bucket.put(key,JSON.stringify(value),{httpMetadata:{contentType:'application/json'}});
  const settings = async () => (await read(CONFIG))?.value;
  async function peer(pair,path,method='GET',body,headers={}) {
    const response=await fetcher(`${DRIVE}/api/sync/peer/${path}`,{method,headers:{'x-lumin-sync-node':pair.nodeId,'x-lumin-sync-key':pair.secret,...headers,...(body && !(body instanceof Uint8Array)?{'Content-Type':'application/json'}:{})},...(body?{body:body instanceof Uint8Array?body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(65000)});
    if (!response.ok) {const data=await response.json().catch(()=>({}));fail(data.error || 'Google Drive could not complete synchronization.',response.status,data.code || 'drive_unavailable');}
    return response;
  }
  const peerJson = async (...args) => (await peer(...args)).json();
  async function locked(run) {
    const owner=crypto.randomUUID(),old=await read(LEASE);
    if (old?.value.expiresAt>Date.now()) fail('Another cloud sync operation is running. Retry shortly.',409,'sync_busy');
    const lease=await bucket.put(LEASE,JSON.stringify({owner,expiresAt:Date.now()+5*60000}),{onlyIf:old?{etagMatches:old.object.etag}:{etagDoesNotMatch:'*'}});
    if (!lease) fail('Another cloud sync operation is running. Retry shortly.',409,'sync_busy');
    try{return await run();}finally{if((await read(LEASE))?.value.owner===owner)await bucket.delete(LEASE);}
  }
  async function connection() {const pair=await settings();if(!pair?.paired)fail('Pair Google Drive and R2 first.',409,'pair_required');return pair;}
  async function refreshCatalog() {
    const pair=await settings();
    if(!pair?.paired)return (await read('_layout/drive-catalog.json'))?.value||null;
    const manifest=await peerJson(pair,'manifest'),meta=await peerJson(pair,'metadata');
    if(manifest.nodeId!==pair.peerId)fail('Google Drive identity changed. Update pairing before refreshing folders.',409,'peer_changed');
    const catalog={nodeId:manifest.nodeId,snapshot:meta.snapshot,records:manifest.files||{},updatedAt:new Date().toISOString()};
    await seedKnownFolders(bucket,catalog);await save('_layout/drive-catalog.json',catalog);return catalog;
  }
  async function resolveCopiedConflict(item,details,digest) {
    if(digest!==item.expectedHash||signature(details)!==signature(item.details))return;
    const job=(await read(JOB))?.value;
    if(!job||job.status==='running')return;
    let changed=false;
    for(const conflict of job.conflicts||[])if(!conflict.reviewed&&conflict.item?.key===caseFold(item.path)) {
      conflict.reviewed=true;conflict.resolution='already_current';job.verifiedFiles=(job.verifiedFiles||0)+1;changed=true;
    }
    if(!changed)return;
    if(job.conflicts.every(c=>c.reviewed)){job.status='completed';job.metadataStatus=job.conflicts.some(c=>c.resolution==='keep_both')?'exceptions':'current';}
    await save(JOB,job);
  }
  async function r2Side(path,patient,hint) {
    const object=await h.getMedia(bucket,path,patient,{},hint);
    if(!object)return {path,record:null,details:{metadata_available:false},object:null};
    const meta=await h.metadata(bucket,path);
    const hash=object.customMetadata?.sha256 || (object.size>LIMIT?`oversize:${object.etag}`:await sha256(new Uint8Array(await object.arrayBuffer())));
    return {path,object,meta,details:meta.details,record:{path,sha256:hash,size:object.size,deleted:false}};
  }
  async function sides(item,pair) {
    const patient=await h.patientFor(auth.token,item.patientId,fetcher);
    const local=await r2Side(item.r2Path,patient,item.drivePath.split('/')[0]),remote=await peerJson(pair,`review-record?path=${encodeURIComponent(item.drivePath)}`);
    if(remote.details?.metadata_available && remote.details.patient_id!==patient.id) fail('Patient identity changed during sync.',409,'patient_changed');
    return {local,remote:{...remote,path:item.drivePath},patient};
  }
  const live = side => Boolean(side.record&&!side.record.deleted);
  async function cleanTest(pair,path) {
    if(!/^Lumin_Sync_Verification\/General\/[a-f\d-]{36}\.png$/.test(path||''))fail('Invalid verification record.',409,'verification_failed');
    const current=await peerJson(pair,`review-record?path=${encodeURIComponent(path)}`);
    if(live(current))await peerJson(pair,'record','POST',{record:{...current.record,deleted:true,sha256:null,size:0,clock:{...current.record.clock,[pair.nodeId]:(current.record.clock[pair.nodeId]||0)+1}},expected:current.record});
  }
  const summary = side => live(side)?{hash:side.record.sha256,details:signature(side.details)}:null;
  const same = (a,b) => equal(summary(a),summary(b));
  async function archive(local) {
    if(!local.object)return;
    const root=`_recovery/${crypto.randomUUID()}`;
    const source=await bucket.get(local.object.key,{onlyIf:{etagMatches:local.object.etag}});
    if(!source||!('body'in source))fail('R2 file changed before it could be preserved.');
    await bucket.put(`${root}/original`,source.body,{httpMetadata:source.httpMetadata});
    await save(`${root}/details.json`,local.details);
  }
  async function copyToR2(item,pair,current) {
    const {local,remote,patient}=current;
    if(!live(remote))fail('The Google Drive copy is missing.');
    if(remote.record.size>LIMIT)fail('Google Drive sync supports files up to 24 MB.',413,'file_too_large');
    const response=await peer(pair,`file?path=${encodeURIComponent(remote.path)}&sha256=${remote.record.sha256}`),bytes=new Uint8Array(await response.arrayBuffer());
    if(bytes.length!==remote.record.size||await sha256(bytes)!==remote.record.sha256)fail('File verification failed.',409,'verification_failed');
    const details=h.detailsFor(local.path,patient,clinical(remote.details));
    if(!live(local)||local.record.sha256!==remote.record.sha256) {
      await archive(local);
      const key=local.object?.key||await h.dataKey(bucket,local.path,patient,remote.path.split('/')[0]);
      const result=await bucket.put(key,bytes,{httpMetadata:{contentType:h.types[local.path.split('.').at(-1).toLowerCase()]},customMetadata:{sha256:remote.record.sha256},onlyIf:local.object?{etagMatches:local.object.etag}:{etagDoesNotMatch:'*'}});
      if(!result)fail('R2 file changed during synchronization.');
    }
    await h.putDetails(bucket,local.path,details,local.meta?.object.etag);
    const verified=await h.getMedia(bucket,local.path,patient);
    if(!verified||await sha256(new Uint8Array(await verified.arrayBuffer()))!==remote.record.sha256)fail('R2 file verification failed.',409,'verification_failed');
    return bytes.length;
  }
  async function copyToDrive(item,pair,current) {
    const {local,remote,patient}=current;
    if(!live(local))fail('The R2 copy is missing.');
    if(local.record.size>LIMIT)fail('Google Drive sync supports files up to 24 MB.',413,'file_too_large');
    const object=await bucket.get(local.object.key,{onlyIf:{etagMatches:local.object.etag}});
    if(!object||!('body'in object))fail('R2 file changed during synchronization.');
    const bytes=new Uint8Array(await object.arrayBuffer());
    if(await sha256(bytes)!==local.record.sha256)fail('R2 file verification failed.',409,'verification_failed');
    const clock={...(remote.record?.clock||{})};clock[pair.nodeId]=(clock[pair.nodeId]||0)+1;
    const record={path:remote.path,sha256:local.record.sha256,size:bytes.length,deleted:false,clock};
    const details={...clinical(local.details),patient_id:patient.id,patient_name:patient.name,patient_number:String(patient.patient_number||''),relative_path:remote.path,metadata_available:true};
    const body={record,expected:remote.record||null,expectedDetails:remote.details,details};
    const needsBytes=!live(remote)||remote.record.sha256!==record.sha256;
    const header=new TextEncoder().encode(JSON.stringify(body)),packet=new Uint8Array(4+header.length+(needsBytes?bytes.length:0));
    new DataView(packet.buffer).setUint32(0,header.length);packet.set(header,4);if(needsBytes)packet.set(bytes,4+header.length);
    await peerJson(pair,'review-resolution','PUT',packet,{'Content-Type':'application/octet-stream'});
    const verified=await peerJson(pair,`review-record?path=${encodeURIComponent(remote.path)}`);
    if(verified.record?.deleted||verified.record?.sha256!==record.sha256||signature(verified.details)!==signature(details))fail('Google Drive file or metadata verification failed.',409,'verification_failed');
    return needsBytes?bytes.length:0;
  }
  async function remember(item,pair) {
    const current=await sides(item,pair);
    if(!same(current.local,current.remote))fail('The two copies changed before verification.');
    const bases=(await read(BASE))?.value||{};
    bases[item.key]={...item,summary:summary(current.local)};await save(BASE,bases);
  }
  async function inspect(item,pair,bases) {
    const current=await sides(item,pair),left=summary(current.local),right=summary(current.remote),saved=bases[item.key],base=saved?.summary;
    if(saved?.kept&&equal(saved.kept,{local:left,remote:right}))return {...current,direction:'exception'};
    if((current.local.record?.size||0)>LIMIT||(current.remote.record?.size||0)>LIMIT)return {...current,conflict:'file_too_large'};
    if(!left&&!right)return {...current,direction:'none'};
    if(same(current.local,current.remote))return {...current,direction:'none'};
    if(!base&&!right&&left)return {...current,direction:'to_drive'};
    if(!base&&!left&&right)return {...current,direction:'to_r2'};
    if(!left||!right)return {...current,conflict:'delete_modified'};
    const leftChanged=!equal(left,base),rightChanged=!equal(right,base);
    if(base&&leftChanged&&!rightChanged)return {...current,direction:'to_drive'};
    if(base&&rightChanged&&!leftChanged)return {...current,direction:'to_r2'};
    return {...current,conflict:left.hash===right.hash?'metadata':'both_modified'};
  }
  async function buildJob(pair) {
    const pending=(await read('_cloud-sync/test-pending.json'))?.value;
    if(pending){await cleanTest(pair,pending.path);await bucket.delete('_cloud-sync/test-pending.json');}
    const [manifest,meta,localRows,bases]=await Promise.all([peerJson(pair,'manifest'),peerJson(pair,'metadata'),h.listMedia(bucket),read(BASE)]);
    const links=new Map(),details=new Map((meta.snapshot?.files||[]).map(d=>[caseFold(d.relative_path),d])),folders=new Map(),unassignedFiles=[];
    const patients=new Map();
    for(let offset=0;;offset+=1000){const page=await h.database(auth.token,`/rest/v1/patients?select=id,name,patient_number&limit=1000&offset=${offset}`,fetcher);for(const p of page)patients.set(p.id,p);if(page.length<1000)break;}
    for(const d of details.values())if(d.patient_id&&!folders.has(d.patient_id))folders.set(d.patient_id,d.relative_path.split('/')[0]);
    const localPaths=new Set(localRows.map(row=>caseFold(row.key.slice(9))));
    for(const [key,base]of Object.entries(bases?.value||{}))if(base.summary||base.kept)links.set(key,{key,patientId:base.patientId,r2Path:base.r2Path,drivePath:base.drivePath});
    for(const record of Object.values(manifest.files||{})) {
      const d=details.get(caseFold(record.path));if(!d?.patient_id){if(!record.deleted)unassignedFiles.push({path:record.path,size:record.size,sha256:record.sha256});continue;}
      const canonical=h.safePath(`${d.patient_id}/${record.path.split('/').slice(1).join('/')}`),key=caseFold(canonical),existing=links.get(key);
      if(record.deleted&&!existing&&!localPaths.has(key))continue;
      if(existing?.seenDrive&&existing.drivePath!==record.path)fail('Duplicate patient file names require review.',409,'name_collision');
      links.set(key,{...existing,key,patientId:d.patient_id,r2Path:existing?.r2Path||canonical,drivePath:record.path,seenDrive:true});
    }
    for(const row of localRows) {
      const canonical=h.safePath(row.key.slice(9)),key=caseFold(canonical),existing=links.get(key),patientId=canonical.split('/')[0];
      if(existing?.seenR2&&existing.r2Path!==canonical)fail('Duplicate R2 file names require review.',409,'name_collision');
      const patient=patients.get(patientId);if(!patient)fail('Patient is unavailable. Review the patient records before syncing.',409,'patient_changed');
      let folder=folders.get(patientId)||(await patientFolder(bucket,patient)).folder;
      if([...folders].some(([id,name])=>id!==patientId&&caseFold(name)===caseFold(folder)))folder+=`_${patient.patient_number||patientId.slice(0,8)}`;
      const target=existing?.drivePath||drivePath(`${folder}/${canonical.split('/').slice(1).join('/')}`);
      links.set(key,{...existing,key,patientId,r2Path:canonical,drivePath:target,seenR2:true});
    }
    const inventory=[];
    for(let offset=0;;offset+=1000) {
      const page=await h.database(auth.token,`/rest/v1/inventory_item_images?select=item_id,revision&order=item_id&limit=1000&offset=${offset}`,fetcher);
      for(const image of page)inventory.push({kind:'inventory',itemId:image.item_id,revision:image.revision});
      if(page.length<1000)break;
    }
    const items=[...inventory,...[...links.values()].map(({seenDrive,seenR2,...item})=>item)];
    return {id:crypto.randomUUID(),peerId:pair.peerId,status:items.length?'running':'completed',phase:items.length?'syncing':'finished',progressByFiles:true,items,totalFiles:items.length,completedFiles:0,totalBytes:0,transferredBytes:0,conflicts:[],unassignedFiles,metadataStatus:items.length?'pending':'current',createdAt:new Date().toISOString(),verifiedFiles:0};
  }
  async function info() {
    const pair=await settings();
    const response=await fetcher(`${DRIVE}/api/sync/info${pair?.nodeId?`?peer=${pair.nodeId}`:''}`,{headers:{Authorization:`Bearer ${auth.token}`},signal:AbortSignal.timeout(20000)});
    if(!response.ok)fail('Google Drive is unavailable. Reconnect it before syncing.',response.status,'drive_unavailable');
    const remote=await response.json(),paired=Boolean(pair?.paired&&pair.peerId===remote.nodeId&&remote.pair?.peerId===pair.nodeId);
    return {nodeId:pair?.nodeId||'unpaired-r2',protocol:1,fileScope:'patient-files-v1',clinicalMetadataVersion:2,pair:paired?{peerId:remote.nodeId,role:'coordinator'}:null,peer:{...remote,pair:paired?{peerId:pair.nodeId,role:'replica'}:null}};
  }
  if(route==='info'&&request.method==='GET')return info();
  if(route.startsWith('layout/'))return layoutRoute(route,request,{...ctx,locked,refreshCatalog,resolveCopiedConflict});
  if(route==='pair'&&request.method==='POST')return locked(async()=>{
    const body=await request.json();if(body.url&&body.url.replace(/\/+$/,'')!==DRIVE)fail('Choose Google Drive and Cloudflare R2.',400,'invalid_peer');
    const old=await settings(),pair=old||{nodeId:crypto.randomUUID(),secret:crypto.randomUUID()+crypto.randomUUID()};
    const remote=await info();
    const response=await fetcher(`${DRIVE}/api/sync/pair/accept`,{method:'POST',headers:{Authorization:`Bearer ${auth.token}`,'Content-Type':'application/json'},body:JSON.stringify({peerId:pair.nodeId,secret:pair.secret}),signal:AbortSignal.timeout(20000)});
    if(!response.ok)fail('Google Drive pairing failed.',response.status,'pair_failed');
    pair.peerId=remote.peer.nodeId;pair.paired=true;await save(CONFIG,pair);return {paired:true,peerId:pair.peerId};
  });
  if(route==='jobs/latest'&&request.method==='GET')return {job:publicJob((await read(JOB))?.value)};
  if(route==='unassigned/delete'&&request.method==='POST')return locked(async()=>{
    const job=(await read(JOB))?.value,body=await request.json();
    if(!job||job.status==='running')fail('Finish the current sync before reviewing unassigned files.',409,'sync_busy');
    if(!Array.isArray(body.paths)||!body.paths.length||body.paths.length>1000||new Set(body.paths).size!==body.paths.length)fail('Choose the unassigned files to remove.',400);
    const pair=await connection(),[manifest,meta]=await Promise.all([peerJson(pair,'manifest'),peerJson(pair,'metadata')]);
    const known=new Map((job.unassignedFiles||[]).map(f=>[f.path,f])),mapped=new Set((meta.snapshot?.files||[]).filter(d=>d.patient_id).map(d=>caseFold(d.relative_path)));
    const records=body.paths.map(path=>{
      const expected=known.get(path),record=Object.values(manifest.files||{}).find(r=>r.path===path);
      if(!expected||mapped.has(caseFold(path))||!record||(!record.deleted&&record.sha256!==expected.sha256))fail('An unassigned file changed or now belongs to a patient. Run sync again before removing it.');
      return record;
    });
    // A manual Drive copy may contain the same unassigned files. Preserve those
    // exact originals in recovery too; never touch a linked or differing copy.
    const assignedKeys=new Set((await h.listMedia(bucket)).map(row=>row.storageKey)),copied=[];
    for(const record of records) {
      const key=MEDIA_ROOT+drivePath(record.path),source=await bucket.get(key);
      if(!source)continue;
      if(assignedKeys.has(key))fail('An R2 copy now belongs to a patient. Refresh the folders before removing it.');
      const bytes=new Uint8Array(await source.arrayBuffer()),digest=await sha256(bytes);
      if(digest!==known.get(record.path).sha256)fail('A copied R2 file differs from the unassigned Drive original. Both files were preserved for review.');
      copied.push({source,bytes,digest,path:record.path});
    }
    for(const item of copied) {
      const root=`_recovery/unassigned-${crypto.randomUUID()}`;
      await bucket.put(`${root}/original`,item.bytes,{httpMetadata:item.source.httpMetadata,customMetadata:{...item.source.customMetadata,sha256:item.digest}});
      await save(`${root}/details.json`,{sourceKey:item.source.key,drivePath:item.path,sha256:item.digest,size:item.bytes.length,reason:'unassigned-file-cleanup',archivedAt:new Date().toISOString()});
      const verified=await bucket.get(`${root}/original`);
      if(!verified||await sha256(new Uint8Array(await verified.arrayBuffer()))!==item.digest)fail('The unassigned R2 original could not be preserved. Active files were left untouched.');
      item.recoveryRoot=root;
    }
    let removed=0;
    for(const record of records)if(!record.deleted){await peerJson(pair,'record','POST',{record:{...record,deleted:true,sha256:null,size:0,clock:{...record.clock,[pair.nodeId]:(record.clock[pair.nodeId]||0)+1}},expected:record});removed++;}
    for(const item of copied) {
      if((await bucket.head(item.source.key))?.etag!==item.source.etag)fail('An unassigned R2 copy changed during cleanup. Its active copy was preserved.');
      await bucket.delete(item.source.key);
      (job.archivedUnassignedR2||=[]).push({path:item.path,recoveryRoot:item.recoveryRoot});
    }
    job.unassignedFiles=job.unassignedFiles.filter(f=>!body.paths.includes(f.path));
    job.removedUnassignedFiles=(job.removedUnassignedFiles||0)+removed;await save(JOB,job);
    return {removed,job:publicJob(job)};
  });
  if(route==='jobs'&&request.method==='POST')return locked(async()=>{
    const previous=(await read(JOB))?.value,pair=await connection();if(previous?.status==='running')return publicJob(previous);
    if(previous?.status==='failed'&&previous.peerId===pair.peerId&&Array.isArray(previous.items)&&Number.isInteger(previous.completedFiles)&&previous.completedFiles>=0&&previous.completedFiles<previous.items.length) {
      previous.status='running';previous.phase='syncing';
      delete previous.error;delete previous.errorStatus;delete previous.errorCode;
      await save(JOB,previous);return publicJob(previous);
    }
    if(previous?.conflicts?.some(c=>!c.reviewed))fail('Review cloud sync differences before starting another sync.',409,'review_pending');
    const job=await buildJob(pair);await save(JOB,job);return publicJob(job);
  });
  const step=route.match(/^jobs\/([^/]+)\/step$/);
  if(step&&request.method==='POST')return locked(async()=>{
    if((await read('_layout/job.json'))?.status==='running')fail('Patient folders are being organized. Sync will resume when that finishes.',409,'sync_busy');
    const job=(await read(JOB))?.value;if(!job||job.id!==step[1])fail('Sync job not found.',404);
    if(job.status!=='running')return publicJob(job);
    try {
      const pair=await connection(),item=job.items[job.completedFiles];
      if(item.kind==='inventory') {
        const response=await fetcher(`${globalThis.LuminPublicConfig.supabaseUrl}/functions/v1/inventory-images/${item.itemId}/sync?v=${encodeURIComponent(item.revision)}`,{method:'POST',headers:{Authorization:`Bearer ${auth.token}`},signal:AbortSignal.timeout(100000)});
        const result=await response.json();if(!response.ok||!result.success)fail(result.error||'Inventory photos could not be synchronized.',response.status,result.code||'inventory_sync_failed');
        job.transferredBytes+=result.transferredBytes||0;job.totalBytes+=result.transferredBytes||0;job.verifiedFiles++;job.verifiedInventoryPhotos=(job.verifiedInventoryPhotos||0)+1;
      }else {
      const bases=(await read(BASE))?.value||{},result=await inspect(item,pair,bases);
      if(result.conflict)job.conflicts.push({path:item.r2Path,kind:result.conflict,item,reviewed:false});
      else if(result.direction==='exception')job.keptDifferences=(job.keptDifferences||0)+1;
      else {
        let transferred=0;
        if(result.direction==='to_r2')transferred=await copyToR2(item,pair,result);
        else if(result.direction==='to_drive')transferred=await copyToDrive(item,pair,result);
        await remember(item,pair);job.transferredBytes+=transferred;job.totalBytes+=transferred;job.verifiedFiles++;
      }
      }
      job.completedFiles++;
      if(job.completedFiles===job.totalFiles){job.status=job.conflicts.length?'completed_with_conflicts':'completed';job.phase='finished';job.metadataStatus=job.conflicts.length?'review':job.keptDifferences?'exceptions':'current';job.finishedAt=new Date().toISOString();}
    }catch(error){job.status='failed';job.phase='failed';job.error=error.message;job.errorStatus=error.status||503;job.errorCode=error.code||'sync_failed';}
    await save(JOB,job);return publicJob(job);
  });
  const review=route.match(/^jobs\/([^/]+)\/conflicts\/(\d+)(?:\/file)?$/);
  if(review)return locked(async()=>{
    const job=(await read(JOB))?.value,conflict=job?.conflicts?.[Number(review[2])];
    if(!job||job.id!==review[1]||!conflict)fail('Comparison not found.',404);
    const pair=await connection(),current=await sides(conflict.item,pair);
    const revision=await sha256(JSON.stringify([summary(current.local),current.local.object?.etag,current.local.meta?.object.etag,current.remote.record,annotationSignature(current.remote.details)]));
    if(route.endsWith('/file')&&request.method==='GET') {
      if(url.searchParams.get('revision')!==revision)fail('Files changed while reviewing. Reload the comparison.');
      const side=url.searchParams.get('side');if(!['local','remote'].includes(side)||!live(current[side]))fail('File not found.',404);
      const source=side==='local'?await bucket.get(current.local.object.key,{onlyIf:{etagMatches:current.local.object.etag}}):await peer(pair,`file?path=${encodeURIComponent(current.remote.path)}&sha256=${current.remote.record.sha256}`);
      if(!source||!('body'in source))fail('File changed while downloading.');
      return new Response(source.body,{headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Type':h.types[current[side].path.split('.').at(-1).toLowerCase()]||'application/octet-stream'}});
    }
    if(request.method==='GET')return {path:conflict.path,kind:conflict.kind,revision,reviewed:conflict.reviewed,resolution:conflict.resolution,versions:{local:current.local.record,remote:current.remote.record},details:{local:current.local.details,remote:current.remote.details},actions:conflict.kind==='file_too_large'?['keep_both']:[...(live(current.local)?['keep_local']:[]),...(live(current.remote)?['keep_remote']:[]),'keep_both']};
    if(request.method!=='POST')fail('Method not allowed.',405);
    const body=await request.json();if(body.revision!==revision)fail('Files changed while reviewing. Reload the comparison.');
    if(conflict.reviewed)return {job:publicJob(job)};
    if(body.action==='keep_local')await copyToDrive(conflict.item,pair,current);
    else if(body.action==='keep_remote')await copyToR2(conflict.item,pair,current);
    else if(body.action!=='keep_both')fail('Choose a valid resolution.',400);
    // Keeping both leaves a durable explicit exception; a later edit is reviewed again.
    if(body.action==='keep_both') {
      const bases=(await read(BASE))?.value||{};bases[conflict.item.key]={...conflict.item,summary:null,kept:{local:summary(current.local),remote:summary(current.remote)}};await save(BASE,bases);
    }else {await remember(conflict.item,pair);job.verifiedFiles++;}
    conflict.reviewed=true;conflict.resolution=body.action;
    if(job.conflicts.every(c=>c.reviewed)){job.metadataStatus=job.conflicts.some(c=>c.resolution==='keep_both')?'exceptions':'current';job.status='completed';}
    await save(JOB,job);return {job:publicJob(job)};
  });
  if(route==='verify'&&request.method==='POST')return locked(async()=>{
    const pair=await connection(),id=crypto.randomUUID(),path=`Lumin_Sync_Verification/General/${id}.png`,key=`_checks/${id}`,bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),c=>c.charCodeAt(0)),digest=await sha256(bytes);
    const record={path,sha256:digest,size:bytes.length,deleted:false,clock:{[pair.nodeId]:1}};
    const pending=(await read('_cloud-sync/test-pending.json'))?.value;
    if(pending){await cleanTest(pair,pending.path);await bucket.delete('_cloud-sync/test-pending.json');}
    await save('_cloud-sync/test-pending.json',{path,id});
    let result;
    try {
      await bucket.put(`${key}/source.png`,bytes);
      const source=await bucket.get(`${key}/source.png`),outbound=new Uint8Array(await source.arrayBuffer());
      await peerJson(pair,'file','PUT',outbound,{'x-lumin-sync-meta':bytes64(new TextEncoder().encode(JSON.stringify({record,expected:null}))),'Content-Type':'application/octet-stream'});
      const remote=await peerJson(pair,`review-record?path=${encodeURIComponent(path)}`);if(remote.record?.sha256!==digest)fail('Google Drive checksum verification failed.',409,'verification_failed');
      const returned=new Uint8Array(await (await peer(pair,`file?path=${encodeURIComponent(path)}&sha256=${digest}`)).arrayBuffer());
      await bucket.put(`${key}/returned.png`,returned);const back=await bucket.get(`${key}/returned.png`);
      if(await sha256(new Uint8Array(await back.arrayBuffer()))!==digest)fail('Round-trip checksum verification failed.',409,'verification_failed');
      result={success:true,directions:['r2_to_drive','drive_to_r2'],sha256:digest,bytes:bytes.length,verifiedAt:new Date().toISOString()};
    }finally{
      try{await cleanTest(pair,path);await bucket.delete('_cloud-sync/test-pending.json');}
      finally{await bucket.delete(`${key}/source.png`);await bucket.delete(`${key}/returned.png`);}
    }
    await save('_cloud-sync/verification.json',result);return result;
  });
  fail('Cloud sync operation not found.',404,'unsupported_operation');
}
