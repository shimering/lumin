/* Patient sections and procedure search. Uses the application's authenticated client. */
const PATIENTS_UI_AR = Object.freeze({
  'Browse': 'تصفح', 'Procedure Search': 'البحث بالإجراءات', 'Patient sections': 'أقسام المرضى',
  'Find patients by procedure': 'البحث عن المرضى حسب الإجراء',
  'Match treatment dates, procedures, and clinical status across all patients.': 'ابحث حسب تاريخ العلاج والإجراء والحالة السريرية بين جميع المرضى.',
  'Time range': 'الفترة الزمنية', 'Last month': 'آخر شهر', 'Last 3 months': 'آخر ٣ أشهر',
  'Last year': 'آخر سنة', 'Custom range': 'فترة مخصصة', 'All procedures': 'جميع الإجراءات',
  'Other procedures': 'إجراءات أخرى', 'Historical procedures': 'إجراءات سابقة',
  'Grouped by category and treatment type.': 'مرتبة حسب التخصص ونوع العلاج.',
  'Bleaching': 'تبييض الأسنان', 'Veneers': 'قشور تجميلية', 'Smile appliances': 'أجهزة تجميل الابتسامة',
  'Crowns': 'تيجان الأسنان', 'Cementation': 'تثبيت التركيبات', 'Inlays and onlays': 'إنلاي وأونلاي',
  'Imaging': 'الأشعة', 'Examinations and consultations': 'الكشف والاستشارات', 'Laboratory tests': 'التحاليل',
  'Root canal treatment': 'علاج الجذور', 'Root canal retreatment': 'إعادة علاج الجذور',
  'Pulp therapy': 'علاج لب الأسنان', 'Abscess treatment': 'علاج الخراج',
  'Implants': 'زراعة الأسنان', 'Bone grafting': 'زراعة العظم',
  'Clear aligners': 'التقويم الشفاف', 'Ceramic braces': 'التقويم السيراميكي', 'Metal braces': 'التقويم المعدني',
  'Orthodontic follow-up': 'متابعة التقويم', 'Orthodontic appliances': 'أجهزة التقويم',
  'Cleaning and polishing': 'التنظيف والتلميع', 'Gum treatment': 'علاج اللثة',
  'Dentures': 'أطقم الأسنان', 'Night guards': 'واقيات ليلية',
  'Composite restorations': 'حشوات الكومبوزيت', 'Glass ionomer restorations': 'حشوات الجلاس أيونومر',
  'Amalgam restorations': 'حشوات الأملجم', 'Posts and cores': 'الأوتاد وبناء السن',
  'Preventive treatments': 'علاجات وقائية', 'Extractions': 'خلع الأسنان', 'Oral surgery': 'جراحة الفم',
  'Procedure status': 'حالة الإجراء', 'All statuses': 'جميع الحالات',
  'Planned': 'مخطط', 'In progress': 'قيد العلاج', 'Completed': 'مكتمل', 'Existed': 'موجود سابقاً',
  'From date': 'من تاريخ', 'To date': 'إلى تاريخ',
  'Reset filters': 'إعادة ضبط الفلاتر', 'Find patients': 'البحث عن المرضى',
  'Matching patients': 'المرضى المطابقون', 'Refresh procedure records': 'تحديث سجلات الإجراءات',
  'Previous patients': 'المرضى السابقون', 'Next patients': 'المرضى التاليون',
  'Swipe horizontally to view all filters and procedure details.': 'اسحب أفقياً لعرض جميع الفلاتر وتفاصيل الإجراءات.',
  'Loading procedure records…': 'جارٍ تحميل سجلات الإجراءات…',
  'Search across your patients': 'ابحث بين مرضاك',
  'Choose a time range, procedure, and status to find matching patients.': 'اختر الفترة والإجراء والحالة للعثور على المرضى المطابقين.',
  'No patients match these filters': 'لا يوجد مرضى يطابقون هذه الفلاتر',
  'Try a wider date range or include all procedure statuses.': 'جرّب فترة أطول أو اختر جميع حالات الإجراءات.',
  'Could not load procedure records': 'تعذر تحميل سجلات الإجراءات',
  'Check your connection and try again.': 'تحقق من الاتصال ثم حاول مرة أخرى.',
  'Try again': 'إعادة المحاولة', 'Invoiced': 'بفاتورة', 'Uninvoiced': 'بدون فاتورة',
  'Open patient': 'فتح المريض', 'Open chart': 'فتح المخطط',
  'Choose both dates for the custom range.': 'اختر تاريخ البداية والنهاية للفترة المخصصة.',
  'The start date must be on or before the end date.': 'يجب أن يكون تاريخ البداية قبل تاريخ النهاية أو مطابقاً له.',
  'Filters changed. Select Find patients to apply them.': 'تغيرت الفلاتر. اضغط البحث عن المرضى لتطبيقها.'
});

let activePatientsTab = 'browse';
let patientProcedureState = newPatientProcedureState();

function newPatientProcedureState() {
  return { records: [], patientsById: new Map(), loaded: false, loadPromise: null, request: 0, results: null, page: 1, error: false };
}

function patientsText(text) {
  return currentUiLanguage === 'ar' ? (PATIENTS_UI_AR[text] || ARABIC_UI_TEXT[text] || text) : text;
}

function canOpenPatientsPage() {
  return hasPageAccess('patients') || hasPageAccess('implants');
}

function allowedPatientsTab(tab) {
  return tab === 'implants' ? hasPageAccess('implants') : ['browse', 'procedures'].includes(tab) && hasPageAccess('patients');
}

async function switchPatientsTab(tab = activePatientsTab) {
  const tabs = ['browse', 'implants', 'procedures'];
  const next = allowedPatientsTab(tab) ? tab : tabs.find(allowedPatientsTab);
  if (!next) return;
  activePatientsTab = next;
  const page = document.getElementById('view-patients');
  const implants = document.getElementById('view-implants');
  if (implants.parentElement !== page) {
    page.appendChild(implants);
    implants.setAttribute('role', 'tabpanel');
    implants.setAttribute('aria-labelledby', 'patients-tab-implants');
  }
  tabs.forEach(candidate => {
    const button = document.getElementById(`patients-tab-${candidate}`);
    button.classList.toggle('hidden', !allowedPatientsTab(candidate));
    button.setAttribute('aria-selected', String(next === candidate));
    button.tabIndex = next === candidate ? 0 : -1;
    const panel = document.getElementById(candidate === 'implants' ? 'view-implants' : `patients-panel-${candidate}`);
    panel.classList.toggle('hidden', next !== candidate);
  });
  page.dataset.patientsTab = next;
  schedulePatientQueryViewportUpdate();
  if (window.lucide) lucide.createIcons();
  if (next === 'browse') {
    await ensurePatientDirectoryPageLoaded();
    if (activePatientsTab === next) runPatientQuery();
  } else if (next === 'implants') {
    await refreshImplantProgress();
  } else {
    updatePatientProcedureRange();
    if (!patientProcedureState.loaded) await searchPatientProcedures();
    else { populatePatientProcedureOptions(); renderPatientProcedureResults(); }
  }
}

function handlePatientsTabKeydown(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = ['browse', 'implants', 'procedures'].filter(allowedPatientsTab);
  const current = tabs.indexOf(activePatientsTab);
  const direction = document.documentElement.dir === 'rtl' ? -1 : 1;
  const offset = event.key === 'ArrowRight' ? direction : -direction;
  const target = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs[(current + offset + tabs.length) % tabs.length];
  event.preventDefault();
  void switchPatientsTab(target);
  document.getElementById(`patients-tab-${target}`)?.focus();
}

function resetPatientsPageState() {
  activePatientsTab = 'browse';
  patientProcedureState.request += 1;
  patientProcedureState = newPatientProcedureState();
  document.getElementById('patient-procedure-code').innerHTML = '<option value="all">All procedures</option>';
  setPatientProcedureLoading(false);
  resetPatientProcedureFilters(false);
  document.getElementById('patient-procedure-count').textContent = '';
  document.getElementById('patient-procedure-message').textContent = '';
  renderPatientProcedureResults();
}

function patientProcedureDay(value) {
  if (!value) return '';
  // Keep SQL date-only values intact; timestamps use the clinic device's local day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const date = new Date(`${value}T12:00:00`);
    return Number.isFinite(date.getTime()) && patientProcedureDay(date) === value ? value : '';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function patientProcedureRange(period, from = '', to = '', now = new Date()) {
  if (period === 'custom') return { from: patientProcedureDay(from), to: patientProcedureDay(to) };
  const months = { month: 1, quarter: 3, year: 12 }[period] || 1;
  const start = new Date(now.getFullYear(), now.getMonth() - months, 1, 12);
  const lastDay = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  start.setDate(Math.min(now.getDate(), lastDay));
  return { from: patientProcedureDay(start), to: patientProcedureDay(now) };
}

function patientProcedureDate(record, invoiceDate = '') {
  const values = record.status === 'C'
    ? [record.completedAt, record.beginDate, record.createdAt, invoiceDate]
    : [record.beginDate, record.createdAt, invoiceDate];
  return values.map(patientProcedureDay).find(Boolean) || '';
}

function formatPatientProcedureDay(value) {
  return value ? new Intl.DateTimeFormat(currentUiLanguage === 'ar' ? 'ar-EG' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${value}T12:00:00`)) : '—';
}

function readPatientProcedureFilters() {
  const get = id => document.getElementById(`patient-procedure-${id}`).value;
  return { ...patientProcedureRange(get('period'), get('from'), get('to')), code: get('code'), status: get('status') };
}

function updatePatientProcedureDateBounds() {
  const from = document.getElementById('patient-procedure-from');
  const to = document.getElementById('patient-procedure-to');
  to.min = from.value;
  from.max = to.value;
  updatePatientProcedureRange();
}

function updatePatientProcedureRange() {
  const custom = document.getElementById('patient-procedure-period').value === 'custom';
  document.getElementById('patient-procedure-custom-range').classList.toggle('hidden', !custom);
  ['from', 'to'].forEach(name => {
    const input = document.getElementById(`patient-procedure-${name}`);
    input.required = custom;
    input.disabled = !custom;
  });
  const range = readPatientProcedureFilters();
  document.getElementById('patient-procedure-range-summary').textContent = range.from && range.to ? `${formatPatientProcedureDay(range.from)} – ${formatPatientProcedureDay(range.to)}` : '';
}

function patientProcedureFiltersChanged() {
  if (patientProcedureState.loaded || patientProcedureState.loadPromise) void searchPatientProcedures();
}

function resetPatientProcedureFilters(search = true) {
  ['code', 'status'].forEach(name => { document.getElementById(`patient-procedure-${name}`).value = 'all'; });
  document.getElementById('patient-procedure-period').value = 'month';
  const range = patientProcedureRange('month');
  document.getElementById('patient-procedure-from').value = range.from;
  document.getElementById('patient-procedure-to').value = range.to;
  updatePatientProcedureDateBounds();
  if (search) void searchPatientProcedures();
}

// Read top-level items instead of nested invoice collections so pagination includes every item.
async function fetchPatientProcedurePages(table, fields) {
  const rows = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db.from(table).select(fields).order('id', { ascending: true }).range(offset, offset + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < pageSize) return rows;
  }
}

function collectPatientProcedureRecords(patientRows, invoiceRows) {
  const records = [];
  const knownPatients = new Map(patientRows.map(patient => [patient.id, patient]));
  const itemsByFinding = new Map();
  invoiceRows.forEach(item => {
    const invoice = Array.isArray(item.patient_invoices) ? item.patient_invoices[0] : item.patient_invoices;
    if (!invoice?.patient_id || !item.finding_id) return;
    const key = `${invoice.patient_id}:${item.finding_id}`;
    if (!itemsByFinding.has(key)) itemsByFinding.set(key, []);
    itemsByFinding.get(key).push({ item, invoice });
  });
  const matchedItems = new Set();
  patientRows.forEach(patient => {
    // Flatten batches: each member keeps its own status, date, and invoice link.
    collectDocumentedFindings(patient).forEach(group => {
      const members = group.memberFindings || [group];
      members.forEach(finding => {
        if (['healthy', 'none'].includes(finding.code) || finding.isProcedureStep) return;
        const linked = itemsByFinding.get(`${patient.id}:${finding.id}`) || [];
        linked.forEach(({ item }) => matchedItems.add(item.id));
        records.push({ patient, id: finding.id, code: finding.code, name: dentalOperationLabel(finding.code), status: finding.status,
          date: patientProcedureDate(finding, linked[0]?.invoice.invoice_date), tooth: finding.toothId || '', invoiced: linked.length > 0 });
      });
      // Orthodontic visits are billed by visit ID, independently of their parent package.
      (group.orthoVisits || []).forEach(visit => {
        const linked = itemsByFinding.get(`${patient.id}:${visit.id}`) || [];
        linked.forEach(({ item }) => matchedItems.add(item.id));
        records.push({ patient, id: visit.id, code: group.code, name: dentalOperationLabel(group.code), status: visit.status,
          date: patientProcedureDay(visit.date || visit.createdAt), tooth: group.toothId || '', invoiced: linked.length > 0, visitNumber: visit.visitNumber });
      });
    });
  });
  invoiceRows.forEach(item => {
    if (matchedItems.has(item.id)) return;
    const invoice = Array.isArray(item.patient_invoices) ? item.patient_invoices[0] : item.patient_invoices;
    const patient = knownPatients.get(invoice?.patient_id);
    if (!patient) return;
    records.push({ patient, id: item.finding_id || `invoice-item-${item.id}`, code: item.operation_code || `operation-${item.operation_id || item.operation_name}`,
      name: item.operation_name || dentalOperationLabel(item.operation_code), status: normaliseOperationStatus(item.operation_status, 'P'),
      date: patientProcedureDay(invoice.invoice_date || item.created_at), tooth: item.tooth_id || '', invoiced: true });
  });
  return records;
}

function filterPatientProcedureRecords(records, filters) {
  const groups = new Map();
  records.forEach(record => {
    if (!record.date || record.date < filters.from || record.date > filters.to
      || (filters.code !== 'all' && record.code !== filters.code)
      || (filters.status !== 'all' && record.status !== filters.status)) return;
    if (!groups.has(record.patient.id)) groups.set(record.patient.id, { patient: record.patient, procedures: [] });
    groups.get(record.patient.id).procedures.push(record);
  });
  return [...groups.values()].map(group => ({ ...group, procedures: group.procedures.sort((a, b) => b.date.localeCompare(a.date)) }))
    .sort((a, b) => b.procedures[0].date.localeCompare(a.procedures[0].date) || String(a.patient.name).localeCompare(String(b.patient.name)));
}

async function loadPatientProcedureRecords(state) {
  if (!state.loadPromise) {
    state.loadPromise = (async () => {
      const [patientRows, invoiceRows] = await Promise.all([
        fetchPatientProcedurePages('patients', 'id, patient_number, legacy_patient_id, name, phone, secondary_phone, chart_state'),
        fetchPatientProcedurePages('patient_invoice_items', 'id, finding_id, operation_id, operation_code, operation_name, operation_status, tooth_id, created_at, patient_invoices!inner(patient_id, invoice_date)'),
        ensureDentalCustomizationLoaded()
      ]);
      const normalisedPatients = patientRows.map(normalisePatientRecord);
      state.patientsById = new Map(normalisedPatients.map(patient => [patient.id, patient]));
      state.records = collectPatientProcedureRecords(normalisedPatients, invoiceRows);
      state.loaded = true;
    })().finally(() => { state.loadPromise = null; });
  }
  await state.loadPromise;
}

function patientProcedureName(record) {
  return currentUiLanguage === 'ar' ? dentalTranslate(record.name, 'ar') : record.name;
}

// The catalog stores specialties, but no subcategory field. Treatment families
// organize its existing names without changing procedure codes or catalog data.
const PATIENT_PROCEDURE_FAMILIES = [
  ['Orthodontic follow-up', /ortho.*follow|follow.*ortho|متابعة.*تقويم/iu],
  ['Clear aligners', /invisalign|aligner|k\s*line|تقويم.*شفاف|إنفزلاين/iu],
  ['Ceramic braces', /ceramic.*braces|braces.*ceramic|تقويم.*سيراميك/iu],
  ['Metal braces', /metal.*braces|braces.*metal|تقويم.*معدني/iu],
  ['Orthodontic appliances', /bracket|braces|orthodont|براكيت|تقويم/iu],
  ['Cementation', /cement|تثبيت.*(?:تاج|تركيب)/iu],
  ['Veneers', /veneer|فينير|قشور/iu],
  ['Inlays and onlays', /inlay|onlay|overlay|إنلاي|أونلاي|أوفرلاي/iu],
  ['Crowns', /crown|zircomax|zircon|كراون|تاج|زركون/iu],
  ['Root canal retreatment', /(?:root\s*canal|endo).*re\s*treat|إعادة.*(?:جذور|عصب)/iu],
  ['Root canal treatment', /root\s*canal|\bendo\b|علاج.*(?:جذور|عصب)/iu],
  ['Pulp therapy', /pulp|عصب.*مباشر|تغطية.*عصب|لب.*الأسنان/iu],
  ['Abscess treatment', /abscess|خراج/iu],
  ['Bone grafting', /bone.*graft|زراعة.*عظم/iu],
  ['Implants', /implant|fixture|زرع|زراعة/iu],
  ['Bleaching', /bleach|whiten|تبييض/iu],
  ['Smile appliances', /snap\s*on|سناب|ابتسامة.*متحركة/iu],
  ['Imaging', /x\s*ray|conebeam|\bcbct\b|أشعة/iu],
  ['Laboratory tests', /blood|lab.*test|تحليل|تحاليل/iu],
  ['Examinations and consultations', /diagnos|examin|consult|كشف|فحص|تشخيص|استشارة/iu],
  ['Cleaning and polishing', /scal|clean|polish|تنظيف|تلميع/iu],
  ['Gum treatment', /gingiv|gum|periodontal|operculect|\bprf\b|لثة|لثوي/iu],
  ['Night guards', /night\s*guard|واقي.*ليلي/iu],
  ['Dentures', /denture|removable|طقم|أطقم|تركيبة.*متحرك/iu],
  ['Posts and cores', /post.*core|وتد|أوتاد/iu],
  ['Glass ionomer restorations', /(?:glass|g\s*\.)\s*i(?:o)?nomer|جلاس|أيونومر|أينومر/iu],
  ['Amalgam restorations', /amalgam|أملجم/iu],
  ['Composite restorations', /composite|كومبوزيت/iu],
  ['Preventive treatments', /sealant|fluoride|وقائي|فلورايد/iu],
  ['Extractions', /extract|خلع/iu],
  ['Oral surgery', /cyst|excision|استئصال|كيس.*فك/iu]
];

function patientProcedureFamily(operation) {
  const name = `${operation.name || ''} ${operation.code || ''}`.replace(/[_-]+/g, ' ');
  return PATIENT_PROCEDURE_FAMILIES.find(([, pattern]) => pattern.test(name))?.[0] || 'Other procedures';
}

function patientProcedureOptionGroups(operations, records, specialties) {
  const options = new Map(operations.filter(operation => operation.code).map(operation => [operation.code, operation]));
  records.forEach(record => { if (record.code && !options.has(record.code)) options.set(record.code, record); });
  const categoryOrder = [...specialties].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)
    || patientProcedureName(a).localeCompare(patientProcedureName(b), currentUiLanguage));
  const catalogCodes = new Set(operations.map(operation => operation.code));
  const categories = new Map(categoryOrder.map(category => [category.id, { name: patientProcedureName(category), groups: new Map() }]));
  const other = { name: patientsText('Other procedures'), groups: new Map() };
  const historical = { name: patientsText('Historical procedures'), groups: new Map() };
  options.forEach(operation => {
    const category = categories.get(operation.specialtyId) || (catalogCodes.has(operation.code) ? other : historical);
    const family = patientProcedureFamily(operation);
    if (!category.groups.has(family)) category.groups.set(family, []);
    category.groups.get(family).push(operation);
  });
  return [...categories.values(), other, historical].flatMap(category => [...category.groups]
    .sort(([a], [b]) => a === 'Other procedures' ? 1 : b === 'Other procedures' ? -1
      : patientsText(a).localeCompare(patientsText(b), currentUiLanguage))
    .map(([family, procedures]) => ({ category: category.name, subcategory: patientsText(family),
      procedures: procedures.sort((a, b) => patientProcedureName(a).localeCompare(patientProcedureName(b), currentUiLanguage)) })));
}

function populatePatientProcedureOptions() {
  const select = document.getElementById('patient-procedure-code');
  if (!select) return;
  const selected = select.value;
  const groups = patientProcedureOptionGroups(dentalOperations, patientProcedureState.records, dentalSpecialties);
  // Native selects support one optgroup level, so each accessible heading includes
  // the full category → subcategory path (also works with mobile native pickers).
  select.innerHTML = `<option value="all">${patientsText('All procedures')}</option>` + groups.map(group =>
    `<optgroup label="${escapeHtml(group.category === group.subcategory ? group.category : `${group.category} · ${group.subcategory}`)}">${group.procedures.map(operation =>
      `<option value="${escapeHtml(operation.code)}">${escapeHtml(patientProcedureName(operation))}</option>`).join('')}</optgroup>`).join('');
  select.value = groups.some(group => group.procedures.some(operation => operation.code === selected)) ? selected : 'all';
}

async function searchPatientProcedures({ force = false } = {}) {
  if (!hasPageAccess('patients') || !currentSession) return;
  updatePatientProcedureRange();
  const filters = readPatientProcedureFilters();
  const message = document.getElementById('patient-procedure-message');
  if (!filters.from || !filters.to || filters.from > filters.to) {
    patientProcedureState.request += 1;
    patientProcedureState.results = null;
    patientProcedureState.error = false;
    renderPatientProcedureResults();
    setPatientProcedureLoading(false);
    message.textContent = patientsText(!filters.from || !filters.to ? 'Choose both dates for the custom range.' : 'The start date must be on or before the end date.');
    return;
  }
  const state = patientProcedureState;
  const request = ++state.request;
  state.error = false;
  if (force) state.loaded = false;
  if (!state.loaded) setPatientProcedureLoading(true);
  message.textContent = '';
  try {
    if (!state.loaded) await loadPatientProcedureRecords(state);
    if (patientProcedureState !== state || request !== state.request || !hasPageAccess('patients')) return;
    populatePatientProcedureOptions();
    state.results = filterPatientProcedureRecords(state.records, filters);
    state.page = 1;
    renderPatientProcedureResults();
  } catch (error) {
    if (patientProcedureState !== state || request !== state.request) return;
    console.error('Could not load patient procedures:', error);
    state.error = true;
    state.results = null;
    renderPatientProcedureResults();
  } finally {
    if (patientProcedureState === state && request === state.request) setPatientProcedureLoading(false);
  }
}

function setPatientProcedureLoading(loading) {
  ['submit', 'refresh'].forEach(id => { document.getElementById(`patient-procedure-${id}`).disabled = loading; });
  const results = document.getElementById('patient-procedure-results');
  results.setAttribute('aria-busy', String(loading));
  if (loading) {
    document.getElementById('patient-procedure-count').textContent = patientsText('Loading procedure records…');
    document.getElementById('patient-procedure-pagination').classList.add('hidden');
    results.innerHTML = `<div class="patients-loading" role="status"><span>${patientsText('Loading procedure records…')}</span>${Array.from({ length: 3 }, () => '<div class="patients-skeleton animate-pulse"><div></div><div></div><div></div></div>').join('')}</div>`;
  }
}

function patientProcedureEmptyMarkup(title, subtitle, action, handler) {
  return `<div class="patients-empty"><span class="patients-empty-icon"><i data-lucide="${patientProcedureState.error ? 'cloud-off' : 'list-filter'}" class="w-5 h-5"></i></span><h4>${patientsText(title)}</h4><p>${patientsText(subtitle)}</p><button class="patients-action patients-action-primary" type="button" onclick="${handler}">${patientsText(action)}</button></div>`;
}

function renderPatientProcedureResults() {
  const state = patientProcedureState;
  const results = document.getElementById('patient-procedure-results');
  const count = document.getElementById('patient-procedure-count');
  const pagination = document.getElementById('patient-procedure-pagination');
  pagination.classList.add('hidden');
  if (state.error) {
    count.textContent = '';
    results.innerHTML = patientProcedureEmptyMarkup('Could not load procedure records', 'Check your connection and try again.', 'Try again', 'searchPatientProcedures({ force: true })');
  } else if (state.results === null) {
    count.textContent = '';
    results.innerHTML = patientProcedureEmptyMarkup('Search across your patients', 'Choose a time range, procedure, and status to find matching patients.', 'Find patients', 'searchPatientProcedures()');
  } else {
    const total = state.results.length;
    const procedures = state.results.reduce((sum, group) => sum + group.procedures.length, 0);
    count.textContent = currentUiLanguage === 'ar' ? `${total} مريض · ${procedures} إجراء` : `${total} patients · ${procedures} procedures`;
    state.page = Math.max(1, Math.min(state.page, Math.ceil(total / 10) || 1));
    if (!total) results.innerHTML = patientProcedureEmptyMarkup('No patients match these filters', 'Try a wider date range or include all procedure statuses.', 'Reset filters', 'resetPatientProcedureFilters()');
    else results.innerHTML = state.results.slice((state.page - 1) * 10, state.page * 10).map(group => {
      const patient = group.patient;
      const statusClasses = { P: 'bg-amber-100 text-amber-800', In: 'bg-blue-50 text-blue-700', C: 'bg-emerald-50 text-emerald-700', E: 'bg-slate-100 text-slate-600' };
      return `<article class="patients-match-card"><div class="patients-match-header"><div class="patients-match-identity"><span class="patients-avatar">${escapeHtml(String(patient.name || '?').trim().slice(0, 1))}</span><div><h4>${escapeHtml(patient.name)}</h4><p><bdi>${escapeHtml(formatPatientNumber(patient))}</bdi>${patient.phone ? ` · <bdi>${escapeHtml(patient.phone)}</bdi>` : ''}</p></div></div><div class="patients-match-contact-actions">${patientPhoneActionsMarkup(patient, 'primary')}</div><div class="patients-match-actions"><button type="button" class="patients-action" data-patient-id="${escapeHtml(patient.id)}" onclick="openPatientWorkspace(this.dataset.patientId, 'profile', 'patients')"><i data-lucide="user-round" class="w-4 h-4"></i><span>${patientsText('Open patient')}</span></button>${hasPageAccess('chart') ? `<button type="button" class="patients-action" data-patient-id="${escapeHtml(patient.id)}" onclick="openPatientWorkspace(this.dataset.patientId, 'chart', 'patients')"><i data-lucide="clipboard-list" class="w-4 h-4"></i><span>${patientsText('Open chart')}</span></button>` : ''}</div></div><div class="patients-match-procedures">${group.procedures.map(record => `<div class="patients-match-procedure"><div class="patients-match-procedure-name"><strong>${escapeHtml(patientProcedureName(record))}</strong>${record.tooth ? `<span>${currentUiLanguage === 'ar' ? 'السن' : 'Tooth'} <bdi>${escapeHtml(String(record.tooth))}</bdi></span>` : ''}${record.visitNumber ? `<span>${currentUiLanguage === 'ar' ? 'زيارة' : 'Visit'} ${Number(record.visitNumber)}</span>` : ''}</div><time datetime="${record.date}">${formatPatientProcedureDay(record.date)}</time><span class="patients-badge ${statusClasses[record.status] || statusClasses.E}">${escapeHtml(patientsText(OPERATION_STATUSES[record.status]?.label || 'Existed'))}</span><span class="patients-badge ${record.invoiced ? 'bg-violet-100 text-violet-800' : 'bg-slate-100 text-slate-600'}">${patientsText(record.invoiced ? 'Invoiced' : 'Uninvoiced')}</span></div>`).join('')}</div></article>`;
    }).join('');
    if (total > 10) {
      pagination.classList.remove('hidden');
      const first = (state.page - 1) * 10 + 1;
      const last = Math.min(state.page * 10, total);
      document.getElementById('patient-procedure-page-summary').textContent = currentUiLanguage === 'ar' ? `${first}–${last} من ${total}` : `${first}–${last} of ${total}`;
      document.getElementById('patient-procedure-previous').disabled = state.page <= 1;
      document.getElementById('patient-procedure-next').disabled = state.page * 10 >= total;
    }
  }
  if (window.lucide) lucide.createIcons();
}

function changePatientProcedurePage(direction) {
  patientProcedureState.page += direction;
  renderPatientProcedureResults();
  document.getElementById('patient-procedure-results').scrollTop = 0;
}
