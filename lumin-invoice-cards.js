(function () {
  'use strict';

  let invoices = new Map();
  let active = null;
  const ar = () => currentUiLanguage === 'ar' || document.documentElement.dir === 'rtl';
  const text = (en, arabic) => ar() ? arabic : en;
  const esc = value => escapeHtml(String(value ?? ''));
  const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const icons = () => { if (window.lucide) lucide.createIcons(); };
  const subtotal = invoice => invoice.items.reduce((sum, item) => sum + invoiceItemTotal(item), 0);
  const sessionId = () => currentSession?.user?.id;
  const fingerprint = invoice => JSON.stringify([invoice.updatedAt, invoice.status, subtotal(invoice), invoice.manualDiscount,
    invoice.manualDiscountType, invoice.manualDiscountValue, invoice.loyaltyDiscount, invoice.paidAmount,
    invoice.releases.map(release => [release.id, release.amount])]);
  const canDiscount = invoice => hasPageAccess('patients') && invoice.items.length > 0 && invoice.status !== 'cancelled';
  const allowed = (kind, invoice) => kind === 'discount' || kind === 'remove-discount' ? canDiscount(invoice)
    : invoice.status !== 'cancelled' && (kind === 'undo-release' ? canUndoInvoiceRelease() : canReleaseInvoice());

  function button(action, label, name, extra = '') {
    return `<button type="button" class="invoice-card-button" data-invoice-action="${action}" ${extra}>${icon(name)}<span>${label}</span></button>`;
  }

  function itemMarkup(item, invoice) {
    const status = operationStatusDefinition(item.operationStatus);
    const isMouth = dentalOperationByCode(item.operationCode)?.actionScope === 'mouth';
    const slot = Number(SLOT_BY_PRIMARY_TOOTH[String(item.toothId || '').toUpperCase()] || item.toothId);
    const quadrant = palmerQuadrantForSlot(slot);
    const dentition = isMouth ? text('Whole mouth', 'كامل الفم') : !item.toothId ? text('No tooth', 'بدون سن')
      : isPrimaryToothId(item.toothId) ? text('Deciduous tooth', 'سن لبني') : text('Permanent tooth', 'سن دائم');
    const surfaceLabels = item.surfaces.map(surface => CHART_SURFACES.includes(surface) ? surfaceAbbreviation(item.toothId, surface) : surface);
    const surfaces = isMouth ? '' : surfaceLabels.length ? surfaceLabels.join(', ') : text('Whole tooth', 'السن بالكامل');
    const tooth = isMouth ? icon('scan') : item.toothId ? palmerNotationSVG(item.toothId, slot, 'h-7 w-10') : icon('minus');
    const paid = invoiceItemPaidAmount(invoice, item.id);
    const remaining = invoiceItemRemaining(invoice, item);
    const canDelete = hasPageAccess('patients') && paid <= 0 && invoice.releasedAmount <= 0 && invoice.loyaltyDiscount <= 0;
    const deleteHint = invoice.loyaltyDiscount > 0 ? text('Reverse the loyalty discount first.', 'اعكس خصم الولاء أولًا.')
      : invoice.releasedAmount > 0 ? text('Undo released amounts first.', 'تراجع عن الإعفاء أولًا.')
      : paid > 0 ? text('Remove procedure payments first.', 'احذف دفعات الإجراء أولًا.') : '';
    const linked = invoice.payments.some(payment => payment.allocations?.some(allocation => Number(allocation.invoiceItemId) === Number(item.id) && allocation.amount > 0));
    const actions = (remaining > 0 && invoiceRemaining(invoice) > 0 && canRecordInvoicePayment()
      ? button('pay-item', text('Pay procedure', 'دفع الإجراء'), 'wallet-cards', `data-item-id="${Number(item.id)}"`) : '')
      + (linked && hasPageAccess('patients') ? button('payments', text('View linked payments', 'عرض الدفعات المرتبطة'), 'receipt-text', `data-item-id="${Number(item.id)}"`) : '')
      + (hasPageAccess('patients') ? button('date', text('Edit invoice date', 'تعديل تاريخ الفاتورة'), 'calendar-days')
        + button('delete-item', text('Remove treatment', 'إزالة العلاج'), 'trash-2', `data-item-id="${Number(item.id)}" ${canDelete ? '' : 'disabled'} aria-label="${esc(text('Remove treatment', 'إزالة العلاج') + (deleteHint ? ': ' + deleteHint : ''))}"`) : '');
    return `<article class="invoice-treatment" data-invoice-procedure="${Number(item.id)}">
      <span class="invoice-tooth" aria-label="${esc(isMouth ? dentition : chartToothLabel(item.toothId))}">${tooth}</span>
      <div class="invoice-treatment-copy"><div class="invoice-treatment-title"><h5>${esc(item.operationName)}</h5><span class="invoice-item-status invoice-tone-${status.key === 'C' ? 'green' : status.key === 'In' ? 'blue' : 'amber'}">${esc(ar() ? ({C:'مكتمل',In:'قيد التنفيذ',P:'مخطط'}[status.key] || status.label) : status.label)}</span></div>
        <p>${esc([dentition, quadrant.abbreviation, surfaces, item.doctorName].filter(Boolean).join(' · '))}</p>
        <div class="invoice-treatment-notes"><span>${icon('calendar-days')}${esc(formatInvoiceDate(invoice.invoiceDate))}</span>${invoiceDoctorSalaryActionMarkup(item)}</div></div>
      <div class="invoice-treatment-price"><strong>${esc(formatInvoiceMoney(invoiceItemTotal(item)))}</strong><span>${esc(text('Qty ', 'الكمية ') + item.quantity)}</span></div>
      ${actions ? `<details class="invoice-card-menu invoice-item-menu"><summary aria-label="${esc(text('Treatment options', 'خيارات العلاج'))}">${icon('ellipsis-vertical')}</summary><div class="invoice-card-menu-list">${actions}</div></details>` : ''}</article>`;
  }

  function adjustmentMarkup(invoice, kind) {
    const discount = kind === 'discount';
    const amount = discount ? invoice.manualDiscount : invoice.releasedAmount;
    const editable = discount ? canDiscount(invoice) : canReleaseInvoice() || canUndoInvoiceRelease();
    const undo = amount > 0 && (discount ? canDiscount(invoice) : invoice.releases.length > 0 && canUndoInvoiceRelease());
    const label = discount ? text('Discount', 'الخصم') : text('Released', 'المبلغ المُعفى');
    const undoLabel = discount ? text('Remove discount', 'إزالة الخصم') : text('Undo latest release', 'التراجع عن آخر إعفاء');
    return `<div class="invoice-adjustment ${discount ? 'is-discount' : 'is-release'}">
      <button type="button" class="invoice-adjustment-toggle" data-invoice-action="${kind}" aria-expanded="false" aria-controls="invoice-drawer-${Number(invoice.id)}" ${editable ? '' : 'disabled'}>
        <span class="invoice-adjustment-icon">${icon(discount ? 'badge-percent' : 'circle-minus')}</span><span class="invoice-adjustment-copy"><span>${label}</span><strong>${esc(formatInvoiceMoney(amount))}</strong></span>${icon('chevron-down')}</button>
      ${undo ? `<button type="button" class="invoice-adjustment-undo" data-invoice-action="${discount ? 'remove-discount' : 'undo-release'}" aria-label="${undoLabel}" title="${undoLabel}">${icon('undo-2')}<span>${text('Undo', 'تراجع')}</span></button>` : ''}</div>`;
  }

  function markup(invoice) {
    invoices.set(Number(invoice.id), invoice);
    const status = invoiceDisplayStatus(invoice);
    const remaining = invoiceRemaining(invoice);
    const cancelled = invoice.status === 'cancelled';
    const paid = !cancelled && remaining <= 0;
    const menu = hasPageAccess('patients') ? `<details class="invoice-card-menu"><summary aria-label="${text('Invoice options', 'خيارات الفاتورة')}">${icon('ellipsis')}</summary><div class="invoice-card-menu-list">
      ${button('date',text('Edit invoice date','تعديل تاريخ الفاتورة'),'calendar-days')}
      ${button('delete',text('Delete invoice','حذف الفاتورة'),'trash-2', invoice.payments.length || invoice.releases.length || invoice.loyaltyDiscount > 0 ? 'disabled' : '')}</div></details>` : '';
    const translatedStatus = {'Cancelled':'ملغاة','Settled with loyalty':'تمت التسوية بالولاء','Discounted':'تمت التسوية بالخصم','Paid + released':'مدفوعة مع إعفاء','Released':'تم الإعفاء','Partially settled':'تسوية جزئية','Paid':'مدفوعة','Partially paid':'مدفوعة جزئيًا','Unpaid':'غير مدفوعة'};
    return `<article class="invoice-card" data-refresh-key="${Number(invoice.id)}" data-invoice-card="${Number(invoice.id)}">
      <header class="invoice-card-header"><div class="invoice-card-reference"><strong dir="ltr">${esc(invoiceNumber(invoice.id))}</strong><span>${esc(formatInvoiceDate(invoice.invoiceDate))}</span></div><span class="invoice-card-status invoice-tone-${cancelled ? 'slate' : paid ? 'green' : invoice.paidAmount > 0 ? 'blue' : 'amber'}">${esc(ar() ? translatedStatus[status.label] || status.label : status.label)}</span>${menu}</header>
      <div class="invoice-card-balance"><div><span class="invoice-card-label">${text('Remaining balance','المبلغ المتبقي')}</span><strong class="invoice-card-amount" data-invoice-balance dir="ltr">${esc(formatInvoiceMoney(remaining))}</strong><p>${text('Invoice','الفاتورة')} <b>${esc(formatInvoiceMoney(invoiceTotal(invoice)))}</b><span>·</span>${text('Paid','المدفوع')} <b>${esc(formatInvoiceMoney(invoice.paidAmount))}</b></p></div>
        ${remaining > 0 && !cancelled && canRecordInvoicePayment() ? `<button type="button" class="invoice-card-button invoice-card-pay" data-invoice-action="pay">${icon('wallet-cards')}${text('Record payment','تسجيل دفعة')}</button>` : ''}</div>
      <button type="button" class="invoice-adjustments-disclosure" data-invoice-action="adjustments" aria-expanded="false" aria-controls="invoice-adjustments-${Number(invoice.id)}"><span class="invoice-adjustments-disclosure-label">${icon('sliders-horizontal')}<span>${text('Discount & release','الخصم والإعفاء')}</span></span><span class="invoice-adjustments-summary">${esc([invoice.manualDiscount > 0 ? text('Discount ','خصم ') + formatInvoiceMoney(invoice.manualDiscount) : '', invoice.releasedAmount > 0 ? text('Released ','إعفاء ') + formatInvoiceMoney(invoice.releasedAmount) : ''].filter(Boolean).join(' · '))}</span>${icon('chevron-down')}</button>
      <div class="invoice-adjustments-drawer" id="invoice-adjustments-${Number(invoice.id)}" aria-hidden="true" inert><div class="invoice-adjustments-clip">
        <div class="invoice-card-adjustments">${adjustmentMarkup(invoice,'discount')}${adjustmentMarkup(invoice,'release')}</div>
        <div class="invoice-inline-drawer" id="invoice-drawer-${Number(invoice.id)}" aria-hidden="true" inert><div class="invoice-inline-clip"><section class="invoice-drawer-panel" role="region" aria-labelledby="invoice-drawer-title-${Number(invoice.id)}"></section></div></div>
      </div></div>
      ${invoice.loyaltyDiscount > 0 ? `<div class="invoice-card-loyalty">${icon('sparkles')}${text('Loyalty discount','خصم الولاء')} ${esc(formatInvoiceMoney(invoice.loyaltyDiscount))}</div>` : ''}
      <div class="invoice-treatment-list">${invoice.items.length ? invoice.items.map(item => itemMarkup(item,invoice)).join('') : `<div class="invoice-card-empty">${icon('receipt-text')}<strong>${text('No treatments yet','لا توجد علاجات بعد')}</strong><span>${text('Add a priced treatment from the dental chart.','أضف علاجًا بسعر من مخطط الأسنان.')}</span></div>`}</div></article>`;
  }

  function setAdjustmentsOpen(card, expanded) {
    const drawer = card.querySelector('.invoice-adjustments-drawer');
    card.querySelector('.invoice-adjustments-disclosure').setAttribute('aria-expanded',String(expanded));
    drawer.classList.toggle('is-open',expanded);
    drawer.inert = !expanded;
    drawer.setAttribute('aria-hidden',String(!expanded));
  }

  function close(force = false) {
    if (!active || active.saving && !force) return;
    const previous = active;
    active = null;
    previous.card.querySelector('.invoice-inline-drawer')?.classList.remove('is-open');
    const drawer = previous.card.querySelector('.invoice-inline-drawer');
    if (drawer) { drawer.inert = true; drawer.setAttribute('aria-hidden','true'); }
    previous.card.querySelectorAll('.invoice-adjustment-toggle').forEach(el => el.setAttribute('aria-expanded','false'));
    if (previous.trigger?.isConnected) previous.trigger.focus({preventScroll:true});
  }

  function heading(entry) {
    const titles = {discount:text('Invoice discount','خصم الفاتورة'),release:text('Release balance','إعفاء من الرصيد'),
      'remove-discount':text('Remove discount?','إزالة الخصم؟'),'undo-release':text('Undo latest release?','التراجع عن آخر إعفاء؟')};
    return `<div class="invoice-drawer-heading"><h4 id="invoice-drawer-title-${entry.id}">${titles[entry.kind]}</h4><button type="button" class="invoice-card-icon-button" data-invoice-action="close" aria-label="${text('Close drawer','إغلاق اللوحة')}">${icon('x')}</button></div>`;
  }

  function projection(entry) {
    const invoice = entry.invoice;
    const maximum = Math.max(0, subtotal(invoice) - invoice.loyaltyDiscount - invoice.paidAmount - invoice.releasedAmount);
    const value = Number(entry.value);
    const discount = entry.type === 'percent' ? Math.round(subtotal(invoice) * value) / 100 : Math.round(value * 100) / 100;
    const valid = entry.value !== '' && Number.isFinite(value) && value >= 0 && (entry.type !== 'percent' || value <= 100) && discount <= maximum + .001;
    const next = entry.kind === 'discount' ? maximum - discount : entry.kind === 'remove-discount' ? invoiceRemaining(invoice) + invoice.manualDiscount
      : entry.kind === 'undo-release' ? invoiceRemaining(invoice) + (invoice.releases[0]?.amount || 0) : 0;
    return {valid,discount,maximum,next:Math.max(0,next)};
  }

  function updatePreview(entry) {
    const result = projection(entry);
    const panel = entry.card.querySelector('.invoice-drawer-panel');
    panel.querySelector('[data-invoice-projection]').textContent = result.valid || entry.kind !== 'discount' ? formatInvoiceMoney(result.next) : '—';
    const input = panel.querySelector('[data-invoice-value]');
    if (input) {
      input.max = entry.type === 'percent' ? String(subtotal(entry.invoice) > 0 ? Math.min(100,result.maximum / subtotal(entry.invoice) * 100) : 100) : String(result.maximum);
      input.setAttribute('aria-invalid',String(!result.valid));
    }
    panel.querySelector('[type="submit"]').disabled = entry.saving || entry.kind === 'discount' && !result.valid
      || entry.kind === 'release' && invoiceRemaining(entry.invoice) <= 0
      || entry.kind === 'remove-discount' && entry.invoice.manualDiscount <= 0
      || entry.kind === 'undo-release' && !entry.invoice.releases.length;
    const validation = panel.querySelector('[data-invoice-validation]');
    validation.hidden = entry.kind !== 'discount' || result.valid;
    validation.textContent = text('Enter a discount within the unpaid balance.','أدخل خصمًا لا يتجاوز الرصيد غير المدفوع.');
    return result;
  }

  function renderPanel(entry, message = '') {
    const panel = entry.card.querySelector('.invoice-drawer-panel');
    const invoice = entry.invoice;
    const latest = invoice.releases[0];
    const release = entry.kind === 'release';
    const discount = entry.kind === 'discount';
    const amount = release ? invoiceRemaining(invoice) : entry.kind === 'remove-discount' ? invoice.manualDiscount : latest?.amount || 0;
    const description = discount ? text('Doctor salary remains based on the full procedure price.','يظل راتب الطبيب محسوبًا على سعر الإجراء الكامل.')
      : release ? text('Release the full remaining balance without recording payment or clinic income.','إعفاء الرصيد المتبقي بالكامل دون تسجيل دفعة أو دخل للعيادة.')
      : entry.kind === 'remove-discount' ? text('This discount will be removed. Released amounts and payments stay as recorded.','سيُحذف هذا الخصم مع الإبقاء على مبالغ الإعفاء والدفعات المسجلة.')
      : text('The latest released amount returns to the balance. Discounts and payments stay as recorded.','سيعود مبلغ آخر إعفاء إلى الرصيد مع الإبقاء على الخصومات والدفعات المسجلة.');
    const confirmLabel = discount ? text('Save discount','حفظ الخصم') : release ? text('Release balance','إعفاء الرصيد')
      : entry.kind === 'remove-discount' ? text('Remove discount','إزالة الخصم') : text('Undo release','التراجع عن الإعفاء');
    panel.innerHTML = `${heading(entry)}<p class="invoice-drawer-description">${description}</p>
      <form data-invoice-form><fieldset ${entry.saving ? 'disabled' : ''}>
        ${discount ? `<div class="invoice-discount-fields"><label>${text('Discount type','نوع الخصم')}<select data-invoice-type><option value="amount" ${entry.type === 'amount' ? 'selected' : ''}>${text('Fixed amount (EGP)','مبلغ ثابت (ج.م)')}</option><option value="percent" ${entry.type === 'percent' ? 'selected' : ''}>${text('Percentage (%)','نسبة مئوية (%)')}</option></select></label><label>${text('Discount value','قيمة الخصم')}<span class="invoice-value-field"><input type="number" inputmode="decimal" min="0" step="0.01" value="${esc(entry.value)}" data-invoice-value required aria-describedby="invoice-validation-${entry.id}"><span>${entry.type === 'percent' ? '%' : 'EGP'}</span></span></label></div>`
          : `<div class="invoice-release-amount"><span>${release ? text('Release amount','مبلغ الإعفاء') : text('Amount restored','المبلغ المستعاد')}</span><strong dir="ltr">${esc(formatInvoiceMoney(amount))}</strong></div>`}
        ${release && invoice.releases.length ? `<div class="invoice-release-history"><span>${text('Previously released','مبالغ الإعفاء السابقة')}</span>${invoice.releases.map(record => `<div><span>${esc(formatInvoiceDate(record.releaseDate || String(record.createdAt || '').slice(0,10)))}</span><strong>${esc(formatInvoiceMoney(record.amount))}</strong></div>`).join('')}</div>` : ''}
        <div class="invoice-drawer-projection" aria-live="polite"><span>${text('Remaining after adjustment','المتبقي بعد التعديل')}</span><strong data-invoice-projection dir="ltr"></strong></div>
        <p class="invoice-drawer-error" data-invoice-validation id="invoice-validation-${entry.id}" role="alert" hidden></p><p class="invoice-drawer-error" data-invoice-error role="alert" ${message ? '' : 'hidden'}>${esc(message)}</p>
        <footer class="invoice-drawer-footer"><button type="button" class="invoice-card-button" data-invoice-action="close">${text('Cancel','إلغاء')}</button><button type="submit" class="invoice-card-button invoice-card-confirm">${icon(entry.saving ? 'loader-circle' : discount ? 'check' : release ? 'circle-minus' : 'undo-2')}<span>${entry.saving ? text('Saving…','جارٍ الحفظ…') : confirmLabel}</span></button></footer>
      </fieldset></form>`;
    updatePreview(entry);
    icons();
  }

  async function readInvoice(id) {
    const {data,error} = await db.from('patient_invoices').select(INVOICE_SELECT_FIELDS).eq('id',id).single();
    if (error) throw error;
    return normaliseInvoiceRecord(data);
  }

  async function open(card, kind, trigger) {
    const id = Number(card.dataset.invoiceCard);
    const invoice = invoices.get(id);
    if (active?.saving || !invoice || !allowed(kind,invoice)) return;
    if (active?.id === id && active.kind === kind) { close(); return; }
    close();
    setAdjustmentsOpen(card,true);
    const entry = {id,kind,card,trigger,invoice,session:sessionId(),type:invoice.manualDiscountType || 'amount',value:String(invoice.manualDiscountValue || 0),saving:false,loading:true};
    active = entry;
    const drawer = card.querySelector('.invoice-inline-drawer');
    drawer.inert = false;
    drawer.setAttribute('aria-hidden','false');
    drawer.classList.add('is-open');
    card.querySelectorAll('.invoice-adjustment-toggle').forEach(el => el.setAttribute('aria-expanded',String(el.dataset.invoiceAction === (kind.includes('discount') ? 'discount' : 'release'))));
    const panel = card.querySelector('.invoice-drawer-panel');
    panel.innerHTML = `${heading(entry)}<div class="invoice-drawer-loading" role="status" aria-label="${text('Loading invoice','جارٍ تحميل الفاتورة')}"><span></span><span></span></div>`;
    icons();
    panel.querySelector('button').focus({preventScroll:true});
    try {
      const fresh = await readInvoice(id);
      if (active !== entry || !card.isConnected || entry.session !== sessionId()) return;
      if (!allowed(kind,fresh)) throw new Error(text('This adjustment is no longer available.','هذا التعديل لم يعد متاحًا.'));
      entry.invoice = fresh;
      entry.type = fresh.manualDiscountType || 'amount';
      entry.value = String(fresh.manualDiscountValue || 0);
      entry.loading = false;
      renderPanel(entry);
      panel.querySelector('[data-invoice-value], .invoice-card-icon-button')?.focus({preventScroll:true});
    } catch (error) {
      if (active !== entry || !card.isConnected) return;
      entry.loading = false;
      panel.innerHTML = `${heading(entry)}<p class="invoice-drawer-error" role="alert">${esc(error.message || text('Could not load invoice. Close the drawer and try again.','تعذر تحميل الفاتورة. أغلق اللوحة وحاول مجددًا.'))}</p>`;
      icons();
    }
  }

  async function refreshViews(invoice) {
    invalidateLoyaltyInvoiceViews();
    const dashboard = document.getElementById('view-dashboard');
    const finances = document.getElementById('view-finances');
    if (dashboard && !dashboard.classList.contains('hidden')) renderDashboard();
    if (activeInvoicePatientId === invoice.patientId) await renderPatientInvoices();
    if (activePatientId === invoice.patientId && hasPageAccess('chart')) await refreshChartFindingInvoiceState(invoice.patientId);
    if (hasPageAccess('finances') && finances && !finances.classList.contains('hidden')) await refreshActiveFinanceTab();
  }

  async function save(entry) {
    if (active !== entry || entry.saving || entry.loading || !allowed(entry.kind,entry.invoice)) return;
    if (entry.kind === 'discount' && !projection(entry).valid) return;
    entry.saving = true;
    renderPanel(entry);
    try {
      const fresh = await readInvoice(entry.id);
      if (active !== entry || !entry.card.isConnected) return;
      if (entry.session !== sessionId() || !allowed(entry.kind,fresh)) throw new Error(text('You no longer have permission to change this invoice.','لم تعد لديك صلاحية تعديل هذه الفاتورة.'));
      if (fingerprint(fresh) !== fingerprint(entry.invoice)) {
        entry.invoice = fresh;
        throw new Error(text('The invoice changed. Review the updated balance, then confirm again.','تغيّرت الفاتورة. راجع الرصيد المحدّث ثم أكد مجددًا.'));
      }
      const kind = entry.kind;
      if (kind === 'release' && invoiceRemaining(fresh) <= 0 || kind === 'undo-release' && !fresh.releases.length
        || kind === 'remove-discount' && fresh.manualDiscount <= 0) throw new Error(text('This adjustment is no longer available.','هذا التعديل لم يعد متاحًا.'));
      const discount = kind === 'discount' || kind === 'remove-discount';
      const {error} = await db.rpc(discount ? 'set_patient_invoice_discount' : kind === 'release' ? 'release_patient_invoice' : 'undo_latest_invoice_release',
        discount ? {p_invoice_id:entry.id,p_discount_type:kind === 'remove-discount' ? 'amount' : entry.type,p_discount_value:kind === 'remove-discount' ? 0 : Number(entry.value)} : {p_invoice_id:entry.id});
      if (error) throw error;
      close(true);
      invoices.delete(entry.id);
      const message = kind === 'discount' ? text('Discount updated','تم تحديث الخصم') : kind === 'remove-discount' ? text('Discount removed','تمت إزالة الخصم')
        : kind === 'release' ? text('Invoice balance released','تم إعفاء رصيد الفاتورة') : text('Invoice release undone','تم التراجع عن إعفاء الفاتورة');
      showAppointmentNotificationToast(message,invoiceNumber(entry.id));
      try { await refreshViews(fresh); }
      catch (refreshError) {
        console.error('Invoice saved; view refresh failed',refreshError);
        showAppointmentNotificationToast(message,text('Refresh the invoice list to see the updated balance.','حدّث قائمة الفواتير لعرض الرصيد المحدّث.'));
      }
    } catch (error) {
      if (active !== entry || !entry.card.isConnected) return;
      entry.saving = false;
      renderPanel(entry,error.message || text('Could not save the adjustment. Please try again.','تعذر حفظ التعديل. حاول مجددًا.'));
    } finally {
      entry.saving = false;
    }
  }

  document.addEventListener('click',event => {
    const trigger = event.target.closest?.('[data-invoice-action]');
    const card = trigger?.closest('[data-invoice-card]');
    if (!card) {
      document.querySelectorAll('.invoice-card-menu[open]').forEach(menu => { if (!menu.contains(event.target)) menu.open = false; });
      return;
    }
    if (active?.saving) return;
    const invoice = invoices.get(Number(card.dataset.invoiceCard));
    if (!invoice) return;
    const action = trigger.dataset.invoiceAction;
    trigger.closest('details')?.removeAttribute('open');
    if (action === 'adjustments') {
      const expanded = trigger.getAttribute('aria-expanded') !== 'true';
      if (!expanded && active?.card === card) close();
      setAdjustmentsOpen(card,expanded);
      if (!expanded) trigger.focus({preventScroll:true});
      return;
    }
    if (['discount','release','remove-discount','undo-release'].includes(action)) { void open(card,action,trigger); return; }
    if (action === 'close') { close(); return; }
    if (action === 'pay' && canRecordInvoicePayment()) openInvoicePaymentModal(invoice.id,null,trigger);
    if (action === 'pay-item' && canRecordInvoicePayment()) openInvoicePaymentModal(invoice.id,Number(trigger.dataset.itemId),trigger);
    if (action === 'payments' && hasPageAccess('patients')) openInvoiceLinkedPayments(invoice.id,Number(trigger.dataset.itemId));
    if (action === 'date' && hasPageAccess('patients')) openInvoiceDateEditor(invoice.id,invoice.invoiceDate);
    if (action === 'delete' && hasPageAccess('patients')) void deletePatientInvoice(invoice.id);
    if (action === 'delete-item' && hasPageAccess('patients')) void deletePatientInvoiceItem(Number(trigger.dataset.itemId),invoice.id);
  });
  document.addEventListener('submit',event => {
    if (!event.target.matches('[data-invoice-form]')) return;
    event.preventDefault();
    if (active && event.target.closest('[data-invoice-card]') === active.card) void save(active);
  });
  document.addEventListener('input',event => {
    if (!event.target.matches('[data-invoice-value]') || !active || active.saving) return;
    active.value = event.target.value;
    updatePreview(active);
  });
  document.addEventListener('change',event => {
    if (!event.target.matches('[data-invoice-type]') || !active || active.saving) return;
    const prior = projection(active).discount;
    active.type = event.target.value;
    active.value = String(active.type === 'percent' ? subtotal(active.invoice) ? Math.round(prior / subtotal(active.invoice) * 10000) / 100 : 0 : prior);
    renderPanel(active);
    active.card.querySelector('[data-invoice-type]')?.focus({preventScroll:true});
  });
  document.addEventListener('keydown',event => {
    if (event.key !== 'Escape') return;
    const menu = event.target.closest?.('.invoice-card-menu[open]');
    if (menu) { menu.open = false; menu.querySelector('summary').focus(); event.preventDefault(); }
    else if (active && active.card.contains(event.target)) { close(); event.preventDefault(); }
    else {
      const card = event.target.closest?.('[data-invoice-card]');
      const toggle = card?.querySelector('.invoice-adjustments-disclosure[aria-expanded="true"]');
      if (toggle) { setAdjustmentsOpen(card,false); toggle.focus({preventScroll:true}); event.preventDefault(); }
    }
  });

  window.LuminInvoiceCards = {
    markup,
    setInvoices(records) {
      invoices = new Map(records.map(invoice => [Number(invoice.id),invoice]));
      if (active && !invoices.has(active.id)) close(true);
    }
  };
})();
