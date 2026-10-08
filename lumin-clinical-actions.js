// A selection-aware action rail. Catalog and chart writes use the existing chart workflow.
const clinicalActionsPanel = { open: false, selectionKey: '', patientId: null, query: '', specialty: '' };
let clinicalActionsSheetGesture = null;

function clinicalActionsIsMobile() {
  return window.matchMedia('(max-width: 767px)').matches || Boolean(window.LuminMobileNav?.isPhone());
}

function clinicalActionsText(english, arabic) {
  return (typeof currentUiLanguage !== 'undefined' && currentUiLanguage === 'ar') ? arabic : english;
}

function clinicalActionsScopeText(scope) {
  return scope === 'mouth' ? clinicalActionsText('Whole mouth', 'الفم كاملاً')
    : scope === 'surface' ? clinicalActionsText('Selected surfaces', 'الأسطح المحددة')
      : clinicalActionsText('Whole tooth', 'السن كاملاً');
}

function updateClinicalActionsRailLayout() {
  const workspace = document.getElementById('chart-clinical-workspace');
  const panel = document.getElementById('action-palette-card');
  const body = document.getElementById('chart-actions-body');
  const toggle = document.getElementById('chart-actions-toggle');
  if (!workspace || !panel || !body || !toggle) return;
  const mobile = clinicalActionsIsMobile();
  document.documentElement.classList.toggle('chart-actions-mobile', mobile);
  const mediaOpen = typeof chartPatientMedia !== 'undefined' && !chartPatientMedia.collapsed;
  const appointmentsOpen = workspace.classList.contains('has-chart-appointments')
    && typeof chartAppointments !== 'undefined' && !chartAppointments.collapsed;
  // Opening an existing viewer keeps the shared rail usable on a short tablet screen.
  if (mediaOpen || appointmentsOpen) clinicalActionsPanel.open = false;
  workspace.classList.add('has-clinical-actions-panel');
  workspace.classList.toggle('is-clinical-actions-open', clinicalActionsPanel.open);
  workspace.classList.toggle('is-chart-rail-collapsed', !clinicalActionsPanel.open && !mediaOpen && !appointmentsOpen);
  panel.classList.toggle('is-collapsed', !clinicalActionsPanel.open);
  if (!clinicalActionsPanel.open && typeof closeClinicalSpecialtyPicker === 'function') closeClinicalSpecialtyPicker();
  panel.inert = mobile && !clinicalActionsPanel.open;
  if (mobile && clinicalActionsPanel.open) panel.setAttribute('role', 'dialog');
  else panel.removeAttribute('role');
  if (!mobile || !clinicalActionsPanel.open) clearClinicalActionsSheetGesture();
  body.hidden = !clinicalActionsPanel.open;
  body.inert = !clinicalActionsPanel.open;
  toggle.setAttribute('aria-expanded', String(clinicalActionsPanel.open));
  toggle.setAttribute('aria-label', clinicalActionsPanel.open
    ? mobile ? clinicalActionsText('Close clinical actions', 'إغلاق الإجراءات السريرية') : clinicalActionsText('Collapse clinical actions', 'طي الإجراءات السريرية')
    : clinicalActionsText('Expand clinical actions', 'توسيع الإجراءات السريرية'));
  const iconName = mobile && clinicalActionsPanel.open ? 'x' : clinicalActionsPanel.open ? 'panel-right-close' : 'panel-right-open';
  if (toggle.dataset.icon !== iconName) {
    toggle.dataset.icon = iconName;
    toggle.innerHTML = `<i data-lucide="${iconName}" aria-hidden="true"></i>`;
    if (window.lucide) lucide.createIcons();
  }
}

function setClinicalActionsPanelOpen(open) {
  clinicalActionsPanel.open = Boolean(open);
  if (open) {
    if (typeof chartPatientMedia !== 'undefined' && !chartPatientMedia.collapsed) {
      chartPatientMedia.collapsed = true;
      if (typeof renderChartMediaPanel === 'function') renderChartMediaPanel();
    }
    if (typeof chartAppointments !== 'undefined' && !chartAppointments.collapsed) {
      chartAppointments.collapsed = true;
      if (typeof renderChartAppointmentsPanel === 'function') renderChartAppointmentsPanel();
    }
    // The other panels can notify layout while closing; apply the requested state last.
    clinicalActionsPanel.open = true;
  }
  updateClinicalActionsRailLayout();
}

function toggleClinicalActionsPanel() {
  setClinicalActionsPanelOpen(!clinicalActionsPanel.open);
  focusClinicalActionsTrigger();
}

function focusClinicalActionsTrigger() {
  const tooth = chartSelectionTargets().at(-1)?.tooth;
  const trigger = clinicalActionsIsMobile() && !clinicalActionsPanel.open
    ? tooth && document.querySelector(`[data-tooth-card="${CSS.escape(tooth)}"]`)
    : document.getElementById('chart-actions-toggle');
  trigger?.focus({ preventScroll: true });
}

function clearClinicalActionsSheetGesture() {
  clinicalActionsSheetGesture = null;
  const panel = document.getElementById('action-palette-card');
  panel?.style.removeProperty('transform');
  panel?.classList.remove('is-sheet-dragging');
}

function setupClinicalActionsSheetSwipe() {
  const panel = document.getElementById('action-palette-card');
  if (!panel || panel.dataset.swipeReady) return;
  panel.dataset.swipeReady = 'true';
  panel.addEventListener('touchstart', event => {
    clearClinicalActionsSheetGesture();
    if (event.touches.length !== 1 || !clinicalActionsIsMobile() || !clinicalActionsPanel.open
      || event.target.closest('button, a, input, textarea, select, [contenteditable]')) return;
    // Preserve native scrolling until every scroll box under the touch is at its top.
    for (let node = event.target; node && node !== panel; node = node.parentElement) {
      if (node.scrollTop > 0 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return;
    }
    const touch = event.touches[0];
    clinicalActionsSheetGesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, time: event.timeStamp, distance: 0, dragging: false };
  }, { passive: true });
  panel.addEventListener('touchmove', event => {
    const gesture = clinicalActionsSheetGesture;
    if (!gesture) return;
    if (event.touches.length !== 1) { clearClinicalActionsSheetGesture(); return; }
    const touch = [...event.touches].find(touch => touch.identifier === gesture.id);
    if (!touch) return;
    const dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
    if (!gesture.dragging) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      if (dy <= 0 || Math.abs(dx) > dy * .8) { clinicalActionsSheetGesture = null; return; }
      gesture.dragging = true;
      panel.classList.add('is-sheet-dragging');
    }
    if (event.cancelable) event.preventDefault();
    gesture.distance = Math.max(0, dy);
    const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    panel.style.transform = `translateY(${gesture.distance / zoom}px)`;
  }, { passive: false });
  const finish = event => {
    const gesture = clinicalActionsSheetGesture;
    if (!gesture) return;
    const close = gesture.dragging && event.type !== 'touchcancel'
      && (gesture.distance >= Math.min(120, panel.getBoundingClientRect().height * .22)
        || (gesture.distance >= 40 && gesture.distance / Math.max(1, event.timeStamp - gesture.time) > .55));
    if (gesture.dragging && event.cancelable) event.preventDefault();
    clearClinicalActionsSheetGesture();
    if (close) { setClinicalActionsPanelOpen(false); focusClinicalActionsTrigger(); }
  };
  panel.addEventListener('touchend', finish, { passive: false });
  panel.addEventListener('touchcancel', finish, { passive: false });
}

function collapseChartSidePanels() {
  // Record the retained selection so chart refreshes do not reopen the rail.
  syncClinicalActionsPanel();
  clinicalActionsPanel.open = false;
  if (typeof chartPatientMedia !== 'undefined') chartPatientMedia.collapsed = true;
  if (typeof chartAppointments !== 'undefined') chartAppointments.collapsed = true;
  if (typeof renderChartMediaPanel === 'function') renderChartMediaPanel();
  if (typeof renderChartAppointmentsPanel === 'function') renderChartAppointmentsPanel();
  updateClinicalActionsRailLayout();
}

function clearClinicalActionsSelection() {
  activeSelection = emptyChartSelection();
  updateSelectionUI();
}

function renderClinicalActionsOperationList() {
  const list = document.getElementById('chart-actions-operations');
  if (!list || typeof dentalOperations === 'undefined' || typeof dentalSpecialties === 'undefined') return;
  const selectedId = document.getElementById('chart-operation-select')?.value;
  const specialties = activeDentalSpecialties();
  const activeIds = new Set(specialties.map(specialty => specialty.id));
  const query = clinicalActionsPanel.query.trim().toLocaleLowerCase();
  const operations = dentalOperations.filter(operation => operation.active && activeIds.has(operation.specialtyId)
    && (!clinicalActionsPanel.specialty || operation.specialtyId === clinicalActionsPanel.specialty)
    && (!query || `${operation.name} ${operation.code} ${specialties.find(specialty => specialty.id === operation.specialtyId)?.name || ''}`.toLocaleLowerCase().includes(query)));
  const signature = JSON.stringify([operations.map(operation => [operation.id, operation.name, operation.price, operation.actionScope, operation.specialtyId]),
    specialties.map(specialty => [specialty.id, specialty.name]), selectedId, query,
    typeof dentalCustomizationLoaded !== 'undefined' && dentalCustomizationLoaded, clinicalActionsText('en', 'ar')]);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  if (!operations.length) {
    const loading = typeof dentalCustomizationLoaded !== 'undefined' && !dentalCustomizationLoaded;
    list.innerHTML = loading
      ? `<div class="chart-actions-loading" role="status">${clinicalActionsText('Loading procedures…', 'جارٍ تحميل الإجراءات…')}<span></span><span></span><span></span></div>`
      : `<div class="chart-actions-empty"><span><i data-lucide="search-x" aria-hidden="true"></i></span><strong>${clinicalActionsText('No matching procedures', 'لا توجد إجراءات مطابقة')}</strong><p>${clinicalActionsText('Try another search or specialty.', 'جرّب بحثاً أو تخصصاً آخر.')}</p><button type="button" class="chart-actions-button" onclick="resetClinicalActionsFilters()">${clinicalActionsText('Show all procedures', 'عرض كل الإجراءات')}</button></div>`;
  } else {
    list.innerHTML = operations.map(operation => {
      const specialty = specialties.find(item => item.id === operation.specialtyId);
      const selected = selectedId === operation.id;
      return `<button type="button" class="chart-actions-operation" data-clinical-operation="${escapeHtml(operation.id)}" aria-pressed="${selected}">
        <span class="chart-actions-operation-symbol"><i data-lucide="${selected ? 'check' : 'plus'}" aria-hidden="true"></i></span>
        <span class="chart-actions-operation-copy"><strong>${escapeHtml(operation.name)}</strong><small>${escapeHtml(specialty?.name || '')} · ${clinicalActionsScopeText(operation.actionScope)}</small></span>
        <span class="chart-actions-price">${escapeHtml(formatInvoiceMoney(operation.price))}</span>
      </button>`;
    }).join('');
  }
  if (window.lucide) lucide.createIcons();
}

function filterClinicalActionsOperations(value) {
  clinicalActionsPanel.query = String(value || '');
  renderClinicalActionsOperationList();
}

function filterClinicalActionsSpecialty(value) {
  clinicalActionsPanel.specialty = String(value || '');
  renderClinicalSpecialtyPicker();
  renderClinicalActionsOperationList();
}

function resetClinicalActionsFilters() {
  clinicalActionsPanel.query = '';
  clinicalActionsPanel.specialty = '';
  document.getElementById('chart-actions-search').value = '';
  renderClinicalSpecialtyPicker();
  renderClinicalActionsOperationList();
}

function chooseClinicalActionsOperation(operationId) {
  const operation = dentalOperations.find(item => item.id === operationId && item.active);
  if (!operation || !activeDentalSpecialties().some(specialty => specialty.id === operation.specialtyId)) return;
  const specialtySelect = document.getElementById('chart-specialty-select');
  const operationSelect = document.getElementById('chart-operation-select');
  specialtySelect.value = operation.specialtyId;
  renderChartOperationOptions();
  operationSelect.value = operation.id;
  updateClinicalOperationPreview();
  document.querySelector(`[data-clinical-operation="${CSS.escape(operation.id)}"]`)?.focus({ preventScroll: true });
}

function syncClinicalActionsPanel() {
  const panel = document.getElementById('action-palette-card');
  if (!panel || typeof chartSelectionTargets !== 'function') return;
  panel.hidden = false;
  const patientId = typeof activePatientId !== 'undefined' ? activePatientId : null;
  if (clinicalActionsPanel.patientId !== patientId) {
    clinicalActionsPanel.patientId = patientId;
    clinicalActionsPanel.selectionKey = '';
    clinicalActionsPanel.open = false;
    clinicalActionsPanel.query = '';
    clinicalActionsPanel.specialty = '';
    const operationSelect = document.getElementById('chart-operation-select');
    if (operationSelect) operationSelect.value = '';
    const search = document.getElementById('chart-actions-search');
    if (search) search.value = '';
  }
  const targets = chartSelectionTargets();
  const selectionKey = JSON.stringify(targets.map(target => [target.tooth, [...target.surfaces].sort()]));
  if (selectionKey !== clinicalActionsPanel.selectionKey) {
    clinicalActionsPanel.selectionKey = selectionKey;
    setClinicalActionsPanelOpen(Boolean(targets.length));
  }
  panel.dir = clinicalActionsText('ltr', 'rtl');
  panel.lang = clinicalActionsText('en', 'ar');
  document.getElementById('chart-actions-title').textContent = clinicalActionsText('Clinical actions', 'الإجراءات السريرية');
  const search = document.getElementById('chart-actions-search');
  search.placeholder = clinicalActionsText('Search procedures', 'ابحث عن إجراء');
  search.setAttribute('aria-label', search.placeholder);
  document.getElementById('chart-actions-status-label').textContent = clinicalActionsText('Operation status', 'حالة الإجراء');
  const statusSelect = document.getElementById('chart-operation-status-select');
  statusSelect.setAttribute('aria-label', clinicalActionsText('Operation status', 'حالة الإجراء'));
  const statuses = [['P', 'Planned', 'مخطط'], ['In', 'In progress', 'قيد التنفيذ'], ['C', 'Completed', 'مكتمل'], ['E', 'Existed', 'موجود سابقاً']];
  statusSelect.innerHTML = statuses.map(([value, english, arabic]) => `<option value="${value}">${clinicalActionsText(english, arabic)}</option>`).join('');
  statusSelect.value = activeClinicalOperationStatus;
  statusSelect.dataset.status = activeClinicalOperationStatus;
  document.getElementById('chart-actions-operations').setAttribute('aria-label', clinicalActionsText('Dental procedures', 'إجراءات الأسنان'));
  const specialties = activeDentalSpecialties();
  renderClinicalSpecialtyPicker(specialties);
  const clear = document.getElementById('chart-actions-clear-selection');
  clear.disabled = !targets.length;
  clear.setAttribute('aria-label', clinicalActionsText('Clear tooth selection', 'إلغاء تحديد الأسنان'));
  const clearFindings = document.getElementById('chart-actions-clear-findings');
  clearFindings.disabled = !targets.length;
  clearFindings.setAttribute('aria-label', clinicalActionsText('Clear selected tooth findings', 'مسح نتائج الأسنان المحددة'));
  renderClinicalActionsOperationList();
  updateClinicalActionsRailLayout();
}

document.addEventListener('DOMContentLoaded', () => {
  const panel = document.getElementById('action-palette-card');
  if (!panel) return;
  panel.addEventListener('click', event => {
    const operation = event.target.closest('[data-clinical-operation]');
    if (operation) chooseClinicalActionsOperation(operation.dataset.clinicalOperation);
  });
  setupClinicalActionsSheetSwipe();
  syncClinicalActionsPanel();
});

window.addEventListener('resize', () => {
  clearClinicalActionsSheetGesture();
  updateClinicalActionsRailLayout();
}, { passive: true });

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !clinicalActionsIsMobile() || !clinicalActionsPanel.open
    || document.getElementById('view-chart')?.classList.contains('hidden')) return;
  event.preventDefault();
  setClinicalActionsPanelOpen(false);
  focusClinicalActionsTrigger();
});
