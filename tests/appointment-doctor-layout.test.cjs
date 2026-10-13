const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {}

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function helper(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = html.slice(start);
  return tail.slice(0, tail.indexOf('\n    }') + 6);
}
function entry(id, doctor, start, duration = 60, status = 'Confirmed') {
  return { id, assignedUserId: doctor, doctor: doctor === 'a' ? 'Doctor A' : 'Doctor B',
    patient: `مريض تجريبي ${id}`, startAt: new Date(2026, 9, 13, Math.floor(start / 60), start % 60).toISOString(),
    duration, status, appointmentColor: doctor === 'a' ? '#65a30d' : '#7c3aed' };
}
const entries = [entry('a18', 'a', 1080), entry('a19', 'a', 1140), entry('b19', 'b', 1140),
  entry('b20', 'b', 1200), entry('a20', 'a', 1200), entry('cancelled', 'a', 1200, 60, 'Cancelled'),
  entry('b21', 'b', 1260, 30), entry('b2130', 'b', 1290, 30), entry('a21', 'a', 1260)];

test('doctors retain their lane regardless of time, input order, duration or cancellation', () => {
  const context = vm.createContext({ appointmentStaff: [{ userId: 'a' }, { userId: 'b' }],
    appointmentMinuteOfDay: item => { const date = new Date(item.startAt); return date.getHours() * 60 + date.getMinutes(); } });
  vm.runInContext(helper('layoutDayAppointments') + helper('layoutDayDoctorAppointments'), context);
  for (const input of [entries, [...entries].reverse()]) {
    const layout = context.layoutDayDoctorAppointments(input);
    assert.equal(layout.length, entries.length);
    for (const item of layout) {
      assert.equal(item.column, item.entry.assignedUserId === 'a' ? 0 : 1);
      assert.equal(item.columnCount, 2);
      assert.equal(item.stacked, ['a20', 'cancelled'].includes(item.entry.id));
      if (item.stacked) assert.deepEqual([item.groupStart, item.groupEnd, item.groupCount], [1200, 1260, 2]);
    }
  }
  assert.ok(context.layoutDayDoctorAppointments(entries.filter(item => item.assignedUserId === 'a')).every(item => item.columnCount === 1));
  assert.equal(context.layoutDayDoctorAppointments([]).length, 0);
  assert.equal(context.layoutDayAppointments(entries.filter(item => item.id === 'b20' || item.id === 'a20')).length, 2, 'week layout remains available');
});

test('half-width doctor stacks remain aligned and editable across responsive layouts', { skip: !chromium && 'Playwright unavailable' }, async t => {
  const browser = await chromium.launch({ headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  const fixture = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, link => {
    if (!/rel="stylesheet"/.test(link)) return '';
    const file = link.match(/href="([^"]+)"/)[1].split('?')[0];
    return `<style>${fs.readFileSync(path.join(root, file), 'utf8')}</style>`;
  });
  await page.setContent(fixture);
  await page.addScriptTag({ content: `
    let appointments = ${JSON.stringify(entries)}, appointmentStaff = [{userId:'a'}, {userId:'b'}];
    let appointmentSelectedDate = new Date(2026,9,13), appointmentDayHourHeight = 96;
    let selectedAppointmentId = null, appointmentCardPopoverId = null, currentUiLanguage = 'en', appointmentDoctorFilter = 'all';
    let appointmentDayDragGesture = null, appointmentDaySwipeGesture = null, appointmentDayTouchGesture = null;
    let appointmentDaySwipeClickGuardUntil = 0;
    const APPOINTMENT_TIME_STEP = 15, APPOINTMENT_MIN_DURATION = 15, APPOINTMENT_CARD_DRAG_DELAY = 500, APPOINTMENT_RANGE_MOVE_TOLERANCE = 12;
    const appointmentDayFormatter = new Intl.DateTimeFormat('en', {dateStyle:'long'}), appointmentCompactDayFormatter = appointmentDayFormatter;
    const appointmentTimeFormatter = new Intl.DateTimeFormat('en', {hour:'2-digit', minute:'2-digit', hour12:true});
    window.editable = true;
    function appointmentsForDate() { return appointments.filter(item => appointmentDoctorFilter === 'all' || item.assignedUserId === appointmentDoctorFilter); }
    function appointmentDateKey() { return '2026-10-13'; }
    function escapeAppointmentText(value) { const el = document.createElement('span'); el.textContent = String(value ?? ''); return el.innerHTML; }
    function canonicalAppointmentStatus(value) { return value; }
    function appointmentStatusVisualStyle(item) { return '--appointment-doctor-rgb:' + (item.assignedUserId === 'a' ? '101,163,13' : '124,58,237') + ';--appointment-doctor-color:' + item.appointmentColor + ';--appointment-status-color:#0891b2;color:#334155'; }
    function appointmentVisitTypeBadgeMarkup() { return '<span class="appointment-visit-type-badge px-1.5 py-0.5 text-[8px]">Check-up</span>'; }
    function appointmentTimeColumnMarkup(minutes) { return appointmentTimeFromMinutes(minutes); }
    function canModifyAppointments() { return window.editable; }
    function normaliseAppointmentDoctorFilter(value) { return value; }
    function getCalendarNonWorkingIntervalsForDate() { return []; }
    function beginAppointmentRangeSelection() {}
    function armAppointmentCardPopoverTouchGuard() {}
    function toggleAppointmentCardPopover(id) { window.openedAppointment = id; }
    function closeAppointmentCardPopover() {}
    function resetAppointmentDaySwipeVisual() {}
    function autoScrollAppointmentWeek() {}
    function persistDraggedAppointment(id, minutes) { window.savedMove = {id, minutes}; }
    function persistResizedAppointment(id, duration) { window.savedResize = {id, duration}; renderAppointmentDayTimeline(); }
    function clampAppointmentDayHourHeight(value) { return Math.max(40, Math.min(136, value)); }
    function showAppointmentDayZoomIndicator() {}
    ${['layoutDayAppointments', 'layoutDayDoctorAppointments', 'appointmentMinuteOfDay', 'appointmentDurationLabel',
      'appointmentEndDate', 'appointmentTimeRange', 'appointmentTimeFromMinutes', 'renderAppointmentDayTimeline',
      'beginAppointmentDrag', 'beginAppointmentResize', 'appointmentRootZoomScale', 'applyAppointmentDayHourHeight'].map(helper).join('\n')}
    document.getElementById('auth-gate').remove();
    document.getElementById('app-shell').classList.remove('hidden');
    document.querySelectorAll('section[id^="view-"]').forEach(el => el.classList.add('hidden'));
    document.getElementById('view-appointments').classList.remove('hidden');
    document.getElementById('appointments-month-view').classList.add('hidden');
    document.getElementById('appointments-day-view').classList.remove('hidden');
    renderAppointmentDayTimeline();
  ` });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  const card = id => page.locator('[data-timeline-appointment-id="' + id + '"]');

  for (const width of [1440, 820, 390]) for (const dir of ['ltr', 'rtl']) for (const raised of [false, true]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(({ dir, raised }) => {
      document.documentElement.dir = dir;
      currentUiLanguage = dir === 'rtl' ? 'ar' : 'en';
      document.body.classList.toggle('lumin-raised', raised);
      renderAppointmentDayTimeline();
      document.getElementById('appointments-day-timeline-scroll').scrollTop = 17 * 96;
    }, { dir, raised });
    const surface = await page.locator('[data-appointment-slot-surface]').boundingBox();
    const first = await card('a18').boundingBox();
    const label = width + ' ' + dir + ' ' + raised;
    for (const id of ['a19', 'a20', 'cancelled', 'a21']) {
      const box = await card(id).boundingBox();
      assert.ok(Math.abs(box.x - first.x) < 1, label + ': doctor A stays aligned');
      assert.ok(Math.abs(box.width - first.width) < 1, label + ': doctor A retains half width');
    }
    for (const id of ['b19', 'b20', 'b21', 'b2130']) {
      const box = await card(id).boundingBox();
      assert.ok(Math.abs(box.x - (surface.x + surface.width / 2 + 2)) < 1, label + ': doctor B stays aligned');
    }
    const upper = await card('a20').boundingBox(), lower = await card('cancelled').boundingBox();
    assert.ok(upper.height >= 44 && lower.height >= 44, label + ': stacked rows retain touch targets');
    assert.ok(lower.y >= upper.y + upper.height + 3, label + ': appointments stack vertically');
    assert.equal(await card('cancelled').getAttribute('data-appointment-status'), 'Cancelled');
    assert.equal(await card('a20').locator('.appointment-visit-type-badge').evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
    const stack = page.locator('[data-day-appointment-stack]');
    assert.equal(Math.round((await stack.boundingBox()).height), 96, label + ': stack stays in its original hour');
    if (width < 768) {
      assert.ok(await stack.evaluate(el => el.scrollHeight > el.clientHeight), 'dense mobile stack can scroll');
      await card('cancelled').focus();
      assert.ok(await stack.evaluate(el => el.scrollTop > 0), 'keyboard focus reveals the next row');
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), label + ': no page overflow');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dir = 'ltr'; currentUiLanguage = 'en'; document.body.classList.remove('lumin-raised');
    renderAppointmentDayTimeline(); document.getElementById('appointments-day-timeline-scroll').scrollTop = 18 * 96;
  });
  await card('cancelled').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.openedAppointment), 'cancelled');

  await t.test('holding a stacked row never shifts its booked time, then dragging snaps correctly', async () => {
    const box = await card('cancelled').boundingBox();
    await page.mouse.move(box.x + 20, box.y + 15);
    await page.mouse.down();
    await page.waitForFunction(() => appointmentDayDragGesture?.active);
    assert.equal(await page.evaluate(() => appointmentDayDragGesture.nextStart), 1200, 'display offset does not reschedule on activation');
    assert.equal(await page.locator('.appointment-day-drag-ghost').evaluate(el => getComputedStyle(el).position), 'fixed');
    await page.mouse.move(box.x + 20, box.y + 15 + 24);
    assert.equal(await page.evaluate(() => appointmentDayDragGesture.nextStart), 1215);
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => window.savedMove), { id: 'cancelled', minutes: 1215 });
  });
  await t.test('resizing and zooming preserve actual duration and stack placement', async () => {
    const handle = await card('a20').locator('[data-appointment-resize-handle]').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 12);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 36);
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => window.savedResize), { id: 'a20', duration: 75 });
    await page.evaluate(() => applyAppointmentDayHourHeight(136));
    assert.equal(Math.round((await page.locator('[data-day-appointment-stack]').boundingBox()).height), 136);
    assert.ok((await card('cancelled').boundingBox()).y > (await card('a20').boundingBox()).y);
    await page.evaluate(() => { appointmentDoctorFilter = 'a'; renderAppointmentDayTimeline(); });
    assert.equal(await page.locator('[data-timeline-appointment-id]').count(), 5);
    assert.ok((await card('a20').boundingBox()).width > 1000, 'a single doctor uses the available width');
  });
  if (process.env.LUMIN_CALENDAR_PREVIEW_DIR) {
    fs.mkdirSync(process.env.LUMIN_CALENDAR_PREVIEW_DIR, { recursive: true });
    for (const [width, dir] of [[1440, 'ltr'], [820, 'rtl'], [390, 'rtl']]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(dir => {
        document.documentElement.dir = dir; currentUiLanguage = dir === 'rtl' ? 'ar' : 'en';
        appointmentDoctorFilter = 'all'; appointmentDayHourHeight = 96;
        renderAppointmentDayTimeline(); document.getElementById('appointments-day-timeline-scroll').scrollTop = 18 * 96 - 12;
      }, dir);
      await page.screenshot({ path: path.join(process.env.LUMIN_CALENDAR_PREVIEW_DIR, `calendar-${width}-${dir}.png`) });
    }
  }
  assert.deepEqual(errors, []);
});
