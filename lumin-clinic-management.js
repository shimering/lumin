/* Clinic management navigation and shared action center. */
(function (host) {
  'use strict';
  const state = { actor:'', token:0, report:null, team:null, alerts:[], alertView:'alerts', day:'', doctor:'', calendarDay:'', loadedAt:0, error:'' };
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
  const button = (label, action, name='arrow-up-right', extra='') => `<button type="button" class="cm-button ${extra}" onclick="LuminClinicManagement.${action}">${icon(name)}${label}</button>`;
  const empty = (title,description,name='circle-check') => `<div class="cm-empty"><span class="cm-icon">${icon(name)}</span><h4>${title}</h4><p>${description}</p></div>`;
  function reset() {
    state.token++;closeAlerts(false);
    Object.assign(state,{actor:'',report:null,team:null,alerts:[],alertView:'alerts',loadedAt:0,error:'',doctor:'',day:'',calendarDay:''});
    el('cm-alert-body')?.replaceChildren();
    if(el('cm-alert-bell')){el('cm-alert-bell').classList.remove('has-alerts');el('cm-alert-count').hidden=true;}
    if(el('cm-refresh'))el('cm-refresh').disabled=false;
  }
  function init() {
    if(!el('cm-alert-bell'))return;
    if(!el('cm-alert-menu')){
      const menu=document.createElement('section');menu.id='cm-alert-menu';menu.className='cm-alert-menu';menu.hidden=true;
      menu.setAttribute('role','dialog');menu.setAttribute('aria-labelledby','cm-alert-heading');
      menu.innerHTML='<div id="cm-alert-menu-header" class="cm-alert-menu-header"></div><div id="cm-alert-body" class="cm-alert-body"></div>';
      document.body.appendChild(menu);
    }
    renderStatic();renderAlerts();icons();
  }
  function renderStatic() {
    if(!el('cm-alert-bell'))return;
    el('cm-refresh').setAttribute('aria-label',text('Refresh clinic data','تحديث بيانات العيادة'));
    el('cm-alert-menu-header').innerHTML=`<span class="cm-icon cm-icon-rose">${icon('bell-ring')}</span><div><h3 id="cm-alert-heading">${text('Action center','مركز التنبيهات')}</h3><p class="cm-muted">${text('Items that need your attention','بنود تحتاج إلى مراجعتك')}</p></div><button class="cm-button cm-button-icon" type="button" onclick="LuminClinicManagement.closeAlerts()" aria-label="${text('Close alerts','إغلاق التنبيهات')}">${icon('x')}</button>`;
    icons();
  }
  function captureTeam() {
    const users=hrDirectoryUsers.filter(user=>user.active);let pending=0;
    for(const user of users){const metric=user.isDoctor?hrDoctorMetrics(user):hrUserMetrics(user);const due=user.isDoctor?number(metric.salary):metric.paid?0:Math.max(0,number(metric.salary));if(due>0)pending++;}
    return {month:currentHrMonth(),pending,
      incomplete:hrAttendanceSessions.filter(s=>s.work_date<today()&&s.check_in_at&&!s.check_out_at).length,
      status:hrPayrollPeriod?.status||'draft'};
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
    const day=today();
    if(state.calendarDay!==day){state.calendarDay=day;state.report=null;state.loadedAt=0;}
    // Reuse HR data only after both the directory and this month's doctor payroll have loaded.
    state.team=allowed('hr')&&typeof hrDirectoryLoaded!=='undefined'&&hrDirectoryLoaded
      &&typeof hrDoctorPayrollLoadedMonth!=='undefined'&&hrDoctorPayrollLoadedMonth===currentHrMonth()?captureTeam():null;
    renderStatic();
    if(!options.force&&state.report&&Date.now()-state.loadedAt<30000){renderAlerts();icons();return;}
    const token=++state.token;el('cm-refresh').disabled=true;
    try{
      const {data,error}=await db.rpc('get_clinic_management_overview',{p_start_date:day,p_end_date:day});
      if(token!==state.token||context!==signature())return;
      if(error)throw error;state.report=data;state.error='';state.loadedAt=Date.now();
    }catch(_){if(token!==state.token||context!==signature())return;state.error='load';state.loadedAt=0;}
    finally{if(token===state.token&&context===signature()){renderAlerts();icons();el('cm-refresh').disabled=false;}}
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
  function invalidate() {state.loadedAt=0;state.team=null;if(allowed('clinic-management')&&!el('view-clinic-management')?.classList.contains('hidden'))void refresh({force:true});}
  function languageChanged(){if(el('cm-alert-menu')){renderStatic();renderAlerts();icons();}}
  function tabKeydown(event) {
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const tabs=Array.from(el('clinic-management-tabs').querySelectorAll('[role="tab"]')).filter(tab=>!tab.classList.contains('hidden'));
    const index=tabs.indexOf(event.target);if(index<0)return;
    const rtl=document.documentElement.dir==='rtl';const delta=(event.key==='ArrowRight'?1:-1)*(rtl?-1:1);
    const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+delta+tabs.length)%tabs.length;
    event.preventDefault();tabs[next].click();tabs[next].focus();
  }
  host.LuminClinicManagement={init,refresh,reset,invalidate,languageChanged,tabKeydown,closeAlerts,toggleAlerts,positionAlerts,navigate,reviewAlert,reviewPayment,showAlerts,renderAlerts};
  if(typeof document!=='undefined'){
    document.addEventListener('DOMContentLoaded',init);
    document.addEventListener('pointerdown',event=>{if(!el('cm-alert-menu')?.hidden&&!el('cm-alert-menu')?.contains(event.target)&&!el('cm-alert-bell')?.contains(event.target))closeAlerts(false);});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!el('cm-alert-menu')?.hidden){event.preventDefault();closeAlerts();}});
    document.addEventListener('scroll',event=>{if(!el('cm-alert-menu')?.hidden&&!el('cm-alert-menu')?.contains(event.target))positionAlerts();},true);
    window.addEventListener('resize',positionAlerts);window.visualViewport?.addEventListener('resize',positionAlerts);
    window.addEventListener('hashchange',()=>closeAlerts(false));
  }
})(typeof window==='undefined'?globalThis:window);
