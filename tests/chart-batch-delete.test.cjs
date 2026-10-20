const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sync = fs.readFileSync(path.join(root, 'lumin-chart-sync.js'), 'utf8');
function source(name) {
  const start = html.search(new RegExp('    (?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}
const helpers = ['stableJsonStringify', 'chartFindingBillingMultiplier', 'chartFindingBatchTotal',
  'collectDocumentedFindings', 'chartFindingSelectionMap', 'chartFindingDeletionLocked',
  'deleteChartFindingById', 'updateChartFindingById', 'saveActivePatientChart', 'deleteSelectedFindings'].map(source).join('\n');
const chart = {
  _meta: {mouthOperations: [
    {id:'mouth',code:'exam',price:0},
    {id:'mouth-step',code:'step',parentFindingId:'mouth',isProcedureStep:true}
  ]},
  1: {wholeOperations: [
    {id:'a',code:'filling',batchId:'batch',price:100},
    {id:'ortho',code:'braces',isOrthoPackage:true,price:9000,orthoVisits:[
      {id:'v1',visitNumber:1,price:0}, {id:'v2',visitNumber:2,price:100}, {id:'v3',visitNumber:3,price:200}
    ]}
  ], surfaces:{M:[{id:'surface',code:'caries',price:0}],D:[{id:'surface',code:'caries',price:0},{id:'keep-surface',code:'caries',price:0}]}},
  2: {wholeOperations:[{id:'b',code:'filling',batchId:'batch',price:100},{id:'keep',code:'crown',price:300}],surfaces:{}}
};
function setup(ids = []) {
  const ctx = vm.createContext({console:{error(){}}});
  vm.runInContext(`
    var currentSession={user:{id:'user'}},currentUiLanguage='en',activePatientId='patient';
    var patientWorkspaceLoadingId=null,chartInvoiceStateLoading=false,hrDirectoryLoaded=true;
    var patients=[{id:'patient',chartState:${JSON.stringify(chart)}},{id:'other',chartState:{}}];
    var selectedFindingIds=new Set(${JSON.stringify(ids)}),invoicedFindingIds=new Set();
    var expandedOrthoFindings=new Set(['ortho']),expandedFindingProcedureSteps=new Set(['a','mouth']);
    var CHART_META_KEY='_meta',SLOT_BY_PRIMARY_TOOTH={};
    var confirmations=[],alerts=[],writes=[],cleanup=[],renderedTeeth=[],renderCount=0;
    var acceptConfirmation=true,failWrite=false,deferWrite=false;
    function getActivePatient(){return patients.find(p=>p.id===activePatientId)}
    function getKnownPatient(id){return patients.find(p=>p.id===id)}
    function confirm(message){confirmations.push(message);return acceptConfirmation}
    function alert(message){alerts.push(message)}
    function chartMouthFindings(p){return p.chartState._meta?.mouthOperations||[]}
    function storeMouthOperations(p,findings){(p.chartState._meta||={}).mouthOperations=findings}
    function ensureWholeOperations(data){return data.wholeOperations||=[]}
    function chartWholeFindings(data){return data.wholeOperations||[]}
    function chartSurfaceFindings(value){return value||[]}
    function storeChartSurfaceFindings(data,surface,findings){data.surfaces[surface]=findings}
    function chartFindingDefaultPrice(){return 0}
    function normaliseOrthoVisits(visits){return visits||[]}
    function chartFindingCreatedAtTimestamp(){return 0}
    function dentalOperationLabel(code){return code}
    function normaliseChartFinding(f){return {...f}}
    function chartFindingProcedureStepMeta(){return {}}
    function chartFindingStorageRecord(code,status,createdAt,id,price,batchId,notes,billingMultiplier,doctorId,doctorName,completedAt,steps,meta,beginDate,orthoVisits,isOrthoPackage,doctorAssignmentMode){
      return {code,status,createdAt,id,price,batchId,notes,billingMultiplier,doctorId,doctorName,completedAt,steps,...meta,beginDate,orthoVisits,isOrthoPackage,doctorAssignmentMode};
    }
    function rebuildChartProcedureStepPayrollFindings(){}
    function queueRealtimeRefresh(){}
    function renderChartFindingTeeth(ids){renderedTeeth.push([...ids])}
    function renderFindingsList(){renderCount++}
    async function deleteImplantProgressByFindingId(id){cleanup.push(id)}
    var db={from(){return{update(value){this.chart=JSON.parse(JSON.stringify(value.chart_state));return this},eq(column,id){
      const write={patientId:id,chart:this.chart};writes.push(write);
      return deferWrite?new Promise(resolve=>write.resolve=resolve):Promise.resolve({error:failWrite?{message:'Save rejected'}:null});
    }}}};
    ${helpers}
    ${sync}
    rememberPatientChartSnapshot(getActivePatient());
  `,ctx);
  return ctx;
}
const ids = findings => Array.from(findings, finding => finding.id);

test('one confirmation deletes selected batch members, surface findings and zero-price mouth procedures in one chart save',async()=>{
  const ctx=setup(['a','b','surface','mouth']);
  await ctx.deleteSelectedFindings();
  assert.equal(ctx.confirmations.length,1);assert.match(ctx.confirmations[0],/Delete 4 selected/);
  assert.equal(ctx.writes.length,1);
  const saved=ctx.writes[0].chart;
  assert.deepEqual(ids(saved[1].wholeOperations),['ortho']);
  assert.deepEqual(ids(saved[2].wholeOperations),['keep']);
  assert.deepEqual(ids(saved[1].surfaces.M),[]);
  assert.deepEqual(ids(saved[1].surfaces.D),['keep-surface']);
  assert.deepEqual(ids(saved._meta.mouthOperations),[],'Dependent mouth step records are also removed');
  assert.deepEqual([...ctx.selectedFindingIds],[]);
  assert.deepEqual([...ctx.cleanup].sort(),['a','b','mouth','surface']);
  assert.deepEqual([...ctx.renderedTeeth[0]].sort(),['1','2']);
  assert.equal(ctx.expandedFindingProcedureSteps.has('a'),false);
});

test('cancelled, empty and loading selections do not mutate or save the chart',async()=>{
  const ctx=setup(['a']);ctx.acceptConfirmation=false;
  await ctx.deleteSelectedFindings();
  assert.equal(ctx.writes.length,0);assert.deepEqual([...ctx.selectedFindingIds],['a']);
  ctx.acceptConfirmation=true;ctx.chartInvoiceStateLoading=true;await ctx.deleteSelectedFindings();
  ctx.chartInvoiceStateLoading=false;ctx.patientWorkspaceLoadingId='patient';await ctx.deleteSelectedFindings();
  ctx.patientWorkspaceLoadingId=null;ctx.selectedFindingIds.clear();await ctx.deleteSelectedFindings();
  assert.equal(ctx.confirmations.length,1);assert.equal(ctx.writes.length,0);
});

test('invoiced selections and packages with invoiced visits prevent the entire batch deletion',async()=>{
  for(const [selected,invoiced] of [[['a','b'],'b'],[['a','ortho'],'v2'],[['v1','v2'],'v2']]){
    const ctx=setup(selected);ctx.invoicedFindingIds.add(invoiced);
    await ctx.deleteSelectedFindings();
    assert.equal(ctx.alerts.length,1);assert.equal(ctx.confirmations.length,0);assert.equal(ctx.writes.length,0);
    assert.deepEqual([...ctx.selectedFindingIds],selected);
  }
});

test('selected visits are deleted together and remaining visits are renumbered',async()=>{
  const ctx=setup(['v1','v3']);ctx.invoicedFindingIds.add('v2');
  await ctx.deleteSelectedFindings();
  const parent=ctx.writes[0].chart[1].wholeOperations.find(f=>f.id==='ortho');
  assert.deepEqual(ids(parent.orthoVisits),['v2']);assert.equal(parent.orthoVisits[0].visitNumber,1);
  assert.equal(ctx.writes.length,1);assert.deepEqual([...ctx.cleanup],[],'Visit deletion retains package implant data');
});

test('selecting a package and its visits deletes the package once, with an Arabic confirmation',async()=>{
  const ctx=setup(['ortho','v1','v2']);ctx.currentUiLanguage='ar';
  await ctx.deleteSelectedFindings();
  assert.match(ctx.confirmations[0],/حذف 1.*جميع زيارات/);
  assert.equal(ctx.writes.length,1);assert.equal(ctx.expandedOrthoFindings.has('ortho'),false);
  assert.deepEqual([...ctx.cleanup],['ortho']);assert.deepEqual([...ctx.selectedFindingIds],[]);
});

test('a rejected save restores the chart and selection before any implant cleanup',async()=>{
  const ctx=setup(['a','mouth']);ctx.failWrite=true;
  await ctx.deleteSelectedFindings();
  assert.deepEqual(ids(ctx.getActivePatient().chartState[1].wholeOperations),['a','ortho']);
  assert.deepEqual(ids(ctx.getActivePatient().chartState._meta.mouthOperations),['mouth','mouth-step']);
  assert.deepEqual([...ctx.selectedFindingIds],['a','mouth']);
  assert.deepEqual([...ctx.cleanup],[]);assert.equal(ctx.alerts.length,1);
  assert.equal(ctx.expandedFindingProcedureSteps.has('a'),true);
});

test('a pending batch cannot be submitted twice or restore selection into another patient chart',async()=>{
  const ctx=setup(['a']);ctx.deferWrite=true;
  const pending=ctx.deleteSelectedFindings();
  await ctx.deleteSelectedFindings();assert.equal(ctx.writes.length,1);
  ctx.activePatientId='other';ctx.selectedFindingIds.add('other-selection');
  ctx.writes[0].resolve({error:{message:'Save rejected'}});await pending;
  assert.deepEqual([...ctx.selectedFindingIds],['other-selection']);
  assert.deepEqual(ids(ctx.getKnownPatient('patient').chartState[1].wholeOperations),['a','ortho']);
});

test('procedure and visit cards have no individual delete controls',()=>{
  const renderer=source('renderFindingsList');
  assert.doesNotMatch(renderer,/finding-delete-button|deleteFindingFromControl|deleteOrthoVisit|data-lucide="trash-2"/);
  assert.match(html,/id="findings-delete-button"[^>]*onclick="deleteSelectedFindings\(\)"/);
});
