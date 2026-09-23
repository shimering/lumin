const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const theme = fs.readFileSync(path.join(root, 'lumin-theme.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

test('global typography uses the native bilingual UI font stack', () => {
  assert.match(theme, /--lumin-font-ui:\s*system-ui,[^;]*Segoe UI[^;]*Noto Sans Arabic[^;]*Tahoma[^;]*Arial/);
  assert.match(theme, /body,\s*\n\s*button,\s*\n\s*input,\s*\n\s*select,\s*\n\s*textarea,\s*\n\s*\.font-sans\s*\{\s*\n\s*font-family:\s*var\(--lumin-font-ui\)/);
});

test('shared utility sizes map to the Lumin semantic type scale', () => {
  for (const token of ['micro', 'caption', 'body', 'body-large', 'subheading', 'heading', 'display']) {
    assert.match(theme, new RegExp(`--lumin-type-${token}:`));
  }
  assert.match(theme, /\.text-\\\[8px\\\][\s\S]*font-size:\s*var\(--lumin-type-micro\)\s*!important/);
  assert.match(theme, /\.text-xs[\s\S]*font-size:\s*var\(--lumin-type-caption\)\s*!important/);
  assert.match(theme, /\.text-sm[\s\S]*font-size:\s*var\(--lumin-type-body\)\s*!important/);
});

test('iPad scale and touch-safe form text are defined at the app breakpoints', () => {
  assert.match(theme, /@media \(min-width: 768px\) and \(max-width: 1023px\)[\s\S]*--lumin-type-body:\s*0\.9375rem/);
  assert.match(theme, /@media \(max-width: 1023px\)[\s\S]*font-size:\s*1rem\s*!important/);
});

test('the updated theme is cache-busted in the page and service worker', () => {
  assert.match(html, /lumin-theme\.css\?v=16/);
  assert.match(serviceWorker, /lumin-dental-shell-v114/);
  assert.match(serviceWorker, /lumin-theme\.css\?v=16/);
});
