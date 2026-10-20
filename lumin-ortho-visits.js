/* Orthodontic visits keep their own clinical details, invoice IDs and payroll. */
let orthoVisitDialogState = null;

function orthoVisitText(en, ar) { return currentUiLanguage === 'ar' ? ar : en; }

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
          <span class="ortho-visit-notes" title="${escapeHtml(visit.notes || '')}">${escapeHtml(visit.notes || orthoVisitText('Add visit notes', 'أضف ملاحظات الزيارة'))}</span>
          <button type="button" class="ortho-button ortho-note-button" onclick="openOrthoVisitDialog(this)" aria-haspopup="dialog" aria-label="${orthoVisitText('Edit visit notes', 'تعديل ملاحظات الزيارة')}"><i data-lucide="sticky-note"></i></button>
        </div>
        <div class="ortho-visit-invoice finding-invoice-control">${invoiced ? chartFindingInvoiceColumn([visit.id]) : ''}</div>
      </div>
      <div class="ortho-visit-controls">
        <button type="button" class="ortho-button ortho-visit-date" onclick="openOrthoVisitDialog(this)" aria-haspopup="dialog" aria-label="${orthoVisitText('Edit visit date', 'تعديل تاريخ الزيارة')}"><i data-lucide="calendar"></i><time datetime="${escapeHtml(visit.date || visit.createdAt || '')}">${escapeHtml(formatChartOperationCreatedAt(visit.date || visit.createdAt))}</time></button>
        ${finding.doctorId ? '' : `<select onchange="updateOrthoVisitDoctor(this)" aria-label="${orthoVisitText('Visit doctor', 'طبيب الزيارة')}">${chartDoctorSelectOptions(visit)}</select>`}
        <span class="rounded-full px-2 py-1 text-xs ${visit.status === 'C' ? 'bg-emerald-50 text-emerald-700' : visit.status === 'In' ? 'bg-blue-50 text-blue-700' : visit.status === 'P' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}">${escapeHtml(operationStatusDefinition(visit.status).label)}</span>
        <label class="ortho-visit-price"><span>EGP</span><input type="number" min="0" step="0.01" value="${Math.max(0, Number(visit.price) || 0)}" onchange="updateOrthoVisitPrice(this)" ${invoiced ? 'disabled' : ''} aria-label="${orthoVisitText('Visit price', 'سعر الزيارة')}"></label>
      </div>
    </div>`;
  }).join('');
  return `<section class="ortho-visits-section" data-ortho-visits-panel aria-label="${orthoVisitText('Package visits', 'زيارات الباقة')}">
    <div id="ortho-visits-${escapeHtml(finding.id)}" class="ortho-visits-scroll" tabindex="0" role="region" aria-label="${orthoVisitText('Visit history', 'سجل الزيارات')}">${cards || `<div class="ortho-empty"><i data-lucide="calendar-plus"></i><strong>${orthoVisitText('No visits yet', 'لا توجد زيارات بعد')}</strong><p>${orthoVisitText('Add the first visit to record its details and fee.', 'أضف الزيارة الأولى لتسجيل التفاصيل والسعر.')}</p></div>`}</div>
    <div class="ortho-visits-footer">
      <button type="button" class="ortho-button" onclick="toggleOrthoVisitsCollapse('${escapeHtml(finding.id)}')" aria-expanded="${!collapsed}" aria-controls="ortho-visits-${escapeHtml(finding.id)}"><i data-lucide="${collapsed ? 'chevron-down' : 'chevron-up'}"></i><span>${visits.length} ${orthoVisitText(visits.length === 1 ? 'visit' : 'visits', 'زيارات')}</span></button>
      <button type="button" data-ortho-add-visit class="ortho-button ortho-primary" onclick="addOrthoVisit(this)"><i data-lucide="plus"></i><span>${orthoVisitText('Add new visit', 'إضافة زيارة جديدة')}</span></button>
    </div>
  </section>`;
}

function orthoVisitFinding(patient, id) {
  return collectDocumentedFindings(patient).flatMap(group => group.memberFindings || [group]).find(finding => finding.id === id);
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
      <label for="ortho-visit-notes" data-label="notes"></label><textarea id="ortho-visit-notes" rows="4" maxlength="10000" autofocus></textarea>
      <label for="ortho-visit-date" data-label="date"></label><input id="ortho-visit-date" type="datetime-local" step="60" required dir="ltr">
      <div class="ortho-dialog-grid"><div><label for="ortho-visit-price" data-label="price"></label><input id="ortho-visit-price" type="number" min="0" step="0.01" required inputmode="decimal"></div><div><label for="ortho-visit-status" data-label="status"></label><select id="ortho-visit-status"></select></div></div>
      <div data-visit-doctor-field><label for="ortho-visit-doctor" data-label="doctor"></label><select id="ortho-visit-doctor"></select></div>
      <p data-visit-error role="alert" hidden></p>
    </div>
    <footer class="ortho-dialog-footer"><button type="button" class="ortho-button" data-visit-cancel></button><button type="submit" class="ortho-button ortho-primary" data-visit-save><i data-lucide="check"></i><span></span></button></footer>
  </form>`;
  dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); void saveOrthoVisitDialog(); });
  dialog.querySelector('[data-visit-close]').onclick = () => closeOrthoVisitDialog();
  dialog.querySelector('[data-visit-cancel]').onclick = () => closeOrthoVisitDialog();
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeOrthoVisitDialog(); });
  document.body.appendChild(dialog);
  return dialog;
}

function orthoVisitContextMatches(state) {
  return state && String(getActivePatient()?.id) === state.patientId
    && (typeof currentSession === 'undefined' || currentSession?.user?.id === state.userId);
}

function syncOrthoVisitDialogContext() {
  if (orthoVisitDialogState && !orthoVisitContextMatches(orthoVisitDialogState)) closeOrthoVisitDialog({ force: true, restoreFocus: false });
}

function openOrthoVisitDialog(button, create = false) {
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
    findingId, visitId, create, trigger: button, saving: false };
  dialog.dir = currentUiLanguage === 'ar' ? 'rtl' : 'ltr';
  dialog.querySelector('h2').textContent = create ? orthoVisitText('Add new visit', 'إضافة زيارة جديدة') : orthoVisitText(`Edit visit #${visit.visitNumber}`, `تعديل الزيارة رقم ${visit.visitNumber}`);
  dialog.querySelector('[data-visit-procedure]').textContent = dentalOperationLabel(finding.code);
  const labels = { notes: ['Visit notes', 'ملاحظات الزيارة'], date: ['Visit date and time', 'تاريخ ووقت الزيارة'], price: ['Visit fee (EGP)', 'سعر الزيارة (ج.م)'], status: ['Visit status', 'حالة الزيارة'], doctor: ['Visit doctor', 'طبيب الزيارة'] };
  Object.entries(labels).forEach(([key, text]) => { dialog.querySelector(`[data-label="${key}"]`).textContent = orthoVisitText(...text); });
  dialog.querySelectorAll('button, input, textarea, select').forEach(element => { element.disabled = false; });
  dialog.querySelector('#ortho-visit-notes').value = visit.notes || '';
  dialog.querySelector('#ortho-visit-notes').placeholder = orthoVisitText('Adjustments, archwires, treatment progress…', 'التعديلات والأسلاك وتقدم العلاج…');
  dialog.querySelector('#ortho-visit-date').value = chartOperationDateInputValue(visit.date || visit.createdAt);
  dialog.querySelector('#ortho-visit-price').value = visit.price || 0;
  dialog.querySelector('#ortho-visit-price').disabled = invoicedFindingIds.has(visitId);
  dialog.querySelector('#ortho-visit-status').innerHTML = operationStatusSelectOptions(visit.status);
  dialog.querySelector('[data-visit-doctor-field]').hidden = Boolean(finding.doctorId);
  dialog.querySelector('#ortho-visit-doctor').innerHTML = chartDoctorSelectOptions(visit);
  dialog.querySelector('[data-visit-error]').hidden = true;
  dialog.querySelector('[data-visit-close]').setAttribute('aria-label', orthoVisitText('Close', 'إغلاق'));
  dialog.querySelector('[data-visit-cancel]').textContent = orthoVisitText('Cancel', 'إلغاء');
  dialog.querySelector('[data-visit-save] span').textContent = orthoVisitText('Save visit', 'حفظ الزيارة');
  if (window.lucide) lucide.createIcons();
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('#ortho-visit-notes').focus();
}

function closeOrthoVisitDialog({ force = false, restoreFocus = true } = {}) {
  const state = orthoVisitDialogState;
  if (state?.saving && !force) return;
  orthoVisitDialogState = null;
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
  const date = new Date(dialog.querySelector('#ortho-visit-date').value);
  const price = Number(dialog.querySelector('#ortho-visit-price').value);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(price) || price < 0) return;
  const doctorId = parent.doctorId || dialog.querySelector('#ortho-visit-doctor').value;
  const doctor = doctorId ? chartDoctors.find(item => item.userId === doctorId) : null;
  const error = dialog.querySelector('[data-visit-error]');
  if (doctorId && !doctor && doctorId !== parent.doctorId) {
    error.textContent = orthoVisitText('Choose an active doctor.', 'اختر طبيباً نشطاً.'); error.hidden = false; return;
  }
  const previousChartState = clonePatientChart(patient.chartState);
  const status = dialog.querySelector('#ortho-visit-status').value;
  const visit = normaliseOrthoVisit({ ...existing, id: state.visitId,
    visitNumber: existing?.visitNumber || Math.max(0, ...(parent.orthoVisits || []).map(item => Number(item.visitNumber) || 0)) + 1,
    createdAt: existing?.createdAt || new Date().toISOString(), date: date.toISOString(),
    notes: dialog.querySelector('#ortho-visit-notes').value.trim(), status,
    price: invoicedFindingIds.has(state.visitId) ? existing?.price : Math.round(price * 100) / 100,
    doctorId: doctorId || null, doctorName: parent.doctorId ? parent.doctorName : doctor?.fullName || '' });
  if (!updateChartFindingById(patient, state.findingId, finding => ({ ...finding, isOrthoPackage: true,
    orthoVisits: state.create && !existing ? [...(finding.orthoVisits || []), visit] : (finding.orthoVisits || []).map(item => item.id === state.visitId ? visit : item) }))) return;
  state.saving = true;
  error.hidden = true;
  dialog.querySelectorAll('button, input, textarea, select').forEach(element => { element.disabled = true; });
  dialog.querySelector('[data-visit-save] span').textContent = orthoVisitText('Saving…', 'جارٍ الحفظ…');
  let saved = false;
  try {
    saved = await saveActivePatientChart(patient, { previousChartState, afterSave: async () => {
      const { error: syncError } = await db.rpc('sync_chart_finding_doctor', { p_patient_id: patient.id, p_finding_ids: [state.visitId] });
      if (syncError) throw syncError;
    } });
  } catch (saveError) {
    console.error('Could not save orthodontic visit:', saveError);
    updateChartFindingById(patient, state.findingId, finding => ({ ...finding,
      orthoVisits: state.create ? (finding.orthoVisits || []).filter(item => item.id !== state.visitId)
        : (finding.orthoVisits || []).map(item => item.id === state.visitId ? existing : item) }));
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
    state.trigger = [...document.querySelectorAll('[data-finding-id]')].find(row => row.dataset.findingId === state.findingId)?.querySelector('[data-ortho-add-visit]') || state.trigger;
    closeOrthoVisitDialog();
  } else {
    dialog.querySelectorAll('button, input, textarea, select').forEach(element => { element.disabled = false; });
    dialog.querySelector('#ortho-visit-price').disabled = invoicedFindingIds.has(state.visitId);
    dialog.querySelector('[data-visit-save] span').textContent = orthoVisitText('Save visit', 'حفظ الزيارة');
    error.textContent = orthoVisitText('The visit could not be saved. Please try again.', 'تعذّر حفظ الزيارة. يرجى المحاولة مرة أخرى.');
    error.hidden = false;
  }
}
