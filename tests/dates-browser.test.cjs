const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');

test('date controls display dd/mm/yyyy, preserve ISO values and validate across devices and languages', async t => {
  const browser = await chromium.launch({ headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || 'chrome' });
  t.after(() => browser.close());
  for (const fixture of [
    { width: 390, locale: 'en-US', dir: 'ltr' },
    { width: 820, locale: 'ar-EG', dir: 'rtl' },
    { width: 1440, locale: 'en-US', dir: 'rtl' }
  ]) await t.test(`${fixture.width}px ${fixture.locale} ${fixture.dir}`, async () => {
    const context = await browser.newContext({ viewport: { width: fixture.width, height: 1000 }, locale: fixture.locale, timezoneId: 'Africa/Cairo', hasTouch: fixture.width < 1024 });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`<html lang="${fixture.locale.slice(0, 2)}" dir="${fixture.dir}"><body class="lumin-raised"><main style="padding:24px;max-width:600px;margin:auto"><form id="form">
      <label>Date<input id="date" name="date" type="date" value="2026-10-05" min="2020-01-01" max="2030-12-31" required class="w-full rounded-xl border border-slate-200 px-3 py-2" oninput="window.inputEvents=(window.inputEvents||0)+1" onchange="window.savedValue=this.value"></label>
      <label>Procedure date and time<input id="date-time" type="datetime-local" value="2026-10-05T19:30" required class="w-full rounded-xl border border-slate-200 px-3 py-2"></label>
      <input id="private-date" type="date" class="hidden" value="2026-10-05">
      <button type="reset">Reset</button></form><div id="dynamic"></div></main></body></html>`);
    for (const file of ['lumin-app.css', 'lumin-theme.css', 'lumin-dates.css']) await page.addStyleTag({ path: path.join(root, file) });
    await page.addScriptTag({ path: path.join(root, 'vendor/lucide.min.js') });
    await page.addScriptTag({ path: path.join(root, 'lumin-dates.js') });
    const date = page.locator('#date').locator('..').locator('[data-lumin-date-text]');
    const dateTime = page.locator('#date-time').locator('..').locator('[data-lumin-date-text]');
    assert.equal(await date.inputValue(), '05/10/2026');
    assert.equal(await dateTime.inputValue(), '05/10/2026 19:30');
    assert.equal(await page.locator('#date').inputValue(), '2026-10-05');
    assert.equal(await page.locator('#private-date').locator('..').isVisible(), false);
    await date.fill('27/02/2028');
    await date.press('Tab');
    assert.equal(await page.evaluate(() => savedValue), '2028-02-27');
    assert.equal(await page.evaluate(() => new FormData(document.getElementById('form')).get('date')), '2028-02-27');
    assert.equal(await page.evaluate(() => document.getElementById('form').checkValidity()), true);
    assert.equal(await page.evaluate(() => inputEvents), 1);
    await date.fill('31/02/2026');
    assert.equal(await date.evaluate(input => input.checkValidity()), false);
    assert.equal(await page.locator('#date').inputValue(), '');
    await date.fill('01/01/2031');
    assert.equal(await date.evaluate(input => input.checkValidity()), false, 'native max is preserved');
    await date.fill('');
    assert.equal(await date.evaluate(input => input.checkValidity()), false, 'required date is preserved');
    await date.fill('٠٥/٠١/٢٠٢٦');
    await date.press('Tab');
    assert.equal(await page.locator('#date').inputValue(), '2026-01-05');
    assert.equal(await date.inputValue(), '05/01/2026');
    await dateTime.fill('29/02/2028 09:45');
    await dateTime.press('Tab');
    assert.equal(await page.locator('#date-time').inputValue(), '2028-02-29T09:45');
    await page.evaluate(() => { document.getElementById('date').value = '2029-12-31'; });
    assert.equal(await date.inputValue(), '31/12/2029', 'programmatic writes refresh the visible field');
    await page.evaluate(() => { document.getElementById('date').disabled = true; });
    await date.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#date + input').disabled);
    assert.equal(await date.isDisabled(), true);
    await page.evaluate(() => { document.getElementById('date').disabled = false; document.getElementById('form').reset(); });
    await page.waitForFunction(() => document.querySelector('#date + input').value === '05/10/2026');
    await page.evaluate(() => { document.getElementById('dynamic').innerHTML = '<label>New date<input type="date" id="new-date" value="2026-01-02"></label>'; });
    await page.locator('#new-date + input').waitFor();
    assert.equal(await page.locator('#new-date + input').inputValue(), '02/01/2026');
    await page.evaluate(() => {
      document.getElementById('date').showPicker = () => { window.pickerOpened = true; };
    });
    await page.locator('#date').locator('..').locator('button').click();
    assert.equal(await page.evaluate(() => pickerOpened), true);
    assert.equal(await page.evaluate(() => document.querySelector('form input').id), 'date', 'existing form selectors still use the ISO input');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const button of await page.locator('.lumin-date-picker:visible').all()) {
      const box = await button.boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44);
    }
    await page.screenshot({ path: path.join(root, '.lumin-drive-test-tools', `dates-${fixture.width}-${fixture.dir}.png`) });
    assert.deepEqual(errors, []);
    await context.close();
  });
});

test('the complete app starts with all date controls enhanced and no script errors', async t => {
  const browser = await chromium.launch({ headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'lumin-date.test') return route.abort();
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.json': 'application/json' };
    return route.fulfill({ contentType: types[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.goto('https://lumin-date.test/');
  await page.waitForFunction(() => typeof setupAppDateMonitor === 'function' && document.querySelectorAll('.lumin-date-native').length > 15);
  const counts = await page.evaluate(() => ({ native: document.querySelectorAll('input[type="date"], input[type="datetime-local"]').length, visible: document.querySelectorAll('[data-lumin-date-text]').length }));
  assert.equal(counts.native, counts.visible);
  assert.deepEqual(errors, []);
});
