// A selection-aware action rail. Catalog and chart writes use the existing chart workflow.
const clinicalActionsPanel = { open: false, selectionKey: '', patientId: null, query: '', specialty: '' };

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
  const mediaOpen = typeof chartPatientMedia !== 'undefined' && !chartPatientMedia.collapsed;
  const appointmentsOpen = workspace.classList.contains('has-chart-appointments')
    && typeof chartAppointments !== 'undefined' && !chartAppointments.collapsed;
  // Opening an existing viewer keeps the shared rail usable on a short tablet screen.
  if (mediaOpen || appointmentsOpen) clinicalActionsPanel.open = false;
  workspace.classList.add('has-clinical-actions-panel');
  workspace.classList.toggle('is-clinical-actions-open', clinicalActionsPanel.open);
  workspace.classList.toggle('is-chart-rail-collapsed', !clinicalActionsPanel.open && !mediaOpen && !appointmentsOpen);
  panel.classList.toggle('is-collapsed', !clinicalActionsPanel.open);
  body.hidden = !clinicalActionsPanel.open;
  body.inert = !clinicalActionsPanel.open;
  toggle.setAttribute('aria-expanded', String(clinicalActionsPanel.open));
  toggle.setAttribute('aria-label', clinicalActionsPanel.open
    ? clinicalActionsText('Collapse clinical actions', 'طي الإجراءات السريرية')
    : clinicalActionsText('Expand clinical actions', 'توسيع الإجراءات السريرية'));
  const iconName = clinicalActionsPanel.open ? 'panel-right-close' : 'panel-right-open';
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
  document.getElementById('chart-actions-toggle')?.focus({ preventScroll: true });
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
  renderClinicalActionsOperationList();
}

function resetClinicalActionsFilters() {
  clinicalActionsPanel.query = '';
  clinicalActionsPanel.specialty = '';
  document.getElementById('chart-actions-search').value = '';
  document.getElementById('chart-actions-specialty-filter').value = '';
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
  const specialtyFilter = document.getElementById('chart-actions-specialty-filter');
  document.getElementById('chart-actions-operations').setAttribute('aria-label', clinicalActionsText('Dental procedures', 'إجراءات الأسنان'));
  const specialties = activeDentalSpecialties();
  if (!specialties.some(specialty => specialty.id === clinicalActionsPanel.specialty)) clinicalActionsPanel.specialty = '';
  specialtyFilter.innerHTML = `<option value="">${clinicalActionsText('All specialties', 'كل التخصصات')}</option>${specialties.map(specialty => `<option value="${escapeHtml(specialty.id)}">${escapeHtml(specialty.name)}</option>`).join('')}`;
  specialtyFilter.value = clinicalActionsPanel.specialty;
  specialtyFilter.setAttribute('aria-label', clinicalActionsText('Filter procedures by specialty', 'تصفية الإجراءات حسب التخصص'));
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
  syncClinicalActionsPanel();
});
