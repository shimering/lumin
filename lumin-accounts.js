(function (root) {
  'use strict';
  const doc = root.document;
  const KEY = 'lumin-saved-accounts-v1';
  const MAX_ACCOUNTS = 12;
  let config, overlay, anchor, busy = false, frozen = false, installing = false;
  let pendingAction = null, identity = null;
  const requests = new Set(), drafts = new Map();
  const t = (en, ar) => config?.language() === 'ar' ? ar : en;
  const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const escape = value => String(value || '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icons = () => { if (root.lucide) root.lucide.createIcons(); };
  const sessionPair = session => typeof session?.access_token === 'string' && session.access_token && typeof session?.refresh_token === 'string' && session.refresh_token
    ? {access_token: session.access_token, refresh_token: session.refresh_token} : null;

  function accounts() {
    try {
      const saved = JSON.parse(root.localStorage.getItem(KEY) || '[]');
      if (!Array.isArray(saved)) return [];
      const seen = new Set();
      return saved.filter(item => item && typeof item.id === 'string' && item.id && !seen.has(item.id) && seen.add(item.id))
        .slice(0, MAX_ACCOUNTS).map(item => ({
          id: item.id, name: String(item.name || ''), login: String(item.login || ''),
          email: String(item.email || ''), role: String(item.role || ''), trusted: item.trusted === true,
          session: item.trusted === true ? sessionPair(item.session) : null
        }));
    } catch (_) { return []; }
  }

  function write(items) {
    try { root.localStorage.setItem(KEY, JSON.stringify(items)); }
    catch (_) { throw new Error(t('This browser could not save the account. Allow site storage and try again.', 'تعذر حفظ الحساب في هذا المتصفح. اسمح بتخزين بيانات الموقع ثم حاول مرة أخرى.')); }
    refreshEntryPoints();
  }

  function remove(id) {
    const items = accounts(), item = items.find(entry => entry.id === id);
    write(items.filter(entry => entry.id !== id));
    try {
      const remembered = root.localStorage.getItem('lumin-dental-remembered-login');
      if (item && [item.login,item.email].includes(remembered)) root.localStorage.removeItem('lumin-dental-remembered-login');
    } catch (_) {}
  }

  // Only explicitly remembered accounts receive a second, switchable session.
  // Authorization always comes from the server, never from these display labels.
  function capture(session, access, preference) {
    if (!session?.user?.id || !access) return true;
    const items = accounts(), previous = items.find(item => item.id === session.user.id);
    if (!previous && !preference?.remember) return true;
    if (preference && !preference.remember) {
      remove(session.user.id);
      return true;
    }
    const trusted = preference ? preference.trusted === true : previous.trusted;
    const item = {id: session.user.id, name: access.fullName, login: access.loginName,
      email: access.email, role: access.roleName, trusted, session: trusted ? sessionPair(session) : null};
    if (!previous && items.length >= MAX_ACCOUNTS) throw new Error(t('Remove a saved account before adding another.', 'احذف حسابًا محفوظًا قبل إضافة حساب آخر.'));
    write([item, ...items.filter(entry => entry.id !== item.id)]);
    return true;
  }

  function rememberSession(session) {
    if (!session?.user?.id) return;
    const items = accounts(), item = items.find(entry => entry.id === session.user.id);
    if (!item?.trusted) return;
    item.session = sessionPair(session);
    write(items);
  }

  function signedOut(id = identity) {
    if (!id) return;
    const items = accounts(), item = items.find(entry => entry.id === id);
    if (item) { item.session = null; write(items); }
  }

  function currentRecord() {
    const access = config.access(), session = config.session();
    if (!access || !session) return null;
    return accounts().find(item => item.id === session.user.id) || {id: session.user.id, name: access.fullName,
      login: access.loginName, email: access.email, role: access.roleName, trusted: false, session: null};
  }

  function button(action, label, symbol, extra = '') {
    return `<button type="button" class="la-button ${extra}" data-account-action="${action}">${icon(symbol)}<span>${label}</span></button>`;
  }

  function frame(title, subtitle, body, footer = '') {
    const panel = overlay.querySelector('.la-panel');
    panel.innerHTML = `<header class="la-header"><div class="la-heading"><span class="la-heading-icon">${icon('users-round')}</span><div><h2 id="la-title">${title}</h2><p>${subtitle}</p></div></div>${button('close', t('Close','إغلاق'), 'x', 'la-icon-button')}</header>
      <div class="la-body">${body}<p id="la-error" class="la-error" role="alert" hidden></p></div>${footer ? `<footer class="la-footer">${footer}</footer>` : ''}`;
    icons(); position();
  }

  function renderList() {
    const current = currentRecord(), saved = accounts();
    const rows = current ? [current, ...saved.filter(item => item.id !== current.id)] : saved;
    const list = rows.map(item => {
      const active = item.id === current?.id;
      const badge = active ? t('Current account','الحساب الحالي') : item.session ? t('Ready to switch','جاهز للتبديل') : t('Password required','كلمة المرور مطلوبة');
      return `<div class="la-account${active ? ' la-current' : ''}"><button class="la-account-select" type="button" data-account-action="select" data-account-id="${escape(item.id)}" ${active ? 'disabled' : ''}>
        <span class="la-avatar">${escape((item.name || item.login || '?').trim().slice(0,1).toUpperCase())}</span><span class="la-account-details"><strong dir="auto">${escape(item.name || item.login)}</strong><span dir="auto">${escape(item.login || item.email)}${item.role ? ' · ' + escape(item.role) : ''}</span><span class="la-badge${active ? ' la-badge-current' : ''}">${active ? icon('check') : icon(item.session ? 'zap' : 'key-round')}${badge}</span></span>${!active ? icon('arrow-right-left') : ''}</button>
        ${saved.some(entry => entry.id === item.id) ? `<button type="button" class="la-button la-icon-button la-remove" data-account-action="remove" data-account-id="${escape(item.id)}" aria-label="${escape(t('Remove from this device','إزالة من هذا الجهاز') + ': ' + (item.name || item.login))}" title="${t('Remove from this device','إزالة من هذا الجهاز')}">${icon('x')}</button>` : ''}</div>`;
    }).join('');
    const remembered = current && saved.some(item => item.id === current.id);
    frame(t('Your accounts','حساباتك'), t('On this browser · One active account','في هذا المتصفح · حساب نشط واحد'),
      `<div class="la-account-list">${list || `<div class="la-empty"><span class="la-heading-icon">${icon('user-round-plus')}</span><strong>${t('No saved accounts yet','لا توجد حسابات محفوظة بعد')}</strong><p>${t('Add an account to find it here next time.','أضف حسابًا لتجده هنا في المرة القادمة.')}</p></div>`}</div>
      ${current ? `<div class="la-preferences"><label class="la-check"><input id="la-remember-current" type="checkbox" ${remembered ? 'checked' : ''}><span>${t('Remember this account','تذكر هذا الحساب')}</span></label><label class="la-check"><input id="la-trust-current" type="checkbox" ${current.trusted ? 'checked' : ''} ${!remembered ? 'disabled' : ''}><span>${t('Allow password-free switching','السماح بالتبديل دون كلمة مرور')}</span></label><p>${t('Use password-free switching only on a trusted device. Anyone using this browser can open these accounts.','استخدم التبديل دون كلمة مرور على جهاز موثوق فقط. يمكن لأي شخص يستخدم هذا المتصفح فتح هذه الحسابات.')}</p></div>` : ''}`,
      `${button('add', t('Add account','إضافة حساب'), 'user-round-plus', 'la-primary')}${current ? button('settings', t('My Settings','إعداداتي'), 'settings') : ''}`);
  }

  function renderForm(item) {
    frame(item ? t('Sign in again','سجّل الدخول مجددًا') : t('Add account','إضافة حساب'),
      t('Your current account stays open until sign-in succeeds.','يبقى حسابك الحالي مفتوحًا حتى ينجح تسجيل الدخول.'),
      `<form id="la-login-form" class="la-form"><label>${t('Login name or email','اسم الدخول أو البريد الإلكتروني')}<input id="la-identifier" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${escape(item?.login || item?.email)}" ${item ? 'readonly' : ''}></label>
      <label>${t('Password','كلمة المرور')}<input id="la-password" name="password" type="password" autocomplete="current-password" required></label>
      <label class="la-check"><input id="la-remember" type="checkbox" checked><span>${t('Remember this account on this device','تذكر هذا الحساب على هذا الجهاز')}</span></label>
      <label class="la-check"><input id="la-trust" type="checkbox" ${item?.trusted ? 'checked' : ''}><span>${t('Allow password-free switching (trusted device)','السماح بالتبديل دون كلمة مرور (جهاز موثوق)')}</span></label>
      <p class="la-note">${t('Saved accounts stay in this browser. Passwords are never stored by Lumin.','تبقى الحسابات المحفوظة في هذا المتصفح. لا يخزّن لومين كلمات المرور.')}</p><input id="la-target" type="hidden" value="${escape(item?.id)}"></form>`,
      `${button('back',t('Back','رجوع'),'arrow-left') }<button type="submit" form="la-login-form" class="la-button la-primary">${icon('log-in')}<span>${t('Sign in and switch','تسجيل الدخول والتبديل')}</span></button>`);
    overlay.querySelector(item ? '#la-password' : '#la-identifier').focus();
  }

  function errorMessage(message) {
    const node = overlay?.querySelector('#la-error');
    if (node) { node.textContent = message; node.hidden = false; node.tabIndex = -1; position(); node.focus({preventScroll:true}); }
  }

  function setBusy(value) {
    busy = value;
    if (!overlay) return;
    overlay.querySelector('.la-panel').setAttribute('aria-busy', String(value));
    overlay.querySelectorAll('button,input').forEach(node => {
      if (value) { node.dataset.wasDisabled = String(node.disabled); node.disabled = true; }
      else if (node.dataset.wasDisabled !== undefined) { node.disabled = node.dataset.wasDisabled === 'true'; delete node.dataset.wasDisabled; }
    });
    overlay.classList.toggle('la-working', value);
  }

  function position() {
    if (!overlay) return;
    const panel = overlay.querySelector('.la-panel');
    if (root.innerWidth < 768) { panel.style.insetInlineStart = ''; panel.style.top = ''; return; }
    const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
    const width = Math.min(400, root.innerWidth - 32), height = Math.min(panel.scrollHeight, root.innerHeight - 32);
    const x = rect ? (rect.width < 80 && rect.x < 100 ? rect.right + 12 : rect.right - width) : (root.innerWidth - width) / 2;
    panel.style.left = Math.max(16, Math.min(x, root.innerWidth - width - 16)) + 'px';
    panel.style.top = Math.max(16, Math.min(rect ? rect.bottom + 8 : 96, root.innerHeight - height - 16)) + 'px';
  }

  function open(trigger) {
    if (!config || frozen || busy) return;
    if (overlay) { close(); return; }
    anchor = trigger || doc.activeElement;
    overlay = doc.createElement('div'); overlay.id = 'lumin-account-overlay'; overlay.className = 'la-overlay';
    overlay.innerHTML = '<section class="la-panel" role="dialog" aria-modal="true" aria-labelledby="la-title" tabindex="-1"></section>';
    doc.body.append(overlay); anchor?.setAttribute('aria-expanded', 'true');
    overlay.addEventListener('click', click); overlay.addEventListener('change', change);
    overlay.addEventListener('submit', submit); renderList();
    overlay.querySelector('.la-panel').focus();
  }

  function close() {
    if (busy || frozen) return;
    pendingAction = null; overlay?.remove(); overlay = null;
    anchor?.setAttribute('aria-expanded', 'false');
    if (anchor?.isConnected) anchor.focus();
  }

  function hasDrafts() {
    for (const [node, value] of drafts) {
      if (!node.isConnected) { drafts.delete(node); continue; }
      if (node.getClientRects().length && fieldValue(node) !== value) return true;
    }
    return Boolean(config.hasUnsavedChanges?.());
  }

  function confirmSwitch(action) {
    if (!config.session() || !hasDrafts()) return action();
    pendingAction = action;
    const notice = doc.createElement('div'); notice.className = 'la-discard'; notice.setAttribute('role','alert');
    notice.innerHTML = `<strong>${t('Unsaved changes','تغييرات غير محفوظة')}</strong><p>${t('Switching accounts will discard unsaved changes. Cancel to return and save your work.','سيؤدي تبديل الحساب إلى تجاهل التغييرات غير المحفوظة. ألغِ التبديل للعودة وحفظ عملك.')}</p><div>${button('cancel-discard', t('Cancel','إلغاء'),'x')}${button('discard', t('Discard and switch','تجاهل والتبديل'),'arrow-right-left','la-primary')}</div>`;
    overlay.querySelector('.la-discard')?.remove(); overlay.querySelector('.la-body').prepend(notice);
    notice.querySelector('button').focus(); position();
  }

  async function click(event) {
    if (event.target === overlay) { close(); return; }
    const target = event.target.closest('[data-account-action]');
    if (!target || busy) return;
    const action = target.dataset.accountAction, item = accounts().find(entry => entry.id === target.dataset.accountId);
    if (action === 'close') close();
    else if (action === 'back') renderList();
    else if (action === 'add') renderForm();
    else if (action === 'settings') { close(); config.settings(); }
    else if (action === 'remove' && item) {
      try { remove(item.id); renderList(); }
      catch (error) { errorMessage(error.message); }
    } else if (action === 'select' && item) {
      if (!item.session) renderForm(item);
      else confirmSwitch(() => transition({item}));
    } else if (action === 'cancel-discard') { pendingAction = null; overlay.querySelector('.la-discard')?.remove(); }
    else if (action === 'discard' && pendingAction) { const run = pendingAction; pendingAction = null; overlay.querySelector('.la-discard')?.remove(); await run(); }
  }

  function change(event) {
    const input = event.target;
    if (input.id === 'la-remember') {
      const trust = overlay.querySelector('#la-trust'); trust.disabled = !input.checked; if (!input.checked) trust.checked = false;
    } else if (input.id === 'la-remember-current' || input.id === 'la-trust-current') {
      try {
        capture(config.session(), config.access(), {remember: overlay.querySelector('#la-remember-current').checked,
          trusted: overlay.querySelector('#la-trust-current').checked}); renderList();
      } catch (error) { renderList(); errorMessage(error.message); }
    }
  }

  function submit(event) {
    if (event.target.id !== 'la-login-form') return;
    event.preventDefault(); if (busy) return;
    // Read the password only after any discard decision, and clear the field immediately.
    confirmSwitch(() => {
      const identifier = overlay.querySelector('#la-identifier').value.trim(), password = overlay.querySelector('#la-password').value;
      overlay.querySelector('#la-password').value = '';
      return transition({credentials:{identifier,password}, expectedId: overlay.querySelector('#la-target').value,
        preference:{remember:overlay.querySelector('#la-remember').checked, trusted:overlay.querySelector('#la-trust').checked}});
    });
  }

  function authFailure(error) {
    return error?.code === 'LUMIN_ACCESS_CONFIGURATION' || [400,401,403].includes(error?.status);
  }

  async function transition(options) {
    setBusy(true);
    try {
      if (root.navigator.locks?.request) {
        await root.navigator.locks.request('lumin-account-transition', {ifAvailable:true}, async lock => {
          if (!lock) throw new Error(t('Another tab is switching accounts. Please try again.','تقوم علامة تبويب أخرى بتبديل الحساب. حاول مرة أخرى.'));
          await validateAndInstall(options);
        });
      } else await validateAndInstall(options);
    } catch (error) {
      if (options.item && authFailure(error)) {
        try { signedOut(options.item.id); } catch (_) {}
        renderForm(options.item);
      }
      errorMessage(error?.code === 'LUMIN_ACCESS_CONFIGURATION' ? t('This account is not active or has no access. Contact the clinic administrator.','هذا الحساب غير نشط أو ليس لديه صلاحية. تواصل مع مسؤول العيادة.')
        : authFailure(error) ? t('Sign in again to continue with this account.','سجّل الدخول مجددًا للمتابعة بهذا الحساب.')
        : error?.message || t('Could not switch accounts. Your current account is still open.','تعذر تبديل الحساب. لا يزال حسابك الحالي مفتوحًا.'));
    } finally { if (!frozen) setBusy(false); }
  }

  async function validateAndInstall({item, credentials, expectedId, preference}) {
    const startingId = config.session()?.user?.id || null;
    const probe = config.createClient();
    let session, access;
    try {
      let pair = item?.session;
      if (credentials) {
        const result = await probe.functions.invoke('user-login', {body:credentials});
        credentials.password = '';
        if (result.error) {
          const error = new Error(t('Sign-in failed. Check your login name and password.','فشل تسجيل الدخول. تحقق من اسم الدخول وكلمة المرور.'));
          error.status = result.error.context?.status; throw error;
        }
        pair = sessionPair(result.data);
      }
      if (!pair) throw Object.assign(new Error('Missing session'), {status:401});
      const result = await probe.auth.setSession(pair);
      if (result.error) throw result.error;
      session = result.data.session;
      if (!session || (item?.id || expectedId) && session.user.id !== (item?.id || expectedId)) throw Object.assign(new Error('Account mismatch'),{status:401});
      // A refresh rotates the token even if the later permission request fails.
      rememberSession(session);
      access = await config.loadAccess(session, probe);
    } finally {
      if (credentials) credentials.password = '';
      if (probe.auth.dispose) await probe.auth.dispose();
      else await probe.auth.stopAutoRefresh();
    }
    if ((config.session()?.user?.id || null) !== startingId || frozen) throw new Error(t('The active account changed. Open the account menu again.','تغيّر الحساب النشط. افتح قائمة الحسابات مجددًا.'));
    if ([...requests].some(request => request.write) || config.hasPendingWrites?.()) throw new Error(t('Please wait for changes to finish saving, then switch again.','انتظر حتى يكتمل حفظ التغييرات، ثم حاول التبديل مجددًا.'));
    const previous = (await config.db.auth.getSession()).data?.session;
    if ((previous?.user?.id || null) !== startingId) { freeze(); config.reload(); return; }
    if (previous && config.access()) capture(previous, config.access());
    capture(session, access, preference);
    freeze();
    try {
      await config.beforeSwitch();
      await config.db.auth.stopAutoRefresh();
      installing = true;
      const result = await config.db.auth.setSession(sessionPair(session));
      if (result.error) throw result.error;
      rememberSession(result.data.session);
      config.reload();
    } catch (error) {
      // Restore the previous identity before ever revealing the old application.
      if (previous) {
        const restored = await config.db.auth.setSession(sessionPair(previous));
        if (restored.error) { config.reload(); return; }
      } else { config.reload(); return; }
      thaw(); await config.resume(); throw error;
    } finally { installing = false; }
  }

  function freeze() {
    frozen = true;
    for (const request of requests) request.controller.abort();
    doc.documentElement.classList.add('lumin-account-transition');
    if (!doc.getElementById('la-switching')) {
      const shield = doc.createElement('div'); shield.id = 'la-switching'; shield.setAttribute('role','status'); shield.setAttribute('aria-live','polite');
      shield.innerHTML = `<span class="la-heading-icon">${icon('loader-circle')}</span><strong>${t('Switching accounts…','جارٍ تبديل الحساب…')}</strong><p>${t('Loading your workspace securely.','جارٍ تحميل مساحة عملك بأمان.')}</p>`;
      doc.body.append(shield); icons();
    }
  }

  function thaw() {
    frozen = false; doc.documentElement.classList.remove('lumin-account-transition'); doc.getElementById('la-switching')?.remove();
  }

  // Guard the shared Supabase client while its identity is being replaced.
  // A full navigation then discards all old closures, caches, dialogs and requests.
  async function guardedFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, root.location.href);
    const method = (init.method || input?.method || 'GET').toUpperCase();
    const auth = url.pathname.includes('/auth/v1/');
    const installingAuth = installing && auth && (method === 'GET' && url.pathname.endsWith('/user') || method === 'POST' && url.pathname.endsWith('/token') && url.searchParams.get('grant_type') === 'refresh_token');
    if (frozen && !installingAuth) throw new DOMException('Account changed','AbortError');
    const controller = new AbortController(), signal = init.signal || input?.signal;
    const cancel = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', cancel, {once:true});
    const request = {controller, write:!auth && !['GET','HEAD','OPTIONS'].includes(method)}; requests.add(request);
    try {
      const response = await root.fetch(input, {...init, signal:controller.signal});
      if (frozen && !auth) throw new DOMException('Account changed','AbortError');
      return response;
    } finally { requests.delete(request); signal?.removeEventListener('abort',cancel); }
  }

  // Auth callbacks stay synchronous; awaiting Supabase calls inside them can deadlock.
  function authChanged(event, session) {
    if (frozen) return true;
    const nextId = session?.user?.id || null;
    try {
      if (event === 'SIGNED_OUT') signedOut(identity);
      else if (session) rememberSession(session);
    } catch (_) { /* The active session remains usable when site storage is full. */ }
    if (identity !== null && nextId !== identity) {
      freeze(); void Promise.resolve().then(config.beforeSwitch).catch(() => {}).finally(() => config.reload()); return true;
    }
    if (nextId) identity = nextId;
    return false;
  }

  function refreshEntryPoints() {
    const trigger = doc?.getElementById('login-saved-accounts');
    if (trigger) trigger.hidden = accounts().length === 0;
  }

  const fieldValue = node => node.type === 'checkbox' || node.type === 'radio' ? node.checked : node.isContentEditable ? node.textContent : node.value;
  function trackDraft(event) {
    const node = event.target;
    if (node?.closest('#lumin-account-overlay,#auth-gate') || !node?.matches?.('input:not([type="hidden"]):not([type="search"]),textarea,select,[contenteditable="true"]')) return;
    if (!drafts.has(node)) drafts.set(node, fieldValue(node));
  }

  function init(options) {
    if (config) return;
    config = options; refreshEntryPoints();
    doc.addEventListener('focusin',trackDraft); doc.addEventListener('pointerdown',trackDraft,true);
    doc.addEventListener('keydown', event => {
      if (!overlay || frozen) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      if (event.key !== 'Tab') return;
      const nodes = [...overlay.querySelectorAll('button:not(:disabled),input:not(:disabled):not([type="hidden"]),[tabindex="0"]')].filter(node => node.getClientRects().length);
      const first = nodes[0], last = nodes[nodes.length-1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (doc.activeElement === first || !nodes.includes(doc.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (doc.activeElement === last || !nodes.includes(doc.activeElement))) { event.preventDefault(); first.focus(); }
    },true);
    root.addEventListener('resize',position);
    root.addEventListener('storage', event => {
      if (event.key === KEY) { refreshEntryPoints(); if (overlay && !busy && !overlay.querySelector('form')) renderList(); }
      if (event.key === options.authStorageKey && !frozen && identity) {
        let nextId = null;
        try { nextId = JSON.parse(event.newValue || 'null')?.user?.id || null; } catch (_) {}
        if (nextId !== identity) { freeze(); void Promise.resolve().then(config.beforeSwitch).catch(() => {}).finally(() => config.reload()); }
      }
    });
    doc.getElementById('login-remember-identifier')?.addEventListener('change', () => {
      const trust = doc.getElementById('login-trust-account');
      trust.disabled = !doc.getElementById('login-remember-identifier').checked; if (trust.disabled) trust.checked = false;
    });
  }

  function authorized(session, access) {
    if (frozen) return false;
    if (identity !== null && session?.user?.id !== identity) {
      freeze(); void Promise.resolve().then(config.beforeSwitch).catch(() => {}).finally(() => config.reload()); return false;
    }
    identity = session?.user?.id || null;
    try { capture(session, access); } catch (_) {}
    return true;
  }

  function restoreLoginPreference() {
    const trust = doc.getElementById('login-trust-account'), remember = doc.getElementById('login-remember-identifier');
    if (!trust || !remember) return;
    const identifier = doc.getElementById('login-identifier').value.trim().toLowerCase();
    trust.checked = accounts().some(item => item.trusted && [item.login,item.email].some(value => value.toLowerCase() === identifier));
    trust.disabled = !remember.checked;
  }

  root.LuminAccounts = {init, open, close, capture, authorized, restoreLoginPreference, authChanged, signedOut, fetch:guardedFetch,
    refresh:refreshEntryPoints, isTransitioning:() => frozen};
})(window);
