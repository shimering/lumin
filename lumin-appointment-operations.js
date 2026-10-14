// Optional links to existing clinical operations. Removing a link never edits the chart.
const appointmentOperationState = {
  patientId: '', selected: [], choices: [], draft: new Set(), open: false,
  status: 'idle', sequence: 0, trigger: null, bodyOverflow: ''
};

function appointmentOperationText(en, ar) {
  return currentUiLanguage === 'ar' ? ar : en;
}

function normaliseAppointmentOperations(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap(item => {
    if (!item || !Array.isArray(item.finding_ids)) return [];
    const ids = [...new Set(item.finding_ids.filter(id => typeof id === 'string' && id))].sort();
    const key = ids.join('|');
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [{ ...item, key, finding_ids: ids, name: String(item.name || item.code || ''),
      tooth_ids: Array.isArray(item.tooth_ids) ? item.tooth_ids.map(String) : [],
      surfaces: Array.isArray(item.surfaces) ? item.surfaces.map(String) : [],
      status: ['P', 'In', 'C', 'E'].includes(item.status) ? item.status : 'P' }];
  });
}

function appointmentOperationName(operation) {
  const name = operation.name || operation.code;
  return currentUiLanguage === 'ar' && window.LuminDentalI18n
    ? window.LuminDentalI18n.translate(name, 'ar') : name;
}

function appointmentOperationLocation(operation) {
  const teeth = operation.tooth_ids;
  return teeth.length
    ? `${appointmentOperationText(teeth.length > 1 ? 'Teeth' : 'Tooth', teeth.length > 1 ? 'الأسنان' : 'السن')} ${teeth.join(', ')}${operation.surfaces.length ? ' · ' + operation.surfaces.join(', ') : ''}`
    : appointmentOperationText('Whole mouth', 'الفم بالكامل');
}

function appointmentOperationStatusMarkup(operation) {
  const labels = {
    P: appointmentOperationText('Planned', 'مخطط'), In: appointmentOperationText('In progress', 'قيد التنفيذ'),
    C: appointmentOperationText('Completed', 'مكتمل'), E: appointmentOperationText('Existing', 'سابق')
  };
  return `<span class="appointment-operation-status" data-status="${operation.status}">${labels[operation.status]}</span>`;
}

function resetAppointmentOperations(patientId = '', selected = []) {
  closeAppointmentOperationPicker(false);
  Object.assign(appointmentOperationState, { patientId, selected: normaliseAppointmentOperations(selected),
    choices: [], draft: new Set(), status: 'idle', sequence: appointmentOperationState.sequence + 1 });
  renderAppointmentOperations();
}

function syncAppointmentOperationPatient(patientId = '') {
  if (appointmentOperationState.patientId !== patientId) resetAppointmentOperations(patientId);
  else renderAppointmentOperations();
}

function appointmentOperationsForSave(patientId) {
  if (appointmentOperationState.patientId !== patientId) return [];
  return appointmentOperationState.selected.map(operation => ({ finding_ids: operation.finding_ids }));
}

function renderAppointmentOperations() {
  const section = document.getElementById('appointment-operations-field');
  if (!section) return;
  section.setAttribute('aria-label', appointmentOperationText('Appointment operations', 'عمليات الموعد'));
  section.hidden = appointmentModalUsesNote();
  const state = appointmentOperationState;
  const editable = canModifyAppointments() && document.getElementById('btn-save-appointment')?.dataset.saving !== 'true';
  section.innerHTML = `<div class="appointment-operations-heading"><div><h4>${appointmentOperationText('Appointment operations', 'عمليات الموعد')} <span class="appointment-operation-optional">${appointmentOperationText('Optional', 'اختياري')}</span></h4><p>${appointmentOperationText('Assign planned or ongoing treatment to this visit.', 'اربط العلاج المخطط أو الجاري بهذه الزيارة.')}</p></div></div>
    <div class="appointment-operation-selected">${state.selected.map((operation, index) => `<div class="appointment-operation-row"><span class="appointment-operation-icon"><i data-lucide="tooth" class="dental-chart-icon" aria-hidden="true"></i></span><div class="appointment-operation-copy"><strong dir="auto">${escapeAppointmentText(appointmentOperationName(operation))}</strong><small dir="auto">${escapeAppointmentText(appointmentOperationLocation(operation))}</small>${appointmentOperationStatusMarkup(operation)}</div><button type="button" class="appointment-operation-button appointment-operation-remove" onclick="removeAppointmentOperation(${index})" ${editable ? '' : 'disabled'} aria-label="${escapeAppointmentText(appointmentOperationText('Remove', 'إزالة') + ' ' + appointmentOperationName(operation))}"><i data-lucide="x" aria-hidden="true"></i></button></div>`).join('')}</div>
    <button id="appointment-operations-choose" type="button" class="appointment-operation-button appointment-operation-choose" onclick="openAppointmentOperationPicker(this)" ${state.patientId && editable ? '' : 'disabled'} aria-haspopup="dialog"><i data-lucide="${state.selected.length ? 'list-filter' : 'plus'}" aria-hidden="true"></i>${state.selected.length ? appointmentOperationText('Edit operations', 'تعديل العمليات') : appointmentOperationText('Choose operations', 'اختيار العمليات')}</button>
    ${state.patientId ? '' : `<p class="appointment-operation-hint">${appointmentOperationText('Choose a patient first.', 'اختر المريض أولاً.')}</p>`}`;
  if (window.lucide) lucide.createIcons();
}

function removeAppointmentOperation(index) {
  if (!canModifyAppointments() || document.getElementById('btn-save-appointment')?.dataset.saving === 'true') return;
  appointmentOperationState.selected.splice(index, 1);
  renderAppointmentOperations();
  document.getElementById('appointment-operations-choose')?.focus({ preventScroll: true });
}

function ensureAppointmentOperationPicker() {
  let layer = document.getElementById('appointment-operation-picker');
  if (layer) return layer;
  layer = document.createElement('div');
  layer.id = 'appointment-operation-picker';
  layer.className = 'appointment-operation-picker';
  layer.hidden = true;
  layer.innerHTML = `<div class="appointment-operation-dialog" role="dialog" aria-modal="true" aria-labelledby="appointment-operation-picker-title"><header><span class="appointment-operation-icon"><i data-lucide="tooth" class="dental-chart-icon" aria-hidden="true"></i></span><div><h3 id="appointment-operation-picker-title"></h3><p id="appointment-operation-picker-description"></p></div><button type="button" class="appointment-operation-button" data-operation-close><i data-lucide="x" aria-hidden="true"></i></button></header><div class="appointment-operation-search"><i data-lucide="search" aria-hidden="true"></i><input id="appointment-operation-search" type="search" autocomplete="off" /></div><div id="appointment-operation-options" class="appointment-operation-options" aria-live="polite"></div><footer><span id="appointment-operation-count" role="status"></span><div><button type="button" class="appointment-operation-button" data-operation-cancel></button><button type="button" class="appointment-operation-button appointment-operation-primary" data-operation-apply></button></div></footer></div>`;
  layer.addEventListener('click', event => { if (event.target === layer) closeAppointmentOperationPicker(); });
  layer.querySelector('[data-operation-close]').addEventListener('click', () => closeAppointmentOperationPicker());
  layer.querySelector('[data-operation-cancel]').addEventListener('click', () => closeAppointmentOperationPicker());
  layer.querySelector('[data-operation-apply]').addEventListener('click', applyAppointmentOperationPicker);
  layer.querySelector('input').addEventListener('input', renderAppointmentOperationOptions);
  layer.querySelector('#appointment-operation-options').addEventListener('change', event => {
    const key = event.target.dataset.operationKey;
    if (!key) return;
    if (event.target.checked) appointmentOperationState.draft.add(key);
    else appointmentOperationState.draft.delete(key);
    event.target.closest('label').classList.toggle('is-selected', event.target.checked);
    updateAppointmentOperationCount();
  });
  layer.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeAppointmentOperationPicker(); }
    if (event.key !== 'Tab') return;
    const targets = [...layer.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href]')];
    const first = targets[0], last = targets[targets.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  document.body.append(layer);
  return layer;
}

async function openAppointmentOperationPicker(trigger = null) {
  const state = appointmentOperationState;
  if (state.open || !state.patientId || !currentSession || !canModifyAppointments()
    || document.getElementById('btn-save-appointment')?.dataset.saving === 'true') return;
  closeAppointmentPatientResults();
  const layer = ensureAppointmentOperationPicker();
  state.trigger = trigger || document.getElementById('appointment-operations-choose');
  state.open = true;
  state.draft = new Set(state.selected.map(operation => operation.key));
  state.status = 'loading';
  state.choices = [];
  layer.hidden = false;
  state.bodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  layer.dir = currentUiLanguage === 'ar' ? 'rtl' : 'ltr';
  document.getElementById('modal-appointment')?.setAttribute('inert', '');
  document.getElementById('appointment-operation-picker-title').textContent = appointmentOperationText('Choose operations', 'اختيار العمليات');
  document.getElementById('appointment-operation-picker-description').textContent = appointmentOperationText('Planned and in-progress operations from this patient’s chart.', 'العمليات المخططة وقيد التنفيذ من مخطط هذا المريض.');
  layer.querySelector('[data-operation-close]').ariaLabel = appointmentOperationText('Close operation picker', 'إغلاق اختيار العمليات');
  layer.querySelector('[data-operation-cancel]').textContent = appointmentOperationText('Cancel', 'إلغاء');
  layer.querySelector('[data-operation-apply]').textContent = appointmentOperationText('Apply selection', 'تطبيق الاختيار');
  const search = layer.querySelector('input');
  search.value = '';
  search.placeholder = appointmentOperationText('Search operations or tooth number', 'ابحث عن عملية أو رقم السن');
  search.ariaLabel = search.placeholder;
  renderAppointmentOperationOptions();
  layer.querySelector('[data-operation-close]').focus({ preventScroll: true });
  await loadAppointmentOperationChoices();
}

async function loadAppointmentOperationChoices() {
  const state = appointmentOperationState;
  const sequence = ++state.sequence, patientId = state.patientId, userId = currentSession?.user?.id;
  state.status = 'loading';
  renderAppointmentOperationOptions();
  const isCurrent = () => state.open && state.sequence === sequence && state.patientId === patientId
    && currentSession?.user?.id === userId && canModifyAppointments();
  try {
    const { data, error } = await db.rpc('get_patient_appointment_operations', { p_patient_id: patientId });
    if (!isCurrent()) return;
    if (error) throw error;
    state.choices = normaliseAppointmentOperations(data);
    // Keep completed links editable; deleted chart operations disappear from the selection.
    const available = new Set(state.choices.map(operation => operation.key));
    state.draft = new Set([...state.draft].filter(key => available.has(key)));
    state.status = 'ready';
  } catch (error) {
    if (!isCurrent()) return;
    state.status = 'error';
  }
  if (isCurrent()) renderAppointmentOperationOptions();
}

function updateAppointmentOperationCount() {
  const layer = document.getElementById('appointment-operation-picker');
  if (!layer) return;
  document.getElementById('appointment-operation-count').textContent = `${appointmentOperationState.draft.size} ${appointmentOperationText('selected', 'محدد')}`;
  layer.querySelector('[data-operation-apply]').disabled = appointmentOperationState.status !== 'ready';
}

function renderAppointmentOperationOptions() {
  const state = appointmentOperationState, list = document.getElementById('appointment-operation-options');
  if (!list || !state.open) return;
  const query = document.getElementById('appointment-operation-search').value.trim().toLocaleLowerCase();
  const linked = new Set(state.selected.map(operation => operation.key));
  const options = state.choices.filter(operation => ['P', 'In'].includes(operation.status) || linked.has(operation.key));
  const matches = options.filter(operation => `${appointmentOperationName(operation)} ${operation.name} ${operation.code} ${appointmentOperationLocation(operation)}`.toLocaleLowerCase().includes(query));
  if (state.status === 'loading') list.innerHTML = `<div class="appointment-operation-skeleton" aria-label="${appointmentOperationText('Loading operations', 'جارٍ تحميل العمليات')}">${'<span></span>'.repeat(3)}</div>`;
  else if (state.status === 'error') list.innerHTML = `<div class="appointment-operation-empty"><span class="appointment-operation-icon"><i data-lucide="cloud-off" aria-hidden="true"></i></span><h4>${appointmentOperationText('Could not load operations', 'تعذر تحميل العمليات')}</h4><p>${appointmentOperationText('Try again to view this patient’s treatment.', 'أعد المحاولة لعرض علاج هذا المريض.')}</p><button type="button" class="appointment-operation-button appointment-operation-primary" onclick="loadAppointmentOperationChoices()">${appointmentOperationText('Try again', 'إعادة المحاولة')}</button></div>`;
  else if (!matches.length) list.innerHTML = `<div class="appointment-operation-empty"><span class="appointment-operation-icon"><i data-lucide="${query ? 'search' : 'clipboard-list'}" aria-hidden="true"></i></span><h4>${query ? appointmentOperationText('No matching operations', 'لا توجد عمليات مطابقة') : appointmentOperationText('No planned operations yet', 'لا توجد عمليات مخططة بعد')}</h4><p>${query ? appointmentOperationText('Try another operation name or tooth number.', 'جرّب اسم عملية آخر أو رقم سن آخر.') : appointmentOperationText('Document planned treatment in the dental chart, or save this appointment without operations.', 'أضف العلاج المخطط في مخطط الأسنان، أو احفظ الموعد دون عمليات.')}</p>${!query && hasPageAccess('chart') ? `<button type="button" class="appointment-operation-button" onclick="openAppointmentOperationChart()"><i data-lucide="tooth" class="dental-chart-icon" aria-hidden="true"></i>${appointmentOperationText('Open dental chart', 'فتح مخطط الأسنان')}</button>` : ''}</div>`;
  else list.innerHTML = matches.map(operation => `<label class="appointment-operation-option ${state.draft.has(operation.key) ? 'is-selected' : ''}"><input type="checkbox" data-operation-key="${escapeAppointmentText(operation.key)}" ${state.draft.has(operation.key) ? 'checked' : ''} /><span class="appointment-operation-copy"><strong dir="auto">${escapeAppointmentText(appointmentOperationName(operation))}</strong><small dir="auto">${escapeAppointmentText(appointmentOperationLocation(operation))}</small></span>${appointmentOperationStatusMarkup(operation)}</label>`).join('');
  updateAppointmentOperationCount();
  if (window.lucide) lucide.createIcons();
}

function applyAppointmentOperationPicker() {
  const state = appointmentOperationState;
  if (!canModifyAppointments() || state.status !== 'ready') return;
  state.selected = state.choices.filter(operation => state.draft.has(operation.key));
  closeAppointmentOperationPicker(false);
  renderAppointmentOperations();
  document.getElementById('appointment-operations-choose')?.focus({ preventScroll: true });
}

function closeAppointmentOperationPicker(restoreFocus = true) {
  const state = appointmentOperationState;
  if (!state.open) return;
  state.open = false;
  state.sequence++;
  const layer = document.getElementById('appointment-operation-picker');
  if (layer) layer.hidden = true;
  document.body.style.overflow = state.bodyOverflow;
  document.getElementById('modal-appointment')?.removeAttribute('inert');
  if (restoreFocus && state.trigger?.isConnected) state.trigger.focus({ preventScroll: true });
  state.trigger = null;
}

async function openAppointmentOperationChart() {
  const patientId = appointmentOperationState.patientId;
  if (!patientId || !hasPageAccess('chart')) return;
  closeAppointmentModal();
  await openPatientChart(patientId);
}

async function editAppointmentOperations(appointmentId) {
  if (!canModifyAppointments()) return;
  await openAppointmentModal(appointmentId);
  if (editingAppointmentId === appointmentId && !document.getElementById('modal-appointment').classList.contains('hidden')) {
    await openAppointmentOperationPicker();
  }
}

function dashboardAppointmentOperationsMarkup(entry) {
  const operations = normaliseAppointmentOperations(entry.operations);
  if (entry.isNote || !operations.length) return '';
  const canOpen = hasPageAccess('chart');
  return `<section class="dashboard-appointment-operations" aria-label="${appointmentOperationText('Appointment operations', 'عمليات الموعد')}"><div class="appointment-operations-heading"><h4><i data-lucide="clipboard-list" aria-hidden="true"></i>${appointmentOperationText('Treatment for this visit', 'علاج هذه الزيارة')}</h4>${canModifyAppointments() ? `<button type="button" class="appointment-operation-button" data-operation-appointment="${escapeAppointmentText(entry.id)}" onclick="editAppointmentOperations(this.dataset.operationAppointment)" aria-label="${appointmentOperationText('Edit appointment operations', 'تعديل عمليات الموعد')}"><i data-lucide="pencil" aria-hidden="true"></i></button>` : ''}</div><div class="dashboard-operation-links">${operations.map(operation => `<${canOpen ? 'button type="button"' : 'div'} class="dashboard-operation-link" data-operation-patient="${escapeAppointmentText(entry.patientId)}" ${canOpen ? 'onclick="openPatientChart(this.dataset.operationPatient, \'dashboard\')"' : ''}><span class="appointment-operation-copy"><strong dir="auto">${escapeAppointmentText(appointmentOperationName(operation))}</strong><small dir="auto">${escapeAppointmentText(appointmentOperationLocation(operation))}</small></span>${appointmentOperationStatusMarkup(operation)}${canOpen ? '<i data-lucide="arrow-up-right" class="appointment-operation-arrow" aria-hidden="true"></i>' : ''}</${canOpen ? 'button' : 'div'}>`).join('')}</div></section>`;
}
