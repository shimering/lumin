/* Orthodontic visits keep their own clinical details, invoice IDs and payroll. */
let orthoVisitDialogState = null;
let orthoVisitViewportFrame = null;
let orthoVisitViewportTimers = [];
const orthoVisitAddsInProgress = new Set();

function orthoVisitText(en, ar) { return currentUiLanguage === 'ar' ? ar : en; }

function orthoVisitAddKey(patient, findingId) {
  return JSON.stringify([typeof currentSession === 'undefined' ? null : currentSession?.user?.id, patient?.id, findingId]);
}

function orthoVisitDateValue(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? value : chartOperationDateInputValue(value).slice(0, 10);
}

function orthoVisitDateLabel(value) {
  const day = orthoVisitDateValue(value);
  return window.LuminDates ? LuminDates.format(day) : day.split('-').reverse().join('/');
}

function renderOrthoVisitDrawer(finding, visits, collapsed) {
  // The clinical date is editable, so it must never determine creation order.
  const newest = visits.map((visit, index) => ({ visit, index })).sort((a, b) =>
    (Date.parse(b.visit.createdAt) || 0) - (Date.parse(a.visit.createdAt) || 0) || b.index - a.index).map(item => item.visit);
  const visible = collapsed ? newest.slice(0, 1) : newest;
  const cards = visible.map(visit => {
    const invoiced = invoicedFindingIds.has(visit.id);
    const selected = selectedFindingIds.has(visit.id);
    const selectable = !invoiced && !chartInvoiceStateLoading;
    return `<div data-ortho-visit-id="${escapeHtml(visit.id)}" class="ortho-visit-card">
      <div class="ortho-visit-topline">
        <div class="ortho-visit-name">
          <label class="finding-selection-target"><input type="checkbox" data-ortho-visit-id="${escapeHtml(visit.id)}" class="h-4 w-4 rounded border-slate-300" ${invoiced ? 'checked disabled' : (selectable ? (selected ? 'checked' : '') : 'disabled')} onchange="toggleOrthoVisitSelection(this)" aria-label="${orthoVisitText(invoiced ? 'Invoiced visit' : 'Select visit', invoiced ? 'زيارة مفوترة' : 'تحديد الزيارة')} #${visit.visitNumber}"></label>
          <span class="ortho-visit-number">${orthoVisitText('Visit', 'زيارة')} #${visit.visitNumber}</span>
          <button type="button" class="ortho-visit-notes${visit.notes ? '' : ' is-empty'}" onclick="openOrthoVisitDialog(this, 'notes')" aria-haspopup="dialog" aria-label="${orthoVisitText('Edit visit notes', 'تعديل ملاحظات الزيارة')} #${visit.visitNumber}" title="${escapeHtml(visit.notes || '')}"><span>${escapeHtml(visit.notes || orthoVisitText('Add visit notes', 'أضف ملاحظات الزيارة'))}</span></button>
        </div>
      </div>
      <div class="ortho-visit-controls">
        <button type="button" class="ortho-button ortho-visit-date" onclick="openOrthoVisitDialog(this, 'date')" aria-haspopup="dialog" aria-label="${orthoVisitText('Edit visit date', 'تعديل تاريخ الزيارة')}"><i data-lucide="calendar"></i><time datetime="${escapeHtml(orthoVisitDateValue(visit.date || visit.createdAt))}">${escapeHtml(orthoVisitDateLabel(visit.date || visit.createdAt))}</time></button>
        ${finding.doctorId ? '' : `<select onchange="updateOrthoVisitDoctor(this)" aria-label="${orthoVisitText('Visit doctor', 'طبيب الزيارة')}">${chartDoctorSelectOptions(visit)}</select>`}
        <label class="ortho-visit-price"><span>EGP</span><input type="number" min="0" step="0.01" value="${Math.max(0, Number(visit.price) || 0)}" onchange="updateOrthoVisitPrice(this)" ${invoiced ? 'disabled' : ''} aria-label="${orthoVisitText('Visit price', 'سعر الزيارة')}"></label>
        <div class="ortho-visit-invoice finding-invoice-control">${invoiced ? chartFindingInvoiceColumn([visit.id]) : ''}</div>
      </div>
    </div>`;
  }).join('');
  return `<section class="ortho-visits-section" data-ortho-visits-panel aria-label="${orthoVisitText('Package visits', 'زيارات الباقة')}">
    <div id="ortho-visits-${escapeHtml(finding.id)}" class="ortho-visits-scroll" tabindex="0" role="region" aria-label="${orthoVisitText('Visit history', 'سجل الزيارات')}">${cards || `<div class="ortho-empty"><i data-lucide="calendar-plus"></i><strong>${orthoVisitText('No visits yet', 'لا توجد زيارات بعد')}</strong><p>${orthoVisitText('Add the first visit to record its details and fee.', 'أضف الزيارة الأولى لتسجيل التفاصيل والسعر.')}</p></div>`}</div>
    <div class="ortho-visits-footer">
      <button type="button" class="ortho-button" onclick="toggleOrthoVisitsCollapse('${escapeHtml(finding.id)}')" aria-expanded="${!collapsed}" aria-controls="ortho-visits-${escapeHtml(finding.id)}"><i data-lucide="${collapsed ? 'chevron-down' : 'chevron-up'}"></i><span>${visits.length} ${orthoVisitText(visits.length === 1 ? 'visit' : 'visits', 'زيارات')}</span></button>
      <button type="button" data-ortho-add-visit class="ortho-button ortho-primary" onclick="addOrthoVisit(this)" ${orthoVisitAddsInProgress.has(orthoVisitAddKey(getActivePatient(), finding.id)) ? 'disabled' : ''}><i data-lucide="plus"></i><span>${orthoVisitText('Add new visit', 'إضافة زيارة جديدة')}</span></button>
    </div>
  </section>`;
}

function orthoVisitFinding(patient, id) {
  return collectDocumentedFindings(patient).flatMap(group => group.memberFindings || [group]).find(finding => finding.id === id);
}

async function addBlankOrthoVisit(button) {
  const patient = getActivePatient();
  const findingId = button.closest('[data-finding-id]')?.dataset.findingId;
  const finding = patient && orthoVisitFinding(patient, findingId);
  if (!finding) return;
  const key = orthoVisitAddKey(patient, findingId);
  if (orthoVisitAddsInProgress.has(key)) return;
  const context = { patientId: String(patient.id), userId: typeof currentSession === 'undefined' ? undefined : currentSession?.user?.id };
  const now = new Date();
  const visit = normaliseOrthoVisit({
    id: createChartFindingId(),
    visitNumber: Math.max(0, ...(finding.orthoVisits || []).map(item => Number(item.visitNumber) || 0)) + 1,
    createdAt: now.toISOString(),
    date: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
    notes: '', price: 0, status: 'C',
    doctorId: finding.doctorId || null, doctorName: finding.doctorId ? finding.doctorName || '' : ''
  });
  const previousChartState = clonePatientChart(patient.chartState);
  orthoVisitAddsInProgress.add(key);
  let saved = false;
  try {
    if (!updateChartFindingById(patient, findingId, current => ({ ...current, isOrthoPackage: true,
      orthoVisits: [...(current.orthoVisits || []), visit] }))) return;
    renderFindingsList();
    const history = document.getElementById(`ortho-visits-${findingId}`);
    if (history) history.scrollTop = 0;
    saved = await saveActivePatientChart(patient, { previousChartState, afterSave: async () => {
      const { error } = await db.rpc('sync_chart_finding_doctor', { p_patient_id: patient.id, p_finding_ids: [visit.id] });
      if (error) throw error;
    } });
    if (saved) {
      hrDirectoryLoaded = false; financeInvoicesLoaded = false; dashboardInvoiceCache.clear();
      if (orthoVisitContextMatches(context)) {
        try { await refreshChartFindingInvoiceState(patient.id); }
        catch (error) { console.error('Could not refresh visit invoice status:', error); }
      }
    }
  } catch (error) {
    console.error('Could not add orthodontic visit:', error);
    updateChartFindingById(patient, findingId, current => ({ ...current,
      orthoVisits: (current.orthoVisits || []).filter(item => item.id !== visit.id) }));
  } finally {
    orthoVisitAddsInProgress.delete(key);
    if (orthoVisitContextMatches(context)) {
      renderFindingsList();
      const history = document.getElementById(`ortho-visits-${findingId}`);
      if (saved && history) history.scrollTop = 0;
    }
  }
  if (!saved && orthoVisitContextMatches(context)) showAppointmentNotificationToast(
    orthoVisitText('Could not add visit', 'تعذّر إضافة الزيارة'),
    orthoVisitText('Please try again.', 'يرجى المحاولة مرة أخرى.')
  );
}

async function saveOrthoVisitControl(control, field) {
  const patient = getActivePatient();
  const findingId = control.closest('[data-finding-id]')?.dataset.findingId;
  const visitId = control.closest('[data-ortho-visit-id]')?.dataset.orthoVisitId;
  const finding = patient && orthoVisitFinding(patient, findingId);
  if (!finding || !(finding.orthoVisits || []).some(visit => visit.id === visitId)) return;
  let change;
  if (field === 'doctor') {
    if (finding.doctorId) { renderFindingsList(); return; }
    const doctorId = String(control.value || '');
    const doctor = chartDoctors.find(item => item.userId === doctorId);
    if (doctorId && !doctor) { renderFindingsList(); return; }
    change = { doctorId: doctor?.userId || null, doctorName: doctor?.fullName || '' };
  } else {
    const price = Number(control.value);
    if (invoicedFindingIds.has(visitId) || !Number.isFinite(price) || price < 0) { renderFindingsList(); return; }
    change = { price: Math.round(price * 100) / 100 };
  }
  const previousChartState = clonePatientChart(patient.chartState);
  updateChartFindingById(patient, findingId, current => ({ ...current,
    orthoVisits: (current.orthoVisits || []).map(visit => visit.id === visitId ? { ...visit, ...change } : visit) }));
  renderFindingsList();
  const saved = await saveActivePatientChart(patient, { previousChartState, ...(field === 'doctor' ? { afterSave: async () => {
    const { error } = await db.rpc('sync_chart_finding_doctor', { p_patient_id: patient.id, p_finding_ids: [visitId] });
    if (error) throw error;
  } } : {}) });
  if (String(getActivePatient()?.id) !== String(patient.id)) return;
  renderFindingsList();
  if (!saved) {
    alert(orthoVisitText('The visit could not be saved. Please try again.', 'تعذّر حفظ الزيارة. يرجى المحاولة مرة أخرى.'));
  } else if (field === 'doctor') {
    hrDirectoryLoaded = false; financeInvoicesLoaded = false; dashboardInvoiceCache.clear();
    await refreshChartFindingInvoiceState(patient.id);
  }
}

function ensureOrthoVisitDialog() {
  let dialog = document.getElementById('ortho-visit-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'ortho-visit-dialog';
  dialog.setAttribute('aria-labelledby', 'ortho-visit-dialog-title');
  dialog.innerHTML = `<form class="ortho-dialog-form">
    <header class="ortho-dialog-header"><div><h2 id="ortho-visit-dialog-title"></h2><p data-visit-procedure></p></div><button type="button" class="ortho-button ortho-close" data-visit-close><i data-lucide="x"></i></button></header>
    <div class="ortho-dialog-body">
      <div data-visit-field="notes"><label for="ortho-visit-notes" data-label="notes"></label><textarea id="ortho-visit-notes" rows="4" maxlength="10000"></textarea></div>
      <div data-visit-field="date"><label for="ortho-visit-date" data-label="date"></label><input id="ortho-visit-date" type="date" required dir="ltr"></div>
      <div class="ortho-dialog-grid" data-visit-field="billing"><div><label for="ortho-visit-price" data-label="price"></label><input id="ortho-visit-price" type="number" min="0" step="0.01" required inputmode="decimal"></div><div><label for="ortho-visit-status" data-label="status"></label><select id="ortho-visit-status"></select></div></div>
      <div data-visit-doctor-field><label for="ortho-visit-doctor" data-label="doctor"></label><select id="ortho-visit-doctor"></select></div>
      <p data-visit-error role="alert" hidden></p>
    </div>
    <footer class="ortho-dialog-footer"><button type="button" class="ortho-button" data-visit-cancel></button><button type="submit" class="ortho-button ortho-primary" data-visit-save><i data-lucide="check"></i><span></span></button></footer>
  </form>`;
  dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); void saveOrthoVisitDialog(); });
  dialog.querySelector('[data-visit-close]').onclick = () => closeOrthoVisitDialog();
  dialog.querySelector('[data-visit-cancel]').onclick = () => closeOrthoVisitDialog();
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeOrthoVisitDialog(); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')]
      .filter(control => control.tabIndex >= 0 && control.getClientRects().length && !control.closest('[hidden]'));
    if (!controls.length) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus({ preventScroll: true }); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus({ preventScroll: true }); }
  });
  dialog.addEventListener('focusin', settleOrthoVisitDialogViewport);
  dialog.addEventListener('focusout', settleOrthoVisitDialogViewport);
  window.addEventListener('resize', scheduleOrthoVisitDialogViewport, { passive: true });
  window.visualViewport?.addEventListener('resize', scheduleOrthoVisitDialogViewport, { passive: true });
  window.visualViewport?.addEventListener('scroll', scheduleOrthoVisitDialogViewport, { passive: true });
  document.body.appendChild(dialog);
  return dialog;
}

function updateOrthoVisitDialogViewport() {
  const dialog = document.getElementById('ortho-visit-dialog');
  if (!dialog?.open) return;
  const viewport = window.visualViewport;
  const bounds = typeof getAppViewportBounds === 'function' ? getAppViewportBounds() : {
    height: Math.min(window.innerHeight, viewport?.height || window.innerHeight),
    width: viewport?.width || window.innerWidth,
    offsetTop: viewport?.offsetTop || 0, offsetLeft: viewport?.offsetLeft || 0
  };
  dialog.style.setProperty('--ortho-viewport-height', `${bounds.height}px`);
  dialog.style.setProperty('--ortho-viewport-width', `${bounds.width}px`);
  dialog.style.setProperty('--ortho-viewport-top', `${bounds.offsetTop}px`);
  dialog.style.setProperty('--ortho-viewport-left', `${bounds.offsetLeft}px`);
  dialog.style.setProperty('--ortho-viewport-right', `${Math.max(0, window.innerWidth - bounds.offsetLeft - bounds.width)}px`);
  dialog.style.setProperty('--ortho-viewport-bottom', `${Math.max(0, window.innerHeight - bounds.offsetTop - bounds.height)}px`);
  // Scroll only the dialog body; keep its actions above the keyboard.
  const body = dialog.querySelector('.ortho-dialog-body');
  const focused = document.activeElement;
  if (body.contains(focused)) {
    const field = focused.getBoundingClientRect(), visible = body.getBoundingClientRect();
    if (field.top < visible.top + 8) body.scrollTop -= visible.top + 8 - field.top;
    else if (field.bottom > visible.bottom - 8) body.scrollTop += field.bottom - visible.bottom + 8;
  }
}

function scheduleOrthoVisitDialogViewport() {
  if (!orthoVisitDialogState || orthoVisitViewportFrame !== null) return;
  orthoVisitViewportFrame = window.requestAnimationFrame(() => {
    orthoVisitViewportFrame = null;
    updateOrthoVisitDialogViewport();
  });
}

function settleOrthoVisitDialogViewport() {
  if (!orthoVisitDialogState) return;
  orthoVisitViewportTimers.forEach(timer => window.clearTimeout(timer));
  scheduleOrthoVisitDialogViewport();
  // Mobile viewport metrics can settle after the keyboard focus event.
  orthoVisitViewportTimers = [120, 400].map(delay => window.setTimeout(scheduleOrthoVisitDialogViewport, delay));
}

function configureOrthoVisitDialogControls(dialog, state, parent) {
  dialog.querySelectorAll('[data-visit-field], [data-visit-doctor-field]').forEach(field => {
    const name = field.dataset.visitField || 'doctor';
    const visible = state.mode === 'create' ? (name !== 'doctor' || !parent.doctorId) : name === state.mode;
    field.hidden = !visible;
    field.querySelectorAll('input, textarea, select, button').forEach(control => { control.disabled = state.saving || !visible; });
  });
  dialog.querySelectorAll('.ortho-dialog-header button, .ortho-dialog-footer button').forEach(button => { button.disabled = state.saving; });
  dialog.querySelector('#ortho-visit-price').disabled = state.saving || state.mode !== 'create' || invoicedFindingIds.has(state.visitId);
}

function orthoVisitContextMatches(state) {
  return state && String(getActivePatient()?.id) === state.patientId
    && (typeof currentSession === 'undefined' || currentSession?.user?.id === state.userId);
}

function syncOrthoVisitDialogContext() {
  if (orthoVisitDialogState && !orthoVisitContextMatches(orthoVisitDialogState)) closeOrthoVisitDialog({ force: true, restoreFocus: false });
}

function openOrthoVisitDialog(button, mode = 'notes') {
  mode = mode === true ? 'create' : mode;
  if (!['create', 'notes', 'date'].includes(mode)) return;
  const create = mode === 'create';
  const patient = getActivePatient();
  const findingId = button.closest('[data-finding-id]')?.dataset.findingId;
  if (!patient || !findingId || orthoVisitDialogState?.saving) return;
  const finding = orthoVisitFinding(patient, findingId);
  if (!finding) return;
  const visitId = create ? createChartFindingId() : button.closest('[data-ortho-visit-id]')?.dataset.orthoVisitId;
  const visit = create ? { id: visitId, date: new Date().toISOString(), price: 0, notes: '', status: 'C' }
    : (finding.orthoVisits || []).find(item => item.id === visitId);
  if (!visit) return;
  const dialog = ensureOrthoVisitDialog();
  orthoVisitDialogState = { patientId: String(patient.id), userId: typeof currentSession === 'undefined' ? undefined : currentSession?.user?.id,
    findingId, visitId, create, mode, trigger: button, saving: false };
  dialog.dir = currentUiLanguage === 'ar' ? 'rtl' : 'ltr';
  dialog.dataset.mode = mode;
  dialog.querySelector('h2').textContent = create ? orthoVisitText('Add new visit', 'إضافة زيارة جديدة')
    : mode === 'notes' ? orthoVisitText('Edit visit notes', 'تعديل ملاحظات الزيارة') : orthoVisitText('Edit visit date', 'تعديل تاريخ الزيارة');
  dialog.querySelector('[data-visit-procedure]').textContent = dentalOperationLabel(finding.code) + (create ? '' : orthoVisitText(` · Visit #${visit.visitNumber}`, ` · الزيارة رقم ${visit.visitNumber}`));
  const labels = { notes: ['Visit notes', 'ملاحظات الزيارة'], date: ['Visit date', 'تاريخ الزيارة'], price: ['Visit fee (EGP)', 'سعر الزيارة (ج.م)'], status: ['Visit status', 'حالة الزيارة'], doctor: ['Visit doctor', 'طبيب الزيارة'] };
  Object.entries(labels).forEach(([key, text]) => { dialog.querySelector(`[data-label="${key}"]`).textContent = orthoVisitText(...text); });
  dialog.querySelector('#ortho-visit-notes').value = visit.notes || '';
  dialog.querySelector('#ortho-visit-notes').placeholder = orthoVisitText('Adjustments, archwires, treatment progress…', 'التعديلات والأسلاك وتقدم العلاج…');
  dialog.querySelector('#ortho-visit-date').value = orthoVisitDateValue(visit.date || visit.createdAt);
  dialog.querySelector('#ortho-visit-price').value = visit.price || 0;
  dialog.querySelector('#ortho-visit-status').innerHTML = operationStatusSelectOptions(visit.status);
  dialog.querySelector('#ortho-visit-doctor').innerHTML = chartDoctorSelectOptions(visit);
  dialog.querySelector('[data-visit-error]').hidden = true;
  dialog.querySelector('[data-visit-close]').setAttribute('aria-label', orthoVisitText('Close', 'إغلاق'));
  dialog.querySelector('[data-visit-cancel]').textContent = orthoVisitText('Cancel', 'إلغاء');
  dialog.querySelector('[data-visit-save] span').textContent = orthoVisitSaveLabel(mode);
  window.LuminDates?.enhanceInputs(dialog);
  configureOrthoVisitDialogControls(dialog, orthoVisitDialogState, finding);
  if (window.lucide) lucide.createIcons();
  if (!dialog.open) dialog.showModal();
  updateOrthoVisitDialogViewport();
  const focus = mode === 'date' ? (dialog.querySelector('[data-visit-field="date"] .lumin-date-text') || dialog.querySelector('#ortho-visit-date')) : dialog.querySelector('#ortho-visit-notes');
  focus.focus({ preventScroll: true });
  settleOrthoVisitDialogViewport();
}

function orthoVisitSaveLabel(mode) {
  return mode === 'notes' ? orthoVisitText('Save notes', 'حفظ الملاحظات')
    : mode === 'date' ? orthoVisitText('Save date', 'حفظ التاريخ') : orthoVisitText('Save visit', 'حفظ الزيارة');
}

function closeOrthoVisitDialog({ force = false, restoreFocus = true } = {}) {
  const state = orthoVisitDialogState;
  if (state?.saving && !force) return;
  orthoVisitDialogState = null;
  orthoVisitViewportTimers.forEach(timer => window.clearTimeout(timer));
  orthoVisitViewportTimers = [];
  if (orthoVisitViewportFrame !== null) window.cancelAnimationFrame(orthoVisitViewportFrame);
  orthoVisitViewportFrame = null;
  document.getElementById('ortho-visit-dialog')?.close();
  if (restoreFocus && state?.trigger?.isConnected) state.trigger.focus({ preventScroll: true });
}

async function saveOrthoVisitDialog() {
  const state = orthoVisitDialogState;
  if (!state || state.saving) return;
  if (!orthoVisitContextMatches(state)) { closeOrthoVisitDialog({ force: true, restoreFocus: false }); return; }
  const dialog = document.getElementById('ortho-visit-dialog');
  if (!dialog.querySelector('form').reportValidity()) return;
  const patient = getActivePatient();
  const parent = orthoVisitFinding(patient, state.findingId);
  const existing = (parent?.orthoVisits || []).find(visit => visit.id === state.visitId);
  if (!parent || (!state.create && !existing)) { closeOrthoVisitDialog(); return; }
  const error = dialog.querySelector('[data-visit-error]');
  let change = {};
  if (state.mode !== 'date') change.notes = dialog.querySelector('#ortho-visit-notes').value.trim();
  if (state.mode !== 'notes') {
    const day = dialog.querySelector('#ortho-visit-date').value;
    const date = new Date(`${day}T00:00:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date.getTime())) return;
    change.date = date.toISOString();
  }
  if (state.create) {
    const price = Number(dialog.querySelector('#ortho-visit-price').value);
    if (!Number.isFinite(price) || price < 0) return;
    const doctorId = parent.doctorId || dialog.querySelector('#ortho-visit-doctor').value;
    const doctor = doctorId ? chartDoctors.find(item => item.userId === doctorId) : null;
    if (doctorId && !doctor && doctorId !== parent.doctorId) {
      error.textContent = orthoVisitText('Choose an active doctor.', 'اختر طبيباً نشطاً.'); error.hidden = false; return;
    }
    change = normaliseOrthoVisit({ ...existing, ...change, id: state.visitId,
      visitNumber: existing?.visitNumber || Math.max(0, ...(parent.orthoVisits || []).map(item => Number(item.visitNumber) || 0)) + 1,
      createdAt: existing?.createdAt || new Date().toISOString(),
      status: dialog.querySelector('#ortho-visit-status').value,
      price: invoicedFindingIds.has(state.visitId) ? existing?.price : Math.round(price * 100) / 100,
      doctorId: doctorId || null, doctorName: parent.doctorId ? parent.doctorName : doctor?.fullName || '' });
  }
  const previousChartState = clonePatientChart(patient.chartState);
  if (!updateChartFindingById(patient, state.findingId, finding => ({ ...finding, isOrthoPackage: true,
    orthoVisits: state.create && !existing ? [...(finding.orthoVisits || []), change] : (finding.orthoVisits || []).map(item => item.id === state.visitId ? { ...item, ...change } : item) }))) return;
  state.saving = true;
  error.hidden = true;
  configureOrthoVisitDialogControls(dialog, state, parent);
  dialog.querySelector('[data-visit-save] span').textContent = orthoVisitText('Saving…', 'جارٍ الحفظ…');
  let saved = false;
  try {
    saved = await saveActivePatientChart(patient, { previousChartState, ...(state.create ? { afterSave: async () => {
      const { error: syncError } = await db.rpc('sync_chart_finding_doctor', { p_patient_id: patient.id, p_finding_ids: [state.visitId] });
      if (syncError) throw syncError;
    } } : {}) });
  } catch (saveError) {
    console.error('Could not save orthodontic visit:', saveError);
    updateChartFindingById(patient, state.findingId, finding => ({ ...finding,
      orthoVisits: state.create && !existing ? (finding.orthoVisits || []).filter(item => item.id !== state.visitId)
        : (finding.orthoVisits || []).map(item => item.id === state.visitId
          ? { ...item, ...Object.fromEntries(Object.keys(change).map(key => [key, existing?.[key]])) } : item) }));
  }
  if (saved) {
    hrDirectoryLoaded = false; financeInvoicesLoaded = false; dashboardInvoiceCache.clear();
    if (orthoVisitContextMatches(state)) {
      renderFindingsList();
      if (state.create) {
        const history = document.getElementById(`ortho-visits-${state.findingId}`);
        if (history) history.scrollTop = 0;
      }
      try { await refreshChartFindingInvoiceState(patient.id); }
      catch (refreshError) { console.error('Could not refresh visit invoice status:', refreshError); }
    }
  } else if (orthoVisitContextMatches(state)) renderFindingsList();
  if (orthoVisitDialogState !== state) return;
  state.saving = false;
  if (saved) {
    const row = [...document.querySelectorAll('[data-finding-id]')].find(row => row.dataset.findingId === state.findingId);
    const visitRow = [...(row?.querySelectorAll('.ortho-visit-card') || [])].find(visit => visit.dataset.orthoVisitId === state.visitId);
    state.trigger = (state.create ? row?.querySelector('[data-ortho-add-visit]')
      : visitRow?.querySelector(state.mode === 'notes' ? '.ortho-visit-notes' : '.ortho-visit-date')) || state.trigger;
    closeOrthoVisitDialog();
  } else {
    configureOrthoVisitDialogControls(dialog, state, parent);
    dialog.querySelector('[data-visit-save] span').textContent = orthoVisitSaveLabel(state.mode);
    error.textContent = orthoVisitText('The visit could not be saved. Please try again.', 'تعذّر حفظ الزيارة. يرجى المحاولة مرة أخرى.');
    error.hidden = false;
  }
}
