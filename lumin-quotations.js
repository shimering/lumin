(function (root) {
  'use strict';
  const ui = {request:0,patient:null,operations:[],settings:null,selectedIds:[],saved:null,busy:false,overlay:null,returnFocus:null,bodyOverflow:''};
  const history = {request:0,patientId:null,patient:null,operations:[],records:[],hasMore:false,busy:false};
  const view = () => root.LuminQuotationView;
  const language = () => typeof currentUiLanguage !== 'undefined' ? currentUiLanguage : 'en';
  const quotationLanguage = 'ar';
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
      'Choose a future expiry date.':'اختر تاريخ انتهاء في المستقبل.',
      'Select planned procedures.':'حدد الإجراءات المخططة.',
      'Could not delete quotation.':'تعذر حذف عرض الأسعار.'
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
    const returnFocus=ui.returnFocus?.isConnected?ui.returnFocus:document.querySelector('[data-patient-workspace-tab="quotations"][aria-selected="true"]');
    returnFocus?.focus({preventScroll:true});
    ui.patient=null;ui.saved=null;ui.selectedIds=[];ui.busy=false;
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
    const url=new URL('quotation.html',location.href);url.search='';url.hash='';url.searchParams.set('q',record.token);return url.href;
  }
  function draftData() {
    return {patientName:ui.patient.name,reference:ui.saved?'QT-'+ui.saved.id.slice(0,8).toUpperCase():t('Preview','معاينة'),
      expiresAt:ui.saved?.expires_at,clinic:{name:ui.settings?.clinic_name||'Lumin Dental',logo:ui.settings?.logo_data_url||'',whatsapp:ui.settings?.whatsapp_phone||''},
      ...LuminQuotationModel.publicProjection(ui.patient.chart_state,ui.operations,ui.selectedIds)};
  }
  function procedurePicker() {
    const candidates=LuminQuotationModel.collect(ui.patient.chart_state,ui.operations);
    const original=new Set(ui.saved?.selected_ids||[]);
    const ids=[...new Set([...candidates.filter(item=>item.status==='P'||original.has(item.id)).map(item=>item.id),...original])];
    return `<details class="q-procedure-picker" ${ui.saved?'open':''}><summary>${t('Included procedures','الإجراءات المشمولة')} <span data-quote-selected-count>${ui.selectedIds.length}</span>${icon('chevron-down')}</summary><p>${t('Add planned procedures or remove procedures from this quotation.','أضف إجراءات مخططة أو أزل إجراءات من عرض الأسعار.')}</p><div class="q-procedure-options">${ids.map(id=>{
      const candidate=candidates.find(item=>item.id===id);
      const item=LuminQuotationModel.publicProjection(ui.patient.chart_state,ui.operations,[id]).items[0];
      const label=item?.name||candidate?.op?.name||t('Removed from plan','أُزيل من الخطة');
      const target=item?view().targetLabel(item,language()):candidate?.toothId?LuminQuotationModel.toothLabel(candidate.toothId):'';
      const status=candidate?.status==='P'?t('Planned','مخطط'):candidate?.status==='In'?t('In progress','قيد التنفيذ'):t('No longer in plan','لم يعد ضمن الخطة');
      return `<label class="q-procedure-option"><input type="checkbox" data-quote-procedure value="${id}" ${ui.selectedIds.includes(id)?'checked':''}/><span><strong dir="auto">${e(label)}</strong><small dir="auto">${e(target)} · ${status}</small></span><strong>${e(view().money(item?.amount||0,language()))}</strong></label>`;
    }).join('')}</div></details>`;
  }
  function renderComposer(excluded=0) {
    loaded();
    const body=ui.overlay.querySelector('[data-quote-body]');
    const expired=ui.saved && new Date(ui.saved.expires_at)<=new Date();
    const shareable=ui.saved&&!expired&&!ui.saved.revoked_at;
    body.innerHTML=`${excluded ? `<p class="q-feedback">${t('Only selected procedures in Plan status are included.','يتضمن العرض الإجراءات المحددة التي لا تزال في حالة التخطيط فقط.')}</p>` : ''}${!ui.settings?.whatsapp_phone ? `<p class="q-feedback">${t('Set the clinic WhatsApp number under Admin → Print forms → Quotation settings before creating a link.','اضبط رقم واتساب العيادة من المسؤول ← نماذج الطباعة ← إعدادات عروض الأسعار قبل إنشاء الرابط.')}</p>` : ''}<div class="q-form-row"><label class="q-field">${t('Expiry date','تاريخ الانتهاء')}<input type="date" id="quotation-expiry" min="${localDate(new Date())}" value="${ui.saved&&!expired?localDate(new Date(ui.saved.expires_at)):defaultExpiry()}" required/></label>${ui.saved?button('replace',t('Use selected planned procedures','استخدام الإجراءات المخططة المحددة'),'list-checks'):''}</div>${ui.saved&&!expired?`<div class="q-link-field"><input aria-label="${t('Quotation link','رابط عرض الأسعار')}" value="${e(quoteLink(ui.saved))}" readonly/>${button('copy',t('Copy link','نسخ الرابط'),'copy')}${button('preview',t('Open page','فتح الصفحة'),'external-link')}</div>`:''}<div id="quotation-preview"></div>`;
    view().render(body.querySelector('#quotation-preview'),draftData(),quotationLanguage,{preview:true});
    if(!shareable)body.querySelector('.q-link-field')?.remove();
    if(ui.saved?.revoked_at)body.insertAdjacentHTML('afterbegin',`<p class="q-feedback">${t('This link is disabled. Editing keeps it disabled.','هذا الرابط معطل. سيظل معطلاً بعد التعديل.')}</p>`);
    body.querySelector('#quotation-preview').insertAdjacentHTML('beforebegin',procedurePicker());
    body.querySelectorAll('[data-quote-procedure]').forEach(input=>input.addEventListener('change',()=>{
      ui.selectedIds=input.checked?[...new Set([...ui.selectedIds,input.value])]:ui.selectedIds.filter(id=>id!==input.value);
      body.querySelector('[data-quote-selected-count]').textContent=ui.selectedIds.length;
      view().render(body.querySelector('#quotation-preview'),draftData(),quotationLanguage,{preview:true});
    }));
    ui.overlay.querySelector('[data-quote-footer]').innerHTML=`${shareable?button('whatsapp',t('Open WhatsApp','فتح واتساب'),'message-circle'):''}${button('close',t('Close','إغلاق'),'x')}${button('save',ui.saved?t('Save changes','حفظ التغييرات'):t('Create quotation link','إنشاء رابط عرض الأسعار'),'link','q-primary')}`;
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
    if(canUse()&&currentPatientId())openPatientWorkspaceTab('quotations');
  }
  const historyVisible=()=>!document.getElementById('view-patient-quotations')?.classList.contains('hidden')&&Boolean(document.getElementById('view-patient-quotations'));
  function resetHistory() {
    history.request++;Object.assign(history,{patientId:null,patient:null,operations:[],records:[],hasMore:false,busy:false});
    const content=document.getElementById('patient-quotations-content');if(content){content.innerHTML='';content.removeAttribute('aria-busy');}
  }
  function historyLabels() {
    const section=document.getElementById('view-patient-quotations');if(!section)return;
    section.dir=language()==='ar'?'rtl':'ltr';
    section.querySelector('.app-page-title').textContent=t('Quotations','عروض الأسعار');
    section.querySelector('[data-quotation-chart-label]').textContent=t('Open dental chart','فتح مخطط الأسنان');
  }
  function renderHistoryCards() {
    const content=document.getElementById('patient-quotations-content');if(!content)return;
    content.innerHTML=`<p class="q-history-note">${t('Quotations for this patient. Totals follow the current treatment plan.','عروض أسعار هذا المريض. تتبع المبالغ خطة العلاج الحالية.')}</p><p class="q-feedback" data-history-feedback role="alert" hidden></p>`+(history.records.length?`<div class="q-history-grid">${history.records.map(record=>{
      const revoked=Boolean(record.revoked_at),expired=new Date(record.expires_at)<=new Date();
      const projection=LuminQuotationModel.publicProjection(history.patient.chart_state,history.operations,record.selected_ids);
      return `<article class="q-history-card" data-quote-id="${record.id}"><div class="q-history-meta"><strong dir="ltr">QT-${record.id.slice(0,8).toUpperCase()}</strong><span class="q-badge ${revoked?'q-muted':expired?'q-planned':'q-live'}">${revoked?t('Disabled','معطل'):expired?t('Expired','منتهي'):t('Active','نشط')}</span></div><div class="q-history-value"><strong>${e(view().money(projection.total,language()))}</strong><span>${projection.items.length} ${projection.items.length===1?t('treatment remaining','إجراء متبقٍ'):t('treatments remaining','إجراءات متبقية')}</span></div><p>${record.created_at?t('Created','أُنشئ في')+' '+view().date(record.created_at,language())+' · ':''}${t('Valid until','صالح حتى')} ${view().date(record.expires_at,language())}</p><div class="q-history-actions">${button('edit',t('Edit','تعديل'),'pencil')}${!revoked&&!expired?button('history-copy',t('Copy link','نسخ الرابط'),'copy')+button('history-preview',t('Open page','فتح الصفحة'),'external-link'):''}${!revoked?button('revoke',t('Disable link','تعطيل الرابط'),'link-2-off'):''}${button('delete',t('Delete','حذف'),'trash-2','q-danger')}</div></article>`;
    }).join('')}</div>${history.hasMore?button('more',t('Load more','تحميل المزيد'),'chevron-down'):''}`:`<div class="q-empty q-panel">${icon('file-text')}<h3>${t('No quotations yet','لا توجد عروض أسعار بعد')}</h3><p>${t('Select planned procedures on the chart, then use the quotation button beside Add invoice.','حدد الإجراءات المخططة على المخطط، ثم اضغط زر عرض الأسعار بجانب إضافة إلى الفاتورة.')}</p>${button('chart',t('Open dental chart','فتح مخطط الأسنان'),'layout-grid','q-primary')}</div>`);
    if(root.lucide)lucide.createIcons();
  }
  async function renderPatientQuotations(options={}) {
    const content=document.getElementById('patient-quotations-content'),id=currentPatientId();
    if(!content||!canUse()||!id||!historyVisible()){resetHistory();return;}
    historyLabels();
    if(!content.dataset.quotationBound){content.dataset.quotationBound='true';content.addEventListener('click',event=>{const trigger=event.target.closest('[data-quote-action]');if(trigger&&!trigger.disabled)historyAction(trigger);});}
    const append=options.append&&history.patientId===id;
    const request=++history.request,user=sessionId();
    const current=()=>request===history.request&&user===sessionId()&&id===currentPatientId()&&canUse()&&historyVisible();
    if(history.patientId!==id){history.records=[];history.patientId=id;}
    history.busy=true;content.setAttribute('aria-busy','true');
    if(!append&&!options.quiet)content.innerHTML='<div class="q-skeleton"></div><div class="q-skeleton"></div>';
    content.querySelectorAll('button').forEach(button=>button.disabled=true);
    try {
      const [data,result]=await Promise.all([patientData(id),api({action:'list',patient_id:id,offset:append?history.records.length:0})]);
      if(!current())return;
      Object.assign(history,data,{records:append?[...new Map([...history.records,...result.quotations].map(record=>[record.id,record])).values()]:result.quotations,hasMore:Boolean(result.has_more)});
      if(typeof updatePatientWorkspaceNavigation==='function')updatePatientWorkspaceNavigation(typeof getKnownPatient==='function'?getKnownPatient(id)||data.patient:data.patient,'quotations');
      renderHistoryCards();
    }catch(_){if(current()){
      content.innerHTML=`<div class="q-empty q-panel">${icon('cloud-off')}<h3>${t('Could not load quotations','تعذر تحميل عروض الأسعار')}</h3><p>${t('Check your connection and try again.','تحقق من اتصالك وحاول مجدداً.')}</p>${button('refresh',t('Try again','حاول مجدداً'),'refresh-cw')}</div>`;
      if(root.lucide)lucide.createIcons();
    }}finally{if(current()){history.busy=false;content.removeAttribute('aria-busy');}}
  }
  async function openEditor(record) {
    const id=currentPatientId(),request=modal(t('Edit quotation','تعديل عرض الأسعار'));
    try{
      if(typeof waitForPatientChartSaves==='function')await waitForPatientChartSaves(id);
      const [data,settings,result]=await Promise.all([patientData(id),api({action:'settings'}),api({action:'get',patient_id:id,id:record.id})]);
      if(!isCurrent(request,id)){if(request===ui.request)close();return;}
      Object.assign(ui,data,{settings:settings.settings,saved:result.quotation,selectedIds:[...result.quotation.selected_ids]});renderComposer();
    }catch(error){if(request===ui.request){loadFailure(error,'retry-editor');ui.saved=record;}}
  }
  function confirmHistoryAction(record,deleting) {
    modal(deleting?t('Delete quotation?','حذف عرض الأسعار؟'):t('Disable quotation link?','تعطيل رابط عرض الأسعار؟'));
    ui.overlay.querySelector('.q-dialog').classList.add('q-confirm-dialog');
    ui.patient={id:currentPatientId()};ui.saved=record;
    ui.overlay.querySelector('[data-quote-body]').innerHTML=`<div class="q-empty">${icon(deleting?'trash-2':'link-2-off')}<h3 dir="ltr">QT-${record.id.slice(0,8).toUpperCase()}</h3><p>${deleting?t('This permanently deletes the quotation and stops its patient link. Patient treatments are kept.','سيُحذف عرض الأسعار نهائياً ويتوقف رابط المريض. ستبقى إجراءات العلاج محفوظة.'):t('The patient will no longer be able to open this link.','لن يتمكن المريض من فتح هذا الرابط بعد التعطيل.')}</p></div>`;
    ui.overlay.querySelector('[data-quote-footer]').innerHTML=button('close',t('Cancel','إلغاء'),'x')+button(deleting?'delete':'revoke',deleting?t('Delete quotation','حذف عرض الأسعار'):t('Disable link','تعطيل الرابط'),deleting?'trash-2':'link-2-off','q-danger');
    if(root.lucide)lucide.createIcons();focusDialog();
  }
  async function historyAction(trigger) {
    const name=trigger.dataset.quoteAction,id=currentPatientId(),request=history.request;
    if(!canUse()||!historyVisible()||history.busy||history.patientId!==id)return;
    if(name==='refresh'){await renderPatientQuotations();return;}
    if(name==='more'){await renderPatientQuotations({append:true});return;}
    if(name==='chart'){openPatientWorkspaceTab('chart');return;}
    const record=history.records.find(item=>item.id===trigger.closest('[data-quote-id]')?.dataset.quoteId);if(!record)return;
    if(name==='edit'){await openEditor(record);return;}
    if(name==='delete'||name==='revoke'){confirmHistoryAction(record,name==='delete');return;}
    try{
      if(name==='history-copy')await copy(record);
      if(name==='history-preview')window.open(quoteLink(record),'_blank','noopener,noreferrer');
    }catch(_){if(request===history.request&&id===currentPatientId()){
      const target=document.querySelector('[data-history-feedback]');if(target){target.textContent=t('Could not copy the link. Open the editor and copy the link from its field.','تعذر نسخ الرابط. افتح المحرر وانسخ الرابط من حقله.');target.hidden=false;}
    }}
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
    if(name==='retry-editor'){if(!ui.busy&&ui.saved)openEditor(ui.saved);return;}
    if(ui.busy||!canUse()||!ui.patient||ui.patient.id!==currentPatientId()){close();return;}
    const record=ui.saved;
    const actionRequest=ui.request;
    const actionPatientId=ui.patient.id;
    try {
      if(name==='copy'||name==='history-copy'){await copy(record);return;}
      if(name==='preview'||name==='history-preview'){window.open(quoteLink(record),'_blank','noopener,noreferrer');return;}
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
        const message=view().text(quotationLanguage,`Hello ${ui.patient.name}, here is your treatment quotation from ${ui.settings.clinic_name}:`,`مرحباً ${ui.patient.name}، إليك عرض أسعار علاجك من ${ui.settings.clinic_name}:`);
        window.open(`https://wa.me/${international}?text=${encodeURIComponent(message+'\n'+quoteLink(record))}`,'_blank','noopener,noreferrer');return;
      }
      if(!['save','revoke','delete'].includes(name))return;
      const request=ui.request,id=ui.patient.id;
      ui.busy=true;ui.overlay.querySelectorAll('button').forEach(button=>button.disabled=true);
      let payload={action:name,patient_id:id,id:record?.id,revision:Number(record?.revision)};
      if(name==='save') {
        if(!ui.selectedIds.length)throw new Error('Select planned procedures.');
        const input=ui.overlay.querySelector('#quotation-expiry');
        const expiry=new Date(input.value+'T23:59:59');
        if(!input.value||!Number.isFinite(expiry.getTime())||expiry<=new Date())throw new Error('Choose a future expiry date.');
        payload={action:ui.saved?'update':'create',patient_id:id,id:ui.saved?.id,revision:Number(ui.saved?.revision),selected_ids:ui.selectedIds,expires_at:expiry.toISOString(),language:quotationLanguage};
      }
      const response=await api(payload);
      if(!isCurrent(request,id))return;
      ui.busy=false;
      if(name==='save'){ui.saved=response.quotation;renderComposer();}
      else close();
      if(historyVisible())await renderPatientQuotations({quiet:true});
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
  function renderFormLogo(value) {
    const container=document.querySelector('#admin-quotation-settings .q-shared-logo');
    if(!container)return;
    const logo=view().logoDataUrl(value);
    container.innerHTML=`<strong>${t('Clinic logo','شعار العيادة')}</strong><p>${t('Uses the logo saved in the prescription form settings.','يستخدم الشعار المحفوظ في إعدادات نموذج الوصفة الطبية.')}</p>${logo?`<img class="q-logo-preview" alt="${t('Clinic logo','شعار العيادة')}" src="${e(logo)}"/>`:`<p>${t('No form logo saved yet.','لم يُحفظ شعار للنموذج بعد.')}</p>`}<button type="button" class="q-button" data-form-logo>${icon('image')}${t('Manage form logo','إدارة شعار النموذج')}</button>`;
    container.querySelector('[data-form-logo]').addEventListener('click',()=>{
      const target=document.getElementById('prescription-print-logo-file')?.closest('section')||document.getElementById('admin-prescription-print-form');
      target?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});
    });
    if(root.lucide)lucide.createIcons();
  }
  async function renderSettings() {
    const container=document.getElementById('admin-quotation-settings');
    if(!container||!currentUserAccess?.isAdmin)return;
    const before=sessionId();
    container.innerHTML='<div class="q-skeleton"></div>';
    try {
      const {settings}=await api({action:'settings'});
      if(before!==sessionId()||!currentUserAccess?.isAdmin)return;
      container.dir=language()==='ar'?'rtl':'ltr';
      container.innerHTML=`<h3>${t('Quotation settings','إعدادات عروض الأسعار')}</h3><p>${t('Clinic identity and contact details shown on patient quotations.','اسم العيادة وبيانات التواصل التي تظهر في عروض أسعار المرضى.')}</p><form><div class="q-form-row"><label class="q-field">${t('Clinic name','اسم العيادة')}<input name="clinic_name" maxlength="120" required value="${e(settings.clinic_name)}"/></label><label class="q-field">${t('Clinic WhatsApp number','رقم واتساب العيادة')}<input name="whatsapp_phone" type="tel" inputmode="tel" placeholder="+20…" required value="${e(settings.whatsapp_phone)}" dir="ltr"/></label></div><div class="q-shared-logo"></div><div class="q-form-row"><button type="submit" class="q-button q-primary">${icon('save')}${t('Save quotation settings','حفظ إعدادات عروض الأسعار')}</button></div><p class="q-feedback" role="status" data-settings-feedback hidden></p></form>`;
      const form=container.querySelector('form'),status=container.querySelector('[data-settings-feedback]');
      const show=message=>{status.textContent=message;status.hidden=false;};
      renderFormLogo(settings.logo_data_url);
      form.addEventListener('submit',async event=>{
        event.preventDefault();const submit=form.querySelector('[type=submit]');submit.disabled=true;
        try{await api({action:'save_settings',clinic_name:form.clinic_name.value,whatsapp_phone:form.whatsapp_phone.value});show(t('Quotation settings saved.','تم حفظ إعدادات عروض الأسعار.'));}
        catch(_){show(t('Could not save. Check the clinic name and international WhatsApp number.','تعذر الحفظ. تحقق من اسم العيادة ورقم واتساب الدولي.'));}
        finally{submit.disabled=false;}
      });
      if(root.lucide)lucide.createIcons();
    } catch(_){container.innerHTML=`<p>${t('Could not load quotation settings.','تعذر تحميل إعدادات عروض الأسعار.')}</p><button type="button" class="q-button" onclick="renderQuotationSettings()">${t('Try again','حاول مجدداً')}</button>`;}
  }
  root.openPatientQuotation=openComposer;
  root.openPatientQuotations=openHistory;
  root.renderPatientQuotations=renderPatientQuotations;
  root.resetPatientQuotations=resetHistory;
  root.renderQuotationSelectionActions=renderSelection;
  root.renderQuotationSettings=renderSettings;
  root.refreshQuotationFormLogo=renderFormLogo;
  root.resetQuotationUi=function(){close();resetHistory();};
  root.refreshQuotationLanguage=function() {
    const label=t('Quotations','عروض الأسعار');
    const tab=document.querySelector('[data-patient-workspace-tab="quotations"]');
    if(tab){tab.querySelector('span').textContent=label;tab.setAttribute('aria-label',label);tab.title=label;}
    historyLabels();
    if(historyVisible()&&canUse())renderPatientQuotations({quiet:true});
    if(typeof selectedFindingIds!=='undefined'&&typeof chartInvoiceStateLoading!=='undefined')renderSelection([],selectedFindingIds.size,chartInvoiceStateLoading);
    if(typeof adminActiveTab!=='undefined'&&adminActiveTab==='print-forms'&&currentUserAccess?.isAdmin)renderSettings();
  };
})(globalThis);
