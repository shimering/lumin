const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..'), html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const dictStart = html.indexOf('    const ARABIC_UI_TEXT = Object.freeze({');
const dictionary = html.slice(dictStart, html.indexOf('\n    });', dictStart) + 8);
function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}
test('doctor payment releases and month/year/all-time filters work on phone, tablet and desktop in English and Arabic', async t => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')); return; }
    const file = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:') ? route.continue() : route.abort());
  await page.goto('http://127.0.0.1:' + server.address().port + '/');
  await page.addScriptTag({ path: path.join(root, 'vendor/lucide.min.js') });
  await page.addScriptTag({ content: `
    let currentUiLanguage='en',activeHrDoctorDetailsId='doctor',hrDoctorSettlementCases=[],hrDoctorSelectedCaseIds=new Set();
    let hrDoctorSettlementLoading=false,hrDoctorReleasePending=false,hrDoctorSettlementRangeKey='',hrDoctorSettlementRequestToken=0;
    let hrDirectoryLoaded=true,hrDoctorPayrollLoadedMonth='2026-11';
    const hrDirectoryUsers=[{userId:'doctor',active:true,isDoctor:true}],calls=[];
    const cases=[{finding_id:'ready',completed_at:'2026-11-01T10:00:00Z',patient_name:'Patient with a long name مريض باسم طويل',operation_name:'Composite restoration ترميم الأسنان',operation_code:'composite',gross_amount:1000,salary_amount:300,compensation_type:'percentage',compensation_rate:30},
      {finding_id:'paid',completed_at:'2024-07-01T10:00:00Z',patient_name:'Historical patient',operation_name:'Crown',salary_amount:600,gross_amount:2000,compensation_type:'percentage',compensation_rate:30,payment_id:'paid'}];
    const db={rpc(name,args){calls.push({name,args}); if(name==='set_hr_doctor_procedure_release'){cases.find(c=>c.finding_id===args.p_finding_id).released_at=args.p_released?'2026-11-04':null;return Promise.resolve({})}
      return{range:async()=>({data:cases.filter(c=>c.completed_at.slice(0,10)>=args.p_start_date&&c.completed_at.slice(0,10)<=args.p_end_date).map(c=>({...c}))})}}};
    function currentHrMonth(){return '2026-11'} function hrClinicDateValue(){return '2026-11-04'} function canModifyHr(){return true}
    function escapeHtml(v){return String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')}
    function formatInvoiceMoney(v){return 'EGP '+v} function formatInvoiceDate(v){return v}
    function formatHrDoctorCaseCompletion(v){return v.slice(0,10)} function renderHrDoctorDetailKpis(){}
    function setAdminMessage(id,text){const node=document.getElementById(id);node.textContent=text;node.classList.toggle('hidden',!text)}
    function showAppointmentNotificationToast(){} async function refreshHrDirectory(){}
    const PATIENTS_UI_AR={};
    ${dictionary}
    const uiTextSources=new WeakMap(),uiTextLastApplied=new WeakMap(),uiAttributeStates=new WeakMap();
    const TRANSLATABLE_ATTRIBUTES=['placeholder','title','aria-label'];
    ${['isUiTranslationExcluded','arabicUiPhrase','translateUiTextNode','translateUiAttribute','translateUiTree'].map(source).join('\n')}
    ${['hrSalaryPaymentText','hrProcedureQuantityLabel','hrDoctorSettlementRange','hrDoctorSettlementMetrics','renderHrDoctorPayroll','setHrDoctorProcedureRelease','toggleHrDoctorSettlementCase','hrDoctorSettlementScopeChanged','loadHrDoctorSettlementCases'].map(source).join('\n')}
    document.getElementById('auth-gate').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');
    document.querySelectorAll('main>section').forEach(node=>node.classList.add('hidden'));
    document.getElementById('view-clinic-management').classList.remove('hidden');document.getElementById('view-hr').classList.remove('hidden');
    document.getElementById('hr-directory-view').classList.add('hidden');document.getElementById('hr-doctor-detail-view').classList.remove('hidden');
    document.getElementById('hr-doctor-detail-name').textContent='Doctor salary';
    document.getElementById('hr-doctor-payroll-month').value='2026-11';document.getElementById('hr-doctor-payroll-year').value='2024';
  ` });
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    for (const language of ['en', 'ar']) {
      await page.evaluate(language => { currentUiLanguage = language; document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr'; translateUiTree(document.getElementById('hr-doctor-detail-view'),language); }, language);
      await page.locator('#hr-doctor-payroll-scope').selectOption('cases');
      await page.locator('#hr-doctor-payroll-period').selectOption('month');
      await page.waitForFunction(() => !hrDoctorSettlementLoading && hrDoctorSettlementCases.length === 1);
      assert.equal(await page.locator('#hr-doctor-pay-salary').isVisible(), false);
      await page.locator('#hr-doctor-payroll-lines input[type=checkbox]').check();
      assert.equal(await page.locator('#hr-doctor-pay-salary').isVisible(), true);
      assert.equal(await page.locator('#hr-doctor-calculated-salary').textContent(), 'EGP 300');
      const release = page.locator('.hr-doctor-case-release');
      assert.equal(await release.textContent(), language === 'ar' ? 'استبعاد الدفع' : 'Release payment');
      const box = await release.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44);
      await release.click();
      await page.waitForFunction(() => !hrDoctorReleasePending);
      assert.equal(await page.locator('#hr-doctor-calculated-salary').textContent(), 'EGP 0');
      assert.equal(await page.locator('#hr-doctor-pay-salary').isVisible(), false);
      assert.equal(await page.locator('#hr-doctor-payroll-lines input[type=checkbox]').count(), 0);
      const restore = page.locator('.hr-doctor-case-restore');
      assert.equal(await restore.textContent(), language === 'ar' ? 'استعادة الدفع' : 'Restore payment');
      await restore.focus(); await page.keyboard.press('Enter'); await page.waitForFunction(() => !hrDoctorReleasePending);
      assert.equal(await page.locator('#hr-doctor-payroll-lines input[type=checkbox]').count(), 1);
      await page.locator('#hr-doctor-payroll-period').selectOption('year');
      await page.waitForFunction(() => !hrDoctorSettlementLoading && hrDoctorSettlementCases[0]?.finding_id === 'paid');
      assert.equal(await page.locator('#hr-doctor-payroll-month-control').isVisible(), false);
      assert.equal(await page.locator('#hr-doctor-payroll-year-control').isVisible(), true);
      await page.locator('#hr-doctor-payroll-period').selectOption('all');
      await page.waitForFunction(() => !hrDoctorSettlementLoading && hrDoctorSettlementCases.length === 2);
      assert.equal(await page.locator('#hr-doctor-payroll-year-control').isVisible(), false);
      assert.match(await page.locator('#hr-doctor-payroll-month-label').textContent(), language === 'ar' ? /كل الفترات/ : /All time/);
      assert.equal(await page.locator('#hr-doctor-payroll-period option[value=all]').textContent(), language === 'ar' ? 'كل الفترات' : 'All time');
      assert.equal(await page.locator('.hr-doctor-case-release').count(), 1);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      assert.equal(overflow, false, `${width}px ${language} page overflow`);
      if (width < 768) {
        assert.equal(await page.locator('.hr-doctor-payroll-table thead').isVisible(), false);
        assert.equal(await page.locator('.hr-doctor-payroll-scroll').evaluate(n => n.scrollWidth > n.clientWidth + 1), false);
      }
      const screenshotDir = process.env.LUMIN_SALARY_SCREENSHOTS;
      if (screenshotDir && width === 390 && language === 'en') await page.locator('#hr-doctor-salary-tab-panel').screenshot({ path: path.join(screenshotDir, 'doctor-salary-mobile.png') });
      if (screenshotDir && width === 1440 && language === 'ar') await page.locator('#hr-doctor-salary-tab-panel').screenshot({ path: path.join(screenshotDir, 'doctor-salary-arabic.png') });
    }
  }
  assert.deepEqual(errors, []);
});
