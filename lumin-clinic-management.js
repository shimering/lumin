/* Clinic overview and day settlement. Uses existing HR payment confirmation and server guards. */
(function (host) {
  'use strict';
  const state = { actor:'', token:0, payrollToken:0, report:null, payroll:null, team:null, alerts:[], alertView:'alerts', start:'', end:'', preset:'today', day:'', calendarDay:'', doctor:'', page:1, onlyUnpaid:false, loading:false, payrollLoading:false,paying:false,loadedAt:0,error:'',payrollError:'' };
  const el = id => document.getElementById(id);
  const text = (en,ar) => typeof currentUiLanguage !== 'undefined' && currentUiLanguage === 'ar' ? ar : en;
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const money = value => formatInvoiceMoney(number(value));
  const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const icons = () => { if(host.lucide) host.lucide.createIcons(); };
  const allowed = page => typeof hasPageAccess === 'function' && hasPageAccess(page);
  const actor = () => typeof currentSession === 'undefined' ? '' : currentSession?.user?.id || '';
  const signature = () => `${actor()}:${['finances','analytics','hr'].map(allowed).join(':')}:${typeof currentUserAccess !== 'undefined' && (currentUserAccess?.isAdmin || currentUserAccess?.permissions?.has('finance_depts'))}`;
  const today = () => typeof hrClinicDateValue === 'function' ? hrClinicDateValue() : new Date().toISOString().slice(0,10);
  const validDay = value => { if(!/^\d{4}-\d{2}-\d{2}$/.test(value || ''))return false;const d=new Date(value+'T12:00:00Z');return !Number.isNaN(d.valueOf())&&d.toISOString().slice(0,10)===value; };
  function validRange(start,end) { return validDay(start)&&validDay(end)&&start<=end&&(new Date(end+'T12:00Z')-new Date(start+'T12:00Z'))/86400000<=365; }
  function presetRange(preset,day=today()) {
    if(!validDay(day))return null;
    const date=new Date(day+'T12:00:00Z');
    const shift=days=>new Date(date.valueOf()+days*86400000).toISOString().slice(0,10);
    if(preset==='today')return {start:day,end:day};
    if(preset==='yesterday')return {start:shift(-1),end:shift(-1)};
    if(preset==='last7')return {start:shift(-6),end:day};
    if(preset==='month')return {start:day.slice(0,7)+'-01',end:day};
    if(preset==='lastMonth'){
      date.setUTCDate(0);const end=date.toISOString().slice(0,10);
      return {start:end.slice(0,7)+'-01',end};
    }
    if(preset==='year')return {start:day.slice(0,4)+'-01-01',end:day};
    return null;
  }
  function cumulativeDays(days) { let income=0,expense=0; return (Array.isArray(days)?days:[]).map(row=>({day:row.day,income:income+=number(row.income),expense:expense+=number(row.expense)})); }
  function payrollTotals(rows) { return rows.reduce((totals,row)=>{if(row.payment_id)totals.paid+=number(row.doctor_amount);else if(row.transferred)totals.ready+=number(row.doctor_amount);else totals.pending+=number(row.doctor_amount);return totals;},{ready:0,pending:0,paid:0}); }
  const button = (label, action, name='arrow-up-right', extra='') => `<button type="button" class="cm-button ${extra}" onclick="LuminClinicManagement.${action}">${icon(name)}${label}</button>`;
  const empty = (title,description,name='circle-check',action='') => `<div class="cm-empty"><span class="cm-icon">${icon(name)}</span><h4>${title}</h4><p>${description}</p>${action}</div>`;
  function reset() {
    state.token++;state.payrollToken++;closeAlerts(false);
    Object.assign(state,{actor:'',report:null,payroll:null,team:null,alerts:[],alertView:'alerts',loadedAt:0,error:'',payrollError:'',loading:false,payrollLoading:false,paying:false,doctor:'',day:'',calendarDay:'',start:'',end:'',preset:'today',page:1,onlyUnpaid:false});
    for(const id of ['cm-stats','cm-payroll-rows','cm-team-content','cm-expense-breakdown','cm-cash-chart','cm-alert-body'])if(el(id))el(id).replaceChildren();
    if(el('cm-alert-bell')){el('cm-alert-bell').classList.remove('has-alerts');el('cm-alert-count').hidden=true;}
  }
  function init() {
    if(!el('view-clinic-overview'))return;
    if(!el('cm-alert-menu')){
      const menu=document.createElement('section');menu.id='cm-alert-menu';menu.className='cm-alert-menu';menu.hidden=true;
      menu.setAttribute('role','dialog');menu.setAttribute('aria-labelledby','cm-alert-heading');
      menu.innerHTML='<div id="cm-alert-menu-header" class="cm-alert-menu-header"></div><div id="cm-alert-body" class="cm-alert-body"></div>';
      document.body.appendChild(menu);
    }
    if(!state.start){state.day=today();state.start=state.day;state.end=state.day;}
    renderStatic();render();
  }
  function renderStatic() {
    if(!el('view-clinic-overview'))return;
    el('clinic-management-tab-overview').querySelector('span').textContent=text('Overview','نظرة عامة');
    el('cm-refresh').setAttribute('aria-label',text('Refresh clinic overview','تحديث نظرة عامة على العيادة'));
    const focused=document.activeElement?.id;
    const presets=[['today',text('Today','اليوم')],['yesterday',text('Yesterday','أمس')],['last7',text('Last 7 days','آخر ٧ أيام')],['month',text('This month','هذا الشهر')],['lastMonth',text('Last month','الشهر الماضي')],['year',text('This year','هذا العام')],['custom',text('Custom','فترة مخصصة')]];
    el('cm-range-toolbar').innerHTML=`<div class="cm-range"><select id="cm-range-preset" class="cm-select" aria-label="${text('Date range','الفترة الزمنية')}" onchange="LuminClinicManagement.setRangePreset(this.value)">${presets.map(([value,label])=>`<option value="${value}" ${state.preset===value?'selected':''}>${label}</option>`).join('')}</select><label><span>${text('From','من')}</span><input id="cm-start-date" class="cm-input" type="date" value="${esc(state.start)}" oninput="LuminClinicManagement.rangeChanged()"></label><label><span>${text('To','إلى')}</span><input id="cm-end-date" class="cm-input" type="date" value="${esc(state.end)}" oninput="LuminClinicManagement.rangeChanged()"></label>${button(text('Apply','تطبيق'),'applyRange()','check')}</div>`;
    el('cm-payroll-panel').hidden=!allowed('hr');el('cm-team-panel').hidden=!allowed('hr');
    const financial=allowed('finances')||allowed('analytics');el('cm-cash-panel').hidden=!financial;el('cm-expense-panel').hidden=!financial;
    el('cm-payroll-title').innerHTML=`<div class="cm-heading-icon"><span class="cm-icon">${icon('stethoscope')}</span><h3 id="cm-payroll-heading">${text('Doctor day payroll','راتب الطبيب ليوم واحد')}</h3></div>`;
    el('cm-payroll-note').innerHTML=`${icon('info')}<span>${text('Completed, invoiced procedures enter payroll automatically and wait for payment in HR.','تُضاف الإجراءات المكتملة والمفوترة للراتب تلقائياً وتنتظر الدفع في الموارد البشرية.')}</span>`;
    el('cm-cash-title').innerHTML=`<div><h3 id="cm-cash-heading">${text('Cash performance','الأداء النقدي')}</h3><p>${text('Cumulative recorded receipts and paid expenses in the selected period','المقبوضات والمصروفات المدفوعة التراكمية خلال الفترة المحددة')}</p></div>${allowed('analytics')?button(text('Open Analytics','فتح التحليلات'),"navigate('analytics')",'chart-no-axes-combined'):''}`;
    el('cm-expense-title').innerHTML=`<div><h3 id="cm-expense-heading">${text('Expense breakdown','تفصيل المصروفات')}</h3><p>${text('Paid in this period','المدفوع خلال هذه الفترة')}</p></div>${allowed('finances')?button(text('View expenses','عرض المصروفات'),"navigate('expenses')",'receipt-text','cm-button-quiet'):''}`;
    el('cm-team-title').innerHTML=`<div><h3 id="cm-team-heading">${text('Team & payroll','الفريق والرواتب')}</h3><p>${text('Payroll month','شهر الرواتب')}: ${typeof currentHrMonth==='function'?esc(currentHrMonth()):''}</p></div>${button(text('Open HR','فتح الموارد البشرية'),"navigate('hr')",'users-round','cm-button-quiet')}`;
    el('cm-alert-menu-header').innerHTML=`<span class="cm-icon cm-icon-rose">${icon('bell-ring')}</span><div><h3 id="cm-alert-heading">${text('Action center','مركز التنبيهات')}</h3><p class="cm-muted">${text('Items that need your attention','بنود تحتاج إلى مراجعتك')}</p></div><button class="cm-button cm-button-icon" type="button" onclick="LuminClinicManagement.closeAlerts()" aria-label="${text('Close alerts','إغلاق التنبيهات')}">${icon('x')}</button>`;
    if(focused?.startsWith('cm-'))el(focused)?.focus();icons();
  }
  function render() {
    if(!el('view-clinic-overview'))return;
    renderStats();renderPayroll();renderFinance();renderTeam();renderAlerts();
    const error=el('cm-overview-error');error.hidden=!state.error;error.className=state.error?'cm-error':'';
    error.innerHTML=state.error?`${icon('triangle-alert')}<span>${text('Could not refresh the overview. Please try again.','تعذر تحديث النظرة العامة. يرجى المحاولة مرة أخرى.')}</span>${button(text('Retry','إعادة المحاولة'),'refresh({force:true})','refresh-cw')}`:'';
    if(state.error)error.setAttribute('role','alert');else error.removeAttribute('role');
    icons();
  }
  function renderStats() {
    const finance=state.report?.finance;const items=[];
    if(allowed('finances')||allowed('analytics')){
      items.push([text('Collected income','الدخل المحصل'),finance?.income_total,'coins','green',text('Recorded payments in this period','المقبوضات المسجلة في هذه الفترة')]);
      items.push([text('Paid expenses','المصروفات المدفوعة'),finance?.expense_total,'wallet-cards','',text('Actual payment dates','تواريخ الدفع الفعلية')]);
      items.push([text('Net cash flow','صافي التدفق النقدي'),finance?.net_total,'arrow-left-right','rose',text('Income less paid expenses','المقبوضات ناقص المصروفات المدفوعة')]);
    }
    if(finance?.debt_total!=null)items.push([text('Patient balances','أرصدة المرضى'),finance.debt_total,'users-round','amber',`${number(finance.debt_patient_count)} ${text('patients · All outstanding','مريض · جميع المستحقات')}`]);
    el('cm-stats').hidden=!items.length;el('cm-stats').style.setProperty('--cm-stat-count',String(Math.max(1,items.length)));el('cm-stats').innerHTML=items.map(([label,value,name,tint,detail])=>`<article class="cm-panel cm-stat"><span class="cm-icon ${tint?'cm-icon-'+tint:''}">${icon(name)}</span><div><span class="cm-stat-label">${label}</span><div class="cm-stat-value">${value==null?'—':esc(money(value))}</div><div class="cm-stat-detail">${detail}</div></div></article>`).join('');
  }
  function renderPayroll() {
    if(!allowed('hr'))return;
    const data=state.payroll;const focused=document.activeElement?.id;
    const doctors=data?.doctors || [];
    const controls=el('cm-payroll-controls');
    // Preserve active controls during background refreshes.
    if(!controls.querySelector('#cm-doctor')||controls.dataset.language!==text('en','ar')||controls.dataset.doctors!==JSON.stringify(doctors)){
      controls.dataset.language=text('en','ar');controls.dataset.doctors=JSON.stringify(doctors);
      controls.innerHTML=`<select id="cm-doctor" class="cm-select" aria-label="${text('Doctor','الطبيب')}" onchange="LuminClinicManagement.setDoctor(this.value)">${doctors.length?doctors.map(d=>`<option value="${esc(d.id)}" ${d.id===state.doctor?'selected':''}>${esc(d.name)}</option>`).join(''):`<option value="">${text('Choose a doctor','اختر طبيبًا')}</option>`}</select><input id="cm-payroll-day" class="cm-input" aria-label="${text('Completion date','تاريخ الإكمال')}" type="date" value="${esc(state.day)}" onchange="LuminClinicManagement.setDay(this.value)"><select id="cm-payroll-filter" class="cm-select" aria-label="${text('Payment status','حالة الدفع')}" onchange="LuminClinicManagement.setUnpaid(this.value==='unpaid')"><option value="all">${text('All procedures','جميع الإجراءات')}</option><option value="unpaid" ${state.onlyUnpaid?'selected':''}>${text('Awaiting payment','بانتظار الدفع')}</option></select>`;
      if(focused?.startsWith('cm-'))el(focused)?.focus();
    }
    el('cm-doctor').disabled=state.paying;el('cm-payroll-day').disabled=state.paying;el('cm-payroll-filter').disabled=state.paying;
    el('cm-payroll-summary').innerHTML=`<div><span>${text('Ready to pay','جاهز للدفع')}</span><strong>${state.payrollLoading?'—':esc(money(data?.ready_amount))}</strong></div><div><span>${text('Awaiting payment','بانتظار الدفع')}</span><strong>${state.payrollLoading?'—':number(data?.ready_count)}</strong></div><div><span>${text('Invoices','الفواتير')}</span><strong>${state.payrollLoading?'—':number(data?.invoice_count)}</strong></div>`;
    const rows=el('cm-payroll-rows');rows.setAttribute('aria-busy',String(state.payrollLoading));rows.setAttribute('aria-label',text('Doctor invoice procedures','إجراءات فواتير الطبيب'));
    if(state.payrollLoading&&!data)rows.innerHTML='<div class="cm-skeleton cm-skeleton-row"></div><div class="cm-skeleton cm-skeleton-row"></div><div class="cm-skeleton cm-skeleton-row"></div>';
    else if(state.payrollError)rows.innerHTML=empty(text('Could not load doctor payroll','تعذر تحميل راتب الطبيب'),text('Retry to review this day before payment.','أعد المحاولة لمراجعة هذا اليوم قبل الدفع.'),'triangle-alert',button(text('Retry','إعادة المحاولة'),'loadPayroll()','refresh-cw'));
    else if(!data?.rows?.length)rows.innerHTML=empty(text('No procedures for this day','لا توجد إجراءات لهذا اليوم'),text('Choose another completion date or doctor to review their invoices.','اختر تاريخ إكمال أو طبيبًا آخر لمراجعة فواتيره.'),'receipt-text');
    else {
      const headers=[text('Patient / Invoice','المريض / الفاتورة'),text('Procedure','الإجراء'),text('Invoice item','بند الفاتورة'),text('Doctor amount','مستحق الطبيب'),text('Payroll','الراتب')];
      const oldScroll=rows.scrollTop;
      rows.innerHTML=`<div class="cm-invoice-header" aria-hidden="true">${headers.map((label,i)=>`<span ${i===2||i===3?'class="cm-amount"':''}>${label}</span>`).join('')}<span></span></div>`+data.rows.map(row=>{
        const paid=Boolean(row.payment_id);const status=paid?text('Paid','مدفوع'):row.transferred?text('Awaiting payment','بانتظار الدفع'):text('Needs HR review','تحتاج مراجعة الموارد البشرية');
        const name=String(row.patient_name || text('Patient','مريض'));const initials=name.trim().split(/\s+/).slice(0,2).map(s=>Array.from(s)[0]).join('');
        const operation=typeof dentalTranslate==='function'?dentalTranslate(row.operation_name,currentUiLanguage):row.operation_name;
        const invoiceLabel=typeof invoiceNumber==='function'?invoiceNumber(row.invoice_id):'#'+row.invoice_id;
        const view=typeof canViewPatientInvoices==='function'&&canViewPatientInvoices();
        return `<article class="cm-invoice-row"><div class="cm-patient"><span class="cm-avatar" aria-hidden="true">${esc(initials)}</span><div><strong>${esc(name)}</strong><small>${esc(invoiceLabel)}</small></div></div><div class="cm-procedure">${esc(operation)}${row.tooth?`<small>${text('Tooth','السن')} ${esc(row.tooth)}</small>`:''}</div><div class="cm-amount" data-label="${headers[2]}">${esc(money(row.invoice_amount))}</div><div class="cm-amount" data-label="${headers[3]}"><strong>${esc(money(row.doctor_amount))}</strong></div><div class="cm-transfer"><span class="cm-pill ${paid?'cm-pill-green':'cm-pill-amber'}">${status}</span>${row.transferred&&!paid?`<small>${text('Unpaid','غير مدفوع')}</small>`:''}</div>${view?`<button type="button" class="cm-button cm-button-icon" data-patient="${esc(row.patient_id)}" data-invoice="${esc(row.invoice_id)}" onclick="LuminClinicManagement.openInvoice(this.dataset.patient,this.dataset.invoice)" aria-label="${esc(text('View invoice','عرض الفاتورة')+' '+invoiceLabel)}">${icon('external-link')}</button>`:'<span></span>'}</article>`;
      }).join('');rows.scrollTop=oldScroll;
    }
    const pages=Math.max(1,Math.ceil(number(data?.total_count)/20));
    el('cm-payroll-pager').innerHTML=pages>1?`${button(text('Previous','السابق'),'setPage(-1)','chevron-left')}<span>${state.page} / ${pages}</span>${button(text('Next','التالي'),'setPage(1)','chevron-right')}`:'';
    if(pages>1){const buttons=el('cm-payroll-pager').querySelectorAll('button');buttons[0].disabled=state.page<=1||state.payrollLoading;buttons[1].disabled=state.page>=pages||state.payrollLoading;}
    const doctor=doctors.find(d=>d.id===state.doctor);const hrLabel=doctor?`${text('Open','فتح')} ${esc(doctor.name)} ${text('in HR','في الموارد البشرية')}`:text('Open doctor in HR','فتح الطبيب في الموارد البشرية');
    el('cm-payroll-footer').innerHTML=`${button(hrLabel,'openDoctor()','external-link')}${button(`${text('Pay day payroll','دفع راتب اليوم')} · ${esc(money(data?.ready_amount))}`,'payDay()','wallet-cards','cm-button-primary')}`;
    const footerButtons=el('cm-payroll-footer').querySelectorAll('button');footerButtons[0].disabled=!state.doctor||state.paying;
    footerButtons[1].disabled=!state.doctor||state.paying||state.payrollLoading||Boolean(state.payrollError)||!canModifyHr()||number(data?.ready_amount)<=0;
  }
  function renderFinance() {
    const finance=state.report?.finance;
    if(!finance){el('cm-cash-chart').innerHTML=state.loading?'<div class="cm-skeleton"></div>':empty(text('No cash data available','لا تتوفر بيانات نقدية'),text('Refresh to load recorded receipts and expenses.','حدّث لتحميل المقبوضات والمصروفات المسجلة.'),'chart-no-axes-combined');el('cm-expense-breakdown').replaceChildren();return;}
    const categories=finance.expense_types || [];const total=number(finance.expense_total);
    el('cm-expense-breakdown').innerHTML=categories.length?categories.map(row=>`<div class="cm-breakdown-row"><span>${esc(currentUiLanguage==='ar'&&typeof arabicUiPhrase==='function'?arabicUiPhrase(row.name):row.name)}</span><div class="cm-bar" aria-hidden="true"><span style="width:${Math.min(100,total>0?number(row.amount)/total*100:0)}%"></span></div><span class="cm-amount">${esc(money(row.amount))}</span></div>`).join(''):empty(text('No paid expenses','لا توجد مصروفات مدفوعة'),text('Paid expenses in this period will appear here.','ستظهر هنا المصروفات المدفوعة في هذه الفترة.'),'receipt-text');
    drawChart();
  }
  function drawChart() {
    const root=el('cm-cash-chart');if(!root||!state.report?.finance)return;
    const finance=state.report.finance;const series=cumulativeDays(finance.days);
    if(!series.length||(!number(finance.income_total)&&!number(finance.expense_total))){root.innerHTML=empty(text('No cash movement','لا توجد حركة نقدية'),text('Choose a different date range to inspect receipts and expenses.','اختر فترة أخرى لعرض المقبوضات والمصروفات.'),'chart-no-axes-combined');return;}
    const width=Math.max(260,root.clientWidth-48),height=240,left=62,right=28,top=24,bottom=36,plotWidth=width-left-right,plotHeight=height-top-bottom;
    const max=Math.max(1,...series.flatMap(row=>[row.income,row.expense]));const ceiling=Math.ceil(max/4)*4;
    const x=i=>left+(series.length===1?plotWidth/2:i/(series.length-1)*plotWidth),y=value=>top+plotHeight-number(value)/ceiling*plotHeight;
    const path=field=>series.map((row,i)=>`${i?'L':'M'}${x(i).toFixed(2)} ${y(row[field]).toFixed(2)}`).join(' ');
    const compact=new Intl.NumberFormat(currentUiLanguage==='ar'?'ar-EG':'en-US',{notation:'compact',maximumFractionDigits:1});
    let marks='';for(let i=0;i<=4;i++){const value=ceiling*i/4;marks+=`<line class="cm-grid-line" x1="${left}" x2="${width-right}" y1="${y(value)}" y2="${y(value)}"/><text x="${left-10}" y="${y(value)+4}" text-anchor="end">${esc(compact.format(value))}</text>`;}
    const tickCount=width<420?3:5;const indices=[...new Set(Array.from({length:tickCount},(_,i)=>Math.round(i/(tickCount-1)*(series.length-1))))];
    for(const index of indices){const d=series[index].day;const label=LuminDates.format(d);marks+=`<text x="${x(index)}" y="${height-8}" text-anchor="${index===0?'start':index===series.length-1?'end':'middle'}">${esc(label)}</text>`;}
    const last=series.at(-1);const lastX=x(series.length-1);
    root.innerHTML=`<div class="cm-toolbar"><span class="cm-muted">${text('Collected','المحصل')}: <strong>${esc(money(finance.income_total))}</strong></span><span class="cm-muted">${text('Paid','المدفوع')}: <strong>${esc(money(finance.expense_total))}</strong></span></div><svg class="cm-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(text('Cumulative cash receipts and paid expenses','المقبوضات والمصروفات المدفوعة التراكمية'))}"><title>${esc(text('Collected income and paid expenses','الدخل المحصل والمصروفات المدفوعة'))}</title><desc>${esc(money(finance.income_total))} / ${esc(money(finance.expense_total))}</desc><text x="${left}" y="14">${text('EGP','ج.م')}</text>${marks}<path d="${path('income')} L${lastX} ${y(0)} L${x(0)} ${y(0)}Z" fill="#2563eb" opacity=".06"/><path d="${path('income')}" fill="none" stroke="#2563eb" stroke-width="2.5"/><path d="${path('expense')}" fill="none" stroke="#94a3b8" stroke-width="2.5"/><circle cx="${lastX}" cy="${y(last.income)}" r="4" fill="#2563eb"/><circle cx="${lastX}" cy="${y(last.expense)}" r="4" fill="#94a3b8"/></svg><div class="cm-legend"><span><i></i>${text('Collected','المحصل')}</span><span><i class="cm-expense-dot"></i>${text('Paid expenses','المصروفات المدفوعة')}</span></div>${number(finance.legacy_expense_total)>0?`<p class="cm-muted">${text('Older payments without installment history use the recorded expense date.','تستخدم الدفعات القديمة بدون سجل أقساط تاريخ المصروف المسجل.')}</p>`:''}`;
  }
  function captureTeam() {
    const users=hrDirectoryUsers.filter(user=>user.active);let balance=0,pending=0;
    for(const user of users){const metric=user.isDoctor?hrDoctorMetrics(user):hrUserMetrics(user);const due=user.isDoctor?number(metric.salary):metric.paid?0:Math.max(0,number(metric.salary));balance+=due;if(due>0)pending++;}
    const date=today();return {month:currentHrMonth(),active:users.length,checked:new Set(hrAttendanceSessions.filter(s=>s.work_date===date&&s.check_in_at).map(s=>s.user_id)).size,
      incomplete:hrAttendanceSessions.filter(s=>s.work_date<date&&s.check_in_at&&!s.check_out_at).length,balance,pending,
      advances:hrSalaryAdvances.reduce((sum,s)=>sum+number(s.amount),0),status:hrPayrollPeriod?.status||'draft'};
  }
  function renderTeam() {
    if(!allowed('hr'))return;const team=state.team;
    el('cm-team-content').innerHTML=team?`<div class="cm-team-row"><span>${text('Checked in today','الحضور اليوم')}</span><strong>${team.checked} / ${team.active}</strong></div><div class="cm-team-row"><span>${text('Unpaid salary balance','رصيد الرواتب غير المدفوع')}</span><strong>${esc(money(team.balance))}</strong></div><div class="cm-team-row"><span>${text('Salary advances','سلف الرواتب')}</span><strong>${esc(money(team.advances))}</strong></div><div class="cm-team-row"><span>${text('Payroll status','حالة الرواتب')} · ${esc(team.month)}</span><span class="cm-pill ${team.status==='locked'?'cm-pill-green':'cm-pill-amber'}">${esc({draft:text('Draft','مسودة'),reviewed:text('Reviewed','تمت المراجعة'),locked:text('Locked','مغلق')}[team.status]||team.status)}</span></div>`:empty(text('HR data unavailable','بيانات الموارد البشرية غير متاحة'),text('Refresh to load attendance and payroll.','حدّث لتحميل الحضور والرواتب.'),'users-round');
  }
  function buildAlerts() {
    const alerts=[];const finance=state.report?.finance,hr=state.report?.hr,team=state.team;
    if(allowed('hr')&&number(hr?.payroll_invoice_count)>0)alerts.push({key:'payments',name:'receipt-text',tint:'amber',title:text('Doctor payroll awaiting payment','رواتب أطباء بانتظار الدفع'),detail:`${number(hr.payroll_invoice_count)} ${text('invoices','فاتورة')} · ${number(hr.payroll_doctor_count)} ${text('doctors','أطباء')} · ${money(hr.payroll_amount)}`,note:text('Included automatically after completion and invoicing','تُضاف تلقائياً بعد الإكمال والفوترة'),action:text('Review doctor payments','مراجعة مستحقات الأطباء')});
    if(allowed('finances')&&number(finance?.debt_patient_count)>0)alerts.push({key:'balances',name:'users-round',tint:'rose',title:text('Patient balance follow-ups','متابعة أرصدة المرضى'),detail:`${number(finance.debt_patient_count)} ${text('patients','مريض')} · ${money(finance.debt_total)}`,action:text('Review balances','مراجعة الأرصدة')});
    if(allowed('finances')&&number(finance?.unpaid_expense_count)>0)alerts.push({key:'expenses',name:'receipt',tint:'amber',title:text('Expenses awaiting payment','مصروفات بانتظار الدفع'),detail:`${number(finance.unpaid_expense_count)} ${text('expenses','مصروف')} · ${money(finance.unpaid_expense_total)}`,action:text('Review expenses','مراجعة المصروفات')});
    if(allowed('hr')&&team?.pending>0&&team.status==='draft')alerts.push({key:'payroll',name:'users-round',tint:'violet',title:text('Payroll needs review','الرواتب تحتاج إلى مراجعة'),detail:`${team.pending} ${text('team members','أعضاء الفريق')} · ${team.month}`,action:text('Open payroll','فتح الرواتب')});
    if(allowed('hr')&&team?.incomplete>0)alerts.push({key:'attendance',name:'clock',tint:'amber',title:text('Incomplete attendance records','سجلات حضور غير مكتملة'),detail:`${team.incomplete} ${text('past shifts missing check-out','ورديات سابقة بدون تسجيل انصراف')}`,action:text('Open attendance','فتح الحضور')});
    return alerts;
  }
  function renderAlerts() {
    state.alerts=buildAlerts();const bell=el('cm-alert-bell'),count=el('cm-alert-count');if(!bell)return;
    bell.classList.toggle('has-alerts',state.alerts.length>0);count.hidden=!state.alerts.length;count.textContent=String(state.alerts.length);
    bell.setAttribute('aria-label',`${text('Action center','مركز التنبيهات')}: ${state.alerts.length} ${text('alerts','تنبيهات')}`);
    el('cm-alert-body').innerHTML=state.alerts.length?state.alerts.map(a=>`<article class="cm-alert-row"><span class="cm-icon cm-icon-${a.tint}">${icon(a.name)}</span><div><h4>${a.title}</h4><p>${esc(a.detail)}</p>${a.note?`<p>${a.note}</p>`:''}${button(a.action,`reviewAlert('${a.key}')`,'arrow-up-right','cm-button-quiet')}</div></article>`).join(''):empty(text('All caught up','لا توجد تنبيهات'),text('No actionable alerts in the current clinic records.','لا توجد تنبيهات تحتاج إجراء في سجلات العيادة الحالية.'),'circle-check');
    if(state.error)el('cm-alert-body').innerHTML=`<div class="cm-error">${text('Alerts could not be refreshed.','تعذر تحديث التنبيهات.')}${button(text('Retry','إعادة المحاولة'),'refresh({force:true})','refresh-cw')}</div>`+el('cm-alert-body').innerHTML;
    if(state.alertView==='payments')renderPaymentPreview();
    if(!el('cm-alert-menu').hidden)positionAlerts();
  }
  async function refresh(options={}) {
    if(!allowed('clinic-management')||!actor()||!['finances','analytics','hr'].some(allowed))return;
    if(!el('cm-alert-menu'))init();
    const context=signature();if(state.actor&&state.actor!==context){reset();init();}state.actor=context;
    if(!state.start){state.day=today();state.start=state.day;state.end=state.day;}
    const currentDay=today(),range=presetRange(state.preset,currentDay);
    if(state.calendarDay&&state.calendarDay!==currentDay&&state.day===state.calendarDay&&!state.paying){state.day=currentDay;state.payroll=null;state.page=1;}
    state.calendarDay=currentDay;
    if(range&&(range.start!==state.start||range.end!==state.end)){state.start=range.start;state.end=range.end;state.report=null;state.loadedAt=0;}
    renderStatic();
    if(!options.force&&state.report&&Date.now()-state.loadedAt<30000){render();if(allowed('hr')&&!state.payroll)await loadPayroll();return;}
    const token=++state.token;state.loading=true;render();el('cm-refresh').disabled=true;
    const jobs=[db.rpc('get_clinic_management_overview',{p_start_date:state.start,p_end_date:state.end})];
    if(allowed('hr'))jobs.push(refreshHrDirectory({refresh:Boolean(options.force)}));
    const results=await Promise.allSettled(jobs);
    if(token!==state.token||context!==signature())return;
    const overview=results[0];state.loading=false;
    if(overview.status==='fulfilled'&&!overview.value.error){state.report=overview.value.data;state.error='';state.loadedAt=Date.now();}else{state.error='load';state.loadedAt=0;}
    if(allowed('hr')){const hr=results[1];state.team=hr?.status==='fulfilled'&&hr.value===true?captureTeam():null;}
    render();el('cm-refresh').disabled=false;
    if(allowed('hr'))await loadPayroll();
  }
  async function loadPayroll() {
    if(!allowed('hr')||!actor()||!validDay(state.day)||state.paying)return;
    const token=++state.payrollToken,context=signature(),doctor=state.doctor,day=state.day;
    state.payrollLoading=true;state.payrollError='';renderPayroll();icons();
    try{
      const {data,error}=await db.rpc('get_clinic_doctor_day_payroll',{p_day:day,p_user_id:doctor||null,p_page:state.page,p_page_size:20,p_untransferred_only:state.onlyUnpaid});
      if(token!==state.payrollToken||context!==signature()||doctor!==state.doctor||day!==state.day)return;
      if(error)throw error;state.payroll=data;state.doctor=data?.doctor_id||'';
    }catch(_){if(token!==state.payrollToken||context!==signature())return;state.payroll=null;state.payrollError='load';}
    finally{if(token===state.payrollToken&&context===signature()){state.payrollLoading=false;renderPayroll();icons();}}
  }
  async function applyRange() {
    const start=el('cm-start-date').value,end=el('cm-end-date').value;
    if(!validRange(start,end)){const error=el('cm-overview-error');error.hidden=false;error.className='cm-error';error.setAttribute('role','alert');error.textContent=text('Choose a valid date range of up to 366 days.','اختر فترة صحيحة لا تزيد على 366 يومًا.');return;}
    state.start=start;state.end=end;state.report=null;await refresh({force:true});
  }
  function setDoctor(value){if(state.paying)return;state.doctor=value;state.page=1;state.payroll=null;void loadPayroll();}
  function rangeChanged(){state.preset='custom';el('cm-range-preset').value='custom';}
  async function setRangePreset(value) {
    if(value==='custom'){state.preset=value;return;}
    const range=presetRange(value);if(!range)return;
    state.preset=value;state.start=range.start;state.end=range.end;state.report=null;await refresh({force:true});
  }
  function setDay(value){if(state.paying)return;if(!validDay(value)){el('cm-payroll-day').value=state.day;return;}state.day=value;state.page=1;state.payroll=null;void loadPayroll();}
  function setUnpaid(value){if(state.paying)return;state.onlyUnpaid=Boolean(value);state.page=1;void loadPayroll();}
  function setPage(delta){if(state.payrollLoading||state.paying)return;const pages=Math.max(1,Math.ceil(number(state.payroll?.total_count)/20));state.page=Math.min(pages,Math.max(1,state.page+delta));el('cm-payroll-rows').scrollTop=0;void loadPayroll();}
  async function payDay() {
    if(!canModifyHr()||state.payrollLoading||state.paying||!state.doctor||!validDay(state.day)||state.payrollError||number(state.payroll?.ready_amount)<=0)return;
    const doctor=state.doctor,day=state.day,context=signature();
    // Refresh the full-day total before confirmation; paging/filtering never defines settlement.
    await loadPayroll();if(context!==signature()||doctor!==state.doctor||day!==state.day||state.payrollError)return;
    const amount=Math.round(number(state.payroll?.ready_amount)*100)/100;if(amount<=0)return;
    const name=state.payroll.doctors.find(d=>d.id===doctor)?.name||'';state.paying=true;renderPayroll();icons();
    try{
      const paid=await openHrSalaryPaymentDialog({amount,recipients:[name],summary:`${text('Single day','يوم واحد')} · ${LuminDates.format(day)} · ${number(state.payroll.ready_count)} ${text('completed procedures','إجراءات مكتملة')}`,
        pay:async methodId=>{if(context!==signature()||!canModifyHr())throw new Error(text('HR access changed. Reopen the payment.','تغيرت صلاحية الموارد البشرية. افتح الدفع مجددًا.'));const {error}=await db.rpc('hr_pay_doctor_procedures_with_method',{p_user_id:doctor,p_scope:'day',p_start_date:day,p_end_date:day,p_finding_ids:null,p_payment_method_id:methodId,p_expected_amount:amount});if(error)throw error;}});
      if(paid&&context===signature()){showAppointmentNotificationToast(text('Doctor salary paid','تم دفع راتب الطبيب'),text('The selected day was settled and a linked Salary expense was added.','تمت تسوية اليوم المحدد وإضافة مصروف راتب مرتبط.'));state.loadedAt=0;}
    }finally{state.paying=false;if(context===signature())await refresh({force:true});}
  }
  async function openDoctor() {
    if(!allowed('hr')||!state.doctor)return;const doctor=state.doctor,day=state.day,context=signature();closeAlerts(false);
    await switchClinicManagementTab('hr');if(context!==signature())return;
    await openHrDoctorDetails(doctor);if(activeHrDoctorDetailsId!==doctor||context!==signature())return;
    el('hr-doctor-payroll-scope').value='day';el('hr-doctor-payroll-day').value=day;
    el('hr-doctor-payroll-month-control').classList.add('hidden');el('hr-doctor-payroll-day-control').classList.remove('hidden');
    await loadHrDoctorSettlementCases({refresh:true});
  }
  async function navigate(target) {
    closeAlerts(false);
    if(['analytics','hr'].includes(target)){if(allowed(target))await switchClinicManagementTab(target);return;}
    if(!allowed('finances'))return;await switchClinicManagementTab('finances');
    if(target==='balances'){
      el('finance-universal-duration').value='all';el('finance-universal-start-date').value='';el('finance-universal-end-date').value='';
      el('finance-universal-patient-search').value='';await switchFinanceTab('depts');
    }
    else if(target==='expenses')await switchFinanceTab('expenses');
  }
  function openInvoice(patient,invoice) {
    if(typeof canViewPatientInvoices!=='function'||!canViewPatientInvoices())return;
    closeAlerts(false);openPatientInvoices(patient,'clinic-management');
    // Patient invoice rendering already supports keyed cards; focus the chosen invoice when ready.
    const context=signature();let attempts=0;
    const focus=()=>{if(context!==signature()||window.location.hash!=='#invoices')return;const node=document.querySelector(`#view-invoices [data-refresh-key="${String(Number(invoice))}"]`);if(node){node.scrollIntoView({block:'center',behavior:'smooth'});return;}if(++attempts<15)setTimeout(focus,100);};setTimeout(focus,100);
  }
  async function reviewAlert(key) {
    if(key==='payments'){
      if(!allowed('hr'))return;state.alertView='payments';renderPaymentPreview();icons();positionAlerts();return;
    }
    if(key==='balances')return navigate('balances');if(key==='expenses')return navigate('expenses');if(key==='payroll'||key==='attendance')return navigate('hr');
  }
  async function reviewPayment(index) {
    const row=state.report?.hr?.payroll_preview?.[index];if(!row||!allowed('hr'))return;
    state.doctor=row.doctor_id;state.day=row.day;await openDoctor();
  }
  function showAlerts() {state.alertView='alerts';renderAlerts();icons();}
  function renderPaymentPreview() {
    if(!allowed('hr'))return;
    const rows=state.report?.hr?.payroll_preview||[],body=el('cm-alert-body');
    body.replaceChildren();
    const back=document.createElement('button');back.type='button';back.className='cm-button cm-button-quiet';
    back.innerHTML=icon('arrow-left')+text('Back to alerts','العودة للتنبيهات');back.onclick=showAlerts;body.appendChild(back);
    const note=document.createElement('p');note.className='cm-note';
    if(state.error){const warning=document.createElement('p');warning.className='cm-error';warning.setAttribute('role','alert');warning.textContent=text('Alerts could not be refreshed. Please retry.','تعذر تحديث التنبيهات. يرجى إعادة المحاولة.');body.appendChild(warning);}
    note.textContent=text('Procedures enter payroll automatically. Open the doctor in HR to review and pay.','تُضاف الإجراءات للراتب تلقائياً. افتح الطبيب في الموارد البشرية للمراجعة والدفع.');body.appendChild(note);
    const list=document.createElement('div');list.className='cm-payment-preview';body.appendChild(list);
    if(!rows.length){list.innerHTML=empty(text('No doctor payments awaiting payment','لا توجد مستحقات أطباء بانتظار الدفع'),text('Refresh to review the latest pending invoice procedures.','حدّث لمراجعة أحدث إجراءات الفواتير المعلقة.'),'circle-check');return;}
    rows.forEach((row,index)=>{
      const entry=document.createElement('article');entry.className='cm-payment-preview-row';
      const detail=document.createElement('div'),name=document.createElement('strong'),procedure=document.createElement('p'),date=document.createElement('p');
      name.textContent=(row.patient_name||'')+' · '+(row.doctor_name||'');
      procedure.textContent=(row.operation_name||'')+' · '+money(row.doctor_amount);date.textContent=LuminDates.format(row.day)+' · #'+row.invoice_id;
      detail.append(name,procedure,date);
      const actions=document.createElement('div');actions.className='cm-payment-preview-actions';
      const redirect=document.createElement('button');redirect.type='button';redirect.className='cm-button cm-button-icon';
      redirect.setAttribute('aria-label',text('Open doctor in HR','فتح الطبيب في الموارد البشرية'));redirect.innerHTML=icon('arrow-up-right');
      redirect.onclick=()=>void reviewPayment(index);
      actions.append(redirect);entry.append(detail,actions);list.appendChild(entry);
    });
  }
  function toggleAlerts() {
    if(!allowed('clinic-management'))return;if(!el('cm-alert-menu'))init();const menu=el('cm-alert-menu');
    if(!menu.hidden){closeAlerts();return;}state.alertView='alerts';renderAlerts();icons();menu.hidden=false;el('cm-alert-bell').setAttribute('aria-expanded','true');positionAlerts();menu.querySelector('button')?.focus();
    if(Date.now()-state.loadedAt>=30000)void refresh();
  }
  function closeAlerts(restore=true) {const menu=el('cm-alert-menu');if(!menu||menu.hidden)return;menu.hidden=true;el('cm-alert-bell')?.setAttribute('aria-expanded','false');if(restore)el('cm-alert-bell')?.focus();}
  function positionAlerts() {
    const menu=el('cm-alert-menu'),bell=el('cm-alert-bell');if(!menu||menu.hidden||!bell)return;
    const bounds=bell.getBoundingClientRect(),viewport=window.visualViewport;
    const width=viewport?.width||window.innerWidth,height=viewport?.height||window.innerHeight,offsetX=viewport?.offsetLeft||0,offsetY=viewport?.offsetTop||0;
    const menuWidth=Math.min(410,width-24);menu.style.width=menuWidth+'px';const rtl=document.documentElement.dir==='rtl';
    const x=Math.max(offsetX+12,Math.min(rtl?bounds.left:bounds.right-menuWidth,offsetX+width-menuWidth-12));
    const y=Math.min(Math.max(offsetY+12,bounds.bottom+10),offsetY+height-160);
    menu.style.left=x+'px';menu.style.top=y+'px';menu.style.maxHeight=Math.max(140,offsetY+height-y-12)+'px';
    menu.style.setProperty('--cm-menu-body-height',Math.max(60,offsetY+height-y-100)+'px');
  }
  function invalidate() {state.loadedAt=0;if(allowed('clinic-management')&&!el('view-clinic-management')?.classList.contains('hidden'))void refresh({force:true});}
  function languageChanged(){if(el('view-clinic-overview')){renderStatic();render();}}
  function tabKeydown(event) {
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const tabs=Array.from(el('clinic-management-tabs').querySelectorAll('[role="tab"]')).filter(tab=>!tab.classList.contains('hidden'));
    const index=tabs.indexOf(event.target);if(index<0)return;
    const rtl=document.documentElement.dir==='rtl';const delta=(event.key==='ArrowRight'?1:-1)*(rtl?-1:1);
    const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+delta+tabs.length)%tabs.length;
    event.preventDefault();tabs[next].click();tabs[next].focus();
  }
  const api={init,refresh,reset,invalidate,languageChanged,tabKeydown,closeAlerts,toggleAlerts,positionAlerts,applyRange,rangeChanged,setRangePreset,setDoctor,setDay,setPage,setUnpaid,loadPayroll,payDay,openDoctor,openInvoice,navigate,reviewAlert,reviewPayment,showAlerts,renderAlerts,validRange,presetRange,cumulativeDays,payrollTotals};
  host.LuminClinicManagement=api;
  if(typeof module!=='undefined'&&module.exports)module.exports={validRange,presetRange,cumulativeDays,payrollTotals};
  if(typeof document!=='undefined'){
    document.addEventListener('DOMContentLoaded',init);
    document.addEventListener('pointerdown',event=>{if(!el('cm-alert-menu')?.hidden&&!el('cm-alert-menu')?.contains(event.target)&&!el('cm-alert-bell')?.contains(event.target))closeAlerts(false);});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!el('cm-alert-menu')?.hidden){event.preventDefault();closeAlerts();}});
    document.addEventListener('scroll',event=>{if(!el('cm-alert-menu')?.hidden&&!el('cm-alert-menu')?.contains(event.target))positionAlerts();},true);
    window.addEventListener('resize',()=>{positionAlerts();drawChart();});window.visualViewport?.addEventListener('resize',positionAlerts);
    window.addEventListener('hashchange',()=>closeAlerts(false));
  }
})(typeof window==='undefined'?globalThis:window);
