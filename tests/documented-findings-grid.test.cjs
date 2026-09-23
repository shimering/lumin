const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

test('desktop documented findings use a shared two-region row grid', () => {
  assert.match(html, /@media \(min-width: 900px\)[\s\S]*#findings-container \.finding-row:not\(\.has-ortho-visits\)\s*\{[\s\S]*display:\s*grid !important/);
  assert.match(html, /grid-template-columns:\s*minmax\(var\(--finding-summary-min\), 1fr\) max-content/);
  assert.match(html, /--finding-row-min-width:\s*86\.5rem/);
});

test('finding action controls are assigned stable semantic columns', () => {
  const expectedColumns = [
    ['finding-dates-group', 1],
    ['finding-doctor-control', 2],
    ['finding-pricing-group', 3],
    ['finding-status-control', 4],
    ['finding-separate-button', 5],
    ['finding-note-button', 6],
    ['finding-delete-button', 7]
  ];

  for (const [className, column] of expectedColumns) {
    assert.match(html, new RegExp(`#findings-container \\.${className}\\s*\\{[\\s\\S]*?grid-column:\\s*${column}`));
  }
});

test('conditional batch and expandable rows preserve the column contract', () => {
  assert.match(html, /class="finding-separate-button inline-flex/);
  assert.match(html, /\.finding-row\.has-procedure-steps > \[data-procedure-steps-panel\][\s\S]*grid-column:\s*1 \/ -1/);
  assert.match(html, /\.finding-row\.has-ortho-visits \.finding-row-main[\s\S]*display:\s*grid !important/);
});

test('tablet and mobile findings use one fixed card length with contained scrolling', () => {
  assert.match(html, /@media \(max-width: 899px\)[\s\S]*#findings-container\s*\{[\s\S]*overflow-x:\s*auto !important/);
  assert.match(html, /--finding-mobile-row-width:\s*70rem/);
  assert.match(html, /@media \(min-width: 640px\) and \(max-width: 899px\)[\s\S]*--finding-mobile-row-width:\s*83rem/);
  assert.match(html, /#findings-container \.finding-row\s*\{[\s\S]*grid-template-columns:\s*var\(--finding-mobile-summary\) max-content/);
  assert.match(html, /#findings-container \.finding-row\.is-batch-finding\s*\{[\s\S]*width:\s*var\(--finding-mobile-row-width\) !important/);
  assert.match(html, /#findings-container \.finding-row\.has-procedure-steps\s*\{[\s\S]*width:\s*var\(--finding-mobile-row-width\) !important/);
  assert.match(html, /#findings-container \.finding-row\.has-ortho-visits\s*\{[\s\S]*width:\s*var\(--finding-mobile-row-width\) !important/);
});

test('mobile summaries cannot overlap the date column', () => {
  assert.match(html, /#findings-container \.finding-row-summary\s*\{[\s\S]*max-width:\s*var\(--finding-mobile-summary\) !important;[\s\S]*overflow:\s*hidden !important/);
  assert.match(html, /#findings-container \.finding-row-actions\s*\{[\s\S]*grid-template-columns:[\s\S]*var\(--finding-mobile-dates\)[\s\S]*var\(--finding-mobile-delete\)/);
});

test('mobile price controls keep the horizontal desktop shape', () => {
  assert.match(html, /#findings-container \.finding-price-control\s*\{[\s\S]*flex-direction:\s*row !important;[\s\S]*height:\s*2\.75rem !important/);
  assert.match(html, /#findings-container \.finding-price-control input\s*\{[\s\S]*height:\s*100% !important;[\s\S]*flex:\s*1 1 auto !important/);
});
