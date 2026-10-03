/* Planning/begin date edits stay outside the clinical findings grid. */
let chartFindingDateDialogState = null;

function chartFindingDateText(en, ar) {
  return currentUiLanguage === 'ar' ? ar : en;
}

function ensureChartFindingDateDialog() {
  let dialog = document.getElementById('chart-finding-date-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'chart-finding-date-dialog';
  dialog.setAttribute('aria-labelledby', 'chart-finding-date-title');
  dialog.setAttribute('aria-describedby', 'chart-finding-date-description');
  dialog.tabIndex = -1;
  dialog.innerHTML = `<form id="chart-finding-date-form" class="chart-date-dialog-content">
    <header class="chart-date-dialog-header"><div><h2 id="chart-finding-date-title"></h2><p id="chart-finding-date-description"></p></div><button type="button" class="chart-date-button chart-date-close" data-date-close><i data-lucide="x"></i></button></header>
    <div class="chart-date-dialog-body"><label for="chart-finding-date-input" id="chart-finding-date-label"></label><input id="chart-finding-date-input" type="datetime-local" required step="60" dir="ltr" autofocus><p id="chart-finding-date-error" role="alert" hidden></p></div>
    <footer class="chart-date-dialog-footer"><button type="button" class="chart-date-button" data-date-cancel></button><button type="submit" class="chart-date-button chart-date-save" data-date-save><i data-lucide="check"></i><span></span></button></footer>
  </form>`;
  dialog.querySelector('[data-date-close]').addEventListener('click', () => closeChartFindingDateDialog());
  dialog.querySelector('[data-date-cancel]').addEventListener('click', () => closeChartFindingDateDialog());
  dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); void saveChartFindingDateDialog(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeChartFindingDateDialog(); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
    if (!controls.length) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
  });
  document.body.appendChild(dialog);
  return dialog;
}

function chartFindingDateContextMatches(state) {
  return state && String(getActivePatient()?.id) === state.patientId
    && (typeof currentSession === 'undefined' || currentSession?.user?.id === state.userId);
}

function syncChartFindingDateDialogContext() {
  if (chartFindingDateDialogState && !chartFindingDateContextMatches(chartFindingDateDialogState)) {
    closeChartFindingDateDialog({ force: true, restoreFocus: false });
  }
}

function openChartFindingDateDialog(button, field) {
  const patient = getActivePatient();
  const findingIds = chartFindingIdsFromControl(button);
  if (!patient || !findingIds.length || !['createdAt', 'beginDate'].includes(field) || chartFindingDateDialogState?.saving) return;
  const control = button.closest(field === 'createdAt' ? '.finding-date-control' : '.finding-begin-date-control');
  if (!control) return;
  const dialog = ensureChartFindingDateDialog();
  closeChartFindingDateDialog({ restoreFocus: false });
  chartFindingDateDialogState = { patientId: String(patient.id), userId: typeof currentSession === 'undefined' ? undefined : currentSession?.user?.id,
    findingIds, toothIds: chartFindingToothIdsFromControl(button), field, trigger: button, saving: false };
  dialog.dir = currentUiLanguage === 'ar' ? 'rtl' : 'ltr';
  const planning = field === 'createdAt';
  dialog.querySelector('h2').textContent = planning ? chartFindingDateText('Edit planning date', 'تعديل تاريخ التخطيط') : chartFindingDateText('Edit begin date', 'تعديل تاريخ بدء الإجراء');
  const finding = collectDocumentedFindings(patient).find(group => (group.memberFindings || [group]).some(member => findingIds.includes(member.id)));
  dialog.querySelector('#chart-finding-date-description').textContent = finding ? dentalOperationLabel(finding.code) : chartFindingDateText('Choose the procedure date and time.', 'اختر تاريخ ووقت الإجراء.');
  dialog.querySelector('label').textContent = planning ? chartFindingDateText('Planning date and time', 'تاريخ ووقت التخطيط') : chartFindingDateText('Begin date and time', 'تاريخ ووقت بدء الإجراء');
  const input = dialog.querySelector('input');
  input.value = chartOperationDateInputValue(control.dataset.dateValue || (!planning ? new Date().toISOString() : ''));
  dialog.querySelector('[data-date-close]').setAttribute('aria-label', chartFindingDateText('Close', 'إغلاق'));
  dialog.querySelector('[data-date-cancel]').textContent = chartFindingDateText('Cancel', 'إلغاء');
  dialog.querySelector('[data-date-save] span').textContent = chartFindingDateText('Save date', 'حفظ التاريخ');
  dialog.querySelector('#chart-finding-date-error').hidden = true;
  dialog.querySelectorAll('button, input').forEach(element => { element.disabled = false; });
  if (window.lucide) lucide.createIcons();
  dialog.showModal();
  input.focus();
}

function closeChartFindingDateDialog({ force = false, restoreFocus = true } = {}) {
  const state = chartFindingDateDialogState;
  if (state?.saving && !force) return;
  chartFindingDateDialogState = null;
  document.getElementById('chart-finding-date-dialog')?.close();
  if (restoreFocus && state?.trigger?.isConnected) state.trigger.focus({ preventScroll: true });
}

async function saveChartFindingDateDialog() {
  const state = chartFindingDateDialogState;
  if (!state || state.saving) return;
  if (!chartFindingDateContextMatches(state)) { closeChartFindingDateDialog({ force: true, restoreFocus: false }); return; }
  const dialog = document.getElementById('chart-finding-date-dialog');
  const input = dialog.querySelector('input');
  const error = dialog.querySelector('#chart-finding-date-error');
  const timestamp = Date.parse(input.value);
  if (!input.reportValidity() || !Number.isFinite(timestamp)) return;
  const patient = getActivePatient();
  const previousChartState = clonePatientChart(patient.chartState);
  const previousDates = new Map(collectDocumentedFindings(patient).flatMap(group => group.memberFindings || [group])
    .filter(finding => state.findingIds.includes(finding.id)).map(finding => [finding.id, finding[state.field]]));
  const date = new Date(timestamp).toISOString();
  error.hidden = true;
  if (!updateChartFindingsByIds(patient, state.findingIds, finding => ({ ...finding, [state.field]: date }))) {
    error.textContent = chartFindingDateText('This procedure is no longer available. Close and reopen the date editor.', 'هذا الإجراء لم يعد متاحاً. أغلق نافذة التاريخ وأعد فتحها.');
    error.hidden = false;
    return;
  }
  state.saving = true;
  dialog.querySelectorAll('button, input').forEach(element => { element.disabled = true; });
  dialog.focus();
  dialog.querySelector('[data-date-save] span').textContent = chartFindingDateText('Saving…', 'جارٍ الحفظ…');
  renderChartFindingTeeth(state.toothIds);
  renderFindingsList();
  let saved = false;
  try { saved = await saveActivePatientChart(patient, { previousChartState }); }
  catch (saveError) {
    console.error('Failed to save procedure date:', saveError);
    updateChartFindingsByIds(patient, state.findingIds, finding => finding[state.field] === date
      ? { ...finding, [state.field]: previousDates.get(finding.id) } : finding);
  }
  if (chartFindingDateContextMatches(state)) { renderChartFindingTeeth(state.toothIds); renderFindingsList(); }
  if (saved && state.field === 'beginDate') {
    state.findingIds.forEach(fid => {
      Object.entries(patient.chartState || {}).forEach(([toothId, toothData]) => {
        if (toothId === CHART_META_KEY || !toothData || typeof toothData !== 'object') return;
        const match = ensureWholeOperations(toothData).find(finding => finding.id === fid);
        if (match) void syncImplantProgressFromChartOperation(patient, toothId, match, null);
      });
    });
  }
  if (chartFindingDateDialogState !== state) return;
  state.saving = false;
  if (saved) {
    // The chart renderer may replace the original button during the save.
    const selector = state.field === 'createdAt' ? '.finding-date-control button' : '.finding-begin-date-control button';
    state.trigger = [...document.querySelectorAll('[data-finding-id]')].find(row => row.dataset.findingId === state.findingIds[0])?.querySelector(selector) || state.trigger;
    closeChartFindingDateDialog();
  } else {
    dialog.querySelectorAll('button, input').forEach(element => { element.disabled = false; });
    dialog.querySelector('[data-date-save] span').textContent = chartFindingDateText('Save date', 'حفظ التاريخ');
    error.textContent = chartFindingDateText('The date could not be saved. Please try again.', 'تعذّر حفظ التاريخ. يرجى المحاولة مرة أخرى.');
    error.hidden = false;
    input.focus();
  }
}
