const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
function setup() {
  const calls = [], renders = [];
  const ctx = vm.createContext({
    currentSession: { user: { id: 'staff' } }, targetedLoadingGeneration: 0, month: '2026-10', allowed: true,
    hrDirectoryUsers: [], hrDirectoryLoaded: false, hrLoadedMonth: '', hrDirectoryLoadPromise: null, hrDirectoryRequestToken: 0,
    hrDoctorPayrollLines: [], hrDoctorPayrollLoadedMonth: '', hrDoctorPayrollLoadPromise: null, hrDoctorPayrollRequestToken: 0, hrDoctorPayrollError: false,
    hrStaffSettings: [], hrAttendanceSessions: [], hrExtraShifts: [], hrPerformanceAdjustments: [], hrSalaryPayments: [], hrSalaryAdvances: [], hrPayrollPeriod: null,
    activeHrTeamTab: 'staff', hasPageAccess: () => ctx.allowed, currentHrMonth: () => ctx.month,
    hrMonthBounds: month => ({ start: month + '-01', end: month === '2026-10' ? '2026-11-01' : '2026-12-01' }),
    document: { getElementById: () => null }, normaliseHrDirectoryUser: r => r,
    renderHrDirectory: () => renders.push({ month: ctx.hrLoadedMonth, users: ctx.hrDirectoryUsers.slice() }),
    queryResult: () => Promise.resolve({ data: [] }), rpcResult: () => Promise.resolve({ data: [{ doctor_id: 'doctor', salary_amount: 500 }] }),
    db: {
      from(table) {
        calls.push(table);
        const query = { select() { return this; }, order() { return this; }, gte() { return this; }, lt() { return this; }, eq() { return this; }, maybeSingle() { return this; },
          then(resolve, reject) { return ctx.queryResult(table).then(resolve, reject); } };
        return query;
      },
      rpc(name, args) { calls.push([name, args]); return ctx.rpcResult(); }
    }
  });
  for (const name of ['refreshHrDoctorPayroll', 'refreshHrDirectory']) vm.runInContext(source(name), ctx);
  return { ctx, calls, renders };
}

test('staff loads without doctor payroll, then doctor tabs share and cache one monthly request', async () => {
  const { ctx, calls } = setup();
  assert.equal(await ctx.refreshHrDirectory(), true);
  assert.equal(calls.length, 8);
  assert.equal(ctx.hrDirectoryLoaded, true);
  const pending = deferred(); ctx.rpcResult = () => pending.promise;
  ctx.activeHrTeamTab = 'doctors';
  const first = ctx.refreshHrDirectory(), second = ctx.refreshHrDirectory();
  assert.equal(calls.length, 9);
  // Returning to staff cannot be held up by the doctor's pending calculation.
  ctx.activeHrTeamTab = 'staff';
  assert.equal(await ctx.refreshHrDirectory(), true);
  pending.resolve({ data: [{ doctor_id: 'doctor', salary_amount: 500 }] });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  ctx.activeHrTeamTab = 'doctors';
  assert.equal(await ctx.refreshHrDirectory(), true);
  assert.equal(calls.length, 9);
  assert.equal(ctx.hrDoctorPayrollLines[0].salary_amount, 500);
});

test('payroll failure leaves staff available and a retry can recover', async () => {
  const { ctx } = setup();
  ctx.activeHrTeamTab = 'doctors';
  ctx.rpcResult = () => Promise.resolve({ error: { message: 'Timed out' } });
  assert.equal(await ctx.refreshHrDirectory(), false);
  assert.equal(ctx.hrDirectoryLoaded, true);
  assert.equal(ctx.hrDoctorPayrollError, true);
  ctx.activeHrTeamTab = 'staff';
  assert.equal(await ctx.refreshHrDirectory(), true);
  ctx.rpcResult = () => Promise.resolve({ data: [{ salary_amount: 25 }] });
  assert.equal(await ctx.refreshHrDoctorPayroll({ refresh: true }), true);
  assert.equal(ctx.hrDoctorPayrollError, false);
});

test('overview explicitly requests monthly payroll and overlapping base reads are deduplicated', async () => {
  const { ctx, calls } = setup();
  const results = await Promise.all([ctx.refreshHrDirectory({ includeDoctorPayroll: true }), ctx.refreshHrDirectory()]);
  assert.deepEqual(results, [true, true]);
  assert.equal(calls.length, 9);
  assert.equal(ctx.hrDoctorPayrollLoadedMonth, '2026-10');
});

test('overlapping base failures resolve cleanly for every caller and can be retried', async () => {
  const { ctx } = setup();
  ctx.queryResult = () => Promise.reject(Error('Offline'));
  assert.deepEqual(await Promise.all([ctx.refreshHrDirectory(), ctx.refreshHrDirectory()]), [false, false]);
  assert.equal(ctx.hrDirectoryLoadPromise, null);
  ctx.queryResult = () => Promise.resolve({ data: [] });
  assert.equal(await ctx.refreshHrDirectory(), true);
});

test('month, account, permission and access-generation changes discard stale directory responses', async () => {
  for (const change of [c => { c.month = '2026-11'; }, c => { c.currentSession = { user: { id: 'other' } }; }, c => { c.allowed = false; }, c => { c.targetedLoadingGeneration++; }]) {
    const { ctx } = setup(), pending = deferred();
    ctx.queryResult = () => pending.promise;
    const read = ctx.refreshHrDirectory();
    await Promise.resolve(); change(ctx);
    pending.resolve({ data: [{ user_id: 'old' }] });
    assert.equal(await read, false);
    assert.equal(ctx.hrDirectoryUsers.length, 0);
    assert.equal(ctx.hrDirectoryLoaded, false);
  }
});

test('a newer month can load while the previous month is pending, and late cleanup cannot clear it', async () => {
  const { ctx } = setup(), old = deferred(), fresh = deferred();
  ctx.queryResult = () => old.promise;
  const first = ctx.refreshHrDirectory();
  await Promise.resolve(); await Promise.resolve();
  ctx.month = '2026-11'; ctx.queryResult = () => fresh.promise;
  const second = ctx.refreshHrDirectory();
  const current = ctx.hrDirectoryLoadPromise;
  old.resolve({ data: [] });
  assert.equal(await first, false);
  assert.equal(ctx.hrDirectoryLoadPromise, current);
  fresh.resolve({ data: [] });
  assert.equal(await second, true);
  assert.equal(ctx.hrLoadedMonth, '2026-11');
});

test('month, account, permission, and refresh changes discard stale doctor payroll', async () => {
  for (const change of [c => { c.month = '2026-11'; }, c => { c.currentSession = null; }, c => { c.allowed = false; }, c => { c.targetedLoadingGeneration++; }, c => { c.hrDoctorPayrollRequestToken++; }]) {
    const { ctx } = setup(), pending = deferred();
    await ctx.refreshHrDirectory();
    ctx.rpcResult = () => pending.promise;
    const read = ctx.refreshHrDoctorPayroll();
    change(ctx); pending.resolve({ data: [{ salary_amount: 999 }] });
    assert.equal(await read, false);
    assert.equal(ctx.hrDoctorPayrollLines.length, 0);
    assert.equal(ctx.hrDoctorPayrollLoadedMonth, '');
  }
});
