const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
function functionSource(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const rest = html.slice(start);
  const end = rest.slice(1).search(/\n    (?:async )?function /);
  return rest.slice(0, end < 0 ? rest.indexOf('</script>') : end + 1);
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const expense = {id:'fixture',name:'Water <&> bill',total:120,paidAmount:120,quantity:1,expenseDate:'2026-09-26',type:{name:'Utilities',color:'#2563eb'},confirmed:true,description:'Private supplier details'};
function context(extra = {}) {
  const ctx = vm.createContext({currentUiLanguage:'en',hasPageAccess:()=>true,canModifyHr:()=>true,expenseTypes:[],escapeHtml,formatInvoiceMoney:n=>`EGP ${n}`,formatInvoiceDate:d=>d,...extra});
  for (const name of ['expenseRemaining','expensePaymentPercent','expensePaymentIndicatorMarkup','financeExpenseRowMarkup','renderFinanceOverview','deleteFinanceExpense']) vm.runInContext(functionSource(name),ctx);
  return ctx;
}
test('Every expense has accessible icon-only edit and delete actions in nine columns', () => {
  for (const record of [expense,{...expense,linkedSalary:true,linkedDoctorSalary:true}]) {
    const row = context().financeExpenseRowMarkup(record);
    assert.equal((row.match(/<td /g)||[]).length,9);
    assert.doesNotMatch(row,/data-label="Description"|Private supplier details|Delete & reopen/);
    const buttons = [...row.matchAll(/<button[^>]*class="finance-expense-action [^>]*>(.*?)<\/button>/g)];
    assert.equal(buttons.length,2);
    buttons.forEach(button=>assert.equal(button[1].replace(/<[^>]*>/g,'').trim(),''));
    assert.match(row,/data-lucide="trash-2"/);
    assert.match(row,/aria-label="Delete expense: Water &lt;&amp;&gt; bill"/);
  }
  assert.match(context({currentUiLanguage:'ar'}).financeExpenseRowMarkup(expense),/aria-label="حذف المصروف:/);
});
test('Net profit uses filtered payments minus paid expenses, ignoring releases and retaining losses', async () => {
  const nodes = Object.fromEntries(['payment-total','release-total','expense-total','net-total','net-card'].map(id=>[`finance-summary-${id}`,{textContent:'',dataset:{},removeAttribute(name){delete this[name];}}]));
  const ctx = context({document:{getElementById:id=>nodes[id]},financeOverviewLoaded:false,financeOverviewRenderToken:0,financeOverviewLoadPromise:null,fetchFinanceOverviewSummary:async()=>({paymentTotal:134960,releaseTotal:37660,expenseTotal:53823})});
  await ctx.renderFinanceOverview();
  assert.equal(nodes['finance-summary-net-total'].textContent,'EGP 81137');
  assert.equal(nodes['finance-summary-net-card'].dataset.loss,'false');
  ctx.fetchFinanceOverviewSummary = async()=>({paymentTotal:100,releaseTotal:0,expenseTotal:175.25});
  await ctx.renderFinanceOverview({refresh:true});
  assert.equal(nodes['finance-summary-net-total'].textContent,'EGP -75.25');
  assert.equal(nodes['finance-summary-net-card'].dataset.loss,'true');
  ctx.fetchFinanceOverviewSummary = async()=>{throw Error('Offline');};
  await ctx.renderFinanceOverview({refresh:true});
  assert.equal(nodes['finance-summary-net-total'].textContent,'—');
  assert.equal(nodes['finance-summary-net-total'].title,'Offline');
  assert.equal(nodes['finance-summary-net-card'].dataset.loss,undefined);
});
test('Expense deletion requires confirmation, refreshes totals, and recovers from errors', async () => {
  const calls=[],errors=[];
  const ctx = context({financeExpenses:[expense],confirm:()=>false,alert:message=>errors.push(message),db:{rpc:async(name,args)=>{calls.push([name,args.p_expense_id]);return{data:{},error:null};}},renderFinanceOverview:undefined,showAppointmentNotificationToast:()=>{},incomeStatementLoadedRange:'range',hrDirectoryLoaded:true,financeExpensesLoaded:true,financeOverviewLoaded:true});
  ctx.renderFinanceOverview = async()=>calls.push('totals');
  ctx.renderFinanceExpenses = async()=>calls.push('expenses');
  const button={disabled:false};
  assert.equal(await ctx.deleteFinanceExpense('fixture',button),false);
  assert.equal(calls.length,0);
  ctx.confirm=()=>true;
  assert.equal(await ctx.deleteFinanceExpense('fixture',button),true);
  assert.deepEqual(calls,[['delete_finance_expense','fixture'],'totals','expenses']);
  assert.equal(ctx.incomeStatementLoadedRange,'');
  assert.equal(button.disabled,false);
  ctx.db.rpc = async()=>({error:{message:'Denied'}});
  assert.equal(await ctx.deleteFinanceExpense('fixture',button),false);
  assert.match(errors[0],/Denied/);
  assert.equal(button.disabled,false);
});
test('Editing a linked salary never writes altered settlement amounts or dates', async () => {
  const values={'expense-total':'1000','expense-paid-amount':'80','expense-sync-payment-method':'','expense-name':'Revised salary label','expense-type':'salary','expense-quantity':'3','expense-date':'2026-01-01','expense-description':'Revised note'};
  const nodes=Object.fromEntries(Object.entries(values).map(([id,value])=>[id,{value}]));
  nodes['expense-form']={dataset:{previousPaidAmount:'100',linkedSalary:'true'}};
  nodes['expense-confirmed']={checked:false};
  nodes['expense-save-button']={disabled:false};
  let saved;
  const ctx=context({document:{getElementById:id=>nodes[id]},editingExpenseId:'salary',setAdminMessage:()=>{},closeExpenseModal:()=>{},renderFinanceExpenses:async()=>{},showAppointmentNotificationToast:()=>{},db:{from:()=>({update:payload=>{saved=payload;return{eq:async()=>({error:null})};}})}});
  ctx.renderFinanceOverview=async()=>{};
  vm.runInContext(functionSource('saveExpense'),ctx);
  await ctx.saveExpense({preventDefault(){}});
  assert.deepEqual(JSON.parse(JSON.stringify(saved)),{name:'Revised salary label',description:'Revised note',confirmed:false});
  assert.equal(nodes['expense-save-button'].disabled,false);
});
