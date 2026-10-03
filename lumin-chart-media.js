// Patient media stays beside the chart; requests are isolated from gallery navigation.
const chartPatientMedia = { patientId: null, files: [], status: 'idle', detailsError: false, request: 0, selectedPath: '', filterToothId: '', collapsed: true };
let chartMediaPreviousFocus = null;
let patientAttachmentState = null;
let patientAttachmentRequest = 0;
const chartMediaLandscape = window.matchMedia('(min-width: 768px) and (orientation: landscape)');

function chartMediaText(english, arabic) {
  return currentUiLanguage === 'ar' ? arabic : english;
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

function chartPatientXrays(toothId = chartPatientMedia.filterToothId) {
  return chartPatientMedia.files.filter(file => patientMediaFileKind(file) === 'image'
    && ['Panoramic', 'Periapical'].includes(file.category)
    && (!toothId || patientMediaToothIds(file.mediaDetails).includes(toothId)));
}

function renderChartToothXrayIndicators() {
  const counts = new Map();
  if (chartPatientMedia.patientId === activePatientId && chartPatientMedia.status === 'ready' && hasPageAccess('patients') && !chartPatientMedia.detailsError) {
    chartPatientXrays('').forEach(file => patientMediaToothIds(file.mediaDetails).forEach(id => counts.set(id, (counts.get(id) || 0) + 1)));
  }
  document.querySelectorAll('[data-tooth-xray-slot]').forEach(slot => {
    const id = slot.dataset.toothXraySlot;
    const count = counts.get(id) || 0;
    let button = slot.querySelector('button');
    if (!count) { button?.remove(); return; }
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
    const label = chartMediaText(`View ${count} X-ray${count === 1 ? '' : 's'} for `, `عرض ${count} من صور الأشعة لـ `) + patientMediaToothLabel(id);
    button.setAttribute('aria-label', label);
    button.title = label;
    button.setAttribute('aria-pressed', String(chartPatientMedia.filterToothId === id));
    button.querySelector('small').textContent = count;
  });
  if (window.lucide) lucide.createIcons();
}

function showChartToothXrays(toothId, trigger = document.activeElement) {
  const id = normalizePatientMediaTeeth([toothId])[0];
  if (!id || chartPatientMedia.patientId !== activePatientId || chartPatientMedia.status !== 'ready' || !hasPageAccess('patients')) return;
  const xrays = chartPatientXrays(id);
  if (!xrays.length) return;
  chartMediaPreviousFocus = trigger;
  chartPatientMedia.filterToothId = id;
  chartPatientMedia.selectedPath = xrays[0].relativePath;
  chartPatientMedia.collapsed = false;
  renderChartMediaPanel();
  if (!chartMediaIsLandscape()) document.getElementById('chart-media-collapse')?.focus({ preventScroll: true });
}

function clearChartXrayFilter() {
  chartPatientMedia.filterToothId = '';
  renderChartMediaPanel();
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
  const heights = ['app-header', 'patient-workspace-header'].map(id => {
    const element = document.getElementById(id);
    return element && !element.classList.contains('hidden') ? element.getBoundingClientRect().height / zoom : 0;
  });
  panel.style.setProperty('--chart-media-sticky-top', `${Math.ceil(heights.reduce((sum, height) => sum + height, 0) + 24)}px`);
}

function toggleChartMediaPanel() {
  if (chartPatientMedia.collapsed) chartMediaPreviousFocus = document.activeElement;
  chartPatientMedia.collapsed = !chartPatientMedia.collapsed;
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
    chartPatientMedia.filterToothId = '';
    chartPatientMedia.collapsed = true;
    chartMediaPreviousFocus = null;
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
    const details = await db.from('patient_media_details').select('relative_path,display_name,note,tooth_id,tooth_ids').eq('patient_id', patient.id);
    if (request !== chartPatientMedia.request || activePatientId !== patient.id) return;
    const byPath = new Map((details.error ? [] : details.data || []).map(item => [item.relative_path, item]));
    chartPatientMedia.files = (response.files || []).map(file => ({ ...file, mediaDetails: byPath.get(file.relativePath) || null }));
    chartPatientMedia.detailsError = Boolean(details.error);
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
  const sheetOpen = chartActive && !chartMediaIsLandscape() && !chartPatientMedia.collapsed;
  document.documentElement.classList.toggle('chart-media-sheet-open', sheetOpen);
  document.body.classList.toggle('chart-media-sheet-open', sheetOpen);
  let backdrop = document.getElementById('chart-media-backdrop');
  if (sheetOpen && !backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'chart-media-backdrop';
    backdrop.addEventListener('click', toggleChartMediaPanel);
    document.body.appendChild(backdrop);
  }
  if (backdrop) backdrop.hidden = !sheetOpen;
  if (sheetOpen) { panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); }
  else { panel.removeAttribute('role'); panel.removeAttribute('aria-modal'); }
  const expand = chartMediaText('Expand X-ray viewer', 'توسيع عارض الأشعة');
  const collapse = sheetOpen ? chartMediaText('Close X-ray viewer', 'إغلاق عارض الأشعة') : chartMediaText('Collapse X-ray viewer', 'طي عارض الأشعة');
  const panelToggle = document.getElementById('chart-media-collapse');
  panelToggle.setAttribute('aria-expanded', String(!chartPatientMedia.collapsed));
  panelToggle.setAttribute('aria-label', chartPatientMedia.collapsed ? expand : collapse);
  panelToggle.title = chartPatientMedia.collapsed ? expand : collapse;
  panelToggle.innerHTML = `<i data-lucide="${sheetOpen ? 'x' : chartPatientMedia.collapsed ? 'panel-right-open' : 'panel-right-close'}"></i>`;
  document.getElementById('chart-media-panel-title').textContent = chartMediaText('X-rays', 'الأشعة');
  const toolbarToggle = document.getElementById('chart-media-toggle');
  toolbarToggle.setAttribute('aria-expanded', String(!chartPatientMedia.collapsed && chartActive));
  toolbarToggle.querySelector('span').textContent = chartMediaText('X-rays', 'الأشعة');
  const attachmentButton = document.getElementById('chart-attachments-button');
  attachmentButton.querySelector('[data-attachment-label]').textContent = chartMediaText('Attachments', 'المرفقات');
  attachmentButton.disabled = !hasPageAccess('patients');
  document.getElementById('chart-attachments-count').textContent = chartPatientMedia.status === 'ready' ? chartPatientAttachments().length : '—';
  const xrays = chartPatientXrays();
  if (chartPatientMedia.status === 'loading') {
    body.innerHTML = `<div class="chart-media-skeleton"></div><p class="chart-media-summary" style="margin-top:16px" role="status">${chartMediaText('Loading patient files…', 'جارٍ تحميل ملفات المريض…')}</p>`;
  } else if (['error', 'unconfigured', 'unavailable'].includes(chartPatientMedia.status)) {
    const configured = chartPatientMedia.status !== 'unconfigured';
    body.innerHTML = `<div class="chart-media-empty"><i data-lucide="${configured ? 'cloud-off' : 'hard-drive'}"></i><h4>${chartMediaText('Patient files unavailable', 'ملفات المريض غير متاحة')}</h4><p>${chartPatientMedia.status === 'unavailable' ? chartMediaText('Patient record access is required.', 'يلزم توفر صلاحية الوصول إلى سجل المريض.') : configured ? chartMediaText('Check the clinic storage connection and try again.', 'تحقق من اتصال خادم التخزين ثم أعد المحاولة.') : chartMediaText('Connect your clinic storage in Settings.', 'اربط خادم تخزين العيادة من الإعدادات.')}</p>${chartPatientMedia.status === 'unavailable' ? '' : `<button type="button" class="chart-media-button" onclick="${configured ? 'loadChartPatientMedia()' : 'openStorageSettings()'}"><i data-lucide="${configured ? 'refresh-cw' : 'settings'}"></i>${configured ? chartMediaText('Retry', 'إعادة المحاولة') : chartMediaText('Storage settings', 'إعدادات التخزين')}</button>`}</div>`;
  } else if (!xrays.length) {
    chartPatientMedia.selectedPath = '';
    body.innerHTML = `<div class="chart-media-empty"><i data-lucide="scan-line"></i><h4>${chartPatientMedia.filterToothId ? chartMediaText('No X-rays assigned to this tooth', 'لا توجد أشعة مرتبطة بهذا السن') : chartMediaText('No X-rays yet', 'لا توجد أشعة بعد')}</h4><p>${chartMediaText('Add a panoramic or periapical X-ray to keep it beside the chart.', 'أضف أشعة بانورامية أو أشعة حول الذروة لعرضها بجوار المخطط.')}</p><button type="button" class="chart-media-button" onclick="openChartPatientMediaUpload()"><i data-lucide="plus"></i>${chartMediaText('Add X-ray', 'إضافة أشعة')}</button></div>${chartMediaPanelActions()}`;
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
      <button type="button" class="chart-media-preview" onclick="openChartPatientMediaFile(${index})" aria-label="${escapeHtml(chartMediaText('Open X-ray: ', 'فتح الأشعة: ') + name)}"><img src="${escapeHtml(patientMediaThumbnailUrl(file))}" alt="${escapeHtml(name)}" data-media-user-content onerror="fallbackChartMediaImage(this, ${index})" /></button>
      <div class="chart-media-caption"><h4 data-media-user-content dir="auto">${escapeHtml(name)}</h4>${tooth ? `<span class="chart-media-tooth" dir="auto">${escapeHtml(tooth)}</span>` : ''}${note ? `<p class="chart-media-note" data-media-user-content dir="auto">${escapeHtml(note)}</p>` : ''}</div>
      <div class="chart-media-nav"><button type="button" class="chart-media-button is-neutral" onclick="stepChartPatientXray(-1)" aria-label="${chartMediaText('Previous X-ray', 'الأشعة السابقة')}" ${xrays.length < 2 ? 'disabled' : ''}><i data-lucide="chevron-left"></i></button><span dir="ltr">${selected + 1} / ${xrays.length}</span><button type="button" class="chart-media-button is-neutral" onclick="openChartPatientMediaFile(${index})" aria-label="${chartMediaText('Enlarge X-ray', 'تكبير الأشعة')}"><i data-lucide="maximize-2"></i></button><button type="button" class="chart-media-button is-neutral" onclick="stepChartPatientXray(1)" aria-label="${chartMediaText('Next X-ray', 'الأشعة التالية')}" ${xrays.length < 2 ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button></div>
      <div class="chart-media-thumbnails" aria-label="${chartMediaText('Patient X-rays', 'أشعة المريض')}">${xrays.map(item => `<button type="button" class="chart-media-thumbnail" onclick="selectChartPatientXray(${chartPatientMedia.files.indexOf(item)})" aria-pressed="${item === file}" aria-label="${escapeHtml(patientMediaDisplayName(item))}"><img src="${escapeHtml(patientMediaThumbnailUrl(item))}" alt="" loading="lazy" onerror="fallbackChartMediaImage(this, ${chartPatientMedia.files.indexOf(item)})" /></button>`).join('')}</div>${chartMediaPanelActions()}`;
  }
  if (chartPatientMedia.detailsError) body.insertAdjacentHTML('afterbegin', `<p class="chart-media-summary" role="status">${chartMediaText('Saved names, tooth assignments, and notes could not be loaded.', 'تعذر تحميل الأسماء وتحديد الأسنان والملاحظات المحفوظة.')}</p>`);
  if (chartPatientMedia.filterToothId) body.insertAdjacentHTML('afterbegin', `<div class="chart-media-filter"><span class="chart-media-tooth" dir="auto"><i data-lucide="filter" aria-hidden="true"></i>${escapeHtml(patientMediaToothLabel(chartPatientMedia.filterToothId))}</span><button type="button" class="chart-media-button is-neutral" onclick="clearChartXrayFilter()"><i data-lucide="x" aria-hidden="true"></i>${chartMediaText('Show all X-rays', 'عرض كل الأشعة')}</button></div>`);
  renderChartToothXrayIndicators();
  updateChartMediaStickyTop();
  if (window.lucide) lucide.createIcons();
  if (sheetOpen && focusWasInsidePanel && !panel.contains(document.activeElement)) panelToggle.focus({ preventScroll: true });
}

function chartMediaPanelActions() {
  return `<div class="chart-media-panel-actions"><button type="button" class="chart-media-button" onclick="openPatientAttachmentList()"><i data-lucide="paperclip"></i>${chartMediaText('Attachments', 'المرفقات')}<span class="chart-media-count">${chartPatientAttachments().length}</span></button><button type="button" class="chart-media-button is-neutral" onclick="openChartMediaGallery()"><i data-lucide="images"></i>${chartMediaText('Gallery', 'المعرض')}</button></div>`;
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

async function openChartPatientMediaUpload(attachment = false) {
  const patientId = chartPatientMedia.patientId;
  if (!patientId || !hasPageAccess('patients')) return;
  closePatientAttachmentModal();
  await openPatientWorkspace(patientId, 'media');
  if (activeWorkspacePatientId !== patientId) return;
  openPatientMediaUploadModal();
  document.getElementById('upload-media-category').value = attachment ? 'General' : 'Periapical';
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
  chartPatientMedia.request++;
  chartPatientMedia.patientId = null;
  chartPatientMedia.files = [];
  chartPatientMedia.selectedPath = '';
  chartPatientMedia.filterToothId = '';
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
  renderChartMediaPanel();
});

document.addEventListener('keydown', event => {
  if (!document.documentElement.classList.contains('chart-media-sheet-open') || patientAttachmentState
    || document.querySelector('#patient-media-lightbox:not(.hidden)')) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); toggleChartMediaPanel(); return; }
  if (event.key !== 'Tab') return;
  const buttons = [...document.querySelectorAll('#chart-media-panel button:not(:disabled)')].filter(button => button.getClientRects().length);
  const first = buttons[0], last = buttons[buttons.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}, true);
