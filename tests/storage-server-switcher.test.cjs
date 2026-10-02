const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const workflow = source.slice(source.indexOf('    const DEFAULT_STORAGE_PRESETS ='), source.indexOf('    async function testStorageServerConnection()'));
function functionSource(name) {
  const start = source.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const closing = source.slice(start).match(/\r?\n    }\r?\n/);
  assert.ok(closing, name);
  return source.slice(start, start + closing.index + closing[0].length);
}
const presets = [
  { id: 'main', name: 'Clinic PC', url: 'https://clinic.test', key: 'main-key', icon: 'server' },
  { id: 'backup', name: 'Backup laptop', url: 'https://backup.test', key: 'backup-key', icon: 'laptop' }
];
function harness() {
  const values = new Map([
    ['lumin_storage_server_presets', JSON.stringify(presets)],
    ['lumin_storage_server_url', presets[0].url], ['lumin_storage_secret_key', presets[0].key]
  ]);
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', disabled: false, textContent: '', className: '', innerHTML: '', dir: '',
      classList: { add() {}, remove() {} }, setAttribute() {}, focus() {}, isConnected: true
    });
    return elements.get(id);
  }
  const writes = [], healthChecks = [];
  let saveResult = { data: { id: 1 }, error: null };
  const query = { update(value) { writes.push(value); return this; }, eq() { return this; }, select() { return this; }, maybeSingle: () => Promise.resolve(saveResult) };
  const ctx = vm.createContext({
    URL, crypto: { randomUUID }, currentUiLanguage: 'en', currentUserAccess: { isAdmin: true },
    storageConnectionConnected: false, storageConnectionState: 'disconnected', clinicStorageServerUrl: '', clinicStorageSecretKey: '',
    document: { getElementById: element, querySelectorAll: () => [], activeElement: element('return-focus') },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    window: {}, console: { warn() {} }, requestAnimationFrame: fn => fn(),
    setTimeout: () => 1, clearTimeout() {}, confirm: () => true,
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'),
    db: { from: () => query }, refreshStorageConnectionConfig() {},
    checkStorageServerConnection: async () => { healthChecks.push(ctx.getStorageServerConfig()); },
    switchView() {}, switchAdminTab() {}
  });
  vm.runInContext(functionSource('getStorageServerConfig') + workflow, ctx);
  element('settings-storage-url').value = presets[0].url;
  element('settings-storage-key').value = presets[0].key;
  return { ctx, values, elements, element, writes, healthChecks, query, setResult: result => { saveResult = result; } };
}

test('quick switching uses the saved URL and key and changes active storage only after a confirmed clinic save', async () => {
  const h = harness();
  let release;
  h.query.maybeSingle = () => new Promise(resolve => { release = resolve; });
  const pending = h.ctx.switchToStoragePreset('backup');
  assert.equal(h.ctx.getStorageServerConfig().url, presets[0].url);
  assert.equal(h.element('settings-storage-preset').disabled, true);
  assert.equal(await h.ctx.switchToStoragePreset('main'), false, 'parallel switches are blocked');
  release({ data: { id: 1 }, error: null });
  assert.equal(await pending, true);
  assert.equal(h.ctx.getStorageServerConfig().url, presets[1].url);
  assert.equal(h.ctx.getStorageServerConfig().key, presets[1].key);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].storage_secret_key, 'backup-key');
  assert.equal(h.element('settings-storage-preset').value, 'backup');
  assert.equal(h.element('settings-storage-preset').disabled, false);
  assert.equal(h.healthChecks.length, 1);
});

test('failed or zero-row writes retain the old server, restore the selection, and allow retry', async () => {
  const h = harness();
  for (const result of [{ data: null, error: { message: 'Offline' } }, { data: null, error: null }]) {
    h.setResult(result);
    assert.equal(await h.ctx.switchToStoragePreset('backup'), false);
    assert.equal(h.ctx.getStorageServerConfig().url, presets[0].url);
    assert.equal(h.values.get('lumin_storage_server_url'), presets[0].url);
    assert.equal(h.element('settings-storage-url').value, presets[0].url);
    assert.equal(h.element('settings-storage-preset').value, 'main');
    assert.match(h.element('settings-storage-message').textContent, /previous server is still active/);
  }
  h.setResult({ data: { id: 1 }, error: null });
  assert.equal(await h.ctx.switchToStoragePreset('backup'), true);
});

test('adding and editing servers persist their name, URL and key without switching the clinic connection', () => {
  const h = harness();
  h.ctx.promptAddStoragePreset();
  h.element('storage-preset-name').value = 'Chairside storage';
  h.element('storage-preset-url').value = 'https://chairside.test/';
  h.element('storage-preset-key').value = 'chairside-key';
  assert.equal(h.ctx.saveStoragePresetFromDialog(), true);
  let saved = h.ctx.getStorageServerPresets();
  assert.equal(saved.length, 3);
  const added = saved.find(preset => preset.name === 'Chairside storage');
  assert.equal(added.url, 'https://chairside.test');
  assert.equal(added.key, 'chairside-key');
  assert.equal(h.ctx.getStorageServerConfig().url, presets[0].url);
  assert.equal(h.writes.length, 0);
  h.ctx.configureStoragePreset(added.id);
  h.element('storage-preset-name').value = 'Chairside backup';
  assert.equal(h.ctx.saveStoragePresetFromDialog(), true);
  saved = h.ctx.getStorageServerPresets();
  assert.equal(saved.length, 3);
  assert.equal(saved.find(preset => preset.id === added.id).name, 'Chairside backup');
});

test('invalid and duplicate URLs are rejected, and removing every saved server preserves the empty list', () => {
  const h = harness();
  h.ctx.promptAddStoragePreset();
  h.element('storage-preset-name').value = 'New server';
  for (const url of ['ftp://invalid.test', 'https://clinic.test/', 'https://user:password@example.test', 'https://example.test?token=wrong']) {
    h.element('storage-preset-url').value = url;
    assert.equal(h.ctx.saveStoragePresetFromDialog(), false);
    assert.equal(h.ctx.getStorageServerPresets().length, 2);
  }
  h.ctx.deleteStoragePreset('main');
  h.ctx.deleteStoragePreset('backup');
  assert.equal(h.ctx.getStorageServerPresets().length, 0);
  assert.equal(h.ctx.getStorageServerConfig().url, presets[0].url);
  assert.match(h.element('storage-server-presets-container').innerHTML, /No saved servers/);
});

test('administration permissions gate add, edit, delete, and switching', async () => {
  const h = harness();
  h.ctx.currentUserAccess = { isAdmin: false };
  h.ctx.promptAddStoragePreset();
  h.ctx.deleteStoragePreset('main');
  assert.equal(h.ctx.saveStoragePresetFromDialog(), false);
  assert.equal(await h.ctx.switchToStoragePreset('backup'), false);
  assert.equal(h.ctx.getStorageServerPresets().length, 2);
  assert.equal(h.writes.length, 0);
});

let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {}
test('real Storage Server subtab supports adding and one-step switching with accessible responsive controls in both languages', { skip: !chromium && 'Playwright is not available' }, async t => {
  const fixture = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture); return; }
    const target = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', target.endsWith('.css') ? 'text/css' : target.endsWith('.js') ? 'application/javascript' : 'application/octet-stream');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  await page.addScriptTag({ url: origin + '/vendor/lucide.min.js' });
  await page.addScriptTag({ content: `
    let currentUiLanguage='en', currentUserAccess={isAdmin:true}, clinicStorageServerUrl='', clinicStorageSecretKey='', storageConnectionConnected=false, storageConnectionState='disconnected';
    let writeCount=0;
    const db={from:()=>({update(){writeCount++;return this},eq(){return this},select(){return this},async maybeSingle(){return {data:{id:1},error:null}}})};
    function escapeHtml(value){return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;')}
    function refreshStorageConnectionConfig(){storageConnectionConnected=false;renderStoragePresetConnectionStatus()}
    async function checkStorageServerConnection(){storageConnectionConnected=true;renderStoragePresetConnectionStatus()}
    ${functionSource('getStorageServerConfig')}
    ${workflow}
    localStorage.setItem('lumin_storage_server_presets',${JSON.stringify(JSON.stringify(presets))});
    localStorage.setItem('lumin_storage_server_url','https://clinic.test');
    localStorage.setItem('lumin_storage_secret_key','main-key');
    document.getElementById('app-shell').classList.remove('hidden');
    document.getElementById('auth-gate').classList.add('hidden');
    document.querySelectorAll('#app-main [id^="view-"]').forEach(el=>el.classList.toggle('hidden',el.id!=='view-admin'));
    document.querySelectorAll('#view-admin [id^="admin-panel-"]').forEach(el=>el.classList.toggle('hidden',el.id!=='admin-panel-storage'));
    populateStorageServerSettingsInputs();
  ` });
  assert.equal(await page.locator('#view-admin > .app-page-bar .app-page-title').textContent(), 'Admin');
  assert.equal(await page.locator('#admin-storage-tab-label').textContent(), 'Storage Server');
  assert.equal(await page.locator('[data-active-storage-connection]').textContent(), 'Not connected');
  await page.locator('#settings-storage-preset').selectOption('backup');
  await page.waitForFunction(() => getStorageServerConfig().url === 'https://backup.test');
  assert.equal(await page.evaluate(() => writeCount), 1);
  assert.equal(await page.locator('[data-active-storage-connection]').textContent(), 'Connected');
  await page.locator('#storage-add-server-label').click();
  await page.locator('#storage-preset-name').fill('Third clinic server');
  await page.locator('#storage-preset-url').fill('https://third-clinic.test');
  await page.locator('#storage-preset-key').fill('third-key');
  await page.locator('#storage-preset-form button[type="submit"]').click();
  assert.equal(await page.locator('.storage-server-card').count(), 3);
  assert.equal(await page.evaluate(() => getStorageServerConfig().url), 'https://backup.test');
  const newId = await page.evaluate(() => getStorageServerPresets().find(p=>p.name==='Third clinic server').id);
  await page.locator('#settings-storage-preset').selectOption(newId);
  await page.waitForFunction(() => getStorageServerConfig().url === 'https://third-clinic.test');
  assert.equal(await page.evaluate(() => getStorageServerConfig().key), 'third-key');
  for (const width of [320,390,768,1440]) {
    await page.setViewportSize({width,height:900});
    for (const language of ['en','ar']) {
      await page.evaluate(language=>{currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';renderStorageServerPresets()},language);
      assert.equal(await page.locator('#admin-storage-tab-label').textContent(),language==='ar'?'خادم التخزين':'Storage Server');
      const controls = await page.locator('#storage-server-presets-container button, #settings-storage-preset').evaluateAll(elements=>elements.map(el=>{
        const rect=el.getBoundingClientRect();return {height:rect.height,width:rect.width,inside:rect.left>=0 && rect.right<=innerWidth+1};
      }));
      controls.forEach(control=>{assert.ok(control.height>=44);assert.ok(control.width>=44);assert.equal(control.inside,true)});
      await page.locator('#storage-add-server-label').click();
      const modal = await page.locator('.storage-server-dialog-card').boundingBox();
      assert.ok(modal.x>=0 && modal.x+modal.width<=width+1);
      const title=await page.locator('#storage-preset-dialog-title').textContent();
      assert.equal(title,language==='ar'?'إضافة خادم':'Add server');
      await page.locator('#storage-preset-form button[type="submit"]').focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('#storage-preset-dialog-close').evaluate(el=>el===document.activeElement),true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#modal-storage-server').isVisible(),false);
    }
  }
  if (process.env.LUMIN_TEST_ARTIFACT_DIR) {
    await page.evaluate(()=>{currentUiLanguage='en';document.documentElement.dir='ltr';renderStorageServerPresets()});
    await page.setViewportSize({width:1440,height:1000});
    await page.screenshot({path:path.join(process.env.LUMIN_TEST_ARTIFACT_DIR,'lumin-storage-server-admin.png')});
    await page.setViewportSize({width:390,height:844});
    await page.locator('#storage-add-server-label').click();
    await page.screenshot({path:path.join(process.env.LUMIN_TEST_ARTIFACT_DIR,'lumin-add-storage-server-mobile.png')});
  }
  assert.deepEqual(errors,[]);
});
