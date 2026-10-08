(function (root) {
  'use strict';
  const ui = {request:0,patient:null,operations:[],settings:null,selectedIds:[],saved:null,records:[],busy:false,overlay:null,returnFocus:null,bodyOverflow:''};
  const view = () => root.LuminQuotationView;
  const language = () => typeof currentUiLanguage !== 'undefined' ? currentUiLanguage : 'en';
  const t = (en,ar) => view().text(language(),en,ar);
  const e = value => view().escape(value);
  const icon = name => view().icon(name);
  const canUse = () => typeof hasPageAccess === 'function' && hasPageAccess('chart');
  const currentPatientId = () => typeof patientWorkspaceId === 'function' ? patientWorkspaceId() : typeof activePatientId !== 'undefined' ? activePatientId : null;
  const sessionId = () => typeof currentSession !== 'undefined' ? currentSession?.user?.id : null;
  function button(action,label,iconName,kind='') {
    return `<button type="button" class="q-button ${kind}" data-quote-action="${action}">${icon(iconName)}${label}</button>`;
  }
  async function api(body) {
    const before = sessionId();
    const {data,error} = await db.functions.invoke('quotation-manage',{body});
    if (before !== sessionId() || !canUse()) throw new Error('session');
    if (error) {
      let detail;
      try { detail = await error.context?.clone().json(); } catch (_) {}
      throw new Error(detail?.error || 'request');
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }
  function feedback(error) {
    const target = ui.overlay?.querySelector('[data-quote-feedback]');
    if (!target) return;
    const message = String(error?.message || error || '');
    const translations = {
      'An administrator must set the clinic WhatsApp number in Quotation settings first.':'يجب على المسؤول ضبط رقم واتساب العيادة في إعدادات عروض الأسعار أولاً.',
      'Some selected procedures are no longer planned. Refresh the chart and try again.':'لم تعد بعض الإجراءات المحددة في حالة التخطيط. حدّث المخطط وحاول مرة أخرى.',
      'This quotation changed. Reopen it before saving.':'تغيّر عرض الأسعار. أعد فتحه قبل الحفظ.',
      'This quotation was disabled. Create a new link.':'تم تعطيل عرض الأسعار. أنشئ رابطاً جديداً.',
      'Choose a future expiry date.':'اختر تاريخ انتهاء في المستقبل.'
    };
    target.textContent = language() === 'ar' ? translations[message] || 'تعذر إكمال العملية. أعد المحاولة.' : message && !['request','session'].includes(message) ? message : 'Could not complete the request. Please try again.';
    target.hidden = false;
  }
  function loaded() {
    const feedback=ui.overlay?.querySelector('[data-quote-feedback]');
    if(feedback)feedback.hidden=true;
  }
  function focusDialog() {
    if(ui.overlay&&!ui.overlay.contains(document.activeElement))ui.overlay.querySelector('button:not(:disabled)')?.focus({preventScroll:true});
  }
  function loadFailure(error,retryAction) {
    ui.overlay.querySelector('[data-quote-body]').innerHTML=`<div class="q-empty">${icon('cloud-off')}<h3>${t('Could not load quotation','تعذر تحميل عرض الأسعار')}</h3><p>${t('Check your connection and try again.','تحقق من اتصالك وحاول مجدداً.')}</p>${button(retryAction,t('Try again','حاول مجدداً'),'refresh-cw')}</div>`;
    feedback(error);
    if(root.lucide)lucide.createIcons();
  }
  function close() {
    ui.request++;
    if (!ui.overlay) return;
    ui.overlay.remove(); ui.overlay=null;
    document.body.style.overflow=ui.bodyOverflow;
    ui.returnFocus?.isConnected && ui.returnFocus.focus({preventScroll:true});
    ui.patient=null;ui.saved=null;ui.records=[];ui.selectedIds=[];ui.busy=false;
  }
  function modal(title) {
    close();
    ui.returnFocus=document.activeElement;
    ui.bodyOverflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    const overlay=document.createElement('div');
    overlay.className='q-overlay';overlay.dir=language()==='ar'?'rtl':'ltr';overlay.setAttribute('translate','no');
    overlay.innerHTML=`<section class="q-dialog" role="dialog" aria-modal="true" aria-labelledby="quotation-dialog-title"><header class="q-dialog-header"><h2 id="quotation-dialog-title">${title}</h2>${button('close',`<span class="sr-only">${t('Close','إغلاق')}</span>`,'x')}</header><div class="q-dialog-body"><p class="q-feedback" data-quote-feedback role="alert" hidden></p><div data-quote-body><div class="q-skeleton"></div><div class="q-skeleton"></div></div></div><footer class="q-dialog-footer" data-quote-footer>${button('close',t('Close','إغلاق'),'x')}</footer></section>`;
    ui.overlay=overlay;document.body.appendChild(overlay);
    overlay.addEventListener('click',event => {
      if(event.target===overlay){if(!ui.busy)close();return;}
      const trigger=event.target.closest('[data-quote-action]');
      if(trigger&&!trigger.disabled) action(trigger.dataset.quoteAction,trigger);
    });
    overlay.addEventListener('keydown',event => {
      if(event.key==='Escape'){event.preventDefault();if(!ui.busy)close();}
      if(event.key!=='Tab')return;
      const controls=[...overlay.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href]')].filter(control=>control.getClientRects().length);
      const first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    });
    if(root.lucide)lucide.createIcons();
    overlay.querySelector('button').focus();
    return ++ui.request;
  }
  const isCurrent = (request,id) => request===ui.request && ui.overlay && canUse() && id===currentPatientId();
  async function patientData(id) {
    const {data,error}=await db.from('patients').select('id,name,phone,chart_state').eq('id',id).single();
    if(error)throw error;
    const {data:operations,error:operationError}=await db.from('dental_operations').select('code,name,price,action_scope,visual_code');
    if(operationError)throw operationError;
    return {patient:data,operations};
  }
  function defaultExpiry() {
    const date=new Date();date.setDate(date.getDate()+30);
    return localDate(date);
  }
  function localDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  }
  function quoteLink(record) {
    const url=new URL('quotation.html',location.href);url.search='';url.hash=record.token;return url.href;
  }
  function draftData() {
    return {patientName:ui.patient.name,reference:ui.saved?'QT-'+ui.saved.id.slice(0,8).toUpperCase():t('Preview','معاينة'),
      expiresAt:ui.saved?.expires_at,clinic:{name:ui.settings?.clinic_name||'Lumin Dental',logo:ui.settings?.logo_data_url||'',whatsapp:ui.settings?.whatsapp_phone||''},
      ...LuminQuotationModel.publicProjection(ui.patient.chart_state,ui.operations,ui.selectedIds)};
  }
  function renderComposer(excluded=0) {
    loaded();
    const body=ui.overlay.querySelector('[data-quote-body]');
    const expired=ui.saved && new Date(ui.saved.expires_at)<=new Date();
    body.innerHTML=`${excluded ? `<p class="q-feedback">${t('Only selected procedures in Plan status are included.','يتضمن العرض الإجراءات المحددة التي لا تزال في حالة التخطيط فقط.')}</p>` : ''}${!ui.settings?.whatsapp_phone ? `<p class="q-feedback">${t('Set the clinic WhatsApp number under Admin → Print forms → Quotation settings before creating a link.','اضبط رقم واتساب العيادة من المسؤول ← نماذج الطباعة ← إعدادات عروض الأسعار قبل إنشاء الرابط.')}</p>` : ''}<div class="q-form-row"><label class="q-field">${t('Expiry date','تاريخ الانتهاء')}<input type="date" id="quotation-expiry" min="${localDate(new Date())}" value="${ui.saved&&!expired?localDate(new Date(ui.saved.expires_at)):defaultExpiry()}" required/></label>${ui.saved?button('replace',t('Use selected planned procedures','استخدام الإجراءات المخططة المحددة'),'list-checks'):''}</div>${ui.saved&&!expired?`<div class="q-link-field"><input aria-label="${t('Quotation link','رابط عرض الأسعار')}" value="${e(quoteLink(ui.saved))}" readonly/>${button('copy',t('Copy link','نسخ الرابط'),'copy')}${button('preview',t('Open page','فتح الصفحة'),'external-link')}</div>`:''}<div id="quotation-preview"></div>`;
    view().render(body.querySelector('#quotation-preview'),draftData(),language(),{preview:true});
    ui.overlay.querySelector('[data-quote-footer]').innerHTML=`${ui.saved&&!expired?button('whatsapp',t('Open WhatsApp','فتح واتساب'),'message-circle'):''}${button('close',t('Close','إغلاق'),'x')}${button('save',ui.saved?t('Save changes','حفظ التغييرات'):t('Create quotation link','إنشاء رابط عرض الأسعار'),'link','q-primary')}`;
    if(root.lucide)lucide.createIcons();
    focusDialog();
  }
  async function openComposer() {
    if(!canUse())return;
    const patient=getActivePatient();
    const ids=[...selectedFindingIds];
    if(!patient||!ids.length)return;
    const request=modal(t('Patient quotation','عرض أسعار المريض'));
    const id=patient.id;
    try {
      const saved=await saveActivePatientChart();
      if(!saved)throw new Error(t('The chart could not be saved. Try again before sharing.','تعذر حفظ المخطط. حاول مجدداً قبل المشاركة.'));
      await waitForPatientChartSaves(id);
      const [data,settings]=await Promise.all([patientData(id),api({action:'settings'})]);
      if(!isCurrent(request,id)){if(request===ui.request)close();return;}
      const projection=LuminQuotationModel.project(data.patient.chart_state,data.operations,ids,'create');
      if(!projection.eligibleIds.length)throw new Error(t('Select at least one planned procedure.','حدد إجراءً واحداً مخططاً على الأقل.'));
      Object.assign(ui,data,{settings:settings.settings,selectedIds:projection.eligibleIds,saved:null});
      renderComposer(projection.excludedCount);
    } catch(error){if(request===ui.request)loadFailure(error,'retry-composer');}
  }
  async function openHistory() {
    if(!canUse())return;
    const id=currentPatientId();if(!id)return;
    const request=modal(t('Patient quotations','عروض أسعار المريض'));
    try {
      const [data,settings,history]=await Promise.all([patientData(id),api({action:'settings'}),api({action:'list',patient_id:id})]);
      if(!isCurrent(request,id)){if(request===ui.request)close();return;}
      Object.assign(ui,data,{settings:settings.settings,records:history.quotations});renderHistory();
    } catch(error){if(request===ui.request)loadFailure(error,'retry-history');}
  }
  function renderHistory() {
    loaded();
    ui.saved=null;
    ui.overlay.querySelector('[data-quote-body]').innerHTML=ui.records.length?ui.records.map(record=>{
      const revoked=Boolean(record.revoked_at),expired=new Date(record.expires_at)<=new Date();
      return `<article class="q-history-card"><div class="q-history-meta"><strong dir="ltr">QT-${record.id.slice(0,8).toUpperCase()}</strong><span class="q-badge ${revoked||expired?'q-planned':'q-live'}">${revoked?t('Disabled','معطل'):expired?t('Expired','منتهي'):t('Active','نشط')}</span></div><p>${t('Valid until','صالح حتى')} ${view().date(record.expires_at,language())}</p><div class="q-history-actions" data-quote-id="${record.id}">${!revoked?button('edit',t('Manage','إدارة'),'settings-2'):''}${!revoked&&!expired?button('history-copy',t('Copy link','نسخ الرابط'),'copy')+button('history-preview',t('Open page','فتح الصفحة'),'external-link'):''}${!revoked?button('revoke',t('Disable link','تعطيل الرابط'),'link-2-off','q-danger'):''}</div></article>`;
    }).join(''):`<div class="q-empty">${icon('file-text')}<h3>${t('No quotations yet','لا توجد عروض أسعار بعد')}</h3><p>${t('Select planned procedures on the chart, then use the quotation button beside Add invoice.','حدد الإجراءات المخططة على المخطط، ثم اضغط زر عرض الأسعار بجانب إضافة إلى الفاتورة.')}</p></div>`;
    ui.overlay.querySelector('[data-quote-footer]').innerHTML=button('close',t('Close','إغلاق'),'x');
    if(root.lucide)lucide.createIcons();
    focusDialog();
  }
  async function copy(record) {
    const link=quoteLink(record);
    try {await navigator.clipboard.writeText(link);}
    catch {
      const field=document.createElement('textarea');field.value=link;document.body.appendChild(field);field.select();
      const copied=document.execCommand('copy');field.remove();if(!copied)throw new Error(t('Copy the link from the field above.','انسخ الرابط من الحقل أعلاه.'));
    }
    if(typeof showAppointmentNotificationToast==='function')showAppointmentNotificationToast(t('Link copied','تم نسخ الرابط'),t('Ready to share with the patient.','جاهز للمشاركة مع المريض.'));
  }
  async function action(name,trigger) {
    if(name==='close'){if(!ui.busy)close();return;}
    if(name==='retry-composer'){if(!ui.busy)openComposer();return;}
    if(name==='retry-history'){if(!ui.busy)openHistory();return;}
    if(ui.busy||!canUse()||!ui.patient||ui.patient.id!==currentPatientId()){close();return;}
    const record=ui.records.find(item=>item.id===trigger.closest('[data-quote-id]')?.dataset.quoteId)||ui.saved;
    const actionRequest=ui.request;
    const actionPatientId=ui.patient.id;
    try {
      if(name==='copy'||name==='history-copy'){await copy(record);return;}
      if(name==='preview'||name==='history-preview'){window.open(quoteLink(record),'_blank','noopener,noreferrer');return;}
      if(name==='edit'){ui.saved=record;ui.selectedIds=[...record.selected_ids];renderComposer();return;}
      if(name==='replace') {
        const patient=getActivePatient();
        if(patient?.id!==ui.patient.id)throw new Error(t('Open this patient’s chart and select planned procedures first.','افتح مخطط هذا المريض وحدد الإجراءات المخططة أولاً.'));
        if(!await saveActivePatientChart())throw new Error(t('The chart could not be saved.','تعذر حفظ المخطط.'));
        if(!isCurrent(actionRequest,actionPatientId))return;
        const data=await patientData(actionPatientId);
        if(!isCurrent(actionRequest,actionPatientId))return;
        const projection=LuminQuotationModel.project(data.patient.chart_state,data.operations,[...selectedFindingIds],'create');
        if(!projection.eligibleIds.length)throw new Error(t('Select at least one planned procedure.','حدد إجراءً واحداً مخططاً على الأقل.'));
        Object.assign(ui,data,{selectedIds:projection.eligibleIds});renderComposer(projection.excludedCount);return;
      }
      if(name==='whatsapp') {
        const phone=String(ui.patient.phone||'').replace(/\D/g,'');
        const international=phone.startsWith('00')?phone.slice(2):phone.startsWith('0')?'20'+phone.slice(1):phone;
        if(!/^[1-9][0-9]{6,14}$/.test(international))throw new Error(t('Add a valid patient phone number before opening WhatsApp.','أضف رقم هاتف صحيحاً للمريض قبل فتح واتساب.'));
        const message=t(`Hello ${ui.patient.name}, here is your treatment quotation from ${ui.settings.clinic_name}:`,`مرحباً ${ui.patient.name}، إليك عرض أسعار علاجك من ${ui.settings.clinic_name}:`);
        window.open(`https://wa.me/${international}?text=${encodeURIComponent(message+'\n'+quoteLink(record))}`,'_blank','noopener,noreferrer');return;
      }
      if(!['save','revoke'].includes(name))return;
      if(name==='revoke'&&!window.confirm(t('Disable this quotation link? The patient will no longer be able to open it.','هل تريد تعطيل رابط عرض الأسعار؟ لن يتمكن المريض من فتحه.')))return;
      const request=ui.request,id=ui.patient.id;
      ui.busy=true;ui.overlay.querySelectorAll('button').forEach(button=>button.disabled=true);
      let payload={action:'revoke',patient_id:id,id:record?.id,revision:Number(record?.revision)};
      if(name==='save') {
        const input=ui.overlay.querySelector('#quotation-expiry');
        const expiry=new Date(input.value+'T23:59:59');
        if(!input.value||!Number.isFinite(expiry.getTime())||expiry<=new Date())throw new Error('Choose a future expiry date.');
        payload={action:ui.saved?'update':'create',patient_id:id,id:ui.saved?.id,revision:Number(ui.saved?.revision),selected_ids:ui.selectedIds,expires_at:expiry.toISOString(),language:language()};
      }
      const response=await api(payload);
      if(!isCurrent(request,id))return;
      ui.busy=false;
      if(name==='save'){ui.saved=response.quotation;renderComposer();}
      else{ui.records=ui.records.map(item=>item.id===record.id?response.quotation:item);renderHistory();}
    } catch(error){if(actionRequest===ui.request)feedback(error);}
    finally{if(actionRequest===ui.request){ui.busy=false;ui.overlay?.querySelectorAll('button').forEach(button=>button.disabled=false);}}
  }
  function renderSelection(findings,count,loading) {
    const group=document.getElementById('findings-selection-actions');
    const trigger=document.getElementById('findings-quotation-button');
    if(!group||!trigger)return;
    group.hidden=Boolean(loading||!count);
    const patient=typeof getActivePatient==='function'?getActivePatient():null;
    const projection=patient?LuminQuotationModel.project(patient.chartState,dentalOperations,[...selectedFindingIds],'create'):null;
    trigger.disabled=Boolean(loading||!projection?.eligibleIds.length||!canUse());
    const label=projection?.eligibleIds.length?t('Create quotation for selected planned procedures','إنشاء عرض أسعار للإجراءات المخططة المحددة'):t('Select a planned procedure to create a quotation','حدد إجراءً مخططاً لإنشاء عرض أسعار');
    trigger.setAttribute('aria-label',label);trigger.title=label;
  }
  async function renderSettings() {
    const container=document.getElementById('admin-quotation-settings');
    if(!container||!currentUserAccess?.isAdmin)return;
    const before=sessionId();
    container.innerHTML='<div class="q-skeleton"></div>';
    try {
      const {settings}=await api({action:'settings'});
      if(before!==sessionId()||!currentUserAccess?.isAdmin)return;
      let logo=settings.logo_data_url||'';
      container.dir=language()==='ar'?'rtl':'ltr';
      container.innerHTML=`<h3>${t('Quotation settings','إعدادات عروض الأسعار')}</h3><p>${t('Clinic identity and contact details shown on patient quotations.','اسم العيادة وبيانات التواصل التي تظهر في عروض أسعار المرضى.')}</p><form><div class="q-form-row"><label class="q-field">${t('Clinic name','اسم العيادة')}<input name="clinic_name" maxlength="120" required value="${e(settings.clinic_name)}"/></label><label class="q-field">${t('Clinic WhatsApp number','رقم واتساب العيادة')}<input name="whatsapp_phone" type="tel" inputmode="tel" placeholder="+20…" required value="${e(settings.whatsapp_phone)}" dir="ltr"/></label></div><label class="q-field">${t('Clinic logo (optional)','شعار العيادة (اختياري)')}<input name="logo" type="file" accept="image/png,image/jpeg,image/webp"/></label><img class="q-logo-preview" alt="" ${logo?`src="${e(logo)}"`:'hidden'}/><div class="q-form-row"><button type="button" class="q-button" data-remove-logo>${icon('image-off')}${t('Remove logo','إزالة الشعار')}</button><button type="submit" class="q-button q-primary">${icon('save')}${t('Save quotation settings','حفظ إعدادات عروض الأسعار')}</button></div><p class="q-feedback" role="status" data-settings-feedback hidden></p></form>`;
      const form=container.querySelector('form'),image=container.querySelector('img'),status=container.querySelector('[data-settings-feedback]');
      const show=message=>{status.textContent=message;status.hidden=false;};
      form.logo.addEventListener('change',async()=>{
        const file=form.logo.files[0];if(!file)return;
        try {
          if(file.size>5*1024*1024||!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('image');
          logo=await optimisePrescriptionLogo(file);
          if(!/^data:image\/(png|jpeg|webp);base64,/.test(logo)||logo.length>300000)throw new Error('image');
          image.src=logo;image.hidden=false;
        } catch(_){show(t('Choose a PNG, JPEG, or WebP logo up to 5 MB.','اختر شعاراً بصيغة PNG أو JPEG أو WebP بحجم لا يتجاوز ٥ ميجابايت.'));}
      });
      container.querySelector('[data-remove-logo]').addEventListener('click',()=>{logo='';form.logo.value='';image.removeAttribute('src');image.hidden=true;});
      form.addEventListener('submit',async event=>{
        event.preventDefault();const submit=form.querySelector('[type=submit]');submit.disabled=true;
        try{await api({action:'save_settings',clinic_name:form.clinic_name.value,whatsapp_phone:form.whatsapp_phone.value,logo_data_url:logo});show(t('Quotation settings saved.','تم حفظ إعدادات عروض الأسعار.'));}
        catch(_){show(t('Could not save. Check the clinic name and international WhatsApp number.','تعذر الحفظ. تحقق من اسم العيادة ورقم واتساب الدولي.'));}
        finally{submit.disabled=false;}
      });
      if(root.lucide)lucide.createIcons();
    } catch(_){container.innerHTML=`<p>${t('Could not load quotation settings.','تعذر تحميل إعدادات عروض الأسعار.')}</p><button type="button" class="q-button" onclick="renderQuotationSettings()">${t('Try again','حاول مجدداً')}</button>`;}
  }
  root.openPatientQuotation=openComposer;
  root.openPatientQuotations=openHistory;
  root.renderQuotationSelectionActions=renderSelection;
  root.renderQuotationSettings=renderSettings;
  root.resetQuotationUi=close;
  root.refreshQuotationLanguage=function() {
    const history=document.getElementById('profile-quotations-button');
    const label=t('Quotations','عروض الأسعار');
    if(history){history.querySelector('span').textContent=label;history.setAttribute('aria-label',label);history.title=label;}
    if(typeof selectedFindingIds!=='undefined'&&typeof chartInvoiceStateLoading!=='undefined')renderSelection([],selectedFindingIds.size,chartInvoiceStateLoading);
    if(typeof adminActiveTab!=='undefined'&&adminActiveTab==='print-forms'&&currentUserAccess?.isAdmin)renderSettings();
  };
})(globalThis);
