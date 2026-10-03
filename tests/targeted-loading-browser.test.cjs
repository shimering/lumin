const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = html.slice(start);
  return tail.slice(0, tail.indexOf('\n    }') + 6);
}
let chromium;
try { ({chromium} = require('playwright')); } catch (_) {}
test('patient navigation shows immediately, rejects old responses, and finance pagination fits all devices', {skip:!chromium}, async t => {
  const fixture=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(fixture);return}
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.statusCode=404;res.end();return}
    res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections()}));
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||undefined});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:')?route.continue():route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addScriptTag({content:`
    let currentSession={user:{id:'staff'}},currentUiLanguage='en',workspaceNavigationToken=0,patientWorkspaceLoadingId=null;
    let activeWorkspacePatientId=null,activePatientId=null,activeInvoicePatientId=null,activePatientsTab='browse',activeClinicManagementTab='finances';
    let chartStructureInitialized=false,dentalCustomizationLoaded=false;
    const patientWorkspaceSwipe=null,patients=[],patientDirectoryRows=[{id:'a',name:'Patient A',recordComplete:false},{id:'b',name:'Patient B',recordComplete:false}];
    const patientProcedureState={patientsById:new Map()},patientDetailReads=new Map(),patientDetailFreshness=new Map(),patientChartSaveStates=new Map(),coalescedRefreshReads=new Map();
    const PATIENT_SELECT_FIELDS='id,name,chart_state';let patientChartWriteRevision=0,targetedLoadingGeneration=0;
    function normalisePatientRecord(r){return{id:r.id,name:r.name,phone:r.phone,chartState:r.chart_state,recordComplete:true}}
    function stableJsonStringify(v){return JSON.stringify(v)}function patientChartSaveKey(id){return id}
    const fixtureReads=new Map();
    const db={from:()=>({select(){return this},eq(k,id){this.id=id;return this},maybeSingle(){return new Promise(resolve=>fixtureReads.set(this.id,resolve))}})};
    function escapeHtml(v){return String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')}
    const lucide={createIcons(){}};
    function hasPageAccess(){return true}function canOpenPatientsPage(){return true}
    function canViewPatientInvoices(){return true}function canViewPatientAppointments(){return true}
    function canViewPatientPrescriptions(){return true}function canViewPatientLoyalty(){return true}
    function firstAuthorizedView(){return 'dashboard'}
    function updatePatientWorkspaceNavigation(patient){document.querySelectorAll('.patient-workspace-name').forEach(el=>el.textContent=patient.name)}
    function renderPatientProfile(){document.getElementById('profile-patient-phone').textContent=getKnownPatient(activeWorkspacePatientId).phone||''}
    ${['closeChartFindingDateDialog','closeMobileHeaderOverlay','closeWhatsAppTemplatePicker','closeQuickCreateMenu','syncNavMountLocation',
      'resetPatientAppointmentsState','resetPatientPrescriptionsState','renderChartMediaPanel','resetWhatsAppWindowScroll','resetPatientQueryWindowScroll',
      'resetAppointmentsCalendarWindowScroll','scheduleDashboardViewportUpdate','renderDashboard','renderPatientInvoices','renderPatientPayments',
      'renderPatientAppointments','renderPatientPrescriptions','renderPatientMedia','renderPatientLoyalty','schedulePatientQueryViewportUpdate','switchPatientsTab'].map(n=>`function ${n}(){}`).join('\n')}
    ${['contentRefreshContext','coalesceRefreshRead','getKnownPatient','ensureKnownPatient','patientWorkspaceId','patientWorkspaceLoadState','switchView'].map(source).join('\n')}
    let financeExpensePage=1,financeExpensePageSize=10,financeDebtPage=1,financeDebtPageSize=10;
    const financeExpenseSummary={total_count:43},financeDebtSummary={total_count:674};
    function setStableHtml(el,markup){el.innerHTML=markup}
    function renderFinanceExpenses(){renderFinancePagedFooter('expense',financeExpensePage,financeExpensePageSize,43)}
    function renderFinanceDepts(){renderFinancePagedFooter('debt',financeDebtPage,financeDebtPageSize,674)}
    const financeDebtDetails=new Map();
    ${['renderFinancePagedFooter','changeFinancePagedPage','changeFinancePagedSize'].map(source).join('\n')}
    document.getElementById('auth-gate').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');
  `});
  for(const [width,height] of [[390,844],[820,1180],[1024,768],[1440,900]]) {
    await page.setViewportSize({width,height});
    await page.evaluate(()=>{activePatientId=activeWorkspacePatientId='a';window.firstNavigation=switchView('patient-profile')});
    assert.equal(await page.locator('#view-patient-profile').evaluate(el=>el.classList.contains('hidden')),false);
    assert.equal(await page.locator('#view-patient-profile').evaluate(el=>el.inert),true);
    assert.equal(await page.locator('#patient-load-status').isVisible(),true);
    await page.evaluate(()=>{activePatientId=activeWorkspacePatientId='b';window.secondNavigation=switchView('patient-profile')});
    await page.waitForFunction(()=>fixtureReads.has('b'));
    await page.evaluate(()=>fixtureReads.get('b')({data:{id:'b',name:'Patient B',phone:'fresh B',chart_state:{}}}));
    await page.evaluate(()=>secondNavigation);
    assert.equal(await page.locator('#view-patient-profile').evaluate(el=>el.inert),false);
    await page.evaluate(()=>fixtureReads.get('a')({data:{id:'a',name:'Patient A',phone:'old A',chart_state:{}}}));
    await page.evaluate(()=>firstNavigation);
    assert.equal(await page.locator('#profile-patient-phone').textContent(),'fresh B');
    await page.evaluate(()=>{document.getElementById('view-patient-profile').classList.add('hidden');document.getElementById('patient-workspace-header').classList.add('hidden');
      document.getElementById('view-clinic-management').classList.remove('hidden');document.getElementById('view-finances').classList.remove('hidden');
      document.getElementById('finance-expenses-results').classList.remove('hidden');document.getElementById('finance-depts-results').classList.remove('hidden');
      renderFinanceExpenses();renderFinanceDepts()});
    for(const dir of ['ltr','rtl']) {
      await page.evaluate(dir=>document.documentElement.dir=dir,dir);
      for(const kind of ['expense','debt']) {
        const footer=page.locator('#finance-'+kind+'-pagination');
        const box=await footer.boundingBox();assert.ok(box.width<=width,kind+' footer fits');
        for(const button of await footer.locator('button,select').all()){const bounds=await button.boundingBox();assert.ok(bounds.height>=44 && bounds.width>=44,'touch targets are at least 44px')}
      }
    }
  }
  await page.locator('#finance-expense-pagination button').last().click();
  assert.match(await page.locator('#finance-expense-pagination').textContent(),/Page 2 of 5/);
  await page.evaluate(()=>{activePatientId=activeWorkspacePatientId='missing';window.failedNavigation=switchView('patient-profile')});
  await page.waitForFunction(()=>fixtureReads.has('missing'));
  await page.evaluate(()=>fixtureReads.get('missing')({error:{message:'Offline'}}));
  await page.evaluate(()=>failedNavigation);
  assert.equal(await page.locator('#view-patient-profile').evaluate(el=>el.style.visibility),'hidden','an error cannot reveal the previous patient');
  assert.equal(await page.locator('#profile-edit-patient-button').isDisabled(),true);
  assert.equal(await page.locator('#patient-load-status button').isVisible(),true,'retry remains available outside the inert content');
  assert.deepEqual(errors,[]);
});
