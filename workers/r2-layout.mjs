import {cleanName,caseFold,sha256} from '../supabase/functions/google-drive/core.ts';

export const MEDIA_ROOT='Lumin Clinic/';
const INDEX='_layout/patients.json',JOB='_layout/job.json';
const CATALOG='_layout/drive-catalog.json';
const readJson=async(bucket,key)=>{const object=await bucket.get(key);return object?await object.json():null;};
const indexBody=patients=>JSON.stringify({version:2,patients});
const validId=value=>typeof value==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
const validFolder=value=>typeof value==='string'&&value.length>0&&!value.startsWith('.')&&!/[\/\\\x00-\x1f]/.test(value);
// Recover folder ownership from recorded Drive identities, never from a name guess.
export async function seedKnownFolders(bucket,catalog) {
  const [bases,cloudJob,savedCatalog]=await Promise.all([readJson(bucket,'_cloud-sync/baselines.json'),readJson(bucket,'_cloud-sync/job.json'),catalog?Promise.resolve(catalog):readJson(bucket,CATALOG)]);
  const references=new Map(),owners=new Map(),patientNames=new Map((savedCatalog?.snapshot?.patients||[]).map(p=>[p.id,p.name]));
  const add=(id,path)=>{
    const folder=typeof path==='string'?path.split('/')[0]:'';
    if(!validId(id)||!validFolder(folder))return;
    const key=caseFold(folder),owner=owners.get(key);
    if(owner&&owner!==id)throw new Error('Stored Drive folders have conflicting patient identities. Review those folders before importing.');
    owners.set(key,id);
    const entry=references.get(id)||{folders:[],folder};
    if(!entry.folders.includes(folder))entry.folders.push(folder);
    entry.folder=folder;references.set(id,entry);
  };
  for(const item of [...Object.values(bases||{}),...(cloudJob?.items||[])])add(item.patientId,item.drivePath);
  for(const details of savedCatalog?.snapshot?.files||[])add(details.patient_id,details.relative_path);
  for(let attempt=0;attempt<6;attempt++) {
    const object=await bucket.get(INDEX),saved=object?await object.json():{},patients=saved?.version===2?saved.patients||{}:saved;
    for(const [id,entry] of Object.entries(patients))for(const folder of [entry.folder,...(entry.aliases||[])]) {
      if(owners.has(caseFold(folder))&&owners.get(caseFold(folder))!==id&&(await bucket.list({prefix:MEDIA_ROOT+folder+'/',limit:1})).objects.length)throw new Error('A named folder is claimed by two patient identities. Its files were preserved for review.');
    }
    for(const [id,reference] of references) {
      const old=patients[id],folder=old?.namePreferred?old.folder:reference.folder,aliases=[...(old?.aliases||[]),...(old?.folder?[old.folder]:[]),...reference.folders];
      patients[id]={...old,folder,patientName:old?.patientName||patientNames.get(id)||'',driveFolder:reference.folder,namePreferred:Boolean(old?.namePreferred&&folder!==reference.folder),
        aliases:[...new Set(aliases)].filter(name=>name!==folder&&(!owners.has(caseFold(name))||owners.get(caseFold(name))===id))};
    }
    const result=await bucket.put(INDEX,indexBody(patients),{httpMetadata:{contentType:'application/json'},onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
    if(result)return {object:result,patients};
  }
  throw new Error('Patient folder index changed. Please retry.');
}
const readIndex=async bucket=>{
  const object=await bucket.get(INDEX),saved=object?await object.json():null;
  return saved?.version===2?{object,patients:saved.patients||{}}:seedKnownFolders(bucket);
};
export async function patientFolder(bucket,patient,hint) {
  for(let attempt=0;attempt<6;attempt++) {
    const {object,patients}=await readIndex(bucket),old=patients[patient.id];
    if(old && old.patientName===patient.name && (!hint || caseFold(old.folder)===caseFold(cleanName(hint)) || old.aliases?.some(name=>caseFold(name)===caseFold(cleanName(hint)))))return old;
    let folder=cleanName(hint || (old&&(!old.patientName||old.patientName===patient.name)?old.driveFolder:'') || patient.name || 'Patient');
    if(!folder)folder='Patient';
    if(!old&&!hint&&(await bucket.list({prefix:MEDIA_ROOT+folder+'/',limit:1})).objects.length)folder+=`_${patient.patient_number||patient.id.slice(0,8)}`;
    if(Object.entries(patients).some(([id,value])=>id!==patient.id&&[value.folder,...(value.aliases||[])].some(name=>caseFold(name)===caseFold(folder))))folder+=`_${patient.patient_number||patient.id.slice(0,8)}`;
    const entry={folder,patientName:patient.name,namePreferred:Boolean(old?.namePreferred||(!hint&&old?.patientName&&old.patientName!==patient.name)),...(hint?{driveFolder:folder}:old?.driveFolder?{driveFolder:old.driveFolder}:{}),aliases:[...new Set([...(old?.aliases||[]),...(old&&old.folder!==folder?[old.folder]:[])])].filter(name=>name!==folder)};
    patients[patient.id]=entry;
    const saved=await bucket.put(INDEX,indexBody(patients),{httpMetadata:{contentType:'application/json'},onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
    if(saved)return entry;
  }
  throw new Error('Patient folder changed. Please retry.');
}
export async function readableKey(bucket,path,patient,hint) {
  const folder=await patientFolder(bucket,patient,hint);
  return MEDIA_ROOT+folder.folder+'/'+path.split('/').slice(1).join('/');
}
export async function mediaObject(bucket,path,patient,options={},hint) {
  const folder=await patientFolder(bucket,patient,hint),tail=path.split('/').slice(1).join('/');
  for(const key of [MEDIA_ROOT+folder.folder+'/'+tail,...(folder.aliases||[]).map(name=>MEDIA_ROOT+name+'/'+tail),'patients/'+path]) {
    const object=await bucket.get(key,options);if(object)return object;
  }
  return null;
}
export async function mediaRows(bucket,list,patientId,includeDuplicates=false) {
  const {patients}=await readIndex(bucket),folders=new Map();
  for(const [id,entry] of Object.entries(patients))for(const folder of [entry.folder,...(entry.aliases||[])])folders.set(folder,id);
  const prefixes=patientId?[...(patients[patientId]?[patients[patientId].folder,...(patients[patientId].aliases||[])].map(folder=>MEDIA_ROOT+folder+'/'):[]),'patients/'+patientId+'/']:[MEDIA_ROOT,'patients/'];
  const result=new Map(),all=[];
  for(const prefix of prefixes)for(const object of await list(bucket,prefix,['customMetadata'])) {
    let canonical;
    if(object.key.startsWith('patients/'))canonical=object.key.slice(9);
    else {
      const parts=object.key.slice(MEDIA_ROOT.length).split('/'),id=folders.get(parts[0]);
      if(!id)continue;
      canonical=id+'/'+parts.slice(1).join('/');
    }
    if(patientId&&canonical.split('/')[0]!==patientId)continue;
    const key=caseFold(canonical);
    const row={...object,key:'patients/'+canonical,storageKey:object.key,relativePath:canonical};
    all.push(row);if(!result.has(key))result.set(key,row);
  }
  return includeDuplicates?all:[...result.values()];
}
export async function layoutRoute(route,request,ctx) {
  const {bucket,auth,fetcher,helpers:h,locked,refreshCatalog,resolveCopiedConflict}=ctx;
  const fail=(message,status=409)=>{throw new h.StorageError(message,status,'layout_changed');};
  const read=async key=>{const object=await bucket.get(key);return object?await object.json():null;};
  const save=(key,value)=>bucket.put(key,JSON.stringify(value),{httpMetadata:{contentType:'application/json'}});
  const publicJob=job=>{if(!job)return null;const {items,...view}=job;return view;};
  if(route==='layout/jobs/latest'&&request.method==='GET')return {job:publicJob(await read(JOB))};
  if(route==='layout/jobs'&&request.method==='POST')return locked(async()=>{
    const old=await read(JOB);if(old?.version===2&&old.status==='running')return publicJob(old);
    const catalog=refreshCatalog?await refreshCatalog():await read(CATALOG);
    const [rows,bases,cloudJob]=await Promise.all([mediaRows(bucket,h.records,undefined,true),read('_cloud-sync/baselines.json'),read('_cloud-sync/job.json')]);
    const hints=new Map();
    for(const item of [...Object.values(bases||{}),...(cloudJob?.items||[])])if(item.patientId&&item.drivePath)hints.set(item.patientId,item.drivePath.split('/')[0]);
    const annotations=new Map((catalog?.snapshot?.files||[]).map(d=>[caseFold(d.patient_id+'/'+d.relative_path.split('/').slice(1).join('/')),d]));
    const items=rows.filter(row=>{try{h.safePath(row.relativePath);return true;}catch(_){return false;}}).map(row=>{
      const details=annotations.get(caseFold(row.relativePath));
      return {path:row.relativePath,sourceKey:row.storageKey,etag:row.etag,size:row.size,hint:details?.relative_path.split('/')[0]||hints.get(row.relativePath.split('/')[0])||'',
        expectedHash:details?(catalog?.records?.[caseFold(details.relative_path)]?.sha256||''):'',details:details||null};
    });
    const knownKeys=new Set(rows.map(row=>row.storageKey)),raw=await h.records(bucket,MEDIA_ROOT);
    const unlinked=raw.filter(row=>{
      if(knownKeys.has(row.key))return false;
      const parts=row.key.slice(MEDIA_ROOT.length).split('/');
      if(parts[0]?.startsWith('.')||['Inventory','Lumin_Sync_Verification'].includes(parts[0]))return false;
      try{h.safePath('00000000-0000-0000-0000-000000000000/'+parts.slice(1).join('/'));return true;}catch(_){return false;}
    });
    const job={version:2,id:crypto.randomUUID(),status:items.length?'running':'completed',totalFiles:items.length,completedFiles:0,movedFiles:0,restoredDetails:0,unlinkedFiles:unlinked.length,unlinkedFolders:[...new Set(unlinked.map(row=>row.key.slice(MEDIA_ROOT.length).split('/')[0]))],root:'Lumin Clinic',items,createdAt:new Date().toISOString()};
    await save(JOB,job);return publicJob(job);
  });
  const step=route.match(/^layout\/jobs\/([^/]+)\/step$/);
  if(step&&request.method==='POST')return locked(async()=>{
    const job=await read(JOB);if(!job||job.id!==step[1])fail('Folder organization job not found.',404);
    if(job.status!=='running')return publicJob(job);
    try {
      const item=job.items[job.completedFiles],patient=await h.patientFor(auth.token,item.path.split('/')[0],fetcher),target=await readableKey(bucket,item.path,patient,item.hint);
      const source=await bucket.get(item.sourceKey);
      if(!source||source.etag!==item.etag)fail('A file changed while its patient folder was being checked. Retry the operation.');
      const needsHash=target!==item.sourceKey||Boolean(item.expectedHash);
      const bytes=needsHash?new Uint8Array(await source.arrayBuffer()):null,digest=bytes?await sha256(bytes):'';
      if(item.expectedHash&&digest!==item.expectedHash)fail('A copied file differs from its recorded Drive original. The file and clinical details were preserved for review.');
      if(target!==item.sourceKey) {
        const existing=await bucket.get(target);
        if(existing) {
          if(await sha256(new Uint8Array(await existing.arrayBuffer()))!==digest)fail('A different file already exists in the named patient folder. Both copies were preserved.');
        }else {
          const result=await bucket.put(target,bytes,{httpMetadata:source.httpMetadata,customMetadata:{...source.customMetadata,sha256:digest},onlyIf:{etagDoesNotMatch:'*'}});
          if(!result)fail('A patient folder changed during organization. Both copies were preserved.');
        }
        const verified=await bucket.get(target);
        if(!verified||verified.size!==source.size||await sha256(new Uint8Array(await verified.arrayBuffer()))!==digest)fail('The named copy could not be verified. The original was preserved.');
        const unchanged=await bucket.head(item.sourceKey);if(unchanged?.etag!==source.etag)fail('The original changed during organization. Both copies were preserved.');
        await bucket.delete(item.sourceKey);job.movedFiles++;
      }
      const metadataKey='metadata/'+item.path+'.json';
      let currentDetails=await read(metadataKey);
      if(!currentDetails) {
        const details=h.detailsFor(item.path,patient,item.details||{display_name:item.path.split('/').at(-1)});
        await h.putDetails(bucket,item.path,details);currentDetails=details;job.restoredDetails=(job.restoredDetails||0)+1;
      }
      if(item.expectedHash&&item.details&&resolveCopiedConflict)await resolveCopiedConflict(item,currentDetails,digest);
      job.completedFiles++;if(job.completedFiles===job.totalFiles){job.status='completed';job.finishedAt=new Date().toISOString();}
    }catch(error){job.status='failed';job.error=error.message;}
    await save(JOB,job);return publicJob(job);
  });
  fail('Folder organization operation not found.',404);
}
