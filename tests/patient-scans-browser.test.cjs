const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const sample = process.env.LUMIN_SCAN_SAMPLE || 'C:/Users/Lenovo/Desktop/Mervat Sa3eed Sadek.zip';
const obj = 'mtllib arch.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl _texture\nf 1/1 2/2 3/3\n';
const bootstrap = `
window.records = []; window.failMetadata = false;
window.fakeDb = { from() { return {
 select() { return { eq: async (_,id) => ({data:window.records.filter(r=>r.patient_id===id),error:null}) }; },
 async upsert(row) {
   if(window.failMetadata) {window.failMetadata=false;return {error:{message:'forced failure'}};}
   const index=window.records.findIndex(r=>r.relative_path===row.relative_path);
   if(index<0)window.records.push(row);else window.records[index]={...window.records[index],...row};
   return {error:null};
 }, delete() { return {eq() {return {in:async (_,paths)=>{window.records=window.records.filter(r=>!paths.includes(r.relative_path));return {error:null};}}}}; }
}; } };
window.mount = (id='test-patient') => { window.scans?.dispose(); window.scans=LuminPatientScans.mount(document.getElementById('view-patient-scans'),{
 patient:{id,name:'Test Patient'},storage:{url:location.origin,key:'test-key'},db:fakeDb,
 language:document.documentElement.lang==='ar'?'ar':'en',isCurrent:()=>true,openSettings:()=>{}
});return window.scans.ready;}; mount();`;

test('scan viewer: original ZIP, comparison, controls, retries, safety, and responsive layouts', {timeout:240000}, async t => {
  const { zipSync, strToU8, unzipSync, strFromU8 } = await import(pathToFileURL(path.join(root, 'vendor/fflate/esm/browser.js')));
  const archives = new Map(), files = [], requests = []; let uploads = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); requests.push(url.pathname);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/')) {
      if(url.pathname!=='/api/health' && req.headers['x-lumin-key']!=='test-key') {res.statusCode=401;res.end();return;}
      if (url.pathname==='/api/health') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({maxFileSizeMB:50,capabilities:{patient3dScans:true,scanOriginalFilenames:true}}));return;}
      if (url.pathname.startsWith('/api/patient/')) {res.end(JSON.stringify({files:url.pathname.includes('/test-patient/')?files:[]}));return;}
      if (url.pathname==='/api/upload') {
        const parts=[]; for await(const part of req)parts.push(part);
        const data=Buffer.concat(parts), boundary=Buffer.from('--'+req.headers['content-type'].split('boundary=')[1]);
        const start=data.indexOf(Buffer.from('\r\n\r\n'))+4, end=data.indexOf(Buffer.concat([Buffer.from('\r\n'),boundary]),start);
        const uploadId=data.toString().match(/name="scanUploadId"\r\n\r\n([^\r]+)/)?.[1];
        const filename=data.subarray(0,start).toString().match(/filename="([^"]*)"/)?.[1];
        const content=data.subarray(start,end), relativePath=`Test/3D-Scans/${uploadId}/${filename}`;
        if(!archives.has(relativePath)){uploads++;archives.set(relativePath,content); files.unshift({filename,relativePath,category:'3D-Scans',sizeBytes:content.length,modifiedAt:'2026-10-05T12:00:00'});}
        res.end(JSON.stringify({success:true,relativePath}));return;
      }
      if(url.pathname==='/api/file') {const chunks=[];for await(const c of req)chunks.push(c);const data=JSON.parse(Buffer.concat(chunks));const index=files.findIndex(f=>f.relativePath===data.relativePath);files.splice(index,1);archives.delete(data.relativePath);res.end('{}');return;}
      if(url.pathname.startsWith('/files/')) {const data=archives.get(decodeURIComponent(url.pathname.slice(7)));res.setHeader('Content-Type','application/zip');res.end(data);return;}
    }
    if(url.pathname==='/') {res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/lumin-theme.css"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/lumin-patient-scans.css"><style>body{margin:0;padding:24px;background:#f8fafc;font-family:Arial}*{box-sizing:border-box}h3,h4,p{margin:0}[hidden]{display:none!important}</style></head><body><section id="view-patient-scans"></section><script src="/vendor/lucide.min.js"></script><script src="/lumin-patient-scans.js"></script><script>${bootstrap}</script></body></html>`);return;}
    const target=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!target.startsWith(root+path.sep)||!fs.existsSync(target)||!fs.statSync(target).isFile()){res.statusCode=404;res.end();return;}
    res.setHeader('Content-Type',target.endsWith('.css')?'text/css':'application/javascript');res.end(fs.readFileSync(target));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||'chrome',args:['--enable-unsafe-swiftshader']});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:1000},acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.evaluate(()=>scans.ready);
  const bytes=fs.existsSync(sample)?fs.readFileSync(sample):Buffer.from(zipSync({'restoration_upper.obj':strToU8(obj),'restoration_lower.obj':strToU8(obj.replace('v 0 0 0','v 0 0 -1')),'arch.mtl':strToU8('newmtl _texture\nKd 1 1 1')}));
  const importZip=async (buffer,name='sample.zip')=>{
    await page.locator('.scan-file').setInputFiles({name,mimeType:'application/zip',buffer});
    await page.waitForFunction(()=>scans.previewReady || (!scans.busy && document.querySelector('.scan-message:not([hidden])')),{},{timeout:60000});
  };
  await importZip(bytes,'Original scan.zip');
  assert.equal(await page.evaluate(()=>scans.previewReady),true);
  const settings = page.locator('.scan-settings-toggle'), panel = page.locator('.scan-viewer-panel');
  assert.equal(await panel.isVisible(),false);
  assert.equal(await settings.getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('.scan-stage [data-scan-setting]').count(),12);
  assert.equal(await page.locator('.scan-workspace > .scan-tools').count(),0);
  const square = await page.locator('.scan-stage').boundingBox();
  assert.ok(Math.abs(square.width-square.height)<2,JSON.stringify(square));
  const settingsBounds = await settings.boundingBox();
  assert.ok(settingsBounds.x>square.x+square.width/2 && settingsBounds.y>square.y+square.height-64);
  assert.equal(await page.locator('[data-scan-setting="background"]').inputValue(),'dark');
  assert.equal(await page.evaluate(()=>scans.viewer.panes[0].scene.background.getHex()),0x1e293b);
  const artifacts=process.env.LUMIN_SCAN_SCREENSHOTS;
  if(artifacts) {fs.mkdirSync(artifacts,{recursive:true});await page.locator('.scan-stage').screenshot({path:path.join(artifacts,'viewer-closed.png')});}
  await settings.click(); assert.equal(await panel.isVisible(),true);
  assert.equal(await settings.getAttribute('aria-controls'),await panel.getAttribute('id'));
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.scanViewerAction),'closeSettings');
  if(artifacts) await page.locator('.scan-stage').screenshot({path:path.join(artifacts,'viewer-settings.png'),animations:'disabled'});
  await page.keyboard.press('Escape');assert.equal(await panel.isVisible(),false);
  assert.equal(await page.evaluate(()=>document.activeElement.className),'scan-settings-toggle');
  await settings.click();await panel.locator('[data-scan-viewer-action="closeSettings"]').click();assert.equal(await panel.isVisible(),false);
  await settings.click();await settings.click();assert.equal(await panel.isVisible(),false);
  // Native fullscreen resizes the existing renderer without changing the camera.
  const fullscreen = page.locator('.scan-fullscreen-toggle');
  const initialPose = await page.evaluate(()=>scans.viewer.panes[0].camera.position.toArray());
  await fullscreen.click(); await page.waitForFunction(()=>document.fullscreenElement === scans.viewer.host);
  await page.waitForFunction(()=>scans.viewer.renderer.domElement.clientHeight === innerHeight);
  assert.equal(await fullscreen.getAttribute('aria-label'),'Exit full screen');
  assert.equal(await fullscreen.getAttribute('aria-pressed'),'true');
  assert.deepEqual(await page.evaluate(()=>scans.viewer.panes[0].camera.position.toArray()),initialPose);
  await settings.click(); await page.locator('[data-scan-setting="mode"]').selectOption('wireframe');
  assert.equal(await page.evaluate(()=>scans.viewer.panes[0].arches.upper.children.every(m=>m.material.wireframe)),true);
  assert.deepEqual(await page.evaluate(()=>scans.viewer.panes[0].camera.position.toArray()),initialPose);
  await page.locator('[data-scan-setting="mode"]').selectOption('textured');
  await settings.click();assert.equal(await panel.isVisible(),false);
  await fullscreen.click(); await page.waitForFunction(()=>!document.fullscreenElement);
  assert.equal(await fullscreen.getAttribute('aria-label'),'Full screen');
  if(fs.existsSync(sample)) {
    const stats=await page.evaluate(()=>scans.viewer.panes[0].arches.upper.children.map(m=>({vertices:m.geometry.attributes.position.count,texture:!!m.material.map,normal:m.geometry.attributes.normal.count})));
    assert.equal(stats[0].vertices,147555*3);assert.equal(stats[0].normal,stats[0].vertices);assert.ok(stats[0].texture);
    const coordinates=await page.evaluate(()=>({upper:scans.viewer.panes[0].arches.upper.children[0].geometry.attributes.position.array.slice(0,3).toString(),lower:scans.viewer.panes[0].arches.lower.children[0].geometry.attributes.position.array.slice(0,3).toString(),upperTransform:scans.viewer.panes[0].arches.upper.position.toArray(),lowerTransform:scans.viewer.panes[0].arches.lower.position.toArray()}));
    assert.deepEqual(coordinates.upperTransform,[0,0,0]);assert.deepEqual(coordinates.lowerTransform,[0,0,0]);
    const entries=unzipSync(bytes);
    for(const arch of ['upper','lower']) {
      const content=strFromU8(entries[Object.keys(entries).find(p=>p.endsWith(`restoration_${arch}.obj`))]);
      const vertices=content.split('\n').filter(line=>line.startsWith('v ')).map(line=>line.trim().split(/\s+/).slice(1).map(Number));
      const firstIndex=Number(content.split('\n').find(line=>line.startsWith('f ')).split(/\s+/)[1].split('/')[0])-1;
      const expected=new Float32Array(vertices[firstIndex]).toString();assert.equal(coordinates[arch],expected);
    }
  }
  await page.locator('[data-scan-field="name"]').fill('Baseline');await page.locator('[data-scan-field="date"]').fill('2026-10-01');
  await page.evaluate(()=>window.failMetadata=true);await page.locator('[data-scan-action="save"]').click();
  await page.waitForFunction(()=>scans.pending?.result && !scans.busy);assert.equal(uploads,1);
  await page.locator('[data-scan-action="save"]').click();await page.waitForFunction(()=>document.querySelectorAll('.scan-card').length===1);assert.equal(uploads,1);
  const downloadPromise=page.waitForEvent('download');await page.locator('[data-scan-action="download"]').click();const download=await downloadPromise;
  assert.equal(download.suggestedFilename(),'Original scan.zip');assert.deepEqual(fs.readFileSync(await download.path()),bytes);
  // A fresh instance represents another clinic device loading shared server files and DB details.
  await page.evaluate(()=>mount());await page.locator('[data-scan-action="open"]').click();await page.waitForFunction(()=>scans.previewReady,{},{timeout:60000});
  await page.locator('[data-scan-field="name"]').fill('Renamed baseline');await page.locator('[data-scan-action="save"]').click();await page.waitForFunction(()=>document.querySelector('.scan-card h4')?.textContent==='Renamed baseline');
  await importZip(bytes,'Second scan.zip');await page.locator('[data-scan-field="name"]').fill('Follow-up');await page.locator('[data-scan-action="save"]').click();await page.waitForFunction(()=>document.querySelectorAll('.scan-card').length===2);
  await page.locator('[data-scan-select="0"]').check();await page.locator('[data-scan-select="1"]').check();await page.locator('[data-scan-action="compare"]').click();await page.waitForFunction(()=>scans.viewer?.panes.length===2,{},{timeout:60000});
  assert.equal(await page.locator('.scan-stage canvas').count(),1);
  await page.waitForFunction(()=>!scans.busy);
  await fullscreen.click(); await page.waitForFunction(()=>document.fullscreenElement === scans.viewer.host);
  assert.equal(await page.locator('.scan-pane').count(),2);
  await page.evaluate(()=>document.exitFullscreen());
  await page.waitForFunction(()=>document.querySelector('.scan-fullscreen-toggle').getAttribute('aria-pressed')==='false');
  await page.locator('.scan-pane').first().scrollIntoViewIfNeeded();
  const box=await page.locator('.scan-pane').first().boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
  const pose=()=>page.evaluate(()=>{
    const pane=scans.viewer.panes[0];return {target:pane.controls.target.toArray(),offset:pane.camera.position.clone().sub(pane.controls.target).toArray()};
  });
  const difference=(a,b)=>Math.hypot(...a.map((value,index)=>value-b[index]));
  // Left + right pans; releasing right resumes left-button rotation without a jump.
  await page.mouse.move(x,y);await page.mouse.down({button:'left'});await page.mouse.move(x+15,y+5);
  let before=await pose();await page.mouse.down({button:'right'});await page.mouse.move(x+60,y+25,{steps:4});let after=await pose();
  assert.ok(difference(before.target,after.target)>.01);assert.ok(difference(before.offset,after.offset)<1e-6);
  assert.ok(await page.evaluate(()=>scans.viewer.panes[0].controls.target.distanceTo(scans.viewer.panes[1].controls.target)<1e-8));
  before=await pose();await page.mouse.up({button:'right'});after=await pose();assert.ok(difference(before.offset,after.offset)<1e-6);
  await page.mouse.move(x+85,y+30,{steps:3});after=await pose();assert.ok(difference(before.target,after.target)<1e-6);assert.ok(difference(before.offset,after.offset)>.01);await page.mouse.up({button:'left'});
  // Right alone stays still; pressing left second starts the same pan gesture.
  await page.mouse.move(x,y);before=await pose();await page.mouse.down({button:'right'});await page.mouse.move(x+20,y+10);after=await pose();assert.ok(difference(before.target,after.target)<1e-6);assert.ok(difference(before.offset,after.offset)<1e-6);
  await page.mouse.down({button:'left'});await page.mouse.move(x+55,y+30,{steps:3});after=await pose();assert.ok(difference(before.target,after.target)>.01);assert.ok(difference(before.offset,after.offset)<1e-6);
  before=await pose();await page.mouse.up({button:'left'});await page.mouse.move(x+75,y+40);after=await pose();assert.ok(difference(before.target,after.target)<1e-6);assert.ok(difference(before.offset,after.offset)<1e-6);await page.mouse.up({button:'right'});
  await page.locator('[data-scan-action="view"][data-index="reset"]').click();
  await settings.click();
  await page.evaluate(()=>{scans.viewer.panes[0].camera.position.x+=1;scans.viewer.panes[0].controls.update();});
  assert.ok(await page.evaluate(()=>scans.viewer.panes[0].camera.position.distanceTo(scans.viewer.panes[1].camera.position)<1e-8));
  await page.locator('[data-scan-setting="linked"]').uncheck();await page.evaluate(()=>{scans.viewer.panes[0].camera.position.x+=1;scans.viewer.panes[0].controls.update();});
  assert.equal(await page.evaluate(()=>scans.viewer.panes[0].camera.position.equals(scans.viewer.panes[1].camera.position)),false);
  await page.locator('[data-scan-setting="mode"]').selectOption('wireframe');
  assert.equal(await page.evaluate(()=>scans.viewer.panes.every(p=>p.arches.upper.children.every(m=>m.material.wireframe))),true);
  await page.locator('[data-scan-setting="mode"]').selectOption('solid');await page.locator('[data-scan-setting="upper"]').uncheck();
  assert.equal(await page.evaluate(()=>scans.viewer.panes.every(p=>!p.arches.upper.visible)),true);
  await page.locator('[data-scan-setting="lowerOpacity"]').fill('0.5');
  await page.locator('.scan-tools').nth(1).locator('summary').click();await page.locator('[data-scan-setting="cut"]').check();await page.locator('[data-scan-setting="axis"]').selectOption('x');await page.locator('[data-scan-setting="reverse"]').check();
  assert.equal(await page.evaluate(()=>scans.viewer.panes.every(p=>p.arches.lower.children.every(m=>m.material.opacity===.5 && m.material.clippingPlanes[0].normal.x===-1))),true);
  await page.locator('[data-scan-setting="background"]').selectOption('light');
  await page.locator('[data-scan-action="view"][data-index="reset"]').click();assert.equal(await page.evaluate(()=>scans.settings.cut===false&&scans.settings.upper&&scans.settings.lowerOpacity===1&&scans.settings.background==='dark'),true);
  assert.equal(await page.locator('[data-scan-setting="background"]').inputValue(),'dark');
  // Browser graphics-context restoration should resume rendering without reimporting.
  await page.evaluate(()=>{window.lossExtension=scans.viewer.renderer.getContext().getExtension('WEBGL_lose_context');lossExtension?.loseContext();});
  await page.waitForFunction(()=>document.querySelector('[data-graphics-lost]'));await page.evaluate(()=>lossExtension.restoreContext());await page.waitForFunction(()=>!document.querySelector('[data-graphics-lost]'));
  const pixels=await page.evaluate(()=>{
    const viewer=scans.viewer;viewer.render();const gl=viewer.renderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight,colors=new Uint8Array(w*h*4);
    gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,colors);const counts=[0,0];
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;if(Math.abs(colors[i]-30)+Math.abs(colors[i+1]-41)+Math.abs(colors[i+2]-59)>50)counts[x<w/2?0:1]++;}
    return counts;
  });assert.ok(pixels.every(count=>count>1000),JSON.stringify(pixels));
  for(const language of ['en','ar']) {
    await page.evaluate(language=>{document.documentElement.lang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';return mount();},language);
    await page.locator('[data-scan-select="0"]').check();await page.locator('[data-scan-select="1"]').check();await page.locator('[data-scan-action="compare"]').click();await page.waitForFunction(()=>scans.viewer?.panes.length===2 && !scans.busy,{},{timeout:60000});
    assert.match(await page.locator('.scan-header h3').textContent(),language==='ar'?/ثلاثي/:/3D/);
    for(const width of [390,820,1280]) for(const raised of [false,true]) {
    await page.setViewportSize({width,height:1000});await page.evaluate(raised=>document.body.classList.toggle('lumin-raised',raised),raised);
    const size=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,short:[...document.querySelectorAll('#view-patient-scans button')].filter(b=>b.getBoundingClientRect().height&&b.getBoundingClientRect().height<44).length}));
    assert.ok(size.scroll<=size.width,JSON.stringify(size));assert.equal(size.short,0);
    if(width===390) assert.ok(await page.evaluate(()=>document.querySelectorAll('.scan-pane')[1].getBoundingClientRect().top>document.querySelectorAll('.scan-pane')[0].getBoundingClientRect().top));
    if (!raised) {
      const overflow = await page.evaluate(()=>document.body.style.overflow);
      await page.evaluate(()=>{scans.viewer.host.requestFullscreen = undefined;});
      await fullscreen.click(); await page.waitForFunction(()=>!!document.querySelector('body > .scan-expanded'));
      assert.equal(await fullscreen.getAttribute('aria-label'),language==='ar'?'الخروج من ملء الشاشة':'Exit full screen');
      const bounds = await page.locator('.scan-stage').boundingBox();
      assert.equal(bounds.width,width); assert.equal(bounds.height,1000);
      const target = await fullscreen.boundingBox(); assert.ok(target.width>=44 && target.height>=44);
      assert.ok(target.x>=0 && target.x+target.width<=width);
      assert.equal(await page.locator('.scan-fullscreen-toggle svg').count(),1);
      await page.keyboard.press('Tab'); assert.equal(await page.evaluate(()=>document.activeElement.className),'scan-pane');
      await settings.click();assert.equal(await panel.isVisible(),true);
      assert.equal(await panel.getAttribute('dir'),language==='ar'?'rtl':'ltr');
      await page.locator('.scan-pane').last().focus();await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(()=>document.activeElement.dataset.scanViewerAction),'closeSettings');
      await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.className),'scan-pane');
      const panelBounds = await panel.boundingBox();
      assert.ok(panelBounds.x>=0 && panelBounds.x+panelBounds.width<=width);
      assert.ok(panelBounds.y>=0 && panelBounds.y+panelBounds.height<=1000);
      const cameraBefore = await page.evaluate(()=>scans.viewer.panes[0].camera.position.toArray());
      await page.locator('[data-scan-setting="mode"]').selectOption('wireframe');
      assert.equal(await page.evaluate(()=>scans.viewer.panes.every(p=>p.arches.upper.children.every(m=>m.material.wireframe))),true);
      await page.locator('[data-scan-setting="upper"]').uncheck();
      assert.equal(await page.evaluate(()=>scans.viewer.panes.every(p=>!p.arches.upper.visible)),true);
      assert.deepEqual(await page.evaluate(()=>scans.viewer.panes[0].camera.position.toArray()),cameraBefore);
      await page.locator('[data-scan-action="view"][data-index="reset"]').click();
      assert.equal(await page.locator('[data-scan-setting="upper"]').isChecked(),true);
      assert.equal(await page.locator('[data-scan-setting="mode"]').inputValue(),'textured');
      await page.keyboard.press('Escape');assert.equal(await panel.isVisible(),false);
      assert.equal(await page.locator('.scan-expanded').count(),1);
      await page.keyboard.press('Escape'); await page.waitForFunction(()=>!document.querySelector('.scan-expanded'));
      assert.equal(await page.evaluate(()=>document.body.style.overflow),overflow);
      assert.equal(await page.locator('#view-patient-scans .scan-stage').count(),1);
    }
    const artifacts=process.env.LUMIN_SCAN_SCREENSHOTS;
    if(artifacts && !raised && ((language==='en'&&width===1280)||(language==='ar'&&width===390))) {fs.mkdirSync(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,language==='en'?'comparison.png':'arabic-mobile.png'),fullPage:true});}
    // The panel stays inside the embedded viewer at every breakpoint and scrolls on mobile.
    await settings.click();
    const embedded = await page.evaluate(()=>{
      const stage=document.querySelector('.scan-stage').getBoundingClientRect(),panel=document.querySelector('.scan-viewer-panel').getBoundingClientRect();
      return {inside:panel.left>=stage.left&&panel.right<=stage.right&&panel.top>=stage.top&&panel.bottom<=stage.bottom,scroll:document.documentElement.scrollWidth,width:innerWidth};
    });assert.equal(embedded.inside,true);assert.ok(embedded.scroll<=embedded.width);
    if(artifacts && language==='ar' && width===390 && !raised) await page.locator('.scan-stage').screenshot({path:path.join(artifacts,'arabic-mobile-settings.png'),animations:'disabled'});
    await page.locator('[data-scan-setting="background"]').selectOption('light');
    assert.equal(await page.evaluate(()=>scans.viewer.panes.every(p=>p.scene.background.getHex()===0xf1f5f9)),true);
    await page.locator('[data-scan-action="view"][data-index="reset"]').click();
    await settings.click();
    }
  }
  await page.setViewportSize({width:1280,height:1000});await page.evaluate(()=>{document.documentElement.lang='en';document.documentElement.dir='ltr';scans.options.language='en';});
  // Changing patients while expanded removes the overlay and restores page scrolling.
  await fullscreen.click(); await page.waitForFunction(()=>!!document.querySelector('.scan-expanded'));
  await page.evaluate(()=>mount()); await page.waitForFunction(()=>document.querySelectorAll('.scan-card').length===2);
  assert.equal(await page.locator('.scan-expanded').count(),0); assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
  await page.locator('[data-scan-action="open"]').first().click(); await page.waitForFunction(()=>scans.previewReady);
  await page.setViewportSize({width:390,height:844});
  const mobileSquare = await page.locator('.scan-stage').boundingBox();assert.ok(Math.abs(mobileSquare.width-mobileSquare.height)<2);
  await settings.click();
  await page.locator('[data-scan-setting="lowerOpacity"]').fill('0.5');
  assert.equal(await page.evaluate(()=>scans.viewer.panes[0].arches.lower.children.every(m=>m.material.opacity===.5)),true);
  if(artifacts) await page.locator('.scan-stage').screenshot({path:path.join(artifacts,'mobile-settings.png'),animations:'disabled'});
  await settings.click();await page.setViewportSize({width:1280,height:1000});
  await page.locator('[data-scan-action="close"]').click();assert.equal(await page.evaluate(()=>scans.workers.size),0);
  // Missing textures and ambiguous file identification stay reviewable.
  const missing=Buffer.from(zipSync({'a.obj':strToU8(obj),'b.obj':strToU8(obj),'arch.mtl':strToU8('newmtl _texture\nmap_Kd missing.jpg')}));
  await page.locator('.scan-file').setInputFiles({name:'ambiguous.zip',mimeType:'application/zip',buffer:missing});await page.waitForFunction(()=>scans.pending?.paths.length===2);
  assert.equal(await page.locator('[data-scan-action="save"]').isDisabled(),true);
  await page.locator('[data-scan-field="upper"]').selectOption('a.obj');await page.locator('[data-scan-field="lower"]').selectOption('b.obj');await page.locator('[data-scan-action="preview"]').click();await page.waitForFunction(()=>scans.previewReady);
  assert.match(await page.locator('.scan-preview-warning').textContent(),/missing/);
  for(const [buffer,message] of [[Buffer.from('broken'),'damaged'],[Buffer.from(zipSync({'../upper.obj':strToU8(obj),'lower.obj':strToU8(obj)})),'unsafe'],[Buffer.from(zipSync({'upper.obj':strToU8(obj),'lower.obj':strToU8(obj),'arch.mtl':strToU8('newmtl _texture\nmap_Kd https://example.org/patient.jpg')})),'External']]) {
    await page.locator('[data-scan-action="close"]').click();await importZip(buffer);assert.match(await page.locator('.scan-message').textContent(),new RegExp(message,'i'));
  }
  assert.ok(!requests.some(url=>url.includes('patient.jpg')));
  await page.locator('[data-scan-action="close"]').click();await importZip(bytes,'Interrupted.zip');
  await page.evaluate(()=>{window.realFetch=window.fetch;window.interruptOnce=true;window.fetch=async(...args)=>{const response=await realFetch(...args);if(interruptOnce&&String(args[0]).endsWith('/api/upload')){interruptOnce=false;throw new TypeError('Interrupted response');}return response;};});
  await page.locator('[data-scan-action="save"]').click();await page.waitForFunction(()=>!scans.busy && !scans.pending.result);assert.equal(uploads,3);
  await page.locator('[data-scan-action="save"]').click();await page.waitForFunction(()=>document.querySelectorAll('.scan-card').length===3);assert.equal(uploads,3);await page.evaluate(()=>window.fetch=realFetch);
  // Leaving a patient during preparation terminates the worker and keeps its results out of the next patient.
  await page.locator('.scan-file').setInputFiles({name:'switch.zip',mimeType:'application/zip',buffer:bytes});await page.evaluate(()=>mount('other-patient'));await page.waitForFunction(()=>document.querySelector('.scan-empty'));assert.equal(await page.evaluate(()=>scans.workers.size),0);assert.equal(await page.locator('.scan-card').count(),0);
  await page.evaluate(()=>mount());await page.waitForFunction(()=>document.querySelectorAll('.scan-card').length===3);
  await page.evaluate(()=>{window.realGetContext=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl2'?null:realGetContext.call(this,type,...args)};});
  await page.locator('[data-scan-action="open"]').first().click();await page.waitForFunction(()=>!scans.busy && document.querySelector('.scan-message').textContent.includes('WebGL2'));
  await page.evaluate(()=>HTMLCanvasElement.prototype.getContext=realGetContext);
  await page.locator('[data-scan-action="close"]').click();page.once('dialog',dialog=>dialog.accept());await page.locator('[data-scan-action="delete"]').first().click();await page.waitForFunction(()=>document.querySelectorAll('.scan-card').length===2);
  await page.evaluate(()=>{window.realFetch=window.fetch;window.fetch=async(...args)=>String(args[0]).endsWith('/api/health')?new Response(JSON.stringify({maxFileSizeMB:50,capabilities:{patient3dScans:true}})):realFetch(...args);return mount();});
  assert.equal(await page.locator('[data-scan-action="import"]').first().isDisabled(),true);assert.match(await page.locator('.scan-warning').textContent(),/Update this storage server/);
  await page.evaluate(()=>window.fetch=realFetch);
  await page.evaluate(()=>scans.dispose());assert.equal(await page.evaluate(()=>scans.workers.size),0);assert.equal(await page.locator('canvas').count(),0);
  assert.deepEqual(errors,[]);
});
