const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'lumin-chart-appointments.js'), 'utf8');
function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const settle = () => new Promise(resolve => setImmediate(resolve));
const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const now = new Date(2026, 9, 8, 15).getTime();
const at = (hour, day = 8) => new Date(2026, 9, day, hour).toISOString();
const row = (id, status = 'Scheduled', hour = 16, extra = {}) => ({ id, patient_id: `patient-${id}`, assigned_user_id: 'staff', appointment_at: at(hour), status, patients: { name: `Patient ${id}` }, ...extra });
function fixture({ landscape = false, phone = false } = {}) {
  let timestamp = now;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [timestamp])); } static now() { return timestamp; } }
  const reads = [], intervals = new Map();
  const ctx = vm.createContext({ Date: Clock, Intl, console, currentSession: { user: { id: 'staff' } }, currentUiLanguage: 'en',
    canView: true, hasPageAccess: () => ctx.canView, appointmentDateKey: dateKey, activePatientId: 'patient-a',
    canonicalAppointmentStatus: value => value, coalescedRefreshReads: new Map(), stableJsonStringify: JSON.stringify,
    appointmentSavedRecords: new Map(), appointmentWriteRevision: 0, APPOINTMENT_SELECT_FIELDS: 'id,patient_id,assigned_user_id,appointment_at,status,patients(name)',
    normaliseAppointmentRecord: record => ({ id: record.id, patientId: record.patient_id, assignedUserId: record.assigned_user_id, isNote: !record.patient_id,
      date: dateKey(new Date(record.appointment_at)), startAt: record.appointment_at, status: record.status, patient: record.patients?.name }),
    window: { matchMedia: () => ({ matches: landscape }), LuminMobileNav: { isPhone: () => phone }, clearInterval: id => intervals.delete(id), setInterval: fn => { const id = intervals.size + 1; intervals.set(id, fn); return id; } },
    document: { addEventListener() {}, getElementById: () => null, visibilityState: 'visible' },
    db: { from(table) { const query = { table, select(fields) { this.fields = fields; return this; }, eq(column, value) { this.filterColumn = column; this.filterValue = value; return this; }, gte(column, value) { this.start = value; return this; },
      lt(column, value) { this.end = value; return this; }, order() { return this; }, range(start, end) { const read = deferred(); reads.push({ ...this, startRow: start, endRow: end, ...read }); return read.promise; } }; return query; } }
  });
  ['coalesceRefreshRead', 'contentRefreshContext', 'appointmentRecordsAfterLocalWrites'].forEach(name => vm.runInContext(source(name), ctx));
  vm.runInContext(script, ctx);
  const state = () => vm.runInContext('chartAppointments', ctx);
  return { ctx, reads, intervals, state, advance: value => { timestamp = value; } };
}

test('landscape appointments start open and data refreshes preserve manual collapse', async () => {
  const { ctx, state, reads } = fixture({ landscape: true });
  assert.equal(state().collapsed, false);
  ctx.toggleChartAppointmentsPanel();
  assert.equal(state().collapsed, true);
  const pending = ctx.loadChartAppointments();
  await settle();
  reads[0].resolve({ data: [row('a')] });
  await pending;
  assert.equal(state().collapsed, true, 'loading the daily queue preserves a manual collapse');
  ctx.resetChartAppointments({ keepTimer: true });
  assert.equal(state().collapsed, true, 'daily rollover preserves the user’s panel state');
  ctx.resetChartAppointments();
  assert.equal(state().collapsed, false, 'a fresh landscape session starts expanded');
});

test('chart entry expands landscape appointments and keeps phones and portrait views collapsed', async () => {
  for (const options of [{landscape:true,phone:false},{landscape:true,phone:true},{landscape:false,phone:false},{landscape:false,phone:true}]) {
    const { ctx, reads, state } = fixture(options);
    state().collapsed = options.landscape && !options.phone;
    ctx.setChartAppointmentsActive(true);
    assert.equal(state().collapsed, !options.landscape || options.phone);
    await settle();reads[0].resolve({data:[row('a')]});await settle();
    ctx.setChartAppointmentsActive(false);
    state().collapsed = options.landscape && !options.phone;
    ctx.setChartAppointmentsActive(true);
    assert.equal(state().collapsed, !options.landscape || options.phone,'Returning to the chart restores the device default');
    ctx.setChartAppointmentsActive(false);
  }
});

test('today queue only includes this account’s pending patients, excludes finished visits and notes, and sorts by time', () => {
  const { ctx, state } = fixture();
  state().records = [row('future'), row('waiting', 'Checked in', 10), row('ongoing', 'In progress', 14), row('done', 'Completed'),
    row('cancelled', 'Cancelled'), row('absent', 'No-show'), row('note', 'Scheduled', 18, { patient_id: null }),
    row('tomorrow', 'Confirmed', 18, { appointment_at: at(18, 9) }), row('other', 'Scheduled', 9, { assigned_user_id: 'other' }),
    row('unassigned', 'Scheduled', 11, { assigned_user_id: null })].map(ctx.normaliseAppointmentRecord);
  assert.deepEqual(Array.from(ctx.chartAppointmentsForToday(), entry => entry.id), ['waiting', 'ongoing', 'future']);
});

test('reads only today with local-midnight boundaries and paginates beyond the API row limit', async () => {
  const { ctx, reads, state } = fixture();
  const pending = ctx.loadChartAppointments();
  await settle();
  assert.equal(reads[0].table, 'appointments');
  assert.equal(reads[0].filterColumn, 'assigned_user_id');
  assert.equal(reads[0].filterValue, 'staff');
  assert.equal(reads[0].start, at(0));
  assert.equal(reads[0].end, at(0, 9));
  reads[0].resolve({ data: Array.from({ length: 1000 }, (_, i) => row(String(i))) });
  await settle();
  assert.equal(reads[1].startRow, 1000);
  assert.equal(reads[1].filterValue, 'staff','Every page is account filtered');
  reads[1].resolve({ data: [row('last')] });
  assert.equal(await pending, true);
  assert.equal(state().records.length, 1001);
  assert.equal(await ctx.loadChartAppointments(), true);
  assert.equal(reads.length, 2, 'patient navigation can reuse the day-scoped queue');
});

test('local writes and reassignment cannot introduce another account’s appointments into the queue', async () => {
  const { ctx, reads, state } = fixture();
  const pending = ctx.loadChartAppointments();await settle();
  const reassigned = row('a', 'Scheduled', 16, { assigned_user_id: 'other' });
  ctx.appointmentSavedRecords.set('a', { record: reassigned, revision: ++ctx.appointmentWriteRevision });
  const foreign = row('foreign', 'Scheduled', 17, { assigned_user_id: 'other' });
  ctx.appointmentSavedRecords.set('foreign', { record: foreign, revision: ++ctx.appointmentWriteRevision });
  reads[0].resolve({data:[row('a'),row('own'),foreign]});await pending;
  assert.deepEqual(Array.from(state().records, entry=>entry.id),['own']);
  ctx.updateChartAppointmentRecord(ctx.normaliseAppointmentRecord(row('own','Scheduled',16,{assigned_user_id:'other'})));
  assert.equal(state().records.length,0,'Reassigning an existing card removes it');
  ctx.updateChartAppointmentRecord(ctx.normaliseAppointmentRecord(foreign));
  assert.equal(state().records.length,0,'Unrelated local saves stay out of the queue');
  ctx.updateChartAppointmentRecord(ctx.normaliseAppointmentRecord(row('own')));
  assert.deepEqual(Array.from(ctx.chartAppointmentsForToday(), entry=>entry.id),['own'],'Assignments to this account appear immediately');
});

test('account switches discard cached records and ignore another account’s in-flight read', async () => {
  const { ctx, reads, state } = fixture();
  const old = ctx.loadChartAppointments();await settle();
  ctx.currentSession={user:{id:'other'}};
  const next=ctx.loadChartAppointments();await settle();
  assert.equal(state().records.length,0);
  assert.equal(reads[1].filterValue,'other');
  reads[1].resolve({data:[row('theirs','Scheduled',16,{assigned_user_id:'other'}),row('ours')]});await next;
  reads[0].resolve({data:[row('old')]});assert.equal(await old,false);
  assert.deepEqual(Array.from(state().records, entry=>entry.id),['theirs']);
});

test('a stale read cannot resurrect a locally completed patient; a later read accepts another staff member’s edits', async () => {
  const { ctx, reads, state } = fixture();
  const pending = ctx.loadChartAppointments();
  await settle();
  const completed = row('a', 'Completed');
  ctx.appointmentSavedRecords.set('a', { record: completed, revision: ++ctx.appointmentWriteRevision });
  ctx.updateChartAppointmentRecord(ctx.normaliseAppointmentRecord(completed));
  reads[0].resolve({ data: [row('a', 'Confirmed')] });
  await pending;
  assert.equal(ctx.chartAppointmentsForToday().length, 0);
  const next = ctx.loadChartAppointments({ refresh: true });
  await settle();
  reads[1].resolve({ data: [row('a', 'Checked in'), row('b', 'Cancelled'), row('new', 'Confirmed')] });
  await next;
  assert.deepEqual(Array.from(ctx.chartAppointmentsForToday(), entry => entry.id), ['a', 'new']);
  ctx.removeChartAppointmentRecord('a');
  assert.equal(state().records.some(entry => entry.id === 'a'), false);
});

test('bursts of realtime changes get a trailing read and failures retain the last usable list', async () => {
  const { ctx, reads, state } = fixture();
  const first = ctx.loadChartAppointments();
  await settle();
  const next = ctx.loadChartAppointments({ refresh: true });
  reads[0].resolve({ data: [row('a')] });
  await settle();
  reads[1].resolve({ data: [row('a', 'Cancelled'), row('b')] });
  await Promise.all([first, next]);
  assert.deepEqual(Array.from(ctx.chartAppointmentsForToday(), entry => entry.id), ['b']);
  const failing = ctx.loadChartAppointments({ refresh: true, throwOnError: true });
  await settle(); reads[2].resolve({ error: Error('Offline') });
  await assert.rejects(failing, /Offline/);
  assert.equal(state().status, 'ready');
  assert.deepEqual(Array.from(ctx.chartAppointmentsForToday(), entry => entry.id), ['b']);
  assert.match(state().error.message, /Offline/);
});

test('permission loss and sign-out clear patient data and invalidate in-flight results', async () => {
  const { ctx, reads, state } = fixture();
  const pending = ctx.loadChartAppointments();
  await settle();
  ctx.currentSession = null;
  ctx.resetChartAppointments();
  reads[0].resolve({ data: [row('a')] });
  assert.equal(await pending, false);
  assert.equal(state().records.length, 0);
  ctx.currentSession = { user: { id: 'staff' } }; ctx.canView = false;
  assert.equal(await ctx.loadChartAppointments(), false);
  assert.equal(reads.length, 1, 'no appointment read without appointment access');
});

test('changes received on another page invalidate the cached queue before returning to the chart', async () => {
  const { ctx, reads, state } = fixture();
  const first=ctx.loadChartAppointments();await settle();reads[0].resolve({data:[row('a')]});await first;
  assert.ok(state().expiresAt>now);
  ctx.invalidateChartAppointments();
  const next=ctx.loadChartAppointments();await settle();
  assert.equal(reads.length,2,'the unexpired cache is invalidated by off-page appointment events');
  reads[1].resolve({data:[row('a','Completed')]});await next;
  assert.equal(ctx.chartAppointmentsForToday().length,0);
});

test('midnight rollover refreshes the day, clears yesterday, and keeps the rollover timer running', async () => {
  const { ctx, reads, intervals, state, advance } = fixture();
  ctx.setChartAppointmentsActive(true);
  await settle(); reads[0].resolve({ data: [row('a')] }); await settle();
  assert.equal(intervals.size, 1);
  advance(new Date(2026, 9, 9, 0, 0, 1).getTime());
  [...intervals.values()][0]();
  await settle();
  assert.equal(state().records.length, 0);
  assert.equal(reads[1].start, at(0, 9));
  reads[1].resolve({ data: [row('b', 'Confirmed', 16, { appointment_at: at(16, 9) })] });
  await settle();
  assert.equal(intervals.size, 1);
  assert.deepEqual(Array.from(ctx.chartAppointmentsForToday(), entry => entry.id), ['b']);
  ctx.setChartAppointmentsActive(false);
  assert.equal(intervals.size, 0);
});

test('chart navigation, local saves, realtime refresh, reconnect, and offline shell include the queue', () => {
  assert.match(source('switchView'), /viewName === 'chart' && typeof collapseChartSidePanels === 'function'\) collapseChartSidePanels\(\);[\s\S]*?setChartAppointmentsActive\(viewName === 'chart'\)/);
  assert.match(source('switchView'), /setChartAppointmentsActive\(viewName === 'chart'\)/);
  assert.match(source('flushRealtimeRefresh'), /realtimeViewIsVisible\('chart'\)[\s\S]*?loadChartAppointments\(\{ refresh: true, throwOnError: true \}\)/);
  assert.match(source('queueRealtimeLoadedRefresh'), /realtimeViewIsVisible\('chart'\)/);
  assert.match(source('replaceNormalisedAppointmentRecord'), /updateChartAppointmentRecord\(normalized\)/);
  assert.match(source('deleteAppointment'), /removeChartAppointmentRecord\(appointmentId\)/);
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const appointmentsScript = html.match(/src="(lumin-chart-appointments\.js\?v=\d+)"/)[1];
  assert.ok(sw.includes('/' + appointmentsScript), 'the offline shell uses the current appointment script');
  assert.match(sw, /lumin-chart-appointments.css\?v=1/);
});
