// Save image orientation with the existing local media annotations.
const patientMediaRotationWrites = new Map();

function xrayRotationText(english, arabic) {
  return currentUiLanguage === 'ar' ? arabic : english;
}

function patientMediaRotationKey(patientId, relativePath, config = getStorageServerConfig()) {
  return JSON.stringify([config.url, config.key, patientId, relativePath]);
}

function patientMediaRotationFile(patientId, relativePath) {
  if (typeof chartPatientMedia !== 'undefined' && chartPatientMedia.patientId === patientId) {
    const file = chartPatientMedia.files.find(item => item.relativePath === relativePath);
    if (file) return file;
  }
  return activePatientMediaPatientId === patientId
    ? currentPatientMediaFiles.find(item => item.relativePath === relativePath) : null;
}

function patientMediaRotation(file, patientId) {
  const pending = patientMediaRotationWrites.get(patientMediaRotationKey(patientId, file.relativePath));
  const value = Number(pending?.pending ? pending.angle : file.mediaDetails?.scan_config?.image_rotation || 0);
  return Number.isFinite(value) && value % 90 === 0 ? ((value % 360) + 360) % 360 : 0;
}

function patientMediaRotationAttributes(file, patientId) {
  return `data-media-rotation="${patientMediaRotation(file, patientId)}" data-media-rotation-path="${escapeHtml(file.relativePath)}" data-media-rotation-patient="${escapeHtml(patientId)}"`;
}

function fitPatientMediaRotations(root = document) {
  root.querySelectorAll('img[data-media-rotation]').forEach(image => {
    const angle = Number(image.dataset.mediaRotation);
    if (!angle) { image.style.width = ''; image.style.height = ''; image.style.transform = ''; return; }
    if (!image.naturalWidth || !image.naturalHeight) return;
    const parent = image.parentElement;
    const swapped = angle % 180 !== 0;
    const factor = Math.min((parent.clientWidth - 8) / (swapped ? image.naturalHeight : image.naturalWidth),
      (parent.clientHeight - 8) / (swapped ? image.naturalWidth : image.naturalHeight));
    image.style.width = `${Math.max(0, image.naturalWidth * factor)}px`;
    image.style.height = `${Math.max(0, image.naturalHeight * factor)}px`;
    image.style.setProperty('--media-rotation', `${angle}deg`);
    image.style.transform = `translate(-50%, -50%) rotate(${angle}deg)`;
  });
}

function fitLightboxRotatedImage(image) {
  const viewport = document.getElementById('lightbox-viewport');
  if (!viewport || !image.naturalWidth || !image.naturalHeight) return;
  const swapped = lightboxRotation % 180 !== 0;
  const factor = Math.min((viewport.clientWidth - 24) / (swapped ? image.naturalHeight : image.naturalWidth),
    (viewport.clientHeight - 24) / (swapped ? image.naturalWidth : image.naturalHeight));
  image.style.width = `${Math.max(0, image.naturalWidth * factor)}px`;
  image.style.height = `${Math.max(0, image.naturalHeight * factor)}px`;
  image.style.maxWidth = 'none';
  image.style.maxHeight = 'none';
}

function applyPatientMediaRotation(state, savedDetails) {
  if (patientMediaRotationKey(state.patientId, state.relativePath) !== state.key) return;
  const lists = [];
  if (typeof chartPatientMedia !== 'undefined' && chartPatientMedia.patientId === state.patientId) lists.push(chartPatientMedia.files);
  if (activePatientMediaPatientId === state.patientId) lists.push(currentPatientMediaFiles);
  lists.flat().filter(file => file.relativePath === state.relativePath).forEach(file => {
    const details = savedDetails || file.mediaDetails || {};
    file.mediaDetails = { ...details, scan_config: { ...(details.scan_config || {}), image_rotation: state.angle } };
  });
  document.querySelectorAll('img[data-media-rotation-path]').forEach(image => {
    if (image.dataset.mediaRotationPath === state.relativePath && image.dataset.mediaRotationPatient === state.patientId) {
      image.dataset.mediaRotation = String(state.angle);
    }
  });
  fitPatientMediaRotations();
  if (currentLightboxPatientId === state.patientId && currentLightboxRelativePath === state.relativePath) {
    lightboxRotation = state.angle;
    updateLightboxTransform();
  }
}

function renderPatientMediaRotationControls() {
  const chartFile = typeof chartPatientMedia !== 'undefined'
    ? chartPatientMedia.files.find(file => file.relativePath === chartPatientMedia.selectedPath) : null;
  const lightboxFile = patientMediaRotationFile(currentLightboxPatientId, currentLightboxRelativePath);
  const contexts = [
    { button: document.querySelector('[data-chart-rotate-xray]'), status: document.querySelector('[data-chart-rotation-status]'), file: chartFile,
      patientId: typeof chartPatientMedia !== 'undefined' ? chartPatientMedia.patientId : null, unavailable: typeof chartPatientMedia !== 'undefined' && chartPatientMedia.detailsError },
    { button: document.getElementById('lightbox-rotate-btn'), status: document.getElementById('lightbox-rotation-status'), file: lightboxFile,
      patientId: currentLightboxPatientId, unavailable: activePatientMediaPatientId === currentLightboxPatientId && patientMediaDetailsError }
  ];
  contexts.forEach(({ button, status, file, patientId, unavailable }) => {
    const state = file ? patientMediaRotationWrites.get(patientMediaRotationKey(patientId, file.relativePath)) : null;
    const label = xrayRotationText('Rotate 90° clockwise · saves automatically', 'تدوير ٩٠° مع عقارب الساعة · يُحفظ تلقائيًا');
    if (button) {
      button.disabled = !file || !hasPageAccess('patients') || unavailable || Boolean(state?.pending);
      button.title = label;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-busy', String(Boolean(state?.pending)));
    }
    if (status) {
      status.textContent = state?.pending ? xrayRotationText('Saving rotation…', 'جارٍ حفظ التدوير…')
        : state?.error ? xrayRotationText('Rotation could not be saved. Try rotating again.', 'تعذر حفظ التدوير. حاول التدوير مرة أخرى.')
        : state ? xrayRotationText('Rotation saved', 'تم حفظ التدوير') : '';
      status.classList.toggle('is-error', Boolean(state?.error));
      status.hidden = !status.textContent;
    }
  });
}

async function rotatePatientMediaImage(file, patientId) {
  if (!file || !patientId || !hasPageAccess('patients') || patientMediaFileKind(file) !== 'image') return;
  const config = { ...getStorageServerConfig() };
  const key = patientMediaRotationKey(patientId, file.relativePath, config);
  if (patientMediaRotationWrites.get(key)?.pending) return;
  const confirmed = patientMediaRotation(file, patientId);
  const state = { key, patientId, relativePath: file.relativePath, angle: (confirmed + 90) % 360, pending: true, error: false };
  patientMediaRotationWrites.set(key, state);
  applyPatientMediaRotation(state);
  renderPatientMediaRotationControls();
  try {
    const saved = await persistPatientMediaDetails(patientId, file.relativePath,
      { scan_config: { ...(file.mediaDetails?.scan_config || {}), image_rotation: state.angle } }, config);
    if (Number(saved.scan_config?.image_rotation) !== state.angle) throw new Error('Rotation was not stored.');
    applyPatientMediaRotation(state, saved);
  } catch (_) {
    state.angle = confirmed;
    state.error = true;
    applyPatientMediaRotation(state);
  } finally {
    state.pending = false;
    renderPatientMediaRotationControls();
  }
}

function rotateChartPatientXray(index) {
  if (chartPatientMedia.detailsError) return;
  return rotatePatientMediaImage(chartPatientMedia.files[index], chartPatientMedia.patientId);
}

document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('load', event => {
    if (event.target.matches?.('img[data-media-rotation]')) fitPatientMediaRotations(event.target.parentElement);
  }, true);
  const observer = new ResizeObserver(() => {
    fitPatientMediaRotations();
    if (currentLightboxRelativePath) updateLightboxTransform();
  });
  ['chart-media-panel', 'patient-media-content', 'lightbox-viewport'].forEach(id => {
    const element = document.getElementById(id);
    if (element) observer.observe(element);
  });
});
