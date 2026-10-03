// Shared X-ray assignments use independent Universal IDs and clinical Palmer notation.
let patientMediaToothPicker = null;

function mediaTeethText(english, arabic) {
  return currentUiLanguage === 'ar' ? arabic : english;
}

function normalizePatientMediaTeeth(ids) {
  if (!Array.isArray(ids) || ids.length > 52 || ids.some(id => typeof id !== 'string' || !/^([1-9]|[12][0-9]|3[0-2]|[A-T])$/.test(id))) {
    throw new Error(mediaTeethText('Choose valid permanent or deciduous teeth.', 'اختر أسناناً دائمة أو لبنية صحيحة.'));
  }
  return [...new Set(ids)];
}

function patientMediaToothIds(details) {
  // An explicit empty array clears an assignment; older records use the single ID.
  return normalizePatientMediaTeeth(details?.tooth_ids ?? (details?.tooth_id ? [details.tooth_id] : []));
}

function patientMediaTeethLabel(details) {
  return patientMediaToothIds(details).map(patientMediaToothLabel).join(' · ');
}

function setPatientMediaTeeth(prefix, ids) {
  const teeth = normalizePatientMediaTeeth(ids);
  const input = document.getElementById(`${prefix}-media-tooth-ids`);
  if (input) input.value = JSON.stringify(teeth);
  const summary = document.getElementById(`${prefix}-media-teeth-summary`);
  if (summary) summary.textContent = teeth.length ? teeth.map(patientMediaToothLabel).join(' · ') : mediaTeethText('Whole mouth / Unassigned', 'الفم بالكامل / غير محدد');
}

function patientMediaToothChoices(primary) {
  // Keep the anatomical direction fixed in both UI languages, matching the chart.
  return [[1,2,3,4,5,6,7,8], [9,10,11,12,13,14,15,16], [32,31,30,29,28,27,26,25], [24,23,22,21,20,19,18,17]]
    .map(slots => slots.map(slot => ({ slot, id: primary ? PRIMARY_TOOTH_BY_SLOT[slot] : String(slot) })).filter(tooth => tooth.id));
}

function openPatientMediaToothPicker(prefix) {
  if (!['upload', 'edit'].includes(prefix)) return;
  const parent = document.getElementById(prefix === 'upload' ? 'patient-media-upload-modal' : 'patient-media-details-modal');
  if (!parent || parent.classList.contains('hidden')) return;
  closePatientMediaToothPicker(false);
  const ids = normalizePatientMediaTeeth(JSON.parse(document.getElementById(`${prefix}-media-tooth-ids`).value || '[]'));
  patientMediaToothPicker = {
    prefix, parent, parentWasInert: parent.inert, returnFocus: document.activeElement,
    patientId: activePatientMediaPatientId, draft: new Set(ids), dentition: ids.length && ids.every(isPrimaryToothId) ? 'primary' : 'permanent',
  };
  let modal = document.getElementById('patient-media-tooth-picker');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'patient-media-tooth-picker';
    modal.className = 'media-tooth-picker';
    modal.addEventListener('click', event => { if (event.target === modal) closePatientMediaToothPicker(); });
    document.body.append(modal);
  }
  parent.inert = true;
  modal.hidden = false;
  renderPatientMediaToothPicker();
  modal.querySelector('[aria-pressed="true"]').focus();
}

function renderPatientMediaToothPicker() {
  const state = patientMediaToothPicker;
  if (!state) return;
  const primary = state.dentition === 'primary';
  const selected = [...state.draft];
  const counts = { primary: selected.filter(isPrimaryToothId).length, permanent: selected.filter(id => !isPrimaryToothId(id)).length };
  const quadrants = patientMediaToothChoices(primary);
  const row = choices => `<div class="media-teeth-row ${primary ? 'is-primary' : ''}" dir="ltr">${choices.map(({ id, slot }) => {
    const checked = state.draft.has(id);
    return `<button type="button" class="media-tooth-tile ${checked ? 'is-selected' : ''}" data-media-tooth="${id}" aria-pressed="${checked}" aria-label="${escapeHtml(patientMediaToothLabel(id))}" onclick="togglePatientMediaTooth('${id}')">${palmerNotationSVG(id, slot)}<span class="media-tooth-check" aria-hidden="true"><i data-lucide="check"></i></span></button>`;
  }).join('')}</div>`;
  document.getElementById('patient-media-tooth-picker').innerHTML = `
    <section class="media-tooth-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="media-tooth-picker-title" aria-describedby="media-tooth-picker-description">
      <header class="media-tooth-picker-header"><div><h3 id="media-tooth-picker-title">${mediaTeethText('Assign teeth', 'تحديد الأسنان')}</h3><p id="media-tooth-picker-description">${mediaTeethText('Tap one or more teeth, then save.', 'اضغط على سن أو أكثر، ثم احفظ.')}</p></div><button type="button" class="media-teeth-action" aria-label="${mediaTeethText('Close', 'إغلاق')}" onclick="closePatientMediaToothPicker()"><i data-lucide="x"></i></button></header>
      <div class="media-tooth-picker-body">
        <div class="media-teeth-tabs" role="group" aria-label="${mediaTeethText('Dentition', 'نوع الأسنان')}">
          ${[['permanent', mediaTeethText('Permanent', 'دائمة')], ['primary', mediaTeethText('Deciduous', 'لبنية')]].map(([type, label]) => `<button type="button" class="media-teeth-action" data-media-dentition="${type}" aria-pressed="${state.dentition === type}" onclick="switchPatientMediaToothDentition('${type}')">${label}<span class="media-teeth-tab-count">${counts[type]}</span></button>`).join('')}
        </div>
        <fieldset class="media-teeth-arch"><legend>${mediaTeethText('Upper arch', 'الفك العلوي')}</legend>${row(quadrants[0])}${row(quadrants[1])}</fieldset>
        <fieldset class="media-teeth-arch"><legend>${mediaTeethText('Lower arch', 'الفك السفلي')}</legend>${row(quadrants[2])}${row(quadrants[3])}</fieldset>
        <button type="button" class="media-teeth-action media-teeth-clear" onclick="clearPatientMediaToothDraft()" ${selected.length ? '' : 'disabled'}><i data-lucide="eraser"></i>${mediaTeethText('Clear selection', 'مسح التحديد')}</button>
      </div>
      <footer class="media-tooth-picker-footer"><span role="status" aria-live="polite">${mediaTeethText(`${selected.length} ${selected.length === 1 ? 'tooth' : 'teeth'} selected`, `الأسنان المحددة: ${selected.length}`)}</span><div><button type="button" class="media-teeth-action" onclick="closePatientMediaToothPicker()">${mediaTeethText('Cancel', 'إلغاء')}</button><button type="button" class="media-teeth-action media-teeth-save" onclick="savePatientMediaToothPicker()"><i data-lucide="check"></i>${mediaTeethText('Save teeth', 'حفظ الأسنان')}</button></div></footer>
    </section>`;
  if (window.lucide) lucide.createIcons();
}

function togglePatientMediaTooth(id) {
  const state = patientMediaToothPicker;
  if (!state || !patientMediaToothChoices(state.dentition === 'primary').flat().some(tooth => tooth.id === id)) return;
  if (state.draft.has(id)) state.draft.delete(id); else state.draft.add(id);
  renderPatientMediaToothPicker();
  document.querySelector(`[data-media-tooth="${id}"]`)?.focus({ preventScroll: true });
}

function switchPatientMediaToothDentition(dentition) {
  if (!patientMediaToothPicker || !['permanent', 'primary'].includes(dentition)) return;
  patientMediaToothPicker.dentition = dentition;
  renderPatientMediaToothPicker();
  document.querySelector(`[data-media-dentition="${dentition}"]`)?.focus({ preventScroll: true });
}

function clearPatientMediaToothDraft() {
  if (!patientMediaToothPicker) return;
  patientMediaToothPicker.draft.clear();
  renderPatientMediaToothPicker();
  document.querySelector('.media-teeth-save')?.focus({ preventScroll: true });
}

function savePatientMediaToothPicker() {
  const state = patientMediaToothPicker;
  if (!state) return;
  if (state.patientId === activePatientMediaPatientId && !state.parent.classList.contains('hidden')) setPatientMediaTeeth(state.prefix, [...state.draft]);
  closePatientMediaToothPicker();
}

function closePatientMediaToothPicker(restoreFocus = true) {
  const state = patientMediaToothPicker;
  patientMediaToothPicker = null;
  const modal = document.getElementById('patient-media-tooth-picker');
  if (modal) modal.hidden = true;
  if (!state) return;
  state.parent.inert = state.parentWasInert;
  if (restoreFocus && state.returnFocus?.isConnected && !state.parent.classList.contains('hidden')) state.returnFocus.focus({ preventScroll: true });
}

document.addEventListener('keydown', event => {
  if (!patientMediaToothPicker) return;
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopImmediatePropagation(); closePatientMediaToothPicker();
  } else if (event.key === 'Tab') {
    event.stopImmediatePropagation();
    const controls = [...document.querySelectorAll('#patient-media-tooth-picker button:not(:disabled)')];
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
}, true);
