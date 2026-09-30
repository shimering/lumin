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
const viewportHelpers = source.slice(source.indexOf('    function updateAppViewportDimensions('), source.indexOf('    function refreshAppointmentCurrentTimeLine('));
const themeHelper = source.slice(source.indexOf('    function applyUiTheme('), source.indexOf('    function resetUiTheme('));
const directoryHelpers = source.slice(source.indexOf('    function renderPatientQueryPagination('), source.indexOf('    async function deletePatient('));
const phoneHelper = source.slice(source.indexOf('    function patientPhoneActionsMarkup('), source.indexOf('    function openPatientProfileWhatsApp('));
const navHelper = source.slice(source.indexOf('    let mobileNavigation = null;'), source.indexOf("    window.addEventListener('resize', syncNavMountLocation"));
const closeHeaderHelper = source.slice(source.indexOf('    function closeMobileHeaderOverlay('), source.indexOf('    function toggleMobileHeaderOverlay('));
const routingHelper = source.slice(source.indexOf('    async function switchView('), source.indexOf('    async function openPatientChart('));
const patientsSource = fs.readFileSync(path.join(root, 'lumin-patients.js'), 'utf8');
const patientsTabHelpers = patientsSource.slice(patientsSource.indexOf('function canOpenPatientsPage('), patientsSource.indexOf('function handlePatientsTabKeydown('));
const appScales = Array.from({ length: 10 }, (_, i) => 80 + i * 5);

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
    res.setHeader('Content-Type', target.endsWith('.css') ? 'text/css' : target.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addScriptTag({ url: `http://127.0.0.1:${server.address().port}/vendor/lucide.min.js` });
  await page.addScriptTag({ url: `http://127.0.0.1:${server.address().port}/lumin-mobile-nav.js?v=1` });
  await page.addScriptTag({ content: `
    let appointmentCalendarResizeFrame = null, patientQueryResizeFrame = null, dashboardResizeFrame = null;
    let currentUiTheme = 'flat', currentUiTint = 'blue', currentUiScale = 100;
    let mobileHeaderOverlayOpen = false;
    let activePatientsTab = 'browse';
    const patientWorkspaceSwipe = null;
    const UI_SCALE_DEFAULT = 100;
    let currentUiLanguage = 'en';
    const PATIENT_QUERY_PAGE_SIZE = 10;
    let patientQueryPage = 1, patientQuerySignature = '';
    const patientsLoaded = true, patientDirectoryLoaded = true, patientDirectoryTotal = 20;
    const patients = Array.from({ length: 20 }, (_, i) => ({ id: 'test-' + i, patientNumber: 2500 + i,
      name: 'Test patient with a long name — مريض تجريبي باسم طويل '.repeat(3), phone: '01000000000', secondaryPhone: '01100000000' }));
    const patientDirectoryRows = patients;
    function hasPageAccess(view) { return !['prices', 'admin'].includes(view); }
    function closeWhatsAppTemplatePicker() {}
    function closeQuickCreateMenu() { document.getElementById('nav-btn-quick-create').setAttribute('aria-expanded', 'false'); }
    function toggleQuickCreateMenu() { window.quickCreateClicks = (window.quickCreateClicks || 0) + 1; document.getElementById('nav-btn-quick-create').setAttribute('aria-expanded', 'true'); }
    function openAppointmentsView() { window.appointmentsClicks = (window.appointmentsClicks || 0) + 1; }
    async function ensurePatientDirectoryPageLoaded() {}
    function resetPatientAppointmentsState() {}
    function resetPatientPrescriptionsState() {}
    function refreshUiThemePreference() {}
    async function loadGoogleCalendarSettings() {}
    function populateStorageServerSettingsInputs() {}
    function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'); }
    function formatPatientNumber(patient) { return '#' + patient.patientNumber; }
    function patientProfilePhoneContext(id) { return { rawPhone: patients.find(patient => patient.id === id).phone }; }
    function normaliseCallPhone(value) { return value; }
    function normaliseWhatsAppPhone(value) { return value; }
    function normaliseUiTint(value) { return value; }
    function normaliseUiScale(value) { return Number(value); }
    function syncUiThemeToggle() {}
    function updateAppointmentMonthCardVisibility() {}
    ${viewportHelpers}
    ${themeHelper}
    ${directoryHelpers}
    ${phoneHelper}
    ${navHelper}
    ${closeHeaderHelper}
    ${patientsTabHelpers}
    ${routingHelper}
    setupMobileNavigation();
    setupAppViewportDimensions();
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
      currentUiLanguage = dir === 'rtl' ? 'ar' : 'en';
      for (const name of ['patient-query-active', 'appointments-calendar-active', 'whatsapp-view-active', 'dashboard-active', 'whatsapp-mobile-chat-open', 'whatsapp-keyboard-open']) {
        root.classList.remove(name); document.body.classList.remove(name);
      }
      document.getElementById('auth-gate').classList.add('hidden');
      const shell = document.getElementById('app-shell'); shell.classList.remove('hidden');
      syncNavMountLocation();
      document.querySelectorAll('#app-main > section, #app-main > div').forEach(el => el.classList.add('hidden'));
      document.getElementById('view-' + (view === 'patient-prescriptions' ? 'prescriptions' : view)).classList.remove('hidden');
      document.querySelectorAll('#app-primary-nav > button[id]').forEach(button => {
        if (button.id === 'nav-btn-' + view) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
      const active = { patients: 'patient-query-active', appointments: 'appointments-calendar-active', whatsapp: 'whatsapp-view-active' }[view];
      if (active) { root.classList.add(active); document.body.classList.add(active); }
      applyUiTheme(theme, 'violet', scale);
      if (view === 'patients') { runPatientQuery(); schedulePatientQueryViewportUpdate(); }
      if (view === 'appointments') scheduleAppointmentCalendarViewportUpdate();
      if (view === 'whatsapp') scheduleWhatsAppMobileViewportUpdate();
    }, { view, scale, theme, dir });
    await settle();
  }

  async function bounds(view) {
    return page.evaluate(view => {
      const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
      const phone = window.LuminMobileNav.isPhone();
      const nav = document.getElementById(phone ? 'lumin-mobile-nav' : 'app-primary-nav');
      return {
        viewport: window.visualViewport?.height || innerHeight,
        viewportWidth: window.visualViewport?.width || innerWidth,
        page: rect(document.getElementById('view-' + (view === 'patient-prescriptions' ? 'prescriptions' : view))),
        phone,
        nav: rect(nav),
        navButtons: Array.from(nav.querySelectorAll(phone ? '.lumin-mobile-nav-bar > button' : ':scope > button')).filter(button => getComputedStyle(button).display !== 'none').map(button => {
          const r = button.getBoundingClientRect();
          return { id: button.id, width: r.width, height: r.height, hit: button.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };
        }),
        ancestors: ['app-main', 'app-shell'].map(id => rect(document.getElementById(id))).concat(rect(document.body), rect(document.documentElement))
      };
    }, view);
  }

  function assertFits(result, description) {
    assert.ok(result.page.height > 0, description + ': page is visible');
    assert.ok(result.navButtons.length > 0, description + ': navigation has controls');
    for (const button of result.navButtons) {
      assert.ok(button.hit, description + ': ' + button.id + ' is visible and tappable');
      if (result.phone) assert.ok(button.width >= 43.9 && button.height >= 43.9, description + ': ' + button.id + ' has a 44px touch target');
    }
    assert.ok(result.nav.left >= 0 && result.nav.right <= result.viewportWidth + 1 && result.nav.bottom <= result.viewport + 1, description + ': dock fits the visible viewport');
    assert.ok(result.nav.top - result.page.bottom >= 7 && result.nav.top - result.page.bottom <= 10, description + ': content reaches the navigation dock');
    for (const rect of result.ancestors) {
      assert.ok(rect.bottom >= result.page.bottom - 1, description + ': no ancestor clips the content');
      assert.ok(Math.abs(rect.height - result.viewport) <= 1, description + ': container fills the actual screen height');
    }
  }

  await t.test('phone and tablet layouts fit in English and Arabic, in both themes', async () => {
    for (const size of [{ width: 320, height: 568 }, { width: 360, height: 640 }, { width: 390, height: 844 }, { width: 412, height: 915 }, { width: 412, height: 780 }, { width: 844, height: 390 }, { width: 820, height: 1180 }]) {
      await page.setViewportSize(size);
      for (const dir of ['ltr', 'rtl']) for (const theme of ['flat', 'raised']) for (const scale of appScales) for (const view of ['patients', 'appointments', 'whatsapp']) {
        await showView(view, scale, theme, dir);
        assertFits(await bounds(view), `${view} ${size.width}×${size.height} ${scale}% ${theme} ${dir}`);
      }
    }
  });

  await t.test('real Patients page entry refreshes stale frame sizing without minimizing the app at every scale', async () => {
    await page.setViewportSize({ width: 384, height: 781 });
    for (const dir of ['ltr', 'rtl']) for (const theme of ['flat', 'raised']) for (const scale of appScales) {
      await showView('whatsapp', scale, theme, dir);
      await page.evaluate(async () => {
        await switchView('settings');
        const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
        // The entry frame still has the earlier app height; no resize/resume event occurs.
        document.documentElement.style.setProperty('--lumin-app-viewport-height', (innerHeight + 220) / zoom + 'px');
        await switchView('patients');
      });
      await settle();
      const result = await bounds('patients');
      assert.ok(result.nav.top >= 0 && result.nav.bottom <= result.viewport, `navigation is on screen immediately at ${scale}% ${dir} ${theme}`);
      assertFits(result, `real Patients entry ${scale}% ${dir} ${theme}`);
    }
  });

  await t.test('Patients entry rechecks viewport sizing after the first render frame', async () => {
    await page.setViewportSize({ width: 384, height: 781 });
    await showView('whatsapp', 85);
    await page.evaluate(async () => {
      await switchView('settings');
      window.originalVisualViewport = window.visualViewport;
      const delayedViewport = { width: innerWidth, height: innerHeight + 220, offsetTop: 0, offsetLeft: 0 };
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: delayedViewport });
      updateAppViewportDimensions();
      await switchView('patients');
      // Model a visible height that settles after the first page-entry frame.
      requestAnimationFrame(() => { delayedViewport.height = innerHeight; });
    });
    try {
      await settle();
      const result = await bounds('patients');
      assert.ok(result.nav.bottom <= result.viewport, 'dock appears without needing an app-resume event');
      assertFits(result, 'Patients entry after delayed viewport measurement');
    } finally {
      await page.evaluate(() => {
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.originalVisualViewport });
        updateAppViewportDimensions();
      });
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

  await t.test('85% standalone layout keeps the dock inside a smaller visible viewport', async () => {
    await page.setViewportSize({ width: 412, height: 915 });
    await showView('patients', 85);
    await page.evaluate(() => {
      window.originalVisualViewport = window.visualViewport;
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: { width: 384, height: 844, offsetTop: 0, offsetLeft: 0 } });
      updateAppViewportDimensions();
      updatePatientQueryViewportHeight();
    });
    try {
      const result = await bounds('patients');
      assert.ok(result.nav.bottom <= result.viewport, 'dock stays above the visible screen bottom');
      assert.ok(result.nav.left >= 0 && result.nav.right <= result.viewportWidth, 'dock stays inside the visible screen width');
      assertFits(result, '85% with smaller visible viewport');
    } finally {
      await page.evaluate(() => Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.originalVisualViewport }));
      await page.evaluate(() => updateAppViewportDimensions());
    }
  });

  await t.test('85% patient results scroll inside their panel without moving the outer page or dock', async () => {
    await page.setViewportSize({ width: 412, height: 915 });
    for (const dir of ['ltr', 'rtl']) {
      await showView('patients', 85, 'raised', dir);
      await page.evaluate(() => {
        const scroll = document.getElementById('patient-query-results-scroll');
        const nav = document.getElementById('lumin-mobile-nav');
        const navBottom = nav.getBoundingClientRect().bottom;
        const horizontalEnd = document.documentElement.dir === 'rtl' ? -100000 : 100000;
        window.scrollTo(horizontalEnd, 100000);
        scroll.scrollTop = 100000;
        scroll.scrollLeft = horizontalEnd;
        window.testNavBottom = navBottom;
      });
      await settle();
      const result = await page.evaluate(() => {
        const scroll = document.getElementById('patient-query-results-scroll');
        return { x: window.scrollX, y: window.scrollY, resultsX: scroll.scrollLeft, resultsY: scroll.scrollTop,
          navBottom: window.testNavBottom, afterNavBottom: document.getElementById('lumin-mobile-nav').getBoundingClientRect().bottom,
          pageRight: document.getElementById('view-patients').getBoundingClientRect().right,
          viewportWidth: window.visualViewport.width };
      });
      assert.equal(result.x, 0, dir + ': outer page does not scroll sideways');
      assert.equal(result.y, 0, dir + ': outer page does not scroll below the viewport');
      assert.ok(result.resultsY > 0 && Math.abs(result.resultsX) > 0, dir + ': table still scrolls in both directions');
      assert.equal(result.navBottom, result.afterNavBottom, dir + ': navigation stays anchored');
      assert.ok(result.pageRight <= result.viewportWidth, dir + ': long names do not widen the page');
    }
  });

  await t.test('85% patient dock remains tappable when innerHeight reports the visible viewport', async () => {
    await page.setViewportSize({ width: 412, height: 915 });
    await showView('patients', 85);
    await page.evaluate(() => {
      window.originalVisualViewport = window.visualViewport;
      window.originalInnerHeightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight');
      // Keep the CSS layout viewport tall while both JS height APIs report the smaller visible area.
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: { width: 412, height: 844, offsetTop: 0, offsetLeft: 0 } });
      updateAppViewportDimensions();
      updatePatientQueryViewportHeight();
    });
    try {
      const result = await bounds('patients');
      assert.ok(result.nav.top > 0 && result.nav.bottom <= result.viewport, 'Patients navigation stays inside the visible screen');
      assertFits(result, '85% with different CSS and JS viewport heights');
    } finally {
      await page.evaluate(() => {
        Object.defineProperty(window, 'innerHeight', window.originalInnerHeightDescriptor);
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.originalVisualViewport });
        updateAppViewportDimensions();
      });
      await showView('patients', 85);
    }
  });

  await t.test('chat fits the visible keyboard viewport at reduced and enlarged scales', async () => {
    for (const scale of [80, 85, 100, 125]) {
      await showView('whatsapp', scale);
      await page.evaluate(() => {
        window.originalVisualViewport = window.visualViewport;
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: { height: 480, offsetTop: 0 } });
        document.body.classList.add('whatsapp-mobile-chat-open');
        updateWhatsAppMobileViewport();
      });
      await settle();
      const result = await page.evaluate(() => ({
        bottom: document.getElementById('view-whatsapp').getBoundingClientRect().bottom,
        composerBottom: document.getElementById('whatsapp-reply-panel').getBoundingClientRect().bottom,
        navDisplay: getComputedStyle(document.getElementById('lumin-mobile-nav')).display
      }));
      assert.ok(Math.abs(result.bottom - 480) < 2, `chat fills keyboard viewport at ${scale}%`);
      assert.ok(result.composerBottom <= 481, `composer remains visible at ${scale}%`);
      assert.equal(result.navDisplay, 'none');
      await page.evaluate(() => Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.originalVisualViewport }));
      await showView('whatsapp', scale);
      assertFits(await bounds('whatsapp'), 'WhatsApp after keyboard dismissal');
    }
  });

  await t.test('the same phone dock remains tappable on every main page and patient workspace', async () => {
    await page.setViewportSize({ width: 320, height: 568 });
    for (const dir of ['ltr', 'rtl']) for (const scale of [80, 100, 125]) {
      for (const view of ['dashboard', 'patients', 'appointments', 'whatsapp', 'clinic-management', 'prices', 'admin', 'settings', 'patient-profile', 'chart', 'invoices', 'patient-media', 'payments', 'loyalty', 'patient-appointments', 'patient-prescriptions']) {
        await showView(view, scale, 'raised', dir);
        const result = await bounds(view);
        assert.ok(result.nav.height > 0 && result.nav.bottom <= result.viewport + 1, view + ': dock is visible');
        assert.ok(result.nav.left >= 0 && result.nav.right <= result.viewportWidth + 1, view + ': dock fits');
        for (const button of result.navButtons) {
          assert.ok(button.hit && button.width >= 43.9 && button.height >= 43.9, view + ': ' + button.id + ' is tappable');
        }
      }
    }
  });

  await t.test('More respects permissions, routes to Settings, and preserves quick actions and unread counts', async () => {
    await page.setViewportSize({ width: 320, height: 568 });
    for (const dir of ['ltr', 'rtl']) for (const scale of [80, 125]) {
      await showView('patients', scale, 'raised', dir);
      await page.evaluate(() => {
        for (const view of ['clinic-management', 'prices', 'admin']) document.getElementById('nav-btn-' + view).classList.remove('hidden');
        const badge = document.getElementById('nav-whatsapp-unread-badge');
        badge.textContent = '12'; badge.classList.remove('hidden');
      });
      await settle();
      assert.equal(await page.locator('#mobile-nav-whatsapp .lumin-mobile-nav-badge').textContent(), '12');
      await page.locator('#mobile-nav-more').click();
      const menu = await page.locator('#lumin-mobile-nav-more').boundingBox();
      assert.ok(menu.x >= 0 && menu.y >= 0 && menu.x + menu.width <= 321, 'More stays on screen');
      assert.equal(await page.locator('#lumin-mobile-nav-more > button').count(), 4);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#mobile-nav-more').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'mobile-nav-more');
      await page.locator('#mobile-nav-more').click();
      await page.locator('#mobile-nav-settings').click();
      await settle();
      assert.equal(await page.locator('#view-settings').isVisible(), true);
      assert.equal(await page.locator('#mobile-nav-more').getAttribute('aria-current'), 'page');
      assert.equal(await page.locator('#lumin-mobile-nav-more').isVisible(), false);
      await page.locator('#mobile-nav-new').click();
      await settle();
      assert.equal(await page.locator('#mobile-nav-new').getAttribute('aria-expanded'), 'true');
      await page.locator('#mobile-nav-appointments').click();
      assert.ok(await page.evaluate(() => window.appointmentsClicks > 0), 'appointments retains its existing entry handler');
      await page.evaluate(() => {
        for (const view of ['clinic-management', 'prices', 'admin']) document.getElementById('nav-btn-' + view).classList.add('hidden');
        document.getElementById('nav-whatsapp-unread-badge').classList.add('hidden');
        closeQuickCreateMenu();
      });
      await settle();
      await page.locator('#mobile-nav-more').click();
      assert.equal(await page.locator('#lumin-mobile-nav-more > button').count(), 1, 'restricted role sees Settings only');
      await page.keyboard.press('Escape');
    }
    assert.ok(await page.evaluate(() => window.quickCreateClicks > 0), 'New opens the existing quick actions');
  });

  await t.test('phone landscape retains the new dock while iPad and desktop keep the existing rail', async () => {
    await page.evaluate(() => {
      window.originalUserAgent = navigator.userAgent;
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Linux; Android 16) SamsungBrowser Mobile' });
    });
    await page.setViewportSize({ width: 844, height: 390 });
    await showView('patients', 85);
    assertFits(await bounds('patients'), 'Android phone landscape');
    assert.equal(await page.locator('#app-primary-nav').isVisible(), false);
    await page.evaluate(() => Object.defineProperty(navigator, 'userAgent', { configurable: true, value: window.originalUserAgent }));
    for (const size of [{ width: 768, height: 1024 }, { width: 820, height: 1180 }, { width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(size);
      await showView('settings', 100);
      assert.equal(await page.locator('#lumin-mobile-nav').isVisible(), false, 'phone dock hidden at ' + size.width);
      assert.equal(await page.locator('#app-primary-nav').isVisible(), true, 'existing nav preserved at ' + size.width);
      assert.equal(await page.locator('#app-primary-nav').evaluate(el => el.parentElement.id), size.width < 1024 ? 'app-shell' : 'app-header-inner');
    }
    await page.setViewportSize({ width: 744, height: 1133 });
    await page.evaluate(() => Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' }));
    await showView('settings', 100);
    assert.equal(await page.locator('#lumin-mobile-nav').isVisible(), false, 'iPad mini keeps tablet navigation even below 768px');
    assert.equal(await page.locator('#app-primary-nav').isVisible(), true);
    await page.evaluate(() => Object.defineProperty(navigator, 'userAgent', { configurable: true, value: window.originalUserAgent }));
  });

  await t.test('phone dock hides with the keyboard on Patients and returns after dismissal; auth hides it', async () => {
    await page.setViewportSize({ width: 384, height: 781 });
    await showView('patients', 85);
    await page.evaluate(() => {
      window.originalVisualViewport = window.visualViewport;
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: { width: 384, height: 480, offsetTop: 0, offsetLeft: 0 } });
      document.getElementById('patient-query-input').focus();
      mobileNavigation.refresh();
    });
    assert.equal(await page.locator('#lumin-mobile-nav').isVisible(), false, 'keyboard has the available screen space');
    await page.evaluate(() => {
      document.activeElement.blur();
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.originalVisualViewport });
      mobileNavigation.refresh();
      document.body.classList.remove('lumin-mobile-keyboard-open');
      schedulePatientQueryViewportUpdate();
    });
    await settle();
    assertFits(await bounds('patients'), 'Patients after keyboard dismissal');
    await page.evaluate(() => document.getElementById('app-shell').classList.add('hidden'));
    await settle();
    assert.equal(await page.locator('#lumin-mobile-nav').isVisible(), false, 'no navigation on sign in');
    await showView('patients', 100);
  });

  await t.test('glass dock respects safe areas, dark mode, and keyboards that also shrink innerHeight', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await showView('patients', 125);
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
      const nav = document.getElementById('lumin-mobile-nav');
      nav.style.setProperty('--nav-safe-bottom', '34px');
      nav.style.setProperty('--nav-safe-left', '20px');
      nav.style.setProperty('--nav-safe-right', '20px');
      mobileNavigation.refresh();
    });
    await settle();
    const safe = await bounds('patients');
    assert.ok(safe.nav.bottom <= 811 && safe.nav.left >= 19 && safe.nav.right <= 371, 'dock clears home indicator and side insets');
    assertFits(safe, 'dark dock with safe areas');
    const glass = await page.locator('.lumin-mobile-nav-bar').evaluate(el => ({ background: getComputedStyle(el).backgroundColor, blur: getComputedStyle(el).backdropFilter }));
    assert.match(glass.background, /rgba\(15, 23, 42,/);
    assert.match(glass.blur, /blur\(24px\)/);
    await page.waitForFunction(() => getComputedStyle(document.getElementById('mobile-nav-patients')).color === 'rgb(147, 197, 253)', null, { timeout: 2000 });
    const activeColor = await page.locator('#mobile-nav-patients').evaluate(el => ({ color: getComputedStyle(el).color, current: el.getAttribute('aria-current'), root: document.documentElement.className, focus: document.activeElement.id }));
    assert.equal(activeColor.color, 'rgb(147, 197, 253)', 'active dock text remains readable in raised dark mode: ' + JSON.stringify(activeColor));
    await page.evaluate(() => {
      document.getElementById('patient-query-input').focus();
      window.originalInnerHeightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight');
      window.originalVisualViewport = window.visualViewport;
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 480 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: { width: 390, height: 480, offsetTop: 0, offsetLeft: 0 } });
      mobileNavigation.refresh();
    });
    assert.equal(await page.locator('#lumin-mobile-nav').isVisible(), false);
    await page.evaluate(() => {
      Object.defineProperty(window, 'innerHeight', window.originalInnerHeightDescriptor);
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.originalVisualViewport });
      document.activeElement.blur();
      document.documentElement.classList.remove('dark');
      const nav = document.getElementById('lumin-mobile-nav');
      for (const property of ['--nav-safe-bottom', '--nav-safe-left', '--nav-safe-right']) nav.style.removeProperty(property);
      mobileNavigation.refresh();
    });
    await showView('patients', 100);
  });

  if (process.env.LUMIN_NAV_SCREENSHOT) {
    await page.setViewportSize({ width: 390, height: 844 });
    await showView('patients', 100);
    await page.screenshot({ path: process.env.LUMIN_NAV_SCREENSHOT });
  }
  assert.deepEqual(errors, [], 'layout helpers do not throw in the browser');
});
