const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
let chromium;
try { ({chromium} = require('playwright')); } catch (_) {}
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const rotation = fs.readFileSync(path.join(root, 'lumin-xray-rotation.js'), 'utf8');
function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}
function harness() {
  const file={filename:'film.png',relativePath:'Patient/Periapical/film.png',mediaDetails:{display_name:'UR6',note:'Keep note',tooth_ids:['3','A'],scan_config:{other:'Keep setting'}}};
  let config={url:'https://storage.example',key:'test'}, release, fail=false;
  const writes=[];
  const context=vm.createContext({currentUiLanguage:'en',currentLightboxPatientId:null,currentLightboxRelativePath:'',activePatientMediaPatientId:'patient-1',currentPatientMediaFiles:[file],
    patientMediaDetailsError:false,chartPatientMedia:{patientId:'patient-1',files:[file],selectedPath:file.relativePath},
    document:{addEventListener(){},querySelectorAll(){return []},querySelector(){return null},getElementById(){return null}},
    getStorageServerConfig:()=>config,hasPageAccess:()=>true,patientMediaFileKind:()=> 'image',escapeHtml:String,
    persistPatientMediaDetails:async(pid,rel,details,target)=>{writes.push({pid,rel,details:structuredClone(details),target});
      if(release===true)await new Promise(resolve=>release=resolve);
      if(fail)throw Error('Offline');return {...file.mediaDetails,...details};}
  });
  vm.runInContext(rotation,context);
  return {context,file,writes,hold(){release=true},release(){release()},fail(value){fail=value},switchServer(){config={url:'https://other.example',key:'other'}}};
}

test('every quarter turn is persisted as partial metadata and four turns restore the original orientation',async()=>{
  const h=harness();
  for(const angle of [90,180,270,0]){
    await h.context.rotatePatientMediaImage(h.file,'patient-1');
    assert.equal(h.context.patientMediaRotation(h.file,'patient-1'),angle);
    assert.equal(h.writes.at(-1).details.scan_config.image_rotation,angle);
    assert.equal(h.writes.at(-1).details.scan_config.other,'Keep setting');
    assert.deepEqual(Object.keys(h.writes.at(-1).details),['scan_config']);
    assert.equal(h.file.mediaDetails.note,'Keep note');assert.deepEqual(h.file.mediaDetails.tooth_ids,['3','A']);
  }
});

test('pending saves cannot race, a failure restores the last saved angle, and a later rotation retries',async()=>{
  const h=harness();h.hold();const pending=h.context.rotatePatientMediaImage(h.file,'patient-1');
  await h.context.rotatePatientMediaImage(h.file,'patient-1');assert.equal(h.writes.length,1);
  h.release();await pending;h.fail(true);await h.context.rotatePatientMediaImage(h.file,'patient-1');
  assert.equal(h.context.patientMediaRotation(h.file,'patient-1'),90);
  h.fail(false);await h.context.rotatePatientMediaImage(h.file,'patient-1');assert.equal(h.context.patientMediaRotation(h.file,'patient-1'),180);
});

test('a save stays scoped to its original server and cannot change a new patient or server preview',async()=>{
  const h=harness();h.hold();const pending=h.context.rotatePatientMediaImage(h.file,'patient-1');
  const next={...h.file,mediaDetails:{scan_config:{image_rotation:270}}};
  h.context.chartPatientMedia={patientId:'patient-2',files:[next]};h.context.activePatientMediaPatientId='patient-2';h.context.currentPatientMediaFiles=[next];
  h.switchServer();h.release();await pending;
  assert.equal(next.mediaDetails.scan_config.image_rotation,270);assert.equal(h.writes[0].target.url,'https://storage.example');
});

test('chart and enlarged viewer save, reopen, fit rotated images, recover errors and support mobile Arabic',{skip:!chromium&&'Playwright unavailable'},async t=>{
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,''));return;}
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.statusCode=404;res.end();return;}
    res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||undefined});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const radiograph='<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400"><rect width="1200" height="400" fill="#101827"/><path d="M100 70 Q200 20 300 70 L280 330 L230 330 L200 180 L150 330 L110 330 Z M420 70 Q520 20 620 70 L600 330 L550 330 L520 180 L470 330 L430 330 Z" fill="#b3bbc5"/><text x="820" y="90" font-size="40" fill="#eef2ff">UR6</text></svg>';
  await page.route('**/api/thumbnail/**',route=>route.fulfill({contentType:'image/svg+xml',body:radiograph}));
  await page.route('**/files/**',route=>route.fulfill({contentType:'image/svg+xml',body:radiograph}));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.addScriptTag({path:path.join(root,'vendor/lucide.min.js')});
  const helpers=['escapeHtml','patientMediaDisplayName','patientMediaDownloadName','patientMediaFileUrl','persistPatientMediaDetails','renderPatientMediaGrid',
    'setupLightboxInteractions','openMediaLightbox','closeMediaLightbox','lightboxZoom','lightboxResetZoom','lightboxRotate','lightboxToggleInvert','updateLightboxTransform'].map(source).join('\n');
  await page.addScriptTag({content:`
    let currentUiLanguage='en',activePatientId='patient-1',activeWorkspacePatientId='patient-1',activePatientMediaPatientId='patient-1';
    let currentLightboxPatientId=null,currentLightboxRelativePath='',currentLightboxOriginalUrl='',patientMediaDetailsError=false,patientMediaToothPicker=null;
    let lightboxScale=1,lightboxRotation=0,lightboxInverted=false,lightboxPanX=0,lightboxPanY=0,lightboxIsDragging=false,lightboxDragStartX=0,lightboxDragStartY=0,lightboxTouchDistStart=0,lightboxTouchScaleStart=1,lightboxEventsSetup=false;
    let activePatientMediaFilter='ALL',allowed=true;
    const initial={display_name:'UR6 before treatment',note:'Clinical note preserved',tooth_ids:['3','A'],scan_config:{other:'kept'}};
    window.savedDetails=structuredClone(initial);window.failSave=false;window.holdSave=false;window.saveCalls=0;
    const template={filename:'film.png',relativePath:'Patient/Periapical/film.png',category:'Periapical',modifiedAt:'2026-10-08T10:00:00Z',sizeBytes:1024};
    let currentPatientMediaFiles=[{...template,mediaDetails:structuredClone(initial)}];
    function getStorageServerConfig(){return {url:location.origin,key:'test'};}
    function getKnownPatient(id){return {id,name:'Ahmed Hassan'};}
    function hasPageAccess(){return allowed;}
    function patientMediaToothIds(details){return details?.tooth_ids||[];}
    function patientMediaTeethLabel(){return 'UR6';}
    function patientMediaToothLabel(value){return value;}
    const nativeFetch=fetch.bind(window);
    window.fetch=async(url,options)=>{
      if(String(url).endsWith('/media-details')){
        window.saveCalls++;const body=JSON.parse(options.body);window.lastSave=body;
        if(window.holdSave)await new Promise(resolve=>window.releaseSave=resolve);
        if(window.failSave)return {ok:false,json:async()=>({error:'Offline'})};
        window.savedDetails={...window.savedDetails,...body.details};return {ok:true,json:async()=>({metadataSource:'local',details:structuredClone(window.savedDetails)})};
      }return nativeFetch(url,options);
    };
    ${helpers}
  `});
  await page.addScriptTag({path:path.join(root,'lumin-chart-media.js')});await page.addScriptTag({path:path.join(root,'lumin-xray-rotation.js')});
  await page.evaluate(()=>{
    document.getElementById('auth-gate').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');
    document.querySelectorAll('#app-main > section, #app-main > div').forEach(node=>node.classList.add('hidden'));
    ['patient-workspace-sheet','patient-workspace-header','view-chart'].forEach(id=>document.getElementById(id).classList.remove('hidden'));
    chartPatientMedia.patientId=activePatientId;chartPatientMedia.files=currentPatientMediaFiles;chartPatientMedia.status='ready';chartPatientMedia.collapsed=false;
    document.dispatchEvent(new Event('DOMContentLoaded'));renderChartMediaPanel();
  });
  const rotate=page.locator('[data-chart-rotate-xray]');await rotate.click();
  await page.waitForFunction(()=>window.savedDetails.scan_config.image_rotation===90);
  assert.equal(await page.locator('.chart-media-preview img').getAttribute('data-media-rotation'),'90');
  assert.equal(await page.evaluate(()=>window.lastSave.details.note),undefined);
  await page.evaluate(()=>{chartPatientMedia.files=[{...template,mediaDetails:structuredClone(window.savedDetails)}];currentPatientMediaFiles=chartPatientMedia.files;renderChartMediaPanel();});
  assert.equal(await page.locator('.chart-media-preview img').getAttribute('data-media-rotation'),'90','A fresh server listing restores rotation');
  await page.waitForFunction(()=>[...document.querySelectorAll('#chart-media-panel img')].every(image=>image.naturalWidth>0));
  await page.evaluate(()=>fitPatientMediaRotations());
  for(const box of await page.locator('#chart-media-panel img').evaluateAll(nodes=>nodes.map(image=>({image:image.getBoundingClientRect().toJSON(),parent:image.parentElement.getBoundingClientRect().toJSON()}))))assert.ok(box.image.x>=box.parent.x&&box.image.y>=box.parent.y&&box.image.right<=box.parent.right+1&&box.image.bottom<=box.parent.bottom+1,JSON.stringify(box));
  await page.locator('.chart-media-preview').click();await page.waitForFunction(()=>document.getElementById('lightbox-img').naturalWidth>0);
  assert.equal(await page.evaluate(()=>lightboxRotation),90);
  await page.locator('#lightbox-rotate-btn').click();await page.waitForFunction(()=>window.savedDetails.scan_config.image_rotation===180);
  await page.evaluate(()=>{lightboxZoom(.5);lightboxToggleInvert();lightboxResetZoom();});assert.equal(await page.evaluate(()=>lightboxRotation),180);
  await page.evaluate(()=>window.failSave=true);await page.locator('#lightbox-rotate-btn').click();
  await page.waitForFunction(()=>document.getElementById('lightbox-rotation-status').textContent.includes('could not'));
  assert.equal(await page.evaluate(()=>lightboxRotation),180);
  await page.evaluate(()=>window.failSave=false);await page.locator('#lightbox-rotate-btn').click();await page.waitForFunction(()=>window.savedDetails.scan_config.image_rotation===270);
  await page.evaluate(()=>closeMediaLightbox());await page.locator('.chart-media-preview').click();assert.equal(await page.evaluate(()=>lightboxRotation),270);
  const screenshots=path.join(os.tmpdir(),'lumin-xray-rotation-preview');fs.mkdirSync(screenshots,{recursive:true});
  for(const viewport of [{width:1440,height:900},{width:834,height:1112},{width:390,height:844},{width:320,height:568}]){
    await page.setViewportSize(viewport);
    for(const language of ['en','ar']){
      await page.evaluate(language=>{currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';renderPatientMediaRotationControls();updateLightboxTransform();},language);
      const modal=await page.locator('#patient-media-lightbox > [role="dialog"]').boundingBox(),image=await page.locator('#lightbox-img').boundingBox(),viewportBox=await page.locator('#lightbox-viewport').boundingBox();
      assert.ok(modal.x>=0&&modal.y>=0&&modal.x+modal.width<=viewport.width+1&&modal.y+modal.height<=viewport.height+1,JSON.stringify({viewport,modal}));
      assert.ok(image.x>=viewportBox.x-1&&image.y>=viewportBox.y-1&&image.x+image.width<=viewportBox.x+viewportBox.width+1&&image.y+image.height<=viewportBox.y+viewportBox.height+1,JSON.stringify({viewport,image,viewportBox}));
      const button=await page.locator('#lightbox-rotate-btn').boundingBox();assert.ok(button.width>=44&&button.height>=44,JSON.stringify({viewport,button,style:await page.locator('#lightbox-rotate-btn').evaluate(node=>({minWidth:getComputedStyle(node).minWidth,minHeight:getComputedStyle(node).minHeight,transform:getComputedStyle(node).transform}))}));
      for(const box of await page.locator('#patient-media-lightbox > [role="dialog"] > :first-child button, #patient-media-lightbox > [role="dialog"] > :first-child a').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().toJSON())))assert.ok(box.x>=modal.x&&box.y>=modal.y&&box.right<=modal.x+modal.width+1&&box.bottom<=modal.y+modal.height+1,JSON.stringify({viewport,box,modal}));
      assert.match(await page.locator('#lightbox-rotate-btn').getAttribute('aria-label'),language==='ar'?/يُحفظ تلقائيًا/:/saves automatically/);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      if((viewport.width===1440&&language==='en')||(viewport.width===390&&language==='ar'))await page.screenshot({path:path.join(screenshots,`rotation-${viewport.width}-${language}.png`)});
    }
  }
  await page.evaluate(()=>{allowed=false;renderPatientMediaRotationControls();});assert.equal(await page.locator('#lightbox-rotate-btn').isDisabled(),true);
  await page.evaluate(()=>{closeMediaLightbox();document.getElementById('view-chart').classList.add('hidden');document.getElementById('view-patient-media').classList.remove('hidden');renderPatientMediaGrid();});
  const galleryImage=page.locator('.media-card-preview img');assert.equal(await galleryImage.getAttribute('data-media-rotation'),'270');
  await page.waitForFunction(()=>document.querySelector('.media-card-preview img').naturalWidth>0);await page.evaluate(()=>fitPatientMediaRotations());
  const galleryBox=await galleryImage.boundingBox(),galleryFrame=await page.locator('.media-card-preview').boundingBox();
  assert.ok(galleryBox.x>=galleryFrame.x&&galleryBox.y>=galleryFrame.y&&galleryBox.x+galleryBox.width<=galleryFrame.x+galleryFrame.width+1&&galleryBox.y+galleryBox.height<=galleryFrame.y+galleryFrame.height+1);
  assert.match(await page.locator('.media-card-note').textContent(),/Clinical note preserved/);
  assert.deepEqual(errors,[]);
});
