const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const syncSource = fs.readFileSync(path.join(root, 'lumin-storage-sync.js'), 'utf8');

test('progress is indeterminate during scans, byte-based for transfers, operation-based for deletions, and reaches 100 only after completion', () => {
  const ctx = vm.createContext({window:{addEventListener(){}}, document:{addEventListener(){}}, currentUiLanguage:'en'});
  vm.runInContext(syncSource.replace('window.LuminStorageSync =', 'window.syncProgress = progress; window.LuminStorageSync ='), ctx);
  const p = job => ctx.window.syncProgress(job);
  assert.equal(p({status:'running',phase:'scanning'}).indeterminate, true);
  assert.equal(p({status:'running',phase:'syncing',totalBytes:1000,transferredBytes:250,totalFiles:2,completedFiles:1}).percent,25);
  assert.equal(p({status:'running',phase:'deleting',totalBytes:0,totalFiles:4,completedFiles:1}).percent,25);
  assert.equal(p({status:'running',phase:'verifying',totalBytes:100,transferredBytes:100}).percent,99);
  assert.equal(p({status:'failed',totalBytes:100,transferredBytes:50}).percent,50);
  assert.equal(p({status:'completed',totalBytes:0,totalFiles:0}).percent,100);
  assert.equal(p({status:'completed_with_conflicts',totalBytes:100,transferredBytes:100}).percent,100);
});

test('missing sync endpoints explain that both server processes need updating and restarting in English and Arabic', () => {
  const ctx = vm.createContext({window:{addEventListener(){}}, document:{addEventListener(){}}, currentUiLanguage:'en'});
  vm.runInContext(syncSource.replace('window.LuminStorageSync =', 'window.syncErrorText = errorText; window.LuminStorageSync ='), ctx);
  const error = Object.assign(new Error('Storage request failed (HTTP 404).'), {status:404});
  assert.equal(ctx.window.syncErrorText(error), 'Update and restart the storage server on both computers, then try pairing again.');
  ctx.currentUiLanguage = 'ar';
  assert.equal(ctx.window.syncErrorText(error), 'حدّث خادم التخزين وأعد تشغيله على الجهازين، ثم حاول الاقتران مجدداً.');
});

let chromium;
try { ({chromium}=require('playwright')); } catch (_) {}
test('Storage Server panel pairs once, syncs in one click, restores progress, retries, and supports responsive Arabic/English controls', {skip:!chromium && 'Playwright unavailable'}, async t => {
  const fixture = fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  const server = http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fixture);return;}
    const target=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!target.startsWith(root+path.sep)||!fs.existsSync(target)||!fs.statSync(target).isFile()){res.statusCode=404;res.end();return;}
    res.setHeader('Content-Type',target.endsWith('.css')?'text/css':target.endsWith('.js')?'application/javascript':'application/octet-stream');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||undefined});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  let paired=false,job=null,starts=0,pairs=0,statusRequests=0;
  const newJob=()=>({id:'job-1',status:'running',phase:'scanning',totalBytes:0,transferredBytes:0,totalFiles:0,completedFiles:0,conflicts:[]});
  await page.route('https://pc.test/api/sync/**',async route=>{
    const req=route.request(),suffix=new URL(req.url()).pathname.slice('/api/sync/'.length);
    assert.equal(req.headers()['authorization'],'Bearer test-token');
    assert.equal(req.headers()['x-lumin-key'],'pc-key');
    let result;
    if(suffix==='info')result={nodeId:'pc-node',protocol:1,pair:paired?{role:'coordinator',peerId:'laptop-node'}:null};
    else if(suffix==='jobs/latest'){statusRequests++;result={job};}
    else if(suffix==='pair'){pairs++;paired=true;assert.deepEqual(req.postDataJSON(),{url:'https://laptop.test',key:'laptop-key'});result={peerId:'laptop-node',paired:true};}
    else if(suffix==='jobs'){starts++;job=newJob();result=job;}
    else throw new Error('Unexpected route '+suffix);
    await route.fulfill({status:suffix==='jobs'?202:200,contentType:'application/json',body:JSON.stringify(result)});
  });
  const origin=`http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  await page.addScriptTag({url:origin+'/vendor/lucide.min.js'});
  await page.addScriptTag({content:`
    let currentUiLanguage='en',currentUserAccess={isAdmin:true};
    const db={auth:{getSession:async()=>({data:{session:{access_token:'test-token'}},error:null})}};
    const savedServers=[{id:'pc',name:'Dedicated Clinic PC',icon:'server',url:'https://pc.test',key:'pc-key'}, {id:'laptop',name:'Backup laptop',icon:'laptop',url:'https://laptop.test',key:'laptop-key'}];
    function getStorageServerPresets(){return savedServers}
    function normaliseStoragePresetUrl(value){return new URL(value).href.replace(/\\/+$/,'')}
    function storageServerUrlsMatch(a,b){return normaliseStoragePresetUrl(a)===normaliseStoragePresetUrl(b)}
    function escapeHtml(value){return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;')}
    window.activeStorageUrl='https://laptop.test';
    document.getElementById('app-shell').classList.remove('hidden');
    document.getElementById('auth-gate').classList.add('hidden');
    document.querySelectorAll('#app-main [id^="view-"]').forEach(el=>el.classList.toggle('hidden',el.id!=='view-admin'));
    document.querySelectorAll('#view-admin [id^="admin-panel-"]').forEach(el=>el.classList.toggle('hidden',el.id!=='admin-panel-storage'));
  `});
  await page.addScriptTag({url:origin+'/lumin-storage-sync.js'});
  await page.evaluate(()=>LuminStorageSync.open());
  await page.locator('#storage-sync-pair').click();
  await page.waitForFunction(()=>!document.getElementById('storage-sync-start').disabled);
  assert.equal(pairs,1);
  await page.locator('#storage-sync-start').click();
  await page.waitForFunction(()=>document.getElementById('storage-sync-phase').textContent==='Scanning files');
  assert.equal(starts,1);
  assert.equal(await page.locator('#storage-sync-bar').getAttribute('aria-valuenow'),null);
  job={...job,phase:'syncing',totalBytes:1048576,transferredBytes:524288,totalFiles:2,completedFiles:1};
  await page.waitForFunction(()=>document.getElementById('storage-sync-percent').textContent==='50%');
  assert.match(await page.locator('#storage-sync-counts').textContent(),/1 \/ 2 files.*0.5 \/ 1.0 MB/);
  assert.equal(await page.evaluate(()=>window.activeStorageUrl),'https://laptop.test');
  // Polling updates must preserve keyboard focus.
  await page.locator('#btn-test-storage').focus();
  job={...job,phase:'verifying',transferredBytes:1048576,completedFiles:2};
  await page.waitForFunction(()=>document.getElementById('storage-sync-percent').textContent==='99%');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'btn-test-storage');
  await page.evaluate(()=>{LuminStorageSync.close();document.getElementById('view-admin').classList.add('hidden')});
  const before=statusRequests;
  await page.waitForTimeout(2200);
  assert.equal(statusRequests,before);
  job={...job,status:'completed_with_conflicts',phase:'finished',conflicts:[{path:'أحمد/أشعة/صورة.pdf',kind:'both_modified'}]};
  await page.evaluate(()=>{document.getElementById('view-admin').classList.remove('hidden');LuminStorageSync.open()});
  await page.waitForFunction(()=>document.getElementById('storage-sync-percent').textContent==='100%');
  assert.equal(await page.locator('#storage-sync-phase').textContent(),'Finished—needs review');
  assert.match(await page.locator('#storage-sync-conflicts').textContent(),/أحمد/);
  // A page reload recovers the persisted pairing and server-side latest job.
  await page.evaluate(()=>LuminStorageSync.close());
  await page.reload();
  await page.addScriptTag({url:origin+'/vendor/lucide.min.js'});
  await page.addScriptTag({content:`
    let currentUiLanguage='en',currentUserAccess={isAdmin:true};
    const db={auth:{getSession:async()=>({data:{session:{access_token:'test-token'}}})}};
    function getStorageServerPresets(){return [{id:'pc',name:'Dedicated PC',icon:'server',url:'https://pc.test',key:'pc-key'},{id:'laptop',name:'Laptop',icon:'laptop',url:'https://laptop.test',key:'laptop-key'}]}
    function normaliseStoragePresetUrl(v){return new URL(v).href.replace(/\\/+$/,'')}
    function storageServerUrlsMatch(a,b){return a===b}
    function escapeHtml(v){return String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')}
    document.getElementById('app-shell').classList.remove('hidden');document.getElementById('auth-gate').classList.add('hidden');
    document.querySelectorAll('#app-main [id^="view-"]').forEach(el=>el.classList.toggle('hidden',el.id!=='view-admin'));
    document.querySelectorAll('#view-admin [id^="admin-panel-"]').forEach(el=>el.classList.toggle('hidden',el.id!=='admin-panel-storage'));
  `});
  await page.addScriptTag({url:origin+'/lumin-storage-sync.js'});
  await page.evaluate(()=>LuminStorageSync.open());
  await page.waitForFunction(()=>document.getElementById('storage-sync-percent').textContent==='100%');
  assert.equal(pairs,1);
  job={...job,status:'failed',phase:'syncing',totalBytes:1048576,transferredBytes:524288,error:'Server disconnected.'};
  await page.waitForFunction(()=>document.getElementById('storage-sync-start-label').textContent==='Retry');
  assert.equal(await page.locator('#storage-sync-percent').textContent(),'50%');
  await page.locator('#storage-sync-start').click();
  await page.waitForFunction(()=>document.getElementById('storage-sync-phase').textContent==='Scanning files');
  assert.equal(starts,2);
  job={...job,status:'completed',phase:'finished'};
  await page.waitForFunction(()=>document.getElementById('storage-sync-percent').textContent==='100%');
  for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:950});
    for(const language of ['en','ar']){
      await page.evaluate(language=>{currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';LuminStorageSync.render()},language);
      assert.equal(await page.locator('#storage-sync-title').textContent(),language==='ar'?'مزامنة ملفات المرضى':'Sync patient files');
      const bounds=await page.locator('#storage-sync-panel button,#storage-sync-panel select').evaluateAll(elements=>elements.map(el=>{const r=el.getBoundingClientRect();return {h:r.height,w:r.width,left:r.left,right:r.right}}));
      bounds.forEach(b=>{assert.ok(b.h>=44);assert.ok(b.w>=44);assert.ok(b.left>=0&&b.right<=width+1)});
      assert.equal(await page.locator('#storage-sync-panel').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    }
  }
  if(process.env.LUMIN_TEST_ARTIFACT_DIR){
    job={...job,status:'running',phase:'syncing',totalBytes:104857600,transferredBytes:67108864,totalFiles:50,completedFiles:32};
    await page.waitForFunction(()=>document.getElementById('storage-sync-percent').textContent==='64%');
    assert.equal(await page.locator('#storage-sync-panel svg').count(),3);
    await page.evaluate(()=>{currentUiLanguage='en';document.documentElement.dir='ltr';LuminStorageSync.render()});
    await page.setViewportSize({width:1440,height:1300});
    await page.locator('#storage-sync-panel').screenshot({path:path.join(process.env.LUMIN_TEST_ARTIFACT_DIR,'storage-sync-panel.png')});
    await page.setViewportSize({width:390,height:950});
    await page.evaluate(()=>{currentUiLanguage='ar';document.documentElement.dir='rtl';LuminStorageSync.render()});
    await page.locator('#storage-sync-panel').screenshot({path:path.join(process.env.LUMIN_TEST_ARTIFACT_DIR,'storage-sync-panel-mobile-ar.png')});
  }
  await page.evaluate(()=>LuminStorageSync.close());
  assert.deepEqual(errors,[]);
});
