const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('clinical action catalog exposes category and procedure creation buttons', () => {
  assert.match(html, /onclick="openDentalSpecialtyDialog\(\)"[^>]*aria-controls="modal-dental-specialty-form"/);
  assert.match(html, /id="admin-open-operation-dialog-button"[^>]*onclick="openDentalOperationDialog\(\)"[^>]*aria-controls="modal-dental-operation-form"/);
});

test('dental customization forms are modal dialogs instead of page cards', () => {
  const specialtyLayer = html.indexOf('id="modal-dental-specialty-form"');
  const specialtyForm = html.indexOf('id="admin-dental-specialty-form"');
  const operationLayer = html.indexOf('id="modal-dental-operation-form"');
  const operationForm = html.indexOf('id="admin-dental-operation-form"');

  assert.ok(specialtyLayer >= 0 && specialtyForm > specialtyLayer, 'specialty form is inside its modal layer');
  assert.ok(operationLayer >= 0 && operationForm > operationLayer, 'operation form is inside its modal layer');
  assert.match(html.slice(specialtyForm, operationLayer), /role="dialog" aria-modal="true"/);
  assert.match(html.slice(operationForm, html.indexOf('</section>', operationForm)), /role="dialog" aria-modal="true"/);
});

test('admin dental dialogs include mobile sheet and accessible interaction behavior', () => {
  assert.match(html, /\.admin-dental-dialog-layer\s*\{[\s\S]*?align-items: flex-end;/);
  assert.match(html, /@media \(min-width: 640px\)[\s\S]*?\.admin-dental-dialog-layer\s*\{[\s\S]*?align-items: center;/);
  assert.match(html, /padding-bottom:max\(1rem, env\(safe-area-inset-bottom\)\)/);
  assert.match(html, /function handleAdminDentalDialogKeydown\(event, dialogType\)/);
  assert.match(html, /if \(event\.key === 'Escape'\)/);
});

test('existing add and edit actions open the new dialogs', () => {
  const editSpecialty = html.slice(html.indexOf('function editDentalSpecialty('), html.indexOf('function editDentalOperation('));
  const editOperation = html.slice(html.indexOf('function editDentalOperation('), html.indexOf('async function saveDentalSpecialty('));
  const addOperation = html.slice(html.indexOf('function startDentalOperationForSpecialty('), html.indexOf('function renderAdminDentalCustomization('));

  assert.match(editSpecialty, /showAdminDentalDialog\('modal-dental-specialty-form'/);
  assert.match(editOperation, /showAdminDentalDialog\('modal-dental-operation-form'/);
  assert.match(addOperation, /openDentalOperationDialog\(specialtyId\)/);
  assert.doesNotMatch(`${editSpecialty}${editOperation}${addOperation}`, /scrollIntoView/);
});
