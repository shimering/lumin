/* One-way finance integration controls. Database credentials never reach this script. */
let financeSyncSnapshot = null;
let financeSyncPoll = null;
let financeSyncLoading = false;
let financeSyncDirty = false;
let financeSyncUserId = null;
const syncText = (en, ar) => currentUiLanguage === 'ar' ? ar : en;
const syncEscape = value => escapeHtml(String(value ?? ''));

function stopFinanceSyncPolling() {
  if (financeSyncPoll) clearInterval(financeSyncPoll);
  financeSyncPoll = null;
}

function resetFinanceSyncState() {
  stopFinanceSyncPolling();
  financeSyncSnapshot = null;
  financeSyncDirty = false;
  financeSyncUserId = null;
  document.getElementById('admin-panel-finance-sync')?.replaceChildren();
}

function populateExpenseSyncMethod(id) {
  const select = document.getElementById(id);
  if (!select) return;
  select.innerHTML = `<option value="">${syncText('Choose a payment method…', 'اختر طريقة الدفع…')}</option>` +
    paymentMethods.filter(method => method.active).map(method => `<option value="${syncEscape(method.id)}">${syncEscape(method.name)}</option>`).join('');
  select.value = '';
}

function financeSyncDraft() {
  const form = document.getElementById('finance-sync-form');
  if (!form) return null;
  return {
    enabled: form.elements.enabled.checked,
    sync_income: form.elements.sync_income.checked,
    sync_expenses: form.elements.sync_expenses.checked,
    payment_routes: Object.fromEntries([...form.querySelectorAll('[data-sync-method]')].map(select => [select.dataset.syncMethod, select.value || null])),
    income_category: form.elements.income_category.value || null,
    expense_categories: Object.fromEntries([...form.querySelectorAll('[data-sync-category]')].map(select => [select.dataset.syncCategory, select.value || null]))
  };
}

function financeSyncOptions(items, selected, placeholder) {
  return `<option value="">${syncEscape(placeholder)}</option>` + items.map(item => {
    const key = item.id || item.key;
    const name = currentUiLanguage === 'ar' ? item.name_ar || item.name : item.name;
    return `<option value="${syncEscape(key)}" ${key === selected ? 'selected' : ''}>${syncEscape(name)}</option>`;
  }).join('');
}

function renderFinanceSyncSnapshot() {
  if (!hasPageAccess('admin') || !financeSyncSnapshot) return;
  const panel = document.getElementById('admin-panel-finance-sync');
  panel.dir = currentUiLanguage === 'ar' ? 'rtl' : 'ltr';
  panel.lang = currentUiLanguage;
  document.querySelector('#admin-tab-finance-sync span').textContent = syncText('Finance sync', 'المزامنة المالية');
  const draft = financeSyncDirty ? financeSyncDraft() : null;
  const data = financeSyncSnapshot;
  const settings = { ...data.settings, ...(draft || {}) };
  const counts = data.counts || {};
  const pending = (counts.pending || 0) + (counts.sending || 0);
  const categoryOptions = kind => settings.categories.filter(category => category.kind === kind);
  const paused = !data.settings.enabled;
  const time = data.last_synced_at ? new Date(data.last_synced_at).toLocaleString(currentUiLanguage === 'ar' ? 'ar-EG' : 'en-GB') : syncText('No entries sent yet', 'لم يتم إرسال قيود بعد');
  panel.innerHTML = `
    <div class="sync-heading"><div class="sync-heading-copy"><span class="sync-icon"><i data-lucide="arrow-right-left"></i></span><div><p class="sync-eyebrow">${syncText('CONNECTED FINANCES', 'الربط المالي')}</p><h3>${syncText('Lumin → Baytna Finance', 'لومين ← مالية بيتنا')}</h3><p>${syncText('Actual money received and paid, routed by payment method.', 'المبالغ المستلمة والمدفوعة فعلياً، حسب طريقة الدفع.')}</p></div></div><span class="sync-badge ${data.connected ? 'sync-green' : 'sync-amber'}">${data.connected ? syncText('Connection configured', 'تم إعداد الاتصال') : syncText('Setup required', 'يلزم إعداد الاتصال')}</span></div>
    <div class="sync-stats" aria-live="polite">${[
      [syncText('Synced', 'تمت المزامنة'), counts.synced || 0, 'sync-green'],
      [syncText('Queued', 'في الانتظار'), pending, 'sync-blue'],
      [syncText('Needs attention', 'تحتاج مراجعة'), (counts.failed || 0) + (counts.needs_method || 0), 'sync-amber'],
      [syncText('Skipped', 'تم تخطيها'), counts.skipped || 0, 'sync-slate']
    ].map(([label, count, tone]) => `<div class="sync-card sync-stat"><span class="sync-badge ${tone}">${label}</span><strong>${count}</strong></div>`).join('')}</div>
    <form id="finance-sync-form" class="sync-card" onsubmit="saveFinanceSyncSettings(event)" onchange="financeSyncDirty = true" oninput="financeSyncDirty = true">
      <div class="sync-section-heading"><div><h4>${syncText('Synchronization controls', 'إدارة المزامنة')}</h4><p>${syncText('Pausing keeps new activity queued. Resume to deliver it.', 'الإيقاف المؤقت يحتفظ بالحركات الجديدة في الانتظار. استأنف لإرسالها.')}</p></div><span class="sync-badge ${paused ? 'sync-amber' : 'sync-green'}">${paused ? syncText('Paused', 'متوقفة مؤقتاً') : syncText('Active', 'نشطة')}</span></div>
      <div class="sync-toggle-grid">
        ${[['enabled', syncText('Enable synchronization', 'تفعيل المزامنة')], ['sync_income', syncText('Patient payments', 'مدفوعات المرضى')], ['sync_expenses', syncText('Expense payments', 'مدفوعات المصروفات')]].map(([key, label]) => `<label class="sync-toggle"><span>${label}</span><input name="${key}" type="checkbox" ${settings[key] ? 'checked' : ''} ${!data.connected && key === 'enabled' ? 'disabled' : ''}/></label>`).join('')}
      </div>
      <div class="sync-section-heading"><div><h4>${syncText('Payment methods → destination accounts', 'طرق الدفع ← الحسابات المستقبلة')}</h4><p>${syncText('Excluded methods never change Baytna balances. Card can be mapped here later.', 'الطرق المستبعدة لا تؤثر على أرصدة بيتنا. يمكنك ربط البطاقة لاحقاً من هنا.')}</p></div></div>
      <div class="sync-mapping-grid">${data.methods.map(method => `<label class="sync-field"><span>${syncEscape(method.name)}${method.active ? '' : ` <small>${syncText('(inactive)', '(غير نشطة)')}</small>`}</span><select data-sync-method="${syncEscape(method.id)}">${financeSyncOptions(settings.accounts, settings.payment_routes[method.id], syncText('Do not sync', 'عدم المزامنة'))}</select></label>`).join('')}</div>
      <div class="sync-section-heading"><div><h4>${syncText('Baytna categories', 'تصنيفات بيتنا')}</h4><p>${syncText('Choose how clinic income and expenses appear in analytics.', 'اختر تصنيف دخل العيادة ومصروفاتها في التحليلات.')}</p></div></div>
      <div class="sync-mapping-grid"><label class="sync-field"><span>${syncText('Patient income', 'دخل المرضى')}</span><select name="income_category">${financeSyncOptions(categoryOptions('income'), settings.income_category, syncText('Uncategorized', 'بدون تصنيف'))}</select></label><label class="sync-field"><span>${syncText('Default expense category', 'تصنيف المصروفات الافتراضي')}</span><select data-sync-category="default">${financeSyncOptions(categoryOptions('expense'), settings.expense_categories.default, syncText('Uncategorized', 'بدون تصنيف'))}</select></label>${data.expense_types.map(type => `<label class="sync-field"><span>${syncEscape(type.name)}</span><select data-sync-category="${syncEscape(type.id)}">${financeSyncOptions(categoryOptions('expense'), settings.expense_categories[type.id], syncText('Use default expense category', 'استخدام التصنيف الافتراضي'))}</select></label>`).join('')}</div>
      <p class="sync-hint">${syncText('Mapping changes apply to subsequent activity. Previously posted entries are not moved automatically.', 'تغييرات الربط تنطبق على الحركات التالية. لا يتم نقل القيود السابقة تلقائياً.')}</p>
      <div class="sync-actions"><span id="finance-sync-save-message" role="status">${financeSyncDirty ? syncText('Unsaved changes', 'تغييرات غير محفوظة') : ''}</span><button class="sync-button sync-primary" type="submit" ${!data.connected ? 'disabled' : ''}><i data-lucide="save"></i>${syncText('Save settings', 'حفظ الإعدادات')}</button></div>
    </form>
    <section class="sync-card"><div class="sync-section-heading"><div><h4>${syncText('Delivery activity', 'نشاط الإرسال')}</h4><p>${syncText('Last successful delivery:', 'آخر إرسال ناجح:')} ${syncEscape(time)}</p></div><div class="sync-actions"><button class="sync-button" type="button" onclick="refreshFinanceSyncCatalogue()"><i data-lucide="refresh-cw"></i>${syncText('Refresh accounts', 'تحديث الحسابات')}</button><button class="sync-button" type="button" onclick="retryFinanceSync()" ${!counts.failed ? 'disabled' : ''}><i data-lucide="rotate-ccw"></i>${syncText('Retry failed', 'إعادة المحاولة')}</button></div></div><p id="finance-sync-action-message" role="status">${data.catalogue_error ? syncEscape(syncReason(data.catalogue_error)) : ''}</p><p class="sync-hint">${syncText('Counts show delivery events, including corrections. Delivery usually takes about one minute; queued items remain safe if Baytna is unavailable.', 'تعرض الأعداد أحداث الإرسال بما فيها التصحيحات. يستغرق الإرسال عادة نحو دقيقة؛ تبقى الحركات محفوظة إذا تعذر الاتصال ببيتنا.')}</p>
      <div class="sync-feed">${data.events.length ? data.events.map(event => financeSyncEventHtml(event, data.methods)).join('') : `<div class="sync-empty"><span class="sync-icon"><i data-lucide="inbox"></i></span><h4>${syncText('Ready for new activity', 'جاهزة للحركات الجديدة')}</h4><p>${syncText('New patient and expense payments will appear here.', 'ستظهر مدفوعات المرضى والمصروفات الجديدة هنا.')}</p><button class="sync-button" type="button" onclick="renderAdminFinanceSync()">${syncText('Refresh activity', 'تحديث النشاط')}</button></div>`}</div>
    </section>
    <div class="sync-card sync-history"><span class="sync-icon"><i data-lucide="history"></i></span><div><h4>${syncText('Existing history stays separate', 'السجل السابق منفصل')}</h4><p>${syncText('Only activity recorded after this connection was created is tracked. Historical import will be a separate action, so existing balances are not counted twice.', 'يتم تتبع الحركات المسجلة بعد إنشاء الاتصال فقط. استيراد السجل السابق سيكون إجراءً منفصلاً لتجنب احتساب الأرصدة مرتين.')}</p></div></div>`;
  if (window.lucide) lucide.createIcons();
}

function financeSyncEventHtml(event, methods) {
  const labels = {
    synced: syncText('Synced', 'تمت المزامنة'), pending: syncText('Queued', 'في الانتظار'), sending: syncText('Sending', 'جارٍ الإرسال'),
    failed: syncText('Failed', 'تعذر الإرسال'), skipped: syncText('Skipped', 'تم التخطي'), needs_method: syncText('Choose method', 'اختر طريقة الدفع')
  };
  const tones = { synced: 'sync-green', pending: 'sync-blue', sending: 'sync-blue', failed: 'sync-rose', skipped: 'sync-slate', needs_method: 'sync-amber' };
  const method = methods.find(item => item.id === event.payment_method_id)?.name || '';
  const amount = (Number(event.payload.amount_minor) || 0) / 100;
  const kind = event.operation === 'delete' ? syncText('Correction / removal', 'تصحيح / إزالة') : event.payload.kind === 'income' ? syncText('Income', 'دخل') : syncText('Expense', 'مصروف');
  const resolve = event.status === 'needs_method' ? `<div class="sync-resolve"><label class="sync-field"><span>${syncText('Payment method', 'طريقة الدفع')}</span><select id="sync-resolve-${event.id}">${financeSyncOptions(methods.filter(item => item.active), null, syncText('Choose method…', 'اختر طريقة الدفع…'))}</select></label><button class="sync-button" type="button" onclick="assignExpenseSyncMethod('${syncEscape(event.source_key.split(':')[1])}', '${event.id}')">${syncText('Assign method', 'تعيين طريقة الدفع')}</button></div>` : '';
  return `<article class="sync-event"><div class="sync-event-main"><div class="sync-event-copy"><span class="sync-eyebrow">${kind}${method ? ` · ${syncEscape(method)}` : ''}</span><strong>${syncEscape(event.payload.note || event.source_key)}</strong><small>${syncEscape(new Date(event.created_at).toLocaleString(currentUiLanguage === 'ar' ? 'ar-EG' : 'en-GB'))}</small>${event.reason ? `<p>${syncEscape(syncReason(event.reason))}</p>` : ''}</div><div class="sync-event-value"><span class="sync-badge ${tones[event.status] || 'sync-slate'}">${labels[event.status] || syncEscape(event.status)}</span><strong>${syncEscape(formatInvoiceMoney(amount))}</strong></div></div>${resolve}</article>`;
}

function syncReason(reason) {
  const arabic = {
    'Payment method is excluded or unmapped.': 'طريقة الدفع مستبعدة أو غير مرتبطة بحساب.',
    'Choose an expense payment method.': 'اختر طريقة الدفع لهذا المصروف.',
    'This transaction type is excluded.': 'هذا النوع من الحركات مستبعد.',
    'Connection authentication failed.': 'تعذر التحقق من الاتصال.',
    'Destination account, category, or event needs review.': 'يلزم مراجعة الحساب أو التصنيف أو الحركة.',
    'Destination unavailable; delivery will retry.': 'الوجهة غير متاحة؛ ستتم إعادة المحاولة.',
    'Delivery timed out; it is safe to retry.': 'انتهت مهلة الإرسال؛ يمكن إعادة المحاولة بأمان.',
    'Payment method assigned in a newer event.': 'تم تعيين طريقة الدفع في حدث أحدث.',
    'Payment was removed or corrected to zero.': 'تم حذف الدفعة أو تصحيحها إلى صفر.'
  };
  return currentUiLanguage === 'ar' ? arabic[reason] || reason : reason;
}

async function renderAdminFinanceSync() {
  if (!hasPageAccess('admin') || financeSyncLoading) return;
  const userId = currentSession?.user?.id;
  if (financeSyncUserId !== userId) resetFinanceSyncState();
  financeSyncUserId = userId;
  const panel = document.getElementById('admin-panel-finance-sync');
  if (!financeSyncSnapshot) panel.innerHTML = '<div class="sync-card sync-skeleton" role="status"><div></div><div></div><div></div></div>';
  financeSyncLoading = true;
  try {
    const { data, error } = await db.rpc('get_finance_sync_admin');
    if (currentSession?.user?.id !== userId || !hasPageAccess('admin')) return;
    if (error) throw error;
    financeSyncSnapshot = data;
    renderFinanceSyncSnapshot();
    if (!financeSyncPoll && adminActiveTab === 'finance-sync') financeSyncPoll = setInterval(() => {
      if (adminActiveTab !== 'finance-sync' || !hasPageAccess('admin')) return stopFinanceSyncPolling();
      if (document.visibilityState !== 'hidden') void renderAdminFinanceSync();
    }, 15000);
  } catch (error) {
    if (currentSession?.user?.id !== userId || !hasPageAccess('admin')) return;
    if (!financeSyncSnapshot) panel.innerHTML = `<div class="sync-card sync-empty"><span class="sync-icon"><i data-lucide="cloud-off"></i></span><h4>${syncText('Could not load finance sync', 'تعذر تحميل المزامنة المالية')}</h4><p>${syncEscape(error.message)}</p><button class="sync-button" type="button" onclick="renderAdminFinanceSync()">${syncText('Try again', 'حاول مجدداً')}</button></div>`;
    else panel.querySelector('#finance-sync-action-message').textContent = syncText('Could not refresh activity. Your changes are preserved.', 'تعذر تحديث النشاط. تم الاحتفاظ بتغييراتك.');
    if (window.lucide) lucide.createIcons();
  } finally { financeSyncLoading = false; }
}

async function saveFinanceSyncSettings(event) {
  event.preventDefault();
  if (!hasPageAccess('admin')) return;
  const draft = financeSyncDraft();
  const userId = currentSession?.user?.id;
  const button = event.target.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const { error } = await db.rpc('save_finance_sync_settings', {
      p_enabled: draft.enabled, p_sync_income: draft.sync_income, p_sync_expenses: draft.sync_expenses,
      p_routes: draft.payment_routes, p_income_category: draft.income_category, p_expense_categories: draft.expense_categories
    });
    if (error) throw error;
    if (currentSession?.user?.id !== userId || !hasPageAccess('admin')) return;
    financeSyncDirty = false;
    await renderAdminFinanceSync();
    const message = document.getElementById('finance-sync-save-message');
    if (message) message.textContent = syncText('Settings saved', 'تم حفظ الإعدادات');
  } catch (error) {
    const message = document.getElementById('finance-sync-save-message');
    if (message && currentSession?.user?.id === userId && hasPageAccess('admin')) message.textContent = error.message;
  } finally { button.disabled = false; }
}

async function retryFinanceSync(refreshCatalogue = false) {
  if (!hasPageAccess('admin')) return;
  const userId = currentSession?.user?.id;
  try {
    const { error } = await db.rpc('retry_finance_sync', { p_refresh_catalogue: refreshCatalogue });
    if (error) throw error;
    if (currentSession?.user?.id !== userId || !hasPageAccess('admin')) return;
    await renderAdminFinanceSync();
    const message = document.getElementById('finance-sync-action-message');
    if (message) message.textContent = syncText('Request queued. Activity will refresh automatically.', 'تمت إضافة الطلب إلى الانتظار. سيتم تحديث النشاط تلقائياً.');
  } catch (error) {
    const message = document.getElementById('finance-sync-action-message');
    if (message && currentSession?.user?.id === userId && hasPageAccess('admin')) message.textContent = error.message;
  }
}

function refreshFinanceSyncCatalogue() { return retryFinanceSync(true); }

async function assignExpenseSyncMethod(entryId, eventId) {
  if (!hasPageAccess('admin')) return;
  const userId = currentSession?.user?.id;
  const method = document.getElementById(`sync-resolve-${eventId}`)?.value;
  if (!method) return;
  try {
    const { error } = await db.rpc('assign_expense_sync_method', { p_entry_id: entryId, p_payment_method_id: method });
    if (error) throw error;
    if (currentSession?.user?.id !== userId || !hasPageAccess('admin')) return;
    await renderAdminFinanceSync();
  } catch (error) {
    const message = document.getElementById('finance-sync-action-message');
    if (message && currentSession?.user?.id === userId && hasPageAccess('admin')) message.textContent = error.message;
  }
}
