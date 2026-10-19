/* Category-based clinic inventory. Stock changes use server-validated balances. */
(function (host) {
  'use strict';
  const model=host.LuminInventoryModel;
  const pictureSizes=['small','medium','large'];
  function savedPictureSize(){try{const value=host.localStorage.getItem('lumin.inventory.pictureSize');return pictureSizes.includes(value)?value:'large';}catch(_){return 'large';}}
  let pictureObserver=null,picturePanel=null;
  const state={pictureSize:savedPictureSize(),quickQueue:[],quickBases:new Map(),quickEpoch:0,dataSequence:0,refreshRead:null,realtimeTimer:null,actor:'',token:0,dialogToken:0,report:null,loading:false,saving:false,error:'',message:'',loadedAt:0,query:'',category:'all',status:'all',sort:'name',page:1,selected:new Map(),dialog:null,pending:null,quickPending:null,timer:null,returnFocus:null,management:null,quickSaving:false,quickRefreshQueued:false};
  const words={
    supplierList:['Supplier list','قائمة المورد'],
    viewOptions:['View options','خيارات العرض'],smallPictures:['Small pictures · Rows','صور صغيرة · صفوف'],mediumPictures:['Medium pictures','صور متوسطة'],largePictures:['Large pictures','صور كبيرة'],
    mainCategory:['Main category','التصنيف الرئيسي'],subcategory:['Subcategory','التصنيف الفرعي'],allSubcategories:['All subcategories','كل التصنيفات الفرعية'],move:['Move','نقل'],moveItem:['Move item','نقل الصنف'],moveCategory:['Move subcategory','نقل التصنيف الفرعي'],destination:['Move to','النقل إلى'],dragHelp:['Drag items or subcategories to a category. Use the Move handle to choose a destination.','اسحب الأصناف أو التصنيفات الفرعية إلى تصنيف. استخدم زر النقل لاختيار الوجهة.'],retryMove:['Retry move','إعادة محاولة النقل'],deleteItem:['Delete item','حذف الصنف'],deleteBody:['Remove this item from inventory?','هل تريد حذف هذا الصنف من المخزون؟'],deletedItem:['Deleted item','صنف محذوف'],moveInvalid:['Choose another parent without creating a cycle or exceeding three category levels.','اختر تصنيفاً أباً آخر دون إنشاء حلقة أو تجاوز ثلاثة مستويات.'],moving:['Moving…','جار النقل…'],moved:['Moved successfully.','تم النقل بنجاح.'],itemMissing:['This item was deleted or is no longer available.','تم حذف هذا الصنف أو لم يعد متاحاً.'],chooseDestination:['Choose a destination','اختر وجهة النقل'],
    chooseUnit:['Choose a stock unit','اختر وحدة المخزون'],
    categoryDepth:['Choose a main category or first subcategory as the parent. A second subcategory is the final level.','اختر تصنيفاً رئيسياً أو تصنيفاً فرعياً أول كأب. التصنيف الفرعي الثاني هو المستوى الأخير.'],manageTitle:['Manage inventory','إدارة المخزون'],manageItems:['Items','الأصناف'],editItem:['Edit item','تعديل الصنف'],itemsEmpty:['No items found','لا توجد أصناف'],itemsHelp:['Add an item or try another name.','أضف صنفاً أو ابحث باسم آخر.'],
    nameEn:['English name','الاسم بالإنجليزية'],nameAr:['Arabic name','الاسم بالعربية'],nameHelp:['Enter at least one name. The app uses the available name if a translation is blank.','أدخل اسماً واحداً على الأقل. يستخدم التطبيق الاسم المتاح إذا كانت الترجمة فارغة.'],
    increase:['Increase stock by 1','زيادة المخزون بمقدار ١'],decrease:['Decrease stock by 1','خفض المخزون بمقدار ١'],unconfirmed:['The change could not be confirmed. Retry to check it safely.','تعذر تأكيد التغيير. أعد المحاولة للتحقق منه بأمان.'],retryStock:['Retry change','إعادة محاولة التغيير'],oneRequired:['At least one stock unit is needed to decrease by 1.','يلزم توفر وحدة مخزون واحدة على الأقل للخفض بمقدار ١.'],stockLimit:['The maximum stock quantity has been reached.','تم بلوغ الحد الأقصى لكمية المخزون.'],
    inventory:['Inventory','المخزون'],subtitle:['Clinic supplies, categories & stock levels','مستلزمات العيادة والتصنيفات وكميات المخزون'],add:['Add item','إضافة صنف'],receive:['Receive stock','استلام مخزون'],use:['Record use','تسجيل استهلاك'],refresh:['Refresh inventory','تحديث المخزون'],total:['Total items','إجمالي الأصناف'],categories:['Categories','التصنيفات'],low:['Low stock','مخزون منخفض'],out:['Out of stock','نفد المخزون'],unknown:['Not counted','لم يتم الجرد'],unconfigured:['Minimum not set','الحد الأدنى غير محدد'],healthy:['In stock','متاح'],review:['Needs review','تحتاج مراجعة'],threshold:['At or below minimum','عند الحد الأدنى أو أقل'],zero:['Recorded quantity is zero','الكمية المسجلة صفر'],all:['All items','كل الأصناف'],allstatus:['All statuses','كل الحالات'],items:['items','أصناف'],category:['Category','التصنيف'],manage:['Manage inventory','إدارة المخزون'],stock:['Stock','الأصناف'],search:['Search items or categories','ابحث عن صنف أو تصنيف'],name:['Item name','اسم الصنف'],current:['Current quantity','الكمية الحالية'],minimum:['Minimum','الحد الأدنى'],unit:['Stock unit','وحدة المخزون'],unitmissing:['Unit not set','الوحدة غير محددة'],details:['Item details','تفاصيل الصنف'],close:['Close','إغلاق'],cancel:['Cancel','إلغاء'],save:['Save changes','حفظ التغييرات'],notset:['Not set','غير محدد'],uncategorized:['Uncategorized','غير مصنف'],empty:['Your inventory starts here','ابدأ بإضافة مخزون العيادة'],emptybody:['Add your first item to organize the clinic’s supplies.','أضف أول صنف لتنظيم مستلزمات العيادة.'],nomatches:['No matching items','لا توجد أصناف مطابقة'],nomatchesbody:['Choose another category or clear the filters.','اختر تصنيفاً آخر أو امسح عوامل التصفية.'],clear:['Clear filters','مسح عوامل التصفية'],retry:['Try again','إعادة المحاولة'],loading:['Loading inventory','جار تحميل المخزون'],failed:['Could not refresh inventory. Your last successful view is still shown.','تعذر تحديث المخزون. ما زالت آخر بيانات تم تحميلها ظاهرة.'],notavailable:['Inventory is not available for this clinic yet. Contact your administrator.','المخزون غير متاح لهذه العيادة بعد. تواصل مع المسؤول.'],saved:['Inventory updated.','تم تحديث المخزون.'],offline:['Connect to the internet to save stock changes.','اتصل بالإنترنت لحفظ حركات المخزون.'],readOnly:['Read only','عرض فقط'],selected:['selected','محدد'],assign:['Assign category','تعيين التصنيف'],select:['Select item','تحديد الصنف'],selectpage:['Select this page','تحديد الصفحة'],sort:['Sort items','ترتيب الأصناف'],statussort:['Stock priority','أولوية المخزون'],namesort:['Name','الاسم'],quantitysort:['Quantity','الكمية'],previous:['Previous page','الصفحة السابقة'],next:['Next page','الصفحة التالية'],of:['of','من'],opening:['Opening quantity','الكمية الافتتاحية'],unknownhelp:['Leave blank if this item has not been counted.','اتركها فارغة إذا لم يتم جرد الصنف.'],optional:['Optional','اختياري'],needsetup:['Set the stock unit and opening count before receiving or recording use.','حدد وحدة المخزون والكمية الافتتاحية قبل الاستلام أو تسجيل الاستهلاك.'],quantity:['Quantity','الكمية'],english:['Category name','اسم التصنيف'],arabic:['Arabic category name','اسم التصنيف بالعربية'],parent:['Parent category','التصنيف الرئيسي'],newcategory:['Add category','إضافة تصنيف'],editcategory:['Edit category','تعديل التصنيف'],archivecategory:['Archive category','أرشفة التصنيف'],archivecategorybody:['Archive this category? Move its active items and subcategories first.','هل تريد أرشفة التصنيف؟ انقل أصنافه وتصنيفاته الفرعية النشطة أولاً.'],unitlocked:['A counted item’s unit cannot be changed. Create a separate item for another unit.','لا يمكن تغيير وحدة صنف تم جرده. أضف صنفاً منفصلاً لوحدة أخرى.'],lastloaded:['Last refreshed','آخر تحديث'],itemrequired:['Choose an item','اختر صنفاً'],confirm:['Confirm','تأكيد'],bulkhelp:['Move the selected items without changing their stock balances.','انقل الأصناف المحددة دون تغيير أرصدتها.']
  };
  const el=id=>document.getElementById(id);
  const isArabic=()=>typeof currentUiLanguage!=='undefined'?currentUiLanguage==='ar':document.documentElement.dir==='rtl';
  const t=key=>(words[key]||[key,key])[isArabic()?1:0];
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon=name=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
  // Lucide 0.468 also replaces already-rendered SVGs. Limit it to new inventory icons.
  function icons(){
    if(!host.lucide)return;
    const nodes=document.querySelectorAll('#view-inventory i[data-lucide],#inventory-overlay i[data-lucide]');if(!nodes.length)return;
    nodes.forEach(node=>{node.setAttribute('data-inv-icon',node.getAttribute('data-lucide'));node.removeAttribute('data-lucide');});
    host.lucide.createIcons({nameAttr:'data-inv-icon'});
    document.querySelectorAll('svg[data-inv-icon]').forEach(node=>{node.setAttribute('data-inventory-icon',node.getAttribute('data-inv-icon'));node.removeAttribute('data-inv-icon');node.removeAttribute('data-lucide');});
  }
  const number=value=>value==null?'—':new Intl.NumberFormat(isArabic()?'ar-EG':'en-GB',{maximumFractionDigits:3}).format(Number(value));
  const actor=()=>typeof currentSession!=='undefined'?currentSession?.user?.id||'':'';
  function newRequestId(){if(host.crypto.randomUUID)return host.crypto.randomUUID();const bytes=host.crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;}
  const allowed=()=>typeof hasPageAccess==='function'&&hasPageAccess('inventory');
  const signature=()=>`${actor()}:${allowed()}:${typeof currentUserAccess!=='undefined'?[...currentUserAccess?.permissions||[]].sort().join(',')+Boolean(currentUserAccess?.isAdmin):''}`;
  const capable=key=>allowed()&&Boolean(state.report?.permissions?.[key]);
  const categories=()=>state.report?.categories||[];
  const itemName=item=>model.itemName(item,isArabic()?'ar':'en');
  const categoryName=category=>category?(isArabic()&&category.name_ar?category.name_ar:category.name):t('uncategorized');
  const categoryLabel=category=>category?model.categoryPath(category,categories()).map(categoryName).join(' / '):t('uncategorized');
  const orderedCategories=()=>model.categoryTree(categories(),isArabic()?'ar':'en');
  const moveTargets=category=>model.categoryMoveTargets(category,categories(),isArabic()?'ar':'en').filter(c=>c.id!==category.parent_id);
  const dragHandle=(kind,id,label)=>`<button type="button" class="inv-icon-button inv-drag-handle" draggable="true" data-inv-drag-kind="${kind}" data-id="${id}" data-inv-action="move-${kind}" aria-label="${esc(t(kind==='item'?'moveItem':'moveCategory')+': '+label)}" title="${esc(t(kind==='item'?'moveItem':'moveCategory'))}">${icon('grip-vertical')}</button>`;
  function categoryFilters(){
    const path=model.categoryPath(categories().find(c=>c.id===state.category),categories()),main=path[0]?.id||state.category;
    const children=orderedCategories().filter(c=>c.parent_id&&model.categoryPath(c,categories())[0]?.id===main);
    return field(t('mainCategory'),`<select class="inv-control" id="inv-mobile-category"><option value="all">${t('all')}</option>${orderedCategories().filter(c=>!c.parent_id).map(c=>`<option value="${c.id}" ${main===c.id?'selected':''}>${esc(categoryName(c))}</option>`).join('')}<option value="uncategorized" ${main==='uncategorized'?'selected':''}>${t('uncategorized')}</option></select>`)+field(t('subcategory'),`<select class="inv-control" id="inv-subcategory" ${!children.length?'disabled':''}><option value="">${t('allSubcategories')}</option>${children.map(c=>`<option value="${c.id}" ${state.category===c.id?'selected':''}>${esc(model.categoryPath(c,categories()).slice(1).map(categoryName).join(' / '))}</option>`).join('')}</select>`)+field(t('viewOptions'),`<select id="inv-picture-size" class="inv-control">${pictureSizes.map(size=>`<option value="${size}" ${state.pictureSize===size?'selected':''}>${t(size+'Pictures')}</option>`).join('')}</select>`)+(capable('manage')?button('categories',t('manage'),'folder-pen'):'');
  }
  function syncFilterControls(){
    const root=document.querySelector('.inv-category-filters'),signature=JSON.stringify([state.category,state.sort,state.status,isArabic(),categories().map(c=>[c.id,c.name,c.name_ar,c.parent_id,c.active])]);
    if(root?.dataset.controls===signature)return;if(root)root.dataset.controls=signature;
    const template=document.createElement('template');template.innerHTML=categoryFilters();
    for(const id of ['inv-mobile-category','inv-subcategory']){
      const node=el(id),next=template.content.querySelector('#'+id);if(!node||!next)continue;const value=next.value;
      const options=select=>JSON.stringify([...select.options].map(option=>[option.value,option.textContent]));
      if(options(node)!==options(next))node.replaceChildren(...next.childNodes);
      node.disabled=next.disabled;if(node.value!==value)node.value=value;
    }
    document.querySelectorAll('.inv-category-nav [data-inv-category]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.invCategory===state.category)));
    document.querySelectorAll('[data-inv-status]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.invStatus===state.status)));
    if(el('inv-sort')&&el('inv-sort').value!==state.sort)el('inv-sort').value=state.sort;
  }
  const visible=()=>!!el('view-inventory')&&!el('view-inventory').classList.contains('hidden')&&!el('view-clinic-management')?.classList.contains('hidden');
  const today=()=>typeof hrClinicDateValue==='function'?hrClinicDateValue():new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const button=(action,label,name='plus',extra='',attrs='')=>action==='import'&&!capable('adjust')?'':`<button type="button" class="inv-button ${extra}" data-inv-action="${action}" ${attrs}>${icon(name)}<span>${esc(label)}</span></button>`;
  const field=(label,control,span=false)=>`<label class="inv-field ${span?'inv-span':''}"><span>${esc(label)}</span>${control}</label>`;
  const input=(name,value='',attrs='')=>`<input class="inv-control" name="${name}" value="${esc(value)}" ${attrs}>`;
  const categoryOptions=(selected='',optional=false,includeParents=true)=>`${optional?`<option value="">${t('uncategorized')}</option>`:''}${orderedCategories().filter(c=>includeParents||!categories().some(child=>child.parent_id===c.id&&child.active)).map(c=>`<option value="${c.id}" ${selected===c.id?'selected':''}>${esc(categoryLabel(c))}</option>`).join('')}`;
  function unitSelect(item,mode){
    const current=String(item.unit||''),normalized=current.trim().toLowerCase();
    const match=model.units.find(unit=>[unit.value,...unit.aliases].some(value=>value.toLowerCase()===normalized||value.toLowerCase()+'s'===normalized));
    const locked=mode==='edit'&&item.quantity!=null&&Boolean(current);
    const options='<option value="">'+t('chooseUnit')+'</option>'+(current&&!match?'<option value="'+esc(current)+'" selected>'+esc(current)+'</option>':'')+model.units.map(unit=>{
      const value=unit===match?current:unit.value;
      return '<option value="'+esc(value)+'" '+(value===current?'selected':'')+'>'+esc(isArabic()?unit.ar:unit.value)+'</option>';
    }).join('');
    return '<select name="unit" class="inv-control" '+(mode==='add'?'required ':'')+(locked?'disabled':'')+'>'+options+'</select>'+(locked?'<span class="inv-caption">'+t('unitlocked')+'</span>':'');
  }
  function errorText(error){
    const message=String(error?.message||error||'');
    const pairs={INVENTORY_ITEM:words.itemMissing,INVENTORY_CATEGORY_MOVE:words.moveInvalid,INVENTORY_CATEGORY_DEPTH:[words.categoryDepth[0],words.categoryDepth[1]],INVENTORY_NAME:[words.nameHelp[0],words.nameHelp[1]],INVENTORY_ACCESS:['Your inventory access changed. Refresh the page or contact an administrator.','تغيرت صلاحيات المخزون. حدّث الصفحة أو تواصل مع المسؤول.'],INVENTORY_STALE:['This record changed. Close it, refresh, and review the current balance before saving again.','تم تعديل هذا السجل. أغلقه وحدّث البيانات وراجع الرصيد قبل الحفظ مجدداً.'],INVENTORY_UNIT_LOCKED:[words.unitlocked[0],words.unitlocked[1]],INVENTORY_CATEGORY_IN_USE:['Move the category’s active items and subcategories before archiving it.','انقل الأصناف والتصنيفات الفرعية النشطة قبل الأرشفة.'],INVENTORY_ALREADY_IMPORTED:['This file includes items already imported. Review existing stock instead of importing it twice.','يتضمن الملف أصنافاً مستوردة بالفعل. راجع المخزون الموجود بدلاً من تكرار الاستيراد.'],INVENTORY_BALANCE:['There is not enough stock for this movement. Refresh and check the current balance.','المخزون غير كافٍ لهذه الحركة. حدّث البيانات وراجع الرصيد الحالي.'],INVENTORY_COUNT_REQUIRED:['Record an opening count first.','سجل جرداً افتتاحياً أولاً.'],INVENTORY_UNIT_REQUIRED:['Set the item’s stock unit first.','حدد وحدة مخزون الصنف أولاً.'],INVENTORY_REASON:['Enter a reason for this correction.','أدخل سبباً لهذا التصحيح.'],INVENTORY_DATE:['Choose a valid movement date that is not in the future.','اختر تاريخ حركة صحيحاً لا يتجاوز اليوم.'],INVENTORY_REVERSAL:['This movement cannot be reversed. Review the item history and use a reasoned stock count if necessary.','لا يمكن عكس هذه الحركة. راجع سجل الصنف واستخدم جرداً مسبباً عند الحاجة.'],INVENTORY_NUMBER:['Enter a non-negative quantity with up to three decimal places.','أدخل كمية غير سالبة بحد أقصى ثلاثة أرقام عشرية.'],INVENTORY_CSV_HEADERS:['The file needs Item, Current quantity, Minimum and Unit columns (Arabic labels are supported).','يحتاج الملف أعمدة الصنف والكمية الحالية والحد الأدنى والوحدة. العناوين العربية مدعومة.'],INVENTORY_CSV_SIZE:['Choose a CSV with up to 500 items and a size below 1 MB.','اختر ملف CSV لا يزيد على ٥٠٠ صنف وحجمه أقل من ١ ميجابايت.'],INVENTORY_CSV_EMPTY:['The CSV has no item rows.','لا يحتوي ملف CSV على أصناف.'],INVENTORY_CSV_FORMAT:['The CSV contains invalid quoting or columns. Check the file and try again.','تنسيق علامات الاقتباس أو الأعمدة غير صحيح. راجع الملف ثم حاول مجدداً.']};
    for(const[key,pair]of Object.entries(pairs))if(message.includes(key))return pair[isArabic()?1:0];
    if(/INVENTORY_CSV_(ROW|DUPLICATE|NUMBER):/.test(message)){const line=message.split(':').pop();return isArabic()?`راجع صف الملف رقم ${line}: اسم مكرر أو بيانات غير صحيحة.`:`Check CSV row ${line}: duplicate name or invalid data.`;}
    if(error?.code==='23505')return isArabic()?'يوجد صنف أو تصنيف بهذا الاسم بالفعل.':'This item or category already exists.';
    if(error?.code==='PGRST202'||error?.code==='42P01')return t('notavailable');
    return isArabic()?'تعذر إتمام العملية. راجع البيانات وحاول مجدداً.':'Could not complete the operation. Check the values and try again.';
  }
  function reset(){
    pictureObserver?.disconnect();pictureObserver=null;picturePanel=null;host.LuminInventoryImages?.clear();state.quickEpoch++;state.quickQueue=[];state.quickBases.clear();state.refreshRead=null;clearTimeout(state.realtimeTimer);
    state.token++;clearTimeout(state.timer);closeDialog(false,true);host.LuminInventorySupplier?.close(true);
    state.management=null;
    Object.assign(state,{actor:'',report:null,loading:false,saving:false,error:'',message:'',loadedAt:0,query:'',category:'all',status:'all',sort:'name',page:1,pending:null,quickPending:null,quickSaving:false,quickRefreshQueued:false});
    state.selected.clear();el('view-inventory')?.replaceChildren();
    state.organizePending=null;endDrag();
  }
  function focusSnapshot(){const node=document.activeElement;return node&&el('view-inventory')?.contains(node)?{id:node.id,start:node.selectionStart,end:node.selectionEnd}:null;}
  function restoreFocus(saved){if(!saved?.id)return;const node=el(saved.id);node?.focus({preventScroll:true});if(node?.setSelectionRange&&saved.start!=null)try{node.setSelectionRange(saved.start,saved.end);}catch(_){}}
  function empty(title,body,action=''){return `<div class="inv-empty"><span class="inv-empty-icon">${icon('package-open')}</span><h3>${esc(title)}</h3><p>${esc(body)}</p>${action}</div>`;}
  function pill(item){const status=model.status(item);return `<span class="inv-pill ${status==='low'?'inv-amber':status==='out'?'inv-rose':status==='healthy'?'inv-green':''}">${t(status)}</span>`;}
  function displayedItem(item){
    const base=state.quickBases.get(item.id);if(!base)return item;let quantity=Number(base.quantity);
    if(state.quickPending?.payload.id===item.id)quantity+=state.quickPending.operation==='receive'?1:-1;
    for(const intent of state.quickQueue)if(intent.id===item.id)quantity+=intent.operation==='receive'?1:-1;
    return {...item,quantity:Math.round(quantity*1000)/1000};
  }
  const quickItemBusy=id=>state.quickSaving&&(state.quickPending?.payload.id===id||state.quickQueue.some(intent=>intent.id===id));
  function stockStepState(item,operation,label){
      item=displayedItem(item);const paused=Boolean(state.quickPending&&!state.quickSaving);
      const retry=paused&&state.quickPending.payload.id===item.id&&state.quickPending.operation===operation;
      const unavailable=item.quantity==null||!item.unit;
      const boundary=operation==='use'?Number(item.quantity)<1:Number(item.quantity)>999999999;
      const disabled=state.saving||Boolean(state.organizePending)||!capable(operation)||(!retry&&(unavailable||boundary||paused));
      const hint=retry?t('retryStock'):!capable(operation)?t('readOnly'):unavailable?t('needsetup'):boundary?t(operation==='use'?'oneRequired':'stockLimit'):t(label);
      return {disabled,hint};
  }
  function stockControl(item){
    const step=(operation,label,ico)=>{
      const {disabled,hint}=stockStepState(item,operation,label);
      return `<button type="button" id="inv-stock-${operation}-${item.id}" class="inv-icon-button inv-stock-step inv-stock-${operation}" data-inv-action="quick-${operation}" data-id="${item.id}" aria-label="${esc(t(label)+': '+itemName(item))}" title="${esc(hint)}" ${disabled?'disabled':''}>${icon(ico)}</button>`;
    };
    return `<div class="inv-stock-stepper" dir="ltr" role="group" aria-label="${esc(t('current')+': '+itemName(item))}" aria-busy="${quickItemBusy(item.id)}">${step('use','decrease','minus')}<span class="inv-number" aria-live="polite" aria-atomic="true">${number(item.quantity)}</span>${step('receive','increase','plus')}</div>`;
  }
  function pagination(total,page,size,scope='stock'){
    const pages=Math.max(1,Math.ceil(Number(total||0)/size));
    return `<div class="inv-pagination" data-total="${total}" data-page="${page}" data-size="${size}"><span class="inv-caption">${total?`${number((page-1)*size+1)}–${number(Math.min(page*size,total))} ${t('of')} ${number(total)}`:`${number(0)} ${t('items')}`}</span><div class="inv-actions">${button(scope+'-previous',t('previous'),'chevron-left','',page<=1?'disabled':'')}<span class="inv-caption">${number(page)} / ${number(pages)}</span>${button(scope+'-next',t('next'),'chevron-right','',page>=pages?'disabled':'')}</div></div>`;
  }
  const feedbackMarkup=new WeakMap();
  function feedbackSignature(){return JSON.stringify([state.error,state.quickPending?[state.quickPending.id,state.quickSaving,state.loading]:null,state.organizePending?[state.organizePending.id,state.saving,state.loading]:null,state.message,isArabic()]);}
  function feedbackHTML(){return `${state.error||state.quickPending&&!state.quickSaving||state.organizePending&&!state.saving?`<div class="inv-error" role="alert"><span>${esc(state.error||t('unconfirmed'))}</span>${state.organizePending?button('retry-move',t('retryMove'),'refresh-cw','',state.saving||state.loading?'disabled':''):state.quickPending?button('retry-stock',t('retryStock'),'refresh-cw','',state.saving||state.loading||state.quickSaving?'disabled':''):button('refresh',t('retry'),'refresh-cw')}</div>`:''}
      ${state.message?`<div class="inv-status" role="status">${icon('circle-check')}<span>${esc(state.message)}</span></div>`:''}`;}
  function render(){
    const root=el('view-inventory');if(!root)return;const focused=focusSnapshot();
    if(!allowed()){root.replaceChildren();return;}
    const data=state.report,summary=data?.summary||{},canManage=capable('manage');
    const navButton=(id,name,count,ico='folder')=>{const category=categories().find(c=>c.id===id),movable=category?.parent_id&&canManage;return `<div class="inv-category-node ${movable?'inv-category-movable':''}" style="--inv-category-depth:${category?model.categoryPath(category,categories()).length-1:0}" ${category?`data-inv-drop-category="${id}" data-inv-parent="${category.parent_id||''}"`:''}>${movable?dragHandle('category',id,name):''}<button type="button" class="inv-category ${category?.parent_id?'inv-category-child':''}" data-inv-category="${esc(id)}" aria-pressed="${state.category===id}">${movable?'':icon(ico)}<span>${esc(name)}</span><small>${number(count)}</small></button></div>`;};
    const categoryRows=orderedCategories();
    const catNav=navButton('all',t('all'),summary.total,'layers')+categoryRows.map(c=>navButton(c.id,categoryName(c),c.item_count,c.parent_id?'package':'folder-open')).join('')+navButton('uncategorized',t('uncategorized'),summary.uncategorized||0);
    root.innerHTML=`<div class="inv-heading"><div><h2>${t('inventory')}</h2><p class="inv-muted">${t('subtitle')}</p></div><div class="inv-actions">${button('refresh',t('refresh'),'refresh-cw','',state.loading?'disabled':'')}${canManage?button('add',t('add'),'plus','inv-heading-add'):''}${canManage||capable('receive')?button('supplier-list',t('supplierList'),'list-plus','inv-heading-supplier'):''}${capable('receive')?button('choose-receive',t('receive'),'package-plus','inv-heading-receive inv-primary') :''}</div></div>
      <span id="inv-move-live" class="inv-visually-hidden" role="status" aria-live="polite"></span><div id="inv-feedback" data-signature="${esc(feedbackSignature())}">${feedbackHTML()}</div>
      <div class="inv-stats">${[['total','package',t('items')],['categories','folders',t('categories')],['low','triangle-alert',t('threshold')],['out','package-x',t('zero')]].map(([key,name,note])=>`<button type="button" class="inv-panel inv-stat" data-inv-stat="${key}"><span class="inv-stat-label">${icon(name)}${t(key)}</span><strong>${data?number(summary[key]):'—'}</strong><span class="inv-caption">${note}</span></button>`).join('')}</div>
      <div class="inv-mobile-category inv-category-filters">${categoryFilters()}</div>
      <div class="inv-workspace"><aside class="inv-panel inv-category-nav"><h3 class="inv-category-heading">${t('categories')}</h3>${catNav}${canManage?button('categories',t('manage'),'folder-pen','inv-category-manage'):''}</aside><div class="inv-content">
        ${renderStock()}
        ${state.loadedAt?`<p id="inv-last-loaded" class="inv-muted">${t('lastloaded')}: ${esc(new Intl.DateTimeFormat(isArabic()?'ar-EG':'en-GB',{hour:'2-digit',minute:'2-digit'}).format(state.loadedAt))}</p>`:''}
      </div></div>`;
    feedbackMarkup.set(el('inv-feedback'),feedbackHTML());
    if(canManage){const note=document.createElement('p');note.className='inv-caption inv-drag-help';note.textContent=t('dragHelp');root.querySelector('.inv-category-nav')?.appendChild(note);}
    icons();syncPhotos(root,data?.items);syncPictureView();restoreFocus(focused);
  }
  function pictureMetrics(){
    const table=picturePanel?.querySelector('tbody');if(!table)return;
    const style=getComputedStyle(table),gap=parseFloat(style.columnGap)||0,available=table.clientWidth-(parseFloat(style.paddingInlineStart)||0)-(parseFloat(style.paddingInlineEnd)||0);
    const columns=host.innerWidth<768?1:Math.max(1,Math.min(table.rows.length||1,Math.floor((available+gap)/(340+gap))));
    const largeWidth=Math.max(0,(available-gap*(columns-1))/columns-2),mediumWidth=host.innerWidth>=768?Math.min(largeWidth/2,Math.max(0,(available-gap*3)/4-2)):largeWidth/2;
    for(const [name,width]of [['--inv-large-photo-width',largeWidth],['--inv-medium-photo-width',mediumWidth]]){const value=width+'px';if(table.style.getPropertyValue(name)!==value)table.style.setProperty(name,value);}
  }
  function syncPictureView(){
    const panel=el('inv-stock-panel'),select=el('inv-picture-size');if(select&&select.value!==state.pictureSize)select.value=state.pictureSize;
    if(!panel)return;panel.dataset.pictureSize=state.pictureSize;
    if(panel!==picturePanel){pictureObserver?.disconnect();picturePanel=panel;if(typeof ResizeObserver!=='undefined'){pictureObserver=new ResizeObserver(pictureMetrics);pictureObserver.observe(panel);}}
    pictureMetrics();
  }
  const photoFrame=(item,detail=false)=>`<div class="inv-photo ${detail?'inv-photo-detail':''}" data-inv-photo="${item.id}"></div>`;
  function syncPhotos(root,items){host.LuminInventoryImages?.sync(root,items,capable('manage'));}
  function photoChanged(id,data){
    state.dataSequence++;
    for(const report of [state.report,state.management?.report]){const item=report?.items.find(item=>item.id===id);if(item)Object.assign(item,data);}
    if(state.dialog?.item?.id===id)Object.assign(state.dialog.item,data);
    state.loadedAt=0;
    syncPhotos(el('view-inventory'),state.report?.items);if(state.dialog?.item)syncPhotos(el('inventory-overlay'),[state.dialog.item]);
  }
  function stockRow(item){item=displayedItem(item);const manage=capable('manage');return `<tr data-inv-row="${item.id}"><td>${manage?`<label class="inv-check"><input type="checkbox" data-inv-select="${item.id}" aria-label="${t('select')}: ${esc(itemName(item))}" ${state.selected.has(item.id)?'checked':''}></label>`:''}</td><td><button type="button" class="inv-item" data-inv-item="${item.id}"><bdi>${esc(itemName(item))}</bdi></button></td><td><span class="inv-pill">${esc(categoryName(categories().find(c=>c.id===item.category_id)))}</span></td><td data-label="${t('current')}"><div class="inv-stock-line">${stockControl(item)}<div class="inv-stock-meta"><span class="inv-caption ${!item.unit?'inv-review':''}">${esc(item.unit||t('unitmissing'))}</span><div class="inv-stock-status">${pill(item)}</div></div></div></td><td data-label="${t('minimum')}"><span class="inv-number">${number(item.minimum)}</span></td><td><button type="button" class="inv-icon-button" data-inv-item="${item.id}" aria-label="${t('details')}: ${esc(itemName(item))}">${icon('sliders-horizontal')}</button></td><td class="inv-photo-cell">${photoFrame(item)}${manage?dragHandle('item',item.id,itemName(item)):''}</td></tr>`;}
  function renderStock(){
    const data=state.report,rows=data?.items||[],manage=capable('manage');
    const title=state.category==='all'?t('all'):categoryLabel(categories().find(c=>c.id===state.category));
    return `<section id="inv-stock-panel" class="inv-panel" data-picture-size="${state.pictureSize}" aria-busy="${state.loading}"><div class="inv-list-heading"><h3>${esc(title)}</h3><span class="inv-caption" aria-live="polite">${data?`${number(data.total)} ${t('items')}`:t('loading')}</span></div>
      <div class="inv-tools"><label class="inv-search">${icon('search')}<input id="inv-search" type="search" maxlength="120" value="${esc(state.query)}" placeholder="${t('search')}" aria-label="${t('search')}"></label><div class="inv-filterbar">${['all','low','out','unknown','review'].map(key=>`<button class="inv-tab" type="button" data-inv-status="${key}" aria-pressed="${state.status===key}">${t(key==='all'?'allstatus':key)}</button>`).join('')}<select id="inv-sort" class="inv-control" aria-label="${t('sort')}">${[['name','namesort'],['status','statussort'],['quantity','quantitysort']].map(([key,label])=>`<option value="${key}" ${state.sort===key?'selected':''}>${t(label)}</option>`).join('')}</select></div></div>
      <div id="inv-stock-bulk" data-selection="${[...state.selected.keys()].join(',')}">${stockBulkHTML()}</div>
      <table class="inv-table" ${!rows.length?'hidden':''}><thead><tr><th>${manage?`<label class="inv-check"><input type="checkbox" id="inv-select-page" aria-label="${t('selectpage')}" ${rows.length&&rows.every(i=>state.selected.has(i.id))?'checked':''}></label>`:''}</th><th>${t('name')}</th><th>${t('category')}</th><th>${t('current')}</th><th>${t('minimum')}</th><th>${t('details')}</th></tr></thead><tbody>${rows.map(stockRow).join('')}</tbody></table>
      <div id="inv-stock-empty" data-kind="${rows.length?'':stockEmptyKind()}" ${rows.length?'hidden':''}>${rows.length?'':stockEmptyHTML()}</div>
      ${data?pagination(data.total,state.page,data.size||20):''}</section>`;
  }
  function stockBulkHTML(){return state.selected.size?`<div class="inv-bulk"><span>${number(state.selected.size)} ${t('selected')}</span><select id="inv-bulk-category" class="inv-control" aria-label="${t('category')}">${categoryOptions('',false,false)}</select>${button('assign',t('assign'),'folder-input','',state.saving?'disabled':'')}${button('unselect',t('clear'),'x')}</div>`:'';}
  function stockEmptyKind(){return !state.report&&state.loading?'loading':state.report?.summary.total===0?'empty':'nomatches';}
  function stockEmptyHTML(){return stockEmptyKind()==='loading'?Array.from({length:4},()=>'<div class="inv-skeleton"></div>').join(''):stockEmptyKind()==='empty'?empty(t('empty'),t('emptybody'),capable('manage')?button('add',t('add'),'plus','inv-primary'):''):empty(t('nomatches'),t('nomatchesbody'),button('clear',t('clear'),'filter-x'));}
  const layoutSignature=report=>JSON.stringify([report?.permissions,report?.categories?.map(c=>[c.id,c.name,c.name_ar,c.parent_id,c.active])]);
  // Retain rows and controls so stock edits preserve focus, selection, and scroll.
  function syncStockView(){
    const data=state.report,panel=el('inv-stock-panel');if(!data||!panel)return;
    const setText=(node,value)=>{if(node&&node.textContent!==String(value))node.textContent=value;};
    const setAttr=(node,name,value)=>{if(node&&node.getAttribute(name)!==String(value))node.setAttribute(name,String(value));};
    syncFilterControls();const tbody=panel.querySelector('tbody');let addedIcons=false;
    if(!tbody){
      const template=document.createElement('template');template.innerHTML=renderStock();panel.replaceWith(template.content);addedIcons=true;
    }else{
      const existing=new Map([...tbody.rows].map(row=>[row.dataset.invRow,row]));
      data.items.forEach((item,index)=>{
        item=displayedItem(item);
        let row=existing.get(item.id);
        if(!row){const template=document.createElement('template');template.innerHTML=stockRow(item);row=template.content.firstElementChild;addedIcons=true;}
        existing.delete(item.id);
        if(tbody.rows[index]!==row)tbody.insertBefore(row,tbody.rows[index]||null);
        setText(row.querySelector('.inv-item bdi'),itemName(item));
        setText(row.cells[2].querySelector('.inv-pill'),categoryName(categories().find(c=>c.id===item.category_id)));
        setText(row.cells[4].querySelector('.inv-number'),number(item.minimum));
        const checkbox=row.querySelector('[data-inv-select]');
        if(checkbox){checkbox.checked=state.selected.has(item.id);setAttr(checkbox,'aria-label',t('select')+': '+itemName(item));}
        setAttr(row.cells[5].querySelector('button'),'aria-label',t('details')+': '+itemName(item));
        const group=row.querySelector('.inv-stock-stepper');
        setAttr(group,'aria-label',t('current')+': '+itemName(item));
        setAttr(group,'aria-busy',Boolean(quickItemBusy(item.id)));
        setText(group.querySelector('.inv-number'),number(item.quantity));
        for(const [operation,label]of [['use','decrease'],['receive','increase']]){
          const node=el('inv-stock-'+operation+'-'+item.id),step=stockStepState(item,operation,label);
          if(node.disabled!==step.disabled)node.disabled=step.disabled;if(node.title!==step.hint)node.title=step.hint;setAttr(node,'aria-label',t(label)+': '+itemName(item));
        }
        const caption=row.querySelector('.inv-stock-meta>.inv-caption');
        setText(caption,item.unit||t('unitmissing'));caption.classList.toggle('inv-review',!item.unit);
        const status=model.status(item),badge=row.querySelector('.inv-stock-status .inv-pill');
        setText(badge,t(status));const badgeClass='inv-pill'+(status==='low'?' inv-amber':status==='out'?' inv-rose':status==='healthy'?' inv-green':'');if(badge.className!==badgeClass)badge.className=badgeClass;
      });
      existing.forEach(row=>row.remove());
      tbody.closest('table').hidden=!data.items.length;
      const emptyState=el('inv-stock-empty'),emptyKind=stockEmptyKind();if(emptyState){emptyState.hidden=Boolean(data.items.length);if(data.items.length){emptyState.replaceChildren();emptyState.dataset.kind='';}else if(emptyState.dataset.kind!==emptyKind){emptyState.innerHTML=stockEmptyHTML();emptyState.dataset.kind=emptyKind;addedIcons=true;}}
      const bulk=el('inv-stock-bulk'),selection=[...state.selected.keys()].join(',');if(bulk&&bulk.dataset.selection!==selection){bulk.innerHTML=stockBulkHTML();bulk.dataset.selection=selection;addedIcons=true;}
      panel.setAttribute('aria-busy',String(state.loading));
      setText(panel.querySelector('.inv-list-heading h3'),state.category==='all'?t('all'):categoryLabel(categories().find(c=>c.id===state.category)));
      setText(panel.querySelector('.inv-list-heading>.inv-caption'),number(data.total)+' '+t('items'));
      const footer=panel.querySelector(':scope>.inv-pagination'),template=document.createElement('template');
      template.innerHTML=pagination(data.total,state.page,data.size||20);
      if(footer&&(footer.dataset.total!==String(data.total)||footer.dataset.page!==String(state.page)||footer.dataset.size!==String(data.size||20))){
        const next=template.content.firstElementChild;setText(footer.querySelector(':scope>.inv-caption'),next.querySelector(':scope>.inv-caption').textContent);setText(footer.querySelector('.inv-actions .inv-caption'),next.querySelector('.inv-actions .inv-caption').textContent);
        footer.querySelectorAll('button').forEach((node,index)=>node.disabled=next.querySelectorAll('button')[index].disabled);Object.assign(footer.dataset,next.dataset);
      }
      const selectPage=el('inv-select-page');if(selectPage)selectPage.checked=data.items.every(item=>state.selected.has(item.id));
    }
    for(const key of ['total','categories','low','out'])setText(document.querySelector('[data-inv-stat="'+key+'"] strong'),number(data.summary[key]));
    document.querySelectorAll('.inv-category-nav [data-inv-category]').forEach(node=>{
      const id=node.dataset.invCategory,count=id==='all'?data.summary.total:id==='uncategorized'?data.summary.uncategorized:categories().find(c=>c.id===id)?.item_count;
      if(count!=null)setText(node.querySelector('small'),number(count));
    });
    const feedback=el('inv-feedback'),key=feedbackSignature();if(feedback&&feedback.dataset.signature!==key){const html=feedbackHTML();if(feedbackMarkup.get(feedback)!==html){feedback.innerHTML=html;feedbackMarkup.set(feedback,html);addedIcons=true;}feedback.dataset.signature=key;}
    setText(el('inv-last-loaded'),t('lastloaded')+': '+new Intl.DateTimeFormat(isArabic()?'ar-EG':'en-GB',{hour:'2-digit',minute:'2-digit'}).format(state.loadedAt));
    if(addedIcons)icons();syncPhotos(el('view-inventory'),data.items);syncPictureView();
  }
  function refresh(options={}){
    const key=JSON.stringify([signature(),isArabic(),state.query,state.category,state.status,state.sort,state.page]);
    if(state.refreshRead?.key===key&&state.refreshRead.sequence>=state.dataSequence)return state.refreshRead.promise;
    const read={key,sequence:state.dataSequence,promise:null};read.promise=loadReport(options);state.refreshRead=read;
    const done=()=>{if(state.refreshRead===read)state.refreshRead=null;};read.promise.then(done,done);return read.promise;
  }
  function scheduleRefresh(){
    clearTimeout(state.realtimeTimer);
    state.realtimeTimer=setTimeout(()=>{state.realtimeTimer=null;if(!visible()||!allowed())return;if(state.quickSaving){state.quickRefreshQueued=true;return;}void refresh({force:true,background:true,preserveError:true});},150);
  }
  async function loadReport(options={}){
    if(!allowed()||!actor()){if(state.report)reset();return;}
    const context=signature();if(state.actor&&state.actor!==context)reset();state.actor=context;
    if(!options.force&&state.report&&Date.now()-state.loadedAt<30000){if(el('inv-stock-panel'))syncStockView();else render();return;}
    const token=++state.token,sequence=state.dataSequence;let stable=Boolean(state.report&&el('inv-stock-panel'));const layout=layoutSignature(state.report);state.loading=true;if(!options.preserveError)state.error='';if(stable)syncStockView();else render();
    try{
      const {data,error}=await db.rpc('get_inventory',{p_filters:{language:isArabic()?'ar':'en',query:state.query,category:state.category,status:state.status,sort:state.sort,page:state.page,size:20}});
      if(token!==state.token||context!==signature())return;
      if(sequence!==state.dataSequence){if(state.quickSaving){state.quickRefreshQueued=true;return;}return refresh({...options,force:true});}
      if(error)throw error;
      stable=stable&&layout===layoutSignature(data);state.report=data;state.loadedAt=Date.now();if(!options.preserveError)state.error='';
      for(const item of data.items)if(state.selected.has(item.id))state.selected.set(item.id,item);
      if(!data.permissions?.manage&&(state.dialog?.mode==='categories'||state.dialog?.returnManagement))closeDialog(true,true);
      if(state.quickPending&&!state.quickSaving&&!data.permissions?.[state.quickPending.operation]){state.quickPending=null;state.quickQueue=[];state.quickBases.clear();state.error=errorText({message:'INVENTORY_ACCESS'});}
      if(data.total>0&&state.page>Math.ceil(data.total/20)){state.page=Math.ceil(data.total/20);state.loading=false;return refresh({force:true,background:stable});}
      if(!data.permissions?.manage)state.selected.clear();
      if(!data.permissions?.manage)state.organizePending=null;
    }catch(error){if(token===state.token&&context===signature())state.error=error?.code==='PGRST202'||error?.code==='42P01'?t('notavailable'):t('failed');}
    finally{if(token===state.token&&context===signature()){state.loading=false;if(stable)syncStockView();else render();}}
  }
  function quickStock(operation,id){
    if(state.saving||state.dialog||state.organizePending||!allowed()||!actor()||!capable(operation))return;
    if(typeof navigator!=='undefined'&&navigator.onLine===false){state.error=t('offline');syncStockView();return;}
    if(state.quickPending&&!state.quickSaving){if(state.quickPending.context===signature()&&state.quickPending.operation===operation&&state.quickPending.payload.id===id)void drainStock();return;}
    const item=state.report?.items.find(row=>row.id===id);if(!item)return;const visibleItem=displayedItem(item);
    if(visibleItem.quantity==null||!visibleItem.unit||(operation==='use'?Number(visibleItem.quantity)<1:Number(visibleItem.quantity)>999999999))return;
    if(!state.quickBases.has(id))state.quickBases.set(id,{...item});
    state.quickQueue.push({id,operation});state.error='';syncStockView();void drainStock();
  }
  async function drainStock(){
    if(state.quickSaving)return;const context=signature(),epoch=state.quickEpoch,current=()=>context===signature()&&epoch===state.quickEpoch;
    state.quickSaving=true;state.error='';let changed=false,terminalError='';syncStockView();
    try{
      while(current()&&(state.quickPending||state.quickQueue.length)){
        if(!state.quickPending){
          const intent=state.quickQueue.shift(),base=state.quickBases.get(intent.id);
          if(!base||!capable(intent.operation))throw Object.assign(Error('INVENTORY_ACCESS'),{code:'42501'});
          state.quickPending={context,operation:intent.operation,id:newRequestId(),payload:{id:intent.id,revision:base.revision,quantity:1,date:today()}};
        }
        const pending=state.quickPending;syncStockView();
        const {data,error}=await db.rpc('inventory_write',{p_operation:pending.operation,p_payload:pending.payload,p_request_id:pending.id});
        if(!current())return;if(error)throw error;
        if(!data||data.quantity==null||!Number.isFinite(Number(data.quantity)))throw Error('Unconfirmed stock response');
        const base=state.quickBases.get(pending.payload.id);base.quantity=Number(data.quantity);base.revision=Number(pending.payload.revision)+1;
        for(const item of state.report?.items||[])if(item.id===base.id&&Number(item.revision)<=base.revision)Object.assign(item,{quantity:base.quantity,revision:base.revision});
        if(state.selected.has(base.id)&&Number(state.selected.get(base.id).revision)<=base.revision)Object.assign(state.selected.get(base.id),{quantity:base.quantity,revision:base.revision});
        state.quickPending=null;state.dataSequence++;changed=true;syncStockView();
      }
    }catch(error){
      if(current()){
        if(/INVENTORY_/.test(String(error?.message||''))||['22023','23505','40001','42501','23514'].includes(error?.code)){
          state.quickPending=null;state.quickQueue=[];state.quickBases.clear();terminalError=errorText(error);changed=true;
        }else state.error=t('unconfirmed');
      }
    }finally{
      if(current()){
        state.quickSaving=false;if(!state.quickPending)state.quickBases.clear();
        if(terminalError)state.error=terminalError;
        if(changed){state.token++;state.refreshRead=null;state.loading=false;state.loadedAt=0;}
        syncStockView();
        if(changed||state.quickRefreshQueued){state.quickRefreshQueued=false;scheduleRefresh();}
      }
    }
  }
  async function write(operation,payload){
    if(state.saving)return false;
    if(typeof navigator!=='undefined'&&navigator.onLine===false){showDialogError(t('offline'));return false;}
    const context=signature(),fingerprint=JSON.stringify([context,operation,payload]);
    if(state.pending?.fingerprint!==fingerprint)state.pending={fingerprint,id:newRequestId()};
    const requestId=state.pending.id,returnToManagement=Boolean(state.dialog?.returnManagement);let completed=false;state.saving=true;state.error='';setDialogBusy(true);
    try{const {error}=await db.rpc('inventory_write',{p_operation:operation,p_payload:payload,p_request_id:requestId});if(context!==signature())return false;if(error)throw error;
      state.dataSequence++;state.pending=null;state.selected.clear();state.message=t('saved');closeDialog(true,true);await refresh({force:true});completed=true;return true;
    }catch(error){if(context===signature()){if(state.dialog)showDialogError(errorText(error));else{state.error=errorText(error);render();}}return false;}
    finally{if(context===signature()){state.saving=false;setDialogBusy(false);render();if(completed&&returnToManagement)openManagement();}}
  }
  let dragging=null,suppressMoveClickUntil=0;
  function endDrag(){dragging=null;document.body.classList.remove('inventory-dragging');document.querySelectorAll('.inv-drop-target,.inv-is-dragging').forEach(node=>node.classList.remove('inv-drop-target','inv-is-dragging'));}
  function dropPayload(targetId){
    if(!dragging||dragging.context!==signature()||!capable('manage'))return null;
    const target=categories().find(c=>c.id===targetId&&c.active);if(!target)return null;
    if(dragging.kind==='category'){
      const category=categories().find(c=>c.id===dragging.id);if(!category||!moveTargets(category).some(c=>c.id===target.id))return null;
      return {operation:'category_move',payload:{id:category.id,revision:dragging.revision,parent_id:target.id,parent_revision:target.revision}};
    }
    const item=state.report?.items.find(i=>i.id===dragging.id);if(!item||item.category_id===target.id)return null;
    return {operation:'assign',payload:{category_id:target.id,category_revision:target.revision,items:[{id:item.id,revision:dragging.revision}]}};
  }
  function bindDrag(){
    document.addEventListener('dragstart',event=>{
      const handle=event.target.closest('[data-inv-drag-kind]');if(!handle)return;
      if(state.saving||state.loading||state.quickPending||state.organizePending||!capable('manage')){event.preventDefault();return;}
      const kind=handle.dataset.invDragKind,id=handle.dataset.id,record=kind==='category'?categories().find(c=>c.id===id):state.report?.items.find(i=>i.id===id);
      if(!record){event.preventDefault();return;}dragging={kind,id,revision:record.revision,context:signature()};
      event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-lumin-inventory',JSON.stringify({kind,id}));event.dataTransfer.setData('text/plain',kind==='category'?categoryName(record):itemName(record));
      handle.classList.add('inv-is-dragging');document.body.classList.add('inventory-dragging');
    });
    document.addEventListener('dragover',event=>{
      if(!dragging)return;const target=event.target.closest('[data-inv-drop-category]');const valid=target&&dropPayload(target.dataset.invDropCategory);
      document.querySelectorAll('.inv-drop-target').forEach(node=>{if(node!==target||!valid)node.classList.remove('inv-drop-target');});
      if(valid){event.preventDefault();event.dataTransfer.dropEffect='move';target.classList.add('inv-drop-target');}
    });
    document.addEventListener('drop',event=>{
      if(!dragging)return;const target=event.target.closest('[data-inv-drop-category]'),move=target&&dropPayload(target.dataset.invDropCategory);
      if(move){event.preventDefault();event.stopPropagation();}suppressMoveClickUntil=Date.now()+400;endDrag();if(move)void organizeWrite(move.operation,move.payload);
    });
    document.addEventListener('dragend',()=>{if(dragging)suppressMoveClickUntil=Date.now()+400;endDrag();});
  }
  async function organizeWrite(operation,payload){
    if(state.saving||state.loading||state.dialog&&state.dialog.mode!=='categories'||!capable('manage'))return;
    const context=signature();if(state.organizePending&&(state.organizePending.context!==context||JSON.stringify([operation,payload])!==state.organizePending.fingerprint))return;
    if(typeof navigator!=='undefined'&&navigator.onLine===false){state.error=t('offline');syncStockView();return;}
    if(!state.organizePending)state.organizePending={context,operation,payload,id:newRequestId(),fingerprint:JSON.stringify([operation,payload])};
    const pending=state.organizePending;state.saving=true;state.quickSaving=true;state.error='';syncStockView();setDialogBusy(true);
    try{const {error}=await db.rpc('inventory_write',{p_operation:pending.operation,p_payload:pending.payload,p_request_id:pending.id});if(context!==signature())return;if(error)throw error;state.dataSequence++;state.organizePending=null;await refresh({force:true,background:true});if(el('inv-move-live'))el('inv-move-live').textContent=t('moved');}
    catch(error){if(context===signature()){if(/INVENTORY_/.test(String(error?.message||''))||['22023','23505','40001','42501','23514'].includes(error?.code)){state.organizePending=null;await refresh({force:true,background:true});state.error=errorText(error);}else state.error=t('unconfirmed');}}
    finally{if(context===signature()){state.saving=false;state.quickSaving=false;setDialogBusy(false);syncStockView();if(state.dialog?.mode==='categories')renderManagementPanel();if(state.quickRefreshQueued){state.quickRefreshQueued=false;void refresh({force:true,background:true});}}}
  }
  function setDialogBusy(busy){const overlay=el('inventory-overlay');if(!overlay)return;overlay.setAttribute('aria-busy',String(busy));overlay.querySelectorAll('button,input,select,textarea').forEach(node=>{if(busy){node.dataset.wasDisabled=String(node.disabled);node.disabled=true;}else if('wasDisabled'in node.dataset){node.disabled=node.dataset.wasDisabled==='true';delete node.dataset.wasDisabled;}});}
  function showDialogError(message){const node=el('inv-dialog-error');if(node){node.hidden=false;node.textContent=message;node.scrollIntoView({block:'nearest'});}}
  function closeDialog(restore=true,force=false){if(state.saving&&!force)return;state.dialogToken++;clearTimeout(state.management?.timer);el('inventory-overlay')?.remove();state.dialog=null;document.body.classList.remove('inventory-dialog-open');if(restore&&state.returnFocus?.isConnected)state.returnFocus.focus({preventScroll:true});state.returnFocus=null;}
  function openDialog(mode,extra={}){
    if(state.saving)return;const previous=state.returnFocus,focused=el('inventory-overlay')?.contains(document.activeElement)?previous:document.activeElement;closeDialog(false);state.returnFocus=focused?.isConnected?focused:previous;state.dialog={mode,...(mode==='add'?{item:{category_id:categories().find(c=>c.active&&c.id===state.category)?.id||''}}:{}),...extra};renderDialog();
  }
  function renderDialog(){
    const dialog=state.dialog;if(!dialog)return;const mode=dialog.mode,item=dialog.item||{};let title=t(mode),body='',submit=true,wide=false;
    const numeric=(name,value,required=false)=>input(name,value??'',`type="number" min="0" max="1000000000" step="0.001" ${required?'required':''} ${name==='quantity'&&mode==='add'&&!capable('adjust')?'disabled':''}`);
    if(mode==='add'||mode==='edit'){
      title=t(mode==='edit'?'details':'add');
      const opening=mode==='add'||item.quantity==null;
      const quantity=opening?numeric('quantity',null)+`<span class="inv-caption">${t('unknownhelp')}</span>`:`<div class="inv-control inv-number">${number(item.quantity)} <bdi>${esc(item.unit)}</bdi></div>`;
      body=`<div class="inv-form-grid">${field(t('nameEn'),input('name_en',model.names(item).name_en,'maxlength="160" dir="ltr" lang="en" aria-describedby="inv-name-help"'))}${field(t('nameAr'),input('name_ar',model.names(item).name_ar,'maxlength="160" dir="rtl" lang="ar" aria-describedby="inv-name-help"'))}<p id="inv-name-help" class="inv-caption inv-span">${t('nameHelp')}</p>${field(t('category'),`<select name="category_id" class="inv-control" ${mode==='add'?'required':''}>${categoryOptions(item.category_id,mode==='edit')}</select>`)}${field(t('unit'),unitSelect(item,mode))}${field(t('minimum'),numeric('minimum',item.minimum,mode==='add'))}${field(t(mode==='add'?'opening':'current'),quantity)}</div>`;
      if(mode==='edit'){
        body=photoFrame(item,true)+`<div class="inv-detail-stat"><div><span class="inv-caption">${t('current')}</span><strong>${number(item.quantity)}</strong> <bdi>${esc(item.unit||t('unitmissing'))}</bdi></div>${pill(item)}</div>`+body;
        if(item.quantity==null||!item.unit)body+=`<p class="inv-review">${t('needsetup')}</p>`;
        submit=capable('manage');
      }
    }else if(mode==='item_delete'){
      title=t('deleteItem');body=`<div class="inv-detail-stat"><strong><bdi>${esc(itemName(item))}</bdi></strong></div><p class="inv-delete-copy">${t('deleteBody')}</p>`;submit=capable('manage');
    }else if(mode==='move_item'||mode==='move_category'){
      title=t(mode==='move_item'?'moveItem':'moveCategory');const list=mode==='move_category'?moveTargets(dialog.category):orderedCategories().filter(c=>c.id!==item.category_id);
      body=`<p class="inv-muted inv-move-name"><bdi>${esc(mode==='move_item'?itemName(item):categoryLabel(dialog.category))}</bdi></p>${field(t('destination'),`<select name="${mode==='move_item'?'category_id':'parent_id'}" class="inv-control" required><option value="">${t('chooseDestination')}</option>${list.map(c=>`<option value="${c.id}">${esc(categoryLabel(c))}</option>`).join('')}</select>`)}<p class="inv-caption">${t('dragHelp')}</p>`;submit=capable('manage')&&list.length>0;
    }else if(['receive','use'].includes(mode)){
      body=`<div class="inv-detail-stat"><div><strong><bdi>${esc(itemName(item))}</bdi></strong><p class="inv-muted">${t('current')}: ${number(item.quantity)} <bdi>${esc(item.unit)}</bdi></p></div></div><div class="inv-form-grid">${field(t('quantity'),numeric('quantity',null,true))}</div><div id="inv-balance-preview" class="inv-muted" aria-live="polite"></div>`;
    }else if(mode==='choose-receive'){
      title=t('receive');body=`<p class="inv-muted">${t('itemrequired')}</p><label class="inv-search">${icon('search')}<input id="inv-picker-search" type="search" maxlength="120" aria-label="${t('search')}" placeholder="${t('search')}"></label><div id="inv-picker-results" style="margin-top:16px"></div>`;submit=false;
    }else if(mode==='categories'){
      title=t('manageTitle');submit=false;body=`<div class="inv-tabs inv-management-tabs" role="tablist" aria-label="${t('manageTitle')}">${['categories','items'].map(tab=>button('manage-'+tab,t(tab==='items'?'manageItems':'categories'),tab==='items'?'package':'folders','inv-tab',`id="inv-manage-tab-${tab}" role="tab" aria-controls="inv-management-panel" aria-selected="${state.management?.tab===tab}" tabindex="${state.management?.tab===tab?'0':'-1'}"`)).join('')}</div><div id="inv-management-panel" role="tabpanel"></div>`;

    }else if(mode==='category_save'){
      title=t(dialog.category?'editcategory':'newcategory');const category=dialog.category||{};
      body=`<div class="inv-form-grid">${field(t('english'),input('name',category.name||'','required maxlength="80"'))}${field(t('arabic'),input('name_ar',category.name_ar||'','maxlength="80"'))}${!dialog.category?field(t('parent'),`<select name="parent_id" class="inv-control"><option value="">${t('notset')}</option>${orderedCategories().filter(c=>c.depth<2).map(c=>`<option value="${c.id}">${esc(categoryLabel(c))}</option>`).join('')}</select><span class="inv-caption">${t('categoryDepth')}</span>`,true):field(t('parent'),`<span class="inv-caption">${esc(categoryLabel(categories().find(c=>c.id===category.parent_id)))}</span>`,true)}</div>`;
    }else if(mode==='category_archive'){
      title=t('archivecategory');body=`<p>${esc(t('archivecategorybody'))}</p>`;
    }else if(mode==='assign'){
      title=t('assign');body=`<p class="inv-muted">${number(state.selected.size)} ${t('selected')} · ${t('bulkhelp')}</p>${field(t('category'),`<select name="category_id" class="inv-control" required>${categoryOptions(dialog.category_id,false,false)}</select>`)}`;
    }
    const overlay=document.createElement('div');overlay.id='inventory-overlay';overlay.className='inv-overlay';overlay.setAttribute('role','presentation');
    overlay.innerHTML=`<section role="dialog" aria-modal="true" aria-labelledby="inv-dialog-title" class="inv-dialog ${wide?'inv-wide':''}"><div class="inv-dialog-header"><div><h3 id="inv-dialog-title">${esc(title)}</h3>${itemName(item)?`<p class="inv-muted"><bdi>${esc(itemName(item))}</bdi></p>`:''}</div><button type="button" class="inv-icon-button" data-inv-action="close" aria-label="${t('close')}">${icon('x')}</button></div><form id="inv-dialog-form" class="inv-form"><div class="inv-dialog-body">${body}<div id="inv-dialog-error" class="inv-error" role="alert" hidden></div></div><div class="inv-dialog-footer">${mode==='edit'&&capable('manage')?button('delete-item',t('deleteItem'),'trash-2','inv-danger inv-delete-trigger'):''}${button('close',t(submit?'cancel':'close'),'x')}${submit?`<button type="submit" class="inv-button ${mode==='item_delete'?'inv-danger':'inv-primary'}" id="inv-dialog-submit">${icon(mode==='item_delete'?'trash-2':'check')}<span>${t(mode==='item_delete'?'deleteItem':mode==='move_item'||mode==='move_category'?'move':mode==='category_archive'?'confirm':'save')}</span></button>`:''}</div></form></section>`;
    el('inventory-overlay')?.remove();document.body.appendChild(overlay);document.body.classList.add('inventory-dialog-open');
    if(mode==='edit'&&!capable('manage'))overlay.querySelectorAll('input,select,textarea').forEach(node=>node.disabled=true);
    if((mode==='add'||mode==='edit')&&!capable('adjust'))overlay.querySelector('input[name="quantity"]')?.setAttribute('disabled','');
    if(mode==='edit'&&dialog.draft)for(const name of ['name_en','name_ar','category_id','unit','minimum','quantity']){const node=overlay.querySelector('[name="'+name+'"]');if(node&&name in dialog.draft)node.value=dialog.draft[name];}
    icons();if(item.id)syncPhotos(overlay,[item]);requestAnimationFrame(()=>overlay.querySelector('input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled)')?.focus());
    if(mode==='choose-receive')void picker('');
    if(mode==='categories')renderManagementPanel();
  }
  async function openItem(id,mode='edit',returnManagement=false){
    const context=signature(),token=++state.dialogToken;
    try{const{data,error}=await db.rpc('get_inventory',{p_filters:{id,page:1,size:1}});if(context!==signature()||token!==state.dialogToken||!visible())return;if(error)throw error;let item=data.items?.find(row=>row.id===id);
      if(!item){state.error=errorText({message:'INVENTORY_ITEM'});render();return;}
      const cap=mode==='edit'?'view':mode==='item_delete'?'manage':mode==='receive'?'receive':mode==='use'?'use':'adjust';if(cap!=='view'&&!capable(cap))return;
      openDialog(mode,{item,returnManagement,deleteFromList:mode==='item_delete'&&returnManagement});
    }catch(error){if(context===signature()){state.error=errorText(error);render();}}
  }
  function openManagement(tab){
    if(state.saving||!capable('manage'))return;
    if(!state.management)state.management={tab:'categories',query:'',page:1,report:null,loading:false,error:'',token:0,timer:null};
    if(tab)state.management.tab=tab;
    openDialog('categories');
  }
  function dismissDialog(){if(state.saving)return;if(state.dialog?.mode==='item_delete'){const {item,returnManagement,draft,deleteFromList}=state.dialog;if(deleteFromList)openManagement('items');else openDialog('edit',{item,returnManagement,draft});}else if(state.dialog?.returnManagement)openManagement();else closeDialog();}
  function renderManagementPanel(){
    const manager=state.management,panel=el('inv-management-panel');if(!manager||!panel)return;
    document.querySelectorAll('.inv-management-tabs [role=tab]').forEach(node=>{const selected=node.id==='inv-manage-tab-'+manager.tab;node.setAttribute('aria-selected',String(selected));node.tabIndex=selected?0:-1;});
    panel.setAttribute('aria-labelledby','inv-manage-tab-'+manager.tab);
    if(manager.tab==='categories'){
      manager.token++;clearTimeout(manager.timer);
      panel.innerHTML=button('category-add',t('newcategory'),'folder-plus','inv-primary')+orderedCategories().map(c=>`<div class="inv-category-row" data-inv-drop-category="${c.id}"><div><strong>${esc(categoryLabel(c))}</strong><span class="inv-caption">${number(c.item_count)} ${t('items')}</span></div><div class="inv-actions">${c.parent_id?dragHandle('category',c.id,categoryName(c)):''}${button('category-edit',t('editcategory'),'pencil','',`data-category="${c.id}"`)}${button('category-archive',t('archivecategory'),'archive','',`data-category="${c.id}"`)}</div></div>`).join('');
    }else{
      panel.innerHTML=`<div class="inv-management-toolbar">${button('managed-add',t('add'),'plus','inv-primary')}<label class="inv-search">${icon('search')}<input id="inv-management-search" type="search" maxlength="120" value="${esc(manager.query)}" placeholder="${t('search')}" aria-label="${t('search')}"></label></div><div id="inv-managed-items" aria-live="polite"></div>`;
      void loadManagedItems();
    }
    icons();
  }
  function renderManagedItems(){
    const manager=state.management,root=el('inv-managed-items');if(!manager||!root)return;
    root.setAttribute('aria-busy',String(manager.loading));
    root.innerHTML=manager.loading?'<div class="inv-skeleton"></div><div class="inv-skeleton"></div>':manager.error?`<div class="inv-error" role="alert"><span>${esc(manager.error)}</span>${button('manage-retry',t('retry'),'refresh-cw')}</div>`:manager.report?.items.length?manager.report.items.map(item=>`<div class="inv-managed-item"><div><strong><bdi>${esc(itemName(item))}</bdi></strong><span class="inv-caption">${esc(categoryName(categories().find(c=>c.id===item.category_id)))} · ${number(item.quantity)} <bdi>${esc(item.unit||t('unitmissing'))}</bdi></span></div><div class="inv-actions inv-managed-actions">${button('managed-edit',t('editItem'),'pencil','',`data-id="${item.id}" aria-label="${esc(t('editItem')+': '+itemName(item))}"`)}${button('managed-delete',t('deleteItem'),'trash-2','inv-danger',`data-id="${item.id}" aria-label="${esc(t('deleteItem')+': '+itemName(item))}"`)}</div></div>`).join('')+pagination(manager.report.total,manager.page,20,'manage'):empty(t('itemsEmpty'),t('itemsHelp'));
    icons();
  }
  async function loadManagedItems(){
    const manager=state.management;if(!manager||state.dialog?.mode!=='categories'||manager.tab!=='items'||!capable('manage'))return;
    const token=++manager.token,context=signature(),dialog=state.dialog;manager.loading=true;manager.error='';renderManagedItems();
    const current=()=>state.management===manager&&state.dialog===dialog&&manager.token===token&&context===signature()&&capable('manage');
    try{const{data,error}=await db.rpc('get_inventory',{p_filters:{language:isArabic()?'ar':'en',query:manager.query,sort:'name',page:manager.page,size:20}});if(!current())return;if(error)throw error;manager.report=data;}
    catch(error){if(current())manager.error=errorText(error);}
    finally{if(current()){manager.loading=false;renderManagedItems();}}
  }
  let pickerToken=0;
  async function picker(query){const token=++pickerToken,context=signature();try{const{data,error}=await db.rpc('get_inventory',{p_filters:{language:isArabic()?'ar':'en',query,sort:'name',page:1,size:20}});if(context!==signature()||token!==pickerToken||state.dialog?.mode!=='choose-receive')return;if(error)throw error;el('inv-picker-results').innerHTML=data.items.map(i=>`<div class="inv-category-row inv-picker-row"><div><strong><bdi>${esc(itemName(i))}</bdi></strong><p class="inv-muted">${number(i.quantity)} <bdi>${esc(i.unit||t('unitmissing'))}</bdi></p></div>${button('receive-picked',t('receive'),'package-plus','',`data-id="${i.id}" ${i.quantity==null||!i.unit?'disabled':''}`)}</div>`).join('')||empty(t('nomatches'),t('nomatchesbody'));icons();}catch(error){if(token===pickerToken)showDialogError(errorText(error));}}
  async function submit(event){
    event.preventDefault();if(state.saving||!state.dialog)return;const dialog=state.dialog,form=new FormData(event.target),mode=dialog.mode,item=dialog.item;let operation=mode,payload={};
    try{
      if(mode==='add'||mode==='edit'){
        if(!capable('manage'))return;operation='item_save';payload=Object.fromEntries(['name_en','name_ar','category_id','unit'].map(key=>[key,String(form.get(key)||'').trim()]));payload.minimum=model.numeric(form.get('minimum'));if(!payload.name_en&&!payload.name_ar)throw Error('INVENTORY_NAME');
        if(mode==='edit'){payload.id=item.id;payload.revision=item.revision;if(item.quantity!=null&&item.unit)payload.unit=item.unit;}
        if(mode==='add'||item.quantity==null&&capable('adjust')){payload.quantity=model.numeric(form.get('quantity'));payload.date=today();}
      }else if(mode==='item_delete'){
        if(!capable('manage'))return;payload={id:item.id,revision:item.revision};
      }else if(mode==='move_item'||mode==='move_category'){
        if(!capable('manage'))return;const category=categories().find(c=>c.id===String(form.get(mode==='move_item'?'category_id':'parent_id')||''));if(!category)throw Error('INVENTORY_CATEGORY');
        if(mode==='move_item'){operation='assign';payload={category_id:category.id,category_revision:category.revision,items:[{id:item.id,revision:item.revision}]};}
        else {operation='category_move';payload={id:dialog.category.id,revision:dialog.category.revision,parent_id:category.id,parent_revision:category.revision};}
      }else if(['receive','use'].includes(mode)){
        payload={id:item.id,revision:item.revision,quantity:model.numeric(form.get('quantity'))};
      }else if(mode==='category_save'){
        payload={name:String(form.get('name')||'').trim(),name_ar:String(form.get('name_ar')||'').trim()};
        if(dialog.category){payload.id=dialog.category.id;payload.revision=dialog.category.revision;}
        else payload.parent_id=String(form.get('parent_id')||'');
      }else if(mode==='category_archive'){payload={id:dialog.category.id,revision:dialog.category.revision};}
      else if(mode==='assign'){payload={category_id:String(form.get('category_id')||''),items:[...state.selected.values()].map(i=>({id:i.id,revision:i.revision}))};}
      else return;
      await write(operation,payload);
    }catch(error){showDialogError(errorText(error));}
  }
  function filtersChanged(){clearTimeout(state.timer);state.page=1;state.selected.clear();state.message='';void refresh({force:true});}
  function action(event){
    const target=event.target.closest('[data-inv-action],[data-inv-category],[data-inv-status],[data-inv-item],[data-inv-stat]');if(!target||target.disabled)return;
    if(Date.now()<suppressMoveClickUntil&&(target.dataset.invCategory||target.dataset.invDragKind))return;
    if(target.dataset.invCategory){state.category=target.dataset.invCategory;filtersChanged();return;}
    if(target.dataset.invStatus){state.status=target.dataset.invStatus;filtersChanged();return;}
    if(target.dataset.invItem){void openItem(target.dataset.invItem);return;}
    if(target.dataset.invStat){const key=target.dataset.invStat;if(key==='categories'){openManagement('categories');return;}state.query='';state.category='all';state.status=key==='total'?'all':key;filtersChanged();return;}
    const name=target.dataset.invAction;
    if(name==='supplier-list'){if(!state.saving&&!state.dialog&&!state.quickSaving&&!state.quickPending&&!state.organizePending)host.LuminInventorySupplier?.open({db,allowed:()=>capable('manage')||capable('receive'),context:signature,arabic:isArabic,uuid:newRequestId});return;}
    if(name==='move-item'||name==='move-category'){if(!capable('manage')||state.saving||state.organizePending||state.quickPending)return;const category=categories().find(c=>c.id===target.dataset.id),item=state.report?.items.find(i=>i.id===target.dataset.id);if(name==='move-item'&&item)openDialog('move_item',{item});else if(name==='move-category'&&category?.parent_id)openDialog('move_category',{category,returnManagement:state.dialog?.mode==='categories'});return;}
    if(name==='delete-item'){if(capable('manage')&&state.dialog?.item)openDialog('item_delete',{item:state.dialog.item,returnManagement:state.dialog.returnManagement,draft:Object.fromEntries(new FormData(el('inv-dialog-form')))});return;}
    if(name==='retry-move'){if(state.organizePending)void organizeWrite(state.organizePending.operation,state.organizePending.payload);return;}
    if(name==='close'){dismissDialog();return;}if(state.saving)return;
    if(name==='quick-receive'||name==='quick-use'){void quickStock(name==='quick-receive'?'receive':'use',target.dataset.id);return;}
    if(name==='retry-stock'){if(state.quickPending)void quickStock(state.quickPending.operation,state.quickPending.payload.id);return;}
    if(name==='refresh'){void refresh({force:true});return;}
    if(name==='clear'){Object.assign(state,{query:'',category:'all',status:'all'});filtersChanged();return;}
    if(name==='unselect'){state.selected.clear();render();return;}
    if(name==='assign'){if(capable('manage')&&state.selected.size)openDialog('assign',{category_id:el('inv-bulk-category')?.value||''});return;}
    if(name==='stock-next'||name==='stock-previous'){state.page+=name.endsWith('next')?1:-1;void refresh({force:true});return;}
    if(['receive','use','receive-picked'].includes(name)){void openItem(target.dataset.id,name==='receive-picked'?'receive':name);return;}
    if(name==='manage-categories'||name==='manage-items'){if(capable('manage')&&state.dialog?.mode==='categories'){state.management.tab=name==='manage-items'?'items':'categories';renderManagementPanel();}return;}
    if(name==='manage-next'||name==='manage-previous'){if(capable('manage')&&state.dialog?.mode==='categories'){state.management.page+=name==='manage-next'?1:-1;void loadManagedItems();}return;}
    if(name==='managed-add'){if(capable('manage'))openDialog('add',{returnManagement:true});return;}
    if(name==='managed-delete'){if(capable('manage'))void openItem(target.dataset.id,'item_delete',true);return;}
    if(name==='managed-edit'){if(capable('manage'))void openItem(target.dataset.id,'edit',true);return;}
    if(name==='manage-retry'){void loadManagedItems();return;}
    if(name==='category-edit'||name==='category-archive'){if(capable('manage'))openDialog(name==='category-edit'?'category_save':'category_archive',{category:categories().find(c=>c.id===target.dataset.category),returnManagement:true});return;}
    if(name==='category-add'){if(capable('manage'))openDialog('category_save',{returnManagement:true});return;}
    if(name==='choose-receive'){if(capable('receive'))openDialog(name);return;}
    if(name==='categories'){openManagement();return;}
    if(name==='add'){if(capable('manage'))openDialog('add');return;}
  }
  function change(event){const node=event.target;
    if(node.id==='inv-picture-size'){if(!pictureSizes.includes(node.value))return;state.pictureSize=node.value;try{host.localStorage.setItem('lumin.inventory.pictureSize',node.value);}catch(_){}syncPictureView();return;}
    if(node.id==='inv-mobile-category'){state.category=node.value;filtersChanged();}
    else if(node.id==='inv-subcategory'){state.category=node.value||el('inv-mobile-category').value;filtersChanged();}
    else if(node.id==='inv-sort'){state.sort=node.value;filtersChanged();}
    else if(node.dataset.invSelect){const row=state.report?.items.find(i=>i.id===node.dataset.invSelect);if(row){if(node.checked)state.selected.set(row.id,row);else state.selected.delete(row.id);render();}}
    else if(node.id==='inv-select-page'){for(const row of state.report?.items||[])if(node.checked)state.selected.set(row.id,row);else state.selected.delete(row.id);render();}
  }
  function permissionChanged(node){const group=node.closest('.inv-permissions');if(!group||node.tagName!=='INPUT')return;const view=group.querySelector('input[value="inventory"]');if(!view)return;if(node===view&&!view.checked)group.querySelectorAll('input').forEach(input=>{input.checked=false;});else if(node.checked&&model.permissions.some(p=>p.key===node.value))view.checked=true;}
  function inputChanged(event){const node=event.target;
    if(node.id==='inv-search'){state.query=node.value;state.page=1;state.selected.clear();state.token++;clearTimeout(state.timer);state.timer=setTimeout(()=>void refresh({force:true}),250);}
    if(node.id==='inv-management-search'&&state.management){const manager=state.management;manager.query=node.value;manager.page=1;manager.token++;clearTimeout(manager.timer);manager.timer=setTimeout(()=>void loadManagedItems(),250);}
    if(node.id==='inv-picker-search'){clearTimeout(state.timer);const value=node.value;state.timer=setTimeout(()=>void picker(value),200);}
    if(node.name==='quantity'&&state.dialog?.item&&el('inv-balance-preview')){try{const qty=model.numeric(node.value),item=state.dialog.item;const after=qty==null?null:item.quantity==null?null:Number(item.quantity)+(state.dialog.mode==='receive'?qty:-qty);el('inv-balance-preview').textContent=`${t('before')} ${number(item.quantity)} → ${t('after')} ${number(after)} ${item.unit}`;}catch(_){el('inv-balance-preview').textContent='';}}
  }
  function keydown(event){const overlay=el('inventory-overlay');if(!overlay)return;if(event.key==='Escape'){event.preventDefault();dismissDialog();return;}if(event.target.matches('[role=tab]')&&event.target.closest('.inv-management-tabs')&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();state.management.tab=event.key==='Home'?'categories':event.key==='End'?'items':state.management.tab==='categories'?'items':'categories';renderManagementPanel();el('inv-manage-tab-'+state.management.tab)?.focus();return;}if(event.key==='Tab'){const nodes=Array.from(overlay.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')).filter(node=>node.getClientRects().length);if(!nodes.length)return;const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}}
  function init(){host.LuminInventoryImages?.init({icons,arabic:isArabic,name:itemName,uuid:newRequestId,endpoint:()=>SUPABASE_URL+'/functions/v1/inventory-images',token:async()=>{const {data}=await db.auth.getSession();return data?.session?.access_token||'';},changed:photoChanged,refresh:()=>refresh({force:true,background:true})});const root=el('view-inventory');if(!root||root.dataset.inventoryBound)return;root.dataset.inventoryBound='true';bindDrag();host.addEventListener('beforeunload',event=>{if(state.quickSaving||state.quickPending||state.quickQueue.length){event.preventDefault();event.returnValue='';}});document.addEventListener('click',event=>{if(root.contains(event.target)||el('inventory-overlay')?.contains(event.target))action(event);if(event.target===el('inventory-overlay'))dismissDialog();});document.addEventListener('change',event=>{permissionChanged(event.target);if(root.contains(event.target)||el('inventory-overlay')?.contains(event.target))change(event);});document.addEventListener('input',event=>{if(root.contains(event.target)||el('inventory-overlay')?.contains(event.target))inputChanged(event);});document.addEventListener('submit',event=>{if(event.target.id==='inv-dialog-form')void submit(event);});document.addEventListener('keydown',keydown);}
  function invalidate(){state.loadedAt=0;host.LuminInventorySupplier?.checkAccess();if(!allowed()){reset();return;}state.dataSequence++;if(state.quickSaving){state.quickRefreshQueued=true;return;}if(visible())scheduleRefresh();}
  function languageChanged(){const label=el('clinic-management-tab-inventory')?.querySelector('span');if(label)label.textContent=t('inventory');if(state.dialog)closeDialog();host.LuminInventorySupplier?.close(true);state.loadedAt=0;if(visible()){render();return refresh({force:true});}}
  function leave(){pickerToken++;closeDialog(false,true);host.LuminInventorySupplier?.close(true);}
  host.LuminInventory={init,refresh,reset,invalidate,languageChanged,leave,summary:()=>state.report?.summary||null};
  if(typeof document!=='undefined')document.addEventListener('DOMContentLoaded',init);
})(typeof window==='undefined'?globalThis:window);
