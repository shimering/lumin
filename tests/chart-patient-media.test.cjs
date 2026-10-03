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
const helpers = ['isPrimaryToothId', 'palmerPositionForSlot', 'palmerQuadrantForSlot', 'palmerQuadrantLabel', 'patientMediaToothLabel', 'patientMediaDisplayName', 'patientMediaDownloadName', 'patientMediaFileUrl', 'openPatientMediaLightboxByIndex', 'updateAppViewportDimensions'].map(source).join('\n');

test('landscape chart viewer stays on the right while scrolling; attachment previews and patient changes are isolated', { skip: !chromium && 'Playwright is not available' }, async t => {
  const fixture = head + '<body><header id="app-header" style="height:64px;padding:20px;font-weight:600">LUMIN · Dental clinic</header><main id="app-main"><header id="patient-workspace-header" style="height:64px;padding:20px;background:white;border-radius:16px;margin-bottom:16px">Ahmed Hassan · Dental chart</header>' + chart + '</main></body></html>';
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
  const page = await browser.newPage();
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
    const PRIMARY_TOOTH_BY_SLOT = {4:'A',5:'B',6:'C',7:'D',8:'E',9:'F',10:'G',11:'H',12:'I',13:'J',20:'K',21:'L',22:'M',23:'N',24:'O',25:'P',26:'Q',27:'R',28:'S',29:'T'};
    const SLOT_BY_PRIMARY_TOOTH = Object.fromEntries(Object.entries(PRIMARY_TOOTH_BY_SLOT).map(([slot,tooth]) => [tooth,Number(slot)]));
    const filesByPatient = {
      'patient-1': [
        {filename:'preop.png',relativePath:'Ahmed/Periapical/preop.png',category:'Periapical',sizeBytes:2048},
        {filename:'child.png',relativePath:'Ahmed/Panoramic/child.png',category:'Panoramic',sizeBytes:1024},
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
  await page.addScriptTag({url:`http://127.0.0.1:${server.address().port}/lumin-chart-media.js?v=2`});
  await page.addScriptTag({url:`http://127.0.0.1:${server.address().port}/lumin-mobile-nav.js?v=1`});
  await page.evaluate(() => {
    document.dispatchEvent(new Event('DOMContentLoaded'));
    for (const id of ['upper-arch','lower-arch']) document.getElementById(id).innerHTML = Array.from({length:16}, (_,i) => '<button class="tooth-card" style="height:140px"><span style="font-size:12px">' + (i+1) + '</span><svg width="40" height="100" viewBox="0 0 40 100"><path d="M4 24 Q0 0 20 4 Q40 0 36 24 L31 90 L22 90 L19 58 L10 90 Z" fill="#f3f0e9" stroke="#cbd5e1"/></svg></button>').join('');
    document.getElementById('findings-container').innerHTML = Array.from({length:16}, (_,i) => '<article style="min-height:76px;padding:20px;border-radius:12px;background:white;margin-top:8px">Finding ' + (i+1) + ' · UR6 · In progress</article>').join('');
  });
  const screenshots = process.env.LUMIN_MEDIA_SCREENSHOT_DIR || path.join(os.tmpdir(), 'lumin-chart-media-preview');
  fs.mkdirSync(screenshots, {recursive:true});
  for (const viewport of [{width:1440,height:900},{width:1180,height:820},{width:1024,height:768},{width:800,height:600},{width:834,height:1112},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    const landscape = viewport.width >= 768 && viewport.width > viewport.height;
    for (const language of ['en','ar']) {
      await page.evaluate(async language => { currentUiLanguage = language; document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr'; chartPatientMedia.collapsed = false; window.scrollTo(0,0); await loadChartPatientMedia(); }, language);
      assert.equal(await page.locator('#chart-media-panel').isVisible(), landscape);
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
        await page.locator('#chart-media-toggle').click();
        assert.equal(await page.evaluate(() => window.lastWorkspaceTab), 'media');
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
  await page.locator('#chart-media-toggle').click();
  assert.equal(await page.evaluate(() => window.lastWorkspaceTab),'media');
  await page.evaluate(() => { delete navigator.userAgent; });
  await page.setViewportSize({width:1024,height:768});
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
  await page.evaluate(() => { activePatientId='patient-1'; metadataError=true; return loadChartPatientMedia(); });
  assert.match(await page.locator('#chart-media-panel-body').textContent(), /could not be loaded/);
  await page.evaluate(() => { canReadPatients=false; return loadChartPatientMedia(); });
  assert.equal(await page.evaluate(() => chartPatientMedia.files.length),0);
  assert.ok(await page.locator('#chart-attachments-button').isDisabled());
  await page.evaluate(() => { canReadPatients=true; storageUrl=''; return loadChartPatientMedia(); });
  assert.match(await page.locator('#chart-media-panel-body').textContent(), /Connect your clinic storage/);
  await page.evaluate(() => { storageUrl=location.origin; metadataError=false; return loadChartPatientMedia(); });
  await page.evaluate(() => { document.body.classList.add('lumin-raised'); renderChartMediaPanel(); openPatientAttachmentList(); resetChartPatientMedia(); });
  assert.ok(!(await page.locator('#patient-attachment-modal').isVisible()));
  assert.equal(await page.evaluate(() => chartPatientMedia.files.length),0);
  assert.deepEqual(errors,[]);
});
