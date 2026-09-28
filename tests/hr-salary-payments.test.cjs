const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp('    (?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  const rest = html.slice(start);
  const end = rest.slice(1).search(/\n    (?:async )?function /);
  return rest.slice(0, end + 1);
}
function setup(extra = {}) {
  const nodes = {};
  const makeNode = () => ({
    value: '', textContent: '', innerHTML: '', disabled: false, dataset: {}, parentElement: { dataset: {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    focus() {}, setAttribute() {}, querySelector() { return makeNode(); }, querySelectorAll() { return []; }
  });
  const ctx = vm.createContext({
    currentUiLanguage: 'en', canModifyHr: () => true, hrSalaryPaymentDialog: null, window: {},
    document: { documentElement: { dir: 'ltr' }, body: { style: { overflow: '' } }, activeElement: null, getElementById: id => nodes[id] ||= makeNode() },
    escapeHtml: value => String(value).replace(/</g, '&lt;'), formatInvoiceMoney: value => 'EGP ' + value, arabicUiPhrase: value => value,
    hrPayrollPeriod: { status: 'locked' }, hrMonthBounds: () => ({ start: '2026-09-01' }), hrDateLabel: value => value,
    financeExpensesLoaded: true, financeOverviewLoaded: true, incomeStatementLoadedRange: 'cached', hrDirectoryLoaded: true,
    hrDirectoryUsers: [{ userId: 'staff', fullName: 'Staff <name>', active: true, isDoctor: false }, { userId: 'doctor', fullName: 'Doctor', active: true, isDoctor: true }],
    hrUserMetrics: () => ({ salary: 1250.5, paid: false, settings: { attendanceEnabled: true } }),
    showAppointmentNotificationToast() {}, refreshHrDirectory: async () => {}, activeHrDoctorDetailsId: 'doctor',
    hrDoctorSettlementLoading: false, hrDoctorSelectedCaseIds: new Set(['case-1']), hrDoctorSettlementRangeKey: 'cached',
    hrDoctorSettlementRange: () => ({ start: '2026-09-01', end: '2026-09-30' }),
    hrDoctorSettlementMetrics: () => ({ scope: 'cases', payableAmount: 850.25, payableCases: [{ finding_id: 'case-1' }] }),
    loadHrDoctorSettlementCases: async () => {}, renderHrDoctorDetails() {}, alert() {},
    ...extra
  });
  for (const name of ['hrSalaryPaymentText', 'hrSalaryPaymentMethodLabel', 'openHrSalaryPaymentDialog', 'loadHrSalaryPaymentMethods', 'updateHrSalaryPaymentRoute', 'closeHrSalaryPaymentDialog', 'handleHrSalaryPaymentKeydown', 'confirmHrSalaryPayment', 'refreshHrAfterSalaryPayment', 'payHrSalary', 'payHrDoctorSalary', 'payAllHrSalaries']) vm.runInContext(source(name), ctx);
  return { ctx, nodes };
}
const methods = {
  enabled: true, sync_expenses: true,
  methods: [
    { id: 'cash', name: 'Cash', account_id: 'wallet', account_name: 'Cash wallet', account_name_ar: 'المحفظة النقدية' },
    { id: 'bank', name: 'InstaPay', account_id: 'main', account_name: 'Main bank', account_name_ar: 'الحساب البنكي' },
    { id: 'card', name: 'Card', account_id: null }
  ]
};
test('Doctor and staff actions cancel without writing and confirm the reviewed amount with the chosen method', async () => {
  for (const action of ['payHrSalary', 'payHrDoctorSalary']) {
    const calls = [];
    const { ctx } = setup({ db: { rpc: async (name, payload) => { calls.push([name, JSON.parse(JSON.stringify(payload))]); return {}; } } });
    let review;
    ctx.openHrSalaryPaymentDialog = async value => { review = value; return false; };
    assert.equal(await ctx[action](action === 'payHrSalary' ? 'staff' : 'doctor'), false);
    assert.equal(calls.length, 0);
    ctx.openHrSalaryPaymentDialog = async value => { review = value; await value.pay('bank'); return true; };
    assert.equal(await ctx[action](action === 'payHrSalary' ? 'staff' : 'doctor'), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].p_payment_method_id, 'bank');
    assert.equal(calls[0][1].p_expected_amount, review.amount);
    assert.match(calls[0][0], /_with_method$/);
    if (action === 'payHrDoctorSalary') assert.deepEqual(calls[0][1].p_finding_ids, ['case-1']);
  }
});
test('Bulk payroll confirms once and sends one atomic batch with each reviewed salary', async () => {
  const calls = [];
  const { ctx } = setup({ db: { rpc: async (name, payload) => { calls.push([name, JSON.parse(JSON.stringify(payload))]); return {}; } } });
  let prompts = 0;
  ctx.openHrSalaryPaymentDialog = async review => { prompts++; assert.equal(review.amount, 1250.5); await review.pay('cash'); return true; };
  await ctx.payAllHrSalaries();
  assert.equal(prompts, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'hr_pay_staff_batch_with_method');
  assert.deepEqual(calls[0][1].p_salaries, [{ user_id: 'staff', expected_amount: 1250.5 }]);
});
test('Routing previews mapped destinations, exclusions, paused delivery and disabled expense sync in both languages', () => {
  const { ctx, nodes } = setup();
  ctx.hrSalaryPaymentDialog = { routes: methods, busy: false };
  for (const [id, text] of [['cash', 'Cash wallet'], ['bank', 'Main bank'], ['card', 'excluded']]) {
    ctx.document.getElementById('hr-salary-payment-method').value = id;
    ctx.updateHrSalaryPaymentRoute();
    assert.match(nodes['hr-salary-payment-route'].textContent, new RegExp(text));
    assert.equal(nodes['hr-salary-payment-confirm'].disabled, false);
  }
  nodes['hr-salary-payment-method'].value = 'unknown';
  ctx.updateHrSalaryPaymentRoute();
  assert.equal(nodes['hr-salary-payment-confirm'].disabled, true);
  nodes['hr-salary-payment-method'].value = 'cash';
  ctx.currentUiLanguage = 'ar';
  ctx.updateHrSalaryPaymentRoute();
  assert.match(nodes['hr-salary-payment-route'].textContent, /المحفظة النقدية/);
  ctx.currentUiLanguage = 'en';
  ctx.hrSalaryPaymentDialog.routes = { ...methods, enabled: false };
  ctx.updateHrSalaryPaymentRoute();
  assert.match(nodes['hr-salary-payment-route'].textContent, /queue until it resumes/);
  ctx.hrSalaryPaymentDialog.routes = { ...methods, sync_expenses: false };
  ctx.updateHrSalaryPaymentRoute();
  assert.match(nodes['hr-salary-payment-route'].textContent, /stay in Lumin/);
});
test('Missing methods do not write; double submission writes once and cannot dismiss an in-flight payment', async () => {
  let release, writes = 0, resolved;
  const { ctx } = setup();
  const state = { routes: methods, busy: false, previousOverflow: '', resolve: value => { resolved = value; }, pay: () => { writes++; return new Promise(done => { release = done; }); } };
  ctx.hrSalaryPaymentDialog = state;
  const event = { preventDefault() {} };
  await ctx.confirmHrSalaryPayment(event);
  assert.equal(writes, 0);
  ctx.document.getElementById('hr-salary-payment-method').value = 'cash';
  const pending = ctx.confirmHrSalaryPayment(event);
  await ctx.confirmHrSalaryPayment(event);
  ctx.closeHrSalaryPaymentDialog();
  assert.equal(ctx.hrSalaryPaymentDialog, state);
  assert.equal(writes, 1);
  release();
  await pending;
  assert.equal(resolved, true);
  assert.equal(ctx.hrSalaryPaymentDialog, null);
  assert.equal(ctx.financeExpensesLoaded, false);
});
test('Failed payment stays open for retry and a post-payment refresh failure cannot report the payment as failed', async () => {
  const { ctx, nodes } = setup();
  ctx.hrSalaryPaymentDialog = { routes: methods, busy: false, pay: async () => { throw Error('Salary changed'); } };
  ctx.document.getElementById('hr-salary-payment-method').value = 'cash';
  await ctx.confirmHrSalaryPayment({ preventDefault() {} });
  assert.equal(ctx.hrSalaryPaymentDialog.busy, false);
  assert.equal(nodes['hr-salary-payment-confirm'].disabled, false);
  assert.equal(nodes['hr-salary-payment-message'].textContent, 'Salary changed');
  ctx.openHrSalaryPaymentDialog = async review => { await review.pay('cash'); return true; };
  ctx.db = { rpc: async () => ({}) };
  ctx.refreshHrDirectory = async () => { throw Error('Offline'); };
  assert.equal(await ctx.payHrSalary('staff'), true);
});
test('Loading failure offers retry, and cancelling during loading ignores the late response', async () => {
  let release;
  const { ctx, nodes } = setup({ db: { rpc: () => new Promise(done => { release = done; }) } });
  const pending = ctx.openHrSalaryPaymentDialog({ amount: 100, recipients: ['Name <x>'], summary: 'Month', pay() {} });
  assert.match(nodes['modal-hr-salary-payment'].innerHTML, /Name &lt;x>/);
  assert.equal(ctx.hrSalaryPaymentDialog.routes, null);
  ctx.closeHrSalaryPaymentDialog();
  release({ data: methods });
  assert.equal(await pending, false);
  await new Promise(done => setImmediate(done));
  assert.equal(ctx.hrSalaryPaymentDialog, null);
  ctx.db.rpc = async () => ({ error: Error('Offline') });
  const retry = ctx.openHrSalaryPaymentDialog({ amount: 100, recipients: ['Name'], summary: 'Month', pay() {} });
  await new Promise(done => setImmediate(done));
  assert.match(nodes['hr-salary-payment-message'].textContent, /Retry before paying/);
  ctx.closeHrSalaryPaymentDialog();
  assert.equal(await retry, false);
});

test('Keyboard focus stays inside the dialog during payment and Escape cannot dismiss it or reach its parent', () => {
  const { ctx } = setup();
  ctx.hrSalaryPaymentDialog = { busy: true };
  let prevented = 0, stopped = 0;
  ctx.handleHrSalaryPaymentKeydown({ key: 'Tab', preventDefault: () => prevented++ });
  ctx.handleHrSalaryPaymentKeydown({ key: 'Escape', preventDefault: () => prevented++, stopPropagation: () => stopped++ });
  assert.equal(prevented, 2);
  assert.equal(stopped, 1);
  assert.equal(ctx.hrSalaryPaymentDialog.busy, true);
  ctx.currentUiLanguage = 'ar';
  assert.equal(ctx.hrSalaryPaymentMethodLabel({ name: 'Cash' }), 'نقداً');
  assert.equal(ctx.hrSalaryPaymentMethodLabel({ name: 'Clinic custom method' }), 'Clinic custom method');
});
