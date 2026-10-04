const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
let playwright;
try { playwright = require('playwright'); } catch (_) { /* Provide Playwright through NODE_PATH. */ }

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const fixture = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
function helper(name) {
  const start = source.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n    (?:async )?function /);
  return rest.slice(0, end + 1);
}
const initialization = source.slice(source.indexOf('    const dashboardStatusPicker ='), source.indexOf('    function toggleDashboardAppointmentActions('));

test('appointment picker animates and saves accessibly across responsive layouts', { skip: !playwright && 'Playwright is unavailable' }, async t => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(fixture); return; }
    const target = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', target.endsWith('.css') ? 'text/css' : target.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const engine = process.env.LUMIN_TEST_BROWSER_ENGINE || 'chromium';
  const browser = await playwright[engine].launch({ headless: true, executablePath: process.env.LUMIN_TEST_BROWSER_EXECUTABLE || undefined, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await page.addScriptTag({ url: `${url}/vendor/lucide.min.js` });
  await page.addScriptTag({ url: `${url}/lumin-appointment-status.js?v=2` });
  await page.addScriptTag({ content: `
    ${source.match(/    const APPOINTMENT_STATUSES = [^\n]+/)[0]}
    let currentUiLanguage = 'en', expandedDashboardAppointmentId = null, dashboardInvoiceRenderToken = 0;
    let allowed = true, appointmentsLoaded = true;
    const currentUserAccess = { isDoctor: false }, dashboardDayCache = new Map(), recentLocalAppointmentChanges = new Map();
    const appointmentToday = new Date(2026, 9, 4), dashboardSelectedDate = appointmentToday;
    const appointmentDayFormatter = new Intl.DateTimeFormat('en', { dateStyle: 'long' });
    const patients = [{ id: 'patient-a', age: 21 }];
    let appointments = [
      { id: 'a', patientId: 'patient-a', patient: 'فرح اشرف', doctor: 'Test clinician', status: 'Confirmed', time: '06:00 PM', duration: 30, appointmentColor: '#7c3aed' },
      { id: 'b', patientId: 'patient-b', patient: 'Another appointment', doctor: 'Test clinician', status: 'Scheduled', time: '06:30 PM', duration: 30, appointmentColor: '#2563eb' }
    ];
    const translations = { Scheduled: 'مجدول', Confirmed: 'مؤكد', 'Checked in': 'تم الحضور', 'In progress': 'قيد العلاج', Completed: 'مكتمل', Cancelled: 'ملغي', 'No-show': 'لم يحضر' };
    function arabicUiPhrase(status) { return translations[status] || status; }
    function escapeHtml(value) { const element = document.createElement('span'); element.textContent = String(value ?? ''); return element.innerHTML; }
    function canModifyAppointments() { return allowed; }
    function refreshMyAttendanceState() {}
    function ensureDashboardAppointmentsLoaded() {}
    function canViewDashboardInvoices() { return false; }
    function syncDashboardMobileTabs() {}
    function renderDashboardDoctorFilter() { return { label: 'Test clinician' }; }
    function dashboardAppointmentsForDate() { return appointments; }
    function dashboardDayContext() { return 'fixture'; }
    function sameAppointmentDate() { return true; }
    function patientAgeLabel() { return '21 yrs'; }
    function normaliseCallPhone() { return ''; }
    function normaliseWhatsAppPhone() { return ''; }
    function hasPageAccess() { return false; }
    function canonicalAppointmentStatus(status) { return status; }
    function appointmentColorRgba() { return '#eff6ff'; }
    function appointmentTextColor() { return '#1d4ed8'; }
    function appointmentDurationLabel() { return '30 min'; }
    function checkedInWaitIndicatorMarkup(entry) { return entry.status === 'Checked in' ? '<span data-appointment-wait>Waiting</span>' : ''; }
    function appointmentVisitTypeBadgeMarkup() { return '<span class="appointment-visit-type-badge">Check-up</span>'; }
    function dashboardMobileContactActionsMarkup() { return ''; }
    function refreshWhatsAppTemplatePickerAnchor() {}
    function ensureAppointmentWaitIndicatorTimer() {}
    function markLocalAppointmentChange(id) { recentLocalAppointmentChanges.set(id, true); }
    function updateAppointmentRecordWithRetry(id, values) { window.saveCalls = (window.saveCalls || 0) + 1; return new Promise(resolve => window.finishSave = success => resolve(success ? { data: {...appointments.find(entry => entry.id === id), ...values} } : { error: { message: 'Offline' } })); }
    function replaceAppointmentRecord(data) { appointments = appointments.map(entry => entry.id === data.id ? data : entry); }
    function queueAppointmentPushNotification(...args) { window.pushCalls = [...(window.pushCalls || []), args]; }
    function renderAppointments() {}
    window.alert = message => window.lastAlert = message;
    ${helper('escapeAppointmentText')}
    ${helper('setStableHtml')}
    ${helper('changeDashboardAppointmentStatus')}
    ${initialization}
    ${helper('renderDashboard')}
    document.getElementById('auth-gate').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');
    document.getElementById('view-dashboard').classList.remove('hidden');
    renderDashboard();
  ` });
  const trigger = page.locator('[data-appointment-id="a"]');
  const listbox = page.getByRole('listbox');
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(errors, [], 'fixture initializes the real dashboard');

  await t.test('touch, viewport edges, Arabic and both themes, including app zoom', async () => {
    for (const [width, height] of [[390, 844], [671, 884], [820, 1180], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      for (const dir of ['ltr', 'rtl']) for (const theme of ['flat', 'raised']) for (const scale of [0.8, 1, 1.25]) {
        await page.evaluate(({ dir, theme, scale }) => {
          dashboardStatusPicker.close(false, false);
          document.documentElement.dir = dir;
          document.documentElement.style.zoom = scale;
          document.documentElement.classList.toggle('is-laptop-device', innerWidth >= 1024);
          document.body.classList.toggle('lumin-raised', theme === 'raised');
          currentUiLanguage = dir === 'rtl' ? 'ar' : 'en';
          renderDashboard();
        }, { dir, theme, scale });
        await trigger.tap();
        await page.waitForTimeout(220);
        assert.equal(await listbox.locator('[role="option"]').count(), 7);
        const box = await listbox.boundingBox();
        assert.ok(box.x >= 8 && box.x + box.width <= width - 8, JSON.stringify({ width, dir, theme, scale, box }));
        assert.ok(box.y >= 8 && box.y + box.height <= height - 8, 'menu fits vertically');
        assert.equal(await listbox.locator('[aria-selected="true"]').textContent(), dir === 'rtl' ? 'مؤكد' : 'Confirmed');
        assert.equal(await trigger.evaluate(button => getComputedStyle(button).borderTopWidth), '0px');
        if (scale === 1) {
          assert.ok((await trigger.boundingBox()).height >= 44);
          for (const option of await listbox.locator('[role="option"]').all()) assert.ok((await option.boundingBox()).height >= 44);
        }
        await page.keyboard.press('Escape');
        assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
        assert.equal(await trigger.evaluate(button => button === document.activeElement), true);
      }
    }
  });

  await t.test('menus flip upward and stay scrollable in short viewports', async () => {
    await page.setViewportSize({ width: 390, height: 460 });
    await page.evaluate(() => {
      dashboardStatusPicker.close(false, false);
      document.documentElement.style.zoom = 1;
      document.querySelector('[data-appointment-id="a"]').style.cssText = 'position:fixed;bottom:16px;right:16px';
    });
    await trigger.tap();
    await page.waitForTimeout(220);
    assert.equal(await page.locator('.lumin-status-menu:not([aria-hidden])').getAttribute('data-side'), 'above');
    assert.ok((await listbox.boundingBox()).y >= 12);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 180 });
    await trigger.tap();
    await page.waitForTimeout(220);
    await page.keyboard.press('End');
    const active = await page.locator('[role="option"]:focus').boundingBox();
    assert.ok(active.y >= 12 && active.y + active.height <= 168);
    await page.keyboard.press('Escape');
    await trigger.evaluate(button => button.removeAttribute('style'));
    await page.setViewportSize({ width: 671, height: 884 });
  });

  await t.test('keyboard selection, fast save, animation continuity and duplicate protection', async () => {
    await page.evaluate(() => { dashboardStatusPicker.close(false, false); currentUiLanguage = 'en'; document.documentElement.dir = 'ltr'; document.documentElement.style.zoom = 1; renderDashboard(); });
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    await settle();
    assert.equal(await listbox.evaluate(element => element.getAnimations({ subtree: true }).length > 0), true);
    await page.keyboard.press('ArrowDown');
    await page.evaluate(() => { window.originalButton = document.querySelector('[data-appointment-id="a"]'); window.otherCard = document.querySelector('[data-dashboard-appointment-card="b"]'); });
    await page.keyboard.press('Enter');
    assert.equal(await trigger.getAttribute('data-status'), 'Checked in');
    assert.equal(await trigger.getAttribute('aria-disabled'), 'true');
    assert.equal(await trigger.evaluate(button => button.disabled), false, 'pending saves retain keyboard focus');
    assert.equal(await trigger.evaluate(button => button === document.activeElement), true);
    assert.equal(await page.evaluate(() => saveCalls), 1);
    await page.evaluate(() => finishSave(true));
    await page.waitForFunction(() => !document.querySelector('[data-appointment-id="a"]').hasAttribute('aria-busy'));
    assert.equal(await trigger.evaluate(button => button === originalButton), true, 'fast saves retain the animated button');
    assert.equal(await page.evaluate(() => document.querySelector('[data-dashboard-appointment-card="b"]') === otherCard), true);
    assert.equal(await trigger.evaluate(button => button.getAnimations({ subtree: true }).length > 0), true);
    assert.equal(await trigger.evaluate(button => button === document.activeElement), true);
    assert.equal(await page.locator('[data-appointment-wait]').count(), 1);
    assert.equal(await page.evaluate(() => pushCalls[0][2].new_status), 'Checked in');
    await trigger.click();
    await listbox.locator('[data-status="Checked in"]').click();
    assert.equal(await page.evaluate(() => saveCalls), 1, 'reselecting the same status does not save');
  });

  await t.test('failed saves roll back the control; permissions block editing', async () => {
    await trigger.click();
    await listbox.locator('[data-status="Cancelled"]').click();
    assert.equal(await trigger.getAttribute('data-status'), 'Cancelled');
    await page.evaluate(() => finishSave(false));
    await page.waitForFunction(() => !document.querySelector('[data-appointment-id="a"]').hasAttribute('aria-busy'));
    assert.equal(await trigger.getAttribute('data-status'), 'Checked in');
    assert.match(await page.evaluate(() => lastAlert), /Offline/);
    assert.equal(await page.evaluate(() => pushCalls.length), 1);
    await page.evaluate(() => { allowed = false; renderDashboard(); });
    assert.equal(await trigger.isDisabled(), true);
    await page.evaluate(() => { allowed = true; renderDashboard(); });
  });

  await t.test('refreshes, outside taps, Tab and routing dismiss the menu', async () => {
    await trigger.click();
    await page.evaluate(() => { appointments[1].notes = 'Background update'; renderDashboard(); });
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Tab');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    await trigger.click();
    await page.locator('#dashboard-date-heading').tap();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    await trigger.click();
    await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
    assert.equal(await listbox.count(), 0);
  });

  await t.test('save and refresh frames keep the glass control connected, focused and stationary', async () => {
    for (const [width, height] of [[390, 844], [820, 1180], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      for (const dir of ['ltr', 'rtl']) for (const theme of ['flat', 'raised']) {
        await page.evaluate(({ dir, theme }) => {
          dashboardStatusPicker.close(false, false);
          document.documentElement.dir = dir;
          document.documentElement.style.zoom = 1;
          document.documentElement.classList.toggle('is-laptop-device', innerWidth >= 1024);
          document.body.classList.toggle('lumin-raised', theme === 'raised');
          currentUiLanguage = dir === 'rtl' ? 'ar' : 'en';
          appointments[0].status = 'Confirmed';
          renderDashboard();
        }, { dir, theme });
        await trigger.tap();
        await page.waitForTimeout(220);
        const glass = await listbox.evaluate(element => {
          const style = getComputedStyle(element);
          return { blur: style.backdropFilter || style.webkitBackdropFilter, background: style.backgroundImage };
        });
        assert.match(glass.blur, /blur\(24px\)/);
        assert.match(glass.background, /rgba/);
        await page.evaluate(() => {
          const button = document.querySelector('[data-appointment-id="a"]');
          window.originalAncestors = [];
          window.originalChevron = button.querySelector('svg');
          for (let node = button; node && node.id !== 'dashboard-appointments-list'; node = node.parentElement) originalAncestors.push(node);
          window.detachedControl = false;
          window.motionObserver = new MutationObserver(records => {
            if (records.some(record => Array.from(record.removedNodes).some(node => originalAncestors.includes(node)))) detachedControl = true;
          });
          motionObserver.observe(document.getElementById('dashboard-appointments-list'), { childList: true, subtree: true });
          const bounds = button.getBoundingClientRect();
          window.stationaryBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        });
        await listbox.locator('[data-status="Completed"]').tap();
        const measurements = await page.evaluate(async () => {
          const frames = [];
          for (let frame = 0; frame < 18; frame++) {
            if (frame === 2 || frame === 4 || frame === 9) { appointments[0].notes = 'Refresh ' + frame; renderDashboard(); }
            if (frame === 6) finishSave(true);
            await new Promise(resolve => requestAnimationFrame(resolve));
            const button = document.querySelector('[data-appointment-id="a"]');
            const bounds = button.getBoundingClientRect(), style = getComputedStyle(button);
            frames.push({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, focused: document.activeElement === button, connected: originalAncestors.every(node => node.isConnected), sameChevron: button.querySelector('svg') === originalChevron, opacity: style.opacity, background: style.backgroundColor });
          }
          motionObserver.disconnect();
          return { frames, baseline: stationaryBounds, detached: detachedControl };
        });
        assert.equal(measurements.detached, false, 'no button ancestor detaches during refresh');
        for (const frame of measurements.frames) {
          for (const dimension of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(frame[dimension] - measurements.baseline[dimension]) < .25, `${width} ${dir} ${theme}: ${dimension} stays steady`);
          assert.equal(frame.connected, true);
          assert.equal(frame.sameChevron, true, 'icon refreshes never replace the chevron');
          assert.equal(frame.focused, true);
          assert.equal(frame.opacity, '1', 'saving never dims the glass control');
          assert.equal(frame.background, 'rgba(0, 0, 0, 0)', 'the control has no solid fill');
        }
      }
    }
  });

  await t.test('reduced motion removes animations while selection still works', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    await trigger.click();
    assert.equal(await listbox.evaluate(element => element.getAnimations({ subtree: true }).length), 0);
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.status), 'No-show');
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    assert.equal(await trigger.getAttribute('data-status'), 'Scheduled');
    assert.equal(await trigger.evaluate(button => button.getAnimations({ subtree: true }).length), 0);
    assert.equal(await trigger.evaluate(button => getComputedStyle(button).transitionDuration), '0s');
    await page.evaluate(() => finishSave(true));
    await page.waitForFunction(() => !document.querySelector('[data-appointment-id="a"]').hasAttribute('aria-busy'));
  });
  await t.test('real day-cache refreshes never flash the old status after saving', async () => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.addScriptTag({ content: `
      let currentSession = { user: { id: 'staff' } }, appointmentWriteRevision = 0;
      let appointmentStaffLoaded = true, appointmentVisitTypesLoaded = true;
      const appointmentSavedRecords = new Map(), appointmentMoveStates = new Map(), coalescedRefreshReads = new Map();
      const APPOINTMENT_SELECT_FIELDS = 'id,appointment_at,status';
      const stableJsonStringify = JSON.stringify;
      const db = { from() { return { select() { return this; }, gte() { return this; }, lt() { return this; }, order() { return this; },
        range() { window.dayReadCount = (window.dayReadCount || 0) + 1; return new Promise(resolve => window.finishDayRead = records => resolve({ data: records })); } }; } };
      function ensureAppointmentStaffLoaded() { return new Promise(resolve => window.finishStaffRead = resolve); }
      function ensureAppointmentVisitTypesLoaded() { return Promise.resolve(true); }
      function realtimeViewIsVisible(view) { return view === 'dashboard'; }
      function notifyRealtimeAppointmentChanges() {}
      function normaliseAppointmentRecord(record) { return { ...record, date: appointmentDateKey(new Date(record.appointment_at)) }; }
      ${helper('appointmentDateKey')}
      ${helper('coalesceRefreshRead')}
      ${helper('appointmentRecordsAfterLocalWrites')}
      ${helper('replaceNormalisedAppointmentRecord')}
      ${helper('rememberSavedAppointmentRecord')}
      ${helper('replaceAppointmentRecord')}
      ${helper('ensureDashboardAppointmentsLoaded')}
      hasPageAccess = () => true;
      currentUiLanguage = 'en';
      document.documentElement.dir = 'ltr';
      appointments = appointments.map(entry => ({ ...entry, appointment_at: new Date(2026, 9, 4, 18).toISOString(), status: 'Confirmed' }));
      appointmentsLoaded = false;
      dashboardDayCache.set(dashboardDayContext(), { data: appointments.map(entry => ({ ...entry })), dateKey: appointmentDateKey(dashboardSelectedDate), expiresAt: Date.now() + 15000 });
      renderDashboard();
      window.statusHistory = [];
      window.statusObserver = new MutationObserver(records => {
        records.filter(record => record.attributeName === 'data-status' && record.target.dataset.appointmentId === 'a')
          .forEach(record => statusHistory.push(record.target.dataset.status));
      });
      statusObserver.observe(document.getElementById('dashboard-appointments-list'), { attributes: true, subtree: true });
    ` });
    await trigger.tap();
    await listbox.locator('[data-status="Checked in"]').tap();
    await page.evaluate(() => finishSave(true));
    await page.waitForFunction(() => !document.querySelector('[data-appointment-id="a"]').hasAttribute('aria-busy'));
    await page.evaluate(() => {
      appointmentStaffLoaded = false;
      window.refreshDone = ensureDashboardAppointmentsLoaded({ refresh: true });
    });
    await page.waitForFunction(() => window.dayReadCount === 1 && window.finishStaffRead);
    await page.evaluate(() => { finishStaffRead(true); appointmentStaffLoaded = true; });
    await page.waitForTimeout(80);
    assert.equal(await trigger.getAttribute('data-status'), 'Checked in', 'metadata enrichment retains the saved status');
    await page.evaluate(async () => { finishDayRead(dashboardDayCache.get(dashboardDayContext()).data); await refreshDone; });
    await page.evaluate(() => { window.refreshDone = ensureDashboardAppointmentsLoaded({ refresh: true }); });
    await page.waitForFunction(() => window.dayReadCount === 2);
    await trigger.tap();
    await listbox.locator('[data-status="Completed"]').tap();
    await page.evaluate(() => finishSave(true));
    await page.waitForFunction(() => !document.querySelector('[data-appointment-id="a"]').hasAttribute('aria-busy'));
    await page.evaluate(async () => {
      finishDayRead(dashboardDayCache.get(dashboardDayContext()).data.map(record => ({ ...record, status: 'Checked in' })));
      await refreshDone;
    });
    await page.waitForTimeout(200);
    assert.equal(await trigger.getAttribute('data-status'), 'Completed', 'a delayed snapshot cannot undo a later save');
    const history = await page.evaluate(() => { statusObserver.disconnect(); return statusHistory; });
    assert.deepEqual([...new Set(history)], ['Checked in', 'Completed']);
    assert.equal(history.includes('Confirmed'), false);
    assert.equal(history.slice(history.indexOf('Completed')).includes('Checked in'), false);
  });
  assert.deepEqual(errors, []);
  if (process.env.LUMIN_TEST_SCREENSHOT) {
    await page.setViewportSize({ width: 671, height: 884 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await trigger.click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: process.env.LUMIN_TEST_SCREENSHOT });
  }
});
