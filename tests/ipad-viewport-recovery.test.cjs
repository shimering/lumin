const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
let playwright;
try { playwright = require('playwright'); } catch (_) {}

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
// Run the actual page styles and sizing code without loading clinic data.
const fixture = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, link => {
  if (!/rel="stylesheet"/.test(link)) return '';
  const file = link.match(/href="([^"]+)"/)[1].split('?')[0];
  return `<style>${fs.readFileSync(path.join(root, file), 'utf8')}</style>`;
});
const helpers = source.slice(source.indexOf('    function updateAppViewportDimensions('), source.indexOf('    function refreshAppointmentCurrentTimeLine('));

test('iPad panels recover from stale viewport readings without restarting', { skip: !playwright && 'Playwright unavailable' }, async t => {
  const engine = process.env.LUMIN_TEST_BROWSER_ENGINE || 'chromium';
  const browser = await playwright[engine].launch({ headless: true,
    executablePath: process.env.LUMIN_TEST_BROWSER_EXECUTABLE || undefined,
    channel: engine === 'chromium' ? process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined : undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1408, height: 970 }, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent(fixture);
  await page.addScriptTag({ content: `
    let appointmentCalendarResizeFrame = null, patientQueryResizeFrame = null, dashboardResizeFrame = null;
    let activeDashboardMobileTab = 'schedule', currentUiLanguage = 'en';
    function canViewDashboardInvoices() { return true; }
    function updateAppointmentMonthCardVisibility() {}
    function refreshWhatsAppTemplatePickerAnchor() {}
    function syncNavMountLocation() {
      const nav = document.getElementById('app-primary-nav');
      const parent = document.getElementById(innerWidth < 1024 ? 'app-shell' : 'app-header-inner');
      if (nav.parentElement !== parent) parent.appendChild(nav);
    }
    ${helpers}
    document.getElementById('auth-gate').remove();
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    document.getElementById('app-shell').classList.remove('hidden');
    const mockViewport = new EventTarget();
    Object.assign(mockViewport, { width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: mockViewport });
    window.testViewport = mockViewport;
    window.showTestView = view => {
      document.querySelectorAll('#app-main > section, #app-main > div').forEach(el => el.classList.add('hidden'));
      document.getElementById('view-' + view).classList.remove('hidden');
      for (const [name, className] of Object.entries({ patients: 'patient-query-active', appointments: 'appointments-calendar-active', dashboard: 'dashboard-active' })) {
        document.documentElement.classList.toggle(className, name === view);
        document.body.classList.toggle(className, name === view);
      }
      syncNavMountLocation();
      updateAppViewportDimensions();
      updatePatientQueryViewportHeight();
      updateAppointmentCalendarViewportHeight();
      updateDashboardViewportHeight();
    };
    document.getElementById('patients-table-body').innerHTML = Array.from({length: 30}, (_, i) => '<tr><td colspan="4" style="height:72px">Test patient ' + i + '</td></tr>').join('');
    document.getElementById('appointments-month-view').classList.add('hidden');
    document.getElementById('appointments-day-view').classList.remove('hidden');
    document.getElementById('appointments-day-timeline').style.height = '2400px';
    setupAppViewportDimensions();
  ` });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const panelBounds = () => page.evaluate(() => {
    const active = ['patients', 'appointments', 'dashboard'].find(view => !document.getElementById('view-' + view).classList.contains('hidden'));
    const panel = document.getElementById({ patients: 'patient-query-results-scroll', appointments: 'appointments-day-timeline-scroll', dashboard: 'view-dashboard' }[active]);
    const rect = panel.getBoundingClientRect();
    return { height: rect.height, bottom: rect.bottom, windowHeight: innerHeight, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight };
  });

  await t.test('landscape content stays full height after a stale keyboard-sized reading', async () => {
    for (const dir of ['ltr', 'rtl']) for (const scale of [85, 100, 125]) for (const view of ['patients', 'appointments', 'dashboard']) {
      await page.evaluate(({ dir, scale, view }) => {
        document.documentElement.dir = dir;
        document.documentElement.classList.toggle('lumin-app-scaled', scale !== 100);
        document.documentElement.style.setProperty('--lumin-app-scale', String(scale / 100));
        document.body.classList.add('lumin-raised');
        testViewport.height = innerHeight;
        showTestView(view);
      }, { dir, scale, view });
      await settle();
      const before = await panelBounds();
      await page.evaluate(() => { testViewport.height = 220; testViewport.dispatchEvent(new Event('resize')); });
      await settle();
      const after = await panelBounds();
      assert.ok(Math.abs(after.height - before.height) <= 2, `${view} ${scale}% ${dir}: stale viewport collapsed ${before.height}px to ${after.height}px`);
      assert.ok(after.height > 400, `${view}: content remains usable`);
      assert.ok(after.bottom <= after.windowHeight + 1, `${view}: panel stays on screen`);
      if (view !== 'dashboard') assert.ok(after.scrollHeight > after.clientHeight, `${view}: content scrolls inside its panel`);
    }
  });

  await t.test('keyboard focus still uses the reduced viewport and blur restores content', async () => {
    await page.evaluate(() => {
      document.documentElement.classList.remove('lumin-app-scaled');
      testViewport.height = innerHeight;
      showTestView('patients');
      document.getElementById('patient-query-input').focus();
      testViewport.height = 480;
      testViewport.dispatchEvent(new Event('resize'));
    });
    await settle();
    const keyboard = await panelBounds();
    assert.ok(keyboard.height > 44 && keyboard.bottom <= 481, 'patient search stays above the actual keyboard');
    await page.evaluate(() => document.activeElement.blur());
    await settle();
    const dismissed = await panelBounds();
    assert.ok(dismissed.height > keyboard.height + 300, 'blur recovers even if visualViewport stays stale and emits no resize');
  });

  await t.test('portrait, landscape, and rotation preserve the scroll areas in both languages', async () => {
    for (const size of [{ width: 820, height: 1180 }, { width: 1024, height: 768 }, { width: 1408, height: 970 }]) {
      await page.setViewportSize(size);
      for (const dir of ['ltr', 'rtl']) for (const scale of [85, 125]) for (const view of ['patients', 'appointments']) {
        await page.evaluate(({ dir, scale, view }) => {
          document.documentElement.dir = dir;
          document.documentElement.classList.add('lumin-app-scaled');
          document.documentElement.style.setProperty('--lumin-app-scale', String(scale / 100));
          Object.assign(testViewport, { width: innerWidth, height: innerHeight, offsetTop: 0 });
          showTestView(view);
        }, { dir, scale, view });
        await settle();
        const before = await panelBounds();
        await page.evaluate(() => {
          // Simulate the previous orientation/keyboard rectangle surviving an app resume.
          Object.assign(testViewport, { height: 220, offsetTop: 50 });
          window.dispatchEvent(new Event('pageshow'));
        });
        await settle();
        const after = await panelBounds();
        assert.ok(Math.abs(after.height - before.height) <= 2, `${view} ${size.width}px ${dir} ${scale}% recovers`);
        assert.ok(after.height > 100 && after.bottom <= size.height + 1, 'scroll area remains visible inside the screen');
      }
    }
  });

  await t.test('missing, zero, and invalid viewport values fall back to usable window bounds', async () => {
    await page.evaluate(() => {
      document.documentElement.classList.remove('lumin-app-scaled');
      Object.assign(testViewport, { width: innerWidth, height: innerHeight, offsetTop: 0 });
      showTestView('patients');
    });
    const before = await panelBounds();
    for (const value of [null, { height: 0 }, { height: NaN }, { height: Infinity }, { height: 970, offsetTop: NaN }]) {
      await page.evaluate(value => {
        Object.defineProperty(window, 'visualViewport', { configurable: true, value });
        updateAppViewportDimensions();
        updatePatientQueryViewportHeight();
      }, value);
      const after = await panelBounds();
      assert.ok(Math.abs(after.height - before.height) <= 2, 'invalid metrics cannot collapse patient results');
    }
    await page.evaluate(() => Object.defineProperty(window, 'visualViewport', { configurable: true, value: testViewport }));
  });

  await t.test('foreground and rotation settling remeasure without a second browser event', async () => {
    for (const eventName of ['pageshow', 'orientationchange', 'visibilitychange']) {
      await page.evaluate(eventName => {
        testViewport.height = innerHeight;
        showTestView('appointments');
        const target = eventName === 'visibilitychange' ? document : window;
        target.dispatchEvent(new Event(eventName));
        // WebKit can update its dimensions after the first event/animation frames.
        setTimeout(() => { testViewport.height = innerHeight - 60; }, 120);
      }, eventName);
      await page.waitForTimeout(800);
      const after = await panelBounds();
      assert.ok(after.height > 400, eventName + ': calendar remains usable');
      assert.ok(after.bottom <= after.windowHeight - 60, eventName + ': late browser chrome measurement is applied');
    }
  });
  assert.deepEqual(errors, []);
});
