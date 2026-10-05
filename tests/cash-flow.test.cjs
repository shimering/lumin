const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname,'..','lumin-cash-flow.js'),'utf8');
function deferred() { let resolve; const promise = new Promise(r=>resolve=r); return {promise,resolve}; }
function context() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id,{value:'',innerHTML:'',textContent:'',attrs:{},classes:new Set(['hidden']),
      setAttribute(k,v){this.attrs[k]=v},classList:{add(c){elements.get(id).classes.add(c)},remove(c){elements.get(id).classes.delete(c)},toggle(c,on){if(on)this.add(c);else this.remove(c)}}});
    return elements.get(id);
  }
  const reports = [],calls=[];
  const ctx = vm.createContext({Date,Intl,Map,console,window:{},currentUiLanguage:'en',currentSession:{user:{id:'staff'}},hasPageAccess:()=>true,
    escapeHtml:v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),formatInvoiceMoney:v=>`EGP ${v}`,
    document:{getElementById:element,querySelectorAll:()=>[],querySelector:()=>null},
    db:{rpc:(name,args)=>{const request=deferred();calls.push({name,args,...request});return request.promise}},refreshIncomeStatement:()=>{},
  });
  vm.runInContext(script,ctx);ctx.renderCashFlowReport=r=>reports.push(r);
  vm.runInContext("activeAnalyticsTab='cash-flow'",ctx);
  element('analytics-cash-start-month').value='2026-01';element('analytics-cash-end-month').value='2026-03';
  return {ctx,element,reports,calls};
}
test('month ranges include leap days, cross years, and enforce complete valid ranges',()=>{
  const {ctx}=context();
  assert.equal(ctx.cashFlowShiftMonth('2026-01',-1),'2025-12');
  assert.equal(ctx.cashFlowRange('2024-02','2024-02').endDate,'2024-02-29');
  assert.ok(ctx.cashFlowRange('2024-01','2026-12'));
  for(const [a,b] of [['2026-04','2026-03'],['2026-00','2026-03'],['2026-01','2026-13'],['2024-01','2027-01'],['','2026-01']]) assert.equal(ctx.cashFlowRange(a,b),null);
});
test('zero months remain in the chart and net totals include negative cash flow',()=>{
  const {ctx}=context();
  const report=ctx.normaliseCashFlowReport({months:[{month:'2026-01',income:100,expense:150,legacy_expense:50},{month:'2026-03',income:50,expense:0}]},ctx.cashFlowRange('2026-01','2026-03'));
  assert.equal(report.months.length,3);assert.equal(report.months[1].income,0);assert.equal(report.months[0].net,-50);
  assert.equal(report.incomeTotal,150);assert.equal(report.expenseTotal,150);assert.equal(report.legacyExpenseTotal,50);
  assert.equal(ctx.normaliseCashFlowReport({months:[]},ctx.cashFlowRange('9999-12','9999-12')).months.length,1);
  assert.doesNotMatch(ctx.cashFlowChartMarkup(report),/NaN|Infinity/);
  assert.throws(()=>ctx.normaliseCashFlowReport({},ctx.cashFlowRange('2026-01','2026-03')));
});
test('one compact request, caching, refresh and stale responses',async()=>{
  const {ctx,element,calls,reports}=context();
  const first=ctx.refreshCashFlow();assert.equal(calls[0].name,'get_clinic_cash_flow');
  assert.equal(calls[0].args.p_end_date,'2026-03-31');assert.match(element('analytics-cash-content').innerHTML,/cash-skeleton/);
  const second=ctx.refreshCashFlow({refresh:true});
  calls[1].resolve({data:{months:[{month:'2026-01',income:200}]},error:null});await second;
  calls[0].resolve({data:{months:[{month:'2026-01',income:100}]},error:null});await first;
  assert.equal(reports.length,1);assert.equal(reports[0].incomeTotal,200);
  await ctx.refreshCashFlow();assert.equal(calls.length,2);assert.equal(reports.length,2);
  ctx.invalidateCashFlowReport();const fresh=ctx.refreshCashFlow();assert.equal(calls.length,3);calls[2].resolve({data:{months:[]}});await fresh;
});
test('range edits, tab switches, logout and permission loss discard pending reads',async()=>{
  for(const change of ['range','tab','logout','permissions']) {
    const {ctx,element,calls,reports}=context();const pending=ctx.refreshCashFlow();
    if(change==='range'){element('analytics-cash-end-month').value='2026-04';ctx.cashFlowRangeChanged()}
    if(change==='tab')await ctx.switchAnalyticsTab('income-statement');
    if(change==='logout'){ctx.currentSession=null;ctx.resetCashFlowAnalytics()}
    if(change==='permissions')ctx.hasPageAccess=()=>false;
    calls[0].resolve({data:{months:[{month:'2026-01',income:999}]}});await pending;assert.equal(reports.length,0,change);
  }
});
test('invalid ranges never fetch; failed requests show a bilingual retry state',async()=>{
  const {ctx,element,calls}=context();element('analytics-cash-end-month').value='2025-01';await ctx.refreshCashFlow();assert.equal(calls.length,0);assert.equal(element('analytics-cash-range-error').classes.has('hidden'),false);
  element('analytics-cash-end-month').value='2026-03';ctx.currentUiLanguage='ar';const pending=ctx.refreshCashFlow();calls[0].resolve({error:{message:'private error'}});await pending;
  assert.match(element('analytics-cash-content').innerHTML,/حاول مرة أخرى/);assert.doesNotMatch(element('analytics-cash-content').innerHTML,/private error/);assert.equal(element('analytics-cash-content').attrs['aria-busy'],'false');
});
