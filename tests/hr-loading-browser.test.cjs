const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..'), html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}

test('staff remains usable during slow/failed payroll; loading and retry work on phones, tablets and desktop in both languages', async t => {
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
    let currentUiLanguage='en',currentSession={user:{id:'staff'}},targetedLoadingGeneration=0;
    let hrDirectoryUsers=[],hrDirectoryLoaded=false,hrLoadedMonth='',hrDirectoryLoadPromise=null,hrDirectoryRequestToken=0;
    let hrDoctorPayrollLines=[],hrDoctorPayrollLoadedMonth='',hrDoctorPayrollLoadPromise=null,hrDoctorPayrollRequestToken=0,hrDoctorPayrollError=false;
    let hrStaffSettings=[],hrAttendanceSessions=[],hrExtraShifts=[],hrPerformanceAdjustments=[],hrSalaryPayments=[],hrSalaryAdvances=[],hrPayrollPeriod=null;
    let activeHrTeamTab='staff',activeHrStaffDetailsId=null,activeHrDoctorDetailsId=null,hrRoleFilter='all';
    window.payrollReads=0;window.releasePayroll=null;
    const users=[{user_id:'staff',full_name:'Staff member',active:true,is_doctor:false},{user_id:'doctor',full_name:'Doctor member',active:true,is_doctor:true}];
    const db={from:table=>({select(){return this},order(){return this},gte(){return this},lt(){return this},eq(){return this},maybeSingle(){return this},then(resolve,reject){return Promise.resolve({data:table==='user_profiles'?users:table==='hr_payroll_periods'?null:[]}).then(resolve,reject)}}),
      rpc:()=>{payrollReads++;return new Promise(resolve=>{releasePayroll=resolve})}};
    function hasPageAccess(){return true}function canModifyHr(){return true}
    function escapeHtml(v){return String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')}
    function formatInvoiceMoney(v){return 'EGP '+v}function setStableHtml(node,markup){node.innerHTML=markup}
    function hrScheduleLabel(){return 'Regular schedule'}
    function hrUserSettings(){return{attendanceEnabled:true,regularRate:100,extraRate:0,schedule:{days:[0,1,2]}}}
    function hrUserMetrics(){return{settings:hrUserSettings(),attended:2,expected:2,late:0,salary:200,regularAmount:200,extraAmount:0,advanceAmount:0,performanceAmount:0,performanceScore:null,performanceRows:[]}}
    function hrDoctorCompensationSummary(){return 'Percentage rule'}
    function closeHrStaffDetails(){activeHrStaffDetailsId=null}function closeHrDoctorDetails(){activeHrDoctorDetailsId=null}
    function renderHrStaffDetails(){}function renderHrDoctorDetails(){}
    ${['normaliseHrDirectoryUser','currentHrMonth','hrMonthBounds','hrDoctorMetrics','hrProcedureQuantityLabel','hrSalaryPaymentText','renderHrRoleFilters','renderHrPeriodControls','renderHrDirectory','switchHrTeamTab','refreshHrDoctorPayroll','refreshHrDirectory'].map(source).join('\n')}
    document.getElementById('auth-gate').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');
    document.querySelectorAll('main>section').forEach(node=>node.classList.add('hidden'));
    document.getElementById('view-clinic-management').classList.remove('hidden');
    ['overview','finances','analytics','inventory'].forEach(name=>document.getElementById(name==='overview'?'view-clinic-overview':'view-'+name)?.classList.add('hidden'));
    document.getElementById('view-hr').classList.remove('hidden');
    document.getElementById('hr-payroll-month').value='2026-10';
  ` });
  await page.evaluate(() => refreshHrDirectory());
  assert.equal(await page.evaluate(() => payrollReads), 0);
  assert.match(await page.locator('#hr-team-table-body').textContent(), /Staff member/);
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const language of ['en', 'ar']) {
      await page.evaluate(language => { currentUiLanguage = language; document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr'; hrDoctorPayrollLoadedMonth = ''; }, language);
      await page.locator('#hr-tab-doctors').click();
      await page.waitForFunction(() => Boolean(releasePayroll));
      assert.equal(await page.locator('#hr-salary-total').textContent(), '—');
      assert.match(await page.locator('#hr-team-table-body [role="status"]').textContent(), language === 'ar' ? /جارٍ/ : /Loading doctor payroll/);
      await page.locator('#hr-tab-staff').click();
      assert.match(await page.locator('#hr-team-table-body').textContent(), /Staff member/);
      await page.evaluate(() => { const release = releasePayroll; releasePayroll = null; release({ error: { message: 'Timeout' } }); });
      await page.waitForFunction(() => hrDoctorPayrollError);
      // Render the failed panel without automatically retrying through the tab handler.
      await page.evaluate(() => { activeHrTeamTab = 'doctors'; renderHrDirectory(); });
      const retry = page.locator('#hr-team-table-body button');
      assert.equal(await retry.textContent(), language === 'ar' ? 'إعادة المحاولة' : 'Retry');
      const box = await retry.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44);
      await retry.click();
      assert.match(await page.locator('#hr-team-table-body [role="status"]').textContent(), language === 'ar' ? /جارٍ/ : /Loading/);
      await page.evaluate(() => { const release = releasePayroll; releasePayroll = null; release({ data: [{ doctor_id: 'doctor', procedure_count: 2, gross_amount: 1000, salary_amount: 300 }] }); });
      await page.waitForFunction(() => hrDoctorPayrollLoadedMonth === '2026-10');
      assert.match(await page.locator('#hr-team-table-body').textContent(), /Doctor member/);
      assert.equal(await page.locator('#hr-salary-total').textContent(), 'EGP 300');
      await page.locator('#hr-tab-staff').click();
    }
  }
  assert.deepEqual(errors, []);
});
