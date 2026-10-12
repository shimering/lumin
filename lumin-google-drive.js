/* Clinic-wide Drive storage. Google credentials never enter the browser. */
(() => {
  const state = {checked: false, connected: false, configured: false, email: '', rootName: 'Lumin Clinic', rootUrl: '', mediaGrant: '', expiresAt: 0, busy: false, loading: null, error: '', popup: null, poll: null, userId: null};
  const t = (en, ar) => typeof currentUiLanguage !== 'undefined' && currentUiLanguage === 'ar' ? ar : en;
  const endpoint = () => `${SUPABASE_URL}/functions/v1/google-drive`;
  const isDrive = url => String(url || '').replace(/\/+$/, '') === endpoint();
  const admin = () => typeof currentUserAccess !== 'undefined' && currentUserAccess?.isAdmin;
  const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const escape = value => typeof escapeHtml === 'function' ? escapeHtml(String(value || '')) : String(value || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  async function invoke(action) {
    const {data, error} = await db.functions.invoke('google-drive', {body: {action}, timeout: 20000});
    if (error) {
      let message = t('Google Drive could not be reached. Complete its setup and try again.', 'تعذر الاتصال بـ Google Drive. أكمل الإعداد وحاول مرة أخرى.');
      if (error.context?.json) { try { message = (await error.context.json()).error || message; } catch (_) {} }
      throw new Error(message);
    }
    if (data?.error) throw new Error(data.error); return data;
  }
  function preset() { return {id: 'preset-google-drive', name: 'Google Drive', url: endpoint(), key: state.mediaGrant, icon: 'cloud', provider: 'google-drive'}; }
  function presets(list) { return [...list.filter(p => p.id !== 'preset-google-drive' && !isDrive(p.url)), preset()]; }
  function config(url) { return isDrive(url) ? {url: endpoint(), key: state.mediaGrant} : null; }
  function render() {
    const host = document.getElementById('storage-google-drive-panel');
    if (!host) return;
    const active = isDrive(typeof getStorageServerConfig === 'function' ? getStorageServerConfig().url : '');
    host.dir = typeof currentUiLanguage !== 'undefined' && currentUiLanguage === 'ar' ? 'rtl' : 'ltr';
    const root = state.connected ? `<a class="drive-action" href="${escape(state.rootUrl)}" target="_blank" rel="noopener noreferrer">${icon('folder-open')}${t('Open clinic folder', 'فتح مجلد العيادة')}</a>` : '';
    host.innerHTML = `<div class="drive-heading"><span class="drive-icon">${icon('cloud')}</span><div class="min-w-0"><h4>${t('Google Drive storage', 'التخزين على Google Drive')}</h4><p>${t('One clinic connection for authorized doctors. Patient folders keep their category structure.', 'اتصال واحد للعيادة للأطباء المصرح لهم. تحتفظ مجلدات المرضى بترتيب التصنيفات.')}</p></div><span class="drive-badge ${state.connected ? 'is-connected' : ''}">${state.busy ? t('Connecting…', 'جارٍ الاتصال…') : state.connected ? t('Connected', 'متصل') : t('Not connected', 'غير متصل')}</span></div>
      ${state.connected ? `<div class="drive-account"><strong dir="ltr">${escape(state.email)}</strong><span>${escape(state.rootName)}</span></div>` : ''}
      <div class="drive-actions"><button type="button" class="drive-action is-primary" onclick="LuminGoogleDrive.connect()" ${state.busy ? 'disabled' : ''}>${icon('link')}${state.connected ? t('Reconnect Google Drive', 'إعادة ربط Google Drive') : t('Connect Google Drive', 'ربط Google Drive')}</button>${root}${state.connected ? `<button type="button" class="drive-action" onclick="LuminGoogleDrive.disconnect()" ${state.busy || active ? 'disabled' : ''}>${icon('unlink')}${t('Disconnect', 'إلغاء الربط')}</button>` : ''}</div>
      <p class="drive-note">${active ? t('Google Drive is selected for the clinic. Switch to a local server before disconnecting.', 'تم اختيار Google Drive للعيادة. اختر خادماً محلياً قبل إلغاء الربط.') : t('Connect first, then choose Google Drive from Quick switch. Sync compares exactly two selected locations.', 'اربط الحساب أولاً ثم اختر Google Drive من التبديل السريع. تقارن المزامنة موقعين محددين فقط.')}</p>
      ${state.error ? `<p class="drive-error" role="alert">${escape(state.error)}</p>` : ''}`;
    document.getElementById('storage-location-card')?.classList.toggle('hidden', active);
    document.getElementById('storage-local-url-field')?.classList.toggle('hidden', active);
    document.getElementById('storage-local-key-field')?.classList.toggle('hidden', active);
    const save = document.getElementById('btn-save-storage'); if (save) { save.classList.toggle('hidden', active); if (active) save.disabled = true; }
    if (window.lucide) lucide.createIcons();
  }
  function renderAll() { if (typeof renderStorageServerPresets === 'function') renderStorageServerPresets(); else render(); }
  function card(p, active, switching, saving) {
    if (p.provider !== 'google-drive') return null;
    return `<article class="storage-server-card drive-card" data-active="${active}" data-storage-preset-id="${p.id}"><div class="drive-card-heading"><span class="drive-icon">${icon('cloud')}</span><h4>Google Drive</h4><span class="drive-badge ${state.connected ? 'is-connected' : ''}">${active ? t('Active storage', 'التخزين النشط') : state.connected ? t('Connected', 'متصل') : t('Connect first', 'اربط الحساب أولاً')}</span></div><p class="drive-note">${escape(state.connected ? state.email : t('Store patient files in your clinic Drive folder.', 'احفظ ملفات المرضى في مجلد Drive الخاص بالعيادة.'))}</p>${active ? '<span data-active-storage-connection role="status"></span>' : ''}<button type="button" class="drive-action is-primary" onclick="${state.connected ? `switchToStoragePreset('${p.id}')` : 'LuminGoogleDrive.connect()'}" ${saving || state.busy || active ? 'disabled' : ''} aria-pressed="${active}">${icon(switching ? 'loader-circle' : active ? 'check' : state.connected ? 'arrow-right-left' : 'link')}${switching ? t('Switching…', 'جارٍ التبديل…') : active ? t('Selected', 'مُختار') : state.connected ? t('Use Google Drive', 'استخدام Google Drive') : t('Connect Google Drive', 'ربط Google Drive')}</button></article>`;
  }
  async function refresh(force = false) {
    const userId = typeof currentUserAccess !== 'undefined' ? currentUserAccess?.userId : null;
    if (state.userId && state.userId !== userId) reset();
    if (state.loading) return state.loading;
    if (!force && state.checked && state.expiresAt > Date.now() + 60000) return state;
    state.userId = userId;
    const expected = userId;
    state.loading = (async () => {
      try {
        const data = await invoke('status');
        if (state.userId !== expected) return state;
        Object.assign(state, data, {checked: true, expiresAt: Date.parse(data.expiresAt), error: ''});
      } catch (error) { if (state.userId === expected) { state.error = error.message; state.checked = true; state.expiresAt = Date.now() + 30000; state.mediaGrant = ''; } throw error; }
      finally { state.loading = null; renderAll(); }
      return state;
    })();
    return state.loading;
  }
  async function ensure() { return refresh(false); }
  function stopPopup() { if (state.poll) clearInterval(state.poll); state.poll = null; state.busy = false; state.popup = null; }
  async function connectedResult(result, message) {
    stopPopup();
    if (result === 'connected') { try { await refresh(true); } catch (_) {} }
    else state.error = message || t('Google Drive connection was cancelled.', 'تم إلغاء ربط Google Drive.');
    renderAll();
  }
  async function connect() {
    if (!admin() || state.busy) return;
    state.busy = true; state.error = '';
    state.popup = window.open('about:blank', 'lumin-google-drive', 'width=540,height=720'); renderAll();
    try {
      const data = await invoke('begin-connect');
      if (!state.popup) { location.assign(data.authorization_url); return; }
      state.popup.location = data.authorization_url;
      state.poll = setInterval(() => { if (state.popup?.closed) { stopPopup(); void refresh(true).catch(() => {}); } }, 1000);
    } catch (error) { state.popup?.close(); stopPopup(); state.error = error.message; renderAll(); }
  }
  async function disconnect() {
    if (!admin() || state.busy || isDrive(getStorageServerConfig().url)) return;
    if (!confirm(t('Disconnect clinic Google Drive? Patient files will be kept in Drive.', 'إلغاء ربط Google Drive الخاص بالعيادة؟ ستبقى ملفات المرضى في Drive.'))) return;
    state.busy = true; renderAll();
    try { await invoke('disconnect'); reset(); await refresh(true); }
    catch (error) { state.error = error.message; }
    finally { state.busy = false; renderAll(); }
  }
  function reset() {
    if (state.mediaGrant) void fetch(`${endpoint()}/api/revoke-grant`, {method: 'POST', headers: {'x-lumin-key': state.mediaGrant}, keepalive: true}).catch(() => {});
    state.popup?.close(); stopPopup(); Object.assign(state, {checked: false, connected: false, mediaGrant: '', expiresAt: 0, userId: null, loading: null, email: '', rootUrl: '', error: ''});
  }
  window.addEventListener('message', event => {
    if (event.origin === location.origin && event.source === state.popup && event.data?.type === 'GOOGLE_DRIVE_AUTH_RESULT') void connectedResult(event.data.result, event.data.message);
  });
  window.addEventListener('focus', () => { if (state.connected && state.expiresAt < Date.now() + 60000) void refresh().catch(() => {}); });
  setInterval(() => {
    if (state.connected && document.visibilityState === 'visible' && navigator.onLine !== false && state.expiresAt < Date.now() + 2 * 60000) void refresh().catch(() => {});
  }, 60000);
  function open() {
    render();
    const parameters = new URLSearchParams(location.search), result = parameters.get('google_drive');
    if (result) {
      parameters.delete('google_drive'); const message = parameters.get('google_drive_message'); parameters.delete('google_drive_message');
      const clean = new URL(location.href); clean.search = parameters.toString(); history.replaceState(null, '', clean);
      void connectedResult(result, message);
    } else if (!state.checked) void refresh().catch(() => {});
  }
  window.LuminGoogleDrive = {isDrive, preset, presets, config, card, render, open, ensure, connect, disconnect, reset, refresh};
})();
