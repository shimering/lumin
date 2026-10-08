// Tooth shortcuts show the same finding notes; there is no second notes store.
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
  return `<header class="tooth-notes-header"><div><h3>${toothNotesText('Tooth notes', 'ملاحظات السن')}</h3><p dir="auto">${escapeHtml(chartToothLabel(toothId))} · ${escapeHtml(toothNotesText(`${count} notes`, `${count} ملاحظات`))}</p></div><button type="button" class="chart-media-button is-neutral" onclick="closeChartFindingNotePreview({restoreFocus:true})" aria-label="${toothNotesText('Close tooth notes', 'إغلاق ملاحظات السن')}"><i data-lucide="x" aria-hidden="true"></i></button></header>
    <div class="tooth-notes-content">${groups || `<div class="tooth-notes-empty"><i data-lucide="sticky-note" aria-hidden="true"></i><strong>${toothNotesText('No findings on this tooth', 'لا توجد نتائج على هذا السن')}</strong><p>${toothNotesText('Add a diagnostic finding to attach notes to it.', 'أضف نتيجة تشخيصية لإرفاق الملاحظات بها.')}</p><button type="button" class="chart-media-button" data-note-tooth="${escapeHtml(toothId)}" onclick="selectToothForFindingNotes(this)"><i data-lucide="plus" aria-hidden="true"></i>${toothNotesText('Add a finding', 'إضافة نتيجة')}</button></div>`}</div>`;
}

function selectToothForFindingNotes(button) {
  const tooth = button.dataset.noteTooth;
  const card = document.getElementById(`tooth-card-${tooth}`);
  if (!card || !hasPageAccess('chart')) return;
  closeChartFindingNotePreview();
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
  });
  const trigger = typeof openChartFindingNoteTrigger !== 'undefined' ? openChartFindingNoteTrigger : null;
  if (trigger?.dataset.toothNoteTrigger && trigger.isConnected) {
    const popover = document.getElementById('chart-finding-note-popover');
    if (popover && !popover.classList.contains('hidden')) {
      setStableHtml(popover, chartToothNotePreviewMarkup(trigger.dataset.toothNoteTrigger));
      popover.dir = currentUiLanguage === 'ar' ? 'rtl' : 'ltr';
      popover.setAttribute('aria-label', toothNotesText('Tooth notes', 'ملاحظات السن'));
      if (window.lucide) lucide.createIcons();
      requestAnimationFrame(positionChartFindingNotePreview);
    }
  }
}

document.addEventListener('DOMContentLoaded', renderChartToothNoteIndicators);
