const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {}
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp('    (?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}
const head = html.slice(0, html.indexOf('</head>') + 7).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const chartStart = html.indexOf('    <section id="view-chart"');
const chart = html.slice(chartStart, html.indexOf('    </section>', chartStart) + 14).replace('class="hidden space-y-6"', 'class="space-y-6"');
const modals = html.slice(html.indexOf('  <div id="patient-media-upload-modal"'), html.indexOf('  <!-- Modal: Change Media Category'));
const dictionaryStart = html.indexOf('    const ARABIC_UI_TEXT = Object.freeze(');
const dictionary = html.slice(dictionaryStart, html.indexOf('\n    });', dictionaryStart) + 8);
const helpers = [
  'isPrimaryToothId', 'palmerPositionForSlot', 'palmerQuadrantForSlot', 'palmerQuadrantLabel', 'palmerNotationSVG',
  'patientMediaToothLabel', 'patientMediaDisplayName', 'patientMediaFileUrl', 'readPatientMediaDetails', 'persistPatientMediaDetails',
  'showPatientMediaUploadError', 'openPatientMediaUploadModal', 'closePatientMediaUploadModal', 'setupMediaDropzoneEvents',
  'handleMediaFileSelected', 'selectPatientMediaUploadFile', 'resetMediaDropzonePreview', 'handlePatientMediaUploadSubmit',
  'createPatientMediaClipboardFile', 'pastePatientMediaFromClipboard',
  'isUiTranslationExcluded', 'arabicUiPhrase', 'translateUiTextNode', 'translateUiAttribute', 'translateUiTree',
].map(source).join('\n');

test('chart X-ray filters prefill uploads, allow multiple teeth, and save without leaving the chart', { skip: !chromium && 'Playwright is not available' }, async t => {
  const fixture = head + '<body><main id="app-main">' + chart + '</main>' + modals + '</body></html>';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(fixture); return; }
    const target = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', target.endsWith('.css') ? 'text/css' : 'application/javascript');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/thumbnail/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="240"><rect width="300" height="240" fill="#334155"/></svg>' }));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addScriptTag({ url: `http://127.0.0.1:${server.address().port}/vendor/lucide.min.js` });
  await page.addScriptTag({ content: `
    let currentUiLanguage='en', activePatientId='patient-1', activeWorkspacePatientId='patient-1', activePatientMediaPatientId='patient-1';
    let selectedPatientMediaUploadFile=null, patientMediaPreviewUrl='', patientMediaUploadContext=null, pendingPatientMediaUpload=null;
    let currentPatientMediaFiles=[], patientMediaDetailsError=false, canReadPatients=true, failDetails=false;
    const patientMediaClipboardExtensions={'image/png':'png'};
    const PRIMARY_TOOTH_BY_SLOT={4:'A',5:'B',6:'C',7:'D',8:'E',9:'F',10:'G',11:'H',12:'I',13:'J',20:'K',21:'L',22:'M',23:'N',24:'O',25:'P',26:'Q',27:'R',28:'S',29:'T'};
    const SLOT_BY_PRIMARY_TOOTH=Object.fromEntries(Object.entries(PRIMARY_TOOTH_BY_SLOT).map(([slot,id])=>[id,Number(slot)]));
    const uiTextSources=new WeakMap(), uiTextLastApplied=new WeakMap(), uiAttributeStates=new WeakMap();
    const TRANSLATABLE_ATTRIBUTES=['placeholder','title','aria-label'], PATIENTS_UI_AR={};
    function escapeHtml(value) { const node=document.createElement('span'); node.textContent=String(value); return node.innerHTML.replaceAll('"','&quot;'); }
    function hasPageAccess() { return canReadPatients; }
    function getKnownPatient(id) { return {id,name:id==='patient-1'?'Test patient':'Other patient'}; }
    function getStorageServerConfig() { return {url:location.origin,key:'test-key'}; }
    function patientWorkspaceId() { return activeWorkspacePatientId; }
    function openPatientWorkspace() { throw Error('Upload must stay on the chart'); }
    function renderPatientMedia() { window.galleryRefreshes++; }
    function openMediaLightbox() {}
    window.galleryRefreshes=0; window.uploads=[]; window.savedDetails=[]; window.mediaFiles=[];
    const db={from() { throw Error('Clinical metadata must use the local storage server'); }};
    window.XMLHttpRequest=class {
      upload={}; status=200;
      open() {} setRequestHeader() {}
      send(form) {
        const category=form.get('category'), patientId=form.get('patientId'), filename='film-'+(window.uploads.length+1)+'.png';
        const relativePath=patientId+'/'+category+'/'+filename;
        window.uploads.push({category,patientId,relativePath});
        window.mediaFiles.push({filename,relativePath,category,uploadedAt:new Date().toISOString()});
        this.responseText=JSON.stringify({relativePath}); queueMicrotask(()=>this.onload());
      }
    };
    const nativeFetch=window.fetch.bind(window);
    window.fetch=async (url,options)=>{
      if(String(url).includes('/api/patient/') && String(url).endsWith('/media-details')) {
        if(failDetails)return {ok:false,json:async()=>({error:'Save failed'})};
        const patientId=decodeURIComponent(String(url).split('/api/patient/')[1].split('/')[0]);
        const payload=JSON.parse(options.body), record={patient_id:patientId,relative_path:payload.relativePath,...payload.details};
        window.savedDetails.push(record);
        return {ok:true,json:async()=>({metadataSource:'local',details:record})};
      }
      if(String(url).includes('/api/patient/'))return {ok:true,json:async()=>({metadataSource:'local',files:window.mediaFiles.filter(file=>file.relativePath.startsWith(activePatientId+'/')).map(file=>({...file,mediaDetails:window.savedDetails.find(record=>record.relative_path===file.relativePath)||null}))})};
      return nativeFetch(url,options);
    };
    ${dictionary}
    ${helpers}
  ` });
  await page.addScriptTag({ url: `http://127.0.0.1:${server.address().port}/lumin-media-teeth.js` });
  await page.addScriptTag({ url: `http://127.0.0.1:${server.address().port}/lumin-chart-media.js` });
  await page.evaluate(async () => {
    document.getElementById('upper-arch').innerHTML=['3','4','A','5'].map(id=>'<div style="min-width:48px"><div class="chart-tooth-xray-slot" data-tooth-xray-slot="'+id+'"></div></div>').join('');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await loadChartPatientMedia();
  });
  const screenshots = process.env.LUMIN_MEDIA_SCREENSHOT_DIR || path.join(os.tmpdir(), 'lumin-chart-media-preview');
  fs.mkdirSync(screenshots, { recursive: true });
  for (const viewport of [{width:1440,height:900},{width:800,height:600},{width:834,height:1112},{width:390,height:844},{width:320,height:568}]) {
    await page.setViewportSize(viewport);
    for (const language of ['en','ar']) {
      await page.evaluate(language => {
        currentUiLanguage=language; document.documentElement.dir=language==='ar'?'rtl':'ltr';
        chartPatientMedia.filterToothIds=[]; chartPatientMedia.collapsed=true; renderChartMediaPanel(); window.scrollTo(0,0);
      }, language);
      assert.equal(await page.locator('[data-tooth-xray-slot="4"] button.is-unassigned').count(),1);
      await page.locator('[data-tooth-xray-slot="4"] button').click();
      assert.deepEqual(await page.evaluate(()=>chartPatientMedia.filterToothIds),['4']);
      assert.match(await page.locator('#chart-media-panel-body').textContent(),language==='ar'?/لا توجد أشعة/:/No X-rays assigned/);
      assert.equal(await page.locator('[data-tooth-xray-slot="4"] button').isEnabled(),true);
      await page.locator('#chart-media-filter-teeth').click();
      assert.equal(await page.locator('[data-media-tooth="4"]').getAttribute('aria-pressed'),'true');
      await page.locator('[data-media-tooth="3"]').click();
      await page.locator('[data-media-dentition="primary"]').click();
      await page.locator('[data-media-tooth="A"]').click();
      await page.locator('.media-teeth-save').click();
      assert.deepEqual(await page.evaluate(()=>chartPatientMedia.filterToothIds),['4','3','A']);
      assert.equal(await page.locator('.chart-media-filter-chip').count(),3);
      await page.locator('[data-chart-add-xray]').click();
      assert.equal(await page.locator('#upload-media-category').inputValue(),'Periapical');
      assert.equal(await page.locator('#upload-media-tooth-ids').inputValue(),'["4","3","A"]');
      assert.equal(await page.evaluate(()=>document.getElementById('view-chart').classList.contains('hidden')),false);
      assert.equal(await page.evaluate(()=>document.getElementById('chart-media-panel').inert),true);
      assert.equal(await page.locator('#upload-media-category').evaluate(node=>node===document.activeElement),true);
      const dialog=await page.locator('#patient-media-upload-modal [role="dialog"]').boundingBox();
      assert.ok(dialog.x>=0 && dialog.x+dialog.width<=viewport.width+1 && dialog.y>=0 && dialog.y+dialog.height<=viewport.height+1, JSON.stringify({viewport,language,dialog}));
      assert.ok(await page.locator('#btn-submit-media-upload').isVisible());
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.locator('#upload-media-teeth-button').click();
      await page.locator('[data-media-tooth="4"]').click();
      await page.locator('.media-teeth-save').click();
      assert.equal(await page.locator('#upload-media-tooth-ids').inputValue(),'["3","A"]');
      assert.deepEqual(await page.evaluate(()=>chartPatientMedia.filterToothIds),['4','3','A'],'Upload edits do not change the filter');
      await page.locator('#upload-media-category').selectOption('Panoramic');
      assert.equal(await page.locator('#upload-media-category').inputValue(),'Panoramic');
      await page.locator('#btn-submit-media-upload').focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(()=>document.getElementById('patient-media-upload-modal').contains(document.activeElement)),true,'Upload traps focus');
      if (viewport.width===1440 && language==='en') await page.screenshot({path:path.join(screenshots,'chart-add-xray-popup.png')});
      if (viewport.width===390 && language==='ar') await page.screenshot({path:path.join(screenshots,'chart-add-xray-popup-ar.png')});
      await page.keyboard.press('Escape');
      assert.ok(!(await page.locator('#patient-media-upload-modal').isVisible()));
      assert.equal(await page.evaluate(()=>document.getElementById('chart-media-panel').inert),false);
      assert.equal(await page.locator('[data-chart-add-xray]').evaluate(node=>node===document.activeElement),true);
      await page.locator('[data-chart-clear-filter]').click();
    }
  }
  await page.setViewportSize({width:1440,height:900});
  await page.evaluate(()=>{currentUiLanguage='en';document.documentElement.dir='ltr';});
  await page.locator('[data-tooth-xray-slot="3"] button').click();
  await page.locator('[data-tooth-xray-slot="4"] button').click();
  assert.deepEqual(await page.evaluate(()=>chartPatientMedia.filterToothIds),['3','4'],'Chart icons add multiple teeth');
  await page.locator('[data-chart-add-xray]').click();
  await page.locator('#upload-media-file-input').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=','base64')});
  await page.locator('#upload-media-name').fill('Shared X-ray');
  await page.locator('#upload-media-note').fill('Review both teeth.');
  await page.evaluate(()=>{failDetails=true;});
  await page.locator('#btn-submit-media-upload').click();
  await page.waitForFunction(()=>pendingPatientMediaUpload && !document.getElementById('btn-submit-media-upload').disabled);
  assert.match(await page.locator('#upload-media-error').textContent(),/without uploading a duplicate/);
  await page.evaluate(()=>{failDetails=false; activeWorkspacePatientId='patient-2';});
  await page.locator('#btn-submit-media-upload').click();
  await page.waitForSelector('#patient-media-upload-modal',{state:'hidden'});
  assert.deepEqual(await page.evaluate(()=>window.savedDetails[0].tooth_ids),['3','4']);
  assert.equal(await page.evaluate(()=>window.savedDetails[0].patient_id),'patient-1','Upload retains the patient captured when opened');
  assert.equal(await page.evaluate(()=>window.uploads.length),1,'Retry does not duplicate the image');
  assert.equal(await page.evaluate(()=>window.uploads[0].category),'Periapical');
  assert.equal(await page.evaluate(()=>window.galleryRefreshes),0);
  assert.equal(await page.locator('.chart-media-caption h4').textContent(),'Shared X-ray');
  assert.equal(await page.locator('.chart-media-thumbnail').count(),1,'Shared image appears once in a multiple-tooth filter');
  assert.equal(await page.locator('[data-tooth-xray-slot="3"] button.is-unassigned, [data-tooth-xray-slot="4"] button.is-unassigned').count(),0);
  await page.locator('[data-tooth-xray-slot="4"] button').click();
  assert.deepEqual(await page.evaluate(()=>chartPatientMedia.filterToothIds),['3']);
  await page.locator('.chart-media-filter-chip').click();
  assert.deepEqual(await page.evaluate(()=>chartPatientMedia.filterToothIds),[]);
  await page.locator('[data-chart-add-xray]').click();
  assert.equal(await page.locator('#upload-media-tooth-ids').inputValue(),'[]');
  assert.equal(await page.locator('#upload-media-category').inputValue(),'Periapical');
  await page.evaluate(async()=>{activePatientId='patient-2';await loadChartPatientMedia();});
  assert.ok(!(await page.locator('#patient-media-upload-modal').isVisible()),'Changing patient closes an unsaved chart upload');
  assert.deepEqual(await page.evaluate(()=>chartPatientMedia.filterToothIds),[]);
  assert.equal(await page.locator('.chart-tooth-xray-indicator:not(.is-unassigned)').count(),0);
  assert.deepEqual(errors,[]);
});
