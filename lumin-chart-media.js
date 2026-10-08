// Patient media stays beside the chart; requests are isolated from gallery navigation.
const chartPatientMedia = { patientId: null, files: [], status: 'idle', detailsError: false, request: 0, selectedPath: '', filterToothIds: [], collapsed: true };
let chartMediaPreviousFocus = null;
let patientAttachmentState = null;
let patientAttachmentRequest = 0;
const chartMediaLandscape = window.matchMedia('(min-width: 768px) and (orientation: landscape)');
const chartMediaReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let chartMediaSheetAnimation = null;
let chartMediaSheetTargetOpen = false;
let chartMediaSheetPatientId = null;

function chartMediaText(english, arabic) {
  return currentUiLanguage === 'ar' ? arabic : english;
}

function chartXrayUploadDateMarkup(file) {
  // Uploads retain their Unix timestamp in the storage filename, even after edits.
  const savedTimestamp = /^\d{4}-\d{2}-\d{2}_(\d{10})_/.exec(String(file.filename || ''))?.[1];
  const rawDate = file.uploadedAt || (savedTimestamp ? new Date(Number(savedTimestamp) * 1000).toISOString() : file.modifiedAt);
  const timestamp = rawDate ? Date.parse(rawDate) : NaN;
  if (!Number.isFinite(timestamp)) return `<p class="chart-media-upload-date"><i data-lucide="calendar-days" aria-hidden="true"></i><span>${chartMediaText('Upload date unavailable', 'تاريخ الرفع غير متوفر')}</span></p>`;
  const date = new Date(timestamp);
  const label = new Intl.DateTimeFormat(currentUiLanguage === 'ar' ? 'ar-EG' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
  return `<p class="chart-media-upload-date"><i data-lucide="calendar-days" aria-hidden="true"></i><span>${chartMediaText('Uploaded', 'تاريخ الرفع')}</span> <time datetime="${date.toISOString()}">${escapeHtml(label)}</time></p>`;
}

function updateChartMediaSheetVisibility(panel, open, chartActive) {
  const root = document.documentElement;
  const wasVisible = root.classList.contains('chart-media-sheet-open');
  const samePatient = chartMediaSheetPatientId === chartPatientMedia.patientId;
  const animate = !chartMediaReducedMotion.matches && typeof panel.animate === 'function' && chartActive && !chartMediaIsLandscape()
    && (open || (wasVisible && samePatient));
  if (chartMediaSheetAnimation && animate && samePatient && chartMediaSheetTargetOpen === open) return;
  const oldTransform = wasVisible ? getComputedStyle(panel).transform : 'translateY(100%) scale(.98)';
  const oldOpacity = wasVisible ? getComputedStyle(panel).opacity : '0';
  chartMediaSheetAnimation?.cancel();
  chartMediaSheetAnimation = null;
  chartMediaSheetTargetOpen = open;
  chartMediaSheetPatientId = chartPatientMedia.patientId;
  const show = visible => {
    root.classList.toggle('chart-media-sheet-open', visible);
    document.body.classList.toggle('chart-media-sheet-open', visible);
    const backdrop = document.getElementById('chart-media-backdrop');
    if (backdrop) backdrop.hidden = !visible;
    if (visible) { panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); }
    else { panel.removeAttribute('role'); panel.removeAttribute('aria-modal'); }
  };
  show(open || (animate && wasVisible));
  if (!animate || (wasVisible === open && oldTransform === 'none')) return;
  const animation = panel.animate([
    { transform: oldTransform, opacity: oldOpacity },
    { transform: open ? 'translateY(0) scale(1)' : 'translateY(100%) scale(.98)', opacity: open ? 1 : 0 }
  ], { duration: 360, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'both' });
  chartMediaSheetAnimation = animation;
  animation.finished.then(() => {
    if (chartMediaSheetAnimation !== animation) return;
    chartMediaSheetAnimation = null;
    show(open);
    animation.cancel();
  }).catch(() => {});
}

function chartMediaIsLandscape() {
  return chartMediaLandscape.matches && !window.LuminMobileNav?.isPhone();
}

function patientMediaFileKind(file) {
  const extension = String(file.filename || '').toLowerCase().split('.').pop();
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'].includes(extension)) return 'image';
  if (extension === 'pdf') return 'pdf';
  if (['txt', 'csv', 'log'].includes(extension)) return 'text';
  if (['mp4', 'webm', 'ogv'].includes(extension)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a'].includes(extension)) return 'audio';
  return 'file';
}

function chartPatientXrays(toothIds = chartPatientMedia.filterToothIds) {
  return chartPatientMedia.files.filter(file => patientMediaFileKind(file) === 'image'
    && ['Panoramic', 'Periapical'].includes(file.category)
    && (!toothIds.length || patientMediaToothIds(file.mediaDetails).some(id => toothIds.includes(id))));
}

function renderChartToothXrayIndicators() {
  const counts = new Map();
  const accessible = Boolean(activePatientId && chartPatientMedia.patientId === activePatientId && hasPageAccess('patients'));
  const countsAvailable = accessible && chartPatientMedia.status === 'ready' && !chartPatientMedia.detailsError;
  if (countsAvailable) {
    chartPatientXrays([]).forEach(file => patientMediaToothIds(file.mediaDetails).forEach(id => counts.set(id, (counts.get(id) || 0) + 1)));
  }
  document.querySelectorAll('[data-tooth-xray-slot]').forEach(slot => {
    const id = slot.dataset.toothXraySlot;
    const count = counts.get(id) || 0;
    let button = slot.querySelector('button');
    if (!accessible) { button?.remove(); return; }
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'chart-tooth-xray-indicator';
      button.setAttribute('aria-controls', 'chart-media-panel');
      button.innerHTML = '<span><i data-lucide="scan-line" aria-hidden="true"></i><small></small></span>';
      button.addEventListener('pointerdown', event => event.stopPropagation());
      button.addEventListener('click', event => { event.stopPropagation(); showChartToothXrays(id, button); });
      slot.appendChild(button);
    }
    const selected = chartPatientMedia.filterToothIds.includes(id);
    const label = chartMediaText(selected ? 'Remove from X-ray filter: ' : 'Add to X-ray filter: ', selected ? 'إزالة من فلتر الأشعة: ' : 'إضافة إلى فلتر الأشعة: ')
      + patientMediaToothLabel(id) + (countsAvailable ? ' · ' + chartMediaText(`${count} X-ray${count === 1 ? '' : 's'}`, `${count} صور أشعة`) : '');
    button.setAttribute('aria-label', label);
    button.title = label;
    button.classList.toggle('is-unassigned', !count);
    button.setAttribute('aria-pressed', String(selected));
    button.querySelector('small').textContent = count || '';
    button.querySelector('small').hidden = !count;
  });
  if (window.lucide) lucide.createIcons();
}

function showChartToothXrays(toothId, trigger = document.activeElement) {
  const id = normalizePatientMediaTeeth([toothId])[0];
  if (!id || chartPatientMedia.patientId !== activePatientId || !hasPageAccess('patients')) return;
  chartMediaPreviousFocus = trigger;
  const selected = chartPatientMedia.filterToothIds;
  chartPatientMedia.filterToothIds = selected.includes(id) ? selected.filter(tooth => tooth !== id) : [...selected, id];
  chartPatientMedia.collapsed = false;
  renderChartMediaPanel();
  if (!chartMediaIsLandscape()) document.getElementById('chart-media-collapse')?.focus({ preventScroll: true });
}

function clearChartXrayFilter() {
  chartPatientMedia.filterToothIds = [];
  renderChartMediaPanel();
}

function removeChartXrayFilterTooth(toothId) {
  chartPatientMedia.filterToothIds = chartPatientMedia.filterToothIds.filter(id => id !== toothId);
  renderChartMediaPanel();
  document.getElementById('chart-media-filter-teeth')?.focus({ preventScroll: true });
}

function chartMediaFilterMarkup() {
  const teeth = chartPatientMedia.filterToothIds;
  return `<div class="chart-media-filter"><div class="chart-media-filter-heading"><span><i data-lucide="filter" aria-hidden="true"></i>${chartMediaText('Tooth filter', 'فلتر الأسنان')}</span><button id="chart-media-filter-teeth" type="button" class="chart-media-button is-neutral" aria-haspopup="dialog" onclick="openPatientMediaToothPicker('chart-filter')"><i data-lucide="scan-line" aria-hidden="true"></i>${chartMediaText('Choose teeth', 'اختيار الأسنان')}</button></div>${teeth.length ? `<div class="chart-media-filter-chips">${teeth.map(id => `<button type="button" class="chart-media-button chart-media-filter-chip" onclick="removeChartXrayFilterTooth('${id}')" aria-label="${escapeHtml(chartMediaText('Remove from X-ray filter: ', 'إزالة من فلتر الأشعة: ') + patientMediaToothLabel(id))}"><span dir="auto">${escapeHtml(patientMediaToothLabel(id))}</span><i data-lucide="x" aria-hidden="true"></i></button>`).join('')}</div><button type="button" class="chart-media-button is-neutral" data-chart-clear-filter onclick="clearChartXrayFilter()"><i data-lucide="x" aria-hidden="true"></i>${chartMediaText('Show all X-rays', 'عرض كل الأشعة')}</button>` : `<p class="chart-media-summary">${chartMediaText('Showing all X-rays. Tap tooth icons or choose teeth to filter.', 'عرض كل الأشعة. اضغط على أيقونات الأشعة أو اختر الأسنان لتصفية الصور.')}</p>`}</div>`;
}

function chartPatientAttachments() {
  return chartPatientMedia.files.filter(file => patientMediaFileKind(file) !== 'image' || !['Panoramic', 'Periapical'].includes(file.category));
}

function patientMediaAuthenticatedUrl(file) {
  return `${patientMediaFileUrl(file)}?key=${encodeURIComponent(getStorageServerConfig().key)}`;
}

function patientMediaThumbnailUrl(file) {
  const config = getStorageServerConfig();
  return `${config.url}/api/thumbnail/${file.relativePath.split('/').map(encodeURIComponent).join('/')}?key=${encodeURIComponent(config.key)}`;
}

function updateChartMediaStickyTop() {
  const panel = document.getElementById('chart-media-panel');
  if (!panel) return;
  const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const panelBounds = panel.getBoundingClientRect();
  let stickyTop = 24;
  ['app-header', 'patient-workspace-header'].forEach(id => {
    // On desktop this header is a full-height navigation rail, not a top header.
    if (id === 'app-header' && window.matchMedia('(min-width: 1024px)').matches) return;
    const element = document.getElementById(id);
    if (!element || element.classList.contains('hidden')) return;
    const style = getComputedStyle(element);
    if (!['fixed', 'sticky'].includes(style.position) || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return;
    const bounds = element.getBoundingClientRect();
    if (bounds.right <= panelBounds.left || bounds.left >= panelBounds.right) return;
    const top = Number.parseFloat(style.top);
    if (!Number.isFinite(top)) return;
    stickyTop = Math.max(stickyTop, top + bounds.height / zoom + 16);
  });
  panel.style.setProperty('--chart-media-sticky-top', `${Math.ceil(stickyTop)}px`);
  document.getElementById('chart-side-panels')?.style.setProperty('--chart-media-sticky-top', `${Math.ceil(stickyTop)}px`);
}

function toggleChartMediaPanel() {
  if (chartPatientMedia.collapsed) chartMediaPreviousFocus = document.activeElement;
  chartPatientMedia.collapsed = !chartPatientMedia.collapsed;
  if (chartMediaIsLandscape() && typeof chartAppointments !== 'undefined' && chartAppointmentsCanView()) {
    chartAppointments.collapsed = chartPatientMedia.collapsed;
    renderChartAppointmentsPanel();
  }
  renderChartMediaPanel();
  if (!chartMediaIsLandscape()) {
    if (chartPatientMedia.collapsed) chartMediaPreviousFocus?.focus({ preventScroll: true });
    else document.getElementById('chart-media-collapse')?.focus({ preventScroll: true });
  }
}

async function loadChartPatientMedia(patientId = activePatientId) {
  const request = ++chartPatientMedia.request;
  const patient = getKnownPatient(patientId);
  if (chartPatientMedia.patientId !== patientId) {
    chartPatientMedia.selectedPath = '';
    chartPatientMedia.filterToothIds = [];
    chartPatientMedia.collapsed = !(typeof chartAppointmentsCanView === 'function' && chartAppointmentsCanView() && chartMediaIsLandscape());
    chartMediaPreviousFocus = null;
    if (typeof patientMediaUploadContext !== 'undefined' && patientMediaUploadContext?.fromChart) closePatientMediaUploadModal();
    if (patientMediaToothPicker?.prefix === 'chart-filter') closePatientMediaToothPicker(false);
  }
  chartPatientMedia.patientId = patientId;
  chartPatientMedia.files = [];
  chartPatientMedia.detailsError = false;
  chartPatientMedia.status = 'loading';
  renderChartMediaPanel();
  if (patientAttachmentState && patientAttachmentState.patientId !== patientId) closePatientAttachmentModal();
  if (patientAttachmentState?.mode === 'list') renderPatientAttachmentList();
  if (!patient || !hasPageAccess('patients')) {
    chartPatientMedia.status = 'unavailable'; renderChartMediaPanel(); renderPatientAttachmentList(); return;
  }
  const config = getStorageServerConfig();
  if (!config.url) { chartPatientMedia.status = 'unconfigured'; renderChartMediaPanel(); renderPatientAttachmentList(); return; }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch(`${config.url}/api/patient/${encodeURIComponent(patient.id)}/files?name=${encodeURIComponent(patient.name || '')}`, {
        headers: { 'x-lumin-key': config.key }, signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      response = await response.json();
    } finally { clearTimeout(timeout); }
    if (request !== chartPatientMedia.request || activePatientId !== patient.id) return;
    chartPatientMedia.detailsError = response.metadataSource !== 'local' || Boolean(response.metadataUnavailable);
    chartPatientMedia.files = (response.files || []).map(file => ({ ...file,
      mediaDetails: chartPatientMedia.detailsError ? null : file.mediaDetails || null }));
    chartPatientMedia.status = 'ready';
    renderChartMediaPanel();
    if (patientAttachmentState?.mode === 'list' && patientAttachmentState.patientId === patient.id) renderPatientAttachmentList();
  } catch (error) {
    if (request !== chartPatientMedia.request || activePatientId !== patient.id) return;
    chartPatientMedia.status = 'error';
    renderChartMediaPanel();
    if (patientAttachmentState?.mode === 'list') renderPatientAttachmentList();
  }
}

function renderChartMediaPanel() {
  const panel = document.getElementById('chart-media-panel');
  const body = document.getElementById('chart-media-panel-body');
  const workspace = document.getElementById('chart-clinical-workspace');
  if (!panel || !body || !workspace) return;
  const focusWasInsidePanel = panel.contains(document.activeElement);
  const chartActive = !document.getElementById('view-chart').classList.contains('hidden');
  document.documentElement.classList.toggle('chart-media-landscape', chartMediaIsLandscape());
  document.documentElement.classList.toggle('chart-media-active', chartActive);
  document.body.classList.toggle('chart-media-active', chartActive);
  workspace.classList.toggle('is-media-collapsed', chartPatientMedia.collapsed);
  if (typeof updateChartSidePanelLayout === 'function') updateChartSidePanelLayout();
  const sheetOpen = chartActive && !chartMediaIsLandscape() && !chartPatientMedia.collapsed;
  let backdrop = document.getElementById('chart-media-backdrop');
  if (sheetOpen && !backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'chart-media-backdrop';
    backdrop.addEventListener('click', () => { if (!chartPatientMedia.collapsed) toggleChartMediaPanel(); });
    document.body.appendChild(backdrop);
  }
  body.inert = chartPatientMedia.collapsed;
  body.setAttribute('aria-hidden', String(chartPatientMedia.collapsed));
  const sharedSidebar = chartMediaIsLandscape() && typeof chartAppointmentsCanView === 'function' && chartAppointmentsCanView();
  const expand = sharedSidebar ? chartMediaText('Expand X-rays and appointments', 'توسيع الأشعة والمواعيد') : chartMediaText('Expand X-ray viewer', 'توسيع عارض الأشعة');
  const collapse = sharedSidebar ? chartMediaText('Collapse X-rays and appointments', 'طي الأشعة والمواعيد') : sheetOpen ? chartMediaText('Close X-ray viewer', 'إغلاق عارض الأشعة') : chartMediaText('Collapse X-ray viewer', 'طي عارض الأشعة');
  const panelToggle = document.getElementById('chart-media-collapse');
  panelToggle.setAttribute('aria-controls', sharedSidebar ? 'chart-media-panel-body chart-appointments-body' : 'chart-media-panel-body');
  panelToggle.setAttribute('aria-expanded', String(!chartPatientMedia.collapsed));
  panelToggle.setAttribute('aria-label', chartPatientMedia.collapsed ? expand : collapse);
  panelToggle.title = chartPatientMedia.collapsed ? expand : collapse;
  panelToggle.innerHTML = `<i data-lucide="${sheetOpen ? 'x' : chartPatientMedia.collapsed ? 'panel-right-open' : 'panel-right-close'}"></i>`;
  document.getElementById('chart-media-panel-title').textContent = chartMediaText('X-rays', 'الأشعة');
  const xrays = chartPatientXrays();
  if (chartPatientMedia.status === 'loading') {
    body.innerHTML = `<div class="chart-media-skeleton"></div><p class="chart-media-summary" style="margin-top:16px" role="status">${chartMediaText('Loading patient files…', 'جارٍ تحميل ملفات المريض…')}</p>`;
  } else if (['error', 'unconfigured', 'unavailable'].includes(chartPatientMedia.status)) {
    const configured = chartPatientMedia.status !== 'unconfigured';
    body.innerHTML = `<div class="chart-media-empty"><i data-lucide="${configured ? 'cloud-off' : 'hard-drive'}"></i><h4>${chartMediaText('Patient files unavailable', 'ملفات المريض غير متاحة')}</h4><p>${chartPatientMedia.status === 'unavailable' ? chartMediaText('Patient record access is required.', 'يلزم توفر صلاحية الوصول إلى سجل المريض.') : configured ? chartMediaText('Check the clinic storage connection and try again.', 'تحقق من اتصال خادم التخزين ثم أعد المحاولة.') : chartMediaText('Connect your clinic storage in Settings.', 'اربط خادم تخزين العيادة من الإعدادات.')}</p>${chartPatientMedia.status === 'unavailable' ? '' : `<button type="button" class="chart-media-button" onclick="${configured ? 'loadChartPatientMedia()' : 'openStorageSettings()'}"><i data-lucide="${configured ? 'refresh-cw' : 'settings'}"></i>${configured ? chartMediaText('Retry', 'إعادة المحاولة') : chartMediaText('Storage settings', 'إعدادات التخزين')}</button>`}</div>`;
  } else if (!xrays.length) {
    chartPatientMedia.selectedPath = '';
    body.innerHTML = `<div class="chart-media-empty"><i data-lucide="scan-line"></i><h4>${chartPatientMedia.filterToothIds.length ? chartMediaText('No X-rays assigned to the selected teeth', 'لا توجد أشعة مرتبطة بالأسنان المحددة') : chartMediaText('No X-rays yet', 'لا توجد أشعة بعد')}</h4><p>${chartMediaText('Add an X-ray above. The selected teeth will be assigned automatically.', 'أضف أشعة من الزر أعلاه. سيتم تحديد الأسنان المختارة تلقائيًا.')}</p></div>${chartMediaPanelActions()}`;
  } else {
    let selected = xrays.findIndex(file => file.relativePath === chartPatientMedia.selectedPath);
    if (selected < 0) selected = 0;
    const file = xrays[selected];
    chartPatientMedia.selectedPath = file.relativePath;
    const index = chartPatientMedia.files.indexOf(file);
    const name = patientMediaDisplayName(file);
    const tooth = patientMediaTeethLabel(file.mediaDetails);
    const note = file.mediaDetails?.note ?? file.note ?? '';
    body.innerHTML = `
      <p class="chart-media-summary" data-media-user-content dir="auto">${escapeHtml(getKnownPatient(chartPatientMedia.patientId)?.name || '')}</p>
      <button type="button" class="chart-media-preview" onclick="openChartPatientMediaFile(${index})" aria-label="${escapeHtml(chartMediaText('Open X-ray: ', 'فتح الأشعة: ') + name)}"><img src="${escapeHtml(patientMediaThumbnailUrl(file))}" alt="${escapeHtml(name)}" data-media-user-content ${typeof patientMediaRotationAttributes === 'function' ? patientMediaRotationAttributes(file, chartPatientMedia.patientId) : ''} onerror="fallbackChartMediaImage(this, ${index})" /></button>
      <div class="chart-media-caption"><h4 data-media-user-content dir="auto">${escapeHtml(name)}</h4>${chartXrayUploadDateMarkup(file)}${tooth ? `<span class="chart-media-tooth" dir="auto">${escapeHtml(tooth)}</span>` : ''}${note ? `<p class="chart-media-note" data-media-user-content dir="auto">${escapeHtml(note)}</p>` : ''}</div>
      <div class="chart-media-nav"><button type="button" class="chart-media-button is-neutral" onclick="stepChartPatientXray(-1)" aria-label="${chartMediaText('Previous X-ray', 'الأشعة السابقة')}" ${xrays.length < 2 ? 'disabled' : ''}><i data-lucide="chevron-left"></i></button><span dir="ltr">${selected + 1} / ${xrays.length}</span>${typeof rotateChartPatientXray === 'function' ? `<button type="button" class="chart-media-button is-neutral" data-chart-rotate-xray onclick="rotateChartPatientXray(${index})"><i data-lucide="rotate-cw" aria-hidden="true"></i></button>` : ''}<button type="button" class="chart-media-button is-neutral" onclick="openChartPatientMediaFile(${index})" aria-label="${chartMediaText('Enlarge X-ray', 'تكبير الأشعة')}"><i data-lucide="maximize-2"></i></button><button type="button" class="chart-media-button is-neutral" onclick="stepChartPatientXray(1)" aria-label="${chartMediaText('Next X-ray', 'الأشعة التالية')}" ${xrays.length < 2 ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button></div>
      ${typeof rotateChartPatientXray === 'function' ? `<p class="xray-rotation-status chart-media-rotation" data-chart-rotation-status role="status" aria-live="polite" hidden></p>` : ''}
      <div class="chart-media-thumbnails" aria-label="${chartMediaText('Patient X-rays', 'أشعة المريض')}">${xrays.map(item => `<button type="button" class="chart-media-thumbnail" onclick="selectChartPatientXray(${chartPatientMedia.files.indexOf(item)})" aria-pressed="${item === file}" aria-label="${escapeHtml(patientMediaDisplayName(item))}"><img src="${escapeHtml(patientMediaThumbnailUrl(item))}" alt="" ${typeof patientMediaRotationAttributes === 'function' ? patientMediaRotationAttributes(item, chartPatientMedia.patientId) : ''} loading="lazy" onerror="fallbackChartMediaImage(this, ${chartPatientMedia.files.indexOf(item)})" /></button>`).join('')}</div>${chartMediaPanelActions()}`;
  }
  if (chartPatientMedia.detailsError) body.insertAdjacentHTML('afterbegin', `<p class="chart-media-summary" role="status">${chartMediaText('Saved names, tooth assignments, and notes could not be loaded.', 'تعذر تحميل الأسماء وتحديد الأسنان والملاحظات المحفوظة.')}</p>`);
  if (chartPatientMedia.patientId === activePatientId && hasPageAccess('patients')) {
    body.insertAdjacentHTML('afterbegin', `<div class="chart-media-tools"><div class="chart-media-add"><button type="button" class="chart-media-button" data-chart-add-xray onclick="openChartPatientMediaUpload()"><i data-lucide="plus" aria-hidden="true"></i>${chartMediaText('Add X-ray', 'إضافة أشعة')}</button></div>${chartMediaFilterMarkup()}</div>`);
  }
  renderChartToothXrayIndicators();
  if (typeof fitPatientMediaRotations === 'function') fitPatientMediaRotations(panel);
  if (typeof renderPatientMediaRotationControls === 'function') renderPatientMediaRotationControls();
  updateChartMediaSheetVisibility(panel, sheetOpen, chartActive);
  updateChartMediaStickyTop();
  if (window.lucide) lucide.createIcons();
  if (sheetOpen && focusWasInsidePanel && !panel.contains(document.activeElement)) panelToggle.focus({ preventScroll: true });
}

function chartMediaPanelActions() {
  return `<div class="chart-media-panel-actions"><button type="button" data-chart-attachments class="chart-media-button" onclick="openPatientAttachmentList()"><i data-lucide="paperclip"></i>${chartMediaText('Attachments', 'المرفقات')}<span class="chart-media-count">${chartPatientAttachments().length}</span></button><button type="button" class="chart-media-button is-neutral" onclick="openChartMediaGallery()"><i data-lucide="images"></i>${chartMediaText('Gallery', 'المعرض')}</button></div>`;
}

function openChartMediaGallery() {
  if (!chartMediaIsLandscape() && !chartPatientMedia.collapsed) toggleChartMediaPanel();
  openPatientWorkspaceTab('media');
}

function fallbackChartMediaImage(image, index) {
  const file = chartPatientMedia.files[index];
  if (!file) return;
  if (!image.dataset.originalAttempted) { image.dataset.originalAttempted = 'true'; image.src = patientMediaAuthenticatedUrl(file); return; }
  image.onerror = null;
  image.hidden = true;
  if (image.closest('.chart-media-preview')) image.parentElement.insertAdjacentHTML('beforeend', `<span class="chart-media-image-error">${chartMediaText('Preview unavailable. Tap to open the original.', 'المعاينة غير متاحة. اضغط لفتح الصورة الأصلية.')}</span>`);
}

function selectChartPatientXray(index) {
  const file = chartPatientMedia.files[index];
  if (!file || chartPatientMedia.patientId !== activePatientId || !chartPatientXrays().includes(file)) return;
  chartPatientMedia.selectedPath = file.relativePath;
  renderChartMediaPanel();
}

function stepChartPatientXray(step) {
  const xrays = chartPatientXrays();
  if (!xrays.length) return;
  const current = Math.max(0, xrays.findIndex(file => file.relativePath === chartPatientMedia.selectedPath));
  chartPatientMedia.selectedPath = xrays[(current + step + xrays.length) % xrays.length].relativePath;
  renderChartMediaPanel();
}

function openChartPatientMediaFile(index) {
  const file = chartPatientMedia.files[index];
  if (!file || chartPatientMedia.patientId !== activePatientId) return;
  openPatientMediaFile(file, chartPatientMedia.patientId);
}

function openChartPatientMediaUpload(attachment = false) {
  const patientId = chartPatientMedia.patientId;
  if (!patientId || patientId !== activePatientId || !hasPageAccess('patients')) return;
  closePatientAttachmentModal();
  openPatientMediaUploadModal({ patientId, fromChart: true, category: attachment ? 'General' : 'Periapical', toothIds: attachment ? [] : [...chartPatientMedia.filterToothIds] });
}

function ensurePatientAttachmentModal() {
  let modal = document.getElementById('patient-attachment-modal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'patient-attachment-modal';
  modal.className = 'patient-attachment-modal';
  modal.hidden = true;
  modal.innerHTML = `<div class="patient-attachment-dialog" role="dialog" aria-modal="true" aria-labelledby="patient-attachment-title"><header class="patient-attachment-header"><div class="patient-attachment-heading"><h3 id="patient-attachment-title"></h3><p id="patient-attachment-subtitle" data-media-user-content dir="auto"></p></div><button type="button" class="chart-media-button is-neutral" onclick="closePatientAttachmentModal()" aria-label="${chartMediaText('Close', 'إغلاق')}"><i data-lucide="x"></i></button></header><div id="patient-attachment-content" class="patient-attachment-content" aria-live="polite"></div><footer id="patient-attachment-footer" class="patient-attachment-footer"></footer></div>`;
  modal.addEventListener('click', event => { if (event.target === modal) closePatientAttachmentModal(); });
  document.body.appendChild(modal);
  return modal;
}

function showPatientAttachmentModal(patientId, mode) {
  const modal = ensurePatientAttachmentModal();
  const previousFocus = patientAttachmentState?.previousFocus || document.activeElement;
  patientAttachmentState = { patientId, mode, previousFocus };
  document.body.classList.add('patient-attachment-open');
  modal.hidden = false;
  modal.querySelector('.patient-attachment-dialog').classList.toggle('is-list', mode === 'list');
  modal.querySelector('header button').setAttribute('aria-label', chartMediaText('Close', 'إغلاق'));
  modal.querySelector('header button').focus();
  return modal;
}

function openPatientAttachmentList() {
  if (!hasPageAccess('patients')) return;
  patientAttachmentRequest++;
  showPatientAttachmentModal(activePatientId, 'list');
  if (chartPatientMedia.patientId !== activePatientId || chartPatientMedia.status === 'idle') void loadChartPatientMedia();
  renderPatientAttachmentList();
}

function renderPatientAttachmentList() {
  const modal = document.getElementById('patient-attachment-modal');
  if (!modal || patientAttachmentState?.mode !== 'list') return;
  document.getElementById('patient-attachment-title').textContent = chartMediaText('Attachments', 'المرفقات');
  document.getElementById('patient-attachment-subtitle').textContent = getKnownPatient(patientAttachmentState.patientId)?.name || '';
  const content = document.getElementById('patient-attachment-content');
  const files = chartPatientAttachments();
  if (chartPatientMedia.status === 'loading') content.innerHTML = `<p class="chart-media-summary">${chartMediaText('Loading patient files…', 'جارٍ تحميل ملفات المريض…')}</p><div class="chart-media-skeleton"></div>`;
  else if (chartPatientMedia.status !== 'ready') content.innerHTML = `<div class="chart-media-empty"><i data-lucide="cloud-off"></i><h4>${chartMediaText('Patient files unavailable', 'ملفات المريض غير متاحة')}</h4><p>${chartMediaText('Check the clinic storage connection and try again.', 'تحقق من اتصال خادم التخزين ثم أعد المحاولة.')}</p><button type="button" class="chart-media-button" onclick="loadChartPatientMedia()"><i data-lucide="refresh-cw"></i>${chartMediaText('Retry', 'إعادة المحاولة')}</button></div>`;
  else if (!files.length) content.innerHTML = `<div class="chart-media-empty"><i data-lucide="paperclip"></i><h4>${chartMediaText('No attachments yet', 'لا توجد مرفقات بعد')}</h4><p>${chartMediaText('Add PDFs, reports, photos, or other patient files.', 'أضف ملفات PDF أو تقارير أو صورًا أو ملفات أخرى للمريض.')}</p></div>`;
  else content.innerHTML = files.map(file => {
    const index = chartPatientMedia.files.indexOf(file);
    return `<article class="patient-attachment-row"><i data-lucide="${patientMediaFileKind(file) === 'image' ? 'image' : 'file-text'}"></i><div class="patient-attachment-row-info"><h4 data-media-user-content dir="auto">${escapeHtml(patientMediaDisplayName(file))}</h4><p>${escapeHtml(String(file.filename).split('.').pop().toUpperCase())} · ${(Number(file.sizeBytes || 0) / 1024).toFixed(0)} KB</p></div><button type="button" class="chart-media-button" onclick="openChartPatientMediaFile(${index})" aria-label="${escapeHtml(chartMediaText('View ', 'عرض ') + patientMediaDisplayName(file))}"><i data-lucide="eye"></i></button><a class="chart-media-button is-neutral" href="${escapeHtml(patientMediaAuthenticatedUrl(file))}" download="${escapeHtml(patientMediaDownloadName(file))}" target="_blank" rel="noopener" aria-label="${chartMediaText('Download', 'تنزيل')}"><i data-lucide="download"></i></a></article>`;
  }).join('');
  document.getElementById('patient-attachment-footer').innerHTML = `<button type="button" class="chart-media-button" onclick="openChartPatientMediaUpload(true)"><i data-lucide="plus"></i>${chartMediaText('Add attachment', 'إضافة مرفق')}</button>`;
  if (window.lucide) lucide.createIcons();
}

async function openPatientMediaFile(file, patientId) {
  if (!hasPageAccess('patients')) return;
  const kind = patientMediaFileKind(file);
  if (kind === 'image') {
    closePatientAttachmentModal();
    if (patientId === chartPatientMedia.patientId && !document.getElementById('view-chart')?.classList.contains('hidden')) {
      currentPatientMediaFiles = chartPatientMedia.files;
      activePatientMediaPatientId = patientId;
      patientMediaDetailsError = chartPatientMedia.detailsError;
    }
    openMediaLightbox(patientMediaFileUrl(file), file.category, patientMediaDisplayName(file), file.modifiedAt?.split('T')[0] || '', patientMediaThumbnailUrl(file), file.relativePath);
    return;
  }
  const request = ++patientAttachmentRequest;
  showPatientAttachmentModal(patientId, 'file');
  const name = patientMediaDisplayName(file);
  const url = patientMediaAuthenticatedUrl(file);
  document.getElementById('patient-attachment-title').textContent = chartMediaText('File preview', 'معاينة الملف');
  document.getElementById('patient-attachment-subtitle').textContent = name;
  const content = document.getElementById('patient-attachment-content');
  content.replaceChildren();
  document.getElementById('patient-attachment-footer').innerHTML = `${patientId === chartPatientMedia.patientId ? `<button type="button" class="chart-media-button is-neutral" onclick="openPatientAttachmentList()"><i data-lucide="paperclip"></i>${chartMediaText('Attachments', 'المرفقات')}</button>` : ''}<a class="chart-media-button is-neutral" href="${escapeHtml(url)}" target="_blank" rel="noopener"><i data-lucide="external-link"></i>${chartMediaText('Open in new tab', 'فتح في علامة تبويب جديدة')}</a><a class="chart-media-button" href="${escapeHtml(url)}" download="${escapeHtml(patientMediaDownloadName(file))}" target="_blank" rel="noopener"><i data-lucide="download"></i>${chartMediaText('Download', 'تنزيل')}</a>`;
  if (window.lucide) lucide.createIcons();
  if (kind === 'pdf') {
    const frame = document.createElement('iframe');
    frame.title = name;
    frame.src = url;
    content.appendChild(frame);
  } else if (kind === 'audio' || kind === 'video') {
    const player = document.createElement(kind);
    player.controls = true;
    player.src = url;
    content.appendChild(player);
  } else if (kind === 'text') {
    content.textContent = chartMediaText('Loading preview…', 'جارٍ تحميل المعاينة…');
    try {
      if (Number(file.sizeBytes) > 2 * 1024 * 1024) throw new Error('Preview too large');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (request !== patientAttachmentRequest || patientAttachmentState?.mode !== 'file') return;
      const preview = document.createElement('pre');
      preview.dir = 'auto';
      preview.dataset.mediaUserContent = '';
      preview.textContent = text;
      content.replaceChildren(preview);
    } catch (_) {
      if (request !== patientAttachmentRequest) return;
      content.innerHTML = patientAttachmentUnavailablePreview();
    }
  } else content.innerHTML = patientAttachmentUnavailablePreview();
  if (window.lucide) lucide.createIcons();
}

function resetChartPatientMedia() {
  closePatientMediaToothPicker(false);
  if (typeof patientMediaUploadContext !== 'undefined' && patientMediaUploadContext?.fromChart) closePatientMediaUploadModal();
  chartPatientMedia.request++;
  chartPatientMedia.patientId = null;
  chartPatientMedia.files = [];
  chartPatientMedia.selectedPath = '';
  chartPatientMedia.filterToothIds = [];
  chartPatientMedia.collapsed = true;
  chartPatientMedia.detailsError = false;
  chartMediaPreviousFocus = null;
  chartPatientMedia.status = 'idle';
  closePatientAttachmentModal();
  renderChartMediaPanel();
}

function patientAttachmentUnavailablePreview() {
  return `<div class="chart-media-empty"><i data-lucide="file-down"></i><h4>${chartMediaText('Open with a compatible app', 'افتح باستخدام تطبيق يدعم الملف')}</h4><p>${chartMediaText('This file format cannot be previewed here. Download it to view it on your device.', 'لا يمكن معاينة هذا النوع هنا. نزّل الملف لعرضه على جهازك.')}</p></div>`;
}

function closePatientAttachmentModal() {
  const previousFocus = patientAttachmentState?.previousFocus;
  patientAttachmentState = null;
  document.body.classList.remove('patient-attachment-open');
  patientAttachmentRequest++;
  const modal = document.getElementById('patient-attachment-modal');
  if (modal) { modal.hidden = true; document.getElementById('patient-attachment-content').replaceChildren(); }
  if (previousFocus?.isConnected) previousFocus.focus();
}

document.addEventListener('keydown', event => {
  if (!patientAttachmentState) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closePatientAttachmentModal(); return; }
  if (event.key !== 'Tab') return;
  const modal = document.getElementById('patient-attachment-modal');
  const focusable = [...modal.querySelectorAll('button:not(:disabled), a[href], iframe, audio, video')].filter(element => element.getClientRects().length);
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}, true);

document.addEventListener('DOMContentLoaded', () => {
  const observer = new ResizeObserver(updateChartMediaStickyTop);
  ['app-header', 'patient-workspace-header'].forEach(id => { const element = document.getElementById(id); if (element) observer.observe(element); });
  chartMediaLandscape.addEventListener('change', () => renderChartMediaPanel());
  chartMediaReducedMotion.addEventListener('change', () => renderChartMediaPanel());
  renderChartMediaPanel();
});

document.addEventListener('keydown', event => {
  const modal = document.getElementById('patient-media-upload-modal');
  if (!modal || modal.classList.contains('hidden') || patientMediaToothPicker) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closePatientMediaUploadModal(); return; }
  if (event.key !== 'Tab') return;
  event.stopImmediatePropagation();
  const controls = [...modal.querySelectorAll('button:not(:disabled), input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(element => element.getClientRects().length);
  const first = controls[0], last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}, true);

document.addEventListener('keydown', event => {
  if (!document.documentElement.classList.contains('chart-media-sheet-open') || chartPatientMedia.collapsed || patientAttachmentState
    || patientMediaToothPicker || document.querySelector('#patient-media-lightbox:not(.hidden), #patient-media-upload-modal:not(.hidden)')) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); toggleChartMediaPanel(); return; }
  if (event.key !== 'Tab') return;
  const buttons = [...document.querySelectorAll('#chart-media-panel button:not(:disabled)')].filter(button => button.getClientRects().length);
  const first = buttons[0], last = buttons[buttons.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}, true);
