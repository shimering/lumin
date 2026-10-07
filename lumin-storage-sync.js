/* Manual patient-file synchronization. The dedicated PC owns the durable job. */
(() => {
  const state = { selection: null, paired: false, repairPair: false, job: null, busy: false, error: '', actionError: '', timer: null, refreshing: false, epoch: 0, review: null };
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
      indeterminate: job.status === 'running' && ['scanning', 'metadata'].includes(job.phase) };
  }

  function phaseLabel(job) {
    if (job?.status === 'failed') return t('Sync interrupted', 'توقفت المزامنة');
    if (job?.status === 'completed_with_conflicts') return t('Finished—needs review', 'اكتملت — تحتاج إلى مراجعة');
    return ({ scanning: t('Scanning files', 'جارٍ فحص الملفات'), metadata: t('Syncing patient details', 'جارٍ مزامنة بيانات المرضى'), syncing: t('Syncing files', 'جارٍ مزامنة الملفات'),
      deleting: t('Applying deletions', 'جارٍ تطبيق الحذف'), verifying: t('Verifying', 'جارٍ التحقق'),
      finished: t('Finished', 'اكتملت') })[job?.phase] || t('Ready to sync', 'جاهز للمزامنة');
  }

  function errorText(error) {
    if (!error) return '';
    const msg = error.message || '';
    const reasons = {
      invalid_clinic_key: t('The clinic key saved for this server does not match its setup app. Edit the saved server and use that computer\'s clinic key.',
        'مفتاح العيادة المحفوظ لهذا الخادم لا يطابق تطبيق الإعداد. عدّل الخادم المحفوظ واستخدم مفتاح العيادة الخاص بذلك الكمبيوتر.'),
      invalid_peer_credentials: t('The saved pairing no longer matches on both computers. Click Pair servers to reconnect them, then retry.',
        'لم تعد بيانات الاقتران متطابقة على الجهازين. اضغط اقتران الخادمين لإعادة توصيلهما ثم أعد المحاولة.'),
      already_paired: t('One of these servers is paired with another computer. Select its existing partner; update pairing after a server reinstall.',
        'أحد الخادمين مقترن بكمبيوتر آخر. اختر الجهاز المقترن به؛ وحدّث الاقتران بعد إعادة تثبيت الخادم.'),
      invalid_manifest: t('The other server returned an inconsistent file list. Update and restart both storage apps, then retry. Existing files are preserved.',
        'أرسل الخادم الآخر قائمة ملفات غير متسقة. حدّث تطبيقَي التخزين وأعد تشغيلهما ثم أعد المحاولة. تبقى الملفات الموجودة محفوظة.'),
      storage_unavailable: t('The patient drive or folder is unavailable on one computer. Reconnect the drive and restart that storage app. No deletions were applied.',
        'محرك أو مجلد المرضى غير متاح على أحد الجهازين. أعد توصيل المحرك وأعد تشغيل تطبيق التخزين عليه. لم يتم تطبيق أي حذف.'),
      storage_unreadable: t('Patient files cannot be read on one computer. Check folder permissions, then retry. No deletions were applied.',
        'تعذر قراءة ملفات المرضى على أحد الجهازين. تحقق من صلاحيات المجلد ثم أعد المحاولة. لم يتم تطبيق أي حذف.'),
      indexes_unavailable: t('The storage indexes could not be refreshed. Check available disk space on both computers, then retry.',
        'تعذر تحديث فهارس التخزين. تحقق من المساحة المتاحة على الجهازين ثم أعد المحاولة.'),
      invalid_clinical_metadata: t('Patient details could not be verified. Retry after checking the patient and file records.',
        'تعذر التحقق من بيانات المرضى. راجع سجلات المرضى والملفات ثم أعد المحاولة.'),
      metadata_unavailable: t('Patient details could not be refreshed. Cached details are shown; retry when the connection is restored.',
        'تعذر تحديث بيانات المرضى. تُعرض البيانات المحفوظة؛ أعد المحاولة عند عودة الاتصال.'),
      invalid_record: t('The peer rejected saved file revision history. Update both server apps, then retry sync.',
        'رفض الخادم سجل إصدارات الملف المحفوظ. حدّث تطبيق الخادم على الجهازين ثم أعد المزامنة.'),
      invalid_transfer: t('The peer rejected the transfer information. Update both server apps, then retry sync.',
        'رفض الخادم بيانات النقل. حدّث تطبيق الخادم على الجهازين ثم أعد المزامنة.'),
      file_excluded: t('The servers have different file rules. Install the same server update on both computers, then retry.',
        'قواعد الملفات مختلفة بين الخادمين. ثبّت نفس تحديث الخادم على الجهازين ثم أعد المحاولة.'),
      same_server: t('Both saved addresses identify the same storage server. Choose two different computers. If they are separate computers, their sync identity was copied and must be reset on one of them.',
        'الرابطان المحفوظان يشيران إلى نفس هوية خادم التخزين. اختر جهازين مختلفين. إذا كانا جهازين منفصلين، فقد نُسخت هوية المزامنة ويجب إعادة ضبطها على أحدهما.'),
      sync_busy: t('A sync job is still running on one of the computers. Wait for it to finish before pairing again.',
        'لا تزال عملية مزامنة تعمل على أحد الجهازين. انتظر اكتمالها قبل إعادة الاقتران.'),
      server_redirect: t('A saved server address redirects to another URL. Update that saved address to the final storage server URL, then pair again.',
        'أحد روابط الخوادم يعيد التوجيه إلى رابط آخر. حدّث الرابط المحفوظ إلى رابط خادم التخزين النهائي، ثم أعد الاقتران.'),
      peer_changed: t('The other server has a different sync identity. Click Pair servers to reconnect these two computers.',
        'تغيّرت هوية المزامنة للخادم الآخر. اضغط اقتران الخادمين لإعادة توصيل الجهازين.'),
      pair_required: t('Pair these two servers before starting sync.', 'اقرن الخادمين قبل بدء المزامنة.'),
      wrong_coordinator: t('Start sync from the computer selected as Dedicated PC, or pair the selected computers again.',
        'ابدأ المزامنة من الجهاز المحدد كجهاز العيادة، أو أعد اقتران الجهازين المحددين.'),
      file_changed: t('A file changed while it was being synced. Pause uploads and file edits on both computers, then click Retry.',
        'تغيّر ملف أثناء المزامنة. أوقف رفع الملفات وتعديلها مؤقتاً على الجهازين، ثم اضغط إعادة المحاولة.'),
      verification_failed: t('A transferred file did not pass verification. Check the connection and available disk space, then click Retry.',
        'لم يجتز أحد الملفات المنقولة التحقق. افحص الاتصال والمساحة المتاحة، ثم اضغط إعادة المحاولة.'),
      name_collision: t('Two stored filenames differ only by letter case. Resolve the duplicate filenames on that computer, then retry.',
        'يوجد اسما ملفين يختلفان فقط في حالة الأحرف. عالج الأسماء المكررة على ذلك الجهاز، ثم أعد المحاولة.'),
      conflict_copy_changed: t('A preserved conflict copy was edited. Review that copy before retrying sync.',
        'تم تعديل نسخة محفوظة لتعارض سابق. راجع تلك النسخة قبل إعادة المزامنة.'),
      review_changed: t('A file changed after this comparison loaded. Reload the comparison before marking it reviewed.',
        'تغيّر ملف بعد تحميل المقارنة. أعد تحميل المقارنة قبل اعتماد المراجعة.'),
      patient_changed: t('A patient was renamed or deleted during sync. Click Retry to apply the latest patient folders.',
        'تغيّر اسم مريض أو حُذف أثناء المزامنة. اضغط إعادة المحاولة لتطبيق أحدث مجلدات المرضى.'),
      patient_rules_unavailable: t('Could not load the patient folder rules. Check the database connection on both computers, then retry.',
        'تعذر تحميل قواعد مجلدات المرضى. افحص اتصال قاعدة البيانات على الجهازين ثم أعد المحاولة.'),
      preview_unavailable: t('Preview unavailable. Retry or download the original to inspect it.',
        'المعاينة غير متاحة. أعد المحاولة أو نزّل الأصل لفحصه.')
    };
    const legacyReasons = [
      [/Choose two different servers with compatible sync support/i, 'same_server'],
      [/Wait for the current sync to finish/i, 'sync_busy'],
      [/Server redirects are not allowed/i, 'server_redirect'],
      [/Invalid or missing clinic secret key/i, 'invalid_clinic_key'],
      [/Invalid sync peer credentials/i, 'invalid_peer_credentials'],
      [/already paired with another computer/i, 'already_paired'],
      [/Select the existing dedicated PC as the coordinator/i, 'wrong_coordinator'],
      [/Invalid peer manifest/i, 'invalid_manifest'],
      [/Patient storage is unavailable/i, 'storage_unavailable'],
      [/Could not read patient storage/i, 'storage_unreadable'],
      [/Storage indexes could not be refreshed/i, 'indexes_unavailable'],
      [/Peer identity changed/i, 'peer_changed'],
      [/Pair the two servers first/i, 'pair_required'],
      [/Start synchronization on the paired dedicated PC/i, 'wrong_coordinator'],
      [/file changed|files changed/i, 'file_changed'],
      [/File verification failed|Transfer exceeded the expected file size/i, 'verification_failed'],
      [/colliding filenames/i, 'name_collision'],
      [/preserved conflict copy was changed/i, 'conflict_copy_changed']
    ];
    const reason = error.code || legacyReasons.find(([pattern]) => pattern.test(msg))?.[1];
    if (reasons[reason]) return `${error.serverName ? error.serverName + ': ' : ''}${reasons[reason]}`;
    if (error.status === 408 || error.name === 'AbortError' || error.name === 'TimeoutError' || /abort/i.test(msg) || /timeout/i.test(msg)) {
      return t(
        'Connection timed out. Ensure the storage server is running on both computers and reachable.',
        'انتهت مهلة الاتصال. تأكد من تشغيل خادم التخزين على كلا الجهازين واتصالهما بالشبكة.');
    }
    if (error.status === 503 || /failed to fetch|networkerror|load failed|connection refused|actively refused/i.test(msg)) {
      return t(
        'Could not reach the storage server. Check that the server is started and the URL is reachable.',
        'تعذر الاتصال بخادم التخزين. تأكد من تشغيل الخادم على ذلك الجهاز وصحة الرابط.');
    }
    if (error.status === 426) return t(
      'Install the latest storage server update on both computers and restart them to sync patient files only.',
      'ثبّت أحدث تحديث لخادم التخزين على الجهازين وأعد تشغيلهما لمزامنة ملفات المرضى فقط.');
    if (error.status === 400 || /HTTP 400/.test(msg)) return t(
      'The other server rejected a file transfer (HTTP 400). Update and restart both server apps, then retry. Existing files are preserved.',
      'رفض الخادم الآخر نقل ملف (HTTP 400). حدّث تطبيق الخادم على الجهازين وأعد تشغيلهما ثم أعد المحاولة. تبقى الملفات الموجودة محفوظة.');
    if (error.status === 404) return t(
      'Update and restart the storage server on both computers, then try pairing again.',
      'حدّث خادم التخزين وأعد تشغيله على الجهازين، ثم حاول الاقتران مجدداً.');
    if (error.status === 401) return t(
      'Sign in again with an administrator account to synchronize storage.',
      'سجّل الدخول مجدداً بحساب مسؤول للمزامنة.');
    if (error.status === 403) return t(
      'Active administrator privileges are required for this action.',
      'تحتاج هذه العملية إلى صلاحيات مسؤول نشط.');
    if (error.status === 409) return t(
      'The storage server rejected this operation (HTTP 409). Install the latest server update on both computers and restart them, then retry to see the specific reason.',
      'رفض خادم التخزين هذه العملية (HTTP 409). ثبّت أحدث تحديث للخادم على الجهازين وأعد تشغيلهما، ثم أعد المحاولة لعرض السبب المحدد.');
    if (t('en', 'ar') === 'en' && msg && !/signal.*abort/i.test(msg)) return msg;
    return t(
      'Could not complete operation. Verify both computers are running, reachable, and have available space.',
      'تعذر إكمال العملية. تأكد من تشغيل الجهازين وصحة الروابط وتوفر الاتصال والمساحة، ثم أعد المحاولة.');
  }

  async function timedRequest(run, timeoutMs, signal) {
    const controller = new AbortController();
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = reason => { controller.abort(reason); rejectAbort(reason); };
    const cancel = () => abort(new DOMException('Review closed or reloaded.', 'AbortError'));
    const timeout = setTimeout(() => abort(new DOMException('Storage server request timed out.', 'TimeoutError')), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      return await Promise.race([Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return run(controller.signal);
      }), aborted]);
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
  }

  async function api(server, route, method = 'GET', body, timeoutMs, binary = false, signal) {
    if (!admin()) throw Object.assign(new Error(t('Administrator access is required.', 'صلاحيات المسؤول مطلوبة.')), { status: 403 });
    const effectiveTimeout = timeoutMs || (['pair', 'jobs'].includes(route) ? 45000 : 25000);
    try {
      return await timedRequest(async requestSignal => {
        let sessionResult = await db.auth.getSession();
        for (let attempt = 0; attempt < 2; attempt++) {
          const { data, error } = sessionResult;
          if (requestSignal.aborted) throw requestSignal.reason;
          if (error || !data?.session?.access_token) throw Object.assign(new Error('Sign in again to synchronize storage.'), { status: 401 });
          const response = await fetch(`${normaliseStoragePresetUrl(server.url)}/api/sync/${route}`, {
            method, cache: 'no-store', signal: requestSignal,
            headers: { 'x-lumin-key': server.key || '', Authorization: `Bearer ${data.session.access_token}`,
              ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {})
          });
          if (response.ok && binary) return await response.blob();
          let result;
          try { result = await response.json(); } catch (_) { result = {}; }
          if (!result || typeof result !== 'object') result = {};
          const clinicKeyRejected = result.code === 'invalid_clinic_key' || /Invalid or missing clinic secret key/i.test(result.error || '');
          if (response.status === 401 && !clinicKeyRejected && attempt === 0 && typeof db.auth.refreshSession === 'function') {
            sessionResult = await db.auth.refreshSession();
            continue;
          }
          if (!response.ok) throw Object.assign(new Error(result.error || `Storage request failed (HTTP ${response.status}).`), {
            status: response.status, code: clinicKeyRejected ? 'invalid_clinic_key' : result.code, serverName: server.name
          });
          return result;
        }
      }, effectiveTimeout, signal);
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError' || /abort/i.test(err.message || '')) {
        throw Object.assign(new Error(t(
          'Connection timed out. Ensure the storage server is running on both computers and reachable.',
          'انتهت مهلة الاتصال. تأكد من تشغيل خادم التخزين على كلا الجهازين واتصالهما بالشبكة.'
        )), { status: 408, name: 'TimeoutError' });
      }
      if (err.message && /failed to fetch|networkerror|load failed|connection refused|actively refused/i.test(err.message)) {
        throw Object.assign(new Error(t(
          'Could not reach the storage server. Check that the server is started and the URL is reachable.',
          'تعذر الاتصال بخادم التخزين. تأكد من تشغيل الخادم على ذلك الجهاز وصحة الرابط.'
        )), { status: 503 });
      }
      throw err;
    }
  }

  async function compatibleInfo() {
    const { coordinator, laptop } = selectedServers();
    const info = await Promise.all([api(coordinator, 'info'), api(laptop, 'info')]);
    if (info.some(server => server.protocol !== 1 || server.fileScope !== 'patient-files-v1' || server.clinicalMetadataVersion !== 2)) {
      throw Object.assign(new Error('Patient-file sync update required.'), { status: 426 });
    }
    if (info[0].nodeId && info[0].nodeId === info[1].nodeId) {
      throw Object.assign(new Error('Both addresses identify the same storage server.'), { status: 409, code: 'same_server' });
    }
    return { ...info[0], peer: info[1] };
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
    set('storage-sync-description', t('Sync patient files and their local tooth assignments, notes, and scan settings between both computers.', 'مزامنة ملفات المرضى وبياناتها المحلية، بما فيها الأسنان المحددة والملاحظات وإعدادات المسح، بين الجهازين.'));
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
    set('storage-sync-pair-label', state.busy ? t('Connecting…', 'جارٍ الاتصال…') : state.paired || state.repairPair ? t('Update pairing', 'تحديث الاقتران') : t('Pair servers', 'اقتران الخادمين'));
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
      const conflictHtml = (job.conflicts || []).map((c, index) => `<li data-reviewed="${Boolean(c.reviewed)}"><div class="storage-sync-conflict-title"><strong>${c.reviewed ? t('Reviewed · both kept', 'تمت المراجعة · حُفظت النسختان') : t('Needs review', 'تحتاج إلى مراجعة')}</strong><button type="button" id="storage-sync-review-${index}" onclick="LuminStorageSync.review(${index})" ${activeJob() ? 'disabled' : ''}><i data-lucide="scan-eye" aria-hidden="true"></i>${t('Review', 'مراجعة')}</button></div><span dir="auto">${escapeHtml(c.path)}</span></li>`).join('');
      if (conflicts.dataset.markup !== conflictHtml) { conflicts.innerHTML = conflictHtml; conflicts.dataset.markup = conflictHtml; if (window.lucide) lucide.createIcons(); }
    }
    const failed = state.job?.status === 'failed';
    const metadataWarning = state.job?.metadataWarning ? errorText(Object.assign(new Error(state.job.metadataWarning), {code:'metadata_unavailable'})) : '';
    const statusMessage = failed ? errorText(Object.assign(new Error(state.job.error), {status: state.job.errorStatus, code: state.job.errorCode}))
      : metadataWarning || (state.job?.metadataStatus === 'current' && !activeJob()
        ? state.job?.conflicts?.some(conflict => !conflict.reviewed)
          ? t('Files synchronized. Review the remaining local annotation or file differences.', 'تمت مزامنة الملفات. راجع الاختلافات المتبقية في البيانات المحلية أو الملفات.')
          : t('Patient IDs, assigned teeth, notes, and scan details are synchronized on both computers.',
            'تمت مزامنة معرّفات المرضى والأسنان المحددة والملاحظات وبيانات المسح على الجهازين.') : '')
      || (!ready() ? t('Set both server URLs in Saved servers, then pair them once.', 'أدخل رابطَي الجهازين في الخوادم المحفوظة، ثم اقرنهما مرة واحدة.')
      : state.repairPair ? t('The selected servers have an old pairing. Update pairing reconnects these two computers and preserves their stored files.',
        'الخادمان المحددان لديهما اقتران قديم. تحديث الاقتران يعيد توصيل هذين الجهازين ويحافظ على الملفات المخزنة.')
      : state.paired ? t('Paired. Both computers must be running and reachable.', 'تم الاقتران. يجب تشغيل الجهازين وإمكانية الاتصال بهما.')
      : t('Pair these two servers to enable one-click sync.', 'اقرن الخادمين لتفعيل المزامنة بنقرة واحدة.'));
    const message = state.actionError || state.error || statusMessage;
    set('storage-sync-message', message);
    document.getElementById('storage-sync-message').dataset.error = String(Boolean(state.actionError || state.error || failed));
  }

  async function refresh() {
    if (!visible() || !ready() || state.refreshing || state.busy || state.review) return;
    state.refreshing = true;
    const epoch = state.epoch, coordinator = selectedServers().coordinator;
    try {
      const info = await compatibleInfo();
      if (epoch !== state.epoch) return;
      state.paired = info.pair?.role === 'coordinator' && info.pair.peerId === info.peer.nodeId
        && info.peer.pair?.role === 'replica' && info.peer.pair.peerId === info.nodeId;
      state.repairPair = !state.paired && Boolean(info.pair || info.peer.pair);
      if (state.paired && selection().peerId !== info.peer.nodeId) {
        selection().peerId = info.peer.nodeId;
        localStorage.setItem(selectionKey, JSON.stringify(selection()));
      }
      const result = await api(coordinator, 'jobs/latest');
      if (epoch !== state.epoch) return;
      state.job = !state.paired || (result.job?.peerId && result.job.peerId !== info.peer.nodeId) ? null : result.job;
      state.error = '';
    } catch (error) { if (epoch === state.epoch) { state.paired = false; state.error = errorText(error); } }
    finally { state.refreshing = false; render(); }
  }

  async function pair() {
    if (!admin() || !ready() || state.busy || activeJob() || state.review) return;
    state.busy = true; state.error = ''; state.actionError = ''; render();
    try {
      const info = await compatibleInfo();
      const { coordinator, laptop } = selectedServers();
      const repair = Boolean((info.pair && (info.pair.peerId !== info.peer.nodeId || info.pair.role !== 'coordinator'))
        || (info.peer.pair && (info.peer.pair.peerId !== info.nodeId || info.peer.pair.role !== 'replica')));
      const result = await api(coordinator, 'pair', 'POST', { url: normaliseStoragePresetUrl(laptop.url), key: laptop.key || '',
        ...(repair ? {replacePair:true} : {}) });
      selection().peerId = result.peerId;
      localStorage.setItem(selectionKey, JSON.stringify(selection()));
      state.paired = true;
      state.repairPair = false;
    } catch (error) { state.paired = false; state.actionError = errorText(error); }
    finally { state.busy = false; render(); }
  }

  async function start() {
    if (!admin() || !state.paired || !ready() || state.busy || activeJob() || state.review) return;
    state.busy = true; state.error = ''; state.actionError = ''; render();
    try { state.job = await api(selectedServers().coordinator, 'jobs', 'POST'); }
    catch (error) { state.actionError = errorText(error); }
    finally { state.busy = false; render(); }
  }

  function closeReview() {
    const review = state.review;
    if (!review || review.saving) return;
    state.review = null;
    review.controller?.abort();
    review.urls.forEach(url => URL.revokeObjectURL(url));
    review.overlay.remove();
    document.body.style.overflow = review.bodyOverflow;
    document.removeEventListener('keydown', review.keydown);
    document.getElementById(`storage-sync-review-${review.index}`)?.focus();
  }

  function reviewKind(kind) {
    return ({path_case: t('The filenames differ in letter case. Compare the contents below.', 'يختلف اسما الملفين في حالة الأحرف. قارن المحتوى أدناه.'),
      both_modified: t('Both computers have different versions. Keeping both preserves the originals and saves both versions on each computer.', 'توجد نسختان مختلفتان على الجهازين. حفظ النسختين يحافظ على الأصلين ويحفظ كليهما على كل جهاز.'),
      metadata: t('Both computers have different local annotations. Keeping both saves a copy with each set of teeth, notes, and scan settings on each computer.', 'توجد بيانات محلية مختلفة على الجهازين. حفظ النسختين يحفظ نسخة بكل مجموعة من الأسنان والملاحظات وإعدادات المسح على كل جهاز.'),
      delete_modified: t('One copy was deleted while the other was modified. The modified file was preserved.', 'حُذفت نسخة بينما عُدّلت الأخرى. تم الاحتفاظ بالملف المعدّل.')})[kind] || t('Compare the copies stored on both computers.', 'قارن النسختين المحفوظتين على الجهازين.');
  }

  function reviewMarkup(review) {
    const data = review.data;
    const versions = ['local', 'remote'].map(side => {
      const record = data?.versions?.[side], file = review.files[side];
      const server = side === 'local' ? review.servers.coordinator : review.servers.laptop;
      const label = side === 'local' ? t('Dedicated PC', 'جهاز العيادة') : t('Laptop', 'اللابتوب');
      const name = record?.path || file?.path || data?.path || review.conflict.path;
      const size = record?.size ?? file?.original?.size;
      const image = file?.url && !file.error;
      const message = record?.deleted ? t('Deleted on this computer', 'محذوف على هذا الجهاز') : file?.error ||
        (file?.loading ? t('Loading preview…', 'جارٍ تحميل المعاينة…') : t('Download this file to inspect it.', 'نزّل الملف لفحصه.'));
      return `<section class="storage-review-version" data-side="${side}"><h4>${label}</h4><p class="storage-review-server">${escapeHtml(server.name || label)}</p><p class="storage-review-path" dir="auto">${escapeHtml(name)}</p>
        <div class="storage-review-preview" aria-busy="${Boolean(file?.loading)}">${image ? `<img src="${file.url}" alt="${escapeHtml(label)}" />` : `${file?.loading ? '<span class="storage-review-loading" aria-hidden="true"></span>' : `<i data-lucide="${/\.zip$/i.test(name) ? 'archive' : 'file'}" aria-hidden="true"></i>`}<p role="status">${escapeHtml(message)}</p>${file?.error && !record?.deleted ? `<button type="button" data-retry="${side}">${t('Retry preview', 'إعادة المعاينة')}</button>` : ''}`}</div>
        <p class="storage-review-server">${size !== undefined ? `${(size / 1048576).toFixed(2)} MB` : ''}</p>${record?.sha256 ? `<p class="storage-review-hash" dir="ltr">SHA-256: ${escapeHtml(record.sha256.slice(0, 16))}…</p>` : ''}
        ${!record?.deleted ? `<button type="button" class="storage-review-download" data-download="${side}" ${file?.downloading ? 'disabled' : ''}><i data-lucide="download" aria-hidden="true"></i>${file?.downloading ? t('Downloading original…', 'جارٍ تنزيل الأصل…') : t('Download original', 'تنزيل الأصل')}</button>` : ''}${file?.downloadError ? `<p class="storage-review-message" role="status">${escapeHtml(file.downloadError)}</p>` : ''}${clinicalMarkup(data?.details?.[side])}</section>`;
    }).join('');
    return `<section role="dialog" aria-modal="true" aria-labelledby="storage-review-title" class="storage-review-dialog" dir="${t('ltr', 'rtl')}"><header><div><h3 id="storage-review-title">${t('Review file difference', 'مراجعة اختلاف الملف')}</h3><p>${escapeHtml(reviewKind(data?.kind || review.conflict.kind))}</p></div><button type="button" data-close aria-label="${t('Close review', 'إغلاق المراجعة')}" ${review.saving ? 'disabled' : ''}><i data-lucide="x" aria-hidden="true"></i></button></header><div class="storage-review-body"><div class="storage-review-versions">${versions}</div>${data?.versions?.local?.sha256 && data.versions.local.sha256 === data.versions.remote?.sha256 ? `<p class="storage-review-same">${t('The file contents are identical.', 'محتوى الملفين متطابق.')}</p>` : ''}<p class="storage-review-message" role="status">${escapeHtml(review.message || '')}</p></div><footer><button type="button" data-reload ${review.saving ? 'disabled' : ''}>${t('Reload comparison', 'إعادة تحميل المقارنة')}</button><button type="button" data-keep ${review.saving || !data?.revision || data.reviewed ? 'disabled' : ''}>${review.saving ? t('Saving review…', 'جارٍ حفظ المراجعة…') : data?.reviewed ? t('Reviewed · both kept', 'تمت المراجعة · حُفظت النسختان') : t('Keep both and mark reviewed', 'حفظ النسختين واعتماد المراجعة')}</button></footer></section>`;
  }

  function clinicalMarkup(details) {
    if (!details) return `<p class="storage-review-server">${t('Patient details are loading or unavailable on this server.', 'بيانات المريض قيد التحميل أو غير متاحة على هذا الخادم.')}</p>`;
    const row = (label, value, direction = 'auto') => `<div><dt>${label}</dt><dd dir="${direction}">${escapeHtml(String(value || '—'))}</dd></div>`;
    const teeth = (details.tooth_ids || (details.tooth_id ? [details.tooth_id] : [])).map(String).filter(id => /^(?:[1-9]|[12][0-9]|3[0-2]|[A-T])$/.test(id));
    const scan = details.scan_config;
    const scanRows = scan ? [
      scan.original_filename && row(t('Original scan file', 'ملف المسح الأصلي'), scan.original_filename),
      scan.upper_path && row(t('Upper arch', 'الفك العلوي'), scan.upper_path),
      scan.lower_path && row(t('Lower arch', 'الفك السفلي'), scan.lower_path),
      ['y-up','z-up'].includes(scan.orientation) && row(t('Display orientation', 'اتجاه العرض'),
        scan.orientation === 'y-up' ? t('Y up', 'المحور Y لأعلى') : t('Z up (dental export)', 'المحور Z لأعلى (تصدير الأسنان)'))
    ].filter(Boolean).join('') : '';
    return `<section class="storage-review-clinical" aria-label="${t('Patient and file details', 'بيانات المريض والملف')}"><h5><i data-lucide="clipboard-list" aria-hidden="true"></i>${t('Patient and file details', 'بيانات المريض والملف')}</h5><dl>
      ${row(t('Patient', 'المريض'), details.patient_name)}${row(t('Patient ID', 'معرّف المريض'), details.patient_id, 'ltr')}${row(t('Patient number', 'رقم المريض'), details.patient_number, 'ltr')}
      <div><dt>${t('Assigned teeth', 'الأسنان المحددة')}</dt><dd class="storage-review-teeth" dir="ltr">${teeth.length ? teeth.map(id => `<span>${escapeHtml(id)}</span>`).join('') : '—'}</dd></div>
      ${row(t('File label', 'اسم الملف'), details.display_name)}${row(t('Notes', 'الملاحظات'), details.note)}${details.scan_date ? row(t('Scan date', 'تاريخ المسح'), details.scan_date, 'ltr') : ''}
      </dl>${scan ? `<div class="storage-review-scan"><p>${t('Saved scan settings', 'إعدادات المسح المحفوظة')}</p>${scanRows ? `<dl>${scanRows}</dl>` : `<p>${t('Scan settings are saved with this file.', 'إعدادات المسح محفوظة مع هذا الملف.')}</p>`}</div>` : ''}
      ${!details.metadata_available ? `<p class="storage-review-server">${t('No saved tooth assignments or file annotations.', 'لا توجد أسنان محددة أو ملاحظات محفوظة لهذا الملف.')}</p>` : ''}</section>`;
  }

  function renderReview(review) {
    if (state.review !== review) return;
    const active = review.overlay.contains(document.activeElement) ? document.activeElement : null;
    const focusAttribute = ['data-close', 'data-reload', 'data-keep', 'data-retry', 'data-download'].find(attr => active?.hasAttribute(attr));
    const focusValue = focusAttribute ? active.getAttribute(focusAttribute) : '';
    review.overlay.innerHTML = reviewMarkup(review);
    review.overlay.querySelector('[data-close]').onclick = closeReview;
    review.overlay.querySelector('[data-reload]').onclick = () => loadReview(review);
    review.overlay.querySelector('[data-keep]').onclick = () => saveReview(review);
    review.overlay.querySelectorAll('[data-retry]').forEach(button => { button.onclick = () => loadPreview(review, button.dataset.retry); });
    review.overlay.querySelectorAll('[data-download]').forEach(button => { button.onclick = () => downloadOriginal(review, button.dataset.download); });
    review.overlay.querySelectorAll('.storage-review-preview img').forEach(img => {
      const side = img.closest('[data-side]').dataset.side;
      img.onerror = () => {
        if (state.review !== review || review.files[side]?.url !== img.src) return;
        review.files[side].error = t('Preview could not be displayed. Retry or download the original.', 'تعذر عرض المعاينة. أعد المحاولة أو نزّل الأصل.');
        renderReview(review);
      };
    });
    if (window.lucide) lucide.createIcons();
    const focus = focusAttribute && review.overlay.querySelector(`[${focusAttribute}="${focusValue}"]:not(:disabled)`);
    (focus || review.overlay.querySelector('[data-close]'))?.focus();
  }

  async function reviewFile(server, path, preview, signal) {
    return timedRequest(async requestSignal => {
      const prefix = preview ? 'api/thumbnail' : 'files';
      const response = await fetch(`${normaliseStoragePresetUrl(server.url)}/${prefix}/${path.split('/').map(encodeURIComponent).join('/')}`, {
        headers: {'x-lumin-key': server.key || ''}, cache: 'no-store', signal: requestSignal
      });
      if (!response.ok) throw Object.assign(new Error(t('File unavailable on this computer. Retry or download the original.', 'الملف غير متاح على هذا الجهاز. أعد المحاولة أو نزّل الأصل.')), {code: preview ? 'preview_unavailable' : undefined});
      const blob = await response.blob();
      if (preview && !blob.type.startsWith('image/')) throw Object.assign(new Error('Preview unavailable.'), {code:'preview_unavailable'});
      return blob;
    }, preview ? 15000 : 120000, signal);
  }

  const previewable = path => /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(path);

  async function loadPreview(review, side) {
    const file = review.files[side];
    if (state.review !== review || !file || !previewable(file.path) || review.data?.versions?.[side]?.deleted) return;
    file.controller?.abort();
    const controller = file.controller = new AbortController();
    const parentSignal = review.controller.signal;
    const cancel = () => controller.abort();
    parentSignal.addEventListener('abort', cancel, { once: true });
    file.loading = true; file.error = ''; renderReview(review);
    const current = () => state.review === review && review.files[side] === file && file.controller === controller;
    try {
      const server = side === 'local' ? review.servers.coordinator : review.servers.laptop;
      const blob = await reviewFile(server, file.path, true, controller.signal);
      if (!current()) return;
      if (file.url) URL.revokeObjectURL(file.url);
      file.url = URL.createObjectURL(blob); review.urls.push(file.url);
    } catch (error) {
      if (current()) file.error = error.name === 'TimeoutError'
        ? t('Preview timed out. Retry or download the original.', 'انتهت مهلة المعاينة. أعد المحاولة أو نزّل الأصل.') : errorText(error);
    } finally {
      parentSignal.removeEventListener('abort', cancel);
      if (current()) { file.loading = false; renderReview(review); }
    }
  }

  async function downloadOriginal(review, side) {
    const file = review.files[side], generation = review.generation;
    if (state.review !== review || !file || file.downloading) return;
    file.downloading = true; file.downloadError = ''; renderReview(review);
    const current = () => state.review === review && generation === review.generation && review.files[side] === file;
    try {
      const server = side === 'local' ? review.servers.coordinator : review.servers.laptop;
      const blob = review.data?.revision
        ? await api(review.servers.coordinator, `${review.route}/file?side=${side}&revision=${encodeURIComponent(review.data.revision)}`, 'GET', undefined, 120000, true, review.controller.signal)
        : await reviewFile(server, file.path, false, review.controller.signal);
      if (!current()) return;
      file.original = blob;
      const url = URL.createObjectURL(blob); review.urls.push(url);
      const link = document.createElement('a'); link.href = url; link.download = file.path.split('/').pop();
      document.body.append(link); link.click(); link.remove();
    } catch (error) { if (current()) file.downloadError = errorText(error); }
    finally { if (current()) { file.downloading = false; renderReview(review); } }
  }

  async function loadReview(review) {
    if (state.review !== review || review.saving) return;
    const generation = review.generation = (review.generation || 0) + 1;
    review.controller?.abort(); review.controller = new AbortController();
    review.urls.forEach(url => URL.revokeObjectURL(url)); review.urls = [];
    review.files = Object.fromEntries(['local', 'remote'].map(side => [side, {path: review.conflict.path, loading: previewable(review.conflict.path)}]));
    review.data = null; review.message = t('Loading comparison…', 'جارٍ تحميل المقارنة…');
    renderReview(review);
    for (const side of ['local', 'remote']) void loadPreview(review, side);
    let legacy = false;
    const current = () => state.review === review && generation === review.generation;
    let data;
    try {
      data = await api(review.servers.coordinator, review.route, 'GET', undefined, undefined, false, review.controller.signal);
    } catch (error) {
      if (!current()) return;
      if (error.status !== 404) { review.message = errorText(error); renderReview(review); return; }
      // Older servers can still preview originals; saving a durable review
      // requires the updated EXE. Never silently dismiss a server warning.
      legacy = true;
      data = {path: review.conflict.path, kind: review.conflict.kind};
    }
    if (!current()) return;
    review.data = data;
    for (const side of ['local', 'remote']) {
      const record = data.versions?.[side];
      if (!legacy && (!record || record.deleted)) {
        review.files[side].controller?.abort();
        review.files[side] = {path: record?.path || data.path, error: t('File unavailable on this computer.', 'الملف غير متاح على هذا الجهاز.')};
      } else if (record && record.path !== review.files[side].path) {
        review.files[side].controller?.abort(); review.files[side] = {path: record.path};
        void loadPreview(review, side);
      }
    }
    review.message = legacy ? t('Install the updated Lumin Storage Setup on the dedicated PC to save this review. You can preview and download the originals now.',
      'ثبّت إصدار إعداد خادم Lumin المحدّث على جهاز العيادة لحفظ المراجعة. يمكنك معاينة الأصلين وتنزيلهما الآن.') : '';
    renderReview(review);
  }

  async function saveReview(review) {
    if (state.review !== review || review.saving || !review.data?.revision) return;
    review.saving = true; renderReview(review);
    try {
      const result = await api(review.servers.coordinator, review.route, 'POST', {action: 'keep_both', revision: review.data.revision}, 120000);
      state.job = result.job; review.saving = false; render(); closeReview();
    } catch (error) { review.saving = false; review.message = errorText(error); renderReview(review); }
  }

  function review(index) {
    const conflict = state.job?.conflicts?.[index];
    if (!admin() || !conflict || activeJob() || state.busy || state.review?.saving || !ready()) return;
    closeReview();
    const overlay = document.createElement('div'); overlay.className = 'storage-review-overlay'; document.body.append(overlay);
    const servers = selectedServers();
    const context = {index, conflict, overlay, servers: {coordinator: {...servers.coordinator}, laptop: {...servers.laptop}},
      route: `jobs/${encodeURIComponent(state.job.id)}/conflicts/${index}`, files: {}, urls: [], bodyOverflow: document.body.style.overflow};
    state.review = context; document.body.style.overflow = 'hidden';
    context.keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); closeReview(); }
      if (event.key === 'Tab') {
        const focusable = [...overlay.querySelectorAll('button:not(:disabled),a[href]')];
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', context.keydown);
    void loadReview(context);
  }

  function select(role, id) {
    if (!['coordinator', 'laptop'].includes(role) || state.busy || activeJob() || state.review?.saving) return;
    closeReview(); selection()[role] = id; selection().peerId = null;
    localStorage.setItem(selectionKey, JSON.stringify(selection()));
    state.epoch++; state.paired = false; state.repairPair = false; state.job = null; state.error = ''; state.actionError = '';
    render(); void refresh();
  }

  function open() {
    render(); void refresh();
    if (state.timer === null) state.timer = setInterval(() => { void refresh(); }, 2000);
  }

  function close() {
    closeReview();
    if (state.timer !== null) clearInterval(state.timer);
    state.timer = null;
    state.epoch++;
  }

  document.addEventListener('visibilitychange', () => { if (visible()) void refresh(); });
  window.addEventListener('online', () => { if (visible()) void refresh(); });
  window.LuminStorageSync = { render, open, close, select, pair, start, review };
})();
