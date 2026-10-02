/* Manual patient-file synchronization. The dedicated PC owns the durable job. */
(() => {
  const state = { selection: null, paired: false, job: null, busy: false, error: '', timer: null, refreshing: false, epoch: 0 };
  const selectionKey = 'lumin_storage_sync_pair';
  const t = (en, ar) => typeof currentUiLanguage !== 'undefined' && currentUiLanguage === 'ar' ? ar : en;
  const admin = () => typeof currentUserAccess !== 'undefined' && currentUserAccess?.isAdmin;
  const presets = () => typeof getStorageServerPresets === 'function' ? getStorageServerPresets() : [];
  const activeJob = () => state.job?.status === 'running';
  const visible = () => document.visibilityState === 'visible' && admin()
    && !document.getElementById('view-admin')?.classList.contains('hidden')
    && !document.getElementById('admin-panel-storage')?.classList.contains('hidden');

  function selection() {
    if (!state.selection) {
      try { state.selection = JSON.parse(localStorage.getItem(selectionKey)); } catch (_) {}
      if (!state.selection || typeof state.selection !== 'object') {
        const list = presets();
        state.selection = {
          coordinator: list.find(p => p.id === 'preset-dedicated' || p.icon === 'server')?.id || '',
          laptop: list.find(p => p.id === 'preset-laptop' || p.icon === 'laptop')?.id || '',
          peerId: null
        };
      }
    }
    return state.selection;
  }

  function selectedServers() {
    const saved = selection(), list = presets();
    return { coordinator: list.find(p => p.id === saved.coordinator), laptop: list.find(p => p.id === saved.laptop) };
  }

  function ready() {
    const { coordinator, laptop } = selectedServers();
    return Boolean(coordinator?.url?.trim() && laptop?.url?.trim()
      && coordinator.id !== laptop.id && !storageServerUrlsMatch(coordinator.url, laptop.url));
  }

  function progress(job) {
    if (!job) return { percent: 0, indeterminate: false };
    const finished = ['completed', 'completed_with_conflicts'].includes(job.status);
    const ratio = job.totalBytes > 0 ? job.transferredBytes / job.totalBytes
      : job.totalFiles > 0 ? job.completedFiles / job.totalFiles : 0;
    return { percent: finished ? 100 : Math.min(99, Math.max(0, Math.floor(ratio * 100))),
      indeterminate: job.status === 'running' && job.phase === 'scanning' };
  }

  function phaseLabel(job) {
    if (job?.status === 'failed') return t('Sync interrupted', 'توقفت المزامنة');
    if (job?.status === 'completed_with_conflicts') return t('Finished—needs review', 'اكتملت — تحتاج إلى مراجعة');
    return ({ scanning: t('Scanning files', 'جارٍ فحص الملفات'), syncing: t('Syncing files', 'جارٍ مزامنة الملفات'),
      deleting: t('Applying deletions', 'جارٍ تطبيق الحذف'), verifying: t('Verifying', 'جارٍ التحقق'),
      finished: t('Finished', 'اكتملت') })[job?.phase] || t('Ready to sync', 'جاهز للمزامنة');
  }

  function errorText(error) {
    if (t('en', 'ar') === 'en') return error.message;
    if (error.status === 401) return 'سجّل الدخول مجدداً بحساب مسؤول للمزامنة.';
    if (error.status === 403) return 'تحتاج هذه العملية إلى صلاحيات مسؤول نشط.';
    if (error.status === 404) return 'حدّث خادم التخزين على الجهازين لدعم المزامنة.';
    if (error.status === 409) return 'تحقق من اختيار جهازين مختلفين وإعداد الاقتران، ثم أعد المحاولة. قد تكون الملفات تغيرت أثناء المزامنة.';
    return 'تعذر إكمال العملية. تأكد من تشغيل الجهازين وصحة الروابط وتوفر الاتصال والمساحة، ثم أعد المحاولة.';
  }

  async function api(server, route, method = 'GET', body) {
    if (!admin()) throw Object.assign(new Error(t('Administrator access is required.', 'صلاحيات المسؤول مطلوبة.')), { status: 403 });
    const { data, error } = await db.auth.getSession();
    if (error || !data?.session?.access_token) throw Object.assign(new Error('Sign in again to synchronize storage.'), { status: 401 });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${normaliseStoragePresetUrl(server.url)}/api/sync/${route}`, {
        method, cache: 'no-store', signal: controller.signal,
        headers: { 'x-lumin-key': server.key || '', Authorization: `Bearer ${data.session.access_token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
      let result;
      try { result = await response.json(); } catch (_) { result = {}; }
      if (!response.ok) throw Object.assign(new Error(result.error || `Storage request failed (HTTP ${response.status}).`), { status: response.status });
      return result;
    } finally { clearTimeout(timeout); }
  }

  function render() {
    const panel = document.getElementById('storage-sync-panel');
    if (!panel || !admin()) return;
    if (!document.getElementById('storage-sync-start')) {
      panel.innerHTML = `
        <div class="storage-sync-heading"><span class="storage-sync-icon"><i data-lucide="refresh-cw" aria-hidden="true"></i></span><div class="min-w-0"><h4 id="storage-sync-title"></h4><p id="storage-sync-description"></p></div></div>
        <div class="storage-sync-selectors">
          <label><span id="storage-sync-coordinator-label"></span><select id="storage-sync-coordinator" onchange="LuminStorageSync.select('coordinator',this.value)"></select></label>
          <label><span id="storage-sync-laptop-label"></span><select id="storage-sync-laptop" onchange="LuminStorageSync.select('laptop',this.value)"></select></label>
        </div>
        <p id="storage-sync-safety" class="storage-sync-note"></p>
        <div class="storage-sync-actions"><button id="storage-sync-pair" type="button" onclick="LuminStorageSync.pair()"><i data-lucide="link" aria-hidden="true"></i><span id="storage-sync-pair-label"></span></button><button id="storage-sync-start" type="button" onclick="LuminStorageSync.start()"><i data-lucide="refresh-cw" aria-hidden="true"></i><span id="storage-sync-start-label"></span></button></div>
        <div id="storage-sync-progress" class="storage-sync-progress hidden">
          <div class="storage-sync-progress-heading"><span id="storage-sync-phase" role="status" aria-live="polite"></span><span id="storage-sync-percent" dir="ltr"></span></div>
          <div id="storage-sync-bar" class="storage-sync-track" role="progressbar" aria-labelledby="storage-sync-phase" aria-valuemin="0" aria-valuemax="100"><span id="storage-sync-fill"></span></div>
          <p id="storage-sync-counts" class="storage-sync-note"></p>
          <ul id="storage-sync-conflicts" class="storage-sync-conflicts hidden"></ul>
        </div>
        <p id="storage-sync-message" class="storage-sync-message" role="status" aria-live="polite"></p>`;
      if (window.lucide) lucide.createIcons();
    }
    const set = (id, text) => { const el = document.getElementById(id); if (el.textContent !== text) el.textContent = text; };
    panel.dir = t('ltr', 'rtl');
    set('storage-sync-title', t('Sync patient files', 'مزامنة ملفات المرضى'));
    set('storage-sync-description', t('Keep the laptop and dedicated PC up to date in both directions.', 'تحديث ملفات اللابتوب وجهاز العيادة في الاتجاهين.'));
    set('storage-sync-coordinator-label', t('Dedicated PC', 'جهاز العيادة المخصص'));
    set('storage-sync-laptop-label', t('Laptop', 'اللابتوب'));
    set('storage-sync-safety', t('Sync includes deletions. Removed and replaced files are kept in a recovery archive.', 'تشمل المزامنة الحذف. تُحفظ الملفات المحذوفة والمستبدلة في أرشيف للاستعادة.'));
    const saved = selection(), list = presets();
    const options = `<option value="">${t('Choose a saved server', 'اختر خادماً محفوظاً')}</option>` + list.map(p =>
      `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}${!p.url?.trim() ? t(' — URL not set', ' — الرابط غير مُدخل') : ''}</option>`).join('');
    for (const role of ['coordinator', 'laptop']) {
      const select = document.getElementById(`storage-sync-${role}`);
      if (select.dataset.options !== options) { select.innerHTML = options; select.dataset.options = options; }
      select.value = saved[role] || '';
      select.disabled = state.busy || activeJob();
    }
    const pairButton = document.getElementById('storage-sync-pair');
    pairButton.disabled = !ready() || state.busy || activeJob();
    set('storage-sync-pair-label', state.busy ? t('Connecting…', 'جارٍ الاتصال…') : state.paired ? t('Update pairing', 'تحديث الاقتران') : t('Pair servers', 'اقتران الخادمين'));
    document.getElementById('storage-sync-start').disabled = !ready() || !state.paired || state.busy || activeJob();
    set('storage-sync-start-label', activeJob() ? t('Syncing…', 'جارٍ المزامنة…') : state.job?.status === 'failed' ? t('Retry', 'إعادة المحاولة') : t('Sync now', 'مزامنة الآن'));
    document.getElementById('storage-sync-progress').classList.toggle('hidden', !state.job);
    if (state.job) {
      const job = state.job, p = progress(job), label = phaseLabel(job);
      set('storage-sync-phase', label);
      set('storage-sync-percent', p.indeterminate ? '—' : `${p.percent}%`);
      const bar = document.getElementById('storage-sync-bar');
      bar.classList.toggle('storage-sync-indeterminate', p.indeterminate);
      bar.dataset.status = job.status;
      if (p.indeterminate) bar.removeAttribute('aria-valuenow'); else bar.setAttribute('aria-valuenow', String(p.percent));
      bar.setAttribute('aria-valuetext', p.indeterminate ? label : `${label}: ${p.percent}%`);
      document.getElementById('storage-sync-fill').style.width = p.indeterminate ? '35%' : `${p.percent}%`;
      const mb = value => (Math.max(0, Number(value) || 0) / 1048576).toFixed(1);
      set('storage-sync-counts', t(`${job.completedFiles} / ${job.totalFiles} files · ${mb(job.transferredBytes)} / ${mb(job.totalBytes)} MB`,
        `${job.completedFiles} / ${job.totalFiles} ملفات · ${mb(job.transferredBytes)} / ${mb(job.totalBytes)} ميجابايت`));
      const conflicts = document.getElementById('storage-sync-conflicts');
      conflicts.classList.toggle('hidden', !job.conflicts?.length);
      const conflictHtml = (job.conflicts || []).map(c => `<li><strong>${t('Needs review', 'تحتاج إلى مراجعة')}</strong><span dir="auto">${escapeHtml(c.path)}</span></li>`).join('');
      if (conflicts.innerHTML !== conflictHtml) conflicts.innerHTML = conflictHtml;
    }
    const failed = state.job?.status === 'failed';
    const message = state.error || (failed ? errorText(new Error(state.job.error))
      : !ready() ? t('Set both server URLs in Saved servers, then pair them once.', 'أدخل رابطَي الجهازين في الخوادم المحفوظة، ثم اقرنهما مرة واحدة.')
      : state.paired ? t('Paired. Both computers must be running and reachable.', 'تم الاقتران. يجب تشغيل الجهازين وإمكانية الاتصال بهما.')
      : t('Pair these two servers to enable one-click sync.', 'اقرن الخادمين لتفعيل المزامنة بنقرة واحدة.'));
    set('storage-sync-message', message);
    document.getElementById('storage-sync-message').dataset.error = String(Boolean(state.error || failed));
  }

  async function refresh() {
    if (!visible() || !ready() || state.refreshing || state.busy) return;
    state.refreshing = true;
    const epoch = state.epoch, coordinator = selectedServers().coordinator;
    try {
      const info = await api(coordinator, 'info');
      if (epoch !== state.epoch) return;
      if (info.protocol !== 1) throw new Error(t('Update both storage servers to support sync.', 'حدّث خادمَي التخزين لدعم المزامنة.'));
      state.paired = info.pair?.role === 'coordinator' && info.pair.peerId === selection().peerId;
      const result = await api(coordinator, 'jobs/latest');
      if (epoch !== state.epoch) return;
      state.job = result.job;
      state.error = '';
    } catch (error) { if (epoch === state.epoch) state.error = errorText(error); }
    finally { state.refreshing = false; render(); }
  }

  async function pair() {
    if (!admin() || !ready() || state.busy || activeJob()) return;
    state.busy = true; state.error = ''; render();
    try {
      const { coordinator, laptop } = selectedServers();
      const result = await api(coordinator, 'pair', 'POST', { url: normaliseStoragePresetUrl(laptop.url), key: laptop.key || '' });
      selection().peerId = result.peerId;
      localStorage.setItem(selectionKey, JSON.stringify(selection()));
      state.paired = true;
    } catch (error) { state.error = errorText(error); }
    finally { state.busy = false; render(); }
  }

  async function start() {
    if (!admin() || !state.paired || !ready() || state.busy || activeJob()) return;
    state.busy = true; state.error = ''; render();
    try { state.job = await api(selectedServers().coordinator, 'jobs', 'POST'); }
    catch (error) { state.error = errorText(error); }
    finally { state.busy = false; render(); }
  }

  function select(role, id) {
    if (!['coordinator', 'laptop'].includes(role) || state.busy || activeJob()) return;
    selection()[role] = id; selection().peerId = null;
    localStorage.setItem(selectionKey, JSON.stringify(selection()));
    state.epoch++; state.paired = false; state.job = null; state.error = '';
    render(); void refresh();
  }

  function open() {
    render(); void refresh();
    if (state.timer === null) state.timer = setInterval(() => { void refresh(); }, 2000);
  }

  function close() {
    if (state.timer !== null) clearInterval(state.timer);
    state.timer = null;
    state.epoch++;
  }

  document.addEventListener('visibilitychange', () => { if (visible()) void refresh(); });
  window.addEventListener('online', () => { if (visible()) void refresh(); });
  window.LuminStorageSync = { render, open, close, select, pair, start };
})();
