const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}

test('patient Media and Finances groups preserve routes, permissions, keyboard access and responsive bilingual layouts', { timeout: 120000 }, async t => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
      return;
    }
    const file = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'application/javascript');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1304, height: 884 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:') ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addScriptTag({ path: path.join(root, 'vendor/lucide.min.js') });
  await page.addScriptTag({ content: `
    let currentSession={user:{id:'staff'}},currentUiLanguage='en',workspaceNavigationToken=0,patientWorkspaceLoadingId=null;
    let activeWorkspacePatientId='patient-a',activePatientId='patient-a',activeInvoicePatientId=null,activePatientsTab='browse',activeClinicManagementTab='finances';
    let activePatientScans=null,chartStructureInitialized=false,dentalCustomizationLoaded=false,patientWorkspaceReturnView='patients';
    const patientWorkspaceSwipe=null,patient={id:'patient-a',name:'محمد عبد الرحمن حسن عبد العزيز الزواوي',recordComplete:true};
    window.access={patients:true,chart:true,invoices:true,appointments:true};
    function hasPageAccess(name){return access[name]!==false;}
    function canViewPatientInvoices(){return access.invoices;}
    function canViewPatientAppointments(){return access.patients&&access.appointments;}
    function canViewPatientPrescriptions(){return access.patients;}
    function canViewPatientLoyalty(){return false;}
    function canOpenPatientsPage(){return access.patients;}
    function firstAuthorizedView(){return 'dashboard';}
    function patientWorkspaceId(){return activeWorkspacePatientId;}
    function getKnownPatient(){return patient;}
    async function ensureKnownPatient(){return patient;}
    function currentPatientAge(){return null;}
    function formatPatientNumber(){return '#2279';}
    function escapeHtml(value){return String(value);}
    function rememberPatientWorkspaceOrigin(){}
    function openPatientInvoices(id){activeInvoicePatientId=id;return switchView('invoices');}
    function openPatientPayments(id){activeInvoicePatientId=id;return switchView('payments');}
    function openPatientChart(){return switchView('chart');}
    function initChartStructure(){}
    async function ensureDentalCustomizationLoaded(){}
    async function ensureChartDoctorsLoaded(){}
    ${['prefetchChartPatientMedia','syncLoyaltyVisibility','closeChartFindingDateDialog','closeMobileHeaderOverlay','closeWhatsAppTemplatePicker','closeQuickCreateMenu','syncNavMountLocation',
      'resetPatientAppointmentsState','resetPatientPrescriptionsState','renderChartMediaPanel','resetWhatsAppWindowScroll','resetPatientQueryWindowScroll','resetAppointmentsCalendarWindowScroll',
      'renderPatientProfile','renderPatientInvoices','renderPatientPayments','renderPatientAppointments','renderPatientPrescriptions','renderPatientMedia','renderPatientScans','renderPatientQuotations',
      'renderPatientLoyalty','loadActivePatientChart','collapseChartSidePanels','setChartAppointmentsActive'].map(name => `function ${name}(){}`).join('\n')}
    const PATIENTS_UI_AR={};
    ${html.match(/const ARABIC_UI_TEXT = Object\.freeze\(\{[\s\S]*?\n    \}\);/)[0]}
    const uiTextSources=new WeakMap(),uiTextLastApplied=new WeakMap(),uiAttributeStates=new WeakMap();
    const TRANSLATABLE_ATTRIBUTES=['placeholder','title','aria-label'];
    ${['isUiTranslationExcluded','arabicUiPhrase','translateUiTextNode','translateUiAttribute','translateUiTree',
      'setupPatientWorkspaceTabScrolling','canOpenPatientWorkspaceTab','openPatientWorkspace','openPatientWorkspaceTab','updatePatientWorkspaceNavigation','patientWorkspaceLoadState','switchView'].map(source).join('\n')}
    document.getElementById('auth-gate').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');
    setupPatientWorkspaceTabScrolling();
  ` });
  const top = page.locator('.patient-workspace-tabs');
  const tab = name => page.locator(`[data-patient-workspace-tab="${name}"]`);
  const group = name => page.locator(`[data-patient-workspace-group="${name}"]`);
  const shots = path.join(os.tmpdir(), 'lumin-patient-workspace-groups');
  fs.mkdirSync(shots, { recursive: true });
  for (const width of [320, 390, 820, 1304]) {
    await page.setViewportSize({ width, height: 884 });
    for (const theme of ['flat', 'raised']) for (const language of ['en', 'ar']) {
      await page.evaluate(({ theme, language }) => {
        document.body.classList.toggle('lumin-raised', theme === 'raised');
        currentUiLanguage = language;
        document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
      }, { theme, language });
      // Direct links retain their routes and activate both the parent and child tabs.
      for (const [route, parent, child] of [['patient-media','media','xrays'],['patient-scans','media','scans'],['invoices','finances','invoices'],['payments','finances','payments'],['patient-quotations','finances','quotations']]) {
        await page.evaluate(route => switchView(route), route);
        assert.equal(await page.evaluate(() => location.hash), '#' + route);
        assert.equal(await top.locator(`[data-patient-workspace-tab="${parent}"]`).getAttribute('aria-selected'), 'true');
        assert.equal(await tab(child).getAttribute('aria-selected'), 'true');
        assert.equal(await group(parent).isVisible(), true);
        assert.equal(await group(parent === 'media' ? 'finances' : 'media').isVisible(), false);
        assert.equal(await top.locator('[data-patient-workspace-tab="scans"], [data-patient-workspace-tab="invoices"], [data-patient-workspace-tab="payments"], [data-patient-workspace-tab="quotations"]').count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, [width,theme,language,route].join('/'));
        for (const button of await group(parent).locator('button:visible').all()) {
          const bounds = await button.boundingBox();
          assert.ok(bounds.width >= 43.9 && bounds.height >= 43.9);
          assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
          assert.equal(await button.evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
        }
      }
      await tab('media').click();
      assert.equal(await page.evaluate(() => location.hash), '#patient-media');
      assert.equal((await tab('media').getAttribute('aria-label')), language === 'ar' ? 'الوسائط' : 'Media');
      assert.equal((await tab('xrays').getAttribute('aria-label')), language === 'ar' ? 'الأشعة' : 'X-Rays');
      await tab('scans').click();
      assert.equal(await page.evaluate(() => location.hash), '#patient-scans');
      await tab('finances').click();
      assert.equal(await page.evaluate(() => location.hash), '#invoices');
      await tab('payments').click();
      assert.equal(await page.evaluate(() => location.hash), '#payments');
      await tab('quotations').click();
      assert.equal(await page.evaluate(() => location.hash), '#patient-quotations');
      if (theme === 'raised' && language === 'en' && [390,1304].includes(width)) {
        await page.screenshot({ path: path.join(shots, `finances-${width}.png`) });
        await tab('media').click();
        await page.screenshot({ path: path.join(shots, `media-${width}.png`) });
      }
      // Arrow keys follow the visual direction; Home/End stay inside the subcategory row.
      await tab('finances').click();
      await tab('invoices').focus();
      await page.keyboard.press(language === 'ar' ? 'ArrowLeft' : 'ArrowRight');
      assert.equal(await tab('payments').evaluate(node => node === document.activeElement), true);
      assert.ok(await tab('payments').evaluate(node => parseFloat(getComputedStyle(node).outlineWidth) >= 2), 'Keyboard focus stays visible in both themes');
      assert.equal(await page.evaluate(() => location.hash), '#payments');
      await page.keyboard.press('End');
      assert.equal(await page.evaluate(() => location.hash), '#patient-quotations');
      await page.keyboard.press('Home');
      assert.equal(await page.evaluate(() => location.hash), '#invoices');
    }
  }
  await page.evaluate(() => { access.patients=false;access.invoices=true;access.chart=false;updatePatientWorkspaceNavigation(patient,'invoices'); });
  assert.equal(await tab('finances').isVisible(), true, 'Invoice-only staff retain the finance group');
  assert.equal(await tab('payments').isVisible(), false);
  assert.equal(await tab('quotations').isVisible(), false);
  assert.equal(await tab('media').isVisible(), false);
  await page.evaluate(() => { access.invoices=false;access.chart=true;updatePatientWorkspaceNavigation(patient,'chart'); });
  await tab('finances').click();
  assert.equal(await page.evaluate(() => location.hash), '#patient-quotations', 'Chart-only staff open their first permitted finance category');
  assert.equal(await tab('invoices').isVisible(), false);
  await page.evaluate(() => { access.chart=false;updatePatientWorkspaceNavigation(patient,'profile'); });
  assert.equal(await tab('finances').isVisible(), false);
  const hash = await page.evaluate(() => location.hash);
  await page.evaluate(() => openPatientWorkspaceTab('payments'));
  assert.equal(await page.evaluate(() => location.hash), hash, 'Programmatic navigation also respects access');
  assert.deepEqual(errors, []);
  console.log('Workspace previews:', shots);
});
