const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
let chromium;try{({chromium}=require('playwright'))}catch(_){}
const html=fs.readFileSync('index.html','utf8');
function source(name){
  const start=html.search(new RegExp('    (?:async )?function '+name+'\\('));
  assert.ok(start>=0,name);return html.slice(start,html.indexOf('\n    }',start)+6);
}
function fixture(){
  const requests=[],stored=new Map([['lumin_storage_secret_key','legacy-secret']]);
  const grants=new Map(),keys=new Map();
  const ctx=vm.createContext({URL,Date,AbortSignal,currentUiLanguage:'en',clinicStorageServerUrl:'https://storage.test',clinicStorageSecretKey:'memory-only-secret',
    storageMediaGrants:grants,storagePresetKeys:keys,storageMediaGrantGeneration:0,
    window:{},localStorage:{getItem:k=>stored.get(k)||null,removeItem:k=>stored.delete(k)},
    fetch:async(url,init)=>{requests.push({url,init});return Response.json({mediaGrant:'m'.repeat(43),expiresAt:Date.now()+900000})}
  });
  vm.runInContext(['getStorageServerConfig','ensureStorageMediaGrant','storageMediaUrl','clearStorageCredentials'].map(source).join('\n'),ctx);
  return{ctx,requests,stored,grants};
}
test('media grants coalesce, stay in memory, and never put reusable keys in URLs',async()=>{
  const f=fixture();
  assert.equal(f.ctx.getStorageServerConfig().key,'memory-only-secret');
  await Promise.all([f.ctx.ensureStorageMediaGrant(),f.ctx.ensureStorageMediaGrant()]);
  assert.equal(f.requests.length,1);
  const url=new URL(f.ctx.storageMediaUrl('https://storage.test/files/film.png'));
  assert.equal(url.searchParams.get('media'),'m'.repeat(43));assert.equal(url.searchParams.has('key'),false);
  assert.doesNotMatch(url.toString(),/memory-only-secret|legacy-secret/);
  f.ctx.clearStorageCredentials();
  assert.equal(f.grants.size,0);assert.equal(f.stored.has('lumin_storage_secret_key'),false);
  assert.equal(f.ctx.getStorageServerConfig().key,'');
  assert.ok(f.requests.some(r=>r.url.endsWith('/revoke')));
});
test('a grant arriving after logout is revoked and cannot repopulate session state',async()=>{
  const f=fixture();let release;
  f.ctx.fetch=(url,init)=>url.endsWith('/revoke')?(f.requests.push({url,init}),Promise.resolve(Response.json({success:true}))):new Promise(resolve=>{release=resolve});
  const pending=f.ctx.ensureStorageMediaGrant();f.ctx.clearStorageCredentials();
  release(Response.json({mediaGrant:'n'.repeat(43),expiresAt:Date.now()+900000}));await pending;
  assert.equal(f.grants.size,0);assert.ok(f.requests.some(r=>r.url.endsWith('/revoke')));
});
test('downloads use authorization headers and a blob URL rather than exposing the reusable key',async()=>{
  const f=fixture(),links=[];
  f.ctx.currentSession={user:{id:'staff'}};f.ctx.hasPageAccess=()=>true;
  f.ctx.patientMediaFileUrl=()=> 'https://storage.test/files/film.png';
  f.ctx.patientMediaDownloadName=()=> 'clinical.png';
  f.ctx.document={body:{append(){}},createElement:()=>({click(){links.push({href:this.href,download:this.download})},remove(){}})};
  f.ctx.setTimeout=fn=>fn();f.ctx.showAppointmentNotificationToast=message=>assert.fail(message);
  f.ctx.fetch=async(url,init)=>{f.requests.push({url,init});return url.endsWith('/api/media-grant')?Response.json({mediaGrant:'m'.repeat(43),expiresAt:Date.now()+900000}):new Response('fixture-image')};
  vm.runInContext(source('downloadPatientMediaFile'),f.ctx);
  await f.ctx.downloadPatientMediaFile({relativePath:'film.png'},{preventDefault(){}});
  const request=f.requests.find(r=>r.url.endsWith('/files/film.png'));
  assert.equal(request.init.headers['x-lumin-key'],'memory-only-secret');assert.equal(new URL(request.url).search,'');
  assert.equal(links.length,1);assert.match(links[0].href,/^blob:/);assert.equal(links[0].download,'clinical.png');
});

test('switching servers during grant renewal cancels the download without sending the old key',async()=>{
  const f=fixture();let release;
  f.ctx.currentSession={user:{id:'staff'}};f.ctx.hasPageAccess=()=>true;
  f.ctx.fetch=(url,init)=>{f.requests.push({url,init});return new Promise(resolve=>{release=resolve})};
  f.ctx.showAppointmentNotificationToast=message=>assert.fail(message);
  vm.runInContext(source('downloadPatientMediaFile'),f.ctx);
  const pending=f.ctx.downloadPatientMediaFile({relativePath:'film.png'},{preventDefault(){}});
  f.ctx.clinicStorageServerUrl='https://other-storage.test';
  release(Response.json({mediaGrant:'m'.repeat(43),expiresAt:Date.now()+900000}));
  await pending;
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].url,'https://storage.test/api/media-grant');
});
test('folder selection keeps quotes, backslashes and injected text as data', {skip:!chromium && 'Playwright unavailable'},async t=>{
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||undefined});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.setContent('<div id="change-storage-browser-current"></div><div id="change-storage-subfolders-list"></div><button id="btn-storage-browser-up"></button>');
  const path="C:\\Patients\\O'Brien');window.marker=1;('";
  await page.addScriptTag({content:`
    let currentUiLanguage='en',currentSession={access_token:'fixture'},storageBrowserCurrentPath='',storageBrowserParentPath='';
    function getStorageServerConfig(){return{url:'https://fixture.invalid',key:'memory-key'}}
    function selectBrowserPath(path){window.selected=path}
    window.marker=0;
    const fetch=async()=>({ok:true,json:async()=>({currentPath:'C:/Patients',parentPath:'C:/',subfolders:[{name:'Quoted folder',path:${JSON.stringify(path)}}]})});
    ${source('escapeHtml')}
    ${source('browseStorageFolder')}
  `});
  await page.evaluate(()=>browseStorageFolder('C:\\Patients'));
  await page.locator('[data-storage-select-path]').click();
  assert.equal(await page.evaluate(()=>window.selected),path);assert.equal(await page.evaluate(()=>window.marker),0);
});
