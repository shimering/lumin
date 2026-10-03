const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
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
const helpers = ['isPrimaryToothId', 'palmerPositionForSlot', 'palmerQuadrantForSlot', 'palmerQuadrantLabel', 'palmerToothNotation', 'chartToothLabel', 'renderToothHTML', 'renderEmptyToothHTML', 'toothDentitionLongPressTarget', 'beginToothDentitionLongPress', 'cancelToothDentitionLongPress', 'initLuminVoiceSpacebarShortcut', 'patientMediaToothLabel', 'patientMediaDisplayName', 'patientMediaDownloadName', 'patientMediaFileUrl', 'openPatientMediaLightboxByIndex', 'updateAppViewportDimensions'].map(source).join('\n');

test('X-ray upload dates use upload timestamps, retain the saved upload date after edits, and handle older files', () => {
  const context=vm.createContext({window:{matchMedia:()=>({matches:false})},document:{addEventListener(){}},currentUiLanguage:'en',escapeHtml:value=>String(value)});
  vm.runInContext(fs.readFileSync(path.join(root,'lumin-chart-media.js'),'utf8'),context);
  const markup=context.chartXrayUploadDateMarkup({uploadedAt:'2026-09-12T12:00:00Z',modifiedAt:'2026-10-02T12:00:00Z'});
  assert.match(markup,/Uploaded/);
  assert.match(markup,/12 Sept 2026/);
  assert.match(markup,/datetime="2026-09-12T12:00:00.000Z"/);
  const savedEpoch=Date.parse('2026-09-12T12:00:00Z')/1000;
  assert.match(context.chartXrayUploadDateMarkup({filename:`2026-09-12_${savedEpoch}_xray.png`,modifiedAt:'2026-10-02T12:00:00Z'}),/12 Sept 2026/);
  assert.match(context.chartXrayUploadDateMarkup({modifiedAt:'2026-09-01T12:00:00Z'}),/1 Sept 2026/);
  for(const file of [{},{modifiedAt:'invalid'},{uploadedAt:'<script>alert(1)</script>'}]) {
    assert.match(context.chartXrayUploadDateMarkup(file),/Upload date unavailable/);
    assert.doesNotMatch(context.chartXrayUploadDateMarkup(file),/<script>|Invalid Date|1970/);
  }
  context.currentUiLanguage='ar';
  assert.match(context.chartXrayUploadDateMarkup({modifiedAt:'2026-09-12T12:00:00Z'}),/تاريخ الرفع/);
  assert.match(context.chartXrayUploadDateMarkup({}),/تاريخ الرفع غير متوفر/);
});

async function settleChartMediaMotion(page) {
  await page.evaluate(async()=>{
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const running=document.getElementById('chart-clinical-workspace').getAnimations({subtree:true}).filter(animation=>Number.isFinite(animation.effect.getTiming().iterations));
    await Promise.all(running.map(animation=>animation.finished.catch(()=>{})));
  });
}

test('landscape chart viewer stays on the right while scrolling; attachment previews and patient changes are isolated', { skip: !chromium && 'Playwright is not available' }, async t => {
  const fixture = head + '<body><header id="app-header" style="height:64px;padding:20px;font-weight:600">LUMIN · Dental clinic</header><main id="app-main"><header id="patient-workspace-header" style="height:64px;padding:20px;background:white;border-radius:16px;margin-bottom:16px">Ahmed Hassan · Dental chart</header>' + chart + '</main></body></html>';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(fixture); return; }
    if (url.pathname === '/shell') { res.setHeader('Content-Type', 'text/html'); res.end(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')); return; }
    const target = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', target.endsWith('.css') ? 'text/css' : 'application/javascript');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({reducedMotion:'reduce',timezoneId:'Africa/Cairo'});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/thumbnail/**', route => route.fulfill({contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="460"><rect width="600" height="460" fill="#151b23"/><path d="M150 160 Q200 110 245 160 L265 330 L240 330 L205 230 L170 330 L150 320 Z M295 160 Q350 110 395 160 L410 330 L385 330 L350 240 L310 330 L290 320 Z" fill="#b4bac4" stroke="#697386" stroke-width="8"/><text x="160" y="410" font-size="24" fill="#94a3b8">Test radiograph</text></svg>'}));
  await page.route('**/files/**', route => {
    const filename = new URL(route.request().url()).pathname;
    if (filename.endsWith('.txt')) return route.fulfill({ contentType:'text/plain', body:'<script>alert("unsafe")</script>\nClinical report: follow up.' });
    if (filename.endsWith('.pdf')) return route.fulfill({ contentType:'application/pdf', body:'%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF' });
    return route.fulfill({ contentType:'application/octet-stream', body:'sample' });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addScriptTag({ url:`http://127.0.0.1:${server.address().port}/vendor/lucide.min.js` });
  await page.addScriptTag({ content: `
    let currentUiLanguage = 'en', activePatientId = 'patient-1', activeWorkspacePatientId = 'patient-1';
    let currentPatientMediaFiles = [], activePatientMediaPatientId = 'patient-1', patientMediaDetailsError = false;
    let canReadPatients = true, metadataError = false, storageUrl = location.origin;
    let toothDentitionLongPressGesture = null, toothDentitionLongPressSuppressClickUntil = 0;
    const TOOTH_DENTITION_LONG_PRESS_DELAY = 550;
    window.toothSelections = 0; window.dentitionSwitches = 0;
    let luminVoiceRecordingActive=false, luminVoiceProcessingActive=false, luminVoiceStarting=false;
    window.voiceStarts=0;
    function startLuminVoiceRecording() { window.voiceStarts++; }
    function stopLuminVoiceRecording() {}
    function getActivePatient() { return getKnownPatient(activePatientId); }
    function chartToothHasFinding() { return false; }
    function toggleToothDentition() { window.dentitionSwitches++; }
    function generateRealisticToothPhoto() { return '<svg class="odontogram-anatomy" width="40" height="100" viewBox="0 0 40 100"><path d="M4 24 Q0 0 20 4 Q40 0 36 24 L31 90 L22 90 L19 58 L10 90 Z" fill="#f3f0e9" stroke="#cbd5e1"/></svg>'; }
    function generateSurfaceMapSVG() { return '<div class="odontogram-surface-view" style="height:40px"></div>'; }
    const PRIMARY_TOOTH_BY_SLOT = {4:'A',5:'B',6:'C',7:'D',8:'E',9:'F',10:'G',11:'H',12:'I',13:'J',20:'K',21:'L',22:'M',23:'N',24:'O',25:'P',26:'Q',27:'R',28:'S',29:'T'};
    const SLOT_BY_PRIMARY_TOOTH = Object.fromEntries(Object.entries(PRIMARY_TOOTH_BY_SLOT).map(([slot,tooth]) => [tooth,Number(slot)]));
    const filesByPatient = {
      'patient-1': [
        {filename:'preop.png',relativePath:'Ahmed/Periapical/preop.png',category:'Periapical',sizeBytes:2048,uploadedAt:'2026-09-12T12:00:00Z',modifiedAt:'2026-10-02T12:00:00Z'},
        {filename:'child.png',relativePath:'Ahmed/Panoramic/child.png',category:'Panoramic',sizeBytes:1024,modifiedAt:'2026-09-01T12:00:00Z'},
        {filename:'lab.pdf',relativePath:'Ahmed/Lab/lab.pdf',category:'Lab',sizeBytes:4096},
        {filename:'report.txt',relativePath:'Ahmed/General/report.txt',category:'General',sizeBytes:128},
        {filename:'scan.dcm',relativePath:'Ahmed/General/scan.dcm',category:'General',sizeBytes:4096},
        {filename:'photo.jpg',relativePath:'Ahmed/Intraoral/photo.jpg',category:'Intraoral',sizeBytes:1024}
      ], 'patient-2': [{filename:'second.png',relativePath:'Sara/Periapical/second.png',category:'Periapical',sizeBytes:2048}]
    };
    const details = [{relative_path:'Ahmed/Periapical/preop.png',display_name:'UR6 before treatment',tooth_id:'3',tooth_ids:['3','4'],note:'Review distal surface.\\nCompare with the previous image.'},{relative_path:'Ahmed/Panoramic/child.png',display_name:'Deciduous follow-up',tooth_id:'A',note:'ملاحظة متابعة للطفل'}];
    function hasPageAccess() { return canReadPatients; }
    function getKnownPatient(id) { return {id, name:id === 'patient-1' ? 'Ahmed Hassan' : 'Sara Ahmed'}; }
    function getStorageServerConfig() { return {url:storageUrl,key:'test-key'}; }
    function escapeHtml(value) { const element = document.createElement('span'); element.textContent = String(value); return element.innerHTML.replaceAll('"','&quot;'); }
    function openMediaLightbox(...args) { window.lastLightbox = args; }
    function openPatientWorkspaceTab(tab) { window.lastWorkspaceTab = tab; }
    function openStorageSettings() { window.storageSettingsOpened = true; }
    const db = {from(table) { if(table !== 'patient_media_details') throw Error(table); return {select() {return this;},eq(column,id) {return Promise.resolve({data:id === 'patient-1' ? details : [],error:metadataError ? Error('Details unavailable') : null});}};}};
    const nativeFetch = window.fetch.bind(window);
    let holdPatientOne = false, releasePatientOne, holdText = false, releaseText;
    window.fetch = async (url, options) => {
      if (String(url).includes('/api/patient/')) {
        const id = String(url).split('/api/patient/')[1].split('/')[0];
        if (id === 'patient-1' && holdPatientOne) await new Promise(resolve => releasePatientOne = resolve);
        return {ok:true,json:async () => ({files:filesByPatient[id] || []})};
      }
      if (String(url).includes('/files/') && String(url).includes('report.txt') && holdText) await new Promise(resolve => releaseText=resolve);
      return nativeFetch(url, options);
    };
    ${helpers}
  ` });
  await page.addScriptTag({url:`http://127.0.0.1:${server.address().port}/lumin-media-teeth.js?v=1`});
  await page.addScriptTag({url:`http://127.0.0.1:${server.address().port}/lumin-chart-media.js?v=6`});
  await page.addScriptTag({url:`http://127.0.0.1:${server.address().port}/lumin-mobile-nav.js?v=1`});
  await page.evaluate(() => {
    document.dispatchEvent(new Event('DOMContentLoaded'));
    initLuminVoiceSpacebarShortcut();
    for (const [id, offset] of [['upper-arch',0],['lower-arch',16]]) document.getElementById(id).innerHTML = Array.from({length:16}, (_,i) => renderToothHTML({slot:i+offset+1,toothId:String(i+offset+1),dentition:'permanent'})).join('');
    document.addEventListener('pointerdown', beginToothDentitionLongPress);
    document.addEventListener('click', event => { if (event.target.closest('[data-tooth-card]')) window.toothSelections++; });
    document.getElementById('findings-container').innerHTML = Array.from({length:16}, (_,i) => '<article style="min-height:76px;padding:20px;border-radius:12px;background:white;margin-top:8px">Finding ' + (i+1) + ' · UR6 · In progress</article>').join('');
  });
  assert.equal(await page.evaluate(() => chartPatientMedia.collapsed), true, 'Default state is collapsed without stored preferences');
  assert.equal(await page.locator('#chart-media-toggle').count(),0, 'Only the right rail and tooth indicators open the viewer');
  const screenshots = process.env.LUMIN_MEDIA_SCREENSHOT_DIR || path.join(os.tmpdir(), 'lumin-chart-media-preview');
  fs.mkdirSync(screenshots, {recursive:true});
  for (const viewport of [{width:1440,height:900},{width:1180,height:820},{width:1024,height:768},{width:800,height:600},{width:834,height:1112},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    const landscape = viewport.width >= 768 && viewport.width > viewport.height;
    for (const language of ['en','ar']) {
      await page.evaluate(async language => { currentUiLanguage = language; document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr'; chartPatientMedia.collapsed = true; chartPatientMedia.filterToothId = ''; window.scrollTo(0,0); await loadChartPatientMedia(); }, language);
      assert.equal(await page.locator('#chart-media-panel').isVisible(), landscape);
      assert.ok(!(await page.locator('#chart-media-panel-body').isVisible()), 'Viewer starts collapsed');
      assert.equal(await page.locator('.chart-tooth-xray-indicator').count(), 2, 'Both teeth assigned to one image have indicators');
      const toothIndicator = page.locator('[data-tooth-xray-slot="3"] button');
      assert.equal(await toothIndicator.locator('small').textContent(), '1');
      const target = await toothIndicator.boundingBox();
      assert.ok(target.width >= 44 && target.height >= 44);
      await toothIndicator.click();
      assert.equal(await page.locator('#chart-media-collapse').getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('#chart-media-panel').evaluate(element => getComputedStyle(element).direction),language === 'ar' ? 'rtl' : 'ltr');
      assert.equal(await page.locator('.chart-media-thumbnail').count(), 1, 'Viewer is filtered to the tapped tooth');
      assert.equal(await page.locator('.chart-media-caption h4').textContent(), 'UR6 before treatment');
      assert.equal(await page.locator('.chart-media-upload-date time').getAttribute('datetime'),'2026-09-12T12:00:00.000Z');
      assert.match(await page.locator('.chart-media-upload-date').textContent(),language==='ar'?/تاريخ الرفع/:/Uploaded 12 Sept 2026/);
      assert.equal(await page.evaluate(() => [window.toothSelections, window.dentitionSwitches].join(',')), '0,0', 'Indicators do not select teeth or switch dentition');
      assert.ok(await page.locator('.chart-media-filter').isVisible());
      await page.locator('.chart-media-filter button').click();
      assert.equal(await page.locator('.chart-media-thumbnail').count(), 2, 'Clear filter restores all X-rays');
      if (!landscape) {
        assert.equal(await page.locator('#chart-media-panel').getAttribute('aria-modal'), 'true');
        const sheet = await page.locator('#chart-media-panel').boundingBox();
        assert.ok(sheet.x >= 0 && sheet.x + sheet.width <= viewport.width + 1 && sheet.y >= 0 && sheet.y + sheet.height <= viewport.height + 1);
        await page.locator('#chart-media-collapse').focus();
        await page.keyboard.press('Shift+Tab');
        assert.equal(await page.evaluate(() => document.getElementById('chart-media-panel').contains(document.activeElement)),true, 'Sheet traps keyboard focus');
        if (viewport.width === 390 && language === 'ar') await page.screenshot({path:path.join(screenshots,'chart-xray-sheet-ar.png')});
        await page.keyboard.press('Escape');
        assert.ok(!(await page.locator('#chart-media-panel').isVisible()));
        assert.equal(await toothIndicator.evaluate(element => element === document.activeElement),true, 'Closing returns focus to the tooth indicator');
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${viewport.width} ${language} overflow`);
      assert.equal(await page.locator('#chart-attachments-count').textContent(), '4');
      if (landscape) {
        const before = await page.locator('#chart-media-panel').boundingBox();
        const main = await page.locator('.chart-clinical-column').boundingBox();
        assert.ok(before.x >= main.x + main.width, 'Panel stays physically right in both languages');
        assert.ok(await page.locator('.chart-media-note').isVisible());
        assert.match(await page.locator('.chart-media-tooth').textContent(), /UR6/);
        assert.match(await page.locator('.chart-media-tooth').textContent(), /UR5/);
        await page.locator('.chart-media-thumbnail').nth(1).click();
        assert.equal(await page.locator('.chart-media-caption h4').textContent(), 'Deciduous follow-up');
        assert.match(await page.locator('.chart-media-tooth').textContent(), /URE/);
        await page.locator('.chart-media-thumbnail').first().click();
        await page.evaluate(() => window.scrollTo(0, 600));
        await page.waitForTimeout(100);
        const sticky = await page.locator('#chart-media-panel').boundingBox();
        assert.ok(sticky.y >= 0 && sticky.y + sticky.height <= viewport.height + 1, `Viewer remains on screen ${JSON.stringify({viewport,language,sticky,before,scroll:await page.evaluate(() => ({y:scrollY,top:getComputedStyle(document.getElementById('chart-media-panel')).top,maxHeight:getComputedStyle(document.getElementById('chart-media-panel')).maxHeight}))})}`);
        await page.evaluate(() => window.scrollTo(0, 900));
        const further = await page.locator('#chart-media-panel').boundingBox();
        assert.ok(Math.abs(sticky.y - further.y) < 2, 'Panel freezes as chart continues scrolling');
        await page.locator('#chart-media-collapse').click();
        assert.ok(!(await page.locator('#chart-media-panel-body').isVisible()));
        assert.equal(await page.locator('#chart-media-collapse').getAttribute('aria-expanded'), 'false');
        const collapsed = await page.locator('#chart-media-panel').boundingBox();
        assert.ok(collapsed.width <= 57);
        await page.locator('#chart-media-collapse').click();
        assert.ok(await page.locator('.chart-media-preview').isVisible());
        await page.locator('.chart-media-preview').click();
        assert.match(await page.evaluate(() => window.lastLightbox[0]), /Ahmed\/Periapical\/preop.png/);
        assert.equal(await page.evaluate(() => activePatientMediaPatientId),'patient-1');
        assert.equal(await page.evaluate(() => currentPatientMediaFiles.length),6);
        await page.evaluate(() => window.scrollTo(0,0));
        if (viewport.width === 1180 && language === 'en') await page.screenshot({path:path.join(screenshots,'chart-xray-landscape.png')});
        if (viewport.width === 1024 && language === 'ar') await page.screenshot({path:path.join(screenshots,'chart-xray-tablet-ar.png')});
      } else {
        await page.locator('[data-tooth-xray-slot="3"] button').click();
        assert.ok(await page.locator('.chart-media-preview').isVisible());
        await page.keyboard.press('Escape');
      }
      await page.locator('#chart-attachments-button').click();
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflowY),'hidden');
      assert.equal(await page.locator('#patient-attachment-title').textContent(), language === 'ar' ? 'المرفقات' : 'Attachments');
      assert.equal(await page.locator('.patient-attachment-row').count(),4);
      const dialog = await page.locator('.patient-attachment-dialog').boundingBox();
      assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= viewport.width + 1 && dialog.y >= 0 && dialog.y + dialog.height <= viewport.height + 1);
      await page.locator('.patient-attachment-row button').first().click();
      assert.ok(await page.locator('#patient-attachment-content iframe').isVisible());
      assert.match(await page.locator('#patient-attachment-content iframe').getAttribute('src'), /lab\.pdf\?key=test-key/);
      const targets = await page.locator('#patient-attachment-modal .chart-media-button').evaluateAll(elements => elements.map(element => ({w:element.getBoundingClientRect().width,h:element.getBoundingClientRect().height})));
      assert.ok(targets.every(target => target.w >= 44 && target.h >= 44));
      await page.keyboard.press('Escape');
      assert.ok(!(await page.locator('#patient-attachment-modal').isVisible()));
    }
  }
  await page.setViewportSize({width:1180,height:820});
  await page.emulateMedia({reducedMotion:'no-preference'});
  for(const language of ['en','ar']) {
    await page.setViewportSize({width:1280,height:820});
    await page.evaluate(language=>{currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';chartPatientMedia.collapsed=true;renderChartMediaPanel();window.scrollTo(0,0);},language);
    await settleChartMediaMotion(page);
    const rail=await page.locator('#chart-media-panel').boundingBox();
    assert.ok(rail.width<=57);
    await page.locator('[data-tooth-xray-slot="3"] button').click();
    const opening=await page.evaluate(()=>document.getElementById('chart-clinical-workspace').getAnimations({subtree:true}).filter(animation=>animation.playState==='running').length);
    assert.ok(opening>0,'Opening animates the width and morphing header');
    await page.waitForTimeout(90);
    const middle=await page.locator('#chart-media-panel').boundingBox();
    await settleChartMediaMotion(page);
    const expanded=await page.locator('#chart-media-panel').boundingBox();
    assert.ok(middle.width>rail.width+2&&middle.width<expanded.width-1,'Panel widens gradually from the rail');
    assert.ok(middle.height>rail.height&&middle.height<expanded.height+1,'The rail morphs into the taller viewer');
    assert.equal(await page.locator('.chart-media-upload-date time').getAttribute('datetime'),'2026-09-12T12:00:00.000Z');
    if(language==='en')await page.screenshot({path:path.join(screenshots,'chart-xray-upload-date.png')});
    await page.locator('#chart-media-collapse').click();
    assert.equal(await page.locator('#chart-media-panel-body').evaluate(body=>body.inert),true,'Collapsing content cannot receive focus');
    await page.waitForTimeout(90);
    const closing=await page.locator('#chart-media-panel').boundingBox();
    assert.ok(closing.width>rail.width+1&&closing.width<expanded.width-2,'Closing smoothly returns to the rail');
    await settleChartMediaMotion(page);
    assert.ok(!(await page.locator('#chart-media-panel-body').isVisible()));
    const title=await page.locator('.chart-media-panel-header h3').boundingBox();
    const collapsed=await page.locator('#chart-media-panel').boundingBox();
    assert.ok(title.x>=collapsed.x&&title.x+title.width<=collapsed.x+collapsed.width+1,'Morphed title stays inside the rail in both languages');
    await page.evaluate(async()=>{
      toggleChartMediaPanel();await new Promise(resolve=>setTimeout(resolve,80));
      toggleChartMediaPanel();await new Promise(resolve=>setTimeout(resolve,60));
      toggleChartMediaPanel();
    });
    await settleChartMediaMotion(page);
    assert.equal(await page.locator('#chart-media-collapse').getAttribute('aria-expanded'),'true');
    assert.equal(await page.locator('.chart-media-thumbnail').count(),1,'Rapid reversal retains the tooth filter');
    assert.equal(await page.locator('#chart-media-panel-body').evaluate(body=>body.inert),false);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.locator('#chart-media-collapse').click();await settleChartMediaMotion(page);
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('[data-tooth-xray-slot="3"] button').click();
  assert.ok(await page.evaluate(()=>chartMediaSheetAnimation?.playState==='running'),'Phone sheet slides in');
  await settleChartMediaMotion(page);
  assert.ok(await page.locator('.chart-media-preview').isVisible());
  await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(()=>chartMediaSheetAnimation?.playState==='running'),'Phone sheet slides out');
  await settleChartMediaMotion(page);
  assert.ok(!(await page.locator('#chart-media-panel').isVisible()));
  assert.equal(await page.evaluate(()=>document.body.classList.contains('chart-media-sheet-open')),false,'Closing restores page scrolling');
  await page.evaluate(async()=>{
    showChartToothXrays('3');await new Promise(resolve=>setTimeout(resolve,70));
    toggleChartMediaPanel();await new Promise(resolve=>setTimeout(resolve,60));
    showChartToothXrays('4');
  });
  await settleChartMediaMotion(page);
  assert.ok(await page.locator('.chart-media-preview').isVisible(),'Reversing a mobile close preserves the reopened sheet');
  assert.equal(await page.evaluate(()=>chartPatientMedia.filterToothId),'4');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.keyboard.press('Escape');
  assert.ok(!(await page.locator('#chart-media-panel').isVisible()),'Reduced motion closes immediately');
  assert.equal(await page.evaluate(()=>chartMediaSheetAnimation),null);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.locator('[data-tooth-xray-slot="3"] button').click();
  await page.evaluate(async()=>{activePatientId='patient-2';await loadChartPatientMedia();});
  assert.ok(!(await page.locator('#chart-media-panel').isVisible()),'Changing patients immediately cancels an old sheet animation');
  assert.equal(await page.evaluate(()=>chartMediaSheetAnimation),null);
  assert.equal(await page.evaluate(()=>document.body.classList.contains('chart-media-sheet-open')),false);
  await page.evaluate(async()=>{activePatientId='patient-1';await loadChartPatientMedia();});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.setViewportSize({width:1280,height:820});
  await page.locator('#chart-media-collapse').click();
  assert.equal(await page.evaluate(()=>{
    const workspace=document.getElementById('chart-clinical-workspace'),panel=document.getElementById('chart-media-panel');
    return workspace.getAnimations({subtree:true}).filter(animation=>animation.effect.target===workspace||panel.contains(animation.effect.target)).length;
  }),0,'Reduced motion skips morphing and sliding');
  await page.locator('#chart-media-collapse').click();

  await page.evaluate(async () => {
    currentUiLanguage='en'; document.documentElement.dir='ltr'; window.scrollTo(0,0);
    filesByPatient['patient-1'].push({filename:'followup.png',relativePath:'Ahmed/Periapical/followup.png',category:'Periapical'}, {filename:'unassigned.png',relativePath:'Ahmed/Panoramic/unassigned.png',category:'Panoramic'});
    details.push({relative_path:'Ahmed/Periapical/followup.png',display_name:'UR6 after treatment',tooth_ids:['3']}, {relative_path:'Ahmed/Intraoral/photo.jpg',tooth_ids:['5']}, {relative_path:'Ahmed/Lab/lab.pdf',tooth_ids:['6']});
    await loadChartPatientMedia();
  });
  assert.equal(await page.locator('[data-tooth-xray-slot="3"] small').textContent(),'2');
  assert.equal(await page.locator('[data-tooth-xray-slot="5"] button, [data-tooth-xray-slot="6"] button').count(),0, 'Assigned photos and PDFs are not X-ray indicators');
  await page.locator('[data-tooth-xray-slot="3"] button').click();
  assert.equal(await page.locator('.chart-media-thumbnail').count(),2);
  await page.locator('.chart-media-nav button').last().click();
  assert.equal(await page.locator('.chart-media-caption h4').textContent(),'UR6 after treatment');
  await page.evaluate(() => selectChartPatientXray(1));
  assert.equal(await page.locator('.chart-media-caption h4').textContent(),'UR6 after treatment', 'Selection cannot escape the active tooth filter');
  await page.evaluate(() => loadChartPatientMedia());
  assert.equal(await page.locator('.chart-media-caption h4').textContent(),'UR6 after treatment', 'Refresh preserves the selected assigned image');
  assert.equal(await page.evaluate(() => chartPatientMedia.filterToothId),'3');
  await page.locator('.chart-media-nav button').last().click();
  assert.equal(await page.locator('.chart-media-caption h4').textContent(),'UR6 before treatment', 'Navigation wraps only inside the filter');
  await page.locator('#chart-media-collapse').click();
  await page.locator('#chart-media-collapse').click();
  assert.equal(await page.locator('.chart-media-thumbnail').count(),2, 'Collapsing and reopening retains the filter');
  await page.screenshot({path:path.join(screenshots,'chart-xray-tooth-filter.png')});
  await page.locator('.chart-media-filter button').click();
  assert.equal(await page.locator('.chart-media-thumbnail').count(),4);
  await page.locator('[data-tooth-xray-slot="4"] button').click();
  assert.equal(await page.locator('.chart-media-thumbnail').count(),1);
  await page.evaluate(() => {
    document.getElementById('tooth-card-4').outerHTML=renderToothHTML({slot:4,toothId:'A',dentition:'primary'});
    renderChartToothXrayIndicators();
  });
  assert.equal(await page.locator('[data-tooth-xray-slot="A"] small').textContent(),'1');
  await page.locator('[data-tooth-xray-slot="A"] button').click();
  assert.equal(await page.locator('.chart-media-caption h4').textContent(),'Deciduous follow-up', 'Primary tooth is distinct from the permanent tooth at the same position');
  assert.equal(await page.evaluate(() => chartPatientMedia.filterToothId),'A');
  await page.locator('[data-tooth-xray-slot="A"] button').focus();
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => window.toothSelections),0, 'Keyboard indicator activation does not select a tooth');
  assert.equal(await page.evaluate(() => window.voiceStarts),0, 'Keyboard indicator activation does not start dictation');
  await page.locator('[data-tooth-xray-slot="A"] button').dispatchEvent('pointerdown',{button:0,isPrimary:true,clientX:100,clientY:100,pointerId:1});
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => window.dentitionSwitches),0, 'Holding an indicator does not change dentition');
  assert.equal(await page.evaluate(() => toothDentitionLongPressTarget(document.querySelector('[data-tooth-xray-slot="A"] button'))),null);
  await page.evaluate(async () => { details[1].tooth_ids=[]; await loadChartPatientMedia(); });
  assert.equal(await page.locator('[data-tooth-xray-slot="A"] button').count(),0, 'Assignment removal removes the indicator');
  assert.match(await page.locator('#chart-media-panel-body').textContent(),/No X-rays assigned to this tooth/);
  assert.equal(await page.evaluate(() => chartPatientMedia.filterToothId),'A', 'Empty filters remain until explicitly cleared');
  await page.locator('.chart-media-filter button').click();
  assert.equal(await page.locator('.chart-media-thumbnail').count(),4);
  await page.evaluate(() => { document.getElementById('tooth-card-A').outerHTML=renderToothHTML({slot:4,toothId:'4',dentition:'permanent'}); renderChartToothXrayIndicators(); });
  await page.locator('#chart-media-collapse').click();
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(() => { currentUiLanguage='en'; document.documentElement.dir='ltr'; openPatientAttachmentList(); });
  await page.locator('.patient-attachment-row button').nth(1).click();
  await page.waitForSelector('#patient-attachment-content pre');
  assert.match(await page.locator('#patient-attachment-content pre').textContent(), /<script>alert/);
  assert.equal(await page.locator('#patient-attachment-content script').count(),0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { holdText=true; window.textPreview=openPatientMediaFile(filesByPatient['patient-1'][3], 'patient-1'); openPatientAttachmentList(); });
  await page.evaluate(async () => { releaseText(); await window.textPreview; holdText=false; });
  assert.equal(await page.locator('.patient-attachment-row').count(),4,'A stale text preview cannot replace the attachment list');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { currentPatientMediaFiles=[filesByPatient['patient-1'][2]]; openPatientMediaLightboxByIndex(0); });
  assert.ok(await page.locator('#patient-attachment-content iframe').isVisible(), 'Gallery PDFs use the same document preview');
  await page.keyboard.press('Escape');
  await page.evaluate(() => openPatientAttachmentList());
  await page.locator('.patient-attachment-row button').nth(2).click();
  assert.match(await page.locator('#patient-attachment-content').textContent(), /compatible app/);
  assert.ok(await page.locator('#patient-attachment-footer a[download]').isVisible());
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:844,height:390});
  await page.evaluate(() => { Object.defineProperty(navigator,'userAgent',{configurable:true,value:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'}); renderChartMediaPanel(); });
  assert.ok(!(await page.locator('#chart-media-panel').isVisible()), 'Landscape phones keep a single-column chart');
  await page.locator('[data-tooth-xray-slot="3"] button').click();
  assert.ok(await page.locator('.chart-media-preview').isVisible(), 'Landscape phones open the X-ray sheet');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { delete navigator.userAgent; });
  await page.setViewportSize({width:1024,height:768});
  await page.evaluate(() => { chartPatientMedia.collapsed=false; renderChartMediaPanel(); });
  for (const zoom of [.8,1.25]) {
    await page.evaluate(zoom => { document.documentElement.style.zoom=zoom; updateAppViewportDimensions(); renderChartMediaPanel(); window.scrollTo(0,600); },zoom);
    const bounds = await page.locator('#chart-media-panel').boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y+bounds.height <= 769, `Viewer fits at scale ${zoom}`);
    await page.evaluate(() => openPatientAttachmentList());
    const modalBounds = await page.locator('.patient-attachment-dialog').boundingBox();
    assert.ok(modalBounds.y >= 0 && modalBounds.y+modalBounds.height <= 769, `Attachments fit at scale ${zoom}`);
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => { document.documentElement.style.zoom=''; updateAppViewportDimensions(); renderChartMediaPanel(); });
  await page.evaluate(() => { holdPatientOne=true; window.staleLoad=loadChartPatientMedia('patient-1'); activePatientId='patient-2'; return loadChartPatientMedia('patient-2'); });
  await page.evaluate(async () => { releasePatientOne(); await window.staleLoad; holdPatientOne=false; });
  assert.equal(await page.evaluate(() => chartPatientMedia.files[0].relativePath), 'Sara/Periapical/second.png');
  assert.equal(await page.evaluate(() => chartPatientMedia.patientId), 'patient-2');
  assert.equal(await page.evaluate(() => chartPatientMedia.filterToothId),'');
  assert.equal(await page.evaluate(() => chartPatientMedia.collapsed),true, 'Changing patient restores the default collapsed viewer');
  assert.equal(await page.locator('.chart-tooth-xray-indicator').count(),0, 'Another patient cannot retain the previous indicators');
  await page.evaluate(() => { activePatientId='patient-1'; metadataError=true; return loadChartPatientMedia(); });
  assert.match(await page.locator('#chart-media-panel-body').textContent(), /could not be loaded/);
  assert.equal(await page.locator('.chart-tooth-xray-indicator').count(),0, 'Unavailable metadata cannot create misleading indicators');
  await page.evaluate(() => { canReadPatients=false; return loadChartPatientMedia(); });
  assert.equal(await page.evaluate(() => chartPatientMedia.files.length),0);
  assert.equal(await page.locator('.chart-tooth-xray-indicator').count(),0);
  assert.ok(await page.locator('#chart-attachments-button').isDisabled());
  await page.evaluate(() => { canReadPatients=true; storageUrl=''; return loadChartPatientMedia(); });
  assert.match(await page.locator('#chart-media-panel-body').textContent(), /Connect your clinic storage/);
  await page.evaluate(() => { storageUrl=location.origin; metadataError=false; return loadChartPatientMedia(); });
  await page.evaluate(() => { document.body.classList.add('lumin-raised'); renderChartMediaPanel(); openPatientAttachmentList(); resetChartPatientMedia(); });
  assert.ok(!(await page.locator('#patient-attachment-modal').isVisible()));
  assert.equal(await page.evaluate(() => chartPatientMedia.files.length),0);
  await page.goto(`http://127.0.0.1:${server.address().port}/shell`);
  await page.addScriptTag({ url:`http://127.0.0.1:${server.address().port}/vendor/lucide.min.js` });
  await page.addScriptTag({content:`
    let currentUiLanguage='en', activePatientId='patient-1';
    function hasPageAccess() { return true; }
    function getKnownPatient(id) { return {id,name:'Ahmed Hassan'}; }
    function getStorageServerConfig() { return {url:location.origin,key:'test-key'}; }
    function escapeHtml(value) { const node=document.createElement('span'); node.textContent=String(value); return node.innerHTML.replaceAll('"','&quot;'); }
    const PRIMARY_TOOTH_BY_SLOT={4:'A'}, SLOT_BY_PRIMARY_TOOTH={A:4};
    ${helpers}
  `});
  await page.addScriptTag({url:`http://127.0.0.1:${server.address().port}/lumin-media-teeth.js?v=1`});
  await page.addScriptTag({url:`http://127.0.0.1:${server.address().port}/lumin-chart-media.js?v=6`});
  await page.addScriptTag({url:`http://127.0.0.1:${server.address().port}/lumin-mobile-nav.js?v=1`});
  await page.evaluate(() => {
    document.getElementById('auth-gate').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');
    document.querySelectorAll('#app-main > section, #app-main > div').forEach(element => element.classList.add('hidden'));
    ['patient-workspace-sheet','patient-workspace-header','view-chart'].forEach(id => document.getElementById(id).classList.remove('hidden'));
    document.getElementById('upper-arch').innerHTML='<div data-tooth-card="3"><div class="chart-tooth-xray-slot" data-tooth-xray-slot="3"></div></div>';
    document.getElementById('findings-container').innerHTML=Array.from({length:25}, () => '<article style="height:100px;padding:20px">Clinical finding</article>').join('');
    chartPatientMedia.patientId='patient-1'; chartPatientMedia.status='ready';
    chartPatientMedia.files=[{filename:'preop.png',relativePath:'Ahmed/Periapical/preop.png',category:'Periapical',mediaDetails:{tooth_ids:['3'],display_name:'UR6 before treatment'}}];
    document.dispatchEvent(new Event('DOMContentLoaded'));
  });
  for (const viewport of [{width:1440,height:900},{width:1280,height:720},{width:1024,height:768},{width:800,height:600}]) {
    await page.setViewportSize(viewport);
    for (const language of ['en','ar']) for (const zoom of [.8,1,1.25]) {
      await page.evaluate(({language,zoom}) => {
        currentUiLanguage=language; document.documentElement.dir=language === 'ar' ? 'rtl' : 'ltr';
        document.documentElement.style.zoom=zoom; updateAppViewportDimensions();
        chartPatientMedia.collapsed=true; chartPatientMedia.filterToothId=''; renderChartMediaPanel(); window.scrollTo(0,0);
      },{language,zoom});
      const collapsed = await page.locator('#chart-media-panel').boundingBox();
      assert.ok(collapsed.y >= 0 && collapsed.y+collapsed.height <= viewport.height+1, `Collapsed viewer is on screen with the real navigation rail: ${JSON.stringify({viewport,language,zoom,collapsed})}`);
      await page.locator('#chart-media-collapse').click();
      const opened = await page.locator('#chart-media-panel').boundingBox();
      assert.ok(opened.y >= 0 && opened.y+opened.height <= viewport.height+1, 'Expanded viewer fits beside the real application navigation');
      assert.ok(await page.locator('.chart-media-preview').isVisible());
      await page.locator('[data-tooth-xray-slot="3"] button').click();
      assert.equal(await page.locator('.chart-media-thumbnail').count(),1);
      await page.evaluate(() => window.scrollTo(0,600));
      const sticky=await page.locator('#chart-media-panel').boundingBox();
      const header=await page.locator('#patient-workspace-header').boundingBox();
      assert.ok(sticky.y >= header.y+header.height && sticky.y+sticky.height <= viewport.height+1, 'Viewer stays below patient tabs and inside the viewport while scrolling');
      await page.evaluate(() => window.scrollTo(0,1000));
      const further=await page.locator('#chart-media-panel').boundingBox();
      assert.ok(Math.abs(sticky.y-further.y)<2, 'Real-shell viewer remains frozen as findings scroll');
      if (viewport.width===1280 && language==='en' && zoom===1) await page.screenshot({path:path.join(screenshots,'chart-xray-real-shell.png')});
    }
  }
  assert.deepEqual(errors,[]);
});
