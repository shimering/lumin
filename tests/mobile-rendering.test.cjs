const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {}

const root = path.resolve(__dirname, '..');
// Keep the real page and stylesheet order, with no clinic connection or local server.
const fixture = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<link\b[^>]*>/gi, link => {
    if (!/rel="stylesheet"/.test(link)) return '';
    const file = link.match(/href="([^"]+)"/)[1].split('?')[0];
    return `<style>${fs.readFileSync(path.join(root, file), 'utf8')}</style>`;
  });

test('long mobile schedules scroll without repeated backdrop layers or a retained dashboard opacity layer', { skip: !chromium }, async t => {
  const browser = await chromium.launch({ headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 412, height: 892 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  const client = await page.context().newCDPSession(page);
  let layers = [];
  client.on('LayerTree.layerTreeDidChange', event => { layers = event.layers || []; });
  await client.send('LayerTree.enable');
  await page.setContent(fixture);
  for (const file of ['vendor/lucide.min.js', 'lumin-nav-motion.js', 'lumin-mobile-nav.js', 'lumin-appointment-status.js', 'lumin-dashboard-motion.js']) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
  await page.evaluate(() => {
    document.getElementById('auth-gate').remove();
    document.getElementById('app-shell').classList.remove('hidden');
    document.getElementById('dashboard-invoices-card').hidden = true;
    document.documentElement.classList.add('dashboard-active');
    document.body.classList.add('dashboard-active');
    document.body.dataset.uiTint = 'violet';
    window.renderingLanguage = 'en';
    window.renderingStatusPicker = createLuminAppointmentStatusPicker({
      statuses: ['Scheduled', 'Confirmed', 'Completed'],
      getLabel: status => renderingLanguage === 'ar' ? ({ Scheduled: 'مجدول', Confirmed: 'مؤكد', Completed: 'مكتمل' })[status] : status,
      getAccessibleLabel: entry => 'Status ' + entry.id, canModify: () => true, onChange: async () => true
    });
    window.renderSchedule = () => {
      const list = document.getElementById('dashboard-appointments-list');
      list.innerHTML = Array.from({ length: 30 }, (_, i) => `<article data-dashboard-appointment-card="test-${i}" class="relative flex gap-4 px-5 py-5">
        <div class="w-20 shrink-0 text-center"><div class="dashboard-time-tile"><p>06:00 PM</p><p>1h</p></div></div>
        <span class="w-1 bg-violet-600"></span><div class="min-w-0 flex-1"><div data-dashboard-appointment-heading-row>
        <h4 class="text-lg font-black text-slate-900">${renderingLanguage === 'ar' ? 'مريض تجريبي' : 'Test patient'} ${i + 1}</h4>
        <div data-dashboard-appointment-status>${renderingStatusPicker.markup({ id: String(i), status: 'Completed' })}</div></div>
        <p class="text-xs text-slate-500">38 yrs</p><button data-dashboard-appointment-actions-toggle type="button">Actions</button></div></article>`).join('');
      LuminDashboardMotion.revealCards(list, renderingLanguage + document.body.className);
      lucide.createIcons();
    };
    window.renderingNav = LuminMobileNav.create({ source: document.getElementById('app-primary-nav'), shell: document.getElementById('app-shell'),
      getLanguage: () => renderingLanguage, onQuickCreate() {}, closeQuickCreate() {}, onLayout() {} });
  });

  for (const width of [412, 915, 820]) {
    await page.setViewportSize({ width, height: 892 });
    for (const theme of ['flat', 'raised']) for (const dir of ['ltr', 'rtl']) {
      await page.evaluate(({ theme, dir }) => {
        renderingStatusPicker.close(false, false);
        document.body.classList.toggle('lumin-raised', theme === 'raised');
        document.documentElement.dir = dir;
        renderingLanguage = dir === 'rtl' ? 'ar' : 'en';
        renderSchedule(); renderingNav.refresh(); window.scrollTo(0, 0);
      }, { theme, dir });
      await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'));
      for (const fraction of [0.5, 1, 0]) {
        await page.evaluate(async fraction => {
          window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * fraction);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }, fraction);
      }
      const label = `${width}px ${theme} ${dir}`;
      assert.equal(await page.locator('#view-dashboard').evaluate(el => getComputedStyle(el).animationName), 'none', label);
      const button = page.locator('[data-appointment-id="0"]');
      assert.equal(await button.evaluate(el => getComputedStyle(el).backdropFilter), 'none', label);
      assert.equal(await button.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(248, 250, 252)', 'pill has an opaque backing');
      assert.equal(await button.evaluate(el => getComputedStyle(el).borderTopWidth), '0px', 'pill stays borderless');
      assert.ok((await button.boundingBox()).height >= 44, 'touch target stays 44px');
      assert.equal(await page.locator('.lumin-mobile-nav-bar').evaluate(el => getComputedStyle(el).backdropFilter), 'none', label);
      await button.click();
      assert.equal(await page.getByRole('listbox').evaluate(el => getComputedStyle(el).backdropFilter), 'none', 'open menu does not restore blur');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.lumin-status-menu'));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      let backdropLayers = 0;
      for (const layer of layers) {
        // Chromium can retire a layer while DevTools is inspecting the tree.
        const reasons = await client.send('LayerTree.compositingReasons', { layerId: layer.layerId }).catch(error => {
          if (/No layer matching given id/.test(error.message)) return null;
          throw error;
        });
        if (!reasons) continue;
        const { compositingReasons = [] } = reasons;
        if (compositingReasons.includes('Has a backdrop filter.')) backdropLayers++;
        if (!layer.backendNodeId) continue;
        const { node } = await client.send('DOM.describeNode', { backendNodeId: layer.backendNodeId });
        if (node.attributes?.includes('view-dashboard')) {
          assert.ok(!compositingReasons.some(reason => /opacity animation/.test(reason)), 'long dashboard does not retain an opacity layer');
        }
      }
      assert.ok(backdropLayers < 8, `${label}: backdrop layers must not grow with the 30 appointments (${backdropLayers})`);
      if (process.env.LUMIN_RENDERING_SCREENSHOTS && width === 412 && theme === 'raised') {
        await page.screenshot({ path: path.join(process.env.LUMIN_RENDERING_SCREENSHOTS, `mobile-rendering-${dir}.png`) });
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.notEqual(await page.locator('[data-appointment-id="0"]').evaluate(el => getComputedStyle(el).backdropFilter), 'none', 'desktop glass is preserved');
  assert.equal(await page.locator('#view-dashboard').evaluate(el => getComputedStyle(el).animationName), 'lumin-dashboard-enter', 'desktop fade is preserved');
  assert.deepEqual(errors, []);
});
