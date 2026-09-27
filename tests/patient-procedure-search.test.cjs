const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'lumin-patients.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function helpers(overrides = {}) {
  const context = vm.createContext({
    Date, Map, Set, Intl, console,
    currentUiLanguage: 'en', ARABIC_UI_TEXT: {},
    collectDocumentedFindings: patient => patient.findings || [],
    dentalOperationLabel: code => ({ implant: 'Implant', filling: 'Filling' }[code] || code),
    normaliseOperationStatus: (value, fallback) => ['P', 'In', 'C', 'E'].includes(value) ? value : fallback,
    ...overrides
  });
  vm.runInContext(source, context);
  return vm.runInContext('({ patientProcedureRange, patientProcedureDate, patientProcedureDay, collectPatientProcedureRecords, filterPatientProcedureRecords, fetchPatientProcedurePages, canOpenPatientsPage, allowedPatientsTab, loadPatientProcedureRecords, patientProcedureOptionGroups, populatePatientProcedureOptions })', context);
}

test('procedure groups follow catalog categories and distinguish treatment families without losing old procedures', () => {
  const { patientProcedureOptionGroups } = helpers();
  const operations = [
    { code: 're-treat', name: 'Root canal re-treatment (molar)', specialtyId: 'endo' },
    { code: 'treat', name: 'Root canal treatment (anterior)', specialtyId: 'endo' },
    { code: 'comp', name: 'Composite filling (minimal)', specialtyId: 'restoration', active: false },
    { code: 'ionomer', name: 'Resin reinforced glass inomer', specialtyId: 'restoration' },
    { code: 'custom', name: 'Custom procedure', specialtyId: 'missing' }
  ];
  const records = [{ code: 'comp', name: 'Old invoice label' }, { code: 'legacy', name: 'Old treatment' }];
  const groups = patientProcedureOptionGroups(operations, records, [
    { id: 'endo', name: 'Endo', sortOrder: 2 }, { id: 'restoration', name: 'Restoration', sortOrder: 1 }
  ]);
  assert.deepEqual(Array.from(groups, group => [group.category, group.subcategory]), [
    ['Restoration', 'Composite restorations'], ['Restoration', 'Glass ionomer restorations'],
    ['Endo', 'Root canal retreatment'], ['Endo', 'Root canal treatment'],
    ['Other procedures', 'Other procedures'], ['Historical procedures', 'Other procedures']
  ]);
  assert.deepEqual(Array.from(groups.flatMap(group => group.procedures), operation => operation.code).sort(),
    ['comp', 'custom', 'ionomer', 'legacy', 're-treat', 'treat']);
  assert.equal(groups[0].procedures[0].name, 'Composite filling (minimal)');
});

test('Arabic groups translate category and family labels and prioritize braces over extraction mentioned in their names', () => {
  const { patientProcedureOptionGroups } = helpers({ currentUiLanguage: 'ar',
    dentalTranslate: name => ({ Orthodontics: 'تقويم الأسنان' }[name] || name) });
  const groups = patientProcedureOptionGroups([
    { code: 'ceramic', name: 'Traditional ceramic braces - Requires extraction', specialtyId: 'ortho' },
    { code: 'metal', name: 'تقويم معدني', specialtyId: 'ortho' }
  ], [], [{ id: 'ortho', name: 'Orthodontics' }]);
  assert.equal(groups.length, 2);
  assert.ok(groups.every(group => group.category === 'تقويم الأسنان'));
  assert.deepEqual(Array.from(groups, group => group.subcategory).sort(), ['التقويم السيراميكي', 'التقويم المعدني'].sort());
});

test('native grouped options escape catalog text and preserve the exact selected procedure across refreshes', () => {
  const select = { value: 'custom', innerHTML: '' };
  const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const { populatePatientProcedureOptions } = helpers({
    document: { getElementById: () => select }, escapeHtml,
    dentalOperations: [{ code: 'custom', name: '<Procedure "A">', specialtyId: 'special' }],
    dentalSpecialties: [{ id: 'special', name: 'Custom "category"' }]
  });
  populatePatientProcedureOptions();
  assert.equal(select.value, 'custom');
  assert.match(select.innerHTML, /<optgroup label="Custom &quot;category&quot; · Other procedures">/);
  assert.match(select.innerHTML, /&lt;Procedure &quot;A&quot;>/);
  assert.doesNotMatch(select.innerHTML, /<Procedure/);
  select.value = 'removed';
  populatePatientProcedureOptions();
  assert.equal(select.value, 'all');
});

const baseFilters = { from: '2026-09-01', to: '2026-09-30', code: 'implant', status: 'C' };
const patientA = { id: 'a', name: 'Patient A' };
const patientB = { id: 'b', name: 'Patient B' };

test('all filters apply to one procedure rather than separate findings on the patient', () => {
  const { filterPatientProcedureRecords } = helpers();
  const records = [
    { patient: patientA, code: 'implant', status: 'P', date: '2026-09-04', invoiced: false },
    { patient: patientA, code: 'filling', status: 'C', date: '2026-09-05', invoiced: true },
    { patient: patientA, code: 'implant', status: 'C', date: '2026-08-30', invoiced: true },
    { patient: patientB, code: 'implant', status: 'C', date: '2026-09-30', invoiced: false },
    { patient: patientB, code: 'implant', status: 'C', date: '2026-09-01', invoiced: true },
    { patient: patientB, code: 'implant', status: 'C', date: '', invoiced: false }
  ];
  const all = filterPatientProcedureRecords(records, baseFilters);
  assert.equal(all.length, 1);
  assert.equal(all[0].patient.id, 'b');
  assert.equal(all[0].procedures.length, 2);
  assert.deepEqual(Array.from(all[0].procedures, record => record.invoiced), [false, true]);
});

test('chart records take precedence over stale invoice status and dates without duplicates', () => {
  const { collectPatientProcedureRecords, filterPatientProcedureRecords } = helpers();
  const patient = { ...patientA, findings: [
    { id: 'linked', code: 'implant', status: 'C', createdAt: '2026-02-02', beginDate: '2026-04-01', completedAt: '2026-09-10', toothId: '7' },
    { id: 'unbilled', code: 'implant', status: 'C', completedAt: '2026-09-15' }
  ] };
  const invoice = { patient_id: 'a', invoice_date: '2026-06-01' };
  const rows = [
    { id: 1, finding_id: 'linked', operation_code: 'implant', operation_status: 'P', patient_invoices: invoice },
    { id: 2, finding_id: null, operation_code: 'filling', operation_name: 'Historical filling', operation_status: 'C', patient_invoices: [{ ...invoice, invoice_date: '2026-09-12' }] }
  ];
  const records = collectPatientProcedureRecords([patient], rows);
  assert.equal(records.length, 3);
  assert.equal(records[0].date, '2026-09-10');
  assert.equal(records[0].status, 'C');
  assert.equal(records[0].invoiced, true);
  assert.equal(records[1].invoiced, false);
  assert.equal(records[2].name, 'Historical filling');
  assert.equal(records[2].date, '2026-09-12');
  assert.equal(filterPatientProcedureRecords(records, baseFilters)[0].procedures.length, 2);
});

test('finding IDs are matched within their patient and invoice-only procedures remain searchable', () => {
  const { collectPatientProcedureRecords } = helpers();
  const patient = { ...patientA, findings: [{ id: 'shared-id', code: 'implant', status: 'P', createdAt: '2026-09-03' }] };
  const records = collectPatientProcedureRecords([patient, patientB], [
    { id: 9, finding_id: 'shared-id', operation_code: 'implant', operation_status: 'C', patient_invoices: { patient_id: 'b', invoice_date: '2026-09-09' } }
  ]);
  assert.equal(records.length, 2);
  assert.equal(records[0].invoiced, false);
  assert.equal(records[1].patient.id, 'b');
  assert.equal(records[1].invoiced, true);
});

test('batch members retain separate dates, statuses, and invoice states', () => {
  const { collectPatientProcedureRecords, filterPatientProcedureRecords } = helpers();
  const patient = { ...patientA, findings: [{ code: 'implant', status: 'P', memberFindings: [
    { id: 'first', code: 'implant', status: 'P', createdAt: '2026-08-03', toothId: '1' },
    { id: 'second', code: 'implant', status: 'C', completedAt: '2026-09-10', toothId: '2' }
  ] }] };
  const records = collectPatientProcedureRecords([patient], [{ id: 1, finding_id: 'first', patient_invoices: { patient_id: 'a', invoice_date: '2026-08-04' } }]);
  const matches = filterPatientProcedureRecords(records, baseFilters);
  assert.equal(matches[0].procedures.length, 1);
  assert.equal(matches[0].procedures[0].tooth, '2');
});

test('orthodontic visits are found and billed independently of their package', () => {
  const { collectPatientProcedureRecords } = helpers();
  const patient = { ...patientA, findings: [{ id: 'package', code: 'ortho', status: 'In', beginDate: '2026-01-01', orthoVisits: [
    { id: 'visit', date: '2026-09-04', status: 'C', visitNumber: 2 }
  ] }] };
  const records = collectPatientProcedureRecords([patient], [{ id: 1, finding_id: 'visit', patient_invoices: { patient_id: 'a', invoice_date: '2026-09-05' } }]);
  assert.equal(records.length, 2);
  assert.equal(records[0].invoiced, false);
  assert.equal(records[1].invoiced, true);
  assert.equal(records[1].date, '2026-09-04');
});

test('date presets clamp month ends and leap years without spilling into the next month', () => {
  const { patientProcedureRange, patientProcedureDay, patientProcedureDate } = helpers();
  assert.equal(patientProcedureRange('month', '', '', new Date(2026, 2, 31)).from, '2026-02-28');
  assert.equal(patientProcedureRange('month', '', '', new Date(2024, 2, 31)).from, '2024-02-29');
  assert.equal(patientProcedureRange('quarter', '', '', new Date(2026, 0, 31)).from, '2025-10-31');
  assert.equal(patientProcedureRange('year', '', '', new Date(2024, 1, 29)).from, '2023-02-28');
  assert.equal(patientProcedureDay('2026-02-31'), '');
  assert.equal(patientProcedureDay('not a date'), '');
  assert.equal(patientProcedureDate({ status: 'C', completedAt: 'bad', beginDate: '2026-08-01' }), '2026-08-01');
  assert.equal(patientProcedureDate({ status: 'P' }), '');
  assert.equal(patientProcedureDate({ status: 'P' }, '2026-09-01'), '2026-09-01');
});

test('paged data loader fetches beyond the API default row limit and stops on errors', async () => {
  const calls = [];
  const fixture = Array.from({ length: 1201 }, (_, id) => ({ id }));
  const { fetchPatientProcedurePages } = helpers({ db: { from(table) { return {
    select(fields) { calls.push({ table, fields }); return this; },
    order(column, options) { assert.equal(column, 'id'); assert.equal(options.ascending, true); return this; },
    async range(from, to) { calls.at(-1).range = [from, to]; return { data: fixture.slice(from, to + 1), error: null }; }
  }; } } });
  const rows = await fetchPatientProcedurePages('patient_invoice_items', 'id');
  assert.equal(rows.length, 1201);
  assert.deepEqual(calls.map(call => call.range), [[0, 499], [500, 999], [1000, 1499]]);
  const failed = helpers({ db: { from() { return { select() { return this; }, order() { return this; }, range: async () => ({ error: new Error('offline') }) }; } } });
  await assert.rejects(failed.fetchPatientProcedurePages('patients', 'id'), /offline/);
});

test('implant-only users can enter Patients without receiving Browse or Procedure Search access', () => {
  const { canOpenPatientsPage, allowedPatientsTab } = helpers({ hasPageAccess: key => key === 'implants' });
  assert.equal(canOpenPatientsPage(), true);
  assert.equal(allowedPatientsTab('implants'), true);
  assert.equal(allowedPatientsTab('browse'), false);
  assert.equal(allowedPatientsTab('procedures'), false);
});

test('all inline application scripts remain valid JavaScript', () => {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});

test('procedure-only search patients have working call and WhatsApp actions without loading Browse', () => {
  const patient = { id: 'search-patient', name: 'Search Patient', phone: '01012345678' };
  const context = vm.createContext({
    patients: [], patientDirectoryRows: [], currentUiLanguage: 'en',
    patientProcedureState: { patientsById: new Map([[patient.id, patient]]) },
    escapeHtml: value => String(value ?? '')
  });
  const snippets = [
    ['function getKnownPatient(', 'async function ensureKnownPatient('],
    ['function normaliseCallPhone(', 'function isMobileWhatsAppLongPressMode('],
    ['function patientProfilePhoneContext(', 'function patientWhatsAppTemplateEntry('],
    ['function patientPhoneActionsMarkup(', 'function openPatientProfileWhatsApp(']
  ];
  snippets.forEach(([start, end]) => vm.runInContext(html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start))), context));
  const markup = vm.runInContext("patientPhoneActionsMarkup(getKnownPatient('search-patient'))", context);
  assert.match(markup, /href="tel:01012345678"/);
  assert.match(markup, /data-patient-id="search-patient"/);
  assert.match(markup, /openPatientProfileWhatsApp\(event, this.dataset.patientId, this.dataset.phoneKind\)/);
  assert.doesNotMatch(markup, /disabled/);
  patient.phone = '';
  assert.equal((vm.runInContext("patientPhoneActionsMarkup(getKnownPatient('search-patient'))", context).match(/disabled/g) || []).length, 2);
  context.patientProcedureState.patientsById.clear();
  assert.equal(vm.runInContext("getKnownPatient('search-patient')", context), null);
});
