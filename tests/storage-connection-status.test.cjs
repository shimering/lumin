const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const setupStart = source.indexOf('    function setupStorageConnectionMonitor(');
const setupEnd = source.slice(setupStart).match(/\r?\n    }\r?\n/);
assert.ok(setupEnd, 'storage monitor setup has a complete function body');
const helpers = source.slice(source.indexOf("    let clinicStorageServerUrl = '';"), setupStart + setupEnd.index + setupEnd[0].length);
const healthy = { status: 'online', service: 'Lumin Local Storage Server', totalPatientFolders: 3, storageRoot: 'Test storage' };
const response = (data = healthy, status = 200) => ({ ok: status === 200, status, json: async () => data });
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  let timerId = 0;
  const timeouts = new Map(), intervals = new Map(), requests = [];
  const windowListeners = new Map(), documentListeners = new Map();
  const values = new Map([['lumin_storage_server_url', 'https://storage.test'], ['lumin_storage_secret_key', 'test-key']]);
  const text = { textContent: '' };
  const badge = { dataset: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, querySelector: () => text };
  const settingsBadge = { className: '', textContent: '' };
  const ctx = vm.createContext({
    AbortController, currentUiLanguage: 'en',
    navigator: { onLine: true },
    localStorage: { getItem: key => values.get(key) || null },
    document: {
      visibilityState: 'visible',
      querySelectorAll: selector => selector === '[data-storage-connection-badge]' ? [badge] : [],
      getElementById: () => settingsBadge,
      addEventListener: (name, listener) => documentListeners.set(name, listener)
    },
    window: { addEventListener: (name, listener) => windowListeners.set(name, listener) },
    setTimeout: (fn, delay) => { timeouts.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: id => timeouts.delete(id),
    setInterval: (fn, delay) => { intervals.set(++timerId, { fn, delay }); return timerId; },
    clearInterval: id => intervals.delete(id),
    fetch: async (url, options) => { requests.push({ url, options }); return response(); }
  });
  vm.runInContext(helpers, ctx);
  ctx.setupStorageConnectionMonitor();
  return { ctx, badge, text, settingsBadge, requests, values, timeouts, intervals, windowListeners, documentListeners };
}

test('checks the actual storage service without cached responses and recovers after an outage', async () => {
  const h = harness();
  assert.equal(h.text.textContent, 'Not connected');
  assert.equal((await h.ctx.checkStorageServerConnection()).connected, true);
  assert.equal(h.badge.dataset.state, 'connected');
  assert.equal(h.text.textContent, 'Connected');
  assert.equal(h.requests[0].url, 'https://storage.test/api/health');
  assert.equal(h.requests[0].options.cache, 'no-store');
  assert.equal(h.requests[0].options.headers['x-lumin-key'], 'test-key');
  h.ctx.fetch = async () => { throw Error('Network failure'); };
  assert.equal((await h.ctx.checkStorageServerConnection()).connected, false);
  assert.equal(h.text.textContent, 'Not connected');
  h.ctx.fetch = async () => response();
  await h.ctx.checkStorageServerConnection();
  assert.equal(h.text.textContent, 'Connected');
  assert.equal(h.settingsBadge.textContent, 'Connected');
});

test('HTTP errors, malformed JSON, offline health, and unrelated servers never show green', async () => {
  const h = harness();
  for (const fetch of [
    async () => response({}, 503),
    async () => ({ ok: true, json: async () => { throw Error('Invalid JSON'); } }),
    async () => response({ ...healthy, status: 'offline' }),
    async () => response({ ...healthy, service: 'Other service' }),
    async () => response(null)
  ]) {
    h.ctx.fetch = fetch;
    assert.equal((await h.ctx.checkStorageServerConnection()).connected, false);
    assert.equal(h.badge.dataset.state, 'disconnected');
  }
});

test('a hung health check times out and releases the request for recovery', async () => {
  const h = harness();
  h.ctx.fetch = (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(Error('Aborted'), { name: 'AbortError' })));
  });
  const pending = h.ctx.checkStorageServerConnection();
  const timeout = [...h.timeouts.values()][0];
  assert.equal(timeout.delay, 4000);
  timeout.fn();
  const result = await pending;
  assert.match(result.error.message, /timed out/);
  assert.equal(h.badge.dataset.state, 'disconnected');
  h.ctx.fetch = async () => response();
  assert.equal((await h.ctx.checkStorageServerConnection()).connected, true);
  assert.equal(h.timeouts.size, 0);
});

test('polls every five seconds only while active and visible, and coalesces overlapping checks', async () => {
  const h = harness();
  assert.equal(h.intervals.size, 0, 'no polling before sign-in');
  h.ctx.startStorageConnectionMonitor();
  h.ctx.startStorageConnectionMonitor();
  await settle();
  assert.equal(h.intervals.size, 1);
  const interval = [...h.intervals.values()][0];
  assert.equal(interval.delay, 5000);
  assert.equal(h.requests.length, 1);
  h.ctx.document.visibilityState = 'hidden';
  interval.fn();
  assert.equal(h.requests.length, 1);
  h.ctx.document.visibilityState = 'visible';
  interval.fn();
  await settle();
  assert.equal(h.requests.length, 2);
  let release;
  h.ctx.fetch = () => new Promise(resolve => { release = resolve; });
  const first = h.ctx.checkStorageServerConnection();
  assert.equal(first, h.ctx.checkStorageServerConnection());
  release(response());
  await first;
  h.ctx.stopStorageConnectionMonitor();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.text.textContent, 'Not connected');
});

test('offline and logout invalidate in-flight successes; online and visibility resume recheck immediately', async () => {
  const h = harness();
  h.ctx.startStorageConnectionMonitor();
  await settle();
  let release;
  h.ctx.fetch = () => new Promise(resolve => { release = resolve; });
  const pending = h.ctx.checkStorageServerConnection();
  h.ctx.navigator.onLine = false;
  h.windowListeners.get('offline')();
  assert.equal(h.text.textContent, 'Not connected');
  release(response());
  assert.equal((await pending).current, false);
  assert.equal(h.text.textContent, 'Not connected');
  h.ctx.fetch = async () => response();
  h.ctx.navigator.onLine = true;
  h.windowListeners.get('online')();
  await settle();
  assert.equal(h.text.textContent, 'Connected');
  h.ctx.fetch = () => new Promise(resolve => { release = resolve; });
  h.ctx.document.visibilityState = 'hidden';
  h.documentListeners.get('visibilitychange')();
  h.ctx.document.visibilityState = 'visible';
  h.documentListeners.get('visibilitychange')();
  const resumed = vm.runInContext('storageConnectionCheck.promise', h.ctx);
  h.ctx.stopStorageConnectionMonitor();
  release(response());
  assert.equal((await resumed).current, false);
  assert.equal(h.text.textContent, 'Not connected');
  h.windowListeners.get('focus')();
  assert.equal(h.intervals.size, 0);
});

test('changing the configured server rejects stale results and checks the new server immediately', async () => {
  const h = harness();
  h.ctx.startStorageConnectionMonitor();
  await settle();
  let release;
  h.ctx.fetch = () => new Promise(resolve => { release = resolve; });
  const oldCheck = h.ctx.checkStorageServerConnection();
  h.values.set('lumin_storage_server_url', 'https://replacement.test/');
  let newUrl;
  h.ctx.fetch = async url => { newUrl = url; return response({}, 503); };
  h.windowListeners.get('storage')({ key: 'lumin_storage_server_url' });
  assert.equal(h.text.textContent, 'Not connected');
  await settle();
  release(response());
  assert.equal((await oldCheck).current, false);
  assert.equal(newUrl, 'https://replacement.test/api/health');
  assert.equal(h.text.textContent, 'Not connected');
});

test('both live states and accessible labels switch between Arabic and English', async () => {
  const h = harness();
  h.ctx.currentUiLanguage = 'ar';
  h.ctx.renderStorageConnectionStatus();
  assert.equal(h.text.textContent, 'غير متصل');
  assert.equal(h.badge.attributes['aria-label'], 'خادم التخزين: غير متصل');
  assert.equal(h.badge.attributes.dir, 'rtl');
  await h.ctx.checkStorageServerConnection();
  assert.equal(h.text.textContent, 'متصل');
  h.ctx.currentUiLanguage = 'en';
  h.ctx.renderStorageConnectionStatus();
  assert.equal(h.text.textContent, 'Connected');
  assert.equal(h.badge.attributes.dir, 'ltr');
});

let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {}
test('title badges remain borderless, readable, and inside page bars on desktop, tablet, and mobile in both languages', { skip: !chromium && 'Playwright is not available' }, async t => {
  // Strip application scripts so the test cannot read or change clinic data.
  const fixture = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture); return; }
    if (url.pathname === '/api/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(healthy)); return; }
    const target = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', target.endsWith('.css') ? 'text/css' : target.endsWith('.js') ? 'application/javascript' : 'application/octet-stream');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  await page.addScriptTag({ url: origin + '/vendor/lucide.min.js' });
  await page.addScriptTag({ content: `let currentUiLanguage = 'en'; ${helpers}
    localStorage.setItem('lumin_storage_server_url', location.origin);
    setupStorageConnectionMonitor();
    document.getElementById('app-shell').classList.remove('hidden');
    document.getElementById('auth-gate').classList.add('hidden');
    void checkStorageServerConnection();` });
  await page.waitForFunction(() => document.querySelector('[data-storage-connection-badge]').dataset.state === 'connected');
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const language of ['en', 'ar']) {
      await page.evaluate(language => {
        currentUiLanguage = language;
        document.documentElement.lang = language;
        document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
        renderStorageConnectionStatus();
      }, language);
      for (const view of ['dashboard', 'patients', 'appointments', 'admin', 'settings', 'chart', 'whatsapp']) {
        await page.evaluate(view => {
          document.querySelectorAll('#app-main [id^="view-"]').forEach(element => element.classList.toggle('hidden', element.id !== 'view-' + view));
          document.getElementById('patient-workspace-sheet').classList.toggle('hidden', view !== 'chart');
        }, view);
        const visibleBadges = page.locator('[data-storage-connection-badge]:visible');
        const hasBadge = view === 'dashboard' || view === 'chart';
        assert.equal(await visibleBadges.count(), hasBadge ? 1 : 0, `${view}, ${width}px, ${language}: badge appears only on Dashboard and Dental Chart`);
        const bounds = await visibleBadges.evaluateAll(badges => badges.map(badge => {
          const rect = badge.getBoundingClientRect(), bar = badge.closest('.app-page-bar').getBoundingClientRect();
          const style = getComputedStyle(badge);
          return { inside: rect.left >= bar.left && rect.right <= bar.right + 1 && rect.top >= bar.top && rect.bottom <= bar.bottom + 1,
            border: style.borderTopWidth, color: style.color, label: badge.textContent, icon: !!badge.querySelector('svg') };
        }));
        for (const result of bounds) {
          assert.equal(result.inside, true, `${view}, ${width}px, ${language}: ${JSON.stringify(result)}`);
          assert.equal(result.border, '0px');
          assert.equal(result.color, 'rgb(4, 120, 87)');
          assert.equal(result.label, language === 'ar' ? 'متصل' : 'Connected');
          assert.equal(result.icon, true);
        }
      }
    }
  }
  // The longer disconnected label must fit too, including the raised theme.
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const language of ['en', 'ar']) {
      for (const view of ['dashboard', 'chart']) {
        await page.evaluate(({ language, view }) => {
          currentUiLanguage = language;
          document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
          document.body.classList.add('lumin-raised');
          document.querySelectorAll('#app-main [id^="view-"]').forEach(element => element.classList.toggle('hidden', element.id !== 'view-' + view));
          document.getElementById('patient-workspace-sheet').classList.toggle('hidden', view !== 'chart');
          window.dispatchEvent(new Event('offline'));
        }, { language, view });
        const result = await page.locator('[data-storage-connection-badge]:visible').evaluate(badge => {
          const rect = badge.getBoundingClientRect(), bar = badge.closest('.app-page-bar').getBoundingClientRect();
          return { inside: rect.left >= bar.left && rect.right <= bar.right + 1 && rect.bottom <= bar.bottom + 1,
            color: getComputedStyle(badge).color, border: getComputedStyle(badge).borderTopWidth, label: badge.textContent };
        });
        assert.equal(result.inside, true, `${view}, ${width}px, ${language}: disconnected badge fits`);
        assert.equal(result.color, 'rgb(190, 18, 60)');
        assert.equal(result.border, '0px');
        assert.equal(result.label, language === 'ar' ? 'غير متصل' : 'Not connected');
      }
    }
  }
  await page.evaluate(() => {
    currentUiLanguage = 'en'; document.documentElement.dir = 'ltr';
    document.querySelectorAll('#app-main [id^="view-"]').forEach(element => element.classList.toggle('hidden', element.id !== 'view-dashboard'));
    document.getElementById('patient-workspace-sheet').classList.add('hidden');
    window.dispatchEvent(new Event('offline'));
  });
  assert.equal(await page.locator('#dashboard-intro [data-storage-connection-badge]').textContent(), 'Not connected');
  assert.equal(await page.locator('#dashboard-intro [data-storage-connection-badge]').evaluate(badge => getComputedStyle(badge).color), 'rgb(190, 18, 60)');
  if (process.env.LUMIN_TEST_ARTIFACT_DIR) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(process.env.LUMIN_TEST_ARTIFACT_DIR, 'lumin-storage-badge-mobile.png') });
    await page.evaluate(() => checkStorageServerConnection());
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: path.join(process.env.LUMIN_TEST_ARTIFACT_DIR, 'lumin-storage-badge-desktop.png') });
  }
  assert.deepEqual(errors, []);
});
