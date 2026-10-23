const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}

test('schedule controls and compact attendance work across themes, devices and languages', async t => {
  const browser = await chromium.launch({ headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1151, height: 884 }, timezoneId: 'Africa/Cairo', hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'lumin-schedule.test') return route.abort();
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
    const body = file.endsWith('index.html') ? html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '') : fs.readFileSync(file);
    return route.fulfill({ contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'application/javascript', body });
  });
  await page.goto('https://lumin-schedule.test/');
  await page.addScriptTag({ path: path.join(root, 'vendor/lucide.min.js') });
  await page.addScriptTag({ path: path.join(root, 'lumin-dates.js') });
  const formatters = html.slice(html.indexOf('    let appointmentMonthFormatter;'), html.indexOf('    function refreshAppCurrentDate('));
  await page.addScriptTag({ content: `
    let currentUiLanguage = 'en', useTwelveHourTime = true;
    const WHATSAPP_TEMPLATE_FORMATTERS = {};
    let currentUserAccess = { userId: 'fixture', isDoctor: false };
    const clinicAttendanceSettings = { enabled: true }, myHrStaffSettings = { attendance_enabled: true };
    let myOpenAttendanceSession = null, attendanceWrites = 0, attendanceLocationRequests = 0;
    let resolveAttendanceLocation, resolveAttendanceRefresh;
    const currentSession = { user: { id: 'fixture' } };
    const appointmentToday = new Date(2026, 9, 23);
    let dashboardSelectedDate = new Date(2026, 9, 24), expandedDashboardAppointmentId = null;
    let dashboardInvoiceRenderToken = 0, activeDashboardMobileTab = 'schedule', appointmentsLoaded = true;
    const dashboardDayCache = new Map();
    ${formatters}
    function canViewDashboardInvoices() { return true; }
    function refreshMyAttendanceState(options = {}) {
      if (options.force) return new Promise(resolve => { resolveAttendanceRefresh = () => { renderMyAttendanceState(); resolve(); }; });
      renderMyAttendanceState();
    }
    function ensureDashboardAppointmentsLoaded() {}
    function renderDashboardDoctorFilter() { return null; }
    function dashboardAppointmentsForDate() { return []; }
    function dashboardDayContext() { return 'fixture'; }
    function setStableHtml(node, markup) { node.innerHTML = markup; }
    function refreshWhatsAppTemplatePickerAnchor() {}
    function ensureAppointmentWaitIndicatorTimer() {}
    function renderDashboardInvoices() { document.getElementById('dashboard-invoice-date').textContent = appointmentDayFormatter.format(dashboardSelectedDate); }
    function refreshAppCurrentDate() { appointmentToday.setTime(new Date().setHours(0, 0, 0, 0)); }
    function getDevicePosition() {
      attendanceLocationRequests++;
      return new Promise(resolve => { resolveAttendanceLocation = () => resolve({ coords: { latitude: 30, longitude: 31, accuracy: 10 } }); });
    }
    const db = {
      rpc: async (name, args) => { attendanceWrites++; myOpenAttendanceSession = args.p_action === 'check_in' ? { id: 'fixture' } : null; return { data: { id: 'fixture' } }; },
      functions: { invoke: async () => ({ data: { sent: true } }) }
    };
    ${['syncDashboardMobileTabs', 'renderDashboard', 'changeDashboardDay', 'showDashboardToday', 'renderMyAttendanceState',
      'queueHrAttendancePushNotification', 'recordMobileAttendance'].map(source).join('\n')}
    document.getElementById('auth-gate').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');
    window.LuminMobileNav = { isPhone: () => innerWidth < 768 };
    window.showFixture = (language, theme, view = 'dashboard') => {
      currentUiLanguage = language;
      document.documentElement.lang = language;
      document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
      document.documentElement.classList.toggle('lumin-phone-nav', innerWidth < 768);
      document.body.classList.toggle('lumin-raised', theme === 'raised');
      for (const section of document.querySelectorAll('section[id^="view-"]')) section.classList.toggle('hidden', section.id !== 'view-' + view);
      configureAppointmentFormatters(); renderDashboard(); lucide.createIcons();
    };
    showFixture('en', 'raised');
  ` });
  const shots = path.join(root, '.lumin-drive-test-tools', 'schedule-toolbar-preview');
  fs.mkdirSync(shots, { recursive: true });
  for (const width of [320, 390, 820, 1151, 1440]) for (const language of ['en', 'ar']) for (const theme of ['flat', 'raised']) {
    await page.setViewportSize({ width, height: 884 });
    await page.evaluate(({ language, theme }) => { dashboardSelectedDate = new Date(2026, 9, 24); showFixture(language, theme); }, { language, theme });
    assert.equal(await page.locator('#dashboard-day-eyebrow').count(), 0);
    assert.equal(await page.locator('#dashboard-date-heading').textContent(), `${language === 'ar' ? 'السبت' : 'Saturday'} · 24/10/2026`);
    assert.equal(await page.locator('#dashboard-invoice-date').textContent(), await page.locator('#dashboard-date-heading').textContent());
    for (const button of await page.locator('#dashboard-date-toolbar button').all()) {
      const box = await button.boundingBox();
      assert.ok(box.width >= 43.9 && box.height >= 43.9 && box.x >= 0 && box.x + box.width <= width + 1, `touch target: ${width} ${language} ${theme} ${JSON.stringify(box)}`);
      assert.equal(await button.evaluate(node => getComputedStyle(node).borderWidth), '0px');
    }
    const today = page.locator('#dashboard-today-button');
    assert.equal(await today.locator('span').isVisible(), true);
    await today.click();
    assert.equal(await page.evaluate(() => dashboardSelectedDate.getTime()), await page.evaluate(() => new Date().setHours(0, 0, 0, 0)));
    assert.equal(await today.isVisible(), true, 'Today remains available on the current date');
    if (width < 768) {
      const attendance = page.locator('#dashboard-attendance-action');
      assert.equal((await attendance.innerText()).trim(), language === 'ar' ? 'تسجيل الحضور' : 'Check in');
      assert.equal(await attendance.locator('svg.lucide-fingerprint').count(), 1);
      assert.equal(await page.locator('#dashboard-attendance-summary, #dashboard-attendance-heading').count(), 0);
      const box = await attendance.boundingBox();
      assert.ok(box.height >= 44 && box.height < 65, 'compact attendance keeps a touch-safe height');
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (theme === 'raised' && [390, 1151].includes(width)) await page.locator('#view-dashboard').screenshot({ path: path.join(shots, `dashboard-${width}-${language}.png`) });
    await page.evaluate(({ language, theme }) => showFixture(language, theme, 'appointments'), { language, theme });
    const calendarToday = page.locator('#appointment-today-button');
    assert.equal(await calendarToday.locator('span').isVisible(), true);
    const box = await calendarToday.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44 && box.x >= 0 && box.x + box.width <= width);
    for (const button of await page.locator('#appointments-calendar-toolbar button').all()) {
      const target = await button.boundingBox();
      assert.ok(target.width >= 43.9 && target.height >= 43.9 && target.x >= 0 && target.x + target.width <= width + 1, `calendar touch target: ${width} ${language} ${theme} ${JSON.stringify(target)}`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.setViewportSize({ width: 390, height: 884 });
  await page.evaluate(() => showFixture('en', 'raised'));
  const attendance = page.locator('#dashboard-attendance-action');
  await attendance.click();
  assert.equal(await attendance.isDisabled(), true, 'one tap starts loading and disables the button immediately');
  assert.equal(await attendance.getAttribute('aria-busy'), 'true');
  await page.evaluate(async () => { await Promise.all([recordMobileAttendance(), recordMobileAttendance()]); });
  assert.equal(await page.evaluate(() => attendanceLocationRequests), 1, 'rapid duplicate calls cannot request location again');
  await page.evaluate(() => resolveAttendanceLocation());
  await page.waitForFunction(() => attendanceWrites === 1);
  await page.evaluate(() => renderMyAttendanceState());
  assert.equal(await attendance.isDisabled(), true, 'the button stays disabled through state refresh and rendering');
  await page.evaluate(() => resolveAttendanceRefresh());
  await page.waitForFunction(() => !document.getElementById('dashboard-attendance-action').disabled);
  assert.equal((await attendance.innerText()).trim(), 'Check out');
  assert.equal(await attendance.locator('svg.lucide-fingerprint').count(), 1);
  assert.equal(await attendance.getAttribute('aria-busy'), 'false');
  await attendance.focus();
  await page.keyboard.press(' ');
  assert.equal(await attendance.isDisabled(), true, 'native keyboard activation also uses one press');
  await page.evaluate(() => resolveAttendanceLocation());
  await page.waitForFunction(() => attendanceWrites === 2);
  await page.evaluate(() => resolveAttendanceRefresh());
  await page.waitForFunction(() => !document.getElementById('dashboard-attendance-action').disabled);
  assert.equal((await attendance.innerText()).trim(), 'Check in');
  await page.evaluate(() => { currentUserAccess.isDoctor = true; renderMyAttendanceState(); });
  assert.equal(await page.locator('#dashboard-attendance-card').isVisible(), false, 'existing attendance eligibility is preserved');
  assert.deepEqual(errors, []);
});
