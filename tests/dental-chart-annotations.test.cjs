const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

test('specialty rail shows specialty names without procedure counts', () => {
  const start = html.indexOf('function renderChartSpecialtyRail()');
  const end = html.indexOf('function renderClinicalActionSelectors()', start);
  const renderer = html.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(renderer, /operationCount/);
  assert.doesNotMatch(renderer, /\$\{operationCount\}\s+procedure/);
});

test('selected procedure area omits the imported specialty description', () => {
  assert.doesNotMatch(html, /id="chart-selected-specialty-description"/);
  assert.doesNotMatch(html, /getElementById\('chart-selected-specialty-description'\)/);
});

test('odontogram teeth use larger art with tighter card spacing', () => {
  assert.match(html, /#upper-arch \.tooth-card,[\s\S]*?#lower-arch \.tooth-card\s*\{[\s\S]*?padding:\s*clamp\(2px, 0\.3vw, 5px\) 0;/);
  assert.match(html, /\.clinical-odontogram-stage \.tooth-card\s*\{[\s\S]*?gap:\s*0\.1rem;[\s\S]*?padding:\s*clamp\(2px, 0\.3vw, 5px\) 0;/);
  assert.match(html, /\.clinical-odontogram-stage \.odontogram-anatomy\s*\{[\s\S]*?width:\s*clamp\(44px, 4\.85vw, 66px\) !important;/);
  assert.match(html, /\.clinical-odontogram-stage \.odontogram-surface-view\s*\{[\s\S]*?width:\s*clamp\(40px, 4\.75vw, 64px\) !important;/);
  assert.match(html, /@media \(max-width: 899px\)[\s\S]*?width:\s*clamp\(42px, 11\.5vw, 52px\) !important;/);
});

test('selected Existed status keeps a white face with dark emphasis', () => {
  assert.match(html, /#action-palette-card \.operation-status-choice\.operation-status-e\.is-selected\s*\{[\s\S]*?color:\s*#0f172a;[\s\S]*?background:\s*#ffffff !important;/);
  assert.match(html, /selected \? \(status === 'E' \? '#ffffff' : OPERATION_STATUSES\[status\]\.color\) : ''/);
});
