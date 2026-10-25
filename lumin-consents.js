(function(root){
  'use strict';
  const model=()=>root.LuminConsentModel;
  const e=value=>model().escape(value);
  const lang=()=>typeof currentUiLanguage!=='undefined'?currentUiLanguage:document.documentElement.dir==='rtl'?'ar':'en';
  const t=(en,ar)=>lang()==='ar'?ar:en;
  const canUse=()=>typeof hasPageAccess==='function'&&(hasPageAccess('patients')||hasPageAccess('chart'));
  const isAdmin=()=>typeof hasPageAccess==='function'&&hasPageAccess('admin');
  const patientId=()=>typeof patientWorkspaceId==='function'?patientWorkspaceId():null;
  const userId=()=>typeof currentSession!=='undefined'?currentSession?.user?.id:null;
  const state={request:0,records:[],templates:[],patient:null,hasMore:false};
  const admin={request:0,templates:[],operations:[]};
  const ui={request:0,overlay:null,record:null,template:null,templates:[],doctors:[],patient:null,context:{},busy:false,dirty:false,editors:[],languageEditors:{},discard:null};
  const rich=()=>root.LuminConsentDocument;
  const implant=()=>root.LuminImplantConsent;
  const icon=name=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
  const icons=()=>{if(root.lucide)lucide.createIcons();};
  const button=(action,label,name='plus',kind='')=>`<button type="button" class="consent-btn ${kind}" data-consent-action="${action}">${icon(name)}<span>${label}</span></button>`;
  const date=value=>value?new Date(value).toLocaleString(lang()==='ar'?'ar-EG':'en-GB',{dateStyle:'medium',timeStyle:'short'}):'';
  const templateTitle=record=>record[lang()==='ar'?'title_ar':'title_en']||record.title_en;
  async function result(query){const response=await query;if(response.error)throw response.error;return response.data;}
  const current=(request,id,user)=>request===state.request&&id===patientId()&&user===userId()&&canUse();
  const skeleton=()=>`<div role="status" aria-label="${t('Loading consents','جارٍ تحميل الموافقات')}"><div class="consent-skeleton"></div><div class="consent-skeleton"></div></div>`;
  function errorText(error){
    const messages={document:t('Review the consent text and formatting before saving.','راجع نص الموافقة وتنسيقه قبل الحفظ.'),'implant-settings':t('Choose a valid interval, first-visit percentage and installment count.','اختر مدة ونسبة دفعة أولى وعدد أقساط صالحين.'),'implant-procedures':t('Assign at least one implant procedure. Every selected implant needs a tooth, price and implant type. Set missing prices on the chart and types in Admin or Implant Progress.','اربط إجراء زراعة واحداً على الأقل. يلزم تحديد السن والسعر ونوع الزراعة لكل إجراء مختار. أكمل السعر في المخطط والنوع في الإدارة أو متابعة الزراعة.')};
    if(error?.message==='implant-first-payment')return t('The first visit amount cannot exceed the total implant fee.','لا يمكن أن يتجاوز مبلغ الزيارة الأولى إجمالي تكلفة الزراعة.');
    if(messages[error?.message])return messages[error.message];
    if(error?.message==='unsaved')return t('Save your changes before printing.','احفظ تغييراتك قبل الطباعة.');
    if(String(error?.message||'').includes('changed'))return t('This form changed on another device. Close and reopen it before saving.','تغير النموذج على جهاز آخر. أغلقه وأعد فتحه قبل الحفظ.');
    if(error?.code==='42P01'||error?.code==='PGRST205')return t('Consent storage is not available yet. Apply the patient consents database migration.','تخزين الموافقات غير متاح بعد. يجب تطبيق تحديث قاعدة بيانات الموافقات.');
    return t('Could not complete this request. Check your connection and access, then try again.','تعذر إكمال الطلب. تحقق من الاتصال والصلاحيات ثم حاول مجدداً.');
  }
  function feedback(error){const target=ui.overlay?.querySelector('[data-consent-feedback]');if(target){target.textContent=errorText(error);target.hidden=false;target.scrollIntoView({block:'nearest'});}}
  function bind(container){
    if(container.dataset.consentBound)return;
    container.dataset.consentBound='true';
    container.addEventListener('click',event=>{const trigger=event.target.closest('[data-consent-action]');if(trigger&&!trigger.disabled){event.preventDefault();event.stopPropagation();void action(trigger.dataset.consentAction,trigger);}});
  }
  function titleHeader(title,subtitle,actions=''){
    return `<div class="consent-toolbar"><div><h2>${title}</h2><p>${subtitle}</p></div><div class="consent-actions">${actions}</div></div>`;
  }
  function renderHistory(){
    const container=document.getElementById('view-patient-consents');if(!container)return;
    container.dir=lang()==='ar'?'rtl':'ltr';
    container.innerHTML=titleHeader(t('Consents','الموافقات'),t('Patient forms, with the wording saved at the time.','نماذج المريض بالنص المحفوظ وقت إنشائها.'),button('refresh',t('Refresh','تحديث'),'refresh-cw')+button('new',t('New consent','موافقة جديدة'),'file-plus-2','consent-primary'))+
      (state.records.length?`<div class="consent-grid">${state.records.map(record=>`<article class="consent-card" data-consent-id="${e(record.id)}"><div class="consent-meta"><span class="consent-badge is-${record.status}">${record.status==='finalized'?t('Finalized','معتمدة'):t('Draft','مسودة')}</span><span>${t('Template version','إصدار النموذج')} ${record.template_revision}</span></div><h3 dir="auto">${e(record.title)}</h3><p dir="auto">${e(record.doctor_name)}${record.procedure_name?' · '+e(record.procedure_name):''}</p><p>${e(date(record.created_at))}</p><div class="consent-actions">${button('open',record.status==='draft'?t('Edit draft','تعديل المسودة'):t('View consent','عرض الموافقة'),record.status==='draft'?'pencil':'file-check-2')}${button('history-print',t('Print','طباعة'),'printer')}${record.status==='finalized'?button('history-reopen',t('Edit consent','تعديل الموافقة'),'pencil'):''}${button('history-delete',t('Delete consent','حذف الموافقة'),'trash-2')}</div></article>`).join('')}</div>${state.hasMore?button('more',t('Load more','تحميل المزيد'),'chevron-down'):''}`:
      `<div class="consent-empty consent-panel"><span class="consent-icon">${icon('file-check-2')}</span><h3>${t('No consents yet','لا توجد موافقات بعد')}</h3><p>${t('Start with a clinic template, adjust the wording for this patient and keep it in their record.','ابدأ بنموذج العيادة وعدّل نصه لهذا المريض ثم احفظه في ملفه.')}</p>${button('new',t('Create first consent','إنشاء أول موافقة'),'plus','consent-primary')}</div>`);
    icons();
  }
  async function render(options={}){
    const container=document.getElementById('view-patient-consents'),id=patientId(),user=userId();
    if(!container||!canUse()||!id)return;
    bind(container);const request=++state.request;
    const append=options.append&&state.patient?.id===id;
    if(!options.quiet)container.innerHTML=skeleton();
    try{
      const [patient,records]=await Promise.all([
        result(db.from('patients').select('id,name,patient_number,birth_date,age,gender,phone,address,chart_state').eq('id',id).single()),
        result(db.from('patient_consents').select('id,title,doctor_name,procedure_name,template_revision,status,created_at').eq('patient_id',id).order('created_at',{ascending:false}).order('id').range(append?state.records.length:0,(append?state.records.length:0)+49))
      ]);
      if(!current(request,id,user))return;
      Object.assign(state,{patient,records:append?[...state.records,...records]:records,hasMore:records.length===50});
      updatePatientWorkspaceNavigation(typeof getKnownPatient==='function'?getKnownPatient(id)||patient:patient,'consents');
      renderHistory();
    }catch(error){if(current(request,id,user)){container.innerHTML=`<div class="consent-panel"><p class="consent-error" role="alert">${e(errorText(error))}</p>${button('refresh',t('Try again','حاول مجدداً'),'refresh-cw')}</div>`;icons();}}
  }
  function requestDiscard(resume){
    if(ui.discard){ui.overlay.querySelector('[data-consent-action="cancel-discard"]').focus();return;}
    const body=ui.overlay.querySelector('.consent-dialog-body'),footer=ui.overlay.querySelector('[data-consent-footer]');
    ui.discard={resume,body,footer,bodyHidden:body.hidden,footerHidden:footer.hidden,focus:document.activeElement};
    const confirmation=document.createElement('section');confirmation.className='consent-discard-confirmation';confirmation.dataset.consentDiscardConfirmation='true';
    confirmation.setAttribute('role','alertdialog');confirmation.setAttribute('aria-modal','true');confirmation.setAttribute('aria-labelledby','consent-discard-title');confirmation.setAttribute('aria-describedby','consent-discard-description');
    confirmation.innerHTML=`<span class="consent-discard-icon">${icon('file-pen-line')}</span><h3 id="consent-discard-title">${t('Discard unsaved changes?','تجاهل التغييرات غير المحفوظة؟')}</h3><p id="consent-discard-description">${t('Cancel to keep this form open with all your changes. Discard changes to leave without saving.','اضغط إلغاء للبقاء في النموذج والاحتفاظ بكل تعديلاتك. اضغط تجاهل التغييرات للخروج دون حفظ.')}</p><div class="consent-actions">${button('cancel-discard',t('Cancel','إلغاء'),t('arrow-left','arrow-right'))}${button('confirm-discard',t('Discard changes','تجاهل التغييرات'),'trash-2','consent-danger')}</div>`;
    body.hidden=true;footer.hidden=true;footer.before(confirmation);icons();confirmation.querySelector('[data-consent-action="cancel-discard"]').focus();
  }
  function cancelDiscard(){
    const pending=ui.discard;if(!pending)return;
    ui.overlay.querySelector('[data-consent-discard-confirmation]').remove();pending.body.hidden=pending.bodyHidden;pending.footer.hidden=pending.footerHidden;ui.discard=null;
    if(pending.focus?.isConnected)pending.focus.focus({preventScroll:true});
  }
  function close(force=false,resume){
    if(force!==true){
      if(ui.busy)return false;
      if(ui.discard||ui.dirty){requestDiscard(resume);return false;}
    }
    ui.request++;
    disposeEditors();
    if(ui.overlay){ui.overlay.remove();document.body.style.overflow=ui.overflow;ui.returnFocus?.isConnected&&ui.returnFocus.focus({preventScroll:true});}
    Object.assign(ui,{overlay:null,record:null,template:null,patient:null,templates:[],doctors:[],context:{},busy:false,dirty:false,readLanguage:null,discard:null});
    return true;
  }
  function modal(title,resume){
    if(!close(false,resume))return null;
    ui.returnFocus=document.activeElement;ui.overflow=document.body.style.overflow;document.body.style.overflow='hidden';
    const overlay=document.createElement('div');overlay.className='consent-overlay';overlay.dir=lang()==='ar'?'rtl':'ltr';overlay.setAttribute('translate','no');
    overlay.innerHTML=`<section class="consent-dialog" role="dialog" aria-modal="true" aria-labelledby="consent-dialog-title"><header><h2 id="consent-dialog-title">${title}</h2>${button('close',`<span class="sr-only">${t('Close','إغلاق')}</span>`,'x')}</header><div class="consent-dialog-body"><p class="consent-error" data-consent-feedback role="alert" hidden></p><div data-consent-body>${skeleton()}</div></div><footer data-consent-footer>${button('close',t('Close','إغلاق'),'x')}</footer></section>`;
    ui.overlay=overlay;document.body.appendChild(overlay);bind(overlay);
    overlay.addEventListener('click',event=>{if(event.target===overlay)close();});
    overlay.addEventListener('input',event=>{if(event.target.name)ui.dirty=true;});
    overlay.addEventListener('change',event=>{if(event.target.name)ui.dirty=true;});
    overlay.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(ui.discard)cancelDiscard();else close();}
      if(event.key!=='Tab')return;
      const scope=ui.discard?overlay.querySelector('[data-consent-discard-confirmation]'):overlay;
      const controls=[...scope.querySelectorAll('button,input,textarea,select,a[href]')].filter(node=>!node.disabled&&node.getClientRects().length);
      const first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    });
    icons();overlay.querySelector('button').focus();return ++ui.request;
  }
  function modalCurrent(request,id,user,adminMode=false){return request===ui.request&&ui.overlay&&user===userId()&&(adminMode?isAdmin():id===patientId()&&canUse());}
  function loadFailure(error){ui.overlay.querySelector('[data-consent-body]').innerHTML=`<p>${t('Close this form and try again.','أغلق النموذج وحاول مجدداً.')}</p>`;feedback(error);}
  function field(label,name,value,options={}){
    if(options.textarea)return `<div data-consent-editor-slot="${name}" data-editor-label="${e(label)}"></div>`;
    return `<label class="consent-field">${label}${options.textarea?`<textarea name="${name}" rows="${options.rows||16}" maxlength="40000" dir="${options.dir||'auto'}" ${options.required?'required':''}>${e(value)}</textarea>`:`<input name="${name}" value="${e(value)}" maxlength="${options.max||200}" dir="${options.dir||'auto'}" ${options.required?'required':''}/>`}</label>`;
  }
  const form=()=>ui.overlay?.querySelector('form');
  function disposeEditors(){ui.editors.forEach(editor=>editor.dispose());ui.editors=[];ui.languageEditors={};}
  function tabsMarkup(selected){return `<div class="consent-language-tabs" role="tablist" aria-label="${t('Consent language versions','نسخ الموافقة باللغتين')}"><button type="button" role="tab" data-consent-language="en" aria-selected="${selected==='en'}" tabindex="${selected==='en'?0:-1}">English</button><button type="button" role="tab" data-consent-language="ar" aria-selected="${selected==='ar'}" tabindex="${selected==='ar'?0:-1}">العربية</button></div>`;}
  function bindLanguageTabs(group,selected,onSelect){
    function select(language){group.querySelectorAll('[data-consent-language]').forEach(button=>{const active=button.dataset.consentLanguage===language;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});group.querySelectorAll('[data-consent-language-panel]').forEach(panel=>panel.hidden=panel.dataset.consentLanguagePanel!==language);onSelect?.(language);}
    group.querySelectorAll('[data-consent-language]').forEach(button=>{
      button.addEventListener('click',()=>select(button.dataset.consentLanguage));
      button.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?'en':event.key==='End'?'ar':button.dataset.consentLanguage==='en'?'ar':'en';select(next);group.querySelector(`[data-consent-language="${next}"]`).focus();});
    });select(selected);return select;
  }
  function mountBilingual(slots,selected,patientMode=false){
    const group=document.createElement('div');group.className='consent-bilingual';group.innerHTML=tabsMarkup(selected);
    slots[selected].element.replaceWith(group);
    for(const language of ['en','ar']){
      const item=slots[language],panel=document.createElement('div');panel.className='consent-language-panel';panel.dataset.consentLanguagePanel=language;
      if(item.titleField)panel.innerHTML=item.titleField;
      panel.appendChild(item.element);group.appendChild(panel);
      const editor=root.LuminConsentEditor.mount(item.element,{name:item.name,label:item.label,language,text:item.text,document:item.document,required:item.required,values:patientMode?()=>patientVariableValues(language):null});
      ui.editors.push(editor);ui.languageEditors[language]=editor;
    }
    ui.selectLanguage=bindLanguageTabs(group,selected,patientMode?language=>{ui.readLanguage=language;}:null);return group;
  }
  function patientVariableValues(language=ui.record.language){
    const record=ui.record,p=record.patient_data,controls=form()?.elements;
    const values=model().variableValues({...p,patient_number:p.number},{full_name:controls?.doctor_name?.value??record.doctor_name,full_name_ar:controls?.doctor_name_ar?.value??record.doctor_name_ar},{language,procedure_name:controls?.procedure_name?.value??record.procedure_name});
    if(isImplantRecord()&&controls?.payment_mode){try{Object.assign(values,implant().variableValues(assignedProcedures(),implantSettings(),language));}catch{/* Keep incomplete variable values visible while inputs are being edited. */}}
    return values;
  }
  function mountPatientEditors(record){
    const primary=ui.overlay.querySelector('[data-consent-editor-slot="body"]'),alternate=document.createElement('div'),other=record.language==='ar'?'en':'ar';
    const label=language=>language==='ar'?t('Arabic consent text','نص الموافقة بالعربية'):t('English consent text','نص الموافقة بالإنجليزية');
    mountBilingual({[record.language]:{element:primary,name:'body',label:label(record.language),text:record.body,document:record.content,required:true},[other]:{element:alternate,name:'alternate_body',label:label(other),text:record.alternate_body||'',document:record.alternate_content,titleField:field(other==='ar'?t('Arabic title','العنوان العربي'):t('English title','العنوان الإنجليزي'),'alternate_title',record.alternate_title||'')}},record.language,true);
  }
  function isImplantRecord(){return Boolean(ui.record?.implant_terms||implant()?.isTemplate(ui.template));}
  function consentToothLabel(tooth){return typeof palmerToothNotation==='function'?palmerToothNotation(tooth,typeof resolveToothSlotNumber==='function'?resolveToothSlotNumber(tooth):Number(tooth)):typeof chartToothLabel==='function'?chartToothLabel(tooth):tooth;}
  function procedureChoices(){
    const lookup=code=>typeof dentalOperationByCode==='function'?dentalOperationByCode(code):null;
    const current=implant().assignments(ui.patient,lookup,ui.progress||[],consentToothLabel),saved=ui.record?.procedure_assignments||[];
    const merged=new Map([...current,...saved].map(item=>[item.finding_id,item]));
    return [...merged.values()].filter(item=>!isImplantRecord()||item.is_implant);
  }
  function assignedProcedures(){const selected=new Set(new FormData(form()).getAll('assigned_finding_ids'));return (ui.procedureChoices||[]).filter(item=>selected.has(item.finding_id));}
  function implantSettings(){const values=new FormData(form()),mode=values.get('payment_mode'),firstMode=values.get('first_visit_mode')||'percent',saved=ui.record.implant_terms||{};return implant().settings({interval_months:values.get('interval_months'),first_visit_mode:firstMode,first_visit_percent:firstMode==='percent'?values.get('first_visit_percent'):(saved.first_visit_percent??50),first_visit_amount:firstMode==='amount'?values.get('first_visit_amount'):(saved.first_visit_amount??0),payment_mode:mode,monthly_count:mode==='monthly'?values.get('monthly_count'):(Number(values.get('monthly_count'))||4)});}
  function firstVisitControls(terms){return `<label class="consent-field">${t('First visit fee','رسوم الزيارة الأولى')}<select name="first_visit_mode"><option value="percent" ${terms.first_visit_mode==='percent'?'selected':''}>${t('Percentage of total','نسبة من الإجمالي')}</option><option value="amount" ${terms.first_visit_mode==='amount'?'selected':''}>${t('Fixed amount','مبلغ محدد')}</option></select></label><label class="consent-field" data-first-visit="percent">${t('First visit payment (%)','نسبة دفعة الزيارة الأولى (%)')}<input name="first_visit_percent" type="number" min="0" max="100" step="0.01" value="${terms.first_visit_percent}"/></label><label class="consent-field" data-first-visit="amount">${t('First visit amount','مبلغ الزيارة الأولى')}<input name="first_visit_amount" type="number" min="0" max="1000000000" step="0.01" inputmode="decimal" value="${terms.first_visit_amount}"/></label>`;}
  function assignmentControls(){
    const record=ui.record,choices=procedureChoices(),selected=new Set(record.finding_ids||[]),specific=isImplantRecord(),terms=implant().settings(record.implant_terms||{});
    ui.procedureChoices=choices;
    return `<section class="consent-assignment"><div class="consent-toolbar"><div><h3>${t('Assigned procedures','الإجراءات المرتبطة')}</h3><p>${specific?t('Insert fees, payment terms and implant details anywhere using the editor’s variables.','أدرج الرسوم وشروط السداد وتفاصيل الزراعة في أي موضع باستخدام متغيرات المحرر.'):t('Select this patient’s chart procedures for this consent.','اختر إجراءات المريض من المخطط لهذه الموافقة.')}</p></div>${record.id&&specific?button('refresh-implant',t('Refresh from chart','تحديث من المخطط'),'refresh-cw'):''}</div><div class="consent-procedure-list">${choices.map(item=>`<label class="consent-check"><input type="checkbox" name="assigned_finding_ids" value="${e(item.finding_id)}" ${selected.has(item.finding_id)?'checked':''}/><span><strong dir="auto">${e(item.name)} · ${e(item.tooth_label||item.tooth||t('Whole mouth','الفم بالكامل'))}</strong><small>${e(item.implant_type)}${item.implant_type?' · ':''}${item.price===null?t('Price missing','السعر غير محدد'):e(typeof formatInvoiceMoney==='function'?formatInvoiceMoney(item.price):item.price)}</small></span></label>`).join('')||`<p class="consent-hint">${t('No eligible chart procedures. Add the procedure to the patient chart first.','لا توجد إجراءات مناسبة بالمخطط. أضف الإجراء إلى مخطط المريض أولاً.')}</p>`}</div>${specific?`<div class="consent-form-grid consent-implant-settings"><label class="consent-field">${t('Payment arrangement','طريقة السداد')}<select name="payment_mode"><option value="two" ${terms.payment_mode==='two'?'selected':''}>${t('Two payments','دفعتان فقط')}</option><option value="monthly" ${terms.payment_mode==='monthly'?'selected':''}>${t('Monthly installments','أقساط شهرية')}</option></select></label>${firstVisitControls(terms)}<label class="consent-field">${t('Restoration interval (months)','المدة حتى التركيب (بالأشهر)')}<select name="interval_months">${Array.from({length:24},(_,i)=>`<option value="${i+1}" ${terms.interval_months===i+1?'selected':''}>${i+1}</option>`).join('')}</select></label><label class="consent-field" data-monthly-count ${terms.payment_mode==='monthly'?'':'hidden'}>${t('Number of monthly installments','عدد الأقساط الشهرية')}<input name="monthly_count" type="number" min="1" max="60" step="1" required value="${terms.monthly_count}"/></label></div><p class="consent-hint">${t('Monthly payments start one month after surgery. The final installment includes any rounding difference. These terms are saved in the consent.','تبدأ الأقساط الشهرية بعد شهر من الزراعة. يشمل القسط الأخير فرق التقريب. تُحفظ هذه الشروط في الموافقة.')}</p>`:''}</section>`;
  }
  function updateVariableValues(){
    if(!form())return;
    if(isImplantRecord()){
      ui.overlay.querySelectorAll('[data-first-visit]').forEach(label=>{const active=label.dataset.firstVisit===form().elements.first_visit_mode.value;label.hidden=!active;label.querySelector('input').disabled=!active;label.querySelector('input').required=active;});
      const monthly=ui.overlay.querySelector('[data-monthly-count]');if(monthly){monthly.hidden=form().elements.payment_mode.value!=='monthly';monthly.querySelector('input').required=!monthly.hidden;}
    }
    for(const language of ['en','ar'])ui.languageEditors[language]?.updateVariables(patientVariableValues(language));
  }
  function renderLockedVersions(record){
    const body=ui.overlay.querySelector('[data-consent-body]'),copy=body.querySelector('.consent-copy'),group=document.createElement('div');group.className='consent-bilingual';group.innerHTML=tabsMarkup(record.language);
    for(const language of ['en','ar']){const alternate=language!==record.language,text=alternate?record.alternate_body:record.body,document=alternate?record.alternate_content:record.content;group.insertAdjacentHTML('beforeend',`<div class="consent-language-panel" data-consent-language-panel="${language}"><h3 dir="auto">${e(alternate?record.alternate_title||record.title:record.title)}</h3><div class="consent-copy consent-rich-content" dir="${language==='ar'?'rtl':'ltr'}">${text?rich().html(rich().read(document,text)):e(t('No version saved in this language.','لا توجد نسخة محفوظة بهذه اللغة.'))}</div></div>`);}
    copy.previousElementSibling?.remove();copy.replaceWith(group);ui.selectLanguage=bindLanguageTabs(group,record.language,language=>{ui.readLanguage=language;const print=ui.overlay.querySelector('[data-consent-action="print"]');if(print)print.disabled=language!==record.language&&!record.alternate_body;});
  }
  function identity(record,tr=t){
    const p=record.patient_data||{};
    return `<div class="consent-identity"><strong dir="auto">${e(p.name)}</strong><span>${tr('File','الملف')}: ${e(p.number||'—')} · ${tr('Date of birth','الميلاد')}: ${e(p.birth_date||'—')} · ${tr('Phone','الهاتف')}: <bdi>${e(p.phone||'—')}</bdi></span><br><span>${tr('Treating doctor','الطبيب المعالج')}: ${e((tr('en','ar')==='ar'&&record.doctor_name_ar)||record.doctor_name||'—')}</span>${record.procedure_name?`<br><span>${tr('Procedure','الإجراء')}: ${e(record.procedure_name)}</span>`:''}</div>`;
  }
  async function openNew(context={}){
    if(!canUse()||!patientId())return;
    const id=patientId(),user=userId(),request=modal(t('New patient consent','موافقة جديدة للمريض'),()=>openNew(context));if(request===null)return;
    try{
      if(typeof ensureDentalCustomizationLoaded==='function')await ensureDentalCustomizationLoaded();
      const [patient,templates,doctors,progress]=await Promise.all([
        result(db.from('patients').select('id,name,patient_number,birth_date,age,gender,phone,address,chart_state').eq('id',id).single()),
        result(db.from('consent_templates').select('*').eq('active',true).order('title_en').limit(1000)),result(db.rpc('list_consent_doctors')),result(db.from('implant_progress').select('finding_id,implant_type').eq('patient_id',id).limit(1000))
      ]);
      if(!modalCurrent(request,id,user))return;
      const known=typeof getKnownPatient==='function'?getKnownPatient(id):null;
      if(known?.chartState&&context.finding_ids?.length)patient.chartState=known.chartState;
      Object.assign(ui,{patient,templates,doctors,progress,context});
      const available=context.templateIds?templates.filter(item=>context.templateIds.includes(item.id)):templates;
      ui.overlay.querySelector('[data-consent-body]').innerHTML=`<p class="consent-hint">${t('Choose a template. You can edit its text for this patient before saving.','اختر نموذجاً. يمكنك تعديل نصه لهذا المريض قبل الحفظ.')}</p><div class="consent-grid" style="margin-top:20px">${available.map(template=>`<article class="consent-card"><h3>${e(templateTitle(template))}</h3><p>${t('Template version','إصدار النموذج')} ${template.revision}</p><div class="consent-actions"><button type="button" class="consent-btn consent-primary" data-consent-action="choose" data-template-id="${e(template.id)}">${icon('file-plus-2')}${t('Use template','استخدام النموذج')}</button></div></article>`).join('')||`<p>${t('No active templates. An administrator can add one under Admin → Consents.','لا توجد نماذج نشطة. يمكن للمسؤول إضافتها من المسؤول ← الموافقات.')}</p>`}</div>`;
      icons();
      if(context.autoTemplateId&&available.some(template=>template.id===context.autoTemplateId))choose(context.autoTemplateId);
    }catch(error){if(modalCurrent(request,id,user))loadFailure(error);}
  }
  function choose(id){
    ui.template=ui.templates.find(item=>item.id===id);if(!ui.template)return;
    const doctor=ui.doctors.find(item=>item.user_id===ui.context.doctorId)||suggestedDoctor(ui.patient,ui.doctors)||{};
    ui.record=model().draft(ui.template,ui.patient,doctor,{...ui.context,language:lang()});
    if(implant().isTemplate(ui.template))ui.record.implant_terms=implant().settings();
    const choices=procedureChoices(),selected=ui.context.finding_ids||[];
    ui.record.procedure_assignments=choices.filter(item=>selected.includes(item.finding_id));
    ui.record.finding_ids=ui.record.procedure_assignments.map(item=>item.finding_id);
    ui.dirty=false;renderEditor();
  }
  function suggestedDoctor(patient,doctors){
    const candidates=[];
    function visit(value){
      if(!value||typeof value!=='object')return;
      if(value.doctorId)candidates.push(value);
      Object.values(value).forEach(item=>{if(item&&typeof item==='object')visit(item);});
    }
    visit(patient.chart_state||patient.chartState);
    candidates.sort((a,b)=>String(b.completedAt||b.createdAt||'').localeCompare(String(a.completedAt||a.createdAt||'')));
    return doctors.find(doctor=>doctor.user_id===candidates.find(finding=>doctors.some(item=>item.user_id===finding.doctorId))?.doctorId)||doctors.find(doctor=>doctor.user_id===userId());
  }
  function doctorControl(record){
    return `<label class="consent-field">${t('Choose treating doctor','اختيار الطبيب المعالج')}<select name="doctor_id"><option value="">${t('Enter a doctor name below','أدخل اسم الطبيب أدناه')}</option>${ui.doctors.map(doctor=>`<option value="${e(doctor.user_id)}" ${record.doctor_id===doctor.user_id?'selected':''}>${e(doctor.full_name)}</option>`).join('')}</select></label>`;
  }
  function renderEditor(){
    disposeEditors();
    ui.overlay.querySelector('[data-consent-feedback]').hidden=true;
    const record=ui.record,locked=record.status==='finalized';
    const body=ui.overlay.querySelector('[data-consent-body]');
    body.innerHTML=identity(record)+(locked?`<p class="consent-hint">${t('Finalized on','اعتمدت في')} ${e(date(record.finalized_at))}. ${t('Use Edit consent to reopen this form as a draft. Printing includes spaces for handwritten signatures.','استخدم تعديل الموافقة لإعادة فتحها كمسودة. تتضمن الطباعة أماكن للتوقيعات اليدوية.')}</p><h3 dir="auto">${e(record.title)}</h3><div class="consent-copy" dir="${record.language==='ar'?'rtl':'ltr'}">${e(record.body)}</div>`:
      `<form onsubmit="return false"><div class="consent-form-grid">${field(t('Consent title','عنوان الموافقة'),'title',record.title,{required:true})}${!record.id?`<label class="consent-field">${t('Form language','لغة النموذج')}<select name="language"><option value="en" ${record.language==='en'?'selected':''}>English</option><option value="ar" ${record.language==='ar'?'selected':''}>العربية</option></select></label>`:''}${doctorControl(record)}${field(t('Treating doctor name','اسم الطبيب المعالج'),'doctor_name',record.doctor_name,{required:true})}${field(t('Treating doctor name (Arabic)','اسم الطبيب المعالج بالعربية'),'doctor_name_ar',record.doctor_name_ar||'',{dir:'rtl'})}${field(t('Procedure / teeth','الإجراء / الأسنان'),'procedure_name',record.procedure_name,{max:1000})}</div>${field(t('Patient-specific consent text','نص الموافقة الخاص بالمريض'),'body',record.body,{textarea:true,required:true,rows:18,dir:record.language==='ar'?'rtl':'ltr'})}<p class="consent-hint">${t('Changes here apply to this consent only. Finalize the wording for printing; use Edit consent if changes are needed later.','تسري التغييرات على هذه الموافقة فقط. اعتمد النص للطباعة؛ استخدم تعديل الموافقة لإجراء تغييرات لاحقاً.')}</p></form>`);
    ui.overlay.querySelector('[data-consent-footer]').innerHTML=button('close',t('Close','إغلاق'),'x')+(record.id?button('delete',t('Delete consent','حذف الموافقة'),'trash-2','consent-danger')+button('print',t('Print','طباعة'),'printer'):'')+(locked?button('reopen',t('Edit consent','تعديل الموافقة'),'pencil','consent-primary'):button('save-draft',t('Save draft','حفظ المسودة'),'save')+button('finalize',t('Finalize consent','اعتماد الموافقة'),'file-check-2','consent-primary'));
    if(locked)renderLockedVersions(record);else{
      form().querySelector('.consent-form-grid').insertAdjacentHTML('afterend',assignmentControls());
      mountPatientEditors(record);updateVariableValues();
      form().addEventListener('change',event=>{if(event.target.closest('.consent-editor'))return;if(event.target.name==='assigned_finding_ids'){
        const names=assignedProcedures().map(item=>`${item.name}${item.tooth_label?' · '+item.tooth_label:''}`);form().elements.procedure_name.value=names.join('; ').slice(0,1000);
      }updateVariableValues();});
      form().addEventListener('input',event=>{if(!event.target.closest('.consent-editor'))updateVariableValues();});
    }
    const doctor=body.querySelector('[name="doctor_id"]');
    if(doctor)doctor.addEventListener('change',()=>{
      const selected=ui.doctors.find(item=>item.user_id===doctor.value);
      if(selected){const input=form().elements.doctor_name;ui.editors.forEach(editor=>{editor.replaceText('Treating doctor: '+input.value,'Treating doctor: '+selected.full_name);editor.replaceText('الطبيب المعالج: '+input.value,'الطبيب المعالج: '+selected.full_name);});input.value=selected.full_name;form().elements.doctor_name_ar.value=selected.full_name_ar||(/[\u0600-\u06ff]/.test(selected.full_name)?selected.full_name:'');updateVariableValues();}
    });
    const language=body.querySelector('[name="language"]');
    if(language)language.addEventListener('change',()=>{
      const selectedLanguage=language.value;
      let payload;try{payload=patientPayload('draft',true);}catch(error){language.value=record.language;feedback(error);return;}
      ui.record={...record,...payload,language:selectedLanguage,title:payload.alternate_title,body:payload.alternate_body,content:payload.alternate_content,alternate_title:payload.title,alternate_body:payload.body,alternate_content:payload.content};renderEditor();ui.dirty=true;
    });
    icons();
  }
  function replaceDoctor(body,before,after){return body.replace('Treating doctor: '+before,'Treating doctor: '+after).replace('الطبيب المعالج: '+before,'الطبيب المعالج: '+after);}
  async function openRecord(id,print=false,printView){
    if(!canUse()){printView?.close();return;}
    const pid=patientId(),user=userId(),request=modal(t('Patient consent','موافقة المريض'),()=>openRecord(id,print,print?root.LuminConsentPrint.reserve():null));if(request===null){printView?.close();return;}
    try{
      if(typeof ensureDentalCustomizationLoaded==='function')await ensureDentalCustomizationLoaded();
      const [record,doctors,patient,progress]=await Promise.all([result(db.from('patient_consents').select('*').eq('patient_id',pid).eq('id',id).single()),result(db.rpc('list_consent_doctors')),result(db.from('patients').select('id,chart_state').eq('id',pid).single()),result(db.from('implant_progress').select('finding_id,implant_type').eq('patient_id',pid).limit(1000))]);
      if(!modalCurrent(request,pid,user)){printView?.close();return;}
      Object.assign(ui,{record,doctors,patient,progress});renderEditor();if(print)await printRecord(record,printView);
    }catch(error){printView?.close();if(modalCurrent(request,pid,user))loadFailure(error);}
  }
  function busy(value){ui.busy=value;ui.overlay?.querySelectorAll('button,input,select,textarea').forEach(node=>node.disabled=value);ui.editors.forEach(editor=>editor.setDisabled(value));if(!value&&form()?.elements.first_visit_mode)updateVariableValues();}
  function patientPayload(status,baseOnly=false){
    const values=new FormData(form()),record=ui.record,doctorName=String(values.get('doctor_name')||'').trim(),procedureName=String(values.get('procedure_name')||'').trim();
    ui.editors.forEach(editor=>{editor.replaceText('Treating doctor: '+record.doctor_name,'Treating doctor: '+doctorName);editor.replaceText('الطبيب المعالج: '+record.doctor_name,'الطبيب المعالج: '+doctorName);editor.replaceText('Procedure / teeth: '+record.procedure_name,'Procedure / teeth: '+procedureName);editor.replaceText('الإجراء / الأسنان: '+record.procedure_name,'الإجراء / الأسنان: '+procedureName);});
    const primary=ui.languageEditors[record.language],other=ui.languageEditors[record.language==='ar'?'en':'ar'];
    const assignments=assignedProcedures(),terms=isImplantRecord()?implantSettings():null;
    if(terms&&!baseOnly)implant().totals(assignments,terms);
    updateVariableValues();
    const content=primary.getDocument();
    const alternate=other.getText()?other.getDocument():null;
    return {title:String(values.get('title')||'').trim(),body:rich().text(content),content,alternate_title:String(values.get('alternate_title')||'').trim(),alternate_body:alternate?rich().text(alternate):'',alternate_content:alternate,doctor_id:values.get('doctor_id')||null,doctor_name:doctorName,doctor_name_ar:String(values.get('doctor_name_ar')||'').trim(),procedure_name:procedureName,procedure_code:assignments[0]?.code||'',finding_ids:assignments.map(item=>item.finding_id),procedure_assignments:assignments,implant_terms:terms,status};
  }
  async function save(status){
    if(ui.busy||!canUse()||!form()?.reportValidity()||ui.record.patient_id!==patientId()||!ui.editors.every(editor=>editor.validate({finalized:status==='finalized'})))return;
    const request=ui.request,id=patientId(),user=userId();let payload;
    try{payload=patientPayload(status);}catch(error){return feedback(error);}
    ui.overlay.querySelector('[data-consent-feedback]').hidden=true;
    busy(true);
    try{
      const record=ui.record;
      const saved=await result(record.id?db.from('patient_consents').update(payload).eq('id',record.id).eq('patient_id',id).eq('revision',record.revision).eq('status','draft').select('*').maybeSingle():db.from('patient_consents').insert({...record,...payload}).select('*').single());
      if(!modalCurrent(request,id,user))return;
      if(!saved)throw new Error('changed');
      ui.record=saved;ui.dirty=false;renderEditor();void render({quiet:true});
    }catch(error){if(modalCurrent(request,id,user))feedback(error);}
    finally{if(request===ui.request)busy(false);}
  }
  let printJob=0;
  async function printRecord(record,view){
    if(!record?.id||record.patient_id!==patientId()||!canUse()){view?.close();return;}
    if(ui.readLanguage&&ui.readLanguage!==record.language){if(!record.alternate_body){view?.close();return;}record={...record,language:ui.readLanguage,title:record.alternate_title||record.title,body:record.alternate_body,content:record.alternate_content};}
    const job=++printJob,user=userId();
    return root.LuminConsentPrint.print(record,{view,isCurrent:()=>job===printJob&&user===userId()&&record.patient_id===patientId()&&canUse()});
  }
  async function reopenConsent(){
    const record=ui.record;if(ui.busy||!record?.id||record.status!=='finalized'||!canUse())return;
    const request=ui.request,id=patientId(),user=userId();busy(true);
    try{const saved=await result(db.from('patient_consents').update({status:'draft'}).eq('patient_id',id).eq('id',record.id).eq('revision',record.revision).eq('status','finalized').select('*').maybeSingle());if(!modalCurrent(request,id,user))return;if(!saved)throw new Error('changed');ui.record=saved;ui.dirty=false;renderEditor();void render({quiet:true});}catch(error){if(modalCurrent(request,id,user))feedback(error);}finally{if(request===ui.request)busy(false);}
  }
  function confirmDelete(){
    if(ui.busy||!ui.record?.id||ui.overlay.querySelector('[data-consent-delete-confirmation]'))return;
    const content=ui.overlay.querySelector('[data-consent-body]'),footer=ui.overlay.querySelector('[data-consent-footer]'),confirmation=document.createElement('div');confirmation.dataset.consentDeleteConfirmation='true';confirmation.className='consent-empty';
    confirmation.innerHTML=`<span class="consent-icon">${icon('trash-2')}</span><h3>${t('Delete this consent?','حذف هذه الموافقة؟')}</h3><p dir="auto"><strong>${e(ui.record.title)}</strong><br>${t('This permanently removes the saved consent from the patient’s record.','سيؤدي هذا إلى حذف الموافقة المحفوظة نهائياً من ملف المريض.')}</p>`;
    ui.deleteFooter=footer.innerHTML;content.hidden=true;content.after(confirmation);footer.innerHTML=button('cancel-delete',t('Keep consent','الاحتفاظ بالموافقة'),'x')+button('confirm-delete',t('Delete consent','حذف الموافقة'),'trash-2','consent-danger');icons();footer.querySelector('button').focus();
  }
  function cancelDelete(){ui.overlay.querySelector('[data-consent-delete-confirmation]')?.remove();ui.overlay.querySelector('[data-consent-body]').hidden=false;ui.overlay.querySelector('[data-consent-footer]').innerHTML=ui.deleteFooter;icons();}
  async function deleteConsent(){
    const record=ui.record;if(ui.busy||!record?.id||!canUse())return;const request=ui.request,id=patientId(),user=userId();busy(true);
    try{const deleted=await result(db.from('patient_consents').delete().eq('patient_id',id).eq('id',record.id).eq('revision',record.revision).select('id').maybeSingle());if(!modalCurrent(request,id,user))return;if(!deleted)throw new Error('changed');close(true);void render({quiet:true});}catch(error){if(modalCurrent(request,id,user))feedback(error);}finally{if(request===ui.request)busy(false);}
  }
  async function renderAdmin(options={}){
    const container=document.getElementById('admin-panel-consents');if(!container||!isAdmin())return;
    const request=++admin.request,user=userId();bind(container);container.dir=lang()==='ar'?'rtl':'ltr';
    if(!options.quiet)container.innerHTML=skeleton();
    try{
      const [templates,operations]=await Promise.all([result(db.from('consent_templates').select('*').order('created_at').limit(1000)),result(db.from('dental_operations').select('code,name,active').order('name').limit(1000))]);
      if(request!==admin.request||user!==userId()||!isAdmin())return;
      Object.assign(admin,{templates,operations});
      container.innerHTML=titleHeader(t('Consent templates','نماذج الموافقة'),t('Shared clinic wording. Updates apply to new consents; saved patient forms retain their text.','نصوص موحدة للعيادة. تسري التحديثات على الموافقات الجديدة وتحتفظ النماذج المحفوظة بنصها.'),button('admin-refresh',t('Refresh','تحديث'),'refresh-cw')+button('template-new',t('Add template','إضافة نموذج'),'plus','consent-primary'))+
        `<div class="consent-panel" style="margin-bottom:20px"><p class="consent-hint">${t('Seven original bilingual starter forms cover the procedure categories in Dentolize’s public generator. Review and adapt the clinical wording to your practice and local requirements before use. Procedure links are optional and managed below.','تغطي سبعة نماذج أولية أصلية باللغتين فئات الإجراءات في مولد Dentolize العام. راجع النص الطبي وعدله وفق العيادة والمتطلبات المحلية قبل الاستخدام. ربط الإجراءات اختياري ويمكن ضبطه أدناه.')}</p><a class="consent-reference" href="https://dentolize.com/tools/dental-consent-form-generator/" target="_blank" rel="noopener noreferrer">${t('Dentolize reference forms','نماذج Dentolize المرجعية')}${icon('external-link')}</a></div><div class="consent-grid">${templates.map(template=>`<article class="consent-card" data-template-id="${e(template.id)}"><div class="consent-meta"><span class="consent-badge ${template.active?'is-finalized':''}">${template.active?t('Active','نشط'):t('Archived','مؤرشف')}</span><span>${t('Version','الإصدار')} ${template.revision}</span></div><h3>${e(templateTitle(template))}</h3><p>${template.procedure_codes.length} ${t('linked procedures','إجراءات مرتبطة')}</p><div class="consent-actions">${button('template-edit',t('Edit template','تعديل النموذج'),'pencil')}</div></article>`).join('')}</div>`;
      void root.LuminConsentPrint.mountAdmin(container);icons();
    }catch(error){if(request===admin.request&&user===userId()&&isAdmin()){container.innerHTML=`<div class="consent-panel"><p class="consent-error" role="alert">${e(errorText(error))}</p>${button('admin-refresh',t('Try again','حاول مجدداً'),'refresh-cw')}</div>`;icons();}}
  }
  async function editTemplate(id){
    if(!isAdmin())return;
    const user=userId(),request=modal(id?t('Edit consent template','تعديل نموذج الموافقة'):t('New consent template','نموذج موافقة جديد'),()=>editTemplate(id));if(request===null)return;
    try{
      const template=id?await result(db.from('consent_templates').select('*').eq('id',id).single()):{title_en:'',title_ar:'',body_en:'',body_ar:'',procedure_codes:[],active:true};
      if(!modalCurrent(request,null,user,true))return;
      ui.template=template;
      ui.overlay.querySelector('[data-consent-body]').innerHTML=`<form onsubmit="return false"><div class="consent-form-grid">${field(t('English title','العنوان الإنجليزي'),'title_en',template.title_en,{required:true})}${field(t('Arabic title','العنوان العربي'),'title_ar',template.title_ar)}</div>${field(t('English wording','النص الإنجليزي'),'body_en',template.body_en,{textarea:true,required:true,rows:12,dir:'ltr'})}<div style="height:20px"></div>${field(t('Arabic wording (optional)','النص العربي (اختياري)'),'body_ar',template.body_ar,{textarea:true,rows:12,dir:'rtl'})}<p class="consent-hint">${t('Automatic fields','حقول تلقائية')}: <bdi>{{patient_name}} · {{patient_number}} · {{birth_date}} · {{phone}} · {{address}} · {{age}} · {{gender}} · {{doctor_name}} · {{date}} · {{procedure}} · {{details}}</bdi></p><span class="consent-section-label">${t('Optional procedure links','ربط الإجراءات (اختياري)')}</span><p class="consent-hint">${t('Applying a linked procedure offers to create this form. No links means the form is available manually only.','عند تطبيق إجراء مرتبط يظهر اقتراح إنشاء هذا النموذج. دون روابط يتاح النموذج يدوياً فقط.')}</p><input class="consent-procedure-search consent-btn" type="search" aria-label="${t('Search procedures','البحث عن الإجراءات')}" placeholder="${t('Search procedures','البحث عن الإجراءات')}" style="width:100%;margin:12px 0"/><div class="consent-procedure-list">${admin.operations.map(operation=>`<label class="consent-check" data-operation-name="${e(operation.name.toLowerCase())}"><input type="checkbox" name="procedure_codes" value="${e(operation.code)}" ${template.procedure_codes.includes(operation.code)?'checked':''}/><span dir="auto">${e(operation.name)}${operation.active?'':' · '+t('Inactive','غير نشط')}</span></label>`).join('')}</div>${template.procedure_codes.filter(code=>!admin.operations.some(op=>op.code===code)).map(code=>`<input type="hidden" name="procedure_codes" value="${e(code)}"/>`).join('')}<label class="consent-check"><input type="checkbox" name="active" ${template.active?'checked':''}/>${t('Active — available for new patient consents','نشط — متاح للموافقات الجديدة')}</label></form>`;
      ui.overlay.querySelector('[data-consent-footer]').innerHTML=button('close',t('Cancel','إلغاء'),'x')+button('template-save',t('Save template','حفظ النموذج'),'save','consent-primary');
      form().querySelector('.consent-form-grid').insertAdjacentHTML('afterend',`<label class="consent-field consent-template-type">${t('Form type','نوع النموذج')}<select name="form_type"><option value="general">${t('Standard consent','موافقة عادية')}</option><option value="implant" ${implant().isTemplate(template)?'selected':''}>${t('Implant consent with fee variables','موافقة زراعة بمتغيرات الرسوم')}</option></select><span class="consent-hint">${t('Implant forms offer patient fee and payment variables. Place only the variables you want in either language. Implant procedures automatically offer this form.','تتيح نماذج الزراعة متغيرات الرسوم والسداد. أدرج ما تحتاجه في أي موضع وبأي لغة. تقترح إجراءات الزراعة هذا النموذج تلقائياً.')}</span></label>`);
      mountBilingual({en:{element:ui.overlay.querySelector('[data-consent-editor-slot="body_en"]'),name:'body_en',label:t('English wording','النص الإنجليزي'),text:template.body_en,document:template.content_en,required:true},ar:{element:ui.overlay.querySelector('[data-consent-editor-slot="body_ar"]'),name:'body_ar',label:t('Arabic wording','النص العربي'),text:template.body_ar,document:template.content_ar}},lang());
      ui.overlay.querySelector('p.consent-hint bdi')?.closest('p').remove();
      ui.overlay.querySelector('.consent-procedure-search').addEventListener('input',event=>{const term=event.target.value.toLowerCase().trim();ui.overlay.querySelectorAll('[data-operation-name]').forEach(label=>label.hidden=!label.dataset.operationName.includes(term));});
      icons();
    }catch(error){if(modalCurrent(request,null,user,true))loadFailure(error);}
  }
  async function saveTemplate(){
    if(ui.busy||!isAdmin()||!form()?.reportValidity()||!ui.editors.every(editor=>editor.validate()))return;
    const request=ui.request,user=userId(),values=new FormData(form());
    const payload={title_en:String(values.get('title_en')||'').trim(),title_ar:String(values.get('title_ar')||'').trim(),body_en:String(values.get('body_en')||'').trim(),body_ar:String(values.get('body_ar')||'').trim(),content_en:ui.languageEditors.en.getDocument(),content_ar:ui.languageEditors.ar.getText()?ui.languageEditors.ar.getDocument():null,procedure_codes:[...new Set(values.getAll('procedure_codes'))],active:values.get('active')==='on',form_type:values.get('form_type')||'general'};
    busy(true);
    try{
      const saved=await result(ui.template.id?db.from('consent_templates').update(payload).eq('id',ui.template.id).eq('revision',ui.template.revision).select('id').maybeSingle():db.from('consent_templates').insert(payload).select('id').single());
      if(!modalCurrent(request,null,user,true))return;
      if(!saved)throw new Error('changed');
      close(true);void renderAdmin({quiet:true});
    }catch(error){if(modalCurrent(request,null,user,true))feedback(error);}
    finally{if(request===ui.request)busy(false);}
  }
  // Prompts are queued so a second chart action never replaces an open form.
  const prompts=[];let prompting=false,epoch=0;
  function appliedContext(patient,code,createdAt){
    const teeth=new Set(),ids=new Set();let doctorId=null;
    function visit(value,tooth){
      if(!value||typeof value!=='object')return;
      if(value.code===code&&value.createdAt===createdAt&&value.id){ids.add(value.id);if(tooth)teeth.add(tooth);doctorId ||= value.doctorId;}
      if(Array.isArray(value))value.forEach(item=>visit(item,tooth));
      else Object.values(value).forEach(item=>{if(item&&typeof item==='object')visit(item,tooth);});
    }
    Object.entries(patient.chartState||{}).forEach(([tooth,data])=>visit(data,tooth==='_meta'?'':tooth));
    return {doctorId,teeth:[...teeth],finding_ids:[...ids]};
  }
  async function procedureApplied(patient,code,createdAt){
    if(!canUse()||patient.id!==patientId())return;
    const context=appliedContext(patient,code,createdAt);
    prompts.push({patientId:patient.id,code,user:userId(),epoch,...context});void drainPrompts();
  }
  async function drainPrompts(){
    if(prompting||ui.overlay||!prompts.length)return;
    const pending=prompts.shift();prompting=true;
    try{
      const operation=typeof dentalOperationByCode==='function'?dentalOperationByCode(pending.code):null;
      const linked=await result(db.from('consent_templates').select('id,title_en,title_ar,active,procedure_codes,form_type').eq('active',true).contains('procedure_codes',[pending.code]).limit(1000));
      const automatic=implant().isImplant(operation)?await result(db.from('consent_templates').select('id,title_en,title_ar,active,procedure_codes,form_type').eq('active',true).eq('form_type','implant').limit(1000)):[];
      const templates=[...new Map([...linked,...automatic].map(template=>[template.id,template])).values()];
      if(pending.epoch!==epoch||pending.user!==userId()||pending.patientId!==patientId()||!canUse()||!templates.length)return;
      const toothNames=pending.teeth.map(tooth=>typeof chartToothLabel==='function'?chartToothLabel(tooth):tooth);
      const name=(operation?.name||pending.code)+(toothNames.length?' · '+toothNames.join(', '):'');
      const request=modal(t('Create a consent for this procedure?','إنشاء موافقة لهذا الإجراء؟'));if(request===null)return;
      ui.context={procedure_code:pending.code,procedure_name:name,doctorId:pending.doctorId,finding_ids:pending.finding_ids,templateIds:templates.map(item=>item.id)};
      ui.overlay.querySelector('[data-consent-body]').innerHTML=`<div class="consent-identity"><strong dir="auto">${e(name)}</strong><span>${e(templates.map(templateTitle).join(' · '))}</span></div><p class="consent-hint">${t('A consent template is linked to this procedure. Create a patient-specific draft now?','يوجد نموذج موافقة مرتبط بهذا الإجراء. هل تريد إنشاء مسودة خاصة بالمريض الآن؟')}</p>`;
      ui.overlay.querySelector('[data-consent-footer]').innerHTML=button('skip-prompt',t('Not now','ليس الآن'),'x')+button('accept-prompt',t('Create consent','إنشاء موافقة'),'file-plus-2','consent-primary');icons();
    }catch(_){
      // Chart application is already saved. Never roll it back for a consent read.
      if(pending.epoch===epoch&&pending.user===userId()&&pending.patientId===patientId()&&canUse()&&typeof showAppointmentNotificationToast==='function')showAppointmentNotificationToast(t('Consent check unavailable','تعذر التحقق من الموافقة'),t('Open the patient Consents tab to create a form.','افتح تبويب موافقات المريض لإنشاء النموذج.'));
    }finally{prompting=false;if(!ui.overlay)void drainPrompts();}
  }
  async function action(name,trigger){
    if(name==='cancel-discard'){cancelDiscard();return;}
    if(name==='confirm-discard'){const pending=ui.discard;if(!pending)return;close(true);if(pending.resume)return pending.resume();void drainPrompts();return;}
    if(name==='close'||name==='skip-prompt'){if(close())void drainPrompts();return;}
    if(name==='refresh')return render();if(name==='more')return render({append:true});
    if(name==='new')return openNew();
    if(name==='choose')return choose(trigger.dataset.templateId);
    if(name==='open'||name==='history-print')return openRecord(trigger.closest('[data-consent-id]').dataset.consentId,name==='history-print',name==='history-print'?root.LuminConsentPrint.reserve():null);
    if(name==='history-reopen'||name==='history-delete'){const id=trigger.closest('[data-consent-id]').dataset.consentId;await openRecord(id);if(ui.record?.id!==id)return;return name==='history-reopen'?reopenConsent():confirmDelete();}
    if(name==='reopen')return reopenConsent();if(name==='delete')return confirmDelete();if(name==='cancel-delete')return cancelDelete();if(name==='confirm-delete')return deleteConsent();
    if(name==='save-draft')return save('draft');if(name==='finalize')return save('finalized');
    if(name==='refresh-implant'){
      let payload;try{payload=patientPayload('draft',true);}catch(error){return feedback(error);}
      const request=ui.request,id=patientId(),user=userId();busy(true);
      try{
        const [patient,progress]=await Promise.all([result(db.from('patients').select('id,chart_state').eq('id',id).single()),result(db.from('implant_progress').select('finding_id,implant_type').eq('patient_id',id).limit(1000))]);
        if(!modalCurrent(request,id,user))return;
        const fresh=implant().assignments(patient,code=>dentalOperationByCode(code),progress,consentToothLabel);
        // Keep the editable wording and rebuild only the generated cost section.
        for(const language of ['en','ar']){const primary=language===ui.record.language;payload[primary?'content':'alternate_content']=ui.languageEditors[language].getDocument();payload[primary?'body':'alternate_body']=ui.languageEditors[language].getText();}
        Object.assign(ui,{patient,progress,record:{...ui.record,...payload,procedure_assignments:payload.procedure_assignments.map(saved=>fresh.find(item=>item.finding_id===saved.finding_id)||saved)}});
        renderEditor();ui.dirty=true;
      }catch(error){if(modalCurrent(request,id,user))feedback(error);}finally{if(request===ui.request)busy(false);}
      return;
    }
    if(name==='print'){
      if(ui.dirty){feedback(new Error('unsaved'));return;}
      return printRecord(ui.record);
    }
    if(name==='admin-refresh')return renderAdmin();if(name==='template-new')return editTemplate();
    if(name==='template-edit')return editTemplate(trigger.closest('[data-template-id]').dataset.templateId);
    if(name==='template-save')return saveTemplate();
    if(name==='accept-prompt'){const context={...ui.context};if(context.templateIds.length===1)context.autoTemplateId=context.templateIds[0];close(true);return openNew(context);}
  }
  function reset(){epoch++;prompts.length=0;state.request++;admin.request++;close(true);state.records=[];state.patient=null;admin.templates=[];admin.operations=[];document.getElementById('view-patient-consents')?.replaceChildren();document.getElementById('admin-panel-consents')?.replaceChildren();}
  function beforeNavigate(resume){if(!close(false,resume))return false;epoch++;prompts.length=0;state.request++;admin.request++;return true;}
  function languageChanged(){
    if(state.patient?.id===patientId()&&canUse()&&!document.getElementById('view-patient-consents')?.classList.contains('hidden'))renderHistory();
    if(isAdmin()&&!document.getElementById('admin-panel-consents')?.classList.contains('hidden'))void renderAdmin({quiet:true});
  }
  root.LuminConsents={render,renderAdmin,openNew,procedureApplied,reset,beforeNavigate,close,languageChanged};
})(window);
