// Tooth shortcuts show the same finding notes; there is no second notes store.
const chartToothNotesPanel = { patientId: null, toothId: '', trigger: null, editor: null, editFindingId: '' };

function toothNotesText(english, arabic) {
  return currentUiLanguage === 'ar' ? arabic : english;
}

function chartToothNoteFindings(toothId, findings = collectDocumentedFindings(getActivePatient())) {
  const id = String(toothId);
  return findings.filter(finding => finding.kind !== 'mouth'
    && (finding.toothIds || [finding.toothId]).map(String).includes(id));
}

function chartToothNotePreviewMarkup(toothId) {
  const findings = chartToothNoteFindings(toothId);
  const count = findings.reduce((total, finding) => total + normaliseChartOperationNotes(finding.notes).length, 0);
  const groups = findings.map(finding => {
    const notes = normaliseChartOperationNotes(finding.notes);
    const ids = finding.findingIds || [finding.id];
    const teeth = finding.toothIds || [finding.toothId];
    return `<section class="tooth-notes-finding" data-finding-id="${escapeHtml(ids[0] || '')}" data-finding-ids="${escapeHtml(ids.join(','))}" data-tooth-ids="${escapeHtml(teeth.join(','))}">
      <div class="tooth-notes-finding-heading"><h4 dir="auto" data-media-user-content>${escapeHtml(dentalOperationLabel(finding.code))}</h4>${teeth.length > 1 ? `<span>${escapeHtml(toothNotesText(`Shared across ${teeth.length} teeth`, `مشتركة بين ${teeth.length} أسنان`))}</span>` : ''}</div>
      ${notes.length ? notes.map(note => `<article class="tooth-notes-note"><span class="tooth-notes-type ${note.type === 'endo' ? 'is-endo' : ''}">${note.type === 'endo' ? toothNotesText('Endo note', 'ملاحظة علاج جذور') : toothNotesText('General note', 'ملاحظة عامة')}</span>${note.text ? `<p dir="auto" data-media-user-content>${chartFindingNoteTextMarkup(note.text)}</p>` : ''}${note.type === 'endo' ? `<div class="tooth-notes-roots">${note.roots.map(root => `<div><strong dir="ltr">${escapeHtml(root.canal)} · ${escapeHtml(String(root.length))} mm</strong><span dir="auto" data-media-user-content>${escapeHtml(root.referencePoint)}</span></div>`).join('')}</div>` : ''}</article>`).join('') : `<p class="tooth-notes-muted">${toothNotesText('No notes on this finding yet.', 'لا توجد ملاحظات على هذه النتيجة بعد.')}</p>`}
      <button type="button" class="chart-media-button tooth-notes-edit" onclick="openChartFindingNoteEditor(this)"><i data-lucide="${notes.length ? 'notebook-pen' : 'message-square-plus'}" aria-hidden="true"></i>${notes.length ? toothNotesText('Add or edit notes', 'إضافة الملاحظات أو تعديلها') : toothNotesText('Add note', 'إضافة ملاحظة')}</button>
    </section>`;
  }).join('');
  return `<header class="tooth-notes-header"><div><h3 dir="auto">${escapeHtml(chartToothLabel(toothId))}</h3><p>${escapeHtml(toothNotesText(`${count} notes`, `${count} ملاحظات`))}</p></div><button type="button" class="chart-media-button is-neutral" onclick="switchChartMediaTab('xrays')"><i data-lucide="scan-line" aria-hidden="true"></i>${toothNotesText('X-rays', 'الأشعة')}</button></header>
    <div class="tooth-notes-content">${groups || `<div class="tooth-notes-empty"><i data-lucide="sticky-note" aria-hidden="true"></i><strong>${toothNotesText('No findings on this tooth', 'لا توجد نتائج على هذا السن')}</strong><p>${toothNotesText('Add a diagnostic finding to attach notes to it.', 'أضف نتيجة تشخيصية لإرفاق الملاحظات بها.')}</p><button type="button" class="chart-media-button" data-note-tooth="${escapeHtml(toothId)}" onclick="selectToothForFindingNotes(this)"><i data-lucide="plus" aria-hidden="true"></i>${toothNotesText('Add a finding', 'إضافة نتيجة')}</button></div>`}</div>`;
}

function selectToothForFindingNotes(button) {
  const tooth = button.dataset.noteTooth;
  const card = document.getElementById(`tooth-card-${tooth}`);
  if (!card || !hasPageAccess('chart')) return;
  closeChartToothNotesPanel({ restoreFocus: true });
  setChartSelectionTargets([{ tooth, slot: Number(card.dataset.slot), surfaces: ['center'] }], tooth);
  updateSelectionUI();
  const palette = document.getElementById('action-palette-card');
  palette?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  palette?.querySelector('#chart-specialty-rail button:not(:disabled)')?.focus({ preventScroll: true });
}

function renderChartToothNoteIndicators() {
  const patient = getActivePatient();
  const findings = patient ? collectDocumentedFindings(patient) : [];
  document.querySelectorAll('[data-tooth-note-trigger]').forEach(button => {
    const toothId = button.dataset.toothNoteTrigger;
    const count = chartToothNoteFindings(toothId, findings).reduce((total, finding) => total + normaliseChartOperationNotes(finding.notes).length, 0);
    button.classList.toggle('has-notes', count > 0);
    button.dataset.noteCount = String(count);
    button.disabled = !patient || !hasPageAccess('chart');
    const label = `${toothNotesText('Tooth notes', 'ملاحظات السن')} · ${chartToothLabel(toothId)} · ${toothNotesText(`${count} notes`, `${count} ملاحظات`)}`;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-expanded', String(chartToothNotesPanelIsActive() && chartToothNotesPanel.toothId === toothId && !chartPatientMedia.collapsed));
    if (chartToothNotesPanelIsActive() && chartToothNotesPanel.toothId === toothId) {
      chartToothNotesPanel.trigger = button;
      chartMediaPreviousFocus = button;
    }
  });
  if (chartToothNotesPanel.patientId && !chartToothNotesPanelHasContext()) {
    closeChartToothNotesPanel();
  } else {
    renderChartToothNotesPanel();
  }
}

function chartToothNotesPanelIsActive() {
  return chartPatientMedia.activeTab === 'notes' && chartToothNotesPanelHasContext();
}

function chartToothNotesPanelHasContext() {
  return Boolean(chartToothNotesPanel.toothId && chartToothNotesPanel.patientId === getActivePatient()?.id && hasPageAccess('chart'));
}

function openChartToothNotesPanel(event, button) {
  event.preventDefault();
  event.stopPropagation();
  const patient = getActivePatient(), toothId = button.dataset.toothNoteTrigger;
  if (!patient || !toothId || !hasPageAccess('chart')) return;
  if (chartToothNotesPanel.editor && (chartToothNotesPanel.patientId !== patient.id || chartToothNotesPanel.toothId !== toothId)) closeChartFindingNoteEditor();
  closeChartFindingNotePreview();
  Object.assign(chartToothNotesPanel, { patientId: patient.id, toothId, trigger: button });
  chartPatientMedia.activeTab = 'notes';
  chartMediaPreviousFocus = button;
  chartPatientMedia.collapsed = false;
  renderChartMediaPanel();
  renderChartToothNoteIndicators();
  if (chartMediaIsLandscape()) document.getElementById('chart-tooth-notes-panel')?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  else document.getElementById('chart-media-collapse')?.focus({ preventScroll: true });
}

function closeChartToothNotesPanel(options = {}) {
  const trigger = chartToothNotesPanel.trigger;
  Object.assign(chartToothNotesPanel, { patientId: null, toothId: '', trigger: null });
  chartPatientMedia.activeTab = 'xrays';
  if (chartToothNotesPanel.editor) closeChartFindingNoteEditor();
  if (options.restoreFocus && !chartMediaIsLandscape()) chartPatientMedia.collapsed = true;
  if (options.render !== false) {
    renderChartMediaPanel();
    renderChartToothNoteIndicators();
  }
  if (options.restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
  if (options.showXrays) document.getElementById('chart-media-collapse')?.focus({ preventScroll: true });
}

function renderChartToothNotesPanel() {
  const panel = document.getElementById('chart-tooth-notes-panel');
  if (!panel) return;
  const hasContext = chartToothNotesPanelHasContext();
  const active = chartPatientMedia.activeTab === 'notes' && hasPageAccess('chart');
  panel.hidden = !active;
  panel.inert = !active || chartPatientMedia.collapsed;
  panel.setAttribute('aria-hidden', String(panel.inert));
  panel.dir = currentUiLanguage === 'ar' ? 'rtl' : 'ltr';
  if (!hasContext) {
    if (active) panel.innerHTML = `<div class="tooth-notes-empty"><i data-lucide="sticky-note" aria-hidden="true"></i><strong>${toothNotesText('Choose a tooth', 'اختر سنًا')}</strong><p>${toothNotesText('Tap a tooth’s notes icon to view or add diagnostic notes.', 'اضغط على أيقونة ملاحظات السن لعرض الملاحظات التشخيصية أو إضافتها.')}</p><button type="button" class="chart-media-button" onclick="toggleChartMediaPanel()">${toothNotesText('Choose tooth', 'اختيار السن')}</button></div>`;
    else panel.replaceChildren();
    if (window.lucide) lucide.createIcons();
    return;
  }
  if (!panel.querySelector('.tooth-notes-preview')) {
    panel.innerHTML = '<div class="tooth-notes-preview"></div><div class="tooth-notes-editor-host" hidden></div>';
  }
  const preview = panel.querySelector('.tooth-notes-preview');
  preview.hidden = Boolean(chartToothNotesPanel.editor);
  // Keep unsaved inputs mounted during live updates, collapsing, and resizing.
  if (!chartToothNotesPanel.editor) setStableHtml(preview, chartToothNotePreviewMarkup(chartToothNotesPanel.toothId));
  else localiseChartToothNoteEditor();
  if (window.lucide) lucide.createIcons();
}

function mountChartToothNoteEditor(control) {
  if (!chartToothNotesPanelIsActive() || !control?.closest('#chart-tooth-notes-panel')) return false;
  const modal = document.getElementById('modal-chart-finding-notes');
  const dialog = modal.firstElementChild;
  const panel = document.getElementById('chart-tooth-notes-panel');
  chartToothNotesPanel.editor = dialog;
  chartToothNotesPanel.editFindingId = control.closest('[data-finding-id]')?.dataset.findingId || '';
  panel.querySelector('.tooth-notes-preview').hidden = true;
  const host = panel.querySelector('.tooth-notes-editor-host');
  host.hidden = false;
  host.appendChild(dialog);
  localiseChartToothNoteEditor();
  return true;
}

function localiseChartToothNoteEditor() {
  const editor = chartToothNotesPanel.editor;
  if (!editor) return;
  const labels = [
    ['#add-general-chart-note', 'General note', 'ملاحظة عامة'],
    ['#add-endo-chart-note', 'Endo note', 'ملاحظة جذور'],
    ['#save-chart-finding-notes', 'Save notes', 'حفظ الملاحظات'],
    ['button[onclick="closeChartFindingNoteEditor()"]:not([aria-label])', 'Cancel', 'إلغاء'],
    ['button[onclick^="addChartFindingNoteRoot("]', 'Add root', 'إضافة قناة'],
    ['button[onclick^="deleteChartFindingNote("]', 'Delete note', 'حذف الملاحظة']
  ];
  labels.forEach(([selector, english, arabic]) => editor.querySelectorAll(selector).forEach(button => {
    const text = [...button.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    if (text) text.textContent = button.id === 'save-chart-finding-notes' && button.disabled ? toothNotesText('Saving notes…', 'جارٍ حفظ الملاحظات…') : toothNotesText(english, arabic);
  }));
  editor.querySelector('button[onclick="closeChartFindingNoteEditor()"][aria-label]')?.setAttribute('aria-label', toothNotesText('Back to tooth notes', 'العودة لملاحظات السن'));
  editor.querySelectorAll('[data-chart-note-index]').forEach(card => {
    const type = card.querySelector('[data-chart-note-type]');
    type.options[0].textContent = toothNotesText('General', 'عام');
    type.options[1].textContent = toothNotesText('Endo', 'جذور');
    type.closest('label').querySelector('span').textContent = toothNotesText(`Note ${Number(card.dataset.chartNoteIndex) + 1}`, `ملاحظة ${Number(card.dataset.chartNoteIndex) + 1}`);
    const text = card.querySelector('[data-chart-note-text]');
    text.closest('label').querySelector('span').textContent = type.value === 'endo' ? toothNotesText('Endo details (optional)', 'تفاصيل علاج الجذور (اختياري)') : toothNotesText('General note', 'ملاحظة عامة');
    text.placeholder = toothNotesText('Enter the clinical note', 'اكتب الملاحظة السريرية');
  });
  [['[data-endo-root-canal]', 'Root', 'القناة'], ['[data-endo-root-length]', 'Length (mm)', 'الطول (مم)'], ['[data-endo-root-reference]', 'Reference point', 'النقطة المرجعية']]
    .forEach(([selector, english, arabic]) => editor.querySelectorAll(selector).forEach(input => { input.closest('label').querySelector('span').textContent = toothNotesText(english, arabic); }));
  [['Root measurements', 'قياسات القنوات'], ['Choose a root, then enter its length and reference point.', 'اختر قناة ثم أدخل طولها ونقطتها المرجعية.'], ['No notes yet', 'لا توجد ملاحظات بعد'], ['Add a General note or an Endo note above.', 'أضف ملاحظة عامة أو ملاحظة علاج جذور أعلاه.'], ['Add at least one root measurement.', 'أضف قياس قناة واحدة على الأقل.']]
    .forEach(([english, arabic]) => editor.querySelectorAll('p').forEach(label => {
      if (!label.childElementCount && [english, arabic].includes(label.textContent)) label.textContent = toothNotesText(english, arabic);
    }));
}

function unmountChartToothNoteEditor() {
  if (!chartToothNotesPanel.editor) return;
  const editor = chartToothNotesPanel.editor;
  [['#add-general-chart-note', 'Add general note'], ['#add-endo-chart-note', 'Add Endo note'], ['button[onclick="closeChartFindingNoteEditor()"]:not([aria-label])', 'Cancel']]
    .forEach(([selector, label]) => {
      const text = [...(editor.querySelector(selector)?.childNodes || [])].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      if (text) text.textContent = label;
    });
  editor.querySelector('button[onclick="closeChartFindingNoteEditor()"][aria-label]')?.setAttribute('aria-label', 'Close operation notes');
  document.getElementById('modal-chart-finding-notes').appendChild(chartToothNotesPanel.editor);
  chartToothNotesPanel.editor = null;
  document.querySelector('.tooth-notes-editor-host')?.setAttribute('hidden', '');
  renderChartToothNotesPanel();
  const finding = [...document.querySelectorAll('#chart-tooth-notes-panel [data-finding-id]')]
    .find(section => section.dataset.findingId === chartToothNotesPanel.editFindingId);
  finding?.querySelector('button')?.focus({ preventScroll: true });
  chartToothNotesPanel.editFindingId = '';
}

document.addEventListener('DOMContentLoaded', renderChartToothNoteIndicators);
