const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {}
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function helper(name) {
  const start = html.indexOf('    function ' + name + '(');
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}
const phone = '201001234567';
const message = 'مرحباً أحمد 👋\nQuotation: https://clinic.invalid/quotation.html?q=' + 'a'.repeat(64) + '\nA+B & 50%';
const url = 'https://api.whatsapp.com/send?phone=' + phone + '&text=' + encodeURIComponent(message);

function fixture(userAgent = 'iPhone') {
  const launches = [], copies = [], fallbacks = [], timers = new Map(), docEvents = new Map(), windowEvents = new Map();
  let nextTimer = 0, now = 0;
  const context = vm.createContext({ URL, URLSearchParams, Date: { now: () => now },
    navigator: { userAgent, clipboard: { writeText(value) { copies.push(value); return Promise.resolve(); } } },
    document: { hidden: false, body: { appendChild() {} },
      addEventListener(name, handler) { docEvents.set(name, handler); }, removeEventListener(name) { docEvents.delete(name); },
      createElement() { return { click() { launches.push({ href: this.href, target: this.target, rel: this.rel }); }, remove() {} }; } },
    window: { open() { throw new Error('Must not create a spare window'); },
      setTimeout(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; }, clearTimeout(id) { timers.delete(id); },
      addEventListener(name, handler) { windowEvents.set(name, handler); }, removeEventListener(name) { windowEvents.delete(name); } },
    showWhatsAppWebFallback(href, close) { const item = { href, close, removed: false, remove() { this.removed = true; } }; fallbacks.push(item); return item; }
  });
  vm.runInContext(helper('whatsAppNativeChatUrl') + helper('openWhatsAppLink'), context);
  return { context, launches, copies, fallbacks, timers, docEvents, windowEvents,
    advance(milliseconds) { now += milliseconds; },
    fire(delay) { const timer = [...timers].find(([, item]) => item.delay === delay); assert.ok(timer, 'timer ' + delay); timers.delete(timer[0]); timer[1].callback(); } };
}

test('iPhone, iPad, Android and laptop links hand off once in the current context with the exact message', () => {
  for (const agent of ['iPhone', 'iPad', 'Android Chrome', 'Windows Chrome', 'Macintosh Safari', 'Linux Firefox']) {
    for (const href of [url, 'https://wa.me/' + phone + '?text=' + encodeURIComponent(message)]) {
      const app = fixture(agent);
      app.context.openWhatsAppLink(href, message);
      assert.equal(app.launches.length, 1, agent);
      const target = new URL(app.launches[0].href);
      assert.equal(target.protocol, 'whatsapp:');
      assert.equal(target.hostname, 'send');
      assert.equal(target.searchParams.get('phone'), phone);
      assert.equal(target.searchParams.get('text'), message);
      assert.equal(app.launches[0].target, '_self');
      assert.deepEqual(app.copies, [message]);
      app.context.openWhatsAppLink.cancelFallback();
    }
  }
});

test('a blocked or absent app gets an explicit web option with no delayed browser navigation', () => {
  const app = fixture();
  app.context.openWhatsAppLink(url);
  app.fire(1200);
  assert.equal(app.launches.length, 1, 'fallback never navigates automatically');
  assert.equal(app.fallbacks.length, 1);
  const web = new URL(app.fallbacks[0].href);
  assert.equal(web.origin, 'https://web.whatsapp.com');
  assert.equal(web.searchParams.get('text'), message);
  app.fallbacks[0].close();
  assert.equal(app.timers.size, 0);
  assert.equal(app.docEvents.size, 0);
  assert.equal(app.windowEvents.size, 0);
  assert.equal(app.fallbacks[0].removed, true);
});

test('backgrounding, page exit, repeat taps and delayed resume discard stale fallbacks', () => {
  for (const event of ['hidden', 'pagehide', 'delayed']) {
    const app = fixture(); app.context.openWhatsAppLink(url);
    if (event === 'hidden') { app.context.document.hidden = true; app.docEvents.get('visibilitychange')(); }
    if (event === 'pagehide') app.windowEvents.get('pagehide')();
    if (event === 'delayed') { app.advance(5000); app.fire(1200); }
    assert.equal(app.fallbacks.length, 0, event);
    assert.equal(app.timers.size, 0, event);
    assert.equal(app.launches.length, 1, event);
  }
  const app = fixture(); app.context.openWhatsAppLink(url); app.fire(1200);
  app.context.openWhatsAppLink('https://wa.me/' + phone);
  assert.equal(app.fallbacks[0].removed, true, 'repeat tap removes the old destination');
  assert.equal(app.launches.length, 2, 'one launch per tap');
  assert.equal([...app.timers.values()].filter(item => item.delay === 1200).length, 1);
  app.context.openWhatsAppLink.cancelFallback();
});

test('blank chats, failed clipboard access and non-chat links retain valid behavior', async () => {
  const app = fixture();
  app.context.navigator.clipboard.writeText = () => Promise.reject(new Error('Denied'));
  app.context.openWhatsAppLink('https://wa.me/' + phone, message);
  assert.equal(new URL(app.launches[0].href).searchParams.has('text'), false, 'blank chat stays blank');
  await Promise.resolve();
  app.context.navigator.clipboard.writeText = () => { throw new Error('Denied'); };
  app.context.openWhatsAppLink(url, message);
  assert.equal(app.launches.length, 2, 'clipboard failure does not block handoff');
  app.context.openWhatsAppLink('https://wa.me/message/business-code');
  assert.equal(app.launches[2].target, '_blank', 'unsupported destinations retain their original web link');
  assert.equal(app.timers.size, 0);
  for (const invalid of ['not a url', 'https://api.whatsapp.com.evil/send?phone=' + phone, 'https://api.whatsapp.com/other?phone=' + phone]) {
    assert.equal(app.context.whatsAppNativeChatUrl(invalid), '');
  }
});

test('the web fallback is accessible and fits mobile, tablet, laptop and Arabic layouts', { skip: !chromium && 'Playwright unavailable' }, async t => {
  const browser = await chromium.launch({ headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  const fixtureHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, link => {
    if (!/rel="stylesheet"/.test(link)) return '';
    const file = link.match(/href="([^"]+)"/)[1].split('?')[0];
    return `<style>${fs.readFileSync(path.join(root, file), 'utf8')}</style>`;
  });
  await page.setContent(fixtureHtml);
  await page.addScriptTag({ path: path.join(root, 'vendor/lucide.min.js') });
  await page.addScriptTag({ content: `let currentUiLanguage = 'en'; ${helper('showWhatsAppWebFallback')}` });
  await page.evaluate(() => document.getElementById('auth-gate').remove());
  for (const width of [390, 820, 1440]) for (const dir of ['ltr', 'rtl']) for (const scale of [.85, 1, 1.25]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(({ dir, scale }) => {
      document.querySelector('.whatsapp-web-fallback')?.remove();
      document.documentElement.dir = dir; currentUiLanguage = dir === 'rtl' ? 'ar' : 'en';
      document.documentElement.style.zoom = scale;
      document.documentElement.style.setProperty('--lumin-app-scale', scale);
      showWhatsAppWebFallback('https://web.whatsapp.com/send?phone=201001234567', () => document.querySelector('.whatsapp-web-fallback')?.remove());
    }, { dir, scale });
    const toast = page.locator('.whatsapp-web-fallback');
    await toast.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    const bounds = await toast.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, JSON.stringify({ width, dir, scale, bounds }));
    for (const element of [toast.locator('a'), toast.locator('button')]) {
      const box = await element.boundingBox();
      assert.ok(box.height >= 43.9 && box.width >= 43.9, JSON.stringify({ width, dir, scale, box }));
      assert.equal(await element.evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
    }
    assert.equal(await toast.locator('a').textContent(), dir === 'rtl' ? 'فتح واتساب ويب' : 'Open WhatsApp Web');
    await toast.locator('button').focus();
    await page.keyboard.press('Tab');
    assert.equal(await toast.locator('a').evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
    await toast.locator('button').click();
    assert.equal(await toast.count(), 0);
  }
  if (process.env.LUMIN_WHATSAPP_LAUNCH_PREVIEW_DIR) {
    fs.mkdirSync(process.env.LUMIN_WHATSAPP_LAUNCH_PREVIEW_DIR, { recursive: true });
    for (const [width, dir] of [[390, 'rtl'], [1440, 'ltr']]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(dir => {
        document.documentElement.dir = dir; currentUiLanguage = dir === 'rtl' ? 'ar' : 'en';
        document.documentElement.style.zoom = 1; document.documentElement.style.setProperty('--lumin-app-scale', 1);
        showWhatsAppWebFallback('https://web.whatsapp.com/send?phone=201001234567', () => {});
      }, dir);
      await page.locator('.whatsapp-web-fallback').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
      await page.screenshot({ path: path.join(process.env.LUMIN_WHATSAPP_LAUNCH_PREVIEW_DIR, `whatsapp-launch-${width}-${dir}.png`) });
      await page.evaluate(() => document.querySelector('.whatsapp-web-fallback').remove());
    }
  }
  assert.deepEqual(errors, []);
});
