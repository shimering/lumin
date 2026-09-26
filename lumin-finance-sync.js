/* One-way finance integration controls. Database credentials never reach this script. */
let financeSyncSnapshot = null;
let financeSyncPoll = null;
let financeSyncLoading = false;
let financeSyncDirty = false;
let financeSyncUserId = null;
let financeSyncCategoryPicker = null;
const syncText = (en, ar) => currentUiLanguage === 'ar' ? ar : en;
const syncEscape = value => escapeHtml(String(value ?? ''));

function stopFinanceSyncPolling() {
  closeFinanceSyncCategoryPicker(false);
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

function financeSyncCategoryChoices(kind, categories = financeSyncSnapshot?.settings.categories || []) {
  const items = categories.filter(item => item.kind === kind);
  const byKey = new Map(items.map(item => [item.key, item]));
  const name = item => currentUiLanguage === 'ar' ? item.name_ar || item.name : item.name;
  const choices = items.map(item => {
    const chain = [item];
    const visited = new Set([item.key]);
    let parent = byKey.get(item.parent_key);
    while (parent && !visited.has(parent.key)) {
      chain.unshift(parent);
      visited.add(parent.key);
      parent = byKey.get(parent.parent_key);
    }
    const parentName = item.parent_key ? (byKey.has(item.parent_key) ? name(byKey.get(item.parent_key)) : currentUiLanguage === 'ar' ? item.parent_name_ar || item.parent_name : item.parent_name) : '';
    const names = chain.map(name);
    if (chain.length === 1 && parentName) names.unshift(parentName);
    return { ...item, label: name(item), path: names.join(' › '), parentName, depth: Math.max(chain.length - 1, item.parent_key ? 1 : 0), group: names[0], groupKey: chain.length === 1 && item.parent_key ? item.parent_key : chain[0].key };
  });
  return choices.sort((a, b) => a.group.localeCompare(b.group, currentUiLanguage) || a.groupKey.localeCompare(b.groupKey) || a.depth - b.depth || a.path.localeCompare(b.path, currentUiLanguage));
}

function financeSyncCategoryField(id, title, kind, selected, placeholder, attribute) {
  const choices = financeSyncCategoryChoices(kind);
  const choice = choices.find(item => item.key === selected);
  const label = choice?.path || (selected ? syncText('Unavailable category', 'تصنيف غير متاح') : placeholder);
  const caption = choice?.depth ? syncText(`Subcategory of ${choice.parentName}`, `تصنيف فرعي من ${choice.parentName}`) : choice ? syncText('Main category', 'تصنيف رئيسي') : selected ? syncText('Choose another category', 'اختر تصنيفاً آخر') : syncText('Choose from Baytna', 'اختر من بيتنا');
  return `<div class="sync-field"><span id="${id}-label">${syncEscape(title)}</span><select hidden id="${id}" ${attribute} tabindex="-1" aria-hidden="true"><option value="">${syncEscape(placeholder)}</option>${selected && !choice ? `<option value="${syncEscape(selected)}" selected>${syncEscape(label)}</option>` : ''}${choices.map(item => `<option value="${syncEscape(item.key)}" ${item.key === selected ? 'selected' : ''}>${syncEscape(item.path)}</option>`).join('')}</select><button id="${id}-trigger" type="button" class="sync-category-trigger" data-category-select="${id}" data-category-kind="${kind}" data-category-placeholder="${syncEscape(placeholder)}" aria-labelledby="${id}-label ${id}-value" aria-haspopup="dialog" aria-expanded="false" onclick="openFinanceSyncCategoryPicker(this)"><span class="sync-category-icon"><i data-lucide="${choice?.depth ? 'corner-down-right' : 'folder'}"></i></span><span class="sync-category-selection"><strong id="${id}-value">${syncEscape(label)}</strong><small>${syncEscape(caption)}</small></span><i data-lucide="chevrons-up-down"></i></button></div>`;
}

function closeFinanceSyncCategoryPicker(restoreFocus = true) {
  const state = financeSyncCategoryPicker;
  if (!state) return;
  financeSyncCategoryPicker = null;
  window.removeEventListener('resize', positionFinanceSyncCategoryPicker);
  window.removeEventListener('scroll', positionFinanceSyncCategoryPicker, true);
  state.dialog.close();
  state.dialog.remove();
  const trigger = document.getElementById(`${state.id}-trigger`);
  trigger?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) trigger?.focus();
}

function positionFinanceSyncCategoryPicker() {
  if (!financeSyncCategoryPicker) return;
  const { dialog, id } = financeSyncCategoryPicker;
  if (window.innerWidth < 640) {
    dialog.style.removeProperty('left'); dialog.style.removeProperty('top');
    dialog.style.removeProperty('width'); dialog.style.removeProperty('max-height');
    return;
  }
  const trigger = document.getElementById(`${id}-trigger`);
  if (!trigger) return closeFinanceSyncCategoryPicker(false);
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(Math.max(rect.width, 360), 440, window.innerWidth - 32);
  const height = Math.min(540, window.innerHeight - 32);
  dialog.style.width = `${width}px`;
  dialog.style.maxHeight = `${height}px`;
  dialog.style.left = `${Math.max(16, Math.min(currentUiLanguage === 'ar' ? rect.right - width : rect.left, window.innerWidth - width - 16))}px`;
  const desiredHeight = Math.min(dialog.scrollHeight || height, height);
  dialog.style.top = `${Math.max(16, Math.min(rect.bottom + 8, window.innerHeight - desiredHeight - 16))}px`;
}

function openFinanceSyncCategoryPicker(trigger) {
  closeFinanceSyncCategoryPicker(false);
  const id = trigger.dataset.categorySelect;
  const dialog = document.createElement('dialog');
  dialog.id = 'finance-sync-category-picker';
  dialog.className = 'sync-category-dialog';
  dialog.dir = currentUiLanguage === 'ar' ? 'rtl' : 'ltr';
  dialog.lang = currentUiLanguage;
  dialog.setAttribute('aria-labelledby', 'sync-category-picker-title');
  dialog.innerHTML = `<header class="sync-category-header"><div><p>${syncText('BAYTNA CATEGORIES', 'تصنيفات بيتنا')}</p><h4 id="sync-category-picker-title">${syncEscape(document.getElementById(`${id}-label`).textContent)}</h4></div><button class="sync-button sync-category-close" type="button" aria-label="${syncText('Close category selector', 'إغلاق اختيار التصنيف')}" onclick="closeFinanceSyncCategoryPicker()"><i data-lucide="x"></i></button></header><label class="sync-category-search"><i data-lucide="search"></i><input id="sync-category-search" type="search" autocomplete="off" placeholder="${syncText('Search categories and subcategories…', 'ابحث عن تصنيف أو تصنيف فرعي…')}" aria-label="${syncText('Search categories and subcategories', 'البحث في التصنيفات والتصنيفات الفرعية')}" oninput="renderFinanceSyncCategoryResults()" /></label><div class="sync-category-results" id="sync-category-results"></div><footer>${syncText('Updates automatically from Baytna.', 'يتم تحديثها تلقائياً من بيتنا.')}</footer>`;
  document.body.append(dialog);
  financeSyncCategoryPicker = { id, dialog, kind: trigger.dataset.categoryKind, placeholder: trigger.dataset.categoryPlaceholder, signature: '' };
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeFinanceSyncCategoryPicker(); });
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) closeFinanceSyncCategoryPicker();
  });
  dialog.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...dialog.querySelectorAll('[data-category-key]')];
    const index = buttons.indexOf(document.activeElement);
    if (document.activeElement?.id === 'sync-category-search' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  });
  renderFinanceSyncCategoryResults();
  dialog.showModal();
  trigger.setAttribute('aria-expanded', 'true');
  positionFinanceSyncCategoryPicker();
  window.addEventListener('resize', positionFinanceSyncCategoryPicker);
  window.addEventListener('scroll', positionFinanceSyncCategoryPicker, true);
  document.getElementById('sync-category-search').focus();
  if (window.lucide) lucide.createIcons();
}

function renderFinanceSyncCategoryResults() {
  const state = financeSyncCategoryPicker;
  if (!state) return;
  const query = document.getElementById('sync-category-search').value.trim().toLocaleLowerCase(currentUiLanguage);
  const choices = financeSyncCategoryChoices(state.kind);
  state.signature = JSON.stringify(choices);
  const selected = document.getElementById(state.id)?.value || '';
  const focusedKey = document.activeElement?.dataset.categoryKey;
  const matches = choices.filter(item => item.path.toLocaleLowerCase(currentUiLanguage).includes(query));
  const option = (key, label, detail, depth) => `<button type="button" class="sync-category-option ${depth ? 'sync-category-child' : ''}" data-category-key="${syncEscape(key)}" aria-pressed="${selected === key}" onclick="selectFinanceSyncCategory(this.dataset.categoryKey)"><span class="sync-category-icon"><i data-lucide="${depth ? 'corner-down-right' : key ? 'folder' : 'circle-slash'}"></i></span><span class="sync-category-selection"><strong>${syncEscape(label)}</strong><small>${syncEscape(detail)}</small></span>${selected === key ? '<i data-lucide="check" class="sync-category-check"></i>' : ''}</button>`;
  const groups = [...new Set(matches.map(item => item.groupKey))];
  document.getElementById('sync-category-results').innerHTML = (!query ? option('', state.placeholder, syncText('No category selected', 'بدون تصنيف محدد'), 0) : '') + groups.map(groupKey => `<section class="sync-category-group"><h5>${syncEscape(matches.find(item => item.groupKey === groupKey).group)}</h5>${matches.filter(item => item.groupKey === groupKey).map(item => option(item.key, item.label, item.depth ? syncText(`Subcategory · ${item.parentName}`, `تصنيف فرعي · ${item.parentName}`) : syncText('Main category', 'تصنيف رئيسي'), item.depth)).join('')}</section>`).join('') + (!matches.length ? `<div class="sync-category-empty"><i data-lucide="search-x"></i><strong>${syncText('No matching categories', 'لا توجد تصنيفات مطابقة')}</strong><span>${syncText('Try a different name.', 'جرّب اسماً آخر.')}</span></div>` : '');
  if (focusedKey !== undefined) ([...state.dialog.querySelectorAll('[data-category-key]')].find(button => button.dataset.categoryKey === focusedKey) || document.getElementById('sync-category-search')).focus();
  positionFinanceSyncCategoryPicker();
  if (window.lucide) lucide.createIcons();
}

function selectFinanceSyncCategory(key) {
  const state = financeSyncCategoryPicker;
  const select = state && document.getElementById(state.id);
  if (!select) return;
  select.value = key;
  financeSyncDirty = true;
  closeFinanceSyncCategoryPicker(false);
  renderFinanceSyncSnapshot();
  document.getElementById(`${state.id}-trigger`)?.focus();
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
      <div class="sync-section-heading"><div><h4>${syncText('Baytna categories', 'تصنيفات بيتنا')}</h4><p>${syncText('Categories and subcategories update automatically, usually within a minute.', 'يتم تحديث التصنيفات والتصنيفات الفرعية تلقائياً، عادة خلال دقيقة.')}</p><p class="sync-catalogue-time">${syncText('Last checked:', 'آخر تحديث:')} ${settings.catalogue_refreshed_at ? syncEscape(new Date(settings.catalogue_refreshed_at).toLocaleString(currentUiLanguage === 'ar' ? 'ar-EG' : 'en-GB')) : syncText('Waiting for Baytna', 'في انتظار بيتنا')}</p></div><button class="sync-button" type="button" onclick="refreshFinanceSyncCatalogue()"><i data-lucide="refresh-cw"></i>${syncText('Refresh categories', 'تحديث التصنيفات')}</button></div>
      <div class="sync-mapping-grid">${financeSyncCategoryField('sync-income-category', syncText('Patient income', 'دخل المرضى'), 'income', settings.income_category, syncText('Uncategorized', 'بدون تصنيف'), 'name="income_category"')}${financeSyncCategoryField('sync-default-category', syncText('Default expense category', 'تصنيف المصروفات الافتراضي'), 'expense', settings.expense_categories.default, syncText('Uncategorized', 'بدون تصنيف'), 'data-sync-category="default"')}${data.expense_types.map(type => financeSyncCategoryField(`sync-type-${type.id}`, type.name, 'expense', settings.expense_categories[type.id], syncText('Use default expense category', 'استخدام التصنيف الافتراضي'), `data-sync-category="${syncEscape(type.id)}"`)).join('')}</div>
      <p class="sync-hint">${syncText('Mapping changes apply to subsequent activity. Previously posted entries are not moved automatically.', 'تغييرات الربط تنطبق على الحركات التالية. لا يتم نقل القيود السابقة تلقائياً.')}</p>
      <div class="sync-actions"><span id="finance-sync-save-message" role="status">${financeSyncDirty ? syncText('Unsaved changes', 'تغييرات غير محفوظة') : ''}</span><button class="sync-button sync-primary" type="submit" ${!data.connected ? 'disabled' : ''}><i data-lucide="save"></i>${syncText('Save settings', 'حفظ الإعدادات')}</button></div>
    </form>
    <section class="sync-card"><div class="sync-section-heading"><div><h4>${syncText('Delivery activity', 'نشاط الإرسال')}</h4><p>${syncText('Last successful delivery:', 'آخر إرسال ناجح:')} ${syncEscape(time)}</p></div><div class="sync-actions"><button class="sync-button" type="button" onclick="refreshFinanceSyncCatalogue()"><i data-lucide="refresh-cw"></i>${syncText('Refresh accounts', 'تحديث الحسابات')}</button><button class="sync-button" type="button" onclick="retryFinanceSync()" ${!counts.failed ? 'disabled' : ''}><i data-lucide="rotate-ccw"></i>${syncText('Retry failed', 'إعادة المحاولة')}</button></div></div><p id="finance-sync-action-message" role="status">${data.catalogue_error ? syncEscape(syncReason(data.catalogue_error)) : ''}</p><p class="sync-hint">${syncText('Counts show delivery events, including corrections. Delivery usually takes about one minute; queued items remain safe if Baytna is unavailable.', 'تعرض الأعداد أحداث الإرسال بما فيها التصحيحات. يستغرق الإرسال عادة نحو دقيقة؛ تبقى الحركات محفوظة إذا تعذر الاتصال ببيتنا.')}</p>
      <div class="sync-feed">${data.events.length ? data.events.map(event => financeSyncEventHtml(event, data.methods)).join('') : `<div class="sync-empty"><span class="sync-icon"><i data-lucide="inbox"></i></span><h4>${syncText('Ready for new activity', 'جاهزة للحركات الجديدة')}</h4><p>${syncText('New patient and expense payments will appear here.', 'ستظهر مدفوعات المرضى والمصروفات الجديدة هنا.')}</p><button class="sync-button" type="button" onclick="renderAdminFinanceSync()">${syncText('Refresh activity', 'تحديث النشاط')}</button></div>`}</div>
    </section>
    <div class="sync-card sync-history"><span class="sync-icon"><i data-lucide="history"></i></span><div><h4>${syncText('Existing history stays separate', 'السجل السابق منفصل')}</h4><p>${syncText('Only activity recorded after this connection was created is tracked. Historical import will be a separate action, so existing balances are not counted twice.', 'يتم تتبع الحركات المسجلة بعد إنشاء الاتصال فقط. استيراد السجل السابق سيكون إجراءً منفصلاً لتجنب احتساب الأرصدة مرتين.')}</p></div></div>`;
  if (window.lucide) lucide.createIcons();
  if (financeSyncCategoryPicker) {
    document.getElementById(`${financeSyncCategoryPicker.id}-trigger`)?.setAttribute('aria-expanded', 'true');
    if (JSON.stringify(financeSyncCategoryChoices(financeSyncCategoryPicker.kind)) !== financeSyncCategoryPicker.signature) renderFinanceSyncCategoryResults();
    positionFinanceSyncCategoryPicker();
  }
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
