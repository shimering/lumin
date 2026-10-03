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
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}
const head = html.slice(0, html.indexOf('</head>') + 7).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const modals = html.slice(html.indexOf('  <div id="patient-media-upload-modal"'), html.indexOf('  <!-- Modal: Change Media Category'));
const script = [
  'isPrimaryToothId','palmerPositionForSlot','palmerQuadrantForSlot','palmerQuadrantLabel',
  'patientMediaToothLabel','updatePatientMediaToothOptions','patientMediaDisplayName','patientMediaDownloadName',
  'patientMediaFileUrl','renderPatientMediaGrid','openPatientMediaDetailsModal','closePatientMediaDetailsModal',
].map(source).join('\n');
const dictionaryStart = html.indexOf('    const ARABIC_UI_TEXT = Object.freeze(');
const dictionary = html.slice(dictionaryStart, html.indexOf('\n    });', dictionaryStart) + 8);
const translationHelpers = ['isUiTranslationExcluded','arabicUiPhrase','translateUiTextNode','translateUiAttribute','translateUiTree'].map(source).join('\n');

test('media gallery and edit sheet fit phone, tablet, and desktop in English and Arabic', { skip: !chromium && 'Playwright is not available' }, async t => {
  const fixture = head + '<body><main style="max-width:1200px;margin:auto;padding:24px;min-width:0"><div id="patient-media-content"></div></main>' + modals + '</body></html>';
  const server = http.createServer((req,res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type','text/html'); res.end(fixture); return; }
    const target = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', target.endsWith('.css') ? 'text/css' : 'application/javascript');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless:true, channel:process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/thumbnail/**', route => route.fulfill({ contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="#e2e8f0"/><text x="140" y="170" font-size="32" fill="#64748b">Test X-ray</text></svg>' }));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addScriptTag({ url:`http://127.0.0.1:${server.address().port}/vendor/lucide.min.js` });
  await page.addScriptTag({ content: `
    let currentUiLanguage = 'en', patientMediaDetailsError = false, activePatientMediaFilter = 'ALL';
    let activePatientMediaPatientId = 'test-patient', editingPatientMediaDetails = null, currentLightboxRelativePath = '';
    const PRIMARY_TOOTH_BY_SLOT = {4:'A',5:'B',6:'C',7:'D',8:'E',9:'F',10:'G',11:'H',12:'I',13:'J',20:'K',21:'L',22:'M',23:'N',24:'O',25:'P',26:'Q',27:'R',28:'S',29:'T'};
    const SLOT_BY_PRIMARY_TOOTH = Object.fromEntries(Object.entries(PRIMARY_TOOTH_BY_SLOT).map(([slot,tooth]) => [tooth,Number(slot)]));
    const currentPatientMediaFiles = [
      {filename:'test.png',relativePath:'Test/Periapical/test.png',category:'Periapical',sizeBytes:2048,modifiedAt:'2026-10-03T10:00:00',mediaDetails:{display_name:'UR6 before treatment',tooth_id:'3',note:'Review distal surface.\\nCompare with the previous image.'}},
      {filename:'second.png',relativePath:'Test/Periapical/second.png',category:'Periapical',sizeBytes:2048,mediaDetails:{display_name:'صورة متابعة لطفل باسم طويل جداً',tooth_id:'A',note:'ملاحظة سريرية تحت الصورة. '.repeat(8)}},
    ];
    function escapeHtml(value) { const element = document.createElement('span'); element.textContent = String(value); return element.innerHTML.replaceAll('"','&quot;'); }
    function getStorageServerConfig() { return {url:location.origin,key:'test-key'}; }
    function hasPageAccess() { return true; }
    const uiTextSources = new WeakMap(), uiTextLastApplied = new WeakMap(), uiAttributeStates = new WeakMap();
    const TRANSLATABLE_ATTRIBUTES = ['placeholder','title','aria-label'];
    const PATIENTS_UI_AR = {};
    ${dictionary}
    ${translationHelpers}
    ${script}
  ` });
  const screenshots = process.env.LUMIN_MEDIA_SCREENSHOT_DIR || path.join(os.tmpdir(),'lumin-media-preview');
  fs.mkdirSync(screenshots,{recursive:true});
  for (const viewport of [{width:390,height:844},{width:834,height:1112},{width:1440,height:900}]) {
    await page.setViewportSize(viewport);
    for (const language of ['en','ar']) {
      await page.evaluate(language => { currentUiLanguage = language; document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr'; renderPatientMediaGrid(); translateUiTree(document.body); }, language);
      assert.ok(await page.locator('.media-card-note').first().isVisible());
      assert.equal(await page.locator('.media-card').count(),2);
      const metrics = await page.evaluate(() => ({ overflow:document.documentElement.scrollWidth > innerWidth, targets:[...document.querySelectorAll('.media-card .media-action')].map(node => ({width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height})), border:getComputedStyle(document.querySelector('.media-card')).borderColor }));
      assert.equal(metrics.overflow,false, `Gallery overflow ${viewport.width} ${language}`);
      assert.ok(metrics.targets.every(target => target.width >= 44 && target.height >= 44));
      assert.ok(['rgb(226, 232, 240)', 'oklch(0.929 0.013 255.508)'].includes(metrics.border), 'Card uses the compiled slate border');
      if (viewport.width === 1440 && language === 'en') await page.screenshot({path:path.join(screenshots,'media-gallery-desktop.png')});
      await page.locator('[data-media-edit-index="1"]').click();
      const sheet = page.locator('#patient-media-details-modal [role="dialog"]');
      assert.ok(await sheet.isVisible());
      assert.equal(await page.locator('#media-details-title').textContent(), language === 'ar' ? 'تعديل تفاصيل الصورة' : 'Edit photo details');
      assert.equal(await page.locator('#edit-media-dentition').inputValue(),'primary');
      assert.equal(await page.locator('#edit-media-tooth').inputValue(),'A');
      assert.equal(await page.locator('#edit-media-tooth option[value]').count(),21);
      const bounds = await sheet.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1);
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height + 1);
      await page.locator('#edit-media-dentition').selectOption('permanent');
      assert.equal(await page.locator('#edit-media-tooth option[value]').count(),33);
      assert.equal(await page.locator('#edit-media-tooth').inputValue(),'');
      if (viewport.width === 390 && language === 'ar') await page.screenshot({path:path.join(screenshots,'media-edit-mobile-ar.png')});
      await page.evaluate(() => closePatientMediaDetailsModal());
      await page.evaluate(() => { const modal = document.getElementById('patient-media-upload-modal'); modal.classList.remove('hidden'); modal.classList.add('flex'); document.getElementById('upload-media-dentition').value = 'primary'; updatePatientMediaToothOptions('upload'); translateUiTree(modal); });
      const uploadBounds = await page.locator('#patient-media-upload-modal [role="dialog"]').boundingBox();
      assert.ok(uploadBounds.x >= 0 && uploadBounds.x + uploadBounds.width <= viewport.width + 1);
      assert.ok(uploadBounds.height <= viewport.height * 0.91);
      await page.locator('#upload-media-note').scrollIntoViewIfNeeded();
      assert.ok(await page.locator('#btn-submit-media-upload').isVisible());
      await page.evaluate(() => { const modal = document.getElementById('patient-media-upload-modal'); modal.classList.add('hidden'); modal.classList.remove('flex'); });
    }
  }
  await page.evaluate(() => { document.body.classList.add('lumin-raised'); renderPatientMediaGrid(); });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
  assert.deepEqual(errors,[]);
});
