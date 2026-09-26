const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { create, isSupportedDevice } = require('../lumin-patient-swipe.js');

const devices = [
  ['iPhone', 'iPhone', 'iPhone', 5, 390, true],
  ['iPad portrait', 'iPad', 'iPad', 5, 820, true],
  ['iPad desktop identity in landscape', 'Macintosh Safari', 'MacIntel', 5, 1366, true],
  ['Android phone', 'Android Mobile', 'Linux arm', 5, 412, true],
  ['Android tablet landscape', 'Android Chrome', 'Linux arm', 10, 1280, true],
  ['Kindle tablet', 'Silk Tablet', 'Linux arm', 5, 1200, true],
  ['Windows desktop', 'Windows Chrome', 'Win32', 0, 1440, false],
  ['Narrow touch laptop', 'Windows Chrome', 'Win32', 10, 800, false],
  ['Mac desktop', 'Macintosh Safari', 'MacIntel', 0, 900, false],
  ['Chromebook', 'CrOS Chrome', 'Linux x86_64', 10, 1000, false],
  ['Linux touch desktop', 'X11 Chrome', 'Linux x86_64', 5, 900, false]
];
for (const [name, userAgent, platform, maxTouchPoints, width, expected] of devices) {
  test(`device restriction: ${name}`, () => assert.equal(isSupportedDevice({ userAgent, platform, maxTouchPoints, width }), expected));
}

class Element {
  constructor(classes = []) {
    this.classes = new Set(classes);
    this.classList = { contains: value => this.classes.has(value), add: value => this.classes.add(value), remove: value => this.classes.delete(value) };
    let properties = {};
    this.style = new Proxy({}, {
      get: (_, name) => name === 'cssText' ? JSON.stringify(properties) : properties[name] || '',
      set: (_, name, value) => { if (name === 'cssText') properties = JSON.parse(value); else properties[name] = value; return true; }
    });
    this.listeners = {};
    this.attributes = new Map();
    this.inert = false;
    this.scrollWidth = 300;
    this.clientWidth = 300;
    this.offsetHeight = 900;
    this.computed = { overflowX: 'visible', zoom: '1', paddingTop: '16', touchAction: 'auto' };
  }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  fire(type, event) { for (const handler of this.listeners[type] || []) handler(event); }
  closest() { return this.interactive ? this : null; }
  getBoundingClientRect() { return this.rect || { top: 16, left: 12, width: 390 }; }
  before(node) { this.placeholder = node; }
  remove() { this.removed = true; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
}

function fixture({ deviceEnabled = true, blocked = false, reducedMotion = false, back } = {}) {
  const surface = new Element();
  surface.parentElement = new Element();
  const target = new Element();
  target.parentElement = surface;
  const destination = new Element(['hidden']);
  destination.style.color = 'blue';
  destination.setAttribute('aria-hidden', 'original');
  const doc = new Element();
  doc.documentElement = new Element();
  doc.body = new Element();
  doc.documentElement.style.overflow = 'auto';
  doc.body.style.overflow = 'clip';
  doc.createElement = () => new Element();
  const timers = new Map();
  let clock = 0, backCount = 0, previewCount = 0;
  const win = new Element();
  Object.assign(win, {
    innerWidth: 390, innerHeight: 844, scrollX: 0, scrollY: 200,
    performance: { now: () => clock }, console,
    getComputedStyle: el => el.computed,
    matchMedia: () => ({ matches: reducedMotion }),
    setTimeout: (callback, delay) => { const id = timers.size + 1; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    scrollTo: (x, y) => { win.scrollX = x; win.scrollY = y; }
  });
  const api = create({ surface, win, doc, enabled: () => deviceEnabled, isBlocked: () => blocked,
    getDestination: () => { previewCount++; return destination; },
    onBack: async () => { backCount++; if (back) await back(api); win.scrollY = 0; surface.classList.add('hidden'); destination.classList.remove('hidden'); }
  });
  function event(x, y, touches = 1, cancelable = true) {
    return { target, touches: Array.from({ length: touches }, (_, identifier) => ({ identifier, clientX: x, clientY: y })), cancelable, prevented: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  }
  const start = () => surface.fire('touchstart', event(30, 200));
  const move = (dx, dy = 0, milliseconds = 100, touches = 1) => {
    clock += milliseconds; const e = event(30 + dx, 200 + dy, touches); surface.fire('touchmove', e); return e;
  };
  const end = () => { clock += 150; surface.fire('touchend', event(0, 0, 0)); };
  const flush = async () => { for (const [id, { callback }] of [...timers]) { timers.delete(id); await callback(); } };
  const restored = () => {
    assert.equal(surface.classList.contains('patient-swipe-source'), false);
    assert.equal(destination.classList.contains('patient-swipe-destination'), false);
    assert.equal(destination.style.color, 'blue');
    assert.equal(destination.style.transform, '');
    assert.equal(destination.inert, false);
    assert.equal(destination.getAttribute('aria-hidden'), 'original');
    assert.equal(doc.documentElement.style.overflow, 'auto');
    assert.equal(doc.body.style.overflow, 'clip');
    assert.equal(doc.body.classList.contains('patient-swipe-active'), false);
    if (surface.placeholder) assert.equal(surface.placeholder.removed, true);
  };
  return { surface, target, destination, win, doc, api, start, move, end, flush, restored, timers,
    backCount: () => backCount, previewCount: () => previewCount, setBlocked: value => { blocked = value; }, tick: ms => { clock += ms; } };
}

test('right drag reveals the live destination and commits Back exactly once', async () => {
  const f = fixture({ back: api => api.cancel() });
  f.start(); assert.equal(f.move(150).prevented, true);
  assert.equal(f.destination.inert, true);
  assert.equal(f.destination.classList.contains('hidden'), true, 'preview must not change application routing state');
  assert.equal(f.destination.classList.contains('patient-swipe-destination'), true);
  assert.match(f.destination.style.transform, /translate3d\(-/);
  assert.match(f.surface.style.transform, /150px/);
  f.end(); f.end(); await f.flush();
  assert.equal(f.backCount(), 1);
  assert.equal(f.win.scrollY, 0, 'new destination scroll position must survive cleanup');
  assert.equal(f.surface.classList.contains('hidden'), true);
  f.restored();
});

test('short drag snaps back, restores DOM and scroll, and suppresses accidental click', async () => {
  const f = fixture(); f.start(); f.move(35); f.end(); await f.flush();
  assert.equal(f.backCount(), 0); assert.equal(f.win.scrollY, 200); f.restored();
  const click = { detail: 1, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
  f.surface.fire('click', click); assert.equal(click.prevented, true);
  f.tick(600); const next = { ...click, prevented: false }; f.surface.fire('click', next); assert.equal(next.prevented, false);
});

test('fast right flick commits while a held short drag cancels', async () => {
  for (const [hold, expected] of [[0, 1], [150, 0]]) {
    const f = fixture(); f.start(); f.move(70, 0, 60); f.tick(hold);
    f.surface.fire('touchend', { touches: [], cancelable: true, preventDefault() {} });
    await f.flush(); assert.equal(f.backCount(), expected); f.restored();
  }
});

test('vertical scrolling and left swipes never prevent native behavior or reveal a destination', () => {
  for (const [dx, dy] of [[5, 30], [-60, 0]]) {
    const f = fixture(); f.start(); assert.equal(f.move(dx, dy).prevented, false);
    f.move(200); f.end(); assert.equal(f.previewCount(), 0); assert.equal(f.backCount(), 0); f.restored();
  }
});

test('desktop, controls, horizontal scroll regions and dialogs cannot start Back', () => {
  for (const mode of ['desktop', 'control', 'scroll', 'dialog']) {
    const f = fixture({ deviceEnabled: mode !== 'desktop', blocked: mode === 'dialog' });
    if (mode === 'control') f.target.interactive = true;
    if (mode === 'scroll') { f.target.computed.overflowX = 'auto'; f.target.scrollWidth = 600; }
    f.start(); assert.equal(f.move(200).prevented, false); f.end();
    assert.equal(f.previewCount(), 0); f.restored();
  }
});

test('pinch, touch cancellation, resize, hidden page, or routing change restore a live drag', async () => {
  for (const reason of ['pinch', 'touchcancel', 'resize', 'visibility', 'navigation', 'dialog']) {
    const f = fixture(); f.start(); f.move(150);
    if (reason === 'pinch') f.move(170, 0, 20, 2);
    if (reason === 'touchcancel') f.surface.fire('touchcancel', {});
    if (reason === 'resize') f.win.fire('resize', {});
    if (reason === 'visibility') { f.doc.hidden = true; f.doc.fire('visibilitychange', {}); }
    if (reason === 'navigation') { f.end(); f.api.cancel(); }
    if (reason === 'dialog') { f.setBlocked(true); f.move(170); }
    await f.flush(); assert.equal(f.backCount(), 0, reason); f.restored();
  }
});

test('reduced motion settles immediately, and application zoom preserves physical drag distance', async () => {
  const f = fixture({ reducedMotion: true });
  f.doc.documentElement.computed.zoom = '0.8';
  f.start(); f.move(150); assert.match(f.surface.style.transform, /187.5px/);
  f.end(); assert.equal([...f.timers.values()][0].delay, 0); await f.flush(); f.restored();
});

test('integration keeps patient sections in one swipe sheet and versions the offline asset', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8');
  assert.match(html, /<div id="patient-workspace-sheet" class="hidden">\s*<header id="patient-workspace-header"/);
  assert.match(html, /patient-workspace-sheet'\).classList.toggle\('hidden', patientWorkspaceHeader.classList.contains\('hidden'\)\)/);
  assert.match(html, /setupPatientWorkspaceSwipeBack\(\);/);
  assert.match(sw, /lumin-patient-swipe\.js\?v=1/);
});
