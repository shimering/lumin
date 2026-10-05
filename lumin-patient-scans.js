(function () {
  'use strict';
  const words = {
    title: ['3D Scans', 'المسح ثلاثي الأبعاد'], subtitle: ['Inspect both arches in their exported bite alignment.', 'استعرض الفكين مع الحفاظ على إطباقهما الأصلي.'],
    import: ['Import ZIP', 'استيراد ZIP'], download: ['Download original ZIP', 'تنزيل ملف ZIP الأصلي'], open: ['Open', 'فتح'], compare: ['Compare selected', 'مقارنة المحدد'],
    delete: ['Delete', 'حذف'], confirmDelete: ['Delete this scan and its original ZIP?', 'حذف هذا المسح وملف ZIP الأصلي؟'],
    empty: ['No 3D scans yet', 'لا توجد ملفات مسح ثلاثي الأبعاد'], emptyHint: ['Import an archive containing upper and lower OBJ models, materials, and textures.', 'استورد ملفًا يحتوي على نماذج OBJ للفكين وملفات المواد والصور.'],
    name: ['Scan name', 'اسم المسح'], date: ['Scan date (optional)', 'تاريخ المسح (اختياري)'], note: ['Notes', 'ملاحظات'], uploaded: ['Uploaded', 'تاريخ الرفع'],
    upper: ['Upper arch', 'الفك العلوي'], lower: ['Lower arch', 'الفك السفلي'], orientation: ['Display orientation', 'اتجاه العرض'],
    zUp: ['Z up (dental export)', 'المحور Z لأعلى (تصدير الأسنان)'], yUp: ['Y up', 'المحور Y لأعلى'],
    preview: ['Preview', 'معاينة'], save: ['Save scan', 'حفظ المسح'], saveDetails: ['Save details', 'حفظ التفاصيل'], close: ['Close viewer', 'إغلاق العارض'],
    choose: ['Choose a ZIP or drop it here', 'اختر ملف ZIP أو أسقطه هنا'], original: ['The original ZIP is saved unchanged and can be downloaded at any time.', 'يُحفظ ملف ZIP الأصلي دون تغيير ويمكن تنزيله في أي وقت.'],
    loading: ['Loading scans…', 'جارٍ تحميل ملفات المسح…'], processing: ['Preparing scan…', 'جارٍ تجهيز المسح…'], uploading: ['Uploading original ZIP…', 'جارٍ رفع ملف ZIP الأصلي…'],
    retry: ['Retry', 'إعادة المحاولة'], settings: ['Storage settings', 'إعدادات التخزين'], noServer: ['Configure the local storage server to save patient scans.', 'اضبط خادم التخزين المحلي لحفظ ملفات المسح.'],
    serverUpdate: ['Update this storage server before importing 3D scans. Existing scans can still be opened and downloaded.', 'حدّث خادم التخزين قبل استيراد المسح ثلاثي الأبعاد. يمكنك فتح وتنزيل الملفات الموجودة.'],
    mode: ['Rendering', 'العرض'], textured: ['Textured', 'بالألوان الأصلية'], solid: ['Solid', 'مصمت'], wireframe: ['Wireframe', 'شبكي'],
    light: ['Lighting', 'الإضاءة'], background: ['Background', 'الخلفية'], lightBg: ['Light', 'فاتحة'], darkBg: ['Dark', 'داكنة'],
    upperOpacity: ['Upper opacity', 'عتامة الفك العلوي'], lowerOpacity: ['Lower opacity', 'عتامة الفك السفلي'], linked: ['Link cameras', 'ربط الكاميرات'],
    front: ['Front', 'أمامي'], left: ['Left', 'يسار'], right: ['Right', 'يمين'], upperView: ['Upper occlusal', 'إطباق علوي'], lowerView: ['Lower occlusal', 'إطباق سفلي'], reset: ['Fit / reset', 'ملاءمة / إعادة ضبط'],
    cut: ['Section cut', 'مقطع'], axis: ['Cut axis', 'محور المقطع'], cutPosition: ['Cut position', 'موضع المقطع'], reverse: ['Reverse cut', 'عكس المقطع'], resetCut: ['Reset cut', 'إعادة ضبط المقطع'],
    cutHint: ['Cuts display existing surfaces; they do not create interior anatomy.', 'تعرض المقاطع الأسطح الموجودة ولا تُنشئ تفاصيل داخلية.'],
    gestureHint: ['Left drag to rotate; hold left and right mouse buttons together to pan. Pinch or scroll to zoom; two fingers to pan. Arrow keys rotate, +/− zoom, Home resets.', 'اسحب بالزر الأيسر للدوران، واضغط زري الفأرة الأيسر والأيمن معًا للتحريك. قرّب بإصبعين أو عجلة التمرير، وحرّك بإصبعين. الأسهم للدوران و +/− للتقريب و Home لإعادة الضبط.'],
    unsafePath: ['The ZIP contains unsafe file paths.', 'يحتوي الملف على مسارات غير آمنة.'], externalAsset: ['External material or texture links are not allowed.', 'روابط المواد أو الصور الخارجية غير مسموح بها.'],
    damagedZip: ['This ZIP is damaged, encrypted, or unsupported.', 'ملف ZIP تالف أو مشفر أو غير مدعوم.'], damagedObj: ['The OBJ contains invalid coordinates.', 'يحتوي نموذج OBJ على إحداثيات غير صالحة.'],
    archiveLimit: ['Archive limit: 128 entries, 128 MB per entry, and 256 MB expanded.', 'حدود الأرشيف: ١٢٨ ملفًا، و١٢٨ ميجابايت لكل ملف، و٢٥٦ ميجابايت بعد الفك.'],
    modelLimit: ['Each arch must contain valid faces and no more than 750,000 triangles or 1,000,000 vertices.', 'يجب أن يحتوي كل فك على أسطح صالحة وبحد أقصى ٧٥٠ ألف مثلث ومليون رأس.'],
    textureLimit: ['Textures must fit within 8192 pixels per side, 16 megapixels per image, and 32 megapixels per scan.', 'حد الصور ٨١٩٢ بكسل لكل جانب و١٦ مليون بكسل لكل صورة و٣٢ مليون بكسل للمسح.'],
    damagedTexture: ['A texture image is damaged or unsupported.', 'إحدى الصور تالفة أو غير مدعومة.'],
    selectArches: ['Select two different OBJ files for the upper and lower arches.', 'اختر ملفي OBJ مختلفين للفكين العلوي والسفلي.'],
    missingTexture: ['A texture is missing. The affected surface uses a neutral material.', 'توجد صورة مفقودة. يُعرض السطح المتأثر بلون محايد.'], missingMaterial: ['A material file is missing. The affected surface uses a neutral material.', 'يوجد ملف مواد مفقود. يُعرض السطح المتأثر بلون محايد.'],
    webglUnavailable: ['This device does not support WebGL2. Use a compatible browser or device to view scans. Original ZIP downloads remain available.', 'هذا الجهاز لا يدعم WebGL2. استخدم متصفحًا أو جهازًا متوافقًا للعرض. يظل تنزيل ZIP الأصلي متاحًا.'],
    contextLost: ['Graphics paused. Waiting for the browser to restore the viewer…', 'توقف العرض مؤقتًا. في انتظار استعادة المتصفح للعارض…'],
    fullscreen: ['Full screen', 'ملء الشاشة'], exitFullscreen: ['Exit full screen', 'الخروج من ملء الشاشة'],
    fileLimit: ['This ZIP exceeds the storage server upload limit.', 'يتجاوز ملف ZIP حد الرفع الخاص بالخادم.'], zipOnly: ['Choose a .zip file.', 'اختر ملفًا بامتداد .zip.'],
    metadataRetry: ['The ZIP is already uploaded. Retry Save to finish its details without uploading another copy.', 'تم رفع ZIP بالفعل. أعد محاولة الحفظ لإكمال التفاصيل دون رفع نسخة أخرى.'],
    failed: ['Could not complete this action. Check the storage connection and retry.', 'تعذر إكمال العملية. تحقق من الاتصال بخادم التخزين وأعد المحاولة.'], selected: ['Select for comparison', 'تحديد للمقارنة'],
    twoScans: ['Select exactly two scans to compare.', 'حدد ملفين للمقارنة.'], saved: ['Saved', 'تم الحفظ']
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pendingUploads = new Map();
  const defaults = () => ({ mode: 'textured', upper: true, lower: true, upperOpacity: 1, lowerOpacity: 1, light: 1, background: 'dark', linked: true, cut: false, axis: 'z', cutPosition: 0, reverse: false });
  class PatientScans {
    constructor(host, options) {
      this.host = host; this.options = options; this.patient = options.patient; this.storage = options.storage;
      this.files = []; this.selected = new Set(); this.workers = new Set(); this.epoch = 0; this.controller = new AbortController(); this.settings = defaults();
      this.onClick = event => { const button = event.target.closest('[data-scan-action]'); if (button && !button.disabled) this.action(button.dataset.scanAction, button.dataset.index).catch(error => this.error(error)); };
      this.onChange = event => this.change(event).catch(error => this.error(error));
      this.onDrop = event => { event.preventDefault(); this.host.classList.remove('scan-dragging'); if (!this.busy && event.dataTransfer?.files[0]) this.importFile(event.dataTransfer.files[0]).catch(error => this.error(error)); };
      this.onDrag = event => { event.preventDefault(); this.host.classList.add('scan-dragging'); };
      host.addEventListener('click', this.onClick); host.addEventListener('change', this.onChange); host.addEventListener('input', this.onChange);
      host.addEventListener('drop', this.onDrop); host.addEventListener('dragover', this.onDrag);
      this.onDragLeave = () => host.classList.remove('scan-dragging'); host.addEventListener('dragleave', this.onDragLeave);
      this.ready = this.load();
    }
    t(key) { return words[key]?.[this.options.language === 'ar' ? 1 : 0] || key; }
    alive() { return !this.disposed && this.options.isCurrent(); }
    canImport() { return this.health?.capabilities?.patient3dScans && this.health?.capabilities?.scanOriginalFilenames; }
    icon(name) { return `<i data-lucide="${name}" aria-hidden="true"></i>`; }
    button(action, key, icon, extra = '') { return `<button type="button" data-scan-action="${action}" ${extra}>${this.icon(icon)}<span>${this.t(key)}</span></button>`; }
    icons() { if (window.lucide) lucide.createIcons(); }
    error(error) {
      if (!this.alive() || error.name === 'AbortError') return;
      const status = this.host.querySelector('.scan-message'); if (!status) return;
      status.textContent = `${this.t(error.message in words ? error.message : 'failed')}${this.pending?.result ? ' ' + this.t('metadataRetry') : ''}`;
      status.className = 'scan-message scan-warning'; status.hidden = false;
      console.warn('3D scan action:', error);
    }
    async request(path, init = {}) {
      const response = await fetch(this.storage.url + path, { ...init, signal: this.controller.signal,
        headers: { 'x-lumin-key': this.storage.key, ...init.headers } });
      if (!response.ok) throw new Error('failed'); return response;
    }
    async load() {
      this.selected.clear();
      this.host.innerHTML = `<div class="scan-skeleton" role="status">${this.t('loading')}</div>`;
      if (!this.storage.url) { this.shell(); this.host.querySelector('.scan-library').innerHTML = `<p>${this.t('noServer')}</p>${this.button('settings', 'settings', 'settings')}`; this.icons(); return; }
      try {
        const [health, listing, metadata] = await Promise.all([
          this.request('/api/health').then(r => r.json()),
          this.request(`/api/patient/${encodeURIComponent(this.patient.id)}/files?name=${encodeURIComponent(this.patient.name || '')}`).then(r => r.json()),
          this.options.db.from('patient_media_details').select('relative_path,display_name,note,scan_date,scan_config').eq('patient_id', this.patient.id)
        ]);
        if (!this.alive()) return;
        if (metadata.error) throw metadata.error;
        this.health = health;
        const byPath = new Map((metadata.data || []).map(row => [row.relative_path, row]));
        const bySubpath = new Map((metadata.data || []).map(row => [row.relative_path.split('/').slice(-2).join('/'), row]));
        this.files = (listing.files || []).filter(file => (file.category === '3D-Scans' || file.relativePath?.split('/')[1] === '3D-Scans') && /\.zip$/i.test(file.filename)).map(file => ({ ...file,
          details: byPath.get(file.relativePath) || bySubpath.get(file.relativePath.split('/').slice(-2).join('/')) || {} }));
        this.shell(); this.library();
        if (pendingUploads.has(this.patient.id)) {
          const status = this.host.querySelector('.scan-message'); status.hidden = false;
          status.innerHTML = `<p>${this.t('metadataRetry')}</p>${this.button('finishMetadata', 'retry', 'save')}`; this.icons();
        }
      } catch (error) {
        if (!this.alive()) return; this.shell(); this.error(error);
        this.host.querySelector('.scan-library').innerHTML = this.button('reload', 'retry', 'refresh-cw'); this.icons();
      }
    }
    shell() {
      this.host.innerHTML = `<header class="scan-header"><div><h3>${this.t('title')}</h3><p>${this.t('subtitle')}</p></div><div class="scan-actions">${this.button('compare', 'compare', 'columns-2', 'disabled')}${this.button('import', 'import', 'upload', `class="scan-primary" ${!this.canImport() ? 'disabled' : ''}`)}${this.button('settings', 'settings', 'settings')}</div></header>
        <p class="scan-message" role="status" hidden></p>
        ${this.health && !this.canImport() ? `<p class="scan-warning">${this.t('serverUpdate')}</p>` : ''}
        <input type="file" class="scan-file" accept=".zip,application/zip" hidden><div class="scan-library"></div><div class="scan-workspace" hidden></div>`;
      this.icons();
    }
    library() {
      const body = this.host.querySelector('.scan-library');
      body.innerHTML = this.files.length ? `<div class="scan-card-grid">${this.files.map((file, index) => {
        const details = file.details, name = details.display_name || details.scan_config?.original_filename || file.filename;
        const date = details.scan_date ? `${esc(details.scan_date)} · ` : '';
        return `<article class="scan-card"><div class="scan-card-heading"><span class="scan-symbol">${this.icon('box')}</span><div><h4>${esc(name)}</h4><p>${date}${this.t('uploaded')} ${esc(String(file.modifiedAt || '').slice(0, 10))} · ${(file.sizeBytes / 1048576).toFixed(1)} MB</p></div></div>
          ${details.note ? `<p class="scan-note">${esc(details.note)}</p>` : ''}<label class="scan-check"><input type="checkbox" data-scan-select="${index}" ${this.selected.has(index) ? 'checked' : ''}>${this.t('selected')}</label>
          <div class="scan-actions">${this.button('open', 'open', 'box', `data-index="${index}"`)}${this.button('download', 'download', 'download', `data-index="${index}"`)}${this.button('delete', 'delete', 'trash-2', `data-index="${index}" class="scan-danger"`)}</div></article>`;
      }).join('')}</div>` : `<div class="scan-empty"><span class="scan-symbol">${this.icon('box')}</span><h4>${this.t('empty')}</h4><p>${this.t('emptyHint')}</p>${this.button('import', 'import', 'upload', !this.canImport() ? 'disabled' : '')}<p class="scan-drop-hint">${this.t('choose')}</p></div>`;
      this.host.querySelector('[data-scan-action="compare"]').disabled = this.selected.size !== 2; this.icons();
    }
    worker() {
      const worker = new Worker(new URL('./lumin-scan-worker.js', document.baseURI), { type: 'module' });
      const waiting = new Map(); let next = 0; this.workers.add(worker);
      worker.onmessage = ({ data }) => { const pending = waiting.get(data.id); if (!pending) return; waiting.delete(data.id); data.error ? pending.reject(new Error(data.error)) : pending.resolve(data); };
      worker.onerror = () => { waiting.forEach(p => p.reject(new Error('damagedZip'))); waiting.clear(); };
      const cancel = () => { worker.terminate(); this.workers.delete(worker); waiting.forEach(p => p.reject(new DOMException('Cancelled', 'AbortError'))); waiting.clear(); };
      worker.cancel = cancel;
      return { worker, cancel, call: (data, transfer = []) => new Promise((resolve, reject) => {
        const id = ++next; waiting.set(id, { resolve, reject }); worker.postMessage({ ...data, id }, transfer);
      }) };
    }
    async inspect(blob) {
      const epoch = this.epoch;
      if (blob.size > (this.health?.maxFileSizeMB || 50) * 1048576) throw new Error('fileLimit');
      const job = this.worker();
      try {
        const buffer = await blob.arrayBuffer(); if (!this.alive() || epoch !== this.epoch) throw new DOMException('Cancelled', 'AbortError');
        const result = await job.call({ type: 'inspect', buffer }, [buffer]); return { job, paths: result.paths };
      } catch (error) { job.cancel(); throw error; }
    }
    detect(paths, config) {
      const matches = key => paths.filter(path => new RegExp(`(?:^|[_ /.-])(?:${key})(?:[_ .-]|$)`, 'i').test(path));
      const upper = matches('upper|maxilla'), lower = matches('lower|mandible');
      return { upper: paths.includes(config?.upper_path) ? config.upper_path : upper.length === 1 ? upper[0] : '',
        lower: paths.includes(config?.lower_path) ? config.lower_path : lower.length === 1 ? lower[0] : '', orientation: config?.orientation === 'y-up' ? 'y-up' : 'z-up' };
    }
    setBusy(value, key = 'processing') {
      this.busy = value;
      this.host.querySelectorAll('.scan-workspace button:not([data-scan-action="close"]), .scan-workspace select, .scan-workspace input, .scan-workspace textarea').forEach(el => el.disabled = value || Boolean(this.pending?.result && ['upper', 'lower', 'orientation'].includes(el.dataset.scanField)) || (el.dataset.scanAction === 'save' && !this.previewReady));
      const status = this.host.querySelector('.scan-message'); status.textContent = value ? this.t(key) : ''; status.hidden = !value; status.className = 'scan-message';
    }
    fields(paths, details, selection, originalName) {
      const optionList = selected => `<option value="">—</option>` + paths.map(path => `<option value="${esc(path)}" ${selected === path ? 'selected' : ''}>${esc(path)}</option>`).join('');
      return `<div class="scan-form-grid"><label>${this.t('name')}<input data-scan-field="name" maxlength="160" value="${esc(details.display_name || originalName.replace(/\.zip$/i, ''))}"></label><label>${this.t('date')}<input type="date" data-scan-field="date" value="${esc(details.scan_date || '')}"></label>
        <label>${this.t('upper')}<select data-scan-field="upper">${optionList(selection.upper)}</select></label><label>${this.t('lower')}<select data-scan-field="lower">${optionList(selection.lower)}</select></label>
        <label>${this.t('orientation')}<select data-scan-field="orientation"><option value="z-up" ${selection.orientation === 'z-up' ? 'selected' : ''}>${this.t('zUp')}</option><option value="y-up" ${selection.orientation === 'y-up' ? 'selected' : ''}>${this.t('yUp')}</option></select></label>
        <label>${this.t('note')}<textarea data-scan-field="note" maxlength="4000" rows="2">${esc(details.note || '')}</textarea></label></div>`;
    }
    controls() {
      const select = (key, values) => `<label>${this.t(key)}<select data-scan-setting="${key}">${values.map(([value, label]) => `<option value="${value}" ${this.settings[key] === value ? 'selected' : ''}>${this.t(label)}</option>`).join('')}</select></label>`;
      const check = key => `<label class="scan-check"><input type="checkbox" data-scan-setting="${key}" ${this.settings[key] ? 'checked' : ''}>${this.t(key)}</label>`;
      const range = (key, min, max, step) => `<label>${this.t(key)}<input type="range" min="${min}" max="${max}" step="${step}" value="${this.settings[key]}" data-scan-setting="${key}"></label>`;
      return `<div class="scan-presets">${[['front', 'front'], ['left', 'left'], ['right', 'right'], ['upper', 'upperView'], ['lower', 'lowerView'], ['reset', 'reset']].map(([view, label]) => this.button('view', label, label === 'reset' ? 'rotate-ccw' : 'scan', `data-index="${view}"`)).join('')}</div>
        <details class="scan-tools" open><summary>${this.t('mode')}</summary><div class="scan-tools-grid">${select('mode', [['textured', 'textured'], ['solid', 'solid'], ['wireframe', 'wireframe']])}${select('background', [['light', 'lightBg'], ['dark', 'darkBg']])}${check('upper')}${check('lower')}${range('upperOpacity', 0, 1, 0.05)}${range('lowerOpacity', 0, 1, 0.05)}${range('light', 0.2, 2, 0.1)}${check('linked')}</div></details>
        <details class="scan-tools"><summary>${this.t('cut')}</summary><div class="scan-tools-grid">${check('cut')}<label>${this.t('axis')}<select data-scan-setting="axis"><option value="z">Z</option><option value="x">X</option><option value="y">Y</option></select></label>${range('cutPosition', -1.5, 1.5, 0.01)}${check('reverse')}${this.button('resetCut', 'resetCut', 'rotate-ccw')}</div><p>${this.t('cutHint')}</p></details>`;
    }
    async importFile(file) {
      if (!this.canImport()) throw new Error('serverUpdate');
      if (!/\.zip$/i.test(file.name)) throw new Error('zipOnly');
      if (file.size > this.health.maxFileSizeMB * 1048576) throw new Error('fileLimit');
      this.close(); const epoch = this.epoch; this.workspace(); this.setBusy(true);
      try {
        const result = await this.inspect(file); if (!this.alive() || epoch !== this.epoch) { result.job.cancel(); return; }
        this.pending = { file, uploadId: crypto.randomUUID(), ...result }; this.originalName = file.name;
        const selection = this.detect(result.paths);
        this.renderWorkspace(result.paths, {}, selection, file.name, false);
        if (selection.upper && selection.lower) await this.preview();
      } finally { if (this.alive() && epoch === this.epoch) this.setBusy(false); }
    }
    workspace() {
      const area = this.host.querySelector('.scan-workspace'); area.hidden = false;
      area.innerHTML = `<div class="scan-workspace-heading"><h4>${this.t('processing')}</h4>${this.button('close', 'close', 'x')}</div>`; this.icons();
    }
    renderWorkspace(paths, details, selection, originalName, saved) {
      this.settings = defaults();
      const area = this.host.querySelector('.scan-workspace'); area.hidden = false;
      area.innerHTML = `<div class="scan-workspace-heading"><h4>${esc(details.display_name || originalName)}</h4>${this.button('close', 'close', 'x')}</div>
        ${this.fields(paths, details, selection, originalName)}<div class="scan-actions">${this.button('preview', 'preview', 'box')}${this.button('save', saved ? 'saveDetails' : 'save', 'save', 'class="scan-primary" disabled')}</div>
        <p class="scan-original">${this.t('original')}</p><p class="scan-preview-warning" role="status" hidden></p><div class="scan-stage"></div><p class="scan-gestures">${this.t('gestureHint')}</p>${this.controls()}`;
      this.icons(); area.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    field(key) { return this.host.querySelector(`[data-scan-field="${key}"]`)?.value || ''; }
    async preview() {
      const epoch = this.epoch;
      const target = this.pending || this.opened; if (!target) return;
      this.setBusy(true); this.viewer?.dispose(); this.viewer = null; this.previewReady = false;
      try {
        const selection = { upper: this.field('upper'), lower: this.field('lower'), orientation: this.field('orientation') };
        const data = await target.job.call({ type: 'parse', upper: selection.upper, lower: selection.lower });
        if (!this.alive() || epoch !== this.epoch) return;
        const { ScanViewer } = await import('./lumin-scan-viewer.js?v=3'); if (!this.alive() || epoch !== this.epoch) return;
        this.viewer = new ScanViewer(this.host.querySelector('.scan-stage'), key => this.t(key));
        await this.viewer.setScans([{ data, name: this.field('name'), orientation: selection.orientation }]);
        if (!this.alive() || epoch !== this.epoch) return;
        this.previewReady = true; this.previewSelection = selection;
        const warning = this.host.querySelector('.scan-preview-warning'); warning.textContent = data.warnings.map(key => this.t(key)).join(' '); warning.hidden = !data.warnings.length;
      } finally {
        if (this.alive() && epoch === this.epoch) { this.setBusy(false); this.host.querySelector('[data-scan-action="save"]').disabled = !this.previewReady; }
      }
    }
    async open(index) {
      const file = this.files[index]; if (!file) return;
      if (file.sizeBytes > this.health.maxFileSizeMB * 1048576) throw new Error('fileLimit');
      this.close(); const epoch = this.epoch; this.workspace(); this.setBusy(true);
      try {
        const blob = await (await this.request(this.filePath(file))).blob();
        if (!this.alive() || epoch !== this.epoch) return;
        const result = await this.inspect(blob); if (!this.alive() || epoch !== this.epoch) { result.job.cancel(); return; }
        this.opened = { file, ...result }; this.originalName = file.details.scan_config?.original_filename || file.filename;
        this.renderWorkspace(result.paths, file.details, this.detect(result.paths, file.details.scan_config), this.originalName, true);
        await this.preview();
      } finally { if (this.alive() && epoch === this.epoch) this.setBusy(false); }
    }
    filePath(file) { return '/files/' + file.relativePath.split('/').map(encodeURIComponent).join('/'); }
    async comparison() {
      if (this.selected.size !== 2) throw new Error('twoScans');
      const files = [...this.selected].map(index => this.files[index]); this.close(); const epoch = this.epoch; this.workspace(); this.setBusy(true);
      try {
        const scans = [];
        for (const file of files) {
          if (file.sizeBytes > this.health.maxFileSizeMB * 1048576) throw new Error('fileLimit');
          const blob = await (await this.request(this.filePath(file))).blob();
          if (!this.alive() || epoch !== this.epoch) return;
          const result = await this.inspect(blob);
          try {
            const selection = this.detect(result.paths, file.details.scan_config);
            const data = await result.job.call({ type: 'parse', upper: selection.upper, lower: selection.lower });
            scans.push({ data, orientation: selection.orientation, name: file.details.display_name || file.filename });
          } finally { result.job.cancel(); }
        }
        if (!this.alive() || epoch !== this.epoch) return;
        const area = this.host.querySelector('.scan-workspace'); this.settings = defaults();
        area.innerHTML = `<div class="scan-workspace-heading"><h4>${this.t('compare')}</h4>${this.button('close', 'close', 'x')}</div><div class="scan-stage"></div><p class="scan-gestures">${this.t('gestureHint')}</p>${this.controls()}`;
        const { ScanViewer } = await import('./lumin-scan-viewer.js?v=3'); if (!this.alive() || epoch !== this.epoch) return;
        this.viewer = new ScanViewer(area.querySelector('.scan-stage'), key => this.t(key)); await this.viewer.setScans(scans); this.icons();
      } finally { if (this.alive() && epoch === this.epoch) this.setBusy(false); }
    }
    async save() {
      if (!this.previewReady || this.busy) return;
      const epoch = this.epoch;
      const pending = this.pending, file = this.opened?.file;
      const details = { display_name: this.field('name').trim(), note: this.field('note').trim(), scan_date: this.field('date') || null,
        scan_config: { version: 1, original_filename: this.originalName, upper_path: this.previewSelection.upper, lower_path: this.previewSelection.lower, orientation: this.previewSelection.orientation } };
      this.setBusy(true, pending && !pending.result ? 'uploading' : 'processing');
      try {
        if (pending && !pending.result) {
          const body = new FormData(); body.append('file', pending.file); body.append('patientId', this.patient.id); body.append('patientName', this.patient.name); body.append('category', '3D-Scans'); body.append('scanUploadId', pending.uploadId);
          pending.result = await (await this.request('/api/upload', { method: 'POST', body })).json();
          if (!pending.result.relativePath) throw new Error('failed');
        }
        if (pending?.result) pendingUploads.set(this.patient.id, { result: pending.result, details });
        const path = pending?.result.relativePath || file.relativePath;
        const { error } = await this.options.db.from('patient_media_details').upsert({ patient_id: this.patient.id, relative_path: path, ...details }, { onConflict: 'patient_id,relative_path' });
        if (error) throw error;
        pendingUploads.delete(this.patient.id);
        if (!this.alive() || epoch !== this.epoch) return;
        this.close(); await this.load();
      } finally { if (this.alive() && epoch === this.epoch) this.setBusy(false); }
    }
    async download(index) {
      const file = this.files[index]; if (!file) return;
      const blob = await (await this.request(this.filePath(file))).blob(); if (!this.alive()) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = file.details.scan_config?.original_filename || file.filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async action(action, index) {
      if (action === 'close') return this.close();
      if (action === 'settings') return this.options.openSettings();
      if (this.busy) return;
      if (action === 'import') return this.host.querySelector('.scan-file').click();
      if (action === 'reload') { this.close(); return this.load(); }
      if (action === 'open') return this.open(Number(index));
      if (action === 'compare') return this.comparison();
      if (action === 'preview') return this.preview();
      if (action === 'save') return this.save();
      if (action === 'download') return this.download(Number(index));
      if (action === 'view') { if (index === 'reset') this.settings = defaults(); this.syncControls(); this.viewer?.apply(this.settings); return this.viewer?.view(index); }
      if (action === 'resetCut') { Object.assign(this.settings, { cut: false, cutPosition: 0, reverse: false, axis: 'z' }); this.syncControls(); return this.viewer?.apply(this.settings); }
      if (action === 'delete') {
        const file = this.files[Number(index)]; if (!file || !confirm(this.t('confirmDelete'))) return;
        await this.request('/api/file', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ relativePath: file.relativePath }) });
        const { error } = await this.options.db.from('patient_media_details').delete().eq('patient_id', this.patient.id).in('relative_path', [...new Set([file.relativePath, file.details.relative_path].filter(Boolean))]);
        this.close(); this.selected.clear(); await this.load(); if (error) throw error;
      }
      if (action === 'finishMetadata') {
        const pending = pendingUploads.get(this.patient.id); if (!pending) return;
        const { error } = await this.options.db.from('patient_media_details').upsert({ patient_id: this.patient.id, relative_path: pending.result.relativePath, ...pending.details }, { onConflict: 'patient_id,relative_path' });
        if (error) throw error; pendingUploads.delete(this.patient.id); return this.load();
      }
    }
    syncControls() {
      this.host.querySelectorAll('[data-scan-setting]').forEach(el => { if (el.type === 'checkbox') el.checked = this.settings[el.dataset.scanSetting]; else el.value = this.settings[el.dataset.scanSetting]; });
    }
    async change(event) {
      const el = event.target;
      if (event.type === 'input' && el.type !== 'range') return;
      if (el.matches('.scan-file') && el.files[0]) { const file = el.files[0]; el.value = ''; return this.importFile(file); }
      if (el.dataset.scanSelect !== undefined) {
        el.checked ? this.selected.add(Number(el.dataset.scanSelect)) : this.selected.delete(Number(el.dataset.scanSelect));
        this.host.querySelector('[data-scan-action="compare"]').disabled = this.selected.size !== 2;
      }
      if (el.dataset.scanSetting) {
        this.settings[el.dataset.scanSetting] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
        this.viewer?.apply(this.settings);
      }
      if (['upper', 'lower', 'orientation'].includes(el.dataset.scanField)) { this.previewReady = false; this.host.querySelector('[data-scan-action="save"]').disabled = true; }
    }
    close() {
      this.epoch++;
      this.viewer?.dispose(); this.viewer = null; this.workers.forEach(worker => worker.cancel()); this.workers.clear();
      this.pending = null; this.opened = null; this.previewReady = false; this.busy = false;
      const area = this.host.querySelector('.scan-workspace'); if (area) { area.innerHTML = ''; area.hidden = true; }
    }
    dispose() {
      this.disposed = true; this.controller.abort(); this.close();
      this.host.removeEventListener('click', this.onClick); this.host.removeEventListener('change', this.onChange); this.host.removeEventListener('input', this.onChange);
      this.host.removeEventListener('drop', this.onDrop); this.host.removeEventListener('dragover', this.onDrag); this.host.removeEventListener('dragleave', this.onDragLeave);
    }
  }
  window.LuminPatientScans = { mount: (host, options) => new PatientScans(host, options) };
})();
