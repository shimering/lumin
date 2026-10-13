const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = html.slice(start);
  return tail.slice(0, tail.indexOf('\n    }') + 6);
}

test('invoiced procedures and diagnosis fees never require manual salary transfer in either language', () => {
  const ctx = vm.createContext({ currentUiLanguage: 'en', hasPageAccess: () => true });
  vm.runInContext(source('invoiceDoctorSalaryActionMarkup'), ctx);
  for (const language of ['en', 'ar']) {
    ctx.currentUiLanguage = language;
    for (const status of ['eligible', 'transferred', 'paid', 'ineligible']) {
      const markup = ctx.invoiceDoctorSalaryActionMarkup({ id: 9, operationCode: 'diagnosis_fee', salaryTransfer: { transfer_status: status } });
      assert.doesNotMatch(markup, /<button|transferDoctorSalaryInvoiceItem/);
      if (status === 'transferred') assert.match(markup, language === 'ar' ? /تلقائياً/ : /Added to salary automatically/);
      if (status === 'paid') assert.match(markup, language === 'ar' ? /تم دفع الراتب/ : /Salary paid/);
    }
    const regular = ctx.invoiceDoctorSalaryActionMarkup({ id: 10, operationCode: 'filling', salaryTransfer: { transfer_status: 'eligible' } });
    assert.equal(regular, '');
    const included = ctx.invoiceDoctorSalaryActionMarkup({ id: 10, operationCode: 'filling', salaryTransfer: { transfer_status: 'transferred' } });
    assert.match(included, language === 'ar' ? /تلقائياً/ : /Added to salary automatically/);
    assert.doesNotMatch(included, /<button|transferDoctorSalaryInvoiceItem/);
  }
  ctx.hasPageAccess = () => false;
  assert.equal(ctx.invoiceDoctorSalaryActionMarkup({ id: 10, operationCode: 'filling', salaryTransfer: { transfer_status: 'eligible' } }), '');
});

test('successful fee saves invalidate HR totals and selected case caches without a second transfer RPC', async () => {
  const calls = [];
  const nodes = { 'diagnosis-fee-doctor': { value: 'doctor' }, 'diagnosis-fee-amount': { value: '400' }, 'diagnosis-fee-save-button': {} };
  const ctx = vm.createContext({ activeDiagnosisAppointmentId: 'appointment', activeDiagnosisFeeState: null,
    hasPageAccess: () => true, document: { getElementById: id => nodes[id] },
    db: { rpc: async (name, args) => { calls.push([name, args]); return { data: [{ created: true }] }; } },
    hrDirectoryLoaded: true, hrDoctorSettlementRangeKey: 'cached', dashboardInvoiceCache: new Map([['cached', true]]),
    setAdminMessage() {}, closeDiagnosisFeeModal() { ctx.activeDiagnosisAppointmentId = null; },
    renderDashboard() {}, showAppointmentNotificationToast() {}, formatInvoiceMoney: value => String(value) });
  vm.runInContext(source('saveDiagnosisFee'), ctx);
  await ctx.saveDiagnosisFee({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'add_assigned_diagnosis_fee_to_patient_invoice');
  assert.equal(ctx.hrDirectoryLoaded, false);
  assert.equal(ctx.hrDoctorSettlementRangeKey, '');
  assert.equal(ctx.dashboardInvoiceCache.size, 0);
});

test('local appointment saves invalidate diagnosis salary totals and cases immediately', () => {
  const ctx = vm.createContext({ normaliseAppointmentRecord: record => ({ date: record.date }),
    hrDirectoryLoaded: true, hrDoctorSettlementRangeKey: 'cached', appointmentSavedRecords: new Map(),
    appointmentWriteRevision: 0, dashboardDayCache: new Map() });
  vm.runInContext(source('rememberSavedAppointmentRecord'), ctx);
  ctx.rememberSavedAppointmentRecord({ id: 'appointment', date: '2026-10-13', status: 'Completed' });
  assert.equal(ctx.hrDirectoryLoaded, false);
  assert.equal(ctx.hrDoctorSettlementRangeKey, '');
});

test('appointment and invoice realtime events invalidate hidden HR caches and refresh an open doctor salary view', async () => {
  for (const visible of [false, true]) for (const table of ['appointments', 'patient_invoice_items']) {
    let directoryRefreshes = 0, caseRefreshes = 0;
    const ctx = vm.createContext({ currentSession: {}, currentUserAccess: {},
      realtimeRefreshInFlight: false, realtimeRefreshQueued: false, realtimePendingTables: new Set([table]),
      realtimeRefreshRetryCount: 0, realtimeHasSubscribed: false,
      REALTIME_INVOICE_TABLES: new Set(['patient_invoice_items']), REALTIME_ACCESS_TABLES: new Set(),
      REALTIME_LOYALTY_TABLES: new Set(), REALTIME_DENTAL_CUSTOMIZATION_TABLES: new Set(),
      REALTIME_EXPENSE_TABLES: new Set(), REALTIME_HR_TABLES: new Set(), REALTIME_IMPLANT_TABLES: new Set(), REALTIME_WHATSAPP_TABLES: new Set(),
      dashboardInvoiceCache: new Map(), dashboardDayCache: new Map(),
      appointmentVisitTypesLoaded: false, appointmentsLoaded: false, whatsappTemplatesLoaded: false,
      dentalCustomizationLoaded: false, patientProcedureState: {}, attendanceStateLoadedAt: 0,
      hrDirectoryLoaded: true, hrDoctorSettlementRangeKey: 'cached', activeHrDoctorDetailsId: 'doctor',
      hasPageAccess: page => page === 'hr', realtimeViewIsVisible: () => false,
      document: { getElementById: id => ({ classList: { contains: () => !(visible && id === 'view-hr') } }) },
      refreshHrDirectory: async () => { directoryRefreshes++; },
      loadHrDoctorSettlementCases: async () => { caseRefreshes++; }, console });
    vm.runInContext(source('flushRealtimeRefresh'), ctx);
    await ctx.flushRealtimeRefresh();
    assert.equal(ctx.realtimeRefreshRetryCount, 0);
    assert.equal(ctx.hrDirectoryLoaded, false);
    assert.equal(ctx.hrDoctorSettlementRangeKey, '');
    assert.equal(directoryRefreshes, visible ? 1 : 0);
    assert.equal(caseRefreshes, visible ? 1 : 0);
  }
});
