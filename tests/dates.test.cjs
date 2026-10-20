const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const dates = require('../lumin-dates.js');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}

test('dates always use padded Gregorian dd/mm/yyyy and date-only values never shift time zones', () => {
  for (const timeZone of ['Africa/Cairo', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    assert.equal(dates.format('2026-01-05', { timeZone }), '05/01/2026');
    assert.equal(dates.format('2024-02-29', { timeZone }), '29/02/2024');
  }
  assert.equal(dates.format('2026-10-19T22:30:00Z', { timeZone: 'Africa/Cairo' }), '20/10/2026');
  assert.equal(dates.format('2026-10-19T22:30:00Z', { timeZone: 'America/Los_Angeles' }), '19/10/2026');
  assert.equal(dates.format('05/10/2026'), '05/10/2026', 'formatting an existing label does not swap day and month');
  for (const value of [null, '', 'invalid', '2026-02-29', '2026-04-31']) assert.equal(dates.format(value), '');
  assert.match(dates.formatDateTime('2026-10-19T22:30:00Z', { timeZone: 'Africa/Cairo' }), /^20\/10\/2026 · 01:30$/);
  assert.match(dates.formatDateTime('2026-10-19T22:30:00Z', { timeZone: 'Africa/Cairo', locale: 'ar-EG' }), /^20\/10\/2026 · /);
});

test('date entry rejects impossible or ambiguous dates and accepts Arabic digits', () => {
  assert.equal(dates.parseInput('05/01/2026'), '2026-01-05');
  assert.equal(dates.parseInput('٠٥/٠١/٢٠٢٦'), '2026-01-05');
  assert.equal(dates.parseInput('۰۵/۰۱/۲۰۲۶'), '2026-01-05');
  assert.equal(dates.parseInput('29/02/2024 09:05', true), '2024-02-29T09:05');
  for (const value of ['02/29/2026', '31/04/2026', '5/1/26', '01/01/0000', '2026-01-05']) assert.equal(dates.parseInput(value), '');
  for (const value of ['01/01/2026 24:00', '01/01/2026 23:60', '01/01/2026']) assert.equal(dates.parseInput(value, true), '');
});

function clockFixture() {
  let now = new Date(2026, 9, 19, 23, 59, 55).getTime();
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const calls = [], listeners = {}, intervals = [];
  const oldDay = new Date(2026, 9, 19);
  const context = vm.createContext({ Date: ClockDate, LuminDates: dates,
    appointmentToday: new Date(oldDay), appointmentSelectedDate: new Date(oldDay), dashboardSelectedDate: new Date(oldDay),
    appointmentVisibleMonth: new Date(2026, 9, 1), currentUserAccess: { userId: 'staff' },
    dashboardDayCache: new Map([['yesterday', {}]]), dashboardInvoiceCache: new Map([['yesterday', {}]]),
    appointmentCalendarMode: 'day', appointmentWeekNavigationDirection: 1, selectedAppointmentId: 'previous',
    window: { LuminDashboardMotion: { prepareCards() {} }, addEventListener: (name, fn) => { listeners[name] = fn; }, setInterval: fn => intervals.push(fn) },
    document: { visibilityState: 'visible', getElementById: () => null, addEventListener: (name, fn) => { listeners[name] = fn; } },
    invalidateChartAppointments: () => calls.push('invalidate-chart'), realtimeViewIsVisible: name => name === 'dashboard',
    renderDashboard: () => calls.push('dashboard'), renderAppointments: () => calls.push('calendar'),
    loadChartAppointments: () => calls.push('chart'), requestAuthSessionRecovery() {}, requestRealtimeCatchUp() {},
    applyFinanceUniversalDuration: value => calls.push(value)
  });
  for (const name of ['appointmentDateKey', 'sameAppointmentDate', 'refreshAppCurrentDate', 'setupAppDateMonitor', 'showDashboardToday', 'showAppointmentToday', 'requestForegroundRecovery']) vm.runInContext(source(name), context);
  const events = html.slice(html.indexOf("    window.addEventListener('online', requestForegroundRecovery)"), html.indexOf('    // ================= SUPABASE DATA SYNC'));
  vm.runInContext(events, context);
  return { context, calls, listeners, intervals, setNow: value => { now = value.getTime(); } };
}

test('midnight rollover advances views following today, invalidates dated caches, and runs only once', () => {
  const { context: ctx, calls, setNow } = clockFixture();
  setNow(new Date(2026, 9, 20, 0, 0, 2));
  assert.equal(ctx.refreshAppCurrentDate(), true);
  for (const date of [ctx.appointmentToday, ctx.dashboardSelectedDate, ctx.appointmentSelectedDate]) assert.equal(ctx.appointmentDateKey(date), '2026-10-20');
  assert.equal(ctx.dashboardDayCache.size + ctx.dashboardInvoiceCache.size, 0);
  assert.deepEqual(calls, ['invalidate-chart', 'dashboard']);
  assert.equal(ctx.refreshAppCurrentDate(), false);
  assert.equal(calls.length, 2);
});

test('resuming after multiple days preserves deliberately selected dates and the visible month', () => {
  const { context: ctx, setNow } = clockFixture();
  ctx.dashboardSelectedDate = new Date(2026, 8, 1);
  ctx.appointmentSelectedDate = new Date(2026, 10, 15);
  ctx.appointmentVisibleMonth = new Date(2026, 10, 1);
  setNow(new Date(2027, 0, 2, 8));
  ctx.refreshAppCurrentDate();
  assert.equal(ctx.appointmentDateKey(ctx.appointmentToday), '2027-01-02');
  assert.equal(ctx.appointmentDateKey(ctx.dashboardSelectedDate), '2026-09-01');
  assert.equal(ctx.appointmentDateKey(ctx.appointmentSelectedDate), '2026-11-15');
  assert.equal(ctx.appointmentDateKey(ctx.appointmentVisibleMonth), '2026-11-01');
});

test('Today buttons read the live clock even before any resume event or timer fires', () => {
  const { context: ctx, setNow } = clockFixture();
  setNow(new Date(2027, 0, 1, 0, 1));
  ctx.showDashboardToday();
  ctx.showAppointmentToday();
  assert.equal(ctx.appointmentDateKey(ctx.dashboardSelectedDate), '2027-01-01');
  assert.equal(ctx.appointmentDateKey(ctx.appointmentSelectedDate), '2027-01-01');
  assert.equal(ctx.appointmentDateKey(ctx.appointmentVisibleMonth), '2027-01-01');
  assert.equal(ctx.selectedAppointmentId, null);
});

test('focus, pageshow, visibility and foreground timer all recover a stale day', () => {
  for (const event of ['focus', 'pageshow', 'visibilitychange', 'timer']) {
    const { context: ctx, listeners, intervals, setNow } = clockFixture();
    ctx.setupAppDateMonitor();
    setNow(new Date(2026, 9, 20, 9));
    if (event === 'timer') intervals[0](); else listeners[event]();
    assert.equal(ctx.appointmentDateKey(ctx.appointmentToday), '2026-10-20', event);
  }
});

test('a month or year boundary updates a calendar that was following today', () => {
  const { context: ctx, setNow } = clockFixture();
  setNow(new Date(2027, 0, 1, 0, 1));
  ctx.refreshAppCurrentDate();
  assert.equal(ctx.appointmentDateKey(ctx.appointmentVisibleMonth), '2027-01-01');
});

test('day rollover recomputes relative finance filters without fetching a hidden view or changing custom dates', () => {
  for (const duration of ['today', 'yesterday', 'this_month', 'custom']) {
    const { context: ctx, setNow } = clockFixture();
    const nodes = {
      'finance-universal-duration': { value: duration },
      'finance-universal-start-date': { value: '2026-10-01' },
      'finance-universal-end-date': { value: '2026-10-19' }
    };
    ctx.document.getElementById = id => nodes[id];
    ctx.financeInvoiceDateInputValue = ctx.appointmentDateKey;
    const refreshes = [];
    ctx.financeUniversalFiltersChanged = options => refreshes.push(options.refresh);
    vm.runInContext(source('applyFinanceUniversalDuration'), ctx);
    setNow(new Date(2026, 10, 1, 1));
    ctx.refreshAppCurrentDate({ render: false });
    const expected = duration === 'custom' ? ['2026-10-01', '2026-10-19']
      : duration === 'yesterday' ? ['2026-10-31', '2026-10-31'] : ['2026-11-01', '2026-11-01'];
    assert.deepEqual([nodes['finance-universal-start-date'].value, nodes['finance-universal-end-date'].value], expected);
    assert.deepEqual(refreshes, duration === 'custom' ? [] : [false]);
  }
});
