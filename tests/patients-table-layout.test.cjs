const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
const tableStart = html.indexOf('<table id="patients-table"');
const tableEnd = html.indexOf('</table>', tableStart);
const tableMarkup = html.slice(tableStart, tableEnd);
const queryStart = html.indexOf('function runPatientQuery()');
const queryEnd = html.indexOf('async function deletePatient(', queryStart);
const queryRenderer = html.slice(queryStart, queryEnd);

test('patient directory uses number, name, contact, and actions columns only', () => {
  assert.ok(tableStart >= 0 && tableEnd > tableStart);
  assert.match(tableMarkup, /patients-table-number-column[\s\S]*patients-table-name-column[\s\S]*patients-table-contact-column[\s\S]*patients-table-actions-column/);
  assert.match(tableMarkup, />Patient number<[\s\S]*>Patient name<[\s\S]*>Contact<[\s\S]*>Actions</);
  assert.doesNotMatch(tableMarkup, /Demographics|Medical Alerts & History|Charted Findings/);
  assert.match(tableMarkup, /colspan="4"/);
});

test('patient number is rendered in a separate cell before the enlarged patient name', () => {
  const numberCell = queryRenderer.indexOf("'Patient number'");
  const nameCell = queryRenderer.indexOf("'Patient name'");
  assert.ok(numberCell >= 0 && nameCell > numberCell);
  assert.match(queryRenderer, /patient-record-number text-sm font-black/);
  assert.match(queryRenderer, /patient-row-name block text-sm font-bold/);
  assert.doesNotMatch(queryRenderer, /countPatientFindings\(p\)|Conditions|patientAgeLabel\(p\)/);
});

test('every patient contact row includes call and WhatsApp controls', () => {
  assert.match(queryRenderer, /patient-directory-contact-actions[\s\S]*patientPhoneActionsMarkup\(p, 'primary'\)/);
  assert.match(html, /function patientProfilePhoneContext\(patientId,[\s\S]*?const patient = getKnownPatient\(patientId\);/);
  assert.match(html, /href="tel:\$\{escapeHtml\(callPhone\)\}"/);
  assert.match(html, /data-whatsapp-contact="patient-profile"/);
});

test('mobile patient row actions are icon-only and touch safe', () => {
  assert.match(html, /@media \(max-width: 767px\)[\s\S]*?#patients-table \.patient-action-label \{ display: none !important; \}/);
  assert.match(html, /#patients-table \.patient-row-action-button\s*\{[\s\S]*?width:\s*2\.75rem;[\s\S]*?height:\s*2\.75rem;/);
  assert.match(queryRenderer, /patient-row-action-button patient-invoice-button/);
  assert.match(queryRenderer, /patient-action-label patient-delete-label/);
});
