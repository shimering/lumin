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

test('tablet and mobile findings retain contained horizontal scrolling', () => {
  assert.match(html, /@media \(max-width: 899px\)[\s\S]*#findings-container\s*\{[\s\S]*overflow-x:\s*auto !important/);
  assert.match(html, /#findings-container \.finding-row\s*\{[\s\S]*min-width:\s*58\.5rem !important/);
});
