/* Focused appointment edits write only the fields the user changed. */
let appointmentDetailEditorState = null;
const appointmentDetailWrites = new Set();
let appointmentDetailSheetGesture = null;
let appointmentDetailSheetBodyOverflow = null;

function clearAppointmentDetailSheetGesture() {
  appointmentDetailSheetGesture = null;
  const panel = document.getElementById('appointment-card-popover');
  panel?.style.removeProperty('translate');
  panel?.classList.remove('is-sheet-dragging');
}

function setAppointmentDetailSheetOpen(open) {
  if (open) {
    if (appointmentDetailSheetBodyOverflow === null) appointmentDetailSheetBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  } else {
    clearAppointmentDetailSheetGesture();
    if (appointmentDetailSheetBodyOverflow !== null) document.body.style.overflow = appointmentDetailSheetBodyOverflow;
    appointmentDetailSheetBodyOverflow = null;
  }
}

function setupAppointmentDetailSheet() {
  const panel = document.getElementById('appointment-card-popover');
  const layer = document.getElementById('appointment-card-popover-layer');
  if (!panel || !layer || panel.dataset.sheetReady) return;
  panel.dataset.sheetReady = 'true';
  let backdropTap = null;
  layer.addEventListener('pointerdown', event => {
    if (event.target !== layer) return;
    backdropTap = { x: event.clientX, y: event.clientY, moved: false };
    event.stopPropagation();
  });
  layer.addEventListener('pointermove', event => {
    if (backdropTap && Math.hypot(event.clientX - backdropTap.x, event.clientY - backdropTap.y) > 8) backdropTap.moved = true;
  });
  layer.addEventListener('touchmove', event => {
    if (event.target === layer && event.cancelable) event.preventDefault();
  }, { passive: false });
  // Keep the backdrop in place until the full click is consumed. Closing on
  // pointerdown can send the subsequent click to a button behind the sheet.
  layer.addEventListener('click', event => {
    if (event.target !== layer) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!backdropTap?.moved) closeAppointmentCardPopover();
    backdropTap = null;
  });
  panel.addEventListener('touchstart', event => {
    clearAppointmentDetailSheetGesture();
    if (event.touches.length !== 1 || !window.matchMedia('(max-width: 767px)').matches || !appointmentCardPopoverId
      || event.target.closest('button, a, input, textarea, select, label, [contenteditable]')) return;
    if (!event.target.closest('.appointment-popover-heading')) {
      // A body swipe dismisses only when every scroll container is at the top.
      for (let node = event.target; node && panel.contains(node); node = node.parentElement) {
        if (node.scrollTop > 0 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return;
      }
    }
    const touch = event.touches[0];
    appointmentDetailSheetGesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, distance: 0, dragging: false };
  }, { passive: true });
  panel.addEventListener('touchmove', event => {
    const gesture = appointmentDetailSheetGesture;
    if (!gesture) return;
    if (event.touches.length !== 1 || !window.matchMedia('(max-width: 767px)').matches) { clearAppointmentDetailSheetGesture(); return; }
    const touch = [...event.touches].find(touch => touch.identifier === gesture.id);
    if (!touch) return;
    const dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
    if (!gesture.dragging) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      if (dy <= 0 || Math.abs(dx) > dy * .8) { clearAppointmentDetailSheetGesture(); return; }
      gesture.dragging = true;
      panel.classList.add('is-sheet-dragging');
    }
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    gesture.distance = Math.max(0, dy);
    const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    panel.style.translate = `0 ${gesture.distance / zoom}px`;
  }, { passive: false });
  const finish = event => {
    const gesture = appointmentDetailSheetGesture;
    if (!gesture) return;
    if (gesture.dragging) {
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      if (event.type !== 'touchcancel' && gesture.distance >= Math.min(100, panel.getBoundingClientRect().height * .2)) closeAppointmentCardPopover();
    }
    clearAppointmentDetailSheetGesture();
  };
  panel.addEventListener('touchend', finish, { passive: false });
  panel.addEventListener('touchcancel', finish, { passive: false });
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...panel.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')]
      .filter(control => !control.disabled && control.getClientRects().length);
    const next = event.shiftKey ? controls.at(-1) : controls[0];
    if (document.activeElement === panel || document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) {
      event.preventDefault();
      (next || panel).focus({ preventScroll: true });
    }
  });
}

function appointmentDetailError(message) {
  const error = document.querySelector('#appointment-card-popover [data-appointment-detail-error]');
  if (error) { error.textContent = message; error.hidden = false; }
}

async function saveAppointmentDetailPatch(appointmentId, patch, notification = null) {
  const userId = currentSession?.user?.id;
  const writeKey = JSON.stringify([userId, appointmentId]);
  if (!userId || !canModifyAppointments() || appointmentDetailWrites.has(writeKey)) return false;
  const entry = appointments.find(item => item.id === appointmentId);
  if (!entry) return false;
  appointmentDetailWrites.add(writeKey);
  try {
    markLocalAppointmentChange(appointmentId);
    const { data, error } = await updateAppointmentRecordWithRetry(appointmentId, patch);
    if (currentSession?.user?.id !== userId || !canModifyAppointments()) return false;
    if (error || !data) throw error || new Error(appointmentPopoverText('The appointment is no longer available.', 'الموعد لم يعد متاحاً.'));
    const saved = replaceAppointmentRecord(data);
    if (notification) queueAppointmentPushNotification(notification, appointmentId);
    if (patch.appointment_at) {
      const date = new Date(saved.startAt);
      appointmentSelectedDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      appointmentVisibleMonth = new Date(date.getFullYear(), date.getMonth(), 1);
      selectedAppointmentId = appointmentId;
    }
    if (realtimeViewIsVisible('dashboard')) renderDashboard();
    if (realtimeViewIsVisible('appointments')) renderAppointments();
    if (appointmentCardPopoverId === appointmentId) openAppointmentCardPopover(appointmentId);
    return true;
  } catch (error) {
    if (currentSession?.user?.id === userId) recentLocalAppointmentChanges.delete(appointmentId);
    throw error;
  } finally { appointmentDetailWrites.delete(writeKey); }
}

async function changeAppointmentCardVisitType(appointmentId, select) {
  const entry = appointments.find(item => item.id === appointmentId);
  const type = appointmentVisitTypes.find(item => item.id === select.value && item.active);
  if (!entry || entry.isNote || !type || !canModifyAppointments() || type.id === entry.visitTypeId) return;
  const previous = entry.visitTypeId || '';
  select.disabled = true;
  select.setAttribute('aria-busy', 'true');
  try {
    const saved = await saveAppointmentDetailPatch(appointmentId, { visit_type_id: type.id, appointment_type: type.name });
    if (!saved) select.value = previous;
  } catch (error) {
    select.value = previous;
    appointmentDetailError(appointmentPopoverText('Could not change visit type. ', 'تعذر تغيير نوع الزيارة. ') + error.message);
  } finally {
    if (select.isConnected) { select.disabled = !canModifyAppointments(); select.removeAttribute('aria-busy'); }
  }
}

function ensureAppointmentDetailEditor() {
  let dialog = document.getElementById('appointment-detail-editor');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'appointment-detail-editor';
  dialog.className = 'appointment-detail-editor';
  dialog.setAttribute('aria-labelledby', 'appointment-detail-editor-title');
  dialog.innerHTML = `<form><header><div><h3 id="appointment-detail-editor-title"></h3><p id="appointment-detail-editor-subtitle"></p></div><button type="button" data-detail-close class="appointment-detail-button"><i data-lucide="x" aria-hidden="true"></i></button></header><div class="appointment-detail-editor-body"></div><p data-detail-error class="appointment-detail-error" role="alert" hidden></p><footer><button type="button" data-detail-cancel class="appointment-detail-button"></button><button type="submit" data-detail-save class="appointment-detail-button is-primary"></button></footer></form>`;
  dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); void saveAppointmentDetailEditor(); });
  dialog.querySelector('[data-detail-close]').addEventListener('click', () => closeAppointmentDetailEditor());
  dialog.querySelector('[data-detail-cancel]').addEventListener('click', () => closeAppointmentDetailEditor());
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeAppointmentDetailEditor(); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeAppointmentDetailEditor(); }
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) closeAppointmentDetailEditor(); });
  document.body.append(dialog);
  return dialog;
}

async function openAppointmentDetailEditor(appointmentId, field, trigger = null) {
  if (!canModifyAppointments() || !['schedule', 'doctor'].includes(field) || appointmentDetailEditorState?.saving) return;
  const entry = appointments.find(item => item.id === appointmentId), userId = currentSession?.user?.id;
  if (!entry || !userId) return;
  closeAppointmentDetailEditor({ restoreFocus: false });
  const state = { appointmentId, field, trigger, userId, saving: false, bodyOverflow: document.body.style.overflow };
  appointmentDetailEditorState = state;
  const dialog = ensureAppointmentDetailEditor(), body = dialog.querySelector('.appointment-detail-editor-body');
  dialog.dir = currentUiLanguage === 'ar' ? 'rtl' : 'ltr';
  dialog.querySelector('h3').textContent = field === 'schedule' ? appointmentPopoverText('Edit date and time', 'تعديل التاريخ والوقت') : appointmentPopoverText('Change assigned doctor', 'تغيير الطبيب المسؤول');
  dialog.querySelector('#appointment-detail-editor-subtitle').textContent = entry.patient;
  dialog.querySelector('[data-detail-close]').ariaLabel = appointmentPopoverText('Close', 'إغلاق');
  dialog.querySelector('[data-detail-cancel]').textContent = appointmentPopoverText('Cancel', 'إلغاء');
  dialog.querySelector('[data-detail-save]').textContent = appointmentPopoverText('Save changes', 'حفظ التغييرات');
  dialog.querySelector('[data-detail-error]').hidden = true;
  dialog.querySelectorAll('button').forEach(button => { button.disabled = false; });
  const date = new Date(entry.startAt);
  if (field === 'schedule') {
    const durations = [...new Set([15, 30, 45, 60, 90, 120, 180, entry.duration])].sort((a, b) => a - b);
    body.innerHTML = `<label><span>${appointmentPopoverText('Date', 'التاريخ')}</span><input id="appointment-detail-date" type="date" required value="${appointmentDateKey(date)}"></label><div class="appointment-detail-controls"><label><span>${appointmentPopoverText('Time', 'الوقت')}</span><input id="appointment-detail-time" type="time" step="60" required dir="ltr" value="${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}"></label><label><span>${appointmentPopoverText('Duration', 'المدة')}</span><select id="appointment-detail-duration">${durations.map(value => `<option value="${value}" ${value === entry.duration ? 'selected' : ''}>${escapeAppointmentText(appointmentDurationLabel(value))}</option>`).join('')}</select></label></div>`;
  } else {
    body.innerHTML = `<div class="appointment-detail-skeleton" aria-label="${appointmentPopoverText('Loading doctors', 'جارٍ تحميل الأطباء')}"></div>`;
    dialog.querySelector('[data-detail-save]').disabled = true;
  }
  if (field === 'schedule' && window.LuminDates) LuminDates.enhanceInputs(body);
  if (window.lucide) lucide.createIcons();
  dialog.showModal();
  document.body.style.overflow = 'hidden';
  if (field === 'doctor') {
    try {
      await ensureAppointmentStaffLoaded();
      if (appointmentDetailEditorState !== state) return;
      if (currentSession?.user?.id !== userId || !canModifyAppointments()) { closeAppointmentDetailEditor({ force: true, restoreFocus: false }); return; }
      const staff = appointmentStaff.filter(item => item.canReceiveAppointments);
      body.innerHTML = `<label><span>${appointmentPopoverText('Assigned doctor', 'الطبيب المسؤول')}</span><select id="appointment-detail-doctor" required><option value="">${appointmentPopoverText('Choose a doctor', 'اختر طبيباً')}</option>${staff.map(item => `<option value="${escapeAppointmentText(item.userId)}" ${item.userId === entry.assignedUserId ? 'selected' : ''}>${escapeAppointmentText(item.fullName)}</option>`).join('')}</select></label>`;
      dialog.querySelector('[data-detail-save]').disabled = !staff.length;
      if (!staff.length) throw new Error(appointmentPopoverText('No appointment-enabled doctors are available.', 'لا يوجد أطباء متاحون لاستقبال المواعيد.'));
      body.querySelector('select').focus();
    } catch (error) {
      if (appointmentDetailEditorState !== state) return;
      const message = dialog.querySelector('[data-detail-error]');
      message.textContent = error.message; message.hidden = false;
    }
  }
}

function closeAppointmentDetailEditor({ force = false, restoreFocus = true } = {}) {
  const state = appointmentDetailEditorState;
  if (state?.saving && !force) return;
  appointmentDetailEditorState = null;
  document.getElementById('appointment-detail-editor')?.close();
  if (state) document.body.style.overflow = state.bodyOverflow;
  if (restoreFocus && state) {
    const trigger = state.trigger?.isConnected ? state.trigger : document.querySelector(`[data-edit-appointment-detail="${state.field}"]`);
    trigger?.focus({ preventScroll: true });
  }
}

async function saveAppointmentDetailEditor() {
  const state = appointmentDetailEditorState, dialog = document.getElementById('appointment-detail-editor');
  if (!state || state.saving || !dialog || !canModifyAppointments() || currentSession?.user?.id !== state.userId || !dialog.querySelector('form').reportValidity()) return;
  let patch, notification;
  if (state.field === 'schedule') {
    const day = appointmentDateFromInput(dialog.querySelector('#appointment-detail-date').value);
    const [hours, minutes] = dialog.querySelector('#appointment-detail-time').value.split(':').map(Number);
    const duration = Number(dialog.querySelector('#appointment-detail-duration').value);
    if (!day || !Number.isInteger(hours) || hours > 23 || !Number.isInteger(minutes) || minutes > 59 || duration <= 0) return;
    day.setHours(hours, minutes, 0, 0);
    if (day.getHours() !== hours || day.getMinutes() !== minutes) return;
    patch = { appointment_at: day.toISOString(), duration_minutes: duration }; notification = 'rescheduled';
  } else {
    const doctor = dialog.querySelector('#appointment-detail-doctor').value;
    if (!appointmentStaff.some(item => item.userId === doctor && item.canReceiveAppointments)) return;
    patch = { assigned_user_id: doctor }; notification = 'reassigned';
  }
  const current = appointments.find(item => item.id === state.appointmentId);
  if (!current) { closeAppointmentDetailEditor(); return; }
  const unchanged = state.field === 'schedule'
    ? Date.parse(current.startAt) === Date.parse(patch.appointment_at) && current.duration === patch.duration_minutes
    : current.assignedUserId === patch.assigned_user_id;
  if (unchanged) { closeAppointmentDetailEditor(); return; }
  state.saving = true;
  dialog.querySelectorAll('button, input, select').forEach(control => { control.disabled = true; });
  const error = dialog.querySelector('[data-detail-error]'); error.hidden = true;
  dialog.querySelector('[data-detail-save]').textContent = appointmentPopoverText('Saving…', 'جارٍ الحفظ…');
  try {
    const saved = await saveAppointmentDetailPatch(state.appointmentId, patch, notification);
    if (appointmentDetailEditorState !== state) return;
    if (currentSession?.user?.id !== state.userId || !canModifyAppointments()) { closeAppointmentDetailEditor({ force: true, restoreFocus: false }); return; }
    if (saved) closeAppointmentDetailEditor({ force: true });
    else throw new Error(appointmentPopoverText('Your appointment access changed. Reopen the details and try again.', 'تغيرت صلاحية المواعيد. أعد فتح التفاصيل وحاول مرة أخرى.'));
  } catch (failure) {
    if (appointmentDetailEditorState === state) { error.textContent = appointmentPopoverText('Could not save changes. ', 'تعذر حفظ التغييرات. ') + failure.message; error.hidden = false; }
  } finally {
    state.saving = false;
    if (appointmentDetailEditorState === state) {
      dialog.querySelectorAll('button, input, select').forEach(control => { control.disabled = false; });
      dialog.querySelector('[data-detail-save]').textContent = appointmentPopoverText('Save changes', 'حفظ التغييرات');
    }
  }
}

async function openAppointmentDetailOperations(appointmentId, trigger = null) {
  const entry = appointments.find(item => item.id === appointmentId);
  if (!entry || entry.isNote || !entry.patientId || !canModifyAppointments() || !currentSession) return;
  closeAppointmentCardPopover(false, false);
  resetAppointmentOperations(entry.patientId, entry.operations || []);
  appointmentOperationState.appointmentId = appointmentId;
  await openAppointmentOperationPicker(trigger);
}
