const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function source(name) {
  const start = html.search(new RegExp('    (?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, `Could not find function ${name} in index.html`);
  const rest = html.slice(start);
  const end = rest.slice(1).search(/\n    (?:async )?function /);
  return rest.slice(0, end + 1);
}

function createMockNode() {
  const node = {
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    className: '',
    classList: {
      _classes: new Set(),
      add(...cls) { cls.forEach(c => this._classes.add(c)); },
      remove(...cls) { cls.forEach(c => this._classes.delete(c)); },
      toggle(cls, force) {
        if (force === undefined) {
          if (this._classes.has(cls)) { this._classes.delete(cls); return false; }
          else { this._classes.add(cls); return true; }
        } else if (force) {
          this._classes.add(cls);
          return true;
        } else {
          this._classes.delete(cls);
          return false;
        }
      },
      contains(cls) { return this._classes.has(cls); }
    }
  };
  return node;
}

function setupContext(overrides = {}) {
  const nodes = {};
  const getNode = id => {
    if (!nodes[id]) nodes[id] = createMockNode();
    return nodes[id];
  };

  const toasts = [];
  const adminMessages = [];

  const ctx = vm.createContext({
    canModifyHr: () => true,
    hrPayrollPeriod: { status: 'draft' },
    currentHrMonth: () => '2026-09',
    hrMonthBounds: () => ({
      start: '2026-09-01',
      end: '2026-10-01',
      startDate: new Date('2026-09-01T00:00:00'),
      endDate: new Date('2026-10-01T00:00:00')
    }),
    hrDirectoryUsers: [
      { userId: 'user-staff-1', fullName: 'Ahmed Staff', active: true, isDoctor: false, roleName: 'Dental Assistant' },
      { userId: 'user-doctor-1', fullName: 'Dr. Sara', active: true, isDoctor: true, roleName: 'Doctor' }
    ],
    hrUserSettings: () => ({
      attendanceEnabled: true,
      regularRate: 200,
      extraRate: 250,
      schedule: { days: [0, 1, 2, 3, 4], start: '09:00', end: '17:00', daily: {} }
    }),
    hrAttendanceSessions: [
      { user_id: 'user-staff-1', work_date: '2026-09-02', check_out_at: '2026-09-02T17:00:00Z', check_in_at: '2026-09-02T09:00:00Z' },
      { user_id: 'user-staff-1', work_date: '2026-09-03', check_out_at: '2026-09-03T17:00:00Z', check_in_at: '2026-09-03T09:00:00Z' }
    ],
    hrExtraShifts: [
      { id: 'extra-1', user_id: 'user-staff-1', shift_date: '2026-09-05', shift_count: 1, rate: 250, approved: true }
    ],
    hrPerformanceAdjustments: [
      { id: 'perf-1', user_id: 'user-staff-1', adjustment_date: '2026-09-10', kind: 'bonus', amount: 150, performance_score: 95 }
    ],
    hrSalaryAdvances: [
      { id: 'adv-1', user_id: 'user-staff-1', advance_date: '2026-09-12', amount: 500, note: 'Mid-month advance' }
    ],
    hrSalaryPayments: [],
    clinicAttendanceSettings: { lateGraceMinutes: 15, timezone: 'Africa/Cairo' },
    hrExpectedShiftCount: () => 20,
    hrTimeZoneMinutes: () => 540,
    formatInvoiceMoney: val => 'EGP ' + Number(val).toLocaleString(),
    setAdminMessage: (id, msg, type) => adminMessages.push({ id, msg, type }),
    showAppointmentNotificationToast: (title, body) => toasts.push({ title, body }),
    lucide: { createIcons: () => {} },
    document: {
      getElementById: getNode
    },
    confirm: () => true,
    db: {
      rpc: async () => ({ data: null, error: null })
    },
    refreshHrDirectory: async () => {},
    hrDirectoryLoaded: true,
    ...overrides
  });

  const functionsToLoad = [
    'hrUserMetrics',
    'openHrAdjustmentModal',
    'closeHrAdjustmentModal',
    'saveHrAdjustment',
    'deleteHrExtraShift',
    'deleteHrPerformanceAdjustment',
    'deleteHrSalaryAdvance'
  ];

  for (const fn of functionsToLoad) {
    vm.runInContext(source(fn), ctx);
  }

  return { ctx, nodes, getNode, toasts, adminMessages };
}

test('hrUserMetrics: correctly calculates earnings minus salary advances and allows overdrawn/negative balance', () => {
  const { ctx } = setupContext();
  const user = ctx.hrDirectoryUsers[0];
  // 2 shifts * 200 = 400 regular
  // + 250 extra
  // + 150 bonus
  // = 800 subtotal
  // - 500 advance
  // = 300 net salary
  let metrics = ctx.hrUserMetrics(user);
  assert.equal(metrics.regularAmount, 400);
  assert.equal(metrics.extraAmount, 250);
  assert.equal(metrics.performanceAmount, 150);
  assert.equal(metrics.advanceAmount, 500);
  assert.equal(metrics.advanceRows.length, 1);
  assert.equal(metrics.salary, 300);

  // When advances exceed current earnings, salary is negative (overdrawn) rather than clamped to 0
  ctx.hrSalaryAdvances.push({ id: 'adv-2', user_id: 'user-staff-1', advance_date: '2026-09-15', amount: 600, note: 'Second advance' });
  metrics = ctx.hrUserMetrics(user);
  assert.equal(metrics.advanceAmount, 1100);
  assert.equal(metrics.salary, -300); // 800 - 1100 = -300
});

test('openHrAdjustmentModal: properly configures modal in advance mode with sky palette and current balance', () => {
  const { ctx, getNode } = setupContext();
  ctx.openHrAdjustmentModal('advance', 'user-staff-1');

  assert.equal(getNode('hr-adjustment-mode').value, 'advance');
  assert.equal(getNode('hr-adjustment-user-id').value, 'user-staff-1');
  assert.equal(getNode('hr-adjustment-title').textContent, 'Add salary advance');
  assert.equal(getNode('hr-adjustment-eyebrow').textContent, 'Salary advance');
  assert.ok(getNode('hr-adjustment-header').className.includes('from-sky-50'));
  assert.ok(getNode('hr-adjustment-save').className.includes('bg-sky-600'));
  assert.ok(getNode('hr-adjustment-save').innerHTML.includes('Save advance'));

  // Fields visibility
  assert.ok(!getNode('hr-advance-fields').classList.contains('hidden'));
  assert.ok(getNode('hr-extra-shift-fields').classList.contains('hidden'));
  assert.ok(getNode('hr-performance-fields').classList.contains('hidden'));

  // Input states
  assert.equal(getNode('hr-advance-amount').disabled, false);
  assert.equal(getNode('hr-extra-shift-count').disabled, true);
  assert.equal(getNode('hr-performance-amount').disabled, true);

  // Balance displayed
  assert.equal(getNode('hr-advance-current-balance').textContent, 'EGP 300');
});

test('openHrAdjustmentModal: disallows opening advance modal for doctors', () => {
  const { ctx, getNode } = setupContext();
  getNode('modal-hr-adjustment').classList.remove('flex');
  getNode('modal-hr-adjustment').classList.add('hidden');

  ctx.openHrAdjustmentModal('advance', 'user-doctor-1');
  // Should return early and modal remains hidden
  assert.ok(getNode('modal-hr-adjustment').classList.contains('hidden'));
});

test('saveHrAdjustment: validates advance amount greater than zero', async () => {
  const { ctx, getNode, adminMessages } = setupContext();
  ctx.openHrAdjustmentModal('advance', 'user-staff-1');

  getNode('hr-advance-amount').value = '0';
  await ctx.saveHrAdjustment({ preventDefault: () => {} });
  assert.ok(adminMessages.some(m => m.msg.includes('greater than zero')));

  adminMessages.length = 0;
  getNode('hr-advance-amount').value = '-50';
  await ctx.saveHrAdjustment({ preventDefault: () => {} });
  assert.ok(adminMessages.some(m => m.msg.includes('greater than zero')));
});

test('saveHrAdjustment: calls save_hr_salary_advance RPC with valid payload and displays toast', async () => {
  const rpcCalls = [];
  const { ctx, getNode, toasts } = setupContext({
    db: {
      rpc: async (fn, payload) => {
        rpcCalls.push({ fn, payload });
        return { data: { id: 'new-adv-id' }, error: null };
      }
    }
  });

  ctx.openHrAdjustmentModal('advance', 'user-staff-1');
  getNode('hr-advance-amount').value = '350.50';
  getNode('hr-adjustment-date').value = '2026-09-18';
  getNode('hr-adjustment-note').value = 'Emergency family expense';

  await ctx.saveHrAdjustment({ preventDefault: () => {} });

  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].fn, 'save_hr_salary_advance');
  assert.deepEqual(JSON.parse(JSON.stringify(rpcCalls[0].payload)), {
    p_id: null,
    p_user_id: 'user-staff-1',
    p_advance_date: '2026-09-18',
    p_amount: 350.5,
    p_note: 'Emergency family expense'
  });

  assert.ok(toasts.some(t => t.title === 'Salary advance saved'));
});

test('deleteHrSalaryAdvance: calls delete_hr_salary_advance RPC upon user confirmation', async () => {
  const rpcCalls = [];
  const { ctx, toasts } = setupContext({
    db: {
      rpc: async (fn, payload) => {
        rpcCalls.push({ fn, payload });
        return { data: null, error: null };
      }
    }
  });

  await ctx.deleteHrSalaryAdvance('adv-1');

  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].fn, 'delete_hr_salary_advance');
  assert.deepEqual(JSON.parse(JSON.stringify(rpcCalls[0].payload)), { p_id: 'adv-1' });
  assert.ok(toasts.some(t => t.title === 'Salary advance deleted'));
});
