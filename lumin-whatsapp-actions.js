let waMessageMenu = null;
let waMessagePress = null;
let waMessageSuppressClickUntil = 0;
const waDeletedMessageIds = new Set();

function whatsappMessageActionText(key) {
  const ar = currentUiLanguage === 'ar';
  const labels = {
    actions: ['Message actions', 'خيارات الرسالة'], more: ['More message actions', 'المزيد من خيارات الرسالة'],
    reply: ['Reply', 'رد'], copy: ['Copy text', 'نسخ النص'], delete: ['Delete from Lumin', 'حذف من لومين'],
    cancel: ['Cancel', 'إلغاء'], confirm: ['Delete this message?', 'حذف هذه الرسالة؟'],
    explanation: ['This removes the message from the shared Lumin chat for clinic staff. The recipient will still see their copy.', 'سيتم حذف الرسالة من محادثة لومين المشتركة لفريق العيادة. ستظل نسخة الرسالة لدى المستلم.'],
    unavailable: ['Deleting from the recipient’s chat is unavailable with this WhatsApp connection.', 'حذف الرسالة من محادثة المستلم غير متاح عبر اتصال واتساب الحالي.'],
    deleting: ['Deleting…', 'جارٍ الحذف…'], failed: ['Could not delete the message. Please try again.', 'تعذر حذف الرسالة. حاول مرة أخرى.'],
    copied: ['Text copied', 'تم نسخ النص'], copyFailed: ['Could not copy the text.', 'تعذر نسخ النص.'],
    reactions: ['React to message', 'التفاعل مع الرسالة']
  };
  return labels[key]?.[ar ? 1 : 0] || key;
}

function cancelWhatsAppMessagePress() {
  if (waMessagePress) {
    clearTimeout(waMessagePress.timer);
    waMessagePress.row.classList.remove('wa-message-pressing');
    waMessagePress = null;
  }
}

function closeWhatsAppMessageMenu({ restoreFocus = false } = {}) {
  cancelWhatsAppMessagePress();
  if (!waMessageMenu) return;
  const { root, trigger, messageId } = waMessageMenu;
  root.remove();
  document.getElementById(`whatsapp-msg-${messageId}`)?.classList.remove('wa-message-selected');
  waMessageMenu = null;
  if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
}

function positionWhatsAppMessageMenu() {
  if (!waMessageMenu) return;
  const { panel, messageId } = waMessageMenu;
  const row = document.getElementById(`whatsapp-msg-${messageId}`);
  if (!row || row.getBoundingClientRect().height === 0 || !isActiveWhatsAppChatVisible()) {
    closeWhatsAppMessageMenu();
    return;
  }
  row.classList.add('wa-message-selected');
  if (!waMessageMenu.trigger?.isConnected) waMessageMenu.trigger = row.querySelector('.wa-message-more');
  if (window.innerWidth < 768) { panel.style.left = ''; panel.style.top = ''; return; }
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
  const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
  const bubble = row.querySelector('.whatsapp-msg-bubble-track').getBoundingClientRect();
  const rect = panel.getBoundingClientRect();
  const rtl = document.documentElement.dir === 'rtl';
  const x = rtl ? bubble.right - rect.width : bubble.left;
  const y = bubble.bottom + 8 + rect.height <= top + height - 12 ? bubble.bottom + 8 : bubble.top - rect.height - 8;
  panel.style.left = `${Math.max(left + 12, Math.min(x, left + width - rect.width - 12))}px`;
  panel.style.top = `${Math.max(top + 12, Math.min(y, top + height - rect.height - 12))}px`;
}

function openWhatsAppMessageMenu(event, messageId, trigger = null) {
  event?.preventDefault();
  event?.stopPropagation();
  const message = whatsappMessages.find(item => item.id === messageId);
  if (!message || waDeletedMessageIds.has(messageId)) return;
  if (!event || event.type === 'contextmenu') waMessageSuppressClickUntil = Date.now() + 800;
  closeWhatsAppMessageMenu();
  const row = document.getElementById(`whatsapp-msg-${messageId}`);
  if (!row) return;
  // Dismiss an already open keyboard without ever focusing the composer.
  if (document.activeElement?.matches('input, textarea, [contenteditable="true"]')) document.activeElement.blur();
  window.getSelection()?.removeAllRanges();
  waChatSwipeGesture = null;
  waSwipedRow = null;
  waIsSwiping = false;
  const root = document.createElement('div');
  root.className = 'wa-message-menu-overlay';
  root.innerHTML = `<section class="wa-message-menu" role="dialog" aria-modal="true" aria-label="${whatsappMessageActionText('actions')}" dir="${currentUiLanguage === 'ar' ? 'rtl' : 'ltr'}" tabindex="-1">
    <div class="wa-message-reactions" role="group" aria-label="${whatsappMessageActionText('reactions')}">${['👍','❤️','😂','😮','🙏','🦷'].map(emoji => `<button type="button" data-wa-reaction="${emoji}" aria-label="${emoji}">${emoji}</button>`).join('')}</div>
    <div class="wa-message-menu-options">
      <button type="button" data-wa-action="reply"><i data-lucide="reply"></i><span>${whatsappMessageActionText('reply')}</span></button>
      ${message.content ? `<button type="button" data-wa-action="copy"><i data-lucide="copy"></i><span>${whatsappMessageActionText('copy')}</span></button>` : ''}
      ${hasPageAccess('whatsapp') ? `<button type="button" data-wa-action="delete" class="wa-message-danger"><i data-lucide="trash-2"></i><span>${whatsappMessageActionText('delete')}</span></button>` : ''}
      <button type="button" data-wa-action="cancel"><i data-lucide="x"></i><span>${whatsappMessageActionText('cancel')}</span></button>
    </div></section>`;
  document.body.append(root);
  const panel = root.querySelector('.wa-message-menu');
  waMessageMenu = { root, panel, messageId, conversationId: activeWhatsAppConversationId, trigger: trigger || row.querySelector('.wa-message-more'), busy: false };
  root.addEventListener('pointerdown', e => { if (e.target === root) closeWhatsAppMessageMenu({ restoreFocus: true }); });
  root.addEventListener('click', async e => {
    const button = e.target.closest('button');
    if (!button || waMessageMenu?.busy) return;
    const action = button.dataset.waAction;
    if (button.dataset.waReaction) {
      const emoji = button.dataset.waReaction;
      closeWhatsAppMessageMenu({ restoreFocus: true });
      void sendWhatsAppReaction(messageId, emoji);
    } else if (action === 'reply') {
      closeWhatsAppMessageMenu();
      triggerWhatsAppReplyById(messageId);
    } else if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(message.content);
        closeWhatsAppMessageMenu({ restoreFocus: true });
        showAppointmentNotificationToast('WhatsApp', whatsappMessageActionText('copied'));
      } catch (_) { showAppointmentNotificationToast('WhatsApp', whatsappMessageActionText('copyFailed')); }
    } else if (action === 'delete') {
      showWhatsAppMessageDeleteConfirmation();
    } else if (action === 'confirm-delete') {
      await deleteWhatsAppMessageFromLumin();
    } else if (action === 'cancel') {
      closeWhatsAppMessageMenu({ restoreFocus: true });
    }
  });
  if (window.lucide) lucide.createIcons();
  positionWhatsAppMessageMenu();
  panel.focus({ preventScroll: true });
}

function showWhatsAppMessageDeleteConfirmation() {
  if (!waMessageMenu) return;
  waMessageMenu.panel.innerHTML = `<div class="wa-message-delete-body"><span class="wa-message-delete-icon"><i data-lucide="trash-2"></i></span>
    <h3 id="wa-message-delete-title">${whatsappMessageActionText('confirm')}</h3>
    <p>${whatsappMessageActionText('explanation')}</p><p class="wa-message-delete-note">${whatsappMessageActionText('unavailable')}</p>
    <p class="wa-message-delete-error" role="alert" hidden></p></div>
    <div class="wa-message-delete-footer"><button type="button" data-wa-action="cancel">${whatsappMessageActionText('cancel')}</button><button type="button" data-wa-action="confirm-delete" class="wa-message-danger">${whatsappMessageActionText('delete')}</button></div>`;
  waMessageMenu.panel.setAttribute('aria-labelledby', 'wa-message-delete-title');
  if (window.lucide) lucide.createIcons();
  positionWhatsAppMessageMenu();
  waMessageMenu.panel.querySelector('[data-wa-action="cancel"]').focus({ preventScroll: true });
}

async function deleteWhatsAppMessageFromLumin() {
  const menu = waMessageMenu;
  if (!menu || menu.busy || !hasPageAccess('whatsapp')) return;
  menu.busy = true;
  menu.panel.setAttribute('aria-busy', 'true');
  menu.panel.querySelectorAll('button').forEach(button => { button.disabled = true; });
  const button = menu.panel.querySelector('[data-wa-action="confirm-delete"]');
  button.textContent = whatsappMessageActionText('deleting');
  try {
    const { data, error } = await db.rpc('delete_whatsapp_message_from_lumin', { p_message_id: menu.messageId, p_conversation_id: menu.conversationId });
    if (error) throw error;
    if (data?.message_id !== menu.messageId) throw new Error('Deletion was not confirmed');
    waDeletedMessageIds.add(menu.messageId);
    if (whatsappMessagesConversationId === menu.conversationId) {
      whatsappMessages = whatsappMessages.filter(message => message.id !== menu.messageId).map(message => message.reply_to_id === menu.messageId ? { ...message, reply_to_id: null, reply_to_text: null, reply_to_sender: null } : message);
      if (whatsappActiveReplyMessage?.id === menu.messageId) clearWhatsAppReplyMessage();
      renderWhatsAppMessages(false);
    }
    if (waMessageMenu === menu) closeWhatsAppMessageMenu();
    // Read current previews, including any messages that arrived during deletion.
    await fetchWhatsAppConversations();
  } catch (error) {
    console.error('Failed to delete WhatsApp message:', error);
    if (waMessageMenu !== menu) return;
    const alert = menu.panel.querySelector('[role="alert"]');
    alert.hidden = false;
    alert.textContent = whatsappMessageActionText('failed');
  } finally {
    menu.busy = false;
    menu.panel.removeAttribute('aria-busy');
    menu.panel.querySelectorAll('button').forEach(control => { control.disabled = false; });
    button.textContent = whatsappMessageActionText('delete');
  }
}

function initWhatsAppMessageActions() {
  const container = document.getElementById('whatsapp-messages-container');
  if (!container || container.dataset.messageActionsBound) return;
  container.dataset.messageActionsBound = 'true';
  container.addEventListener('pointerdown', event => {
    if (event.button !== 0 || waMessageMenu) return;
    if (event.isPrimary === false) { cancelWhatsAppMessagePress(); return; }
    const bubble = event.target.closest('.whatsapp-msg-bubble-track');
    if (!bubble || event.target.closest('button, audio, video, input, textarea')) return;
    cancelWhatsAppMessagePress();
    const row = bubble.closest('.whatsapp-msg-row');
    row.classList.add('wa-message-pressing');
    const press = { row, x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    press.timer = setTimeout(() => {
      if (waMessagePress !== press || !row.isConnected) return;
      waMessageSuppressClickUntil = Date.now() + 800;
      openWhatsAppMessageMenu(null, row.dataset.messageId);
      try { navigator.vibrate?.(20); } catch (_) {}
    }, 420);
    waMessagePress = press;
  });
  container.addEventListener('contextmenu', event => {
    const row = event.target.closest('.whatsapp-msg-row');
    if (!row) return;
    event.preventDefault();
    if (waMessageMenu?.messageId !== row.dataset.messageId) openWhatsAppMessageMenu(event, row.dataset.messageId);
  });
  container.addEventListener('click', event => {
    if (Date.now() < waMessageSuppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  container.addEventListener('selectstart', event => { if (event.target.closest('.whatsapp-msg-bubble-track')) event.preventDefault(); });
  document.addEventListener('pointermove', event => {
    if (waMessagePress && (Math.abs(event.clientX - waMessagePress.x) > 6 || Math.abs(event.clientY - waMessagePress.y) > 6)) cancelWhatsAppMessagePress();
  }, { passive: true });
  document.addEventListener('pointerup', cancelWhatsAppMessagePress, { passive: true });
  document.addEventListener('pointercancel', cancelWhatsAppMessagePress, { passive: true });
  container.addEventListener('touchstart', event => { if (event.touches.length !== 1) cancelWhatsAppMessagePress(); }, { passive: true });
  container.addEventListener('scroll', () => { cancelWhatsAppMessagePress(); positionWhatsAppMessageMenu(); }, { passive: true });
  document.addEventListener('keydown', event => {
    if (!waMessageMenu) return;
    if (event.key === 'Escape') { event.preventDefault(); closeWhatsAppMessageMenu({ restoreFocus: true }); }
    else if (event.key === 'Tab') {
      const controls = [...waMessageMenu.panel.querySelectorAll('button:not(:disabled)')];
      const index = controls.indexOf(document.activeElement);
      event.preventDefault();
      controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
    }
  });
  window.addEventListener('resize', positionWhatsAppMessageMenu);
  window.visualViewport?.addEventListener('resize', positionWhatsAppMessageMenu);
  window.visualViewport?.addEventListener('scroll', positionWhatsAppMessageMenu);
  window.addEventListener('hashchange', () => closeWhatsAppMessageMenu());
  window.addEventListener('blur', cancelWhatsAppMessagePress);
  document.addEventListener('visibilitychange', () => { if (document.hidden) closeWhatsAppMessageMenu(); });
}
