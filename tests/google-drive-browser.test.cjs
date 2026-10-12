const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
let chromium; try { ({chromium} = require('playwright')); } catch (_) {}
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const workflow = html.slice(html.indexOf('    const DEFAULT_STORAGE_PRESETS ='), html.indexOf('    async function testStorageServerConnection()'));
function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  const end = html.slice(start).match(/\r?\n    }\r?\n/);
  return html.slice(start, start + end.index + end[0].length);
}
test('Drive switch, private grants and exactly two sync locations work on mobile and Arabic layouts', {skip: !chromium && 'Playwright unavailable'}, async t => {
  const fixture = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture); return; }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined});
  t.after(() => browser.close());
  const page = await browser.newPage(); const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  let paired = false;
  await page.route(/^https:\/\/(?:pc\.test|project\.supabase\.test)\//, async route => {
    const request = route.request(), url = new URL(request.url()); requests.push({url: url.toString(), method: request.method(), body: request.postDataJSON()});
    if (url.pathname.endsWith('/api/revoke-grant')) { await route.fulfill({json: {success: true}}); return; }
    assert.equal(request.headers().authorization, 'Bearer admin-session');
    let data;
    if (url.pathname.endsWith('/info')) data = url.hostname === 'pc.test'
      ? {nodeId:'local-node',protocol:1,fileScope:'patient-files-v1',clinicalMetadataVersion:2,pair:paired?{peerId:'drive-node',role:'coordinator'}:null}
      : {nodeId:'drive-node',protocol:1,fileScope:'patient-files-v1',clinicalMetadataVersion:2,pair:paired?{peerId:'local-node',role:'replica'}:null};
    else if (url.pathname.endsWith('/pair')) { paired = true; data = {peerId:'drive-node',paired:true}; }
    else if (url.pathname.endsWith('/jobs/latest')) data = {job:null};
    else throw new Error('Unexpected request: ' + url);
    await route.fulfill({json: data});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addScriptTag({url: '/vendor/lucide.min.js'});
  await page.addScriptTag({content: `
    const SUPABASE_URL='https://project.supabase.test';
    let currentUiLanguage='en',currentUserAccess={isAdmin:true,userId:'admin'},clinicStorageServerUrl='https://pc.test',clinicStorageSecretKey='local-key',storageConnectionConnected=false,storageConnectionState='disconnected';
    const settingsWrites=[];
    const db={functions:{invoke:async(name,{body})=>({data:{connected:true,configured:true,email:'clinic@example.test',rootName:'Lumin Clinic',rootUrl:'https://drive.google.com/drive/folders/root',mediaGrant:'ephemeral-media-grant-only-in-memory',expiresAt:new Date(Date.now()+900000).toISOString()}})},
      auth:{getSession:async()=>({data:{session:{access_token:'admin-session'}}})},
      from:()=>({update(value){settingsWrites.push(value);return this},eq(){return this},select(){return this},async maybeSingle(){return {data:{id:1},error:null}}})};
    function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
    function refreshStorageConnectionConfig(){}
    async function checkStorageServerConnection(){storageConnectionConnected=true;renderStoragePresetConnectionStatus()}
    ${source('getStorageServerConfig')}
    ${workflow}
    localStorage.setItem('lumin_storage_server_presets',JSON.stringify([{id:'pc',name:'Clinic PC',url:'https://pc.test',key:'local-key',icon:'server'},{id:'laptop',name:'Laptop',url:'https://laptop.test',key:'laptop-key',icon:'laptop'}]));
    document.getElementById('app-shell').classList.remove('hidden');document.getElementById('auth-gate').classList.add('hidden');
    document.querySelectorAll('#app-main [id^="view-"]').forEach(el=>el.classList.toggle('hidden',el.id!=='view-admin'));
    document.querySelectorAll('#view-admin [id^="admin-panel-"]').forEach(el=>el.classList.toggle('hidden',el.id!=='admin-panel-storage'));
  `});
  await page.addScriptTag({url:'/lumin-google-drive.js'});
  await page.addScriptTag({url:'/lumin-storage-sync.js'});
  await page.evaluate(async () => { await LuminGoogleDrive.ensure(); populateStorageServerSettingsInputs(); LuminStorageSync.open(); });
  assert.equal(await page.locator('.storage-server-card').count(), 3);
  await page.locator('#settings-storage-preset').selectOption('preset-google-drive');
  await page.waitForFunction(() => getStorageServerConfig().url.endsWith('/google-drive'));
  assert.equal(await page.evaluate(() => settingsWrites.at(-1).storage_secret_key), '');
  assert.equal(await page.evaluate(() => getStorageServerConfig().key), 'ephemeral-media-grant-only-in-memory');
  assert.equal(await page.locator('#storage-local-url-field').isVisible(), false);
  assert.equal(await page.locator('#storage-location-card').isVisible(), false);
  assert.equal(await page.locator('#btn-save-storage').isVisible(), false);
  assert.equal(await page.locator('#storage-google-drive-panel button').last().isDisabled(), true);
  const selectors = page.locator('#storage-sync-panel select'); assert.equal(await selectors.count(), 2);
  await selectors.nth(0).selectOption('preset-google-drive'); await selectors.nth(1).selectOption('pc');
  await page.locator('#storage-sync-pair').click();
  await page.waitForFunction(() => !document.getElementById('storage-sync-start').disabled);
  assert.ok(requests.some(r => r.url === 'https://pc.test/api/drive-sync/pair' && r.body.url === 'https://project.supabase.test/functions/v1/google-drive'));
  assert.ok(requests.some(r => r.url.includes('/google-drive/api/sync/info?peer=local-node')));
  assert.ok(!requests.some(r => r.url.includes('laptop.test')));
  const stored = await page.evaluate(() => Object.values(localStorage).join(' '));
  assert.ok(!stored.includes('ephemeral-media-grant'));
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({width, height: 1100});
    for (const language of ['en','ar']) {
      await page.evaluate(language => {currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';renderStorageServerPresets();LuminStorageSync.render();}, language);
      const controls = await page.locator('#storage-google-drive-panel .drive-action, .drive-card .drive-action').evaluateAll(elements => elements.map(el => {const r=el.getBoundingClientRect();return {height:r.height,width:r.width,inside:r.left>=0&&r.right<=innerWidth+1}}));
      controls.forEach(control => {assert.ok(control.height>=44);assert.ok(control.width>=44);assert.ok(control.inside)});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
  }
  if (process.env.LUMIN_TEST_ARTIFACT_DIR) {
    await page.setViewportSize({width:1440,height:1200}); await page.evaluate(()=>{currentUiLanguage='en';document.documentElement.dir='ltr';renderStorageServerPresets();LuminStorageSync.render()});
    await page.locator('#admin-panel-storage').screenshot({path:path.join(process.env.LUMIN_TEST_ARTIFACT_DIR,'google-drive-storage.png')});
  }
  assert.deepEqual(errors, []);
});
