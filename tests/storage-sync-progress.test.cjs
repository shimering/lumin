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

test('older file-sync versions explain the required update in English and Arabic', () => {
  const ctx = vm.createContext({window:{addEventListener(){}}, document:{addEventListener(){}}, currentUiLanguage:'en'});
  vm.runInContext(syncSource.replace('window.LuminStorageSync =', 'window.syncErrorText = errorText; window.LuminStorageSync ='), ctx);
  const error = Object.assign(new Error('Patient-file sync update required.'), {status:426});
  assert.match(ctx.window.syncErrorText(error), /both computers.*patient files only/);
  ctx.currentUiLanguage = 'ar';
  assert.match(ctx.window.syncErrorText(error), /الجهازين.*ملفات المرضى فقط/);
});

test('HTTP 400 explains the required server update and preserves the specific rejection reason', () => {
  const ctx = vm.createContext({window:{addEventListener(){}}, document:{addEventListener(){}}, currentUiLanguage:'en'});
  vm.runInContext(syncSource.replace('window.LuminStorageSync =', 'window.syncErrorText = errorText; window.LuminStorageSync ='), ctx);
  assert.match(ctx.window.syncErrorText(new Error('Server request failed (HTTP 400).')), /Update and restart both server apps/);
  assert.match(ctx.window.syncErrorText(Object.assign(new Error('Invalid sync record.'), {status:400,code:'invalid_record'})), /revision history/);
  ctx.currentUiLanguage = 'ar';
  assert.match(ctx.window.syncErrorText(new Error('Server request failed (HTTP 400).')), /حدّث تطبيق الخادم على الجهازين/);
});

test('409 errors distinguish pairing problems from file changes in English and Arabic', () => {
  const ctx = vm.createContext({window:{addEventListener(){}}, document:{addEventListener(){}}, currentUiLanguage:'en'});
  vm.runInContext(syncSource.replace('window.LuminStorageSync =', 'window.syncErrorText = errorText; window.LuminStorageSync ='), ctx);
  for (const language of ['en','ar']) {
    ctx.currentUiLanguage=language;
    const render=(message,code)=>ctx.window.syncErrorText(Object.assign(new Error(message),{status:409,code}));
    assert.match(render('Wait for the current sync to finish before pairing.'),language==='en'?/still running/:/لا تزال/);
    assert.match(render('Choose two different servers with compatible sync support.'),language==='en'?/same storage server/:/نفس هوية/);
    assert.match(render('Server redirects are not allowed. Update the saved server URL.'),language==='en'?/redirects/:/التوجيه/);
    assert.match(render('Server request failed (HTTP 409).','file_changed'),language==='en'?/Pause uploads/:/أوقف رفع/);
    assert.doesNotMatch(render('Server request failed (HTTP 409).'),/Files may have changed|قد تكون الملفات تغيرت/);
    assert.match(render('Preview unavailable.','preview_unavailable'),language==='en'?/Retry or download/:/أعد المحاولة أو نزّل/);
    assert.match(render('Unauthorized. Invalid or missing clinic secret key.'),language==='en'?/clinic key saved/:/مفتاح العيادة المحفوظ/);
    assert.match(render('This server is already paired with another computer.'),language==='en'?/existing partner/:/الجهاز المقترن/);
    assert.match(render('Invalid peer manifest.'),language==='en'?/inconsistent file list/:/قائمة ملفات غير متسقة/);
  }
});

test('an expired admin token is refreshed once; invalid clinic keys never trigger sign-in recovery', async () => {
  let refreshes=0, requests=0;
  const ctx=vm.createContext({window:{addEventListener(){}},document:{addEventListener(){}},currentUiLanguage:'en',
    currentUserAccess:{isAdmin:true},AbortController,DOMException,setTimeout,clearTimeout,
    normaliseStoragePresetUrl:url=>url,
    db:{auth:{getSession:async()=>({data:{session:{access_token:'expired'}}}),
      refreshSession:async()=>{refreshes++;return {data:{session:{access_token:'fresh'}}}}}},
    fetch:async (url,options)=>{requests++;return options.headers.Authorization==='Bearer fresh'
      ? {ok:true,json:async()=>({nodeId:'pc'})}
      : {ok:false,status:401,json:async()=>({error:'Invalid administrator session.'})}}
  });
  vm.runInContext(syncSource.replace('window.LuminStorageSync =','window.syncApi=api; window.syncErrorText=errorText; window.LuminStorageSync ='),ctx);
  const server={name:'Laptop',url:'https://pc.test',key:'fixture'};
  assert.equal((await ctx.window.syncApi(server,'info')).nodeId,'pc');
  assert.equal(refreshes,1);assert.equal(requests,2);
  ctx.fetch=async()=>({ok:false,status:401,json:async()=>({error:'Invalid administrator session.'})});
  await assert.rejects(ctx.window.syncApi(server,'info'),e=>e.status===401);
  assert.equal(refreshes,2,'a repeated rejection must stop after one refresh');
  ctx.fetch=async()=>({ok:false,status:401,json:async()=>({error:'Unauthorized. Invalid or missing clinic secret key.'})});
  await assert.rejects(ctx.window.syncApi(server,'info'),e=>e.code==='invalid_clinic_key' && /Laptop: .*clinic key/.test(ctx.window.syncErrorText(e)));
  assert.equal(refreshes,2,'a clinic key mismatch cannot be fixed by refreshing the admin session');
});

test('aborts and timeouts show helpful bilingual explanations instead of raw browser signal abort errors', () => {
  const ctx = vm.createContext({window:{addEventListener(){}}, document:{addEventListener(){}}, currentUiLanguage:'en'});
  vm.runInContext(syncSource.replace('window.LuminStorageSync =', 'window.syncErrorText = errorText; window.LuminStorageSync ='), ctx);

  const rawAbort = Object.assign(new Error('signal is aborted without reason'), { name: 'AbortError' });
  const rawTimeout = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError', status: 408 });
  const unreachable = Object.assign(new Error('Failed to fetch'), { status: 503 });

  // English
  assert.equal(ctx.window.syncErrorText(rawAbort), 'Connection timed out. Ensure the storage server is running on both computers and reachable.');
  assert.equal(ctx.window.syncErrorText(rawTimeout), 'Connection timed out. Ensure the storage server is running on both computers and reachable.');
  assert.equal(ctx.window.syncErrorText(unreachable), 'Could not reach the storage server. Check that the server is started and the URL is reachable.');

  // Arabic
  ctx.currentUiLanguage = 'ar';
  assert.equal(ctx.window.syncErrorText(rawAbort), 'انتهت مهلة الاتصال. تأكد من تشغيل خادم التخزين على كلا الجهازين واتصالهما بالشبكة.');
  assert.equal(ctx.window.syncErrorText(rawTimeout), 'انتهت مهلة الاتصال. تأكد من تشغيل خادم التخزين على كلا الجهازين واتصالهما بالشبكة.');
  assert.equal(ctx.window.syncErrorText(unreachable), 'تعذر الاتصال بخادم التخزين. تأكد من تشغيل الخادم على ذلك الجهاز وصحة الرابط.');
});

test('review timeouts cover stalled response bodies and session retrieval, and cancellation aborts transfers', async () => {
  let lastSignal;
  const ctx = vm.createContext({window:{addEventListener(){}},document:{addEventListener(){}},currentUiLanguage:'en',currentUserAccess:{isAdmin:true},
    AbortController,DOMException,setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,30)),clearTimeout,
    normaliseStoragePresetUrl:url=>url,
    db:{auth:{getSession:()=>new Promise(()=>{})}},
    fetch:async (url,options)=>{lastSignal=options.signal;return {ok:true,blob:()=>new Promise(()=>{})}}
  });
  vm.runInContext(syncSource.replace('window.LuminStorageSync =', 'window.reviewFile = reviewFile; window.syncApi = api; window.LuminStorageSync ='),ctx);
  const server={url:'https://pc.test',key:'test-key'};
  await assert.rejects(ctx.window.reviewFile(server,'Patient/image.png',true),error=>error.name==='TimeoutError');
  assert.equal(lastSignal.aborted,true,'a stalled body must be aborted, not just hidden');
  await assert.rejects(ctx.window.syncApi(server,'jobs/test/conflicts/0'),error=>error.name==='TimeoutError' && error.status===408);
  const controller=new AbortController();
  const pending=ctx.window.reviewFile(server,'Patient/image.png',true,controller.signal);
  await new Promise(resolve=>setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending,error=>error.name==='AbortError');
  assert.equal(lastSignal.aborted,true);
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
  let paired=false,job=null,starts=0,pairs=0,statusRequests=0,laptopFileScope='patient-files-v1',pcNodeId='pc-node',pairError=null;
  let legacyReview=false,staleReview=false,reviewsSaved=0,originalDownloads=0,slowPreview=false,brokenPreview=false,slowComparison=false,oldLaptopPair=false;
  let conflictKind='path_case',missingSide=null,expectedAction='keep_both',oldResolutionPeer=false;
  const delayedPreviews=[],delayedComparisons=[];
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  const newJob=()=>({id:'job-1',status:'running',phase:'scanning',totalBytes:0,transferredBytes:0,totalFiles:0,completedFiles:0,conflicts:[]});
  await page.route(/^https:\/\/(?:pc|laptop)\.test\/api\/sync\//,async route=>{
    const req=route.request(),suffix=new URL(req.url()).pathname.slice('/api/sync/'.length);
    assert.equal(req.headers()['authorization'],'Bearer test-token');
    const isLaptop = new URL(req.url()).hostname === 'laptop.test';
    assert.equal(req.headers()['x-lumin-key'],isLaptop?'laptop-key':'pc-key');
    let result;
    if(suffix==='info')result=isLaptop?{nodeId:'laptop-node',protocol:1,fileScope:laptopFileScope,clinicalMetadataVersion:2,pair:oldLaptopPair?{role:'replica',peerId:'reinstalled-pc'}:paired?{role:'replica',peerId:'pc-node'}:null}
      :{nodeId:pcNodeId,protocol:1,fileScope:'patient-files-v1',clinicalMetadataVersion:2,pair:paired?{role:'coordinator',peerId:'laptop-node'}:null};
    else if(suffix==='jobs/latest'){statusRequests++;result={job};}
    else if(suffix==='pair'){
      pairs++;
      assert.deepEqual(req.postDataJSON(),{url:'https://laptop.test',key:'laptop-key',...(oldLaptopPair?{replacePair:true}:{})});
      if(pairError){await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify(pairError)});return;}
      paired=true;oldLaptopPair=false;result={peerId:'laptop-node',paired:true};
    }
    else if(suffix==='jobs'){starts++;job=newJob();result=job;}
    else if(suffix==='jobs/job-1/conflicts/0'){
      if(slowComparison && req.method()==='GET')await new Promise(resolve=>delayedComparisons.push(resolve));
      if(legacyReview){await route.fulfill({status:404,contentType:'application/json',body:'{}'});return;}
      if(req.method()==='POST'){
        assert.deepEqual(req.postDataJSON(),{action:expectedAction,revision:'review-revision'});
        if(staleReview){await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({code:'review_changed'})});return;}
        reviewsSaved++;job={...job,status:'completed',conflicts:job.conflicts.map(c=>({...c,reviewed:true,resolution:expectedAction}))};result={job};
      }else result={path:job.conflicts[0].path,kind:conflictKind,revision:'review-revision',reviewed:false,
        actions:oldResolutionPeer?['keep_both']:missingSide?[missingSide==='local'?'keep_remote':'keep_local','delete_both']:conflictKind==='path_case'?['keep_both']:['keep_both','keep_local','keep_remote'],
        details:Object.fromEntries(['local','remote'].map(side=>[side,{patient_name:'مريض تجريبي',patient_id:'12345678-1234-4234-8234-123456789abc',patient_number:'1042',tooth_ids:['3','A'],display_name:'فحص الأسنان',note:side+' Follow-up <img onerror="window.clinicalInjected=true">',scan_date:'2026-10-07',scan_config:{rotation:90},metadata_available:true}])),
        versions:Object.fromEntries(['local','remote'].map(side=>[side,{path:job.conflicts[0].path,size:side===missingSide?0:png.length,sha256:side===missingSide?null:'a'.repeat(64),deleted:side===missingSide}]))};
    }
    else if(suffix==='jobs/job-1/conflicts/0/file'){
      originalDownloads++;
      assert.equal(new URL(req.url()).searchParams.get('revision'),'review-revision');
      await route.fulfill({contentType:'image/png',body:png});return;
    }
    else throw new Error('Unexpected route '+suffix);
    await route.fulfill({status:suffix==='jobs'?202:200,contentType:'application/json',body:JSON.stringify(result)});
  });
  await page.route(/^https:\/\/(?:pc|laptop)\.test\/api\/thumbnail\//,async route=>{
    const isLaptop=new URL(route.request().url()).hostname==='laptop.test';
    assert.equal(route.request().headers()['x-lumin-key'],isLaptop?'laptop-key':'pc-key');
    assert.equal(new URL(route.request().url()).searchParams.has('key'),false);
    if(slowPreview && isLaptop)await new Promise(resolve=>delayedPreviews.push(resolve));
    await route.fulfill({contentType:brokenPreview && isLaptop?'text/html':'image/png',body:brokenPreview && isLaptop?'not an image':png}).catch(()=>{});
  });
  await page.route(/^https:\/\/(?:pc|laptop)\.test\/files\//,async route=>{
    assert.equal(route.request().headers()['x-lumin-key'],new URL(route.request().url()).hostname==='pc.test'?'pc-key':'laptop-key');
    assert.equal(new URL(route.request().url()).searchParams.has('key'),false);
    await route.fulfill({contentType:'image/png',body:png});
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
  await page.waitForFunction(()=>document.getElementById('storage-sync-message').textContent.includes('Pair these two servers'));
  laptopFileScope=undefined;
  await page.locator('#storage-sync-pair').click();
  await page.waitForFunction(()=>document.getElementById('storage-sync-message').textContent.includes('Install the latest storage server update'));
  assert.equal(pairs,0,'an older peer must not be paired or start a job');
  assert.equal(starts,0);
  assert.equal(await page.locator('#storage-sync-start').isEnabled(),false);
  laptopFileScope='patient-files-v1';
  pcNodeId='laptop-node';
  await page.locator('#storage-sync-pair').click();
  await page.waitForFunction(()=>document.getElementById('storage-sync-message').textContent.includes('same storage server'));
  assert.equal(pairs,0,'copied identities must be detected before attempting to pair');
  pcNodeId='pc-node';
  pairError={error:'Wait for the current sync to finish before pairing.',code:'sync_busy'};
  await page.locator('#storage-sync-pair').click();
  await page.waitForFunction(()=>document.getElementById('storage-sync-message').textContent.includes('still running'));
  const beforePairErrorPoll=statusRequests;
  await page.waitForFunction(()=>document.getElementById('storage-sync-message').textContent.includes('still running'));
  while(statusRequests===beforePairErrorPoll) await page.waitForTimeout(200);
  assert.match(await page.locator('#storage-sync-message').textContent(),/still running/,'successful status polling must preserve action errors');
  pairError=null;
  oldLaptopPair=true;
  await page.locator('#storage-sync-pair').click();
  await page.waitForFunction(()=>!document.getElementById('storage-sync-start').disabled);
  assert.equal(pairs,2);
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
  job={...job,status:'completed_with_conflicts',phase:'finished',conflicts:[{path:'أحمد/أشعة/صورة.png',kind:'path_case'}]};
  await page.evaluate(()=>{document.getElementById('view-admin').classList.remove('hidden');LuminStorageSync.open()});
  await page.waitForFunction(()=>document.getElementById('storage-sync-percent').textContent==='100%');
  assert.equal(await page.locator('#storage-sync-phase').textContent(),'Finished—needs review');
  assert.match(await page.locator('#storage-sync-conflicts').textContent(),/أحمد/);
  await page.locator('#storage-sync-review-0').focus();
  await page.waitForTimeout(2200);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'storage-sync-review-0');
  // Choosing either version is explicit and saves that action on both servers.
  for(const action of ['keep_local','keep_remote','delete_both']){
    expectedAction=action;conflictKind=action==='delete_both'?'delete_modified':'both_modified';
    missingSide=action==='delete_both'?'local':null;
    job={...job,status:'completed_with_conflicts',conflicts:[{path:'أحمد/أشعة/صورة.png',kind:conflictKind}]};
    await page.waitForFunction(()=>document.querySelector('#storage-sync-conflicts strong').textContent==='Needs review');
    await page.locator('#storage-sync-review-0').click();
    await page.waitForFunction(()=>document.querySelector('[data-apply]'));
    assert.equal(await page.locator('[data-apply]').isDisabled(),true);
    if(missingSide){
      assert.equal(await page.locator('[data-download="local"]').count(),0);
      assert.equal(await page.locator('[data-choice="keep_local"]').count(),0);
      assert.match(await page.locator('[data-choice="keep_remote"]').textContent(),/Restore this copy on both/);
      assert.equal(await page.locator('[data-keep]').count(),0);
    }
    await page.locator(`[data-choice="${action}"]`).click();
    assert.equal(await page.locator(`[data-choice="${action}"]`).getAttribute('aria-pressed'),'true');
    assert.match(await page.locator('.storage-review-choice-summary').textContent(),action==='delete_both'?/removed from both/:/selected image/);
    await page.locator('[data-apply]').click();
    await page.waitForFunction(()=>document.querySelector('.storage-review-overlay')===null);
    assert.match(await page.locator('#storage-sync-conflicts').textContent(),action==='delete_both'?/deleted on both/:/chosen copy on both/);
  }
  for(const side of ['local','remote']){
    expectedAction=side==='local'?'keep_remote':'keep_local';conflictKind='delete_modified';missingSide=side;
    job={...job,status:'completed_with_conflicts',conflicts:[{path:'أحمد/أشعة/صورة.png',kind:conflictKind}]};
    await page.waitForFunction(()=>document.querySelector('#storage-sync-conflicts strong').textContent==='Needs review');
    await page.locator('#storage-sync-review-0').click();
    await page.waitForFunction(()=>document.querySelector('[data-apply]'));
    await page.locator(`[data-choice="${expectedAction}"]`).click();
    assert.match(await page.locator('.storage-review-choice-summary').textContent(),/restored to both/);
    await page.locator('[data-apply]').click();
    await page.waitForFunction(()=>document.querySelector('.storage-review-overlay')===null);
  }
  assert.equal(reviewsSaved,5);
  // An older peer keeps existing safe actions and offers no unsupported choices.
  oldResolutionPeer=true;missingSide=null;conflictKind='both_modified';
  job={...job,status:'completed_with_conflicts',conflicts:[{path:'أحمد/أشعة/صورة.png',kind:conflictKind}]};
  await page.waitForFunction(()=>document.querySelector('#storage-sync-conflicts strong').textContent==='Needs review');
  await page.locator('#storage-sync-review-0').click();
  await page.waitForFunction(()=>!document.querySelector('[data-keep]').disabled);
  assert.equal(await page.locator('[data-choice]').count(),0);
  await page.locator('[data-close]').click();
  oldResolutionPeer=false;
  expectedAction='keep_both';conflictKind='path_case';reviewsSaved=0;
  job={...job,status:'completed_with_conflicts',conflicts:[{path:'أحمد/أشعة/صورة.png',kind:'path_case'}]};
  await page.locator('#storage-sync-review-0').click();
  await page.waitForFunction(()=>document.querySelectorAll('.storage-review-preview img').length===2);
  assert.equal(await page.locator('.storage-review-download').count(),2);
  assert.match(await page.locator('.storage-review-same').textContent(),/identical/);
  assert.equal(await page.locator('.storage-review-clinical').count(),2);
  assert.match(await page.locator('.storage-review-clinical').first().textContent(),/12345678-1234-4234-8234-123456789abc/);
  assert.match(await page.locator('.storage-review-clinical').first().textContent(),/1042/);
  assert.deepEqual(await page.locator('[data-side="local"] .storage-review-teeth span').allTextContents(),['3','A']);
  assert.equal(await page.locator('.storage-review-clinical img').count(),0,'annotations must render as escaped text');
  assert.equal(await page.evaluate(()=>window.clinicalInjected),undefined);
  assert.equal(originalDownloads,0,'opening a review must not download full originals');
  slowComparison=true;
  await page.locator('[data-reload]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.storage-review-preview img').length===2);
  assert.match(await page.locator('.storage-review-message').textContent(),/Loading comparison/);
  assert.equal(await page.locator('[data-keep]').isDisabled(),true,'previews may load while revision checks are still pending');
  slowComparison=false;delayedComparisons.splice(0).forEach(resolve=>resolve());
  await page.waitForFunction(()=>!document.querySelector('[data-keep]').disabled);
  slowPreview=true;
  await page.locator('[data-reload]').click();
  await page.waitForFunction(()=>document.querySelector('[data-side="local"] img') && !document.querySelector('[data-side="remote"] img'));
  assert.equal(await page.locator('[data-keep]').isEnabled(),true,'a slow preview must not block the review action');
  assert.equal(originalDownloads,0);
  slowPreview=false;delayedPreviews.splice(0).forEach(resolve=>resolve());
  await page.waitForFunction(()=>document.querySelectorAll('.storage-review-preview img').length===2);
  // A stalled body is bounded, and retry reloads only the affected side.
  await page.evaluate(()=>{const original=setTimeout;window.setTimeout=(fn,ms,...args)=>original(fn,ms===15000?100:ms,...args)});
  slowPreview=true;
  await page.locator('[data-reload]').click();
  await page.waitForFunction(()=>document.querySelector('[data-side="remote"]').textContent.includes('Preview timed out'));
  assert.equal(await page.locator('[data-side="local"] img').count(),1);
  assert.equal(await page.locator('[data-keep]').isEnabled(),true);
  slowPreview=false;delayedPreviews.splice(0).forEach(resolve=>resolve());
  await page.locator('[data-retry="remote"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.storage-review-preview img').length===2);
  brokenPreview=true;
  await page.locator('[data-reload]').click();
  await page.waitForFunction(()=>document.querySelector('[data-side="remote"]').textContent.includes('Preview unavailable'));
  assert.equal(await page.locator('[data-side="local"] img').count(),1);
  brokenPreview=false;
  await page.locator('[data-retry="remote"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.storage-review-preview img').length===2);
  const downloaded=page.waitForEvent('download');
  await page.locator('[data-download="local"]').click();
  assert.equal((await downloaded).suggestedFilename(),'صورة.png');
  assert.equal(originalDownloads,1,'original bytes download only after an explicit click');
  conflictKind='metadata';
  for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:884});
    for(const language of ['en','ar']){
      await page.evaluate(language=>{currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr'},language);
      await page.locator('[data-reload]').click();
      await page.waitForFunction(()=>document.querySelectorAll('.storage-review-preview img').length===2);
      await page.waitForFunction(()=>document.querySelector('.storage-review-dialog header p').textContent.includes(currentUiLanguage==='ar'?'بيانات محلية مختلفة':'different local annotations'));
      const bounds=await page.locator('.storage-review-dialog button,.storage-review-dialog a').evaluateAll(elements=>elements.map(el=>{const r=el.getBoundingClientRect();return {h:r.height,w:r.width,left:r.left,right:r.right}}));
      bounds.forEach(b=>{assert.ok(b.h>=44);assert.ok(b.w>=44);assert.ok(b.left>=0&&b.right<=width+1)});
      assert.equal(await page.locator('.storage-review-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
      assert.equal(await page.locator('.storage-review-dialog').getAttribute('dir'),language==='ar'?'rtl':'ltr');
      assert.equal(await page.locator('.storage-review-body').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
      if(process.env.LUMIN_TEST_ARTIFACT_DIR && ((width===1440&&language==='en')||(width===390&&language==='ar'))){
        fs.mkdirSync(process.env.LUMIN_TEST_ARTIFACT_DIR,{recursive:true});
        await page.locator('.storage-review-body').evaluate(el=>{el.scrollTop=230});
        await page.locator('.storage-review-dialog').screenshot({path:path.join(process.env.LUMIN_TEST_ARTIFACT_DIR,language==='ar'?'storage-clinical-review-mobile-ar.png':'storage-clinical-review.png')});
      }
    }
  }
  await page.evaluate(()=>{currentUiLanguage='en';document.documentElement.dir='ltr'});
  staleReview=true;
  await page.locator('[data-keep]').click();
  await page.waitForFunction(()=>document.querySelector('.storage-review-message').textContent.includes('Reload the comparison'));
  assert.equal(reviewsSaved,0);
  staleReview=false;legacyReview=true;
  await page.locator('[data-reload]').click();
  await page.waitForFunction(()=>document.querySelector('.storage-review-message').textContent.includes('updated Lumin Storage Setup'));
  assert.equal(await page.locator('[data-keep]').isDisabled(),true);
  assert.equal(await page.locator('.storage-review-download').count(),2);
  legacyReview=false;
  await page.locator('[data-reload]').click();
  await page.waitForFunction(()=>document.querySelector('[data-keep]').disabled===false);
  await page.locator('[data-keep]').click();
  await page.waitForFunction(()=>document.querySelector('.storage-review-overlay')===null);
  assert.equal(reviewsSaved,1);
  assert.match(await page.locator('#storage-sync-conflicts').textContent(),/Reviewed · both kept/);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'storage-sync-review-0');
  // A page reload recovers the persisted pairing and server-side latest job.
  await page.evaluate(()=>LuminStorageSync.close());
  await page.evaluate(()=>localStorage.removeItem('lumin_storage_sync_pair'));
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
  assert.equal(pairs,2);
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
