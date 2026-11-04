const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}
function setup(extra = {}) {
  const nodes = {};
  const ctx = vm.createContext({
    document: { documentElement: { dir: 'ltr' }, getElementById: id => nodes[id] ||= { value: '', classList: { toggle() {} } } },
    currentUiLanguage: 'en', currentHrMonth: () => '2026-11', hrClinicDateValue: () => '2026-11-04',
    canModifyHr: () => true, activeHrDoctorDetailsId: 'doctor', hrDoctorSettlementLoading: false, hrDoctorReleasePending: false,
    hrDoctorSettlementCases: [{ finding_id: 'ready', salary_amount: 100 }, { finding_id: 'paid', payment_id: 'payment', salary_amount: 200 }, { finding_id: 'released', released_at: '2026-11-01', salary_amount: 300 }],
    hrDirectoryUsers: [{ userId: 'doctor', active: true, isDoctor: true }], hrDoctorSelectedCaseIds: new Set(['ready', 'released']),
    hrDoctorSettlementRangeKey: 'cached', hrDoctorSettlementRequestToken: 0, hrDirectoryLoaded: true, hrDoctorPayrollLoadedMonth: '2026-11',
    setAdminMessage() {}, showAppointmentNotificationToast() {}, renderHrDoctorPayroll() {}, renderHrDoctorDetailKpis() {},
    refreshHrDirectory: async () => {}, arabicUiPhrase: value => value,
    ...extra
  });
  for (const name of ['hrSalaryPaymentText', 'hrDoctorSettlementRange', 'hrDoctorSettlementMetrics', 'toggleHrDoctorSettlementCase', 'hrDoctorSettlementScopeChanged', 'loadHrDoctorSettlementCases', 'setHrDoctorProcedureRelease']) vm.runInContext(source(name), ctx);
  return { ctx, nodes };
}
test('individual cases supports month, leap year, all time, and validates the year', () => {
  const { ctx } = setup();
  const value = (id, v) => ctx.document.getElementById('hr-doctor-payroll-' + id).value = v;
  value('scope', 'cases'); value('month', '2024-02');
  assert.equal(ctx.hrDoctorSettlementRange().end, '2024-02-29');
  value('period', 'year'); value('year', '2024');
  assert.equal(ctx.hrDoctorSettlementRange().start, '2024-01-01');
  assert.equal(ctx.hrDoctorSettlementRange().end, '2024-12-31');
  value('year', '0'); assert.equal(ctx.hrDoctorSettlementRange().start, null);
  value('period', 'all'); assert.equal(ctx.hrDoctorSettlementRange().start, '0001-01-01');
  assert.equal(ctx.hrDoctorSettlementRange().end, '9999-12-31');
  value('scope', 'month'); assert.equal(ctx.hrDoctorSettlementRange().start, '2024-02-01');
  value('scope', 'day'); assert.equal(ctx.hrDoctorSettlementRange().start, '2026-11-04');
});
test('released and paid cases never enter any payable selection or stale checkbox selection', () => {
  const { ctx } = setup();
  for (const scope of ['month', 'day', 'cases']) {
    ctx.document.getElementById('hr-doctor-payroll-scope').value = scope;
    const metrics = ctx.hrDoctorSettlementMetrics();
    assert.equal(metrics.payableAmount, 100);
    assert.deepEqual(Array.from(metrics.payableCases, item => item.finding_id), ['ready']);
    assert.equal(metrics.releasedCases.length, 1);
  }
  ctx.hrDoctorSelectedCaseIds.clear();
  ctx.toggleHrDoctorSettlementCase('released', true); ctx.toggleHrDoctorSettlementCase('paid', true);
  assert.equal(ctx.hrDoctorSelectedCaseIds.size, 0);
});
test('release is reversible, duplicate clicks write once, and errors preserve the selection', async () => {
  const calls = [];
  let resolve;
  const { ctx } = setup({ db: { rpc: (name, args) => { calls.push([name, args]); return new Promise(r => resolve = r); } } });
  ctx.loadHrDoctorSettlementCases = async () => true;
  const pending = ctx.setHrDoctorProcedureRelease('ready', true);
  assert.equal(await ctx.setHrDoctorProcedureRelease('ready', true), false);
  assert.equal(calls.length, 1); resolve({}); assert.equal(await pending, true);
  assert.ok(ctx.hrDoctorSettlementCases[0].released_at);
  assert.equal(ctx.hrDoctorSelectedCaseIds.has('ready'), false);
  assert.equal(ctx.hrDoctorPayrollLoadedMonth, '');
  const restore = ctx.setHrDoctorProcedureRelease('ready', false); resolve({}); assert.equal(await restore, true);
  assert.equal(ctx.hrDoctorSettlementCases[0].released_at, null);
  ctx.hrDoctorSelectedCaseIds.add('ready');
  const failed = ctx.setHrDoctorProcedureRelease('ready', true); resolve({ error: { message: 'Unavailable' } });
  assert.equal(await failed, false); assert.equal(ctx.hrDoctorSelectedCaseIds.has('ready'), true);
  assert.equal(ctx.hrDoctorReleasePending, false);
  assert.equal(await ctx.setHrDoctorProcedureRelease('paid', true), false);
});
test('all-time loading fetches every page, discards stale responses, and filters released selections', async () => {
  const ranges = [];
  const { ctx } = setup({ db: { rpc: () => ({ range: async (from, to) => {
    ranges.push([from, to]);
    return { data: from === 0 ? Array.from({ length: 500 }, (_, i) => ({ finding_id: String(i) })) : [{ finding_id: 'released', released_at: '2026-11-01' }] };
  } }) } });
  ctx.document.getElementById('hr-doctor-payroll-scope').value = 'cases';
  ctx.document.getElementById('hr-doctor-payroll-period').value = 'all';
  assert.equal(await ctx.loadHrDoctorSettlementCases({ refresh: true }), true);
  assert.equal(ctx.hrDoctorSettlementCases.length, 501);
  assert.deepEqual(ranges, [[0, 499], [500, 999]]);
  assert.equal(ctx.hrDoctorSelectedCaseIds.size, 0);
  let resolve;
  ctx.db.rpc = () => ({ range: () => new Promise(r => resolve = r) });
  const pending = ctx.loadHrDoctorSettlementCases({ refresh: true });
  ctx.hrDoctorSettlementRequestToken++;
  resolve({ data: [{ finding_id: 'stale' }] });
  assert.equal(await pending, false);
  assert.equal(ctx.hrDoctorSettlementCases.length, 501);
});
