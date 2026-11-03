const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
function source(name) {
  const start=html.search(new RegExp(`    (?:async )?function ${name}\\(`)),end=html.slice(start).match(/\r?\n    }\r?\n/);
  return html.slice(start,start+end.index+end[0].length);
}
const workflow=html.slice(html.indexOf('    const storagePresetKeys ='),html.indexOf('    async function testStorageServerConnection()'));
test('R2 appears in the saved list, tests without switching, saves no JWT, and fits English/Arabic layouts',async t=>{
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if (url.pathname==='/') {res.setHeader('Content-Type','text/html');res.end(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,''));return;}
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if (!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()) {res.statusCode=404;res.end();return;}
    res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||undefined});t.after(()=>browser.close());
  const page=await browser.newPage(),errors=[],calls=[];page.on('pageerror',error=>errors.push(error.message));
  const origin=`http://127.0.0.1:${server.address().port}`;let paired=false,job=null,layout=null;
  await page.route('**/r2/api/**',async route=>{
    calls.push(new URL(route.request().url()).pathname);
    assert.equal(route.request().headers()['x-lumin-key'],'user-session-token');
    const url=new URL(route.request().url()),endpoint=url.pathname;
    if(endpoint.includes('/api/cloud-sync/')) {
      const nodeId='11111111-1111-4111-8111-111111111111',peerId='22222222-2222-4222-8222-222222222222';let data;
      if(endpoint.endsWith('/layout/jobs'))data=layout={id:'layout-job',status:'running',totalFiles:2,completedFiles:0};
      else if(endpoint.endsWith('/layout/jobs/layout-job/step'))data=layout={...layout,status:'completed',completedFiles:2,movedFiles:2};
      else if(endpoint.endsWith('/info'))data={nodeId,protocol:1,fileScope:'patient-files-v1',clinicalMetadataVersion:2,pair:paired?{peerId,role:'coordinator'}:null,peer:{nodeId:peerId,pair:paired?{peerId:nodeId,role:'replica'}:null}};
      else if(endpoint.endsWith('/pair')) {paired=true;data={paired:true,peerId};}
      else if(endpoint.endsWith('/jobs/latest'))data={job};
      else if(endpoint.endsWith('/jobs'))data=job={id:'cloud-job',peerId,status:'running',phase:'syncing',totalFiles:1,completedFiles:0,totalBytes:10,transferredBytes:0,conflicts:[]};
      else if(endpoint.endsWith('/step'))data=job={...job,status:'completed',phase:'finished',completedFiles:1,transferredBytes:10,metadataStatus:'current',verifiedFiles:1,unassignedFiles:[{path:'Unassigned/General/old.png'}]};
      else if(endpoint.endsWith('/verify'))data={success:true,directions:['r2_to_drive','drive_to_r2']};
      else if(endpoint.endsWith('/unassigned/delete')){assert.deepEqual(route.request().postDataJSON(),{paths:['Unassigned/General/old.png']});job={...job,unassignedFiles:[]};data={removed:1,job};}
      else throw new Error('Unexpected cloud route');
      await route.fulfill({json:data});return;
    }
    await route.fulfill({json:route.request().method()==='POST'?{success:true,verified:['write','read','delete']}:{status:'online',service:'Lumin Cloudflare R2 Storage'}});
  });
  await page.goto(origin);
  await page.addScriptTag({content:`
    let currentUiLanguage='en',currentUserAccess={isAdmin:true,userId:'test-user'},clinicStorageServerUrl='https://clinic.test',clinicStorageSecretKey='clinic-key',storageConnectionConnected=true,storageConnectionState='connected';
    const SUPABASE_URL='https://project.supabase.test';let writes=[];
    const db={auth:{getSession:async()=>({data:{session:{access_token:'user-session-token',user:{id:'test-user'}}}})},from:()=>({update(value){writes.push(value);return this},eq(){return this},select(){return this},async maybeSingle(){return {data:{id:1},error:null}}})};
    function escapeHtml(value){return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')}
    function refreshStorageConnectionConfig(){} async function checkStorageServerConnection(){}
    ${source('getStorageServerConfig')}
    ${workflow}
    localStorage.setItem('lumin_storage_server_presets',JSON.stringify([{id:'main',name:'Clinic PC',url:'https://clinic.test',key:'clinic-key'}]));
    document.getElementById('app-shell').classList.remove('hidden');document.getElementById('auth-gate').classList.add('hidden');
    document.querySelectorAll('#app-main [id^="view-"]').forEach(el=>el.classList.toggle('hidden',el.id!=='view-admin'));
    document.querySelectorAll('#view-admin [id^="admin-panel-"]').forEach(el=>el.classList.toggle('hidden',el.id!=='admin-panel-storage'));
  `});
  await page.addScriptTag({url:origin+'/vendor/lucide.min.js'});
  await page.addScriptTag({url:origin+'/lumin-google-drive.js'});
  await page.addScriptTag({url:origin+'/lumin-r2.js'});
  await page.evaluate(()=>populateStorageServerSettingsInputs());
  const card=page.locator('.r2-card');assert.equal(await card.count(),1);
  await card.getByRole('button',{name:'Test R2',exact:true}).click();
  await card.getByText(/Connection verified/).waitFor();
  assert.deepEqual(calls,['/r2/api/health','/r2/api/self-test']);
  assert.equal(await page.evaluate(()=>writes.length),0);
  assert.equal(await page.evaluate(()=>getStorageServerConfig().url),'https://clinic.test');
  await card.getByRole('button',{name:'Refresh patient folders',exact:true}).click();
  await card.getByText(/Patient-name folders ready in Lumin Clinic/).waitFor();
  assert.equal(await page.evaluate(()=>writes.length),0,'organizing preserves the active storage selection');
  for (const width of [320,390,768,1440]) for (const language of ['en','ar']) {
    await page.setViewportSize({width,height:1000});
    await page.evaluate(language=>{currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';renderStorageServerPresets();},language);
    const metrics=await card.evaluate(el=>({width:el.getBoundingClientRect().width,scroll:el.scrollWidth,client:el.clientWidth,buttons:[...el.querySelectorAll('button')].map(b=>({width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height}))}));
    assert.ok(metrics.scroll<=metrics.client+1);assert.ok(metrics.buttons.every(b=>b.width>=44&&b.height>=44),JSON.stringify(metrics));
  }
  await page.evaluate(()=>{currentUiLanguage='en';document.documentElement.dir='ltr';renderStorageServerPresets();});
  await card.getByRole('button',{name:'Use Cloudflare R2',exact:true}).click();
  await card.getByRole('button',{name:'Selected',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>writes[0].storage_secret_key),'');
  assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('user-session-token')),false);
  assert.equal(await page.locator('#storage-location-card').isVisible(),false);
  await page.locator('#settings-storage-preset').selectOption('main');
  await page.waitForFunction(()=>getStorageServerConfig().url==='https://clinic.test');
  assert.equal(await page.locator('#storage-local-url-field').isVisible(),true);
  await page.addScriptTag({url:origin+'/lumin-storage-sync.js'});
  await page.evaluate(()=>LuminStorageSync.open());
  await page.locator('#storage-sync-coordinator').selectOption('preset-google-drive');
  await page.locator('#storage-sync-laptop').selectOption('preset-cloudflare-r2');
  await page.locator('#storage-sync-pair').click();
  await page.waitForFunction(()=>!document.getElementById('storage-sync-start').disabled);
  await page.locator('#storage-sync-start').click();
  await page.locator('#storage-sync-message').getByText(/1 files verified/).waitFor();
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('#storage-sync-remove-unassigned').click();
  await page.waitForFunction(()=>document.getElementById('storage-sync-remove-unassigned').style.display==='none');
  assert.equal(await page.evaluate(()=>getStorageServerConfig().url),'https://clinic.test','sync does not select a different active server');
  for(const width of [320,768,1440])for(const language of ['en','ar']) {
    await page.setViewportSize({width,height:1000});await page.evaluate(language=>{currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';LuminStorageSync.render();},language);
    assert.equal(await page.locator('#storage-sync-panel').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
  }
  assert.deepEqual(errors,[]);
});
