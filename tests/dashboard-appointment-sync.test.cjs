const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = html.slice(start);
  return tail.slice(0, tail.indexOf('\n    }') + 6);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const day = new Date(2026, 9, 4);
const at = new Date(2026, 9, 4, 18).toISOString();
const dateKey = value => { const date = new Date(value); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const row = (status = 'Confirmed', id = 'a', extra = {}) => ({ id, appointment_at: at, status, ...extra });
function fixture(extra = {}) {
  const reads = [], renders = [];
  const ctx = vm.createContext({ Date, console, currentSession: { user: { id: 'staff' } }, currentUiLanguage: 'en',
    currentUserAccess: {}, hasPageAccess: () => true, dashboardSelectedDate: day, dashboardDayCache: new Map(),
    appointmentMoveStates: new Map(), appointmentSavedRecords: new Map(), appointmentWriteRevision: 0,
    coalescedRefreshReads: new Map(), stableJsonStringify: JSON.stringify, appointments: [], appointmentsLoaded: false,
    appointmentStaffLoaded: true, appointmentVisitTypesLoaded: true,
    APPOINTMENT_SELECT_FIELDS: 'id,appointment_at,status', appointmentDateKey: dateKey,
    normaliseAppointmentRecord: record => ({ ...record, date: dateKey(record.appointment_at) }),
    ensureAppointmentStaffLoaded: async () => true, ensureAppointmentVisitTypesLoaded: async () => true,
    realtimeViewIsVisible: view => view === 'dashboard', notifyRealtimeAppointmentChanges() {},
    renderDashboard: () => renders.push(ctx.appointments.map(item => item.status)),
    renderAppointments() {}, document: { getElementById: () => ({ classList: { contains: () => true } }) },
    canModifyAppointments: () => true, APPOINTMENT_STATUSES: ['Confirmed', 'Checked in', 'Completed', 'Cancelled'],
    recentLocalAppointmentChanges: new Map(), markLocalAppointmentChange() {}, queueAppointmentPushNotification() {},
    updateAppointmentRecordWithRetry: async (id, values) => ({ data: row(values.status, id) }), alert() {},
    db: { from() { const query = { select() { return this; }, gte() { return this; }, lt() { return this; },
      order() { return this; }, range() { const read = deferred(); reads.push(read); return read.promise; },
      then(resolve, reject) { const read = deferred(); reads.push(read); return read.promise.then(resolve, reject); } }; return query; } },
    ...extra });
  const names = ['coalesceRefreshRead', 'contentRefreshContext', 'dashboardDayContext', 'ensureDashboardAppointmentsLoaded',
    'replaceNormalisedAppointmentRecord', 'rememberSavedAppointmentRecord', 'replaceAppointmentRecord', 'changeDashboardAppointmentStatus',
    'fetchAppointmentsFromDB', 'appointmentRecordsAfterLocalWrites'];
  names.forEach(name => vm.runInContext(source(name), ctx));
  const entry = { data: [row()], dateKey: ctx.appointmentDateKey(day), expiresAt: Date.now() + 15000, error: null };
  ctx.dashboardDayCache.set(ctx.dashboardDayContext(), entry);
  ctx.appointments = entry.data.map(ctx.normaliseAppointmentRecord);
  return { ctx, entry, reads, renders };
}

test('a saved dashboard status stays saved while cached metadata is refreshed', async () => {
  const staff = deferred();
  const { ctx, entry, reads, renders } = fixture({ appointmentStaffLoaded: false, ensureAppointmentStaffLoaded: () => staff.promise });
  assert.equal(await ctx.changeDashboardAppointmentStatus('a', 'Checked in'), true);
  const pending = ctx.ensureDashboardAppointmentsLoaded({ refresh: true });
  await settle();
  staff.resolve(true);
  await settle();
  assert.equal(ctx.appointments[0].status, 'Checked in');
  assert.equal(entry.data[0].status, 'Checked in');
  assert.ok(renders.every(statuses => statuses[0] === 'Checked in'), 'no render restores the old status');
  reads[0].resolve({ data: [row('Checked in')] });
  await pending;
});

test('a response started before a save cannot restore an older status or drop a newly saved appointment', async () => {
  const { ctx, entry, reads } = fixture();
  const pending = ctx.ensureDashboardAppointmentsLoaded({ refresh: true });
  await settle();
  ctx.replaceAppointmentRecord(row('Checked in'));
  ctx.replaceAppointmentRecord(row('Confirmed', 'new'));
  reads[0].resolve({ data: [row()] });
  await pending;
  assert.equal(ctx.appointments.find(item => item.id === 'a').status, 'Checked in');
  assert.equal(entry.data.find(item => item.id === 'a').status, 'Checked in');
  assert.equal(ctx.appointments.filter(item => item.id === 'new').length, 1);
});

test('a fresh read still accepts another staff member\'s status and unrelated appointments', async () => {
  const { ctx, reads } = fixture();
  ctx.replaceAppointmentRecord(row('Checked in'));
  const pending = ctx.ensureDashboardAppointmentsLoaded({ refresh: true });
  await settle();
  reads[0].resolve({ data: [row('Completed'), row('Cancelled', 'b')] });
  await pending;
  assert.equal(ctx.appointments.find(item => item.id === 'a').status, 'Completed');
  assert.equal(ctx.appointments.find(item => item.id === 'b').status, 'Cancelled');
});

test('a coalesced trailing read accepts the latest change after a local save', async () => {
  const { ctx, reads } = fixture();
  const first = ctx.ensureDashboardAppointmentsLoaded({ refresh: true });
  await settle();
  ctx.replaceAppointmentRecord(row('Checked in'));
  const second = ctx.ensureDashboardAppointmentsLoaded({ refresh: true });
  reads[0].resolve({ data: [row()] });
  await settle();
  assert.equal(reads.length, 2);
  reads[1].resolve({ data: [row('Completed')] });
  await Promise.all([first, second]);
  assert.equal(ctx.appointments[0].status, 'Completed');
});

test('calendar reads overlapping a dashboard save also retain the saved status', async () => {
  const { ctx, reads } = fixture({ appointmentsLoaded: true });
  const pending = ctx.fetchAppointmentsFromDB({ refreshStaff: false });
  await settle();
  ctx.replaceAppointmentRecord(row('Checked in'));
  reads[0].resolve({ data: [row()] });
  await pending;
  assert.equal(ctx.appointments[0].status, 'Checked in');
});

test('failed status saves retain the previous model and cache without a local-write override', async () => {
  const { ctx, entry } = fixture({ updateAppointmentRecordWithRetry: async () => ({ error: Error('Offline') }) });
  assert.equal(await ctx.changeDashboardAppointmentStatus('a', 'Checked in'), false);
  assert.equal(ctx.appointments[0].status, 'Confirmed');
  assert.equal(entry.data[0].status, 'Confirmed');
  assert.equal(ctx.appointmentSavedRecords.size, 0);
});

test('rescheduling updates every cached language and day without duplicating an appointment', () => {
  const { ctx, entry } = fixture();
  const tomorrow = new Date(2026, 9, 5), tomorrowAt = new Date(2026, 9, 5, 18).toISOString();
  const destination = { data: [], dateKey: dateKey(tomorrow) };
  const translatedDay = { data: [row()], dateKey: entry.dateKey };
  ctx.dashboardDayCache.set('tomorrow', destination);
  ctx.dashboardDayCache.set('arabic-day', translatedDay);
  ctx.rememberSavedAppointmentRecord(row('Checked in', 'a', { appointment_at: tomorrowAt }));
  assert.equal(entry.data.length, 0);
  assert.equal(translatedDay.data.length, 0);
  assert.equal(destination.data.length, 1);
  assert.equal(destination.data[0].status, 'Checked in');
  assert.equal(ctx.appointmentRecordsAfterLocalWrites([row()], 0, entry.dateKey).length, 0);
  assert.equal(ctx.appointmentRecordsAfterLocalWrites([], 0, destination.dateKey).length, 1);
});

test('deletion clears cached statuses and prevents an older read from restoring the appointment', async () => {
  const { ctx, entry, reads } = fixture({ confirm: () => true, patientAppointmentRecords: [],
    appointmentTimeRange: () => '6 PM', queueGoogleCalendarAppointmentSync() {}, selectedAppointmentId: 'a', editingAppointmentId: null });
  const pending = ctx.ensureDashboardAppointmentsLoaded({ refresh: true });
  await settle();
  ctx.replaceAppointmentRecord(row('Completed'));
  ctx.db.from = () => ({ delete() { return this; }, eq() { return this; }, select: async () => ({ data: [{ id: 'a' }] }) });
  vm.runInContext(source('deleteAppointment'), ctx);
  await ctx.deleteAppointment('a');
  reads[0].resolve({ data: [row()] });
  await pending;
  assert.equal(ctx.appointments.length, 0);
  assert.equal(entry.data.length, 0);
});

test('account changes discard old dashboard reads and delayed metadata callbacks', async () => {
  const staff = deferred();
  const { ctx, reads, renders } = fixture({ appointmentStaffLoaded: false, ensureAppointmentStaffLoaded: () => staff.promise });
  const pending = ctx.ensureDashboardAppointmentsLoaded({ refresh: true });
  await settle();
  ctx.currentSession = { user: { id: 'other-staff' } };
  ctx.appointments = [];
  staff.resolve(true);
  reads[0].resolve({ data: [row()] });
  assert.equal(await pending, false);
  assert.equal(ctx.appointments.length, 0);
  assert.equal(renders.length, 0);
});
