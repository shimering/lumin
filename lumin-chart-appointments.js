// A day-scoped queue: independent of the calendar's selected day and filters.
const chartAppointments = {
  records: [], dateKey: '', userId: null, status: 'idle', error: null,
  pending: null, expiresAt: 0, generation: 0, collapsed: false, timer: null,
  exits: new Map()
};

function chartAppointmentsText(english, arabic) {
  return currentUiLanguage === 'ar' ? arabic : english;
}

function chartAppointmentsCanView() {
  return Boolean(currentSession && hasPageAccess('chart') && hasPageAccess('appointments'));
}

function chartAppointmentIsPending(entry, dateKey = appointmentDateKey(new Date())) {
  return Boolean(entry.patientId && !entry.isNote && entry.date === dateKey
    && !['Completed', 'Cancelled', 'No-show'].includes(canonicalAppointmentStatus(entry.status)));
}

function chartAppointmentsForToday() {
  const dateKey = appointmentDateKey(new Date());
  return chartAppointments.records.filter(entry => chartAppointmentIsPending(entry, dateKey))
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt) || String(a.id).localeCompare(String(b.id)));
}

function updateChartSidePanelLayout() {
  const workspace = document.getElementById('chart-clinical-workspace');
  const panel = document.getElementById('chart-appointments-panel');
  if (!workspace || !panel) return;
  const allowed = chartAppointmentsCanView();
  panel.hidden = !allowed;
  panel.dir = currentUiLanguage === 'ar' ? 'rtl' : 'ltr';
  workspace.classList.toggle('has-chart-appointments', allowed);
  workspace.classList.toggle('is-appointments-collapsed', chartAppointments.collapsed);
  workspace.classList.toggle('is-side-panels-collapsed', allowed && chartAppointments.collapsed
    && typeof chartPatientMedia !== 'undefined' && chartPatientMedia.collapsed);
}

function toggleChartAppointmentsPanel() {
  chartAppointments.collapsed = !chartAppointments.collapsed;
  renderChartAppointmentsPanel();
  document.getElementById('chart-appointments-collapse')?.focus({ preventScroll: true });
}

function setChartAppointmentsActive(active) {
  if (chartAppointments.timer) window.clearInterval(chartAppointments.timer);
  chartAppointments.timer = null;
  if (!active) return;
  if (!chartAppointmentsCanView()) { resetChartAppointments(); return; }
  void loadChartAppointments();
  chartAppointments.timer = window.setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (chartAppointments.dateKey !== appointmentDateKey(new Date())) void loadChartAppointments({ refresh: true });
  }, 30000);
}

function invalidateChartAppointments() {
  chartAppointments.expiresAt = 0;
}

function resetChartAppointments(options = {}) {
  const timer = options.keepTimer ? chartAppointments.timer : null;
  const collapsed = options.keepTimer ? chartAppointments.collapsed : false;
  if (chartAppointments.timer && !options.keepTimer) window.clearInterval(chartAppointments.timer);
  chartAppointments.exits.forEach(animation => animation.cancel());
  chartAppointments.exits.clear();
  Object.assign(chartAppointments, {
    records: [], dateKey: '', userId: null, status: 'idle', error: null,
    pending: null, expiresAt: 0, collapsed, timer,
    generation: chartAppointments.generation + 1
  });
  document.getElementById('chart-appointments-list')?.replaceChildren();
  renderChartAppointmentsPanel();
}

function loadChartAppointments(options = {}) {
  if (!chartAppointmentsCanView()) {
    resetChartAppointments();
    return Promise.resolve(false);
  }
  const now = new Date(), dateKey = appointmentDateKey(now), userId = currentSession.user.id;
  if (chartAppointments.dateKey !== dateKey || chartAppointments.userId !== userId) {
    resetChartAppointments({ keepTimer: true });
    Object.assign(chartAppointments, { dateKey, userId });
  }
  if (!options.refresh && chartAppointments.pending) return chartAppointments.pending;
  if (!options.refresh && chartAppointments.expiresAt > Date.now()) {
    renderChartAppointmentsPanel();
    return Promise.resolve(true);
  }
  const generation = chartAppointments.generation;
  const isCurrent = () => generation === chartAppointments.generation
    && currentSession?.user?.id === userId && chartAppointmentsCanView()
    && appointmentDateKey(new Date()) === dateKey;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  chartAppointments.error = null;
  if (chartAppointments.status !== 'ready') chartAppointments.status = 'loading';
  renderChartAppointmentsPanel();
  const request = coalesceRefreshRead(contentRefreshContext('chart-appointments', dateKey), async () => {
    const readRevision = appointmentWriteRevision, records = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db.from('appointments').select(APPOINTMENT_SELECT_FIELDS)
        .gte('appointment_at', start.toISOString()).lt('appointment_at', end.toISOString())
        .order('appointment_at', { ascending: true }).order('id', { ascending: true }).range(offset, offset + 999);
      if (error) throw error;
      records.push(...(data || []));
      if ((data || []).length < 1000) return { records, readRevision };
    }
  });
  const pending = request.then(({ records, readRevision }) => {
    if (!isCurrent()) return false;
    chartAppointments.records = appointmentRecordsAfterLocalWrites(records, readRevision, dateKey).map(normaliseAppointmentRecord);
    chartAppointments.status = 'ready';
    chartAppointments.expiresAt = Date.now() + 15000;
    renderChartAppointmentsPanel();
    return true;
  }).catch(error => {
    if (!isCurrent()) return false;
    chartAppointments.error = error;
    if (chartAppointments.status !== 'ready') chartAppointments.status = 'error';
    renderChartAppointmentsPanel();
    if (options.throwOnError) throw error;
    return false;
  }).finally(() => {
    if (chartAppointments.pending === pending) chartAppointments.pending = null;
  });
  chartAppointments.pending = pending;
  return pending;
}

function updateChartAppointmentRecord(entry) {
  if (!chartAppointmentsCanView() || chartAppointments.userId !== currentSession.user.id) return;
  chartAppointments.records = chartAppointments.records.filter(record => record.id !== entry.id);
  if (entry.date === chartAppointments.dateKey) chartAppointments.records.push(entry);
  renderChartAppointmentsPanel();
}

function removeChartAppointmentRecord(id) {
  chartAppointments.records = chartAppointments.records.filter(entry => entry.id !== id);
  renderChartAppointmentsPanel();
}

function createChartAppointmentCard(entry) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'chart-appointment-card';
  card.dataset.appointmentId = entry.id;
  card.innerHTML = '<time class="chart-appointment-time" dir="auto"></time><span class="chart-appointment-name" dir="auto" data-media-user-content></span>';
  card.addEventListener('click', async () => {
    const current = chartAppointments.records.find(record => record.id === card.dataset.appointmentId);
    if (!chartAppointmentsCanView() || !current || !chartAppointmentIsPending(current)) return;
    card.disabled = true;
    try { await openPatientChart(current.patientId); }
    finally { if (card.isConnected && !chartAppointments.exits.has(card)) card.disabled = false; }
  });
  return card;
}

function updateChartAppointmentCard(card, entry) {
  const color = appointmentStatusColor(entry.status);
  card.style.setProperty('--chart-appointment-rgb', appointmentColorRgbChannels(color));
  card.dataset.status = canonicalAppointmentStatus(entry.status);
  const time = card.querySelector('time');
  const label = new Intl.DateTimeFormat(currentUiLanguage === 'ar' ? 'ar-EG' : 'en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(entry.startAt));
  time.dateTime = entry.startAt;
  time.textContent = label;
  card.querySelector('.chart-appointment-name').textContent = entry.patient;
  const status = currentUiLanguage === 'ar' ? arabicUiPhrase(card.dataset.status) : card.dataset.status;
  card.title = `${entry.patient} · ${label} · ${status}`;
  card.setAttribute('aria-label', `${chartAppointmentsText('Open dental chart', 'فتح مخطط الأسنان')}: ${card.title}`);
  card.setAttribute('aria-current', entry.patientId === activePatientId ? 'true' : 'false');
}

function dismissChartAppointmentCard(card) {
  if (chartAppointments.exits.has(card)) return;
  card.disabled = true;
  card.setAttribute('aria-hidden', 'true');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion || !card.getClientRects().length || typeof card.animate !== 'function') {
    card.remove();
    return;
  }
  // Always exit to the physical right, including in Arabic.
  const animation = card.animate([
    { transform: 'translateX(0)', opacity: 1, height: '44px', minHeight: '44px', paddingBlock: '8px', marginBlockEnd: '0px' },
    { transform: 'translateX(110%)', opacity: 0, height: '44px', minHeight: '44px', paddingBlock: '8px', marginBlockEnd: '0px', offset: .7 },
    { transform: 'translateX(110%)', opacity: 0, height: '0px', minHeight: '0px', paddingBlock: '0px', marginBlockEnd: '-6px' }
  ], { duration: 360, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'forwards' });
  chartAppointments.exits.set(card, animation);
  animation.finished.then(() => {
    if (chartAppointments.exits.get(card) !== animation) return;
    chartAppointments.exits.delete(card);
    card.remove();
    animation.cancel();
    renderChartAppointmentsPlaceholder();
  }).catch(() => {});
}

function renderChartAppointmentsPlaceholder() {
  const list = document.getElementById('chart-appointments-list');
  if (!list || list.querySelector('.chart-appointment-card')) return;
  if (chartAppointments.status === 'loading' || chartAppointments.status === 'idle') {
    list.innerHTML = '<div class="chart-appointments-skeleton" aria-hidden="true"></div>'.repeat(4);
    return;
  }
  const failed = chartAppointments.status === 'error';
  list.innerHTML = `<div class="chart-appointments-empty"><i data-lucide="${failed ? 'cloud-off' : 'calendar-check-2'}" aria-hidden="true"></i><strong>${failed ? chartAppointmentsText('Appointments unavailable', 'المواعيد غير متاحة') : chartAppointmentsText('All clear for today', 'لا توجد مواعيد متبقية اليوم')}</strong><p>${failed ? chartAppointmentsText('Try loading today’s appointments again.', 'أعد محاولة تحميل مواعيد اليوم.') : chartAppointmentsText('No remaining patient appointments today.', 'لا توجد مواعيد مرضى متبقية اليوم.')}</p><button type="button" class="chart-media-button" onclick="${failed ? 'loadChartAppointments({refresh:true})' : "switchView('appointments')"}"><i data-lucide="${failed ? 'refresh-cw' : 'calendar-days'}" aria-hidden="true"></i>${failed ? chartAppointmentsText('Retry', 'إعادة المحاولة') : chartAppointmentsText('View calendar', 'عرض التقويم')}</button></div>`;
  if (window.lucide) lucide.createIcons();
}

function renderChartAppointmentsPanel() {
  const panel = document.getElementById('chart-appointments-panel');
  const list = document.getElementById('chart-appointments-list');
  if (!panel || !list) return;
  updateChartSidePanelLayout();
  if (panel.hidden) { list.replaceChildren(); return; }
  document.getElementById('chart-appointments-title').textContent = chartAppointmentsText('Today’s appointments', 'مواعيد اليوم');
  const toggle = document.getElementById('chart-appointments-collapse');
  const action = chartAppointments.collapsed ? chartAppointmentsText('Expand today’s appointments', 'توسيع مواعيد اليوم') : chartAppointmentsText('Collapse today’s appointments', 'طي مواعيد اليوم');
  toggle.setAttribute('aria-expanded', String(!chartAppointments.collapsed));
  toggle.setAttribute('aria-label', action);
  toggle.title = action;
  toggle.innerHTML = `<i data-lucide="${chartAppointments.collapsed ? 'chevron-up' : 'chevron-down'}" aria-hidden="true"></i>`;
  const body = document.getElementById('chart-appointments-body');
  body.hidden = chartAppointments.collapsed;
  body.inert = chartAppointments.collapsed;
  body.setAttribute('aria-busy', String(chartAppointments.status === 'loading'));
  const feedback = document.getElementById('chart-appointments-feedback');
  feedback.hidden = !chartAppointments.error || chartAppointments.status === 'error';
  if (!feedback.hidden) feedback.innerHTML = `${chartAppointmentsText('Updates paused. Showing the last loaded appointments.', 'توقفت التحديثات. يتم عرض آخر مواعيد تم تحميلها.')} <button type="button" class="chart-media-button is-neutral" onclick="loadChartAppointments({refresh:true})">${chartAppointmentsText('Retry', 'إعادة المحاولة')}</button>`;
  const entries = chartAppointmentsForToday(), ids = new Set(entries.map(entry => String(entry.id)));
  const cards = new Map([...list.querySelectorAll('.chart-appointment-card')].map(card => [card.dataset.appointmentId, card]));
  if (entries.length) [...list.children].filter(node => !node.classList.contains('chart-appointment-card')).forEach(node => node.remove());
  cards.forEach((card, id) => { if (!ids.has(id)) dismissChartAppointmentCard(card); });
  let cursor = list.firstElementChild;
  entries.forEach(entry => {
    const card = cards.get(String(entry.id)) || createChartAppointmentCard(entry);
    const exit = chartAppointments.exits.get(card);
    if (exit) {
      chartAppointments.exits.delete(card);
      exit.cancel();
      card.disabled = false;
      card.removeAttribute('aria-hidden');
    }
    updateChartAppointmentCard(card, entry);
    if (card !== cursor) list.insertBefore(card, cursor);
    cursor = card.nextElementSibling;
  });
  const count = document.getElementById('chart-appointments-count');
  if (count.textContent !== String(entries.length)) {
    count.textContent = String(entries.length);
    document.getElementById('chart-appointments-announcement').textContent = chartAppointmentsText(`${entries.length} appointments remaining today`, `المواعيد المتبقية اليوم: ${entries.length}`);
  }
  renderChartAppointmentsPlaceholder();
  if (window.lucide) lucide.createIcons();
}

document.addEventListener('DOMContentLoaded', renderChartAppointmentsPanel);
