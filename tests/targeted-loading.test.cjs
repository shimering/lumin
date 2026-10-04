const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = html.slice(start);
  return tail.slice(0, tail.indexOf('\n    }') + 6);
}
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
function context(extra = {}, names = []) {
  const ctx = vm.createContext({ Date, console, currentSession: {user:{id:'staff'}}, currentUiLanguage:'en',
    patients:[], patientDirectoryRows:[], patientProcedureState:{patientsById:new Map()},
    patientDetailReads:new Map(), patientDetailFreshness:new Map(), patientChartSaveStates:new Map(), patientChartWriteRevision:7, targetedLoadingGeneration:0,
    PATIENT_SELECT_FIELDS:'id,name,chart_state', patientChartSaveKey:id=>id, normalisePatientRecord:r=>({id:r.id,name:r.name,chartState:r.chart_state,recordComplete:true}),
    coalescedRefreshReads:new Map(), workspaceNavigationToken:0, stableJsonStringify:JSON.stringify, ...extra });
  ['contentRefreshContext','coalesceRefreshRead','getKnownPatient',...names].forEach(name => vm.runInContext(source(name), ctx));
  return ctx;
}
test('opening a patient navigates immediately without a bulk directory request', async () => {
  const routes = [];
  const ctx = context({hasPageAccess:()=>true, rememberPatientWorkspaceOrigin(){}, switchView:v=>routes.push(v),
    ensurePatientsLoaded(){throw Error('Bulk loading is forbidden')},activeWorkspacePatientId:null,activePatientId:null}, ['openPatientWorkspace']);
  await ctx.openPatientWorkspace('patient-b');
  assert.deepEqual(routes,['patient-profile']);
  assert.equal(ctx.activePatientId,'patient-b');
});
test('a directory summary cannot replace a complete chart; concurrent detail reads share one request', async () => {
  const calls = [], pending = deferred();
  const query = {select:v=>{calls.push(['select',v]);return query},eq:(k,v)=>{calls.push([k,v]);return query},maybeSingle:()=>pending.promise};
  const ctx = context({patientDirectoryRows:[{id:'patient',name:'Summary',recordComplete:false}],db:{from:t=>{calls.push(['from',t]);return query}}}, ['ensureKnownPatient']);
  const a=ctx.ensureKnownPatient('patient'),b=ctx.ensureKnownPatient('patient');
  await Promise.resolve();
  assert.deepEqual(calls,[['from','patients'],['select','id,name,chart_state'],['id','patient']]);
  pending.resolve({data:{id:'patient',name:'Fresh',chart_state:{UR6:{finding:'crown'}}}});
  assert.equal((await a).chartState.UR6.finding,'crown');
  assert.equal((await b).recordComplete,true);
  assert.equal(ctx.patients.length,1);
});
test('patient responses from a signed-out account are discarded', async () => {
  const pending=deferred(),query={select(){return this},eq(){return this},maybeSingle:()=>pending.promise};
  const ctx=context({db:{from:()=>query}},['ensureKnownPatient']);
  const reading=ctx.ensureKnownPatient('patient');
  await Promise.resolve();ctx.currentSession=null;
  pending.resolve({data:{id:'patient',chart_state:{}}});
  assert.equal(await reading,null); assert.equal(ctx.patients.length,0);
});
test('targeted reads preserve the chart save revision and pending local edits', async () => {
  const calls=[],query={select(){return this},eq(){return this},maybeSingle:async()=>({data:{id:'patient',chart_state:{server:true}}})};
  const ctx=context({patients:[{id:'patient',chartState:{pending:true}}],patientChartSaveStates:new Map([['patient',{}]]),
    rememberPatientChartSnapshot:(patient,revision)=>{calls.push(revision);patient.chartState={pending:true}},db:{from:()=>query}},['ensureKnownPatient']);
  const patient=await ctx.ensureKnownPatient('patient',{force:true});
  assert.equal(patient.chartState.pending,true);assert.deepEqual(calls,[7]);
});
test('dashboard fetches exactly one day, without calendar working schedules', async () => {
  const calls=[];
  const query={select(v){calls.push(['select',v]);return this},gte(k,v){calls.push(['gte',k,v]);return this},lt(k,v){calls.push(['lt',k,v]);return this},order(){return this},range(a,b){calls.push(['range',a,b]);return Promise.resolve({data:[]})}};
  const date=new Date(2026,9,4);
  const ctx=context({currentUserAccess:{},hasPageAccess:()=>true,dashboardSelectedDate:date,dashboardDayCache:new Map(),appointments:[],appointmentMoveStates:new Map(),
    appointmentSavedRecords:new Map(),appointmentWriteRevision:0,appointmentStaffLoaded:true,appointmentVisitTypesLoaded:true,
    APPOINTMENT_SELECT_FIELDS:'id,appointment_at',appointmentDateKey:d=>`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`,normaliseAppointmentRecord:r=>r,
    ensureAppointmentStaffLoaded:async()=>true,ensureAppointmentVisitTypesLoaded:async()=>true,realtimeViewIsVisible:()=>false,
    ensureDoctorWorkingSchedulesLoaded(){throw Error('Calendar schedules must not block the dashboard')},db:{from:()=>query}},['dashboardDayContext','appointmentRecordsAfterLocalWrites','ensureDashboardAppointmentsLoaded']);
  assert.equal(await ctx.ensureDashboardAppointmentsLoaded(),true);
  assert.deepEqual(calls.find(c=>c[0]==='gte'),['gte','appointment_at',new Date(2026,9,4).toISOString()]);
  assert.deepEqual(calls.find(c=>c[0]==='lt'),['lt','appointment_at',new Date(2026,9,5).toISOString()]);
  await ctx.ensureDashboardAppointmentsLoaded();assert.equal(calls.filter(c=>c[0]==='range').length,1);
});
test('expense pages pass filters to the backend and request only visible salary links', async () => {
  const calls=[];
  const query={select(){return this},in:(key,ids)=>{calls.push([key,ids]);return Promise.resolve({data:[]})}};
  const ctx=context({financeExpensePage:2,financeExpensePageSize:10,financeExpenseQueryFilters:()=>({search:'water',type:'all',startDate:'2026-10-01',endDate:'2026-10-31'}),
    canModifyHr:()=>true,normaliseExpenseRecord:r=>r,
    db:{rpc:async(name,args)=>{calls.push([name,args]);return{data:{expenses:[{id:'visible'}],total_count:43,paid_total:12000,remaining_total:500}}},from:t=>{calls.push(['from',t]);return query}}},['fetchFinanceExpenseRecords']);
  const result=await ctx.fetchFinanceExpenseRecords();
  assert.equal(calls[0][0],'get_finance_expense_page');assert.equal(calls[0][1].p_page,2);assert.equal(calls[0][1].p_search,'water');
  assert.deepEqual(Array.from(calls[2][1]),['visible']);assert.equal(result.paid_total,12000);
});
test('invoice summaries omit payment allocations while retaining financial amounts', () => {
  const projection=html.match(/const INVOICE_SUMMARY_SELECT_FIELDS = '([^']+)'/)[1];
  assert.doesNotMatch(projection,/invoice_payment_allocations|medical_history|chart_state|doctor_name|surfaces/);
  assert.match(projection,/invoice_payments\(amount\)/);assert.match(projection,/manual_discount_amount/);assert.match(projection,/invoice_releases\(id, amount/);
});
test('debt groups are paged at the backend and their invoice details load only on expansion', async () => {
  const calls=[];
  const ctx=context({financeDebtPage:3,financeDebtPageSize:20,financeUniversalQueryFilters:()=>({search:'patient',startDate:'2026-10-01'}),
    db:{rpc:async(name,args)=>{calls.push([name,args]);return{data:{groups:[{patient_id:'patient'}],total_count:674}}}}},['fetchFinanceDeptInvoiceRecords']);
  await ctx.fetchFinanceDeptInvoiceRecords();
  assert.equal(calls.length,1);assert.equal(calls[0][0],'get_finance_debt_page');
  assert.equal(calls[0][1].p_page,3);assert.equal(calls[0][1].p_page_size,20);
  assert.doesNotMatch(source('fetchFinanceDeptInvoiceRecords'),/while\s*\(/);
});
test('debt detail responses for a previous account cannot populate the current list', async () => {
  const pending=deferred();
  const ctx=context({financeDebtDetails:new Map(),financeDebtPageSize:10,canViewFinanceDepts:()=>true,
    financeDeptGroupForPatient:()=>({patientId:'patient'}),financeUniversalQueryFilters:()=>({}),renderFinanceDeptRows(){},
    db:{rpc:()=>pending.promise}},['loadFinanceDebtDetails']);
  const read=ctx.loadFinanceDebtDetails('patient');await Promise.resolve();
  ctx.currentSession={user:{id:'another-account'}};ctx.financeDebtDetails.clear();
  pending.resolve({data:{invoices:[{id:1,total_amount:100,paid_amount:10,released_amount:0}],total_count:1}});
  await read;assert.equal(ctx.financeDebtDetails.size,0);
});
test('navigation and access changes discard debt invoice responses', async () => {
  for (const guard of ['workspaceNavigationToken','targetedLoadingGeneration']) {
    const pending=deferred();
    let renders=0;
    const ctx=context({financeDebtDetails:new Map(),financeDebtPageSize:10,canViewFinanceDepts:()=>true,
      financeDeptGroupForPatient:()=>({patientId:'patient'}),financeUniversalQueryFilters:()=>({}),renderFinanceDeptRows(){renders++},
      db:{rpc:()=>pending.promise}},['loadFinanceDebtDetails']);
    const read=ctx.loadFinanceDebtDetails('patient');await Promise.resolve();ctx[guard]++;
    const before=renders;
    pending.resolve({data:{invoices:[{id:1,total_amount:100,paid_amount:10,released_amount:0}],total_count:1}});
    await read;
    assert.equal(ctx.financeDebtDetails.get('patient').invoices.length,0);
    assert.equal(renders,before);
  }
});
function expenseContext(fetch) {
  const nodes={ 'finance-expenses-table-body':{}, 'finance-expense-results-summary':{} };
  const ctx=context({document:{getElementById:id=>nodes[id]},hasPageAccess:()=>true,canModifyHr:()=>false,
    financeExpensePage:1,financeExpensePageSize:10,financeExpenseRenderToken:0,financeExpensesLoaded:false,
    financeExpenses:[],financeExpenseSummary:{},financeExpenseLoadPromise:null,expenseSearch:'',
    ensureExpenseTypesLoaded:async()=>true,financeExpenseQueryFilters:()=>({search:ctx.expenseSearch}),
    fetchFinanceExpenseRecords:fetch,beginContentRefresh(){},finishContentRefresh(){},failContentRefresh(){},
    renderFinanceExpenseRows(){},lucide:{createIcons(){}},escapeHtml:String},['renderFinanceExpenses']);
  return ctx;
}
test('finance expense responses cannot overwrite a newer page, filter, navigation, or access state', async () => {
  for (const guard of ['financeExpensePage','expenseSearch','workspaceNavigationToken','targetedLoadingGeneration']) {
    const pending=deferred(),ctx=expenseContext(()=>pending.promise);
    const read=ctx.renderFinanceExpenses();await Promise.resolve();
    ctx[guard]=guard==='expenseSearch'?'new search':ctx[guard]+1;
    pending.resolve({expenses:[{id:'old'}],total_count:100,paid_total:200,remaining_total:300});
    await read;
    assert.equal(ctx.financeExpenses.length,0,guard);
    assert.equal(ctx.financeExpensesLoaded,false,guard);
  }
});
test('expense pagination returns to the last remaining page after deletion and keeps full totals', async () => {
  const pages=[];
  const ctx=expenseContext(function(){pages.push(ctx.financeExpensePage);return Promise.resolve({
    expenses:ctx.financeExpensePage===2?[]:[{id:'remaining'}],total_count:10,paid_total:900,remaining_total:100});});
  ctx.financeExpensePage=2;
  await ctx.renderFinanceExpenses({refresh:true});
  assert.deepEqual(pages,[2,1]);assert.equal(ctx.financeExpensePage,1);
  assert.equal(ctx.financeExpenses[0].id,'remaining');assert.equal(ctx.financeExpenseSummary.paid_total,900);
});
test('summary patient records are explicitly incomplete and cannot save charts', async () => {
  const ctx=context({patientNumberValue:v=>v,normalizePatientPhone:v=>v},['normalisePatientRecord']);
  const patient=ctx.normalisePatientRecord({id:'patient',name:'Summary'});
  assert.equal(patient.recordComplete,false);assert.equal(patient.chartState,undefined);
  ctx.getActivePatient=()=>patient;ctx.patientWorkspaceLoadingId=null;
  ctx.enqueuePatientChartSave=()=>{throw Error('Summary write forbidden')};
  vm.runInContext(source('saveActivePatientChart'),ctx);
  assert.equal(await ctx.saveActivePatientChart(),false);
});
