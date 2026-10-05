/* Monthly clinic cash movement, styled after Baytna's income area / expense line. */
let activeAnalyticsTab = 'income-statement';
let cashFlowReport = null;
let cashFlowLoadedRange = '';
let cashFlowLoadedAt = 0;
let cashFlowRenderToken = 0;
let cashFlowSelectedMonth = '';

function cashFlowText(en, ar) { return currentUiLanguage === 'ar' ? ar : en; }
function cashFlowCurrentMonth() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
}
function cashFlowShiftMonth(month, offset) {
  const [year, number] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, number - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
function cashFlowRange(start, end) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(start) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(end) || start > end) return null;
  const [sy, sm] = start.split('-').map(Number), [ey, em] = end.split('-').map(Number);
  if (sy < 1900 || ey > 9999 || (ey - sy) * 12 + em - sm >= 36) return null;
  return { startDate: `${start}-01`, endDate: `${end}-${new Date(Date.UTC(ey, em, 0)).getUTCDate()}` };
}
function initialiseCashFlowRange() {
  const start = document.getElementById('analytics-cash-start-month'), end = document.getElementById('analytics-cash-end-month');
  if (start && end && (!start.value || !end.value)) { end.value = cashFlowCurrentMonth(); start.value = cashFlowShiftMonth(end.value, -11); }
}
function invalidateCashFlowReport() { cashFlowLoadedRange = ''; cashFlowRenderToken += 1; }
function resetCashFlowAnalytics() {
  invalidateCashFlowReport(); cashFlowReport = null; cashFlowLoadedAt = 0; cashFlowSelectedMonth = ''; activeAnalyticsTab = 'income-statement';
  ['analytics-cash-start-month', 'analytics-cash-end-month'].forEach(id => { const input = document.getElementById(id); if (input) input.value = ''; });
  const content = document.getElementById('analytics-cash-content'); if (content) content.innerHTML = '';
}
function cashFlowRangeChanged() {
  invalidateCashFlowReport();
  document.getElementById('analytics-cash-range-error')?.classList.add('hidden');
  const content = document.getElementById('analytics-cash-content');
  if (content) { content.innerHTML = `<p class="cash-caption" role="status">${cashFlowText('Apply the range to update the chart.', 'طبّق الفترة لتحديث الرسم البياني.')}</p>`; content.setAttribute('aria-busy', 'false'); }
}
function setCashFlowPreset(preset) {
  const end = cashFlowCurrentMonth();
  document.getElementById('analytics-cash-end-month').value = end;
  document.getElementById('analytics-cash-start-month').value = preset === 'year' ? `${end.slice(0, 4)}-01` : cashFlowShiftMonth(end, preset === '6' ? -5 : -11);
  cashFlowRangeChanged(); return refreshCashFlow();
}
function syncAnalyticsTabUi() {
  document.querySelectorAll('[data-analytics-tab]').forEach(button => {
    const selected = button.dataset.analyticsTab === activeAnalyticsTab;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
  });
  ['income-statement', 'cash-flow'].forEach(tab => { const panel = document.getElementById(`analytics-panel-${tab}`); if (panel) { panel.classList.toggle('hidden', tab !== activeAnalyticsTab); panel.hidden = tab !== activeAnalyticsTab; } });
}
async function switchAnalyticsTab(tab) {
  if (!hasPageAccess('analytics') || !['income-statement', 'cash-flow'].includes(tab)) return;
  if (tab !== activeAnalyticsTab) cashFlowRenderToken += 1;
  activeAnalyticsTab = tab; syncAnalyticsTabUi(); await refreshActiveAnalyticsTab();
}
function analyticsTabKeydown(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tabs = ['income-statement', 'cash-flow'];
  const tab = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[1] : tabs[1 - tabs.indexOf(activeAnalyticsTab)];
  document.getElementById(`analytics-tab-${tab}`)?.focus(); void switchAnalyticsTab(tab);
}
async function refreshActiveAnalyticsTab(options = {}) {
  syncAnalyticsTabUi();
  return activeAnalyticsTab === 'cash-flow' ? refreshCashFlow(options) : refreshIncomeStatement(options);
}
function normaliseCashFlowReport(data, range) {
  if (!Array.isArray(data?.months)) throw new Error('Invalid cash flow response');
  const amount = value => { const number = Number(value); return Number.isFinite(number) ? Math.max(0, number) : 0; };
  const byMonth = new Map(data.months.map(item => [String(item.month), item]));
  const months = [];
  const first = range.startDate.slice(0,7), last = range.endDate.slice(0,7);
  const [firstYear, firstMonth] = first.split('-').map(Number), [lastYear, lastMonth] = last.split('-').map(Number);
  const count = (lastYear - firstYear) * 12 + lastMonth - firstMonth + 1;
  for (let i = 0; i < count; i += 1) {
    const key = cashFlowShiftMonth(first, i);
    const item = byMonth.get(key), income = amount(item?.income), expense = amount(item?.expense);
    months.push({ month: key, income, expense, net: income - expense, legacyExpense: amount(item?.legacy_expense) });
  }
  return { ...range, months, incomeTotal: months.reduce((sum, m) => sum + m.income, 0), expenseTotal: months.reduce((sum, m) => sum + m.expense, 0), legacyExpenseTotal: months.reduce((sum, m) => sum + m.legacyExpense, 0) };
}
function cashFlowMonthLabel(month, full = false) {
  return new Intl.DateTimeFormat(currentUiLanguage === 'ar' ? 'ar-EG' : 'en-GB', { timeZone: 'UTC', month: full ? 'long' : 'short', year: 'numeric' }).format(new Date(`${month}-15T12:00:00Z`));
}
function cashFlowCurve(points) {
  return points.map((point, i) => {
    if (!i) return `M ${point.x} ${point.y}`;
    const previous = points[i-1], middle = (previous.x + point.x) / 2;
    return `C ${middle} ${previous.y}, ${middle} ${point.y}, ${point.x} ${point.y}`;
  }).join(' ');
}
function cashFlowChartMarkup(report) {
  const width = Math.max(900, report.months.length * 68), height = 300, left = 64, right = width - 24, top = 20, bottom = 256;
  const max = Math.max(1, ...report.months.flatMap(m => [m.income, m.expense]));
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const ceiling = Math.ceil(max / magnitude / 2) * magnitude * 2;
  const y = value => bottom - value / ceiling * (bottom - top);
  const step = (right - left) / Math.max(1, report.months.length - 1);
  const x = i => report.months.length === 1 ? (left + right) / 2 : left + step * i;
  const income = report.months.map((m,i) => ({ x:x(i), y:y(m.income) })), expense = report.months.map((m,i) => ({ x:x(i), y:y(m.expense) }));
  const formatter = new Intl.NumberFormat(currentUiLanguage === 'ar' ? 'ar-EG' : 'en-GB', { notation:'compact', maximumFractionDigits:1 });
  const grid = Array.from({length:5}, (_,i) => { const value = ceiling * i / 4; return `<line x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}" stroke="#e2e8f0"/><text x="${left-12}" y="${y(value)+4}" text-anchor="end">${escapeHtml(formatter.format(value))}</text>`; }).join('');
  const points = report.months.map((month,i) => `<g><text x="${x(i)}" y="282" text-anchor="middle">${escapeHtml(cashFlowMonthLabel(month.month))}</text><circle cx="${x(i)}" cy="${y(month.income)}" r="3.5" fill="#168765"/><circle cx="${x(i)}" cy="${y(month.expense)}" r="3" fill="#e48a68"/></g>`).join('');
  const hitAreas = report.months.map((month,i) => `<rect data-cash-month="${month.month}" x="${Math.max(left, x(i)-step/2)}" y="${top}" width="${report.months.length === 1 ? right-left : Math.min(right,x(i)+step/2)-Math.max(left,x(i)-step/2)}" height="${bottom-top}" fill="transparent" tabindex="0" role="button" aria-label="${escapeHtml(`${cashFlowMonthLabel(month.month,true)}: ${cashFlowText('Money in','النقد الداخل')} ${formatInvoiceMoney(month.income)}, ${cashFlowText('Money out','النقد الخارج')} ${formatInvoiceMoney(month.expense)}`)}" onpointerenter="selectCashFlowMonth('${month.month}')" onfocus="selectCashFlowMonth('${month.month}')" onclick="selectCashFlowMonth('${month.month}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectCashFlowMonth('${month.month}')}"></rect>`).join('');
  return `<div class="cash-chart-scroll"><svg class="cash-chart" style="min-width:${Math.max(640,report.months.length*64)}px" viewBox="0 0 ${width} ${height}" role="group" aria-label="${cashFlowText('Monthly cash flow chart in EGP','الرسم البياني للتدفق النقدي الشهري بالجنيه المصري')}"><defs><linearGradient id="cash-income-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#31b88a" stop-opacity=".3"/><stop offset="100%" stop-color="#31b88a" stop-opacity="0"/></linearGradient></defs>${grid}<path d="${cashFlowCurve(income)} L ${income.at(-1).x} ${bottom} L ${income[0].x} ${bottom} Z" fill="url(#cash-income-gradient)"/><path d="${cashFlowCurve(income)}" fill="none" stroke="#168765" stroke-width="3"/><path d="${cashFlowCurve(expense)}" fill="none" stroke="#e48a68" stroke-width="2.5"/>${points}<line id="cash-selected-line" y1="${top}" y2="${bottom}" stroke="#94a3b8" stroke-dasharray="4 5" pointer-events="none"/>${hitAreas}</svg></div><div class="cash-months" aria-label="${cashFlowText('Inspect a month','استعراض شهر')}">${report.months.map(m => `<button type="button" class="cash-month" data-month="${m.month}" aria-pressed="false" onclick="selectCashFlowMonth('${m.month}')">${escapeHtml(cashFlowMonthLabel(m.month))}</button>`).join('')}</div><div id="analytics-cash-detail" class="cash-detail" aria-live="polite"></div>`;
}
function selectCashFlowMonth(key) {
  const month = cashFlowReport?.months.find(m => m.month === key); if (!month) return;
  cashFlowSelectedMonth = key;
  document.querySelectorAll('.cash-month').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.month === key)));
  const area = document.querySelector(`[data-cash-month="${key}"]`), line = document.getElementById('cash-selected-line');
  if (area && line) { const i = cashFlowReport.months.indexOf(month), width = Math.max(900, cashFlowReport.months.length*68); const x = cashFlowReport.months.length === 1 ? (64+width-24)/2 : 64 + i*(width-88)/(cashFlowReport.months.length-1); line.setAttribute('x1', x); line.setAttribute('x2', x); }
  const detail = document.getElementById('analytics-cash-detail');
  if (detail) detail.innerHTML = `<h4>${escapeHtml(cashFlowMonthLabel(key,true))}</h4><dl>${[[cashFlowText('Money in','النقد الداخل'),month.income],[cashFlowText('Money out','النقد الخارج'),month.expense],[cashFlowText('Net cash flow','صافي التدفق النقدي'),month.net]].map(([label,value]) => `<div><dt>${label}</dt><dd dir="auto">${escapeHtml(formatInvoiceMoney(value))}</dd></div>`).join('')}</dl>`;
}
function renderCashFlowReport(report) {
  const net = report.incomeTotal - report.expenseTotal;
  const stat = (tone, icon, label, value, caption) => `<article class="cash-card cash-stat" data-tone="${tone}"><p class="cash-stat-label"><i data-lucide="${icon}" class="h-4 w-4"></i>${label}</p><strong dir="auto">${escapeHtml(formatInvoiceMoney(value))}</strong><p class="cash-caption">${caption}</p></article>`;
  const hasActivity = report.incomeTotal > 0 || report.expenseTotal > 0;
  const content = document.getElementById('analytics-cash-content');
  content.innerHTML = `<div class="cash-summary">${stat('income','arrow-down-left',cashFlowText('Money in','النقد الداخل'),report.incomeTotal,cashFlowText('Patient payments received','مدفوعات المرضى المستلمة'))}${stat('expense','arrow-up-right',cashFlowText('Money out','النقد الخارج'),report.expenseTotal,cashFlowText('Expenses actually paid','المصروفات المدفوعة فعلياً'))}${stat(net < 0 ? 'loss' : 'net','arrow-right-left',cashFlowText('Net cash flow','صافي التدفق النقدي'),net,cashFlowText('Money in less money out','النقد الداخل ناقص النقد الخارج'))}</div><article class="cash-card"><div class="cash-heading"><div><h3>${cashFlowText('Monthly cash flow','التدفق النقدي الشهري')}</h3><p class="cash-caption">${cashFlowText('Actual receipts and payments · EGP','المقبوضات والمدفوعات الفعلية · جنيه مصري')}</p></div><span class="cash-period">${escapeHtml(cashFlowMonthLabel(report.startDate.slice(0,7)))} – ${escapeHtml(cashFlowMonthLabel(report.endDate.slice(0,7)))}</span></div><div class="cash-legend" style="margin-top:20px"><span><i aria-hidden="true"></i>${cashFlowText('Money in','النقد الداخل')}</span><span><i class="expense" aria-hidden="true"></i>${cashFlowText('Money out','النقد الخارج')}</span></div>${hasActivity ? cashFlowChartMarkup(report) : `<div class="cash-empty"><span class="cash-empty-icon"><i data-lucide="chart-no-axes-combined" class="h-5 w-5"></i></span><h4>${cashFlowText('No cash movement in this period','لا توجد حركة نقدية في هذه الفترة')}</h4><p>${cashFlowText('Choose another period to see the clinic’s receipts and payments.','اختر فترة أخرى لعرض مقبوضات العيادة ومدفوعاتها.')}</p><button type="button" class="cash-button cash-button-primary" onclick="setCashFlowPreset('12')">${cashFlowText('Show last 12 months','عرض آخر ١٢ شهراً')}</button></div>`}${report.legacyExpenseTotal > 0 ? `<p class="cash-caption">${cashFlowText('Older payments without payment-date history use the recorded expense date.','المدفوعات القديمة التي ليس لها سجل بتاريخ الدفع تستخدم تاريخ المصروف المسجل.')}</p>` : ''}</article>`;
  content.setAttribute('aria-busy','false');
  if (hasActivity) selectCashFlowMonth(report.months.some(m => m.month === cashFlowSelectedMonth) ? cashFlowSelectedMonth : report.months.at(-1).month);
  if (window.lucide) lucide.createIcons();
}
async function refreshCashFlow(options = {}) {
  if (!hasPageAccess('analytics') || activeAnalyticsTab !== 'cash-flow') return;
  initialiseCashFlowRange();
  const start = document.getElementById('analytics-cash-start-month').value, end = document.getElementById('analytics-cash-end-month').value;
  const range = cashFlowRange(start,end), errorElement = document.getElementById('analytics-cash-range-error');
  if (!range) { invalidateCashFlowReport(); errorElement.textContent = cashFlowText('Choose a valid range of up to 36 months.','اختر فترة صحيحة لا تتجاوز ٣٦ شهراً.'); errorElement.classList.remove('hidden'); return; }
  errorElement.classList.add('hidden');
  const key = `${start}:${end}`;
  if (!options.refresh && cashFlowReport && cashFlowLoadedRange === key && Date.now()-cashFlowLoadedAt < 30000) { renderCashFlowReport(cashFlowReport); return; }
  const token = ++cashFlowRenderToken, actor = currentSession?.user?.id, content = document.getElementById('analytics-cash-content');
  const current = () => token === cashFlowRenderToken && actor === currentSession?.user?.id && hasPageAccess('analytics') && activeAnalyticsTab === 'cash-flow' && start === document.getElementById('analytics-cash-start-month').value && end === document.getElementById('analytics-cash-end-month').value;
  content.setAttribute('aria-busy','true');
  content.innerHTML = `<div class="cash-card" role="status"><p class="cash-caption">${cashFlowText('Loading cash flow…','جارٍ تحميل التدفق النقدي…')}</p><div class="cash-skeleton" aria-hidden="true"></div></div>`;
  try {
    const {data,error} = await db.rpc('get_clinic_cash_flow',{p_start_date:range.startDate,p_end_date:range.endDate});
    if (error) throw error; if (!current()) return;
    cashFlowReport = normaliseCashFlowReport(data,range); cashFlowLoadedRange = key; cashFlowLoadedAt = Date.now(); renderCashFlowReport(cashFlowReport);
  } catch (_) {
    if (!current()) return;
    content.setAttribute('aria-busy','false'); cashFlowLoadedRange = '';
    content.innerHTML = `<div class="cash-card cash-empty" role="alert"><span class="cash-empty-icon"><i data-lucide="triangle-alert" class="h-5 w-5"></i></span><h4>${cashFlowText('Could not load cash flow','تعذر تحميل التدفق النقدي')}</h4><p>${cashFlowText('Please try again to load the clinic’s monthly totals.','يرجى المحاولة مرة أخرى لتحميل إجماليات العيادة الشهرية.')}</p><button type="button" class="cash-button cash-button-primary" onclick="refreshCashFlow({refresh:true})">${cashFlowText('Try again','حاول مرة أخرى')}</button></div>`;
    if (window.lucide) lucide.createIcons();
  }
}
