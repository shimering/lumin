const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

test('WhatsApp BSUID and Username validation, cleaning, and formatting helpers exist and work', () => {
  // Extract utility functions from index.html
  const context = vm.createContext({
    useTwelveHourTime: false,
    currentUiLanguage: 'en',
    patients: [],
    patientDirectoryRows: []
  });

  const helperFunctions = [
    'function isWhatsAppBsuid(',
    'function formatWhatsAppCode(',
    'function cleanWhatsAppCode(',
    'function cleanWhatsAppUsername(',
    'function isWhatsAppUsername(',
    'function formatWhatsAppContactDisplay(',
    'function normalizePatientPhone('
  ];

  for (const fn of helperFunctions) {
    const startIdx = html.indexOf(fn);
    assert.ok(startIdx !== -1, `Expected ${fn} to exist in index.html`);
  }

  // Run the snippet containing these functions
  const start = html.indexOf('function isWhatsAppBsuid(');
  const end = html.indexOf('const PATIENT_SELECT_FIELDS =', start);
  const snippet = html.slice(start, end);
  vm.runInContext(snippet, context);

  // 1. isWhatsAppBsuid
  assert.equal(context.isWhatsAppBsuid('EG.4631528857091458'), true);
  assert.equal(context.isWhatsAppBsuid('+EG.4631528857091458'), true);
  assert.equal(context.isWhatsAppBsuid('IQ.9876543210'), true);
  assert.equal(context.isWhatsAppBsuid('+US.1234567'), true);
  assert.equal(context.isWhatsAppBsuid('201001537371'), false);
  assert.equal(context.isWhatsAppBsuid('+201001537371'), false);
  assert.equal(context.isWhatsAppBsuid('dr_sarah'), false);
  assert.equal(context.isWhatsAppBsuid('@dr_sarah'), false);
  assert.equal(context.isWhatsAppBsuid(''), false);
  assert.equal(context.isWhatsAppBsuid(null), false);

  // 2. formatWhatsAppCode
  assert.equal(context.formatWhatsAppCode('EG.4631528857091458'), '+EG.4631528857091458');
  assert.equal(context.formatWhatsAppCode('+EG.4631528857091458'), '+EG.4631528857091458');
  assert.equal(context.formatWhatsAppCode(''), '');

  // 3. cleanWhatsAppCode
  assert.equal(context.cleanWhatsAppCode('+EG.4631528857091458'), 'EG.4631528857091458');
  assert.equal(context.cleanWhatsAppCode('EG.4631528857091458'), 'EG.4631528857091458');

  // 4. cleanWhatsAppUsername
  assert.equal(context.cleanWhatsAppUsername('@dr_sarah'), 'dr_sarah');
  assert.equal(context.cleanWhatsAppUsername('@@Dr_Sarah'), 'dr_sarah');
  assert.equal(context.cleanWhatsAppUsername('Clinic_Dental'), 'clinic_dental');
  assert.equal(context.cleanWhatsAppUsername(''), '');

  // 5. isWhatsAppUsername
  assert.equal(context.isWhatsAppUsername('@dr_sarah'), true);
  assert.equal(context.isWhatsAppUsername('dr_sarah'), true);
  assert.equal(context.isWhatsAppUsername('dental.clinic_2026'), true);
  assert.equal(context.isWhatsAppUsername('1234567890'), false);
  assert.equal(context.isWhatsAppUsername('+EG.4631528857091458'), false);
  assert.equal(context.isWhatsAppUsername('EG.4631528857091458'), false);

  // 6. formatWhatsAppContactDisplay
  assert.equal(context.formatWhatsAppContactDisplay('EG.4631528857091458'), '+EG.4631528857091458');
  assert.equal(context.formatWhatsAppContactDisplay('+EG.4631528857091458'), '+EG.4631528857091458');
  assert.equal(context.formatWhatsAppContactDisplay('@dr_sarah'), '@dr_sarah');
  assert.equal(context.formatWhatsAppContactDisplay('dr_sarah'), '@dr_sarah');
  assert.equal(context.formatWhatsAppContactDisplay('201001537371'), '+201001537371');
  assert.equal(context.formatWhatsAppContactDisplay('+201001537371'), '+201001537371');
});

test('resolvePatientForWhatsApp correctly matches patients by id, BSUID code, username, and phone', () => {
  const patient1 = {
    id: 'p-1',
    patientNumber: '1001',
    name: 'Sarah Connor',
    phone: '201001537371',
    whatsappUsername: 'sarah_c',
    whatsappCode: '+EG.4631528857091458'
  };
  const patient2 = {
    id: 'p-2',
    patientNumber: '1002',
    name: 'Omar Sherif',
    phone: '201223344556',
    whatsappUsername: '',
    whatsappCode: '+EG.9988776655443322'
  };
  const patient3 = {
    id: 'p-3',
    patientNumber: '1003',
    name: 'Layla Ahmed',
    phone: '',
    whatsappUsername: 'layla_ahmed',
    whatsappCode: ''
  };

  const context = vm.createContext({
    patients: [patient1, patient2, patient3],
    patientDirectoryRows: [],
    getKnownPatient: id => [patient1, patient2, patient3].find(p => p.id === id) || null
  });

  const snippet = html.slice(
    html.indexOf('function isWhatsAppBsuid('),
    html.indexOf('async function fetchPatientDirectoryPage()')
  );
  vm.runInContext(snippet, context);

  // Match by patient_id
  assert.equal(context.resolvePatientForWhatsApp({ patient_id: 'p-1' })?.id, 'p-1');
  assert.equal(context.resolvePatientForWhatsApp({ patient_id: 'p-3' })?.id, 'p-3');

  // Match unlinked conversation by BSUID code with or without leading +
  assert.equal(context.resolvePatientForWhatsApp({ phone: '+EG.4631528857091458' })?.id, 'p-1');
  assert.equal(context.resolvePatientForWhatsApp({ phone: 'EG.4631528857091458' })?.id, 'p-1');
  assert.equal(context.resolvePatientForWhatsApp({ phone: '+EG.9988776655443322' })?.id, 'p-2');

  // Match unlinked conversation by username with or without @
  assert.equal(context.resolvePatientForWhatsApp({ phone: '@sarah_c' })?.id, 'p-1');
  assert.equal(context.resolvePatientForWhatsApp({ phone: 'sarah_c' })?.id, 'p-1');
  assert.equal(context.resolvePatientForWhatsApp({ phone: '@layla_ahmed' })?.id, 'p-3');

  // Match unlinked conversation by phone number digits
  assert.equal(context.resolvePatientForWhatsApp({ phone: '201001537371' })?.id, 'p-1');
  assert.equal(context.resolvePatientForWhatsApp({ phone: '+20 100 153 7371' })?.id, 'p-1');
  assert.equal(context.resolvePatientForWhatsApp({ phone: '01001537371' })?.id, 'p-1');

  // Non-matching returns null
  assert.equal(context.resolvePatientForWhatsApp({ phone: '+EG.0000000000000000' }), null);
  assert.equal(context.resolvePatientForWhatsApp({ phone: '@unknown_user' }), null);
});

test('mergePatientSearchValue indexes WhatsApp username and BSUID code for quick search and deduplication', () => {
  const context = vm.createContext({});

  const snippet = html.slice(
    html.indexOf('function mergePatientSearchValue('),
    html.indexOf('function renderMergePatientCandidates(')
  );
  vm.runInContext(snippet, context);

  const patient = {
    patientNumber: '1042',
    name: 'Dr. Tariq',
    phone: '01001234567',
    secondaryPhone: '',
    whatsappUsername: 'tariq_dental',
    whatsappCode: '+EG.4631528857091458'
  };

  const indexed = context.mergePatientSearchValue(patient);
  assert.ok(indexed.includes('tariq_dental'));
  assert.ok(indexed.includes('4631528857091458'));
  assert.ok(indexed.includes('+eg.4631528857091458'));
});

test('patient form modal contains whatsapp-username and whatsapp-code inputs with accessible attributes', () => {
  assert.match(html, /id="form-whatsapp-username"/);
  assert.match(html, /id="form-whatsapp-code"/);
  assert.match(html, /placeholder="e\.g\. \+EG\.4631528857091458"/);
});

test('normalisePatientRecord parses whatsappUsername and whatsappCode', () => {
  const context = vm.createContext({
    patientNumberValue: v => v ?? '',
    normalizePatientPhone: p => p ?? ''
  });

  const snippet = html.slice(
    html.indexOf('function normalisePatientRecord('),
    html.indexOf('function getKnownPatient(')
  );
  vm.runInContext(snippet, context);

  const record = context.normalisePatientRecord({
    id: 'test-1',
    patient_number: '55',
    name: 'Test Patient',
    whatsapp_username: 'test_user',
    whatsapp_code: '+EG.123456'
  });

  assert.equal(record.whatsappUsername, 'test_user');
  assert.equal(record.whatsappCode, '+EG.123456');
});
