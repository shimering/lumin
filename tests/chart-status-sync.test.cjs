const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sync = fs.readFileSync(path.join(root, 'lumin-chart-sync.js'), 'utf8');
function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const rest = html.slice(start), end = rest.slice(1).search(/\n    (?:async )?function /);
  return rest.slice(0, end + 1);
}
const bootstrap = `
  var currentSession = {user:{id:'staff'}}, currentUiLanguage = 'en', activePatientId = 'patient';
  var OPERATION_STATUSES = {P:{key:'P',label:'Planned',color:'#dc2626'},In:{key:'In',label:'In progress',color:'#2563eb'},C:{key:'C',label:'Completed',color:'#16a34a'},E:{key:'E',label:'Existed',color:'#475569'}};
  var CHART_META_KEY = '_meta', hrDirectoryLoaded = true, financeInvoicesLoaded = true;
  var patients = [{id:'patient',name:'Fixture',chartState:{'1':{wholeOperations:[
    {id:'a',code:'filling',status:'P',price:100,createdAt:'2026-09-30T12:00:00Z',steps:[]},
    {id:'b',code:'crown',status:'P',price:200,createdAt:'2026-09-30T12:00:00Z',steps:[]},
    {id:'c',code:'root_canal',status:'P',price:300,createdAt:'2026-09-30T12:00:00Z',doctorAssignmentMode:'steps',steps:[
      {id:'s1',name:'First step',status:'P',percentage:50,payrollFindingId:'pay1'},
      {id:'s2',name:'Second step',status:'P',percentage:50,payrollFindingId:'pay2'}
    ]}
  ]},_meta:{mouthOperations:[]}}}];
  var fixtureWrites = [], fixtureRpcCalls = [], fixtureAlerts = [], fixtureRenderCount = 0, fixtureRefreshes = 0;
  var fixtureServerRows = JSON.parse(JSON.stringify(patients)), fixtureRead = null;
  var db = {from: () => ({select(){return this},order(){return this},range(){return fixtureRead || Promise.resolve({data:fixtureServerRows,error:null})},
    update(value){this.value=JSON.parse(JSON.stringify(value));return this},
    eq(column,id){return new Promise(resolve=>fixtureWrites.push({patientId:id,chart:this.value.chart_state,resolve}))}
  }), rpc: async(name,payload)=>{fixtureRpcCalls.push({name,payload});return {}}};
  function releaseWrite(index,error=null){const write=fixtureWrites[index];if(!error)fixtureServerRows.find(row=>row.id===write.patientId).chartState=JSON.parse(JSON.stringify(write.chart));write.resolve({error})}
  function getActivePatient(){return patients.find(patient=>patient.id===activePatientId)}
  function getKnownPatient(id){return patients.find(patient=>patient.id===id)}
  function hasPageAccess(){return true}
  function ensureWholeOperations(data){return data.wholeOperations || []}
  function normaliseChartFindingSteps(steps){return (steps || []).map(step=>({...step}))}
  function chartMouthFindings(patient){return patient.chartState._meta?.mouthOperations || []}
  function storeMouthOperations(patient,findings){(patient.chartState._meta ||= {}).mouthOperations=findings}
  function collectDocumentedFindings(patient=getActivePatient()){
    return Object.entries(patient.chartState).filter(([key])=>key!=='_meta').flatMap(([toothId,data])=>(data.wholeOperations || []).map(finding=>({...finding,toothId,kind:'whole',surfaces:[]})));
  }
  function updateChartFindingById(patient,id,update){let changed=false;Object.values(patient.chartState).forEach(data=>{(data.wholeOperations || []).forEach((finding,i)=>{if(finding.id===id){data.wholeOperations[i]=update({...finding});changed=true}})});return changed}
  function chartFindingStorageRecord(code,status,createdAt,id,price,batchId,notes,multiplier,doctorId,doctorName,completedAt,steps,meta,beginDate){return {code,status,createdAt,id,price,doctorId,doctorName,completedAt,beginDate,...meta}}
  function chartFindingBatchTotal(finding){return finding.price}
  function queueRealtimeRefresh(){fixtureRefreshes++}
  function renderChartFindingTeeth(){}
  function renderFindingsList(){fixtureRenderCount++}
  function alert(message){fixtureAlerts.push(message)}
  async function syncImplantProgressFromChartOperation(){}
  async function refreshChartFindingInvoiceState(id){await waitForPatientChartSaves(id)}
  function showAppointmentNotificationToast(){}
  var chartDoctors=[], dashboardInvoiceCache=new Map(), coalescedRefreshReads=new Map();
  ${['stableJsonStringify','normaliseOperationStatus','operationStatusDefinition','chartFindingStatusFromSteps',
    'rebuildChartProcedureStepPayrollFindings','updateChartFindingsByIds','chartFindingIdsFromControl','chartFindingToothIdsFromControl',
    'chartFindingGroupFromControl','saveActivePatientChart','updateFindingGroupStatusFromControl','updateFindingProcedureStepFromControl',
    'coalesceRefreshRead','contentRefreshContext'].map(source).join('\n')}
  ${sync}
  rememberPatientChartSnapshot(getActivePatient());
`;
function setup(extra = {}) {
  const ctx = vm.createContext({console:{error(){}}, ...extra});
  vm.runInContext(bootstrap, ctx);
  return ctx;
}
const tick = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
const control = (id,value,step) => ({value,dataset:{procedureStepId:step},closest:()=>({dataset:{findingIds:id,toothIds:'1'}})});
const states = chart => Array.from(chart['1'].wholeOperations,finding=>finding.status);

test('rapid status changes save in order, including repeated changes to the same procedure', async () => {
  const ctx = setup();
  const a = ctx.updateFindingGroupStatusFromControl(control('a','C'));
  const b = ctx.updateFindingGroupStatusFromControl(control('b','In'));
  const again = ctx.updateFindingGroupStatusFromControl(control('a','P'));
  assert.deepEqual(states(ctx.patients[0].chartState), ['P','In','P']);
  assert.equal(ctx.fixtureWrites.length,1);
  assert.deepEqual(states(ctx.fixtureWrites[0].chart), ['C','P','P']);
  ctx.releaseWrite(0); await tick();
  assert.equal(ctx.fixtureWrites.length,2);
  assert.deepEqual(states(ctx.fixtureWrites[1].chart), ['C','In','P']);
  ctx.releaseWrite(1); await tick();
  assert.deepEqual(states(ctx.fixtureWrites[2].chart), ['P','In','P']);
  ctx.releaseWrite(2); await Promise.all([a,b,again]);
  assert.deepEqual(states(ctx.fixtureServerRows[0].chartState), ['P','In','P']);
  assert.equal(ctx.fixtureRefreshes,1,'one catch-up after the burst settles');
  assert.equal(ctx.fixtureAlerts.length,0);
});

test('a rejected status restores only that edit and preserves another queued procedure in the same tooth', async () => {
  const ctx=setup();
  const a=ctx.updateFindingGroupStatusFromControl(control('a','C'));
  const b=ctx.updateFindingGroupStatusFromControl(control('b','In'));
  ctx.releaseWrite(0,{message:'Salary is already paid'}); await tick();
  assert.deepEqual(states(ctx.patients[0].chartState), ['P','In','P']);
  assert.deepEqual(states(ctx.fixtureWrites[1].chart), ['P','In','P']);
  ctx.releaseWrite(1); await Promise.all([a,b]);
  assert.deepEqual(states(ctx.fixtureServerRows[0].chartState), ['P','In','P']);
  assert.equal(ctx.fixtureAlerts.length,1);
});

test('failed saves can be retried without mutating the last confirmed baseline', async () => {
  const ctx=setup();
  const first=ctx.updateFindingGroupStatusFromControl(control('a','C'));
  ctx.releaseWrite(0,{message:'Offline'}); await first;
  const retry=ctx.updateFindingGroupStatusFromControl(control('a','C'));
  ctx.releaseWrite(1,{message:'Still offline'}); await retry;
  assert.equal(ctx.patients[0].chartState['1'].wholeOperations[0].status,'P');
  const recovered=ctx.updateFindingGroupStatusFromControl(control('b','C'));
  ctx.releaseWrite(2); await recovered;
  assert.deepEqual(states(ctx.fixtureServerRows[0].chartState), ['P','C','P']);
});

test('a rejected step keeps the next step edit and recalculates procedure and payroll statuses', async () => {
  const ctx=setup();
  const first=ctx.updateFindingProcedureStepFromControl(control('c','C','s1'),'status');
  const next=ctx.updateFindingProcedureStepFromControl(control('c','In','s2'),'status');
  ctx.releaseWrite(0,{message:'Paid salary guard'}); await tick();
  const chart=ctx.fixtureWrites[1].chart, finding=chart['1'].wholeOperations[2];
  assert.deepEqual(Array.from(finding.steps,step=>step.status), ['P','In']);
  assert.equal(finding.status,'In');
  assert.equal(chart._meta.mouthOperations.find(row=>row.id==='pay1').status,'P');
  assert.equal(chart._meta.mouthOperations.find(row=>row.id==='pay2').status,'In');
  ctx.releaseWrite(1); await Promise.all([first,next]);
  assert.equal(ctx.fixtureRpcCalls.length,1,'only the successful edit syncs doctor salary');
});

test('saving one procedure preserves a manually entered date on another procedure', async () => {
  const ctx=setup(), patient=ctx.patients[0];
  patient.chartState['1'].wholeOperations[2].beginDate='2026-09-25T12:00:00Z';
  ctx.rememberPatientChartSnapshot(patient);
  const save=ctx.updateFindingGroupStatusFromControl(control('a','C'));
  assert.equal(ctx.fixtureWrites[0].chart['1'].wholeOperations[2].beginDate,'2026-09-25T12:00:00Z');
  ctx.releaseWrite(0); await save;
});

test('doctor sync rejection is compensated before another queued chart write', async () => {
  const ctx=setup(), patient=ctx.patients[0];
  patient.chartState['1'].wholeOperations[0].doctorId='doctor';
  const rejected=ctx.saveActivePatientChart(patient,{afterSave:async()=>{throw Error('Paid salary cannot change')}});
  patient.chartState['1'].wholeOperations[1].status='C';
  const next=ctx.saveActivePatientChart(patient);
  ctx.releaseWrite(0); await tick();
  assert.equal(ctx.fixtureWrites[1].chart['1'].wholeOperations[0].doctorId,undefined);
  ctx.releaseWrite(1); await tick();
  assert.equal(ctx.fixtureWrites[2].chart['1'].wholeOperations[0].doctorId,undefined);
  assert.equal(ctx.fixtureWrites[2].chart['1'].wholeOperations[1].status,'C');
  ctx.releaseWrite(2);
  assert.deepEqual(await Promise.all([rejected,next]), [false,true]);
});

test('a patient read started before a save cannot reload an older chart after the save completes', async () => {
  const ctx=setup({document:{getElementById:()=>({classList:{contains:()=>false}})}});
  Object.assign(ctx,{patientsLoaded:true,patientDirectoryLoaded:true,patientDirectoryRows:[],patientDirectoryTotal:0,PATIENT_QUERY_PAGE_SIZE:10,
    PATIENT_SELECT_FIELDS:'*',normalisePatientRecord:row=>row,patientChartRenderSignature:patient=>JSON.stringify(patient.chartState),
    runPatientQuery(){},renderAppointmentPatientOptions(){},renderDashboard(){},financeInvoicesLoaded:false,
    renderPatientProfile(){},loadActivePatientChart(){ctx.chartReloads++},chartReloads:0});
  vm.runInContext(source('fetchPatientsFromDB'),ctx);
  const oldRows=JSON.parse(JSON.stringify(ctx.patients));
  let resolveRead; ctx.fixtureRead=new Promise(resolve=>resolveRead=resolve);
  const read=ctx.fetchPatientsFromDB(); await tick();
  const save=ctx.updateFindingGroupStatusFromControl(control('a','C'));
  ctx.releaseWrite(0); await save;
  resolveRead({data:oldRows,error:null}); await read;
  assert.equal(ctx.patients[0].chartState['1'].wholeOperations[0].status,'C');
  assert.equal(ctx.chartReloads,0);
  ctx.fixtureRead=null;
  ctx.fixtureServerRows[0].chartState['1'].wholeOperations[1].status='In';
  await ctx.fetchPatientsFromDB();
  assert.equal(ctx.patients[0].chartState['1'].wholeOperations[1].status,'In','a subsequent staff change is still applied');
  assert.equal(ctx.chartReloads,1);
});

test('invoice refresh waits for saves and retries a read interrupted by another edit without loading twitch', async () => {
  const ctx=setup();
  Object.assign(ctx,{chartInvoiceStatePatientId:'patient',chartInvoiceStateLoaded:true,chartInvoiceStateLoading:false,chartInvoiceStateRenderToken:0,
    invoicedFindingIds:new Set(),chartInvoiceItemsByFindingId:new Map(),chartSalaryTransfersByFindingId:new Map(),selectedFindingIds:new Set(),
    renderFindingInvoiceToolbar(){throw Error('Background refresh must keep the toolbar visible')},fetchPatientDoctorSalaryTransfers:async()=>new Map()});
  const invoiceReads=[];
  ctx.fetchInvoiceRecords=()=>new Promise(resolve=>invoiceReads.push(resolve));
  vm.runInContext(source('refreshChartFindingInvoiceState'),ctx);
  const first=ctx.updateFindingGroupStatusFromControl(control('a','C'));
  await tick(); assert.equal(invoiceReads.length,0);
  ctx.releaseWrite(0); await tick(); assert.equal(invoiceReads.length,1);
  const next=ctx.updateFindingGroupStatusFromControl(control('b','C'));
  ctx.releaseWrite(1); await tick();
  invoiceReads[0]([{id:1,items:[{id:1,findingId:'a'}]}]); await tick();
  assert.equal(invoiceReads.length,2);
  invoiceReads[1]([{id:2,items:[{id:2,findingId:'b'}]}]); await tick();
  // Overlapping refresh callers share a final trailing read.
  if(invoiceReads[2])invoiceReads[2]([{id:2,items:[{id:2,findingId:'b'}]}]);
  await Promise.all([first,next]);
  assert.deepEqual([...ctx.invoicedFindingIds], ['b']);
  assert.equal(ctx.chartInvoiceStateLoading,false);
});

let chromium;
try {({chromium}=require('playwright'));}catch(_){}
test('real finding cards retain controls during rapid chart edits on mobile, tablet and desktop', {skip:!chromium&&'Playwright unavailable'}, async t=>{
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||undefined});
  t.after(()=>browser.close());
  for(const width of [412,834,1440]) await t.test('viewport '+width,async()=>{
    const page=await browser.newPage({viewport:{width,height:915}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    try{
      await page.setContent('<div id="findings-invoice-selection-summary"></div><button id="findings-invoice-button"></button><div id="findings-container" style="height:400px;overflow:auto"></div>');
      await page.addScriptTag({path:path.join(root,'vendor/lucide.min.js')});
      await page.addScriptTag({content:bootstrap+`
        var windowLucide=window.lucide, documentedFindingsTab='treatment',documentedFindingsStatusFilter='all';
        var selectedFindingIds=new Set(),invoicedFindingIds=new Set(),chartInvoiceItemsByFindingId=new Map(),chartSalaryTransfersByFindingId=new Map();
        var expandedFindingProcedureSteps=new Set(['c']),collapsedOrthoFindings=new Set(),chartInvoiceStateLoading=false,chartDoctorsLoaded=true;
        var openChartFindingNoteTrigger=null, SLOT_BY_PRIMARY_TOOTH={}, FINDING_SURFACE_TOGGLE_ORDER=[];
        function renderDocumentedFindingsTabs(){}
        function chartFindingInvoiceAmounts(findings){return new Map(findings.map(f=>[f.id,f.price]))}
        function chartFindingBillingMultiplier(){return 1}
        function normaliseOrthoVisits(visits){return visits||[]}
        function normaliseChartOperationNotes(notes){return notes||[]}
        function dentalProcedureStepsTotal(steps){return steps.reduce((sum,s)=>sum+s.percentage,0)}
        function appointmentColorRgba(){return '#eef2ff'}
        function escapeHtml(value){return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')}
        function formatInvoiceMoney(value){return 'EGP '+value}
        function chartToothLabel(id){return 'Tooth '+id}
        function dentalOperationLabel(code){return code}
        function palmerNotationSVG(){return '<svg></svg>'}
        function formatChartOperationCreatedAt(value){return value||''}
        function chartOperationDateInputValue(value){return (value||'').slice(0,16)}
        ${['setStableHtml','renderFindingInvoiceToolbar','renderFindingsList','chartFindingPaymentButton','chartFindingNoteTargetLabel',
          'chartDoctorSelectOptions','chartProcedureStepStatusOptions','operationStatusSelectOptions'].map(source).join('\n')}
        renderFindingsList();
      `});
      const result=await page.evaluate(async()=>{
        const list=document.getElementById('findings-container');
        const a=list.children[0],b=list.children[1],c=list.children[2];
        const price=a.querySelector('input[type=number]'),step=c.querySelector('select[data-procedure-step-id="s2"][onchange*="status"]');
        price.value='1234';step.focus();list.scrollTop=150;
        const beforeIcons=Array.from(c.querySelectorAll('svg'));
        const status=a.querySelector('.finding-status-select-mobile');status.value='C';const first=updateFindingGroupStatusFromControl(status);
        const other=b.querySelector('.finding-status-select-mobile');other.value='In';const next=updateFindingGroupStatusFromControl(other);
        const preservedBefore=price===a.querySelector('input[type=number]')&&price.value==='1234'&&step===document.activeElement&&a===list.children[0]&&c===list.children[2];
        const beforeScroll=list.scrollTop;
        releaseWrite(0);await new Promise(resolve=>setTimeout(resolve,0));releaseWrite(1);await Promise.all([first,next]);
        const stepControl=c.querySelector('select[data-procedure-step-id="s1"][onchange*="status"]');stepControl.value='C';const stepSave=updateFindingProcedureStepFromControl(stepControl,'status');
        const sameCardFocus=step===document.activeElement&&step===c.querySelector('select[data-procedure-step-id="s2"][onchange*="status"]');
        releaseWrite(2);await stepSave;
        const iconsRetained=beforeIcons.filter(icon=>icon.isConnected).length>0;
        return {preservedBefore,sameCardFocus,iconsRetained,price:price.value,scroll:list.scrollTop===beforeScroll,
          statuses:patients[0].chartState['1'].wholeOperations.map(f=>f.status),cards:list.children.length};
      });
      assert.deepEqual(result,{preservedBefore:true,sameCardFocus:true,iconsRetained:true,price:'1234',scroll:true,statuses:['C','In','In'],cards:3});
      assert.deepEqual(errors,[]);
    }finally{await page.close()}
  });
});
