/* Loyalty uses the shared authenticated client and patient workspace. */
/* global currentUiLanguage, hasPageAccess, escapeHtml, currentSession, db, switchView,
   formatInvoiceMoney, formatInvoiceDate, invoiceNumber, patientWorkspaceId, patients,
   updatePatientWorkspaceNavigation, lucide, setAdminMessage,
   fetchInvoiceRecords, invoiceRemaining, invalidateLoyaltyInvoiceViews */
/* exported resetLoyaltyState, fetchLoyaltySettings, renderPatientLoyalty, reloadLoyaltySettings,
   saveLoyaltySettings, renderAdminLoyalty, manageLoyaltyPatient, toggleLoyaltyMembership,
   redeemLoyalty, reverseLoyaltyDiscount */
let loyaltySettings = null;
let loyaltySettingsDirty = false;
let loyaltySettingsEditingVersion = null;
let loyaltyPatientToken = 0;
let loyaltyControlPatientId = null;
let loyaltyPatientData = null;
let loyaltyPatientInvoices = [];
let loyaltyPatientHistory = [];
let loyaltyNextHistoryId = null;
let loyaltyPendingRequest = null;
let loyaltyBusy = false;
let loyaltyPatientControlsDirty = false;

function loyaltyText(en, ar) { return currentUiLanguage === 'ar' ? ar : en; }
function loyaltyNumber(value) { return Number(value || 0).toLocaleString(currentUiLanguage === 'ar' ? 'ar-EG' : 'en-GB', { maximumFractionDigits: 2 }); }
function canViewPatientLoyalty() { return Boolean(loyaltySettings && hasPageAccess('patients') && hasPageAccess('loyalty') && (loyaltySettings.visible || hasPageAccess('admin'))); }
function canManagePatientLoyalty() { return canViewPatientLoyalty(); }
function loyaltyEscape(value) { return escapeHtml(String(value ?? '')); }
function resetLoyaltyState() {
  loyaltySettings = null; loyaltySettingsDirty = false; loyaltySettingsEditingVersion = null;
  loyaltyPatientToken++; loyaltyPatientControlsDirty = false; loyaltyControlPatientId = null; loyaltyPatientData = null;
  loyaltyPatientInvoices = []; loyaltyPatientHistory = []; loyaltyNextHistoryId = null; loyaltyPendingRequest = null;
  document.getElementById('patient-loyalty-content')?.replaceChildren();
  const panel = document.getElementById('admin-panel-loyalty');
  if (panel) { panel.replaceChildren(); panel.dataset.initialized = ''; }
  syncLoyaltyVisibility();
}

async function fetchLoyaltySettings() {
  const sessionId = currentSession?.user?.id;
  const { data, error } = await db.from('loyalty_settings').select('*').eq('id', 1).single();
  if (sessionId !== currentSession?.user?.id) return;
  if (error) {
    loyaltySettings = null;
    syncLoyaltyVisibility();
    throw error;
  }
  loyaltySettings = data;
  syncLoyaltyVisibility();
  if (!loyaltySettingsDirty) renderLoyaltySettings();
}

function syncLoyaltyVisibility() {
  const button = document.querySelector('[data-patient-workspace-tab="loyalty"]');
  if (button) {
    button.hidden = !canViewPatientLoyalty();
    button.style.display = canViewPatientLoyalty() ? '' : 'none';
    button.setAttribute('aria-hidden', String(!canViewPatientLoyalty()));
  }
  const tabs = document.querySelector('[aria-label="Patient record sections"]');
  tabs?.classList.toggle('sm:grid-cols-5', canViewPatientLoyalty());
  tabs?.classList.toggle('sm:grid-cols-4', !canViewPatientLoyalty());
  if (!canViewPatientLoyalty()) {
    loyaltyPatientToken++;
    document.getElementById('patient-loyalty-content')?.replaceChildren();
    if (window.location.hash === '#loyalty') void switchView('patient-profile');
  }
}

function loyaltyCard(label, value, sub = '') {
  return `<div class="rounded-2xl border border-slate-200 bg-white p-5"><p class="text-sm font-bold text-slate-500">${loyaltyEscape(label)}</p><p class="mt-2 text-2xl font-black text-blue-950">${loyaltyEscape(value)}</p>${sub ? `<p class="mt-2 text-sm text-slate-500">${loyaltyEscape(sub)}</p>` : ''}</div>`;
}

function loyaltySummaryMarkup(data) {
  const account = data.account;
  const status = !account ? loyaltyText('Not enrolled', 'غير مشترك') : account.status === 'active' ? loyaltyText('Active member', 'عضوية نشطة') : loyaltyText('Suspended', 'موقوف');
  const minimum = Number(loyaltySettings.minimum_redemption);
  const progress = Math.min(100, Math.max(0, Number(data.balance) / minimum * 100));
  return `<div class="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3"><p class="text-sm font-bold text-blue-800">${status}${account ? ' · ' + loyaltyText('Enrolled ', 'تاريخ الاشتراك ') + formatInvoiceDate(account.enrolled_at.slice(0,10)) : ''}</p></div>
    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">${loyaltyCard(loyaltyText('Available points','النقاط المتاحة'),loyaltyNumber(data.balance),loyaltyText('Whole points available to redeem','نقاط كاملة متاحة للاستبدال'))}${loyaltyCard(loyaltyText('Points value','قيمة النقاط'),formatInvoiceMoney(data.value),loyaltyText('Current discount value of unused points','قيمة الخصم الحالية للنقاط غير المستخدمة'))}${loyaltyCard(loyaltyText('Expiring in 30 days','تنتهي خلال ٣٠ يومًا'),loyaltyNumber(data.expiring_points),data.next_expiry ? formatInvoiceDate(data.next_expiry.slice(0,10)) : loyaltyText('No upcoming expiry','لا يوجد انتهاء قريب'))}${loyaltyCard(loyaltyText('Points deficit','عجز النقاط'),loyaltyNumber(account?.debt),loyaltyText('Future points recover any deficit','النقاط القادمة تغطي أي عجز'))}</div>
    <div class="rounded-2xl border border-slate-200 bg-white p-5"><div class="flex flex-wrap justify-between gap-2 text-sm"><strong>${Number(data.balance)>=minimum ? loyaltyText('Minimum reward reached','تم بلوغ الحد الأدنى للمكافأة') : loyaltyText('Progress to your next reward','التقدم نحو المكافأة التالية')}</strong><span>${loyaltyNumber(data.balance)} / ${loyaltyNumber(minimum)}</span></div><div role="progressbar" aria-label="${loyaltyText('Reward progress','التقدم للمكافأة')}" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100" class="mt-3 h-2 overflow-hidden rounded-full bg-slate-100"><div class="h-full rounded-full bg-blue-600" style="width:${progress}%"></div></div><p class="mt-3 text-sm text-slate-500">${loyaltyText('Redeem points here, within the invoice limit and membership rules.','يمكن استبدال النقاط هنا حسب حد الفاتورة وحالة العضوية.')}</p>${!loyaltySettings.earning_enabled || !loyaltySettings.redemption_enabled ? `<p class="mt-2 text-sm font-bold text-amber-700">${!loyaltySettings.earning_enabled ? loyaltyText('Earning paused. ','اكتساب النقاط متوقف. ') : ''}${!loyaltySettings.redemption_enabled ? loyaltyText('Redemption paused.','استبدال النقاط متوقف.') : ''}</p>` : ''}</div>`;
}

function loyaltyHistoryMarkup(rows) {
  const labels = { earned: ['Earned','مكتسبة'], redeemed: ['Redeemed','مستبدلة'], expired: ['Expired','منتهية'], adjusted: ['Adjustment','تعديل'], reversed: ['Reversal','عكس عملية'], debt_repaid: ['Deficit recovered','تغطية عجز'], membership: ['Membership','العضوية'] };
  return `<div class="overflow-hidden rounded-2xl border border-slate-200 bg-white"><h3 class="border-b border-slate-100 p-5 text-base font-black">${loyaltyText('Activity history','سجل النشاط')}</h3>${rows.length ? `<div class="overflow-x-auto"><table class="w-full min-w-[700px] text-start text-sm"><thead class="bg-slate-50 text-slate-500"><tr>${[loyaltyText('Date','التاريخ'),loyaltyText('Activity','النشاط'),loyaltyText('Points','النقاط'),loyaltyText('Details','التفاصيل'),loyaltyText('Staff','الموظف')].map(x=>`<th class="px-5 py-3 text-start">${x}</th>`).join('')}</tr></thead><tbody class="divide-y divide-slate-100">${rows.map(row=>`<tr><td class="whitespace-nowrap px-5 py-4">${loyaltyEscape(formatInvoiceDate(row.created_at.slice(0,10)))}</td><td class="px-5 py-4 font-bold">${loyaltyText(...(labels[row.kind] || [row.kind,row.kind]))}</td><td class="px-5 py-4 font-black ${Number(row.points)<0 ? 'text-rose-700' : 'text-emerald-700'}">${Number(row.points)>0 ? '+' : ''}${loyaltyNumber(row.points)}</td><td class="px-5 py-4">${loyaltyEscape(row.reason)}${row.invoice_id ? `<span class="mt-1 block font-mono text-xs text-slate-500">${loyaltyEscape(invoiceNumber(row.invoice_id))}${row.payment_id ? ' · '+loyaltyText('Payment ','دفعة ')+loyaltyEscape(row.payment_id) : ''}</span>` : ''}</td><td class="px-5 py-4">${loyaltyEscape(row.staff_name || loyaltyText('System','النظام'))}</td></tr>`).join('')}</tbody></table></div>` : `<p class="p-8 text-center text-sm text-slate-500">${loyaltyText('No loyalty activity yet. Points begin after enrollment.','لا يوجد نشاط ولاء بعد. يبدأ اكتساب النقاط بعد الاشتراك.')}</p>`}</div>`;
}

async function renderPatientLoyalty(loadMore = false, { preserveControls = false } = {}) {
  const patientId = patientWorkspaceId();
  const patient = patients.find(item=>item.id===patientId);
  const container = document.getElementById('patient-loyalty-content');
  if (!patient || !container || !canViewPatientLoyalty()) return;
  const samePatient = loyaltyControlPatientId === patientId;
  if (preserveControls && samePatient && loyaltyBusy) return;
  if (!samePatient) {
    loyaltyControlPatientId = patientId;
    loyaltyPatientData = null; loyaltyPatientInvoices = []; loyaltyPendingRequest = null;
    loyaltyPatientHistory = []; loyaltyNextHistoryId = null; loyaltyPatientControlsDirty = false;
  }
  loadMore = loadMore && samePatient;
  updatePatientWorkspaceNavigation(patient,'loyalty');
  const token = ++loyaltyPatientToken;
  const sessionId = currentSession?.user?.id;
  const keepControls = samePatient && (loadMore || (preserveControls && loyaltyPatientControlsDirty));
  if (!samePatient || (!loadMore && !preserveControls)) container.innerHTML = '<p role="status" class="p-8 text-center text-slate-500">' + loyaltyText('Loading loyalty…','جارٍ تحميل الولاء…') + '</p>';
  try {
    const [{data,error},invoices] = await Promise.all([
      db.rpc('get_patient_loyalty',{p_patient_id:patientId,p_before_id:loadMore ? loyaltyNextHistoryId : null}),
      canManagePatientLoyalty() ? fetchInvoiceRecords({patientId}) : Promise.resolve([])
    ]);
    if(error) throw error;
    if(token!==loyaltyPatientToken || patientId!==patientWorkspaceId() || sessionId!==currentSession?.user?.id || !canViewPatientLoyalty()) return;
    if (data.settings && Number(data.settings.version)>=Number(loyaltySettings?.version || 0)) {
      loyaltySettings=data.settings;
      syncLoyaltyVisibility();
      if (!canViewPatientLoyalty()) return;
    }
    loyaltyPatientData = data; loyaltyPatientInvoices = invoices;
    const page=data.history.slice(0,50);
    const preserveHistory = preserveControls && samePatient && loyaltyPatientHistory.length > 50;
    if (!preserveHistory) loyaltyNextHistoryId=data.history.length>50 ? page.at(-1).id : null;
    loyaltyPatientHistory = loadMore ? [...loyaltyPatientHistory,...page] : preserveHistory
      ? [...new Map([...page,...loyaltyPatientHistory].map(row=>[row.id,row])).values()].sort((a,b)=>b.id-a.id) : page;
    if (!keepControls || !document.getElementById('patient-loyalty-summary')) {
      container.innerHTML = '<div id="patient-loyalty-summary" class="space-y-4"></div><section id="patient-loyalty-controls" class="space-y-4" oninput="loyaltyPatientControlsDirty=true" onchange="loyaltyPatientControlsDirty=true"></section><p id="patient-loyalty-message" class="hidden rounded-xl px-3 py-2 text-sm" role="status"></p><div id="patient-loyalty-history" class="space-y-4"></div>';
      loyaltyPatientControlsDirty = false;
      renderLoyaltyPatientControls();
    } else if (!canManagePatientLoyalty()) {
      document.getElementById('patient-loyalty-controls')?.replaceChildren();
    }
    document.getElementById('patient-loyalty-summary').innerHTML = loyaltySummaryMarkup(data);
    document.getElementById('patient-loyalty-history').innerHTML = loyaltyHistoryMarkup(loyaltyPatientHistory) + (loyaltyNextHistoryId ? '<button type="button" onclick="renderPatientLoyalty(true)" class="min-h-11 rounded-xl border border-slate-200 bg-white px-5 text-sm font-bold">' + loyaltyText('Load older activity','تحميل نشاط أقدم') + '</button>' : '');
    updateLoyaltyRedemptionPreview();
    syncLoyaltyMembershipToggle();
    lucide.createIcons();
  } catch(error) {
    if(token!==loyaltyPatientToken || patientId!==patientWorkspaceId() || sessionId!==currentSession?.user?.id) return;
    if (keepControls && document.getElementById('patient-loyalty-message')) {
      setAdminMessage('patient-loyalty-message',error.message,'error');
    } else {
      container.innerHTML='<div role="alert" class="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-800">' + loyaltyEscape(error.message) + ' <button type="button" onclick="renderPatientLoyalty()" class="min-h-11 px-3 font-bold underline">' + loyaltyText('Retry','إعادة المحاولة') + '</button></div>';
    }
  }
}

function loyaltyToggle(id, label, detail) {
  return `<label class="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-slate-200 p-4"><span><span class="block text-sm font-bold">${label}</span><span class="mt-1 block text-sm text-slate-500">${detail}</span></span><span class="relative inline-flex shrink-0 items-center"><input id="${id}" type="checkbox" class="peer sr-only"/><span class="h-6 w-11 rounded-full bg-slate-300 transition peer-checked:bg-blue-600 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2"></span><span class="pointer-events-none absolute left-1 h-4 w-4 rounded-full bg-white shadow-sm transition peer-checked:translate-x-5"></span></span></label>`;
}

function renderLoyaltySettings() {
  const container=document.getElementById('admin-loyalty-settings');
  if(!container || !loyaltySettings || loyaltySettingsDirty) return;
  const s=loyaltySettings;
  loyaltySettingsEditingVersion=s.version;
  const field=(id,label,value,min,max,step=1)=>`<label class="block text-sm font-bold">${label}<input id="${id}" type="number" required min="${min}" max="${max}" step="${step}" value="${value}" class="mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base font-normal"/></label>`;
  container.innerHTML=`<form onsubmit="saveLoyaltySettings(event)" oninput="loyaltySettingsDirty=true" class="space-y-5"><div class="flex flex-wrap items-start justify-between gap-3"><div><h3 class="text-lg font-black">${loyaltyText('Loyalty program','برنامج الولاء')}</h3><p class="mt-1 text-sm text-slate-500">${loyaltyText('The discount rate applies to all unused points. The earning rate applies to future payments. Existing expiry dates stay the same.','يسري معدل الخصم على جميع النقاط غير المستخدمة، ومعدل الاكتساب على الدفعات الجديدة. تبقى تواريخ الانتهاء السابقة كما هي.')}</p></div><span class="text-sm text-slate-500">${loyaltyText('Rule version ','إصدار القواعد ')}${s.version}</span></div>
    ${loyaltyToggle('loyalty-visible',loyaltyText('Show Loyalty to users','إظهار الولاء للمستخدمين'),loyaltyText('Show the fifth patient tab to users. Administrators can still open it when hidden.','إظهار التبويب الخامس للمستخدمين. يظل بإمكان المسؤولين فتحه عند الإخفاء.'))}
    <div class="grid gap-3 lg:grid-cols-2">${loyaltyToggle('loyalty-earning',loyaltyText('Earn points','اكتساب النقاط'),loyaltyText('Award points on eligible payments after enrollment.','إضافة نقاط على الدفعات المؤهلة بعد الاشتراك.'))}${loyaltyToggle('loyalty-redemption',loyaltyText('Redeem points','استبدال النقاط'),loyaltyText('Allow users with Loyalty access to apply discounts.','السماح للمستخدمين ذوي صلاحية الولاء بتطبيق الخصومات.'))}${loyaltyToggle('loyalty-auto-enroll',loyaltyText('Automatic enrollment','اشتراك تلقائي'),loyaltyText('Enroll patients when their next payment is recorded. No historical points.','اشتراك المريض عند تسجيل دفعته التالية. دون نقاط بأثر رجعي.'))}${loyaltyToggle('loyalty-combine',loyaltyText('Combine with released balances','الجمع مع إعفاءات الرصيد'),loyaltyText('Permit loyalty discounts on invoices with a released amount.','السماح بخصم الولاء على فاتورة تحتوي على مبلغ مُعفى.'))}</div>
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">${field('loyalty-cash-rate',loyaltyText('EGP paid per point','المبلغ المدفوع بالجنيه لكل نقطة'),s.cash_per_point,.01,1000000,.01)}${field('loyalty-point-value',loyaltyText('EGP discount per point','خصم بالجنيه لكل نقطة'),s.point_value,.01,1000000,.01)}${field('loyalty-minimum',loyaltyText('Minimum points to redeem','الحد الأدنى للاستبدال'),s.minimum_redemption,1,1000000)}${field('loyalty-max-percent',loyaltyText('Maximum invoice discount (%)','أقصى خصم للفاتورة (%)'),s.max_invoice_percent,.01,100,.01)}${field('loyalty-expiry',loyaltyText('Expiry in months (0 = no expiry)','الانتهاء بالأشهر (٠ = بدون انتهاء)'),s.expiry_months,0,120)}</div>
    <label class="block text-sm font-bold">${loyaltyText('Excluded treatment codes','أكواد العلاجات المستثناة')}<input id="loyalty-excluded" value="${loyaltyEscape(s.excluded_operation_codes.join(', '))}" placeholder="${loyaltyText('Comma-separated operation codes','أكواد العمليات مفصولة بفواصل')}" class="mt-2 min-h-11 w-full rounded-xl border border-slate-300 px-3 text-base font-normal"/><span class="mt-2 block font-normal text-slate-500">${loyaltyText('Applies to earning and the eligible amount for redemption. Find codes under Customization.','تسري على اكتساب النقاط والمبلغ المؤهل للاستبدال. الأكواد موجودة في التخصيص.')}</span></label>
    <p id="admin-loyalty-settings-message" class="hidden rounded-xl px-3 py-2 text-sm" role="status"></p><div class="flex flex-wrap gap-3"><button type="submit" class="min-h-11 rounded-xl bg-blue-700 px-5 text-sm font-black text-white disabled:opacity-50">${loyaltyText('Save loyalty settings','حفظ إعدادات الولاء')}</button><button type="button" onclick="reloadLoyaltySettings()" class="min-h-11 rounded-xl border border-slate-300 px-5 text-sm font-bold">${loyaltyText('Reload saved settings','إعادة تحميل الإعدادات المحفوظة')}</button></div></form>`;
  for(const [id,key] of [['loyalty-visible','visible'],['loyalty-earning','earning_enabled'],['loyalty-redemption','redemption_enabled'],['loyalty-auto-enroll','auto_enroll'],['loyalty-combine','allow_with_releases']]) document.getElementById(id).checked=s[key];
}

async function reloadLoyaltySettings() {
  loyaltySettingsDirty=false;
  try { await fetchLoyaltySettings(); } catch(error) { setAdminMessage('admin-loyalty-settings-message',error.message,'error'); }
}

async function saveLoyaltySettings(event) {
  event.preventDefault(); if(!hasPageAccess('admin')) return;
  const form=event.target; const button=form.querySelector('[type="submit"]'); button.disabled=true;
  const checked=id=>document.getElementById(id).checked; const value=id=>Number(document.getElementById(id).value);
  const settings={visible:checked('loyalty-visible'),earning_enabled:checked('loyalty-earning'),redemption_enabled:checked('loyalty-redemption'),auto_enroll:checked('loyalty-auto-enroll'),allow_with_releases:checked('loyalty-combine'),cash_per_point:value('loyalty-cash-rate'),point_value:value('loyalty-point-value'),minimum_redemption:value('loyalty-minimum'),max_invoice_percent:value('loyalty-max-percent'),expiry_months:value('loyalty-expiry'),excluded_operation_codes:[...new Set(document.getElementById('loyalty-excluded').value.split(/[,،]/).map(x=>x.trim()).filter(Boolean))]};
  try {
    const {data,error}=await db.rpc('save_loyalty_settings',{p_settings:settings,p_expected_version:loyaltySettingsEditingVersion}); if(error) throw error;
    loyaltySettings=data; loyaltySettingsDirty=false; renderLoyaltySettings(); syncLoyaltyVisibility();
    setAdminMessage('admin-loyalty-settings-message',loyaltyText('Loyalty settings saved.','تم حفظ إعدادات الولاء.'));
    await refreshLoyaltyReport().catch(error=>setAdminMessage('admin-loyalty-message',error.message,'error'));
  } catch(error) { setAdminMessage('admin-loyalty-settings-message',error.message,'error'); }
  finally { button.disabled=false; }
}

async function renderAdminLoyalty() {
  if(!hasPageAccess('admin')) return;
  const root=document.getElementById('admin-panel-loyalty');
  root.dir=currentUiLanguage==='ar'?'rtl':'ltr';
  root.lang=currentUiLanguage;
  if(!root.dataset.initialized) {
    root.innerHTML='<div id="admin-loyalty-settings" class="rounded-2xl border border-slate-200 bg-white p-5"></div><div id="admin-loyalty-report" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"></div><p id="admin-loyalty-message" role="status" class="hidden rounded-xl px-3 py-2 text-sm"></p>';
    root.dataset.initialized='true';
  }
  try { await fetchLoyaltySettings(); await refreshLoyaltyReport(); }
  catch(error) { setAdminMessage('admin-loyalty-message',error.message,'error'); }
}

async function refreshLoyaltyReport() {
  if(!hasPageAccess('admin')) return;
  const {data,error}=await db.rpc('get_loyalty_report'); if(error) throw error;
  document.getElementById('admin-loyalty-report').innerHTML=loyaltyCard(loyaltyText('Active members','الأعضاء النشطون'),loyaltyNumber(data.members))+loyaltyCard(loyaltyText('Points earned / redeemed','النقاط المكتسبة / المستبدلة'),`${loyaltyNumber(data.issued)} / ${loyaltyNumber(data.redeemed)}`)+loyaltyCard(loyaltyText('Outstanding points','النقاط المتبقية'),loyaltyNumber(data.outstanding),formatInvoiceMoney(data.outstanding_value))+loyaltyCard(loyaltyText('Loyalty discounts granted','خصومات الولاء الممنوحة'),formatInvoiceMoney(data.discounts),loyaltyText('Points deficit: ','عجز النقاط: ')+loyaltyNumber(data.deficit));
}

function renderLoyaltyPatientControls() {
  const container=document.getElementById('patient-loyalty-controls');
  if (!container) return;
  if (!canManagePatientLoyalty() || loyaltyControlPatientId!==patientWorkspaceId()) { container.replaceChildren(); return; }
  const data=loyaltyPatientData; if(!data) return;
  container.innerHTML='<h3 class="text-lg font-black text-slate-900">' + loyaltyText('Manage patient loyalty','إدارة ولاء المريض') + '</h3>' + `<label class="flex min-h-16 cursor-pointer items-center justify-between gap-4 rounded-2xl border border-blue-200 bg-blue-50 p-5"><span><span class="block text-base font-black text-blue-950">${loyaltyText('Loyalty membership','عضوية برنامج الولاء')}</span><span class="mt-1 block text-sm text-blue-800">${loyaltyText('On: enrolled and active. Off: membership suspended.','تشغيل: عضوية نشطة. إيقاف: تعليق العضوية.')}</span></span><span class="relative inline-flex shrink-0 items-center"><input id="loyalty-membership-toggle" type="checkbox" role="switch" onchange="toggleLoyaltyMembership(this.checked)" ${data.account?.status==='active' ? 'checked' : ''} ${loyaltyBusy ? 'disabled' : ''} class="peer sr-only" /><span class="h-6 w-11 rounded-full bg-slate-300 transition peer-checked:bg-blue-700 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 peer-disabled:opacity-50"></span><span class="pointer-events-none absolute left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition peer-checked:translate-x-5"></span></span></label><div class="grid gap-4 xl:grid-cols-2">${data.account ? `<form onsubmit="manageLoyaltyPatient(event)" class="space-y-4 rounded-2xl border border-slate-200 bg-white p-5"><h3 class="text-base font-black">${loyaltyText('Adjust points','تعديل النقاط')}</h3><label class="block text-sm font-bold">${loyaltyText('Points (+ add / − deduct)','النقاط (+ إضافة / − خصم)')}<input id="loyalty-adjustment" required type="number" min="-1000000" max="1000000" step="1" value="0" class="mt-2 min-h-11 w-full rounded-xl border border-slate-300 px-3 text-base"/></label><label class="block text-sm font-bold">${loyaltyText('Reason for adjustment','سبب تعديل النقاط')}<input id="loyalty-adjust-reason" required minlength="3" maxlength="500" class="mt-2 min-h-11 w-full rounded-xl border border-slate-300 px-3 text-base"/></label><button type="submit" class="min-h-11 rounded-xl bg-slate-900 px-5 text-sm font-bold text-white disabled:opacity-50">${loyaltyText('Adjust points','تعديل النقاط')}</button></form>` : '<p class="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500">' + loyaltyText('Turn on membership to start earning points.','فعّل العضوية لبدء اكتساب النقاط.') + '</p>'}
    <form onsubmit="redeemLoyalty(event)" class="space-y-4 rounded-2xl border border-blue-200 bg-white p-5"><h3 class="text-base font-black">${loyaltyText('Redeem against an invoice','استبدال النقاط على فاتورة')}</h3><label class="block text-sm font-bold">${loyaltyText('Invoice','الفاتورة')}<select id="loyalty-redeem-invoice" required onchange="updateLoyaltyRedemptionPreview()" class="mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base"><option value="">${loyaltyText('Choose an unpaid invoice…','اختر فاتورة بها رصيد مستحق…')}</option>${loyaltyPatientInvoices.filter(i=>i.status!=='cancelled' && invoiceRemaining(i)>0).map(i=>`<option value="${i.id}">${loyaltyEscape(invoiceNumber(i.id))} · ${loyaltyEscape(formatInvoiceMoney(invoiceRemaining(i)))}</option>`).join('')}</select></label><label class="block text-sm font-bold">${loyaltyText('Points to redeem','النقاط المطلوب استبدالها')}<input id="loyalty-redeem-points" required type="number" min="${loyaltySettings.minimum_redemption}" max="${Math.min(1000000,Number(data.balance))}" step="1" oninput="updateLoyaltyRedemptionPreview()" class="mt-2 min-h-11 w-full rounded-xl border border-slate-300 px-3 text-base"/></label><p id="loyalty-redeem-preview" role="status" class="rounded-xl bg-blue-50 p-4 text-sm text-blue-900"></p><button id="loyalty-redeem-submit" type="submit" disabled class="min-h-11 rounded-xl bg-blue-700 px-5 text-sm font-bold text-white disabled:opacity-50">${loyaltyText('Apply loyalty discount','تطبيق خصم الولاء')}</button></form></div>
    <div class="rounded-2xl border border-slate-200 bg-white p-5"><h3 class="text-base font-black">${loyaltyText('Invoice discounts','خصومات الفواتير')}</h3><div class="mt-3 space-y-3">${data.redemptions.length ? data.redemptions.map(r=>`<div class="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 p-4"><div class="text-sm"><strong>${loyaltyEscape(invoiceNumber(r.invoice_id))} · ${loyaltyEscape(formatInvoiceMoney(r.amount))}</strong><p class="mt-1 text-slate-500">${loyaltyNumber(r.points)} ${loyaltyText('points','نقطة')} · ${loyaltyEscape(formatInvoiceDate(r.created_at.slice(0,10)))}${r.reversed_at ? ' · '+loyaltyText('Reversed','تم العكس') : ''}</p></div>${r.reversed_at ? '' : `<button type="button" onclick="reverseLoyaltyDiscount('${loyaltyEscape(r.id)}')" class="min-h-11 rounded-xl border border-rose-200 px-4 text-sm font-bold text-rose-700">${loyaltyText('Reverse discount','عكس الخصم')}</button>`}</div>`).join('') : `<p class="text-sm text-slate-500">${loyaltyText('No loyalty discounts yet.','لا توجد خصومات ولاء بعد.')}</p>`}</div></div>`;
  updateLoyaltyRedemptionPreview(); lucide.createIcons();
}

function loyaltyRedemptionQuote(data, invoice, points, settings) {
  let needed=Number(points);
  for(const lot of data?.lots || []) { const used=Math.min(needed,Number(lot.points)); if(used<=0) break; needed-=used; }
  const amount=Math.round((Number(points)*Number(settings.point_value)+Number.EPSILON)*100)/100;
  const eligible=invoice?.items.filter(i=>!settings.excluded_operation_codes.includes(i.operationCode)).reduce((sum,i)=>sum+i.unitPrice*i.quantity,0) || 0;
  const limit=Math.max(0,Math.round(eligible*Number(settings.max_invoice_percent))/100-Number(invoice?.loyaltyDiscount || 0));
  const valid=Boolean(invoice && data?.account?.status==='active' && Number(data.account.debt)===0 && settings.redemption_enabled && Number.isInteger(points) && points>=settings.minimum_redemption && points<=data.balance && points<=1000000 && needed<0.00000001 && amount>0 && amount<=limit && amount<=invoiceRemaining(invoice) && (settings.allow_with_releases || !invoice.releasedAmount));
  return {amount,limit,valid};
}

function updateLoyaltyRedemptionPreview() {
  const element=document.getElementById('loyalty-redeem-preview'); if(!element) return;
  const pointsInput=document.getElementById('loyalty-redeem-points');
  pointsInput.min=String(loyaltySettings.minimum_redemption);
  pointsInput.max=String(Math.min(1000000,Number(loyaltyPatientData?.balance || 0)));
  const points=Number(pointsInput.value);
  const invoice=loyaltyPatientInvoices.find(i=>String(i.id)===document.getElementById('loyalty-redeem-invoice').value);
  const quote=loyaltyRedemptionQuote(loyaltyPatientData,invoice,points,loyaltySettings);
  element.textContent=loyaltyText('Discount: ','الخصم: ')+formatInvoiceMoney(quote.amount)+' · '+loyaltyText('Invoice limit: ','حد الفاتورة: ')+formatInvoiceMoney(quote.limit)+(quote.valid ? '' : ' · '+loyaltyText('Choose an eligible invoice and points within the available balance, minimum, and limit.','اختر فاتورة مؤهلة ونقاطًا ضمن الرصيد المتاح والحد الأدنى وحد الفاتورة.'));
  document.getElementById('loyalty-redeem-submit').disabled=!quote.valid || loyaltyBusy;
}

function syncLoyaltyMembershipToggle() {
  const toggle=document.getElementById('loyalty-membership-toggle');
  if (!toggle) return;
  toggle.checked=loyaltyPatientData?.account?.status==='active';
  toggle.disabled=loyaltyBusy || !canManagePatientLoyalty() || loyaltyControlPatientId!==patientWorkspaceId();
}

async function toggleLoyaltyMembership(enabled) {
  if (!canManagePatientLoyalty() || loyaltyBusy || !loyaltyPatientData || loyaltyControlPatientId!==patientWorkspaceId()) { syncLoyaltyMembershipToggle(); return; }
  const active=loyaltyPatientData.account?.status==='active';
  if (Boolean(enabled)===active) { syncLoyaltyMembershipToggle(); return; }
  const action=enabled ? (loyaltyPatientData.account ? 'resume' : 'enroll') : 'suspend';
  await runLoyaltyMutation('manage_loyalty_patient',{p_patient_id:loyaltyControlPatientId,p_action:action,p_points:0,p_reason:null});
  syncLoyaltyMembershipToggle();
}

async function runLoyaltyMutation(action, payload) {
  const patientId=loyaltyControlPatientId;
  const sessionId=currentSession?.user?.id;
  if(loyaltyBusy || !canManagePatientLoyalty() || !patientId || patientId!==patientWorkspaceId()) return;
  if (payload.p_patient_id && payload.p_patient_id!==patientId) return;
  if (action==='reverse_loyalty_redemption' && !loyaltyPatientData?.redemptions.some(row=>row.id===payload.p_redemption_id)) return;
  if(!navigator.onLine) { setAdminMessage('patient-loyalty-message',loyaltyText('Connect to the internet before changing loyalty.','اتصل بالإنترنت قبل تغيير الولاء.'),'error'); return; }
  loyaltyBusy=true;
  syncLoyaltyMembershipToggle();
  // A rules refresh must not turn a retry into a second redemption.
  const requestIdentity={...payload}; delete requestIdentity.p_expected_version;
  const key=JSON.stringify([action,requestIdentity]);
  if(!loyaltyPendingRequest || loyaltyPendingRequest.key!==key) loyaltyPendingRequest={key,id:crypto.randomUUID()};
  const request=action==='reverse_loyalty_redemption' ? payload : {...payload,p_request_id:loyaltyPendingRequest.id};
  document.querySelectorAll('#patient-loyalty-controls button').forEach(e=>e.disabled=true);
  const isCurrentPatient=()=>patientId===patientWorkspaceId() && patientId===loyaltyControlPatientId && sessionId===currentSession?.user?.id && canManagePatientLoyalty();
  try {
    const {error}=await db.rpc(action,request); if(error) throw error;
    if (loyaltyPendingRequest?.key===key) loyaltyPendingRequest=null;
    invalidateLoyaltyInvoiceViews();
    if (isCurrentPatient()) {
      loyaltyPatientControlsDirty=false;
      await renderPatientLoyalty();
      if (isCurrentPatient()) setAdminMessage('patient-loyalty-message',loyaltyText('Loyalty updated.','تم تحديث الولاء.'));
    }
  } catch(error) {
    if (isCurrentPatient()) setAdminMessage('patient-loyalty-message',error.message,'error');
  } finally {
    loyaltyBusy=false;
    syncLoyaltyMembershipToggle();
    document.querySelectorAll('#patient-loyalty-controls button').forEach(e=>e.disabled=false);
    updateLoyaltyRedemptionPreview();
  }
}

async function manageLoyaltyPatient(event) {
  event.preventDefault();
  if (!canManagePatientLoyalty() || loyaltyControlPatientId!==patientWorkspaceId()) return;
  await runLoyaltyMutation('manage_loyalty_patient',{p_patient_id:loyaltyControlPatientId,p_action:'adjust',p_points:Number(document.getElementById('loyalty-adjustment').value),p_reason:document.getElementById('loyalty-adjust-reason').value.trim()});
}
async function redeemLoyalty(event) {
  event.preventDefault();
  if (!canManagePatientLoyalty() || loyaltyControlPatientId!==patientWorkspaceId()) return;
  const points=Number(document.getElementById('loyalty-redeem-points').value);
  const invoice=loyaltyPatientInvoices.find(i=>String(i.id)===document.getElementById('loyalty-redeem-invoice').value);
  const quote=loyaltyRedemptionQuote(loyaltyPatientData,invoice,points,loyaltySettings);
  if(!quote.valid) return;
  if(!confirm(loyaltyText('Apply ','تطبيق ')+formatInvoiceMoney(quote.amount)+loyaltyText(' loyalty discount to ',' خصم ولاء على ')+invoiceNumber(invoice.id)+loyaltyText(' using ',' باستخدام ')+loyaltyNumber(points)+loyaltyText(' points?',' نقطة؟'))) return;
  await runLoyaltyMutation('redeem_loyalty',{p_patient_id:loyaltyControlPatientId,p_invoice_id:Number(invoice.id),p_points:points,p_expected_version:loyaltySettings.version});
}
async function reverseLoyaltyDiscount(id) {
  if (!canManagePatientLoyalty() || loyaltyControlPatientId!==patientWorkspaceId()) return;
  const reason=prompt(loyaltyText('Reason for reversing this loyalty discount (at least 3 characters):','سبب عكس خصم الولاء (٣ أحرف على الأقل):'));
  if(!reason?.trim()) return;
  await runLoyaltyMutation('reverse_loyalty_redemption',{p_redemption_id:id,p_reason:reason.trim()});
}
