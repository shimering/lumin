const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function functionSource(name) {
  const start = source.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n    (?:async )?function /);
  return rest.slice(0, end < 0 ? rest.indexOf('</script>') : end + 1);
}
const helpers = ['coalesceRefreshRead', 'contentRefreshContext', 'beginContentRefresh', 'finishContentRefresh', 'failContentRefresh', 'setStableHtml'];
function context(extra = {}) {
  const ctx = vm.createContext({ coalescedRefreshReads: new Map(), currentSession: { user: { id: 'staff' } }, currentUiLanguage: 'en', stableJsonStringify: JSON.stringify, ...extra });
  helpers.forEach(name => vm.runInContext(functionSource(name), ctx));
  return ctx;
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
test('overlapping reads are serialized and a change arriving in flight gets one fresh trailing read', async () => {
  const ctx = context(), first = deferred();
  let reads = 0;
  const pending = ctx.coalesceRefreshRead('invoices', async () => { reads++; return first.promise; });
  await Promise.resolve();
  const second = ctx.coalesceRefreshRead('invoices', async () => { reads++; return 'superseded'; });
  const third = ctx.coalesceRefreshRead('invoices', async () => { reads++; return 'latest other-staff change'; });
  assert.equal(reads, 1);
  first.resolve('old snapshot');
  assert.deepEqual(await Promise.all([pending, second, third]), Array(3).fill('latest other-staff change'));
  assert.equal(reads, 2);
  assert.equal(ctx.coalescedRefreshReads.size, 0);
});
test('read failures release the queue and new patient/filter/session contexts remain independent', async () => {
  const ctx = context();
  await assert.rejects(ctx.coalesceRefreshRead('invoices', async () => { throw Error('Offline'); }), /Offline/);
  assert.equal(await ctx.coalesceRefreshRead('invoices', async () => 'recovered'), 'recovered');
  const first = deferred(), a = ctx.contentRefreshContext('invoices', 'patient-a');
  const pending = ctx.coalesceRefreshRead(a, () => first.promise);
  ctx.currentSession = { user: { id: 'other-staff' } };
  const b = ctx.contentRefreshContext('invoices', 'patient-a');
  assert.notEqual(a, b);
  assert.equal(await ctx.coalesceRefreshRead(b, async () => 'other session'), 'other session');
  first.resolve('first session');
  assert.equal(await pending, 'first session');
});
function clockContext() {
  let now = 0, id = 0;
  const timers = new Map(), batches = [];
  const ctx = context({
    Date: { now: () => now }, setTimeout: (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id; }, clearTimeout: id => timers.delete(id),
    currentUserAccess: {}, REALTIME_APP_TABLES: new Set(['appointments', 'invoice_payments', 'patient_invoices']),
    realtimePendingTables: new Set(), realtimeRefreshTimer: null, realtimeRefreshDueAt: 0, realtimeRefreshBatchStartedAt: null, realtimeRefreshInFlight: false, realtimeRefreshQueued: false,
    flushRealtimeRefresh: () => { batches.push([...ctx.realtimePendingTables]); ctx.realtimePendingTables.clear(); ctx.realtimeRefreshTimer = null; ctx.realtimeRefreshBatchStartedAt = null; }
  });
  ['scheduleRealtimeRefresh', 'queueRealtimeRefresh'].forEach(name => vm.runInContext(functionSource(name), ctx));
  function tick(end) { while (true) { const entry = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= end); if (!entry) break; timers.delete(entry[0]); now = entry[1].at; entry[1].fn(); } now = end; }
  return { ctx, timers, batches, tick };
}
test('related notifications debounce together without indefinite delay under continuous traffic', () => {
  const { ctx, batches, tick } = clockContext();
  ctx.queueRealtimeRefresh('invoice_payments'); tick(80);
  ctx.queueRealtimeRefresh('patient_invoices'); tick(200);
  assert.equal(batches.length, 0);
  tick(230);
  assert.deepEqual(batches, [['invoice_payments', 'patient_invoices']]);
  for (let at = 240; at <= 640; at += 100) { tick(at); ctx.queueRealtimeRefresh('invoice_payments'); }
  tick(740);
  assert.equal(batches.length, 2, 'a continuous burst is flushed within 500ms');
});
test('notifications during a refresh stay pending and immediate catch-up remains immediate', () => {
  const { ctx, timers, batches, tick } = clockContext();
  ctx.realtimeRefreshInFlight = true;
  ctx.queueRealtimeRefresh('invoice_payments'); ctx.queueRealtimeRefresh('patient_invoices');
  assert.equal(timers.size, 0);
  assert.equal(ctx.realtimeRefreshQueued, true);
  ctx.realtimeRefreshInFlight = false; ctx.scheduleRealtimeRefresh(); tick(150);
  assert.deepEqual(batches[0], ['invoice_payments', 'patient_invoices']);
  ctx.queueRealtimeRefresh('appointments', 0); ctx.queueRealtimeRefresh('invoice_payments'); tick(150);
  assert.equal(batches.length, 2);
});

let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {}
test('real invoice renderer refreshes quietly and preserves unaffected controls', { skip: !chromium && 'Playwright is not available' }, async t => {
  const browser = await chromium.launch({ headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  t.after(() => page.close());
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<div id="dashboard-invoice-date"></div><div id="dashboard-invoice-count"></div><div id="view-dashboard"><div id="dashboard-invoices-list" style="height:400px;overflow:auto"></div></div>');
  await page.addScriptTag({ content: `
    let currentSession = {user:{id:'staff'}}, currentUiLanguage = 'en';
    const coalescedRefreshReads = new Map(), dashboardInvoiceCache = new Map();
    const DASHBOARD_INVOICE_CACHE_TTL = 30000, appointmentDayFormatter = {format: d => d.toISOString().slice(0,10)};
    let dashboardSelectedDate = new Date('2026-09-30T12:00:00Z'), dashboardInvoiceRenderToken = 0;
    let fixtureRows = Array.from({length:12}, (_,id) => ({id,patientId:'patient',paidAmount:0,status:'partial'}));
    let fixtureRead = null, fixtureReadCount = 0;
    const db = {from: () => ({select(){return this},order(){return this},eq(){return this},in(){return this},
      then(resolve,reject) { fixtureReadCount++; return (fixtureRead || Promise.resolve()).then(() => resolve({data:fixtureRows.map(row=>({...row})),error:null}),reject); }
    })};
    const INVOICE_SELECT_FIELDS = '*';
    function stableJsonStringify(value){return JSON.stringify(value)}
    function appointmentDateKey(value){return value.toISOString().slice(0,10)}
    function canViewDashboardInvoices(){return true}
    function normaliseInvoiceRecord(record){return record}
    function escapeHtml(value){return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;')}
    function invoiceRemaining(){return 1}
    function translateUiTree(){}
    const lucide = {createIcons(){}};
    function dashboardInvoiceCardMarkup(invoice){return '<article data-refresh-key="'+invoice.id+'" style="height:90px"><span>'+invoice.paidAmount+'</span><input aria-label="Invoice note '+invoice.id+'" value=""/></article>'}
    ${helpers.map(functionSource).join('\n')}
    ${['fetchInvoiceRecords','dashboardInvoiceCacheKey','loadDashboardInvoiceRecords','renderDashboardInvoices'].map(functionSource).join('\n')}
    async function refreshFixtures(){dashboardInvoiceCache.clear();await renderDashboardInvoices([{patientId:'patient',patient:'Fixture'}])}
    await renderDashboardInvoices([{patientId:'patient',patient:'Fixture'}]);
  `.replace('    await renderDashboardInvoices', '    void renderDashboardInvoices') });
  await page.waitForFunction(() => document.querySelectorAll('article').length === 12);
  await t.test('save refresh plus realtime echo has no loading flash or replacement of unchanged cards', async () => {
    await page.locator('[aria-label="Invoice note 3"]').fill('unfinished note');
    await page.evaluate(() => {
      const list = document.getElementById('dashboard-invoices-list'); list.scrollTop = 220;
      window.originalCard = list.children[3]; window.originalInput = document.activeElement;
      window.contentMutations = 0;
      window.observer = new MutationObserver(events => { contentMutations += events.filter(event => event.type === 'childList').length; });
      observer.observe(list,{childList:true});
      fixtureRead = new Promise(resolve => {window.releaseRead = resolve});
      window.firstRefresh = refreshFixtures(); window.echoRefresh = refreshFixtures();
    });
    assert.equal(await page.locator('article').count(), 12);
    assert.equal(await page.getByText('Loading invoices...').count(), 0);
    await page.evaluate(() => { fixtureRows[0].paidAmount = 50; releaseRead(); });
    await page.evaluate(() => Promise.all([firstRefresh, echoRefresh]));
    assert.equal(await page.locator('article').first().locator('span').textContent(), '50');
    assert.equal(await page.locator('[aria-label="Invoice note 3"]').inputValue(), 'unfinished note');
    assert.equal(await page.evaluate(() => originalCard === document.querySelectorAll('article')[3] && originalInput === document.activeElement), true);
    assert.equal(await page.locator('#dashboard-invoices-list').evaluate(el => el.scrollTop), 220);
    await page.evaluate(() => { fixtureRead = null; observer.disconnect(); });
    const mutations = await page.evaluate(() => contentMutations);
    await page.evaluate(() => { observer.observe(document.getElementById('dashboard-invoices-list'),{childList:true}); return refreshFixtures(); });
    assert.equal(await page.evaluate(() => contentMutations), mutations, 'unchanged echo has no list DOM writes');
    await page.evaluate(() => observer.disconnect());
  });
  await t.test('background failure keeps current invoices and recovers on retry', async () => {
    await page.evaluate(() => { fixtureRead = Promise.reject(Error('Offline')); return refreshFixtures(); });
    assert.equal(await page.locator('article').count(), 12);
    assert.equal(await page.getByRole('status').textContent(), 'Could not refresh. Showing the last loaded information.');
    await page.evaluate(() => { fixtureRead = null; return refreshFixtures(); });
    assert.equal(await page.getByRole('status').count(), 0);
  });
  await t.test('a new day shows its initial loader and older responses cannot replace its results', async () => {
    await page.evaluate(() => { fixtureRead = new Promise(resolve => { window.releaseRead = resolve; }); window.oldRefresh = refreshFixtures(); dashboardSelectedDate = new Date('2026-10-01T12:00:00Z'); window.newRefresh = renderDashboardInvoices([{patientId:'patient',patient:'Fixture'}]); });
    assert.equal(await page.locator('article').count(), 0);
    assert.equal(await page.getByText('Loading invoices...').count(), 1);
    await page.evaluate(() => { releaseRead(); return Promise.all([oldRefresh,newRefresh]); });
    assert.equal(await page.locator('article').count(), 12);
    assert.equal(await page.locator('#dashboard-invoice-date').textContent(), '2026-10-01');
    assert.equal(await page.locator('#dashboard-invoices-list').getAttribute('aria-busy'), 'false');
  });
  await t.test('keyed table rows preserve an unsaved control when another row changes or ordering changes', async () => {
    const result = await page.evaluate(() => {
      const table = document.createElement('table'); document.body.appendChild(table);
      const body = document.createElement('tbody'); table.appendChild(body);
      const row = (id, amount) => '<tr data-refresh-key="'+id+'"><td>'+amount+'</td><td><input value="original"/></td></tr>';
      setStableHtml(body, row('a', 10) + row('b', 20));
      const input = body.children[0].querySelector('input'); input.value = 'unsaved'; input.focus();
      setStableHtml(body, row('b', 30) + row('a', 10));
      const preserved = input === body.children[1].querySelector('input') && input.value === 'unsaved' && input === document.activeElement;
      body.innerHTML = '<tr><td>Loading</td></tr>';
      setStableHtml(body, row('b', 30) + row('a', 10));
      const restored = body.children.length === 2 && body.children[0].getAttribute('data-refresh-key') === 'b';
      table.remove(); return {preserved, restored};
    });
    assert.deepEqual(result, {preserved:true, restored:true});
  });
  await t.test('permission edits survive an update to a different user type', async () => {
    await page.addScriptTag({ content: `
      let adminRoles = [{id:'dentist',name:'Dentist',is_system:false},{id:'reception',name:'Reception',is_system:false}];
      const APP_PAGES = [{key:'dashboard',label:'Dashboard'}];
      function roleHasPermission(){return false}
      function roleHasWhatsAppNotifications(){return false}
      ${functionSource('renderAdminRoles')}
    ` });
    const result = await page.evaluate(() => {
      const container = document.createElement('div'); container.id = 'admin-roles-list'; document.body.appendChild(container);
      renderAdminRoles();
      const card = container.children[0], checkbox = card.querySelector('[data-role-permission]');
      checkbox.checked = true; checkbox.focus();
      adminRoles[1].name = 'Reception team'; renderAdminRoles();
      const preserved = card === container.children[0] && checkbox.checked && checkbox === document.activeElement;
      const updated = container.children[1].querySelector('h4').textContent === 'Reception team';
      container.remove(); return {preserved,updated};
    });
    assert.deepEqual(result, {preserved:true,updated:true});
  });
  await t.test('Arabic refresh failures retain cards and report the failure in Arabic', async () => {
    await page.evaluate(() => { currentUiLanguage = 'ar'; document.documentElement.dir = 'rtl'; fixtureRead = null; return refreshFixtures(); });
    await page.evaluate(() => { fixtureRead = Promise.reject(Error('Offline')); return refreshFixtures(); });
    assert.equal(await page.locator('article').count(), 12);
    assert.equal(await page.getByRole('status').textContent(), 'تعذر تحديث البيانات. يتم عرض آخر بيانات تم تحميلها.');
    await page.evaluate(() => { fixtureRead = null; return refreshFixtures(); });
  });
  assert.deepEqual(errors, []);
});
