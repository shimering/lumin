const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

// Optional browser regression: provide Playwright in NODE_PATH and, for a system
// browser, set LUMIN_TEST_BROWSER_CHANNEL=chrome (or msedge).
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) { /* Browser tests are optional. */ }

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
// Exercise the real markup, CSS, and layout helpers without connecting to clinic data.
const fixture = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const viewportHelpers = source.slice(source.indexOf('    function mobileViewContentBottom('), source.indexOf('    function refreshAppointmentCurrentTimeLine('));
const themeHelper = source.slice(source.indexOf('    function applyUiTheme('), source.indexOf('    function resetUiTheme('));

test('mobile screens fill the available height at every app scale', { skip: !chromium && 'Playwright is not available' }, async t => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(fixture);
      return;
    }
    const target = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.statusCode = 404; res.end(); return;
    }
    res.setHeader('Content-Type', target.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addScriptTag({ content: `
    let appointmentCalendarResizeFrame = null, patientQueryResizeFrame = null, dashboardResizeFrame = null;
    let currentUiTheme = 'flat', currentUiTint = 'blue', currentUiScale = 100;
    const UI_SCALE_DEFAULT = 100;
    function normaliseUiTint(value) { return value; }
    function normaliseUiScale(value) { return Number(value); }
    function syncUiThemeToggle() {}
    function updateAppointmentMonthCardVisibility() {}
    ${viewportHelpers}
    ${themeHelper}
    setupAppointmentCalendarViewport();
    setupPatientQueryViewport();
    setupDashboardViewport();
    setupWhatsAppMobileViewport();
  ` });

  async function settle() {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }

  async function showView(view, scale, theme = 'raised', dir = 'ltr') {
    await page.evaluate(({ view, scale, theme, dir }) => {
      const root = document.documentElement;
      root.dir = dir;
      for (const name of ['patient-query-active', 'appointments-calendar-active', 'whatsapp-view-active', 'dashboard-active', 'whatsapp-mobile-chat-open', 'whatsapp-keyboard-open']) {
        root.classList.remove(name); document.body.classList.remove(name);
      }
      document.getElementById('auth-gate').classList.add('hidden');
      const shell = document.getElementById('app-shell'); shell.classList.remove('hidden');
      shell.appendChild(document.getElementById('app-primary-nav'));
      document.querySelectorAll('#app-main > section, #app-main > div').forEach(el => el.classList.add('hidden'));
      document.getElementById('view-' + view).classList.remove('hidden');
      const active = { patients: 'patient-query-active', appointments: 'appointments-calendar-active', whatsapp: 'whatsapp-view-active' }[view];
      if (active) { root.classList.add(active); document.body.classList.add(active); }
      applyUiTheme(theme, 'violet', scale);
      if (view === 'patients') schedulePatientQueryViewportUpdate();
      if (view === 'appointments') scheduleAppointmentCalendarViewportUpdate();
      if (view === 'whatsapp') scheduleWhatsAppMobileViewportUpdate();
    }, { view, scale, theme, dir });
    await settle();
  }

  async function bounds(view) {
    return page.evaluate(view => {
      const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
      return {
        viewport: innerHeight,
        page: rect(document.getElementById('view-' + view)),
        nav: rect(document.getElementById('app-primary-nav')),
        ancestors: ['app-main', 'app-shell'].map(id => rect(document.getElementById(id))).concat(rect(document.body), rect(document.documentElement))
      };
    }, view);
  }

  function assertFits(result, description) {
    assert.ok(result.page.height > 0, description + ': page is visible');
    assert.ok(result.nav.top - result.page.bottom >= 7 && result.nav.top - result.page.bottom <= 10, description + ': content reaches the navigation dock');
    for (const rect of result.ancestors) {
      assert.ok(rect.bottom >= result.page.bottom - 1, description + ': no ancestor clips the content');
      assert.ok(Math.abs(rect.height - result.viewport) <= 1, description + ': container fills the actual screen height');
    }
  }

  await t.test('phone and tablet layouts fit in English and Arabic, in both themes', async () => {
    for (const size of [{ width: 360, height: 640 }, { width: 390, height: 844 }, { width: 412, height: 915 }, { width: 412, height: 780 }, { width: 844, height: 390 }, { width: 820, height: 1180 }]) {
      await page.setViewportSize(size);
      for (const dir of ['ltr', 'rtl']) for (const theme of ['flat', 'raised']) for (const scale of [80, 100, 125]) for (const view of ['patients', 'appointments', 'whatsapp']) {
        await showView(view, scale, theme, dir);
        assertFits(await bounds(view), `${view} ${size.width}×${size.height} ${scale}% ${theme} ${dir}`);
      }
    }
  });

  await t.test('window resizing updates the active view without a navigation action', async () => {
    for (const view of ['patients', 'appointments', 'whatsapp']) {
      await page.setViewportSize({ width: 412, height: 915 });
      await showView(view, 80);
      await page.setViewportSize({ width: 412, height: 720 });
      await settle();
      assertFits(await bounds(view), view + ' after resize');
    }
  });

  await t.test('changing app scale recalculates WhatsApp without switching pages', async () => {
    await page.setViewportSize({ width: 412, height: 915 });
    await showView('whatsapp', 100);
    await page.evaluate(() => applyUiTheme('raised', 'violet', 80));
    await settle();
    assertFits(await bounds('whatsapp'), 'WhatsApp after changing scale');
  });

  await t.test('chat fits the visible keyboard viewport at reduced and enlarged scales', async () => {
    for (const scale of [80, 100, 125]) {
      await showView('whatsapp', scale);
      await page.evaluate(() => {
        window.originalVisualViewport = window.visualViewport;
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: { height: 480, offsetTop: 0 } });
        document.body.classList.add('whatsapp-mobile-chat-open');
        updateWhatsAppMobileViewport();
      });
      const result = await page.evaluate(() => ({
        bottom: document.getElementById('view-whatsapp').getBoundingClientRect().bottom,
        composerBottom: document.getElementById('whatsapp-reply-panel').getBoundingClientRect().bottom,
        navDisplay: getComputedStyle(document.getElementById('app-primary-nav')).display
      }));
      assert.ok(Math.abs(result.bottom - 480) < 2, `chat fills keyboard viewport at ${scale}%`);
      assert.ok(result.composerBottom <= 481, `composer remains visible at ${scale}%`);
      assert.equal(result.navDisplay, 'none');
      await page.evaluate(() => Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.originalVisualViewport }));
      await showView('whatsapp', scale);
      assertFits(await bounds('whatsapp'), 'WhatsApp after keyboard dismissal');
    }
  });
  assert.deepEqual(errors, [], 'layout helpers do not throw in the browser');
});
