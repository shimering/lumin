/* Category-based clinic inventory. All stock writes use the server-validated ledger. */
(function (host) {
  'use strict';
  const model=host.LuminInventoryModel;
  const state={actor:'',token:0,historyToken:0,dialogToken:0,report:null,history:null,loading:false,historyLoading:false,saving:false,exporting:false,error:'',message:'',loadedAt:0,query:'',category:'all',status:'all',sort:'status',page:1,tab:'stock',selected:new Map(),historyPage:1,historyKind:'',historyStart:'',historyEnd:'',historyQuery:'',historyItem:'',dialog:null,pending:null,quickPending:null,timer:null,returnFocus:null};
  const words={
    chooseUnit:['Choose a stock unit','اختر وحدة المخزون'],
    nameEn:['English name','الاسم بالإنجليزية'],nameAr:['Arabic name','الاسم بالعربية'],nameHelp:['Enter at least one name. The app uses the available name if a translation is blank.','أدخل اسماً واحداً على الأقل. يستخدم التطبيق الاسم المتاح إذا كانت الترجمة فارغة.'],
    increase:['Increase stock by 1','زيادة المخزون بمقدار ١'],decrease:['Decrease stock by 1','خفض المخزون بمقدار ١'],unconfirmed:['The change could not be confirmed. Retry to check it safely.','تعذر تأكيد التغيير. أعد المحاولة للتحقق منه بأمان.'],retryStock:['Retry change','إعادة محاولة التغيير'],oneRequired:['At least one stock unit is needed to decrease by 1.','يلزم توفر وحدة مخزون واحدة على الأقل للخفض بمقدار ١.'],stockLimit:['The maximum stock quantity has been reached.','تم بلوغ الحد الأقصى لكمية المخزون.'],
    inventory:['Inventory','المخزون'],subtitle:['Items, categories & daily stock movements','الأصناف والتصنيفات وحركات المخزون اليومية'],add:['Add item','إضافة صنف'],receive:['Receive stock','استلام مخزون'],use:['Record use','تسجيل استهلاك'],reverse:['Reverse movement','عكس الحركة'],refresh:['Refresh inventory','تحديث المخزون'],import:['Import CSV','استيراد CSV'],export:['Export CSV','تصدير CSV'],total:['Total items','إجمالي الأصناف'],categories:['Categories','التصنيفات'],low:['Low stock','مخزون منخفض'],out:['Out of stock','نفد المخزون'],unknown:['Not counted','لم يتم الجرد'],unconfigured:['Minimum not set','الحد الأدنى غير محدد'],healthy:['In stock','متاح'],review:['Needs review','تحتاج مراجعة'],threshold:['At or below minimum','عند الحد الأدنى أو أقل'],zero:['Recorded quantity is zero','الكمية المسجلة صفر'],all:['All items','كل الأصناف'],allstatus:['All statuses','كل الحالات'],allkinds:['All movements','كل الحركات'],items:['items','أصناف'],category:['Category','التصنيف'],manage:['Manage categories','إدارة التصنيفات'],stock:['Stock','الأصناف'],movements:['Movements','حركات المخزون'],search:['Search items or categories','ابحث عن صنف أو تصنيف'],name:['Item name','اسم الصنف'],current:['Current quantity','الكمية الحالية'],minimum:['Minimum','الحد الأدنى'],unit:['Stock unit','وحدة المخزون'],unitmissing:['Unit not set','الوحدة غير محددة'],details:['Item details','تفاصيل الصنف'],close:['Close','إغلاق'],cancel:['Cancel','إلغاء'],save:['Save changes','حفظ التغييرات'],notset:['Not set','غير محدد'],uncategorized:['Uncategorized','غير مصنف'],empty:['Your inventory starts here','ابدأ بإضافة مخزون العيادة'],emptybody:['Add your first item or import a CSV to organize the clinic’s supplies.','أضف أول صنف أو استورد ملف CSV لتنظيم مستلزمات العيادة.'],nomatches:['No matching items','لا توجد أصناف مطابقة'],nomatchesbody:['Choose another category or clear the filters.','اختر تصنيفاً آخر أو امسح عوامل التصفية.'],clear:['Clear filters','مسح عوامل التصفية'],retry:['Try again','إعادة المحاولة'],loading:['Loading inventory','جار تحميل المخزون'],failed:['Could not refresh inventory. Your last successful view is still shown.','تعذر تحديث المخزون. ما زالت آخر بيانات تم تحميلها ظاهرة.'],notavailable:['Inventory is not available for this clinic yet. Contact your administrator.','المخزون غير متاح لهذه العيادة بعد. تواصل مع المسؤول.'],saved:['Inventory updated.','تم تحديث المخزون.'],offline:['Connect to the internet to save stock changes.','اتصل بالإنترنت لحفظ حركات المخزون.'],readOnly:['Read only','عرض فقط'],selected:['selected','محدد'],assign:['Assign category','تعيين التصنيف'],select:['Select item','تحديد الصنف'],selectpage:['Select this page','تحديد الصفحة'],sort:['Sort items','ترتيب الأصناف'],statussort:['Stock priority','أولوية المخزون'],namesort:['Name','الاسم'],quantitysort:['Quantity','الكمية'],previous:['Previous page','الصفحة السابقة'],next:['Next page','الصفحة التالية'],of:['of','من'],opening:['Opening quantity','الكمية الافتتاحية'],unknownhelp:['Leave blank if this item has not been counted.','اتركها فارغة إذا لم يتم جرد الصنف.'],optional:['Optional','اختياري'],needsetup:['Set the stock unit and opening count before receiving or recording use.','حدد وحدة المخزون والكمية الافتتاحية قبل الاستلام أو تسجيل الاستهلاك.'],quantity:['Quantity','الكمية'],observed:['Counted quantity','الكمية بعد الجرد'],date:['Movement date','تاريخ الحركة'],reason:['Reason','السبب'],reference:['Reference','المرجع'],before:['Before','قبل'],after:['After','بعد'],english:['Category name','اسم التصنيف'],arabic:['Arabic category name','اسم التصنيف بالعربية'],parent:['Parent category','التصنيف الرئيسي'],newcategory:['Add category','إضافة تصنيف'],editcategory:['Edit category','تعديل التصنيف'],archivecategory:['Archive category','أرشفة التصنيف'],archivecategorybody:['Archive this category? Move its active items and subcategories first.','هل تريد أرشفة التصنيف؟ انقل أصنافه وتصنيفاته الفرعية النشطة أولاً.'],file:['CSV file','ملف CSV'],importhelp:['Arabic or English columns: category, item (or English name and Arabic name), current quantity, minimum, unit. Blank quantities stay unknown. Category suggestions can be changed before import.','أعمدة عربية أو إنجليزية: التصنيف، الصنف (أو الاسم بالإنجليزية والاسم بالعربية)، الكمية الحالية، الحد الأدنى، الوحدة. الكمية الفارغة تبقى غير معروفة. يمكنك تعديل التصنيفات المقترحة قبل الاستيراد.'],importdate:['Opening balance date','تاريخ الرصيد الافتتاحي'],importready:['Review the rows, then import. Existing items are not overwritten.','راجع الصفوف ثم استوردها. لن يتم استبدال الأصناف الموجودة.'],nohistory:['No stock movements yet','لا توجد حركات مخزون بعد'],historybody:['Receipts, usage, counts and corrections will appear here.','ستظهر هنا حركات الاستلام والاستهلاك والجرد والتصحيح.'],staff:['Recorded by','سجلها'],openingkind:['Opening count','رصيد افتتاحي'],countkind:['Stock count','جرد المخزون'],receivekind:['Receipt','استلام'],usekind:['Usage','استهلاك'],wastekind:['Wastage','تالف'],reversalkind:['Reversal','عكس حركة'],start:['From','من'],end:['To','إلى'],apply:['Apply','تطبيق'],historysearch:['Search item, reference or staff','ابحث بالصنف أو المرجع أو الموظف'],showall:['All item movements','حركات كل الأصناف'],unitlocked:['A recorded unit cannot be changed after stock movements. Create a separate item for another unit.','لا يمكن تغيير الوحدة المسجلة بعد وجود حركات. أضف صنفاً منفصلاً لوحدة أخرى.'],lastloaded:['Last refreshed','آخر تحديث'],countdatehelp:['Use the date these opening balances were recorded.','اختر تاريخ تسجيل هذه الأرصدة الافتتاحية.'],itemrequired:['Choose an item','اختر صنفاً'],confirm:['Confirm','تأكيد'],bulkhelp:['Move the selected items without changing their stock balances.','انقل الأصناف المحددة دون تغيير أرصدتها.']
  };
  const el=id=>document.getElementById(id);
  const isArabic=()=>typeof currentUiLanguage!=='undefined'?currentUiLanguage==='ar':document.documentElement.dir==='rtl';
  const t=key=>(words[key]||[key,key])[isArabic()?1:0];
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon=name=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
  const icons=()=>{if(host.lucide)host.lucide.createIcons();};
  const number=value=>value==null?'—':new Intl.NumberFormat(isArabic()?'ar-EG':'en-GB',{maximumFractionDigits:3}).format(Number(value));
  const actor=()=>typeof currentSession!=='undefined'?currentSession?.user?.id||'':'';
  function newRequestId(){if(host.crypto.randomUUID)return host.crypto.randomUUID();const bytes=host.crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;}
  const allowed=()=>typeof hasPageAccess==='function'&&hasPageAccess('inventory');
  const signature=()=>`${actor()}:${allowed()}:${typeof currentUserAccess!=='undefined'?[...currentUserAccess?.permissions||[]].sort().join(',')+Boolean(currentUserAccess?.isAdmin):''}`;
  const capable=key=>allowed()&&Boolean(state.report?.permissions?.[key]);
  const categories=()=>state.report?.categories||[];
  const itemName=item=>model.itemName(item,isArabic()?'ar':'en');
  const categoryName=category=>category?(isArabic()&&category.name_ar?category.name_ar:category.name):t('uncategorized');
  const visible=()=>!!el('view-inventory')&&!el('view-inventory').classList.contains('hidden')&&!el('view-clinic-management')?.classList.contains('hidden');
  const today=()=>typeof hrClinicDateValue==='function'?hrClinicDateValue():new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const button=(action,label,name='plus',extra='',attrs='')=>action==='import'&&!capable('adjust')?'':`<button type="button" class="inv-button ${extra}" data-inv-action="${action}" ${attrs}>${icon(name)}<span>${esc(label)}</span></button>`;
  const field=(label,control,span=false)=>`<label class="inv-field ${span?'inv-span':''}"><span>${esc(label)}</span>${control}</label>`;
  const input=(name,value='',attrs='')=>`<input class="inv-control" name="${name}" value="${esc(value)}" ${attrs}>`;
  const categoryOptions=(selected='',optional=false,includeParents=true)=>`${optional?`<option value="">${t('uncategorized')}</option>`:''}${categories().filter(c=>c.active&&(includeParents||!categories().some(child=>child.parent_id===c.id&&child.active))).map(c=>`<option value="${c.id}" ${selected===c.id?'selected':''}>${esc(categoryName(c))}</option>`).join('')}`;
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
    const pairs={INVENTORY_NAME:[words.nameHelp[0],words.nameHelp[1]],INVENTORY_ACCESS:['Your inventory access changed. Refresh the page or contact an administrator.','تغيرت صلاحيات المخزون. حدّث الصفحة أو تواصل مع المسؤول.'],INVENTORY_STALE:['This record changed. Close it, refresh, and review the current balance before saving again.','تم تعديل هذا السجل. أغلقه وحدّث البيانات وراجع الرصيد قبل الحفظ مجدداً.'],INVENTORY_UNIT_LOCKED:[words.unitlocked[0],words.unitlocked[1]],INVENTORY_CATEGORY_IN_USE:['Move the category’s active items and subcategories before archiving it.','انقل الأصناف والتصنيفات الفرعية النشطة قبل الأرشفة.'],INVENTORY_ALREADY_IMPORTED:['This file includes items already imported. Review existing stock instead of importing it twice.','يتضمن الملف أصنافاً مستوردة بالفعل. راجع المخزون الموجود بدلاً من تكرار الاستيراد.'],INVENTORY_BALANCE:['There is not enough stock for this movement. Refresh and check the current balance.','المخزون غير كافٍ لهذه الحركة. حدّث البيانات وراجع الرصيد الحالي.'],INVENTORY_COUNT_REQUIRED:['Record an opening count first.','سجل جرداً افتتاحياً أولاً.'],INVENTORY_UNIT_REQUIRED:['Set the item’s stock unit first.','حدد وحدة مخزون الصنف أولاً.'],INVENTORY_REASON:['Enter a reason for this correction.','أدخل سبباً لهذا التصحيح.'],INVENTORY_DATE:['Choose a valid movement date that is not in the future.','اختر تاريخ حركة صحيحاً لا يتجاوز اليوم.'],INVENTORY_REVERSAL:['This movement cannot be reversed. Review the item history and use a reasoned stock count if necessary.','لا يمكن عكس هذه الحركة. راجع سجل الصنف واستخدم جرداً مسبباً عند الحاجة.'],INVENTORY_NUMBER:['Enter a non-negative quantity with up to three decimal places.','أدخل كمية غير سالبة بحد أقصى ثلاثة أرقام عشرية.'],INVENTORY_CSV_HEADERS:['The file needs Item, Current quantity, Minimum and Unit columns (Arabic labels are supported).','يحتاج الملف أعمدة الصنف والكمية الحالية والحد الأدنى والوحدة. العناوين العربية مدعومة.'],INVENTORY_CSV_SIZE:['Choose a CSV with up to 500 items and a size below 1 MB.','اختر ملف CSV لا يزيد على ٥٠٠ صنف وحجمه أقل من ١ ميجابايت.'],INVENTORY_CSV_EMPTY:['The CSV has no item rows.','لا يحتوي ملف CSV على أصناف.'],INVENTORY_CSV_FORMAT:['The CSV contains invalid quoting or columns. Check the file and try again.','تنسيق علامات الاقتباس أو الأعمدة غير صحيح. راجع الملف ثم حاول مجدداً.']};
    for(const[key,pair]of Object.entries(pairs))if(message.includes(key))return pair[isArabic()?1:0];
    if(/INVENTORY_CSV_(ROW|DUPLICATE|NUMBER):/.test(message)){const line=message.split(':').pop();return isArabic()?`راجع صف الملف رقم ${line}: اسم مكرر أو بيانات غير صحيحة.`:`Check CSV row ${line}: duplicate name or invalid data.`;}
    if(error?.code==='23505')return isArabic()?'يوجد صنف أو تصنيف بهذا الاسم بالفعل.':'This item or category already exists.';
    if(error?.code==='PGRST202'||error?.code==='42P01')return t('notavailable');
    return isArabic()?'تعذر إتمام العملية. راجع البيانات وحاول مجدداً.':'Could not complete the operation. Check the values and try again.';
  }
  function reset(){
    state.token++;state.historyToken++;clearTimeout(state.timer);closeDialog(false,true);
    Object.assign(state,{actor:'',report:null,history:null,loading:false,historyLoading:false,saving:false,exporting:false,error:'',message:'',loadedAt:0,query:'',category:'all',status:'all',sort:'status',page:1,tab:'stock',historyPage:1,historyKind:'',historyStart:'',historyEnd:'',historyQuery:'',historyItem:'',pending:null,quickPending:null});
    state.selected.clear();el('view-inventory')?.replaceChildren();
  }
  function focusSnapshot(){const node=document.activeElement;return node&&el('view-inventory')?.contains(node)?{id:node.id,start:node.selectionStart,end:node.selectionEnd}:null;}
  function restoreFocus(saved){if(!saved?.id)return;const node=el(saved.id);node?.focus({preventScroll:true});if(node?.setSelectionRange&&saved.start!=null)try{node.setSelectionRange(saved.start,saved.end);}catch(_){}}
  function empty(title,body,action=''){return `<div class="inv-empty"><span class="inv-empty-icon">${icon('package-open')}</span><h3>${esc(title)}</h3><p>${esc(body)}</p>${action}</div>`;}
  function pill(item){const status=model.status(item);return `<span class="inv-pill ${status==='low'?'inv-amber':status==='out'?'inv-rose':status==='healthy'?'inv-green':''}">${t(status)}</span>`;}
  function stockControl(item){
    const step=(operation,label,ico)=>{
      const retry=state.quickPending?.payload.id===item.id&&state.quickPending.operation===operation;
      const unavailable=item.quantity==null||!item.unit;
      const boundary=operation==='use'?Number(item.quantity)<1:Number(item.quantity)>999999999;
      const disabled=state.saving||state.loading||!capable(operation)||(!retry&&(unavailable||boundary||Boolean(state.quickPending)));
      const hint=retry?t('retryStock'):!capable(operation)?t('readOnly'):unavailable?t('needsetup'):boundary?t(operation==='use'?'oneRequired':'stockLimit'):t(label);
      return `<button type="button" id="inv-stock-${operation}-${item.id}" class="inv-icon-button inv-stock-step inv-stock-${operation}" data-inv-action="quick-${operation}" data-id="${item.id}" aria-label="${esc(t(label)+': '+itemName(item))}" title="${esc(hint)}" ${disabled?'disabled':''}>${icon(ico)}</button>`;
    };
    return `<div class="inv-stock-stepper" dir="ltr" role="group" aria-label="${esc(t('current')+': '+itemName(item))}" aria-busy="${state.saving&&state.quickPending?.payload.id===item.id}">${step('use','decrease','minus')}<span class="inv-number" aria-live="polite" aria-atomic="true">${number(item.quantity)}</span>${step('receive','increase','plus')}</div>`;
  }
  function pagination(total,page,size,scope='stock'){
    const pages=Math.max(1,Math.ceil(Number(total||0)/size));
    return `<div class="inv-pagination"><span class="inv-caption">${total?`${number((page-1)*size+1)}–${number(Math.min(page*size,total))} ${t('of')} ${number(total)}`:`${number(0)} ${t('items')}`}</span><div class="inv-actions">${button(scope+'-previous',t('previous'),'chevron-left','',page<=1?'disabled':'')}<span class="inv-caption">${number(page)} / ${number(pages)}</span>${button(scope+'-next',t('next'),'chevron-right','',page>=pages?'disabled':'')}</div></div>`;
  }
  function render(){
    const root=el('view-inventory');if(!root)return;const focused=focusSnapshot();
    if(!allowed()){root.replaceChildren();return;}
    const data=state.report,summary=data?.summary||{},canManage=capable('manage');
    const navButton=(id,name,count,ico='folder')=>`<button type="button" class="inv-category ${categories().find(c=>c.id===id)?.parent_id?'inv-category-child':''}" data-inv-category="${esc(id)}" aria-pressed="${state.category===id}">${icon(ico)}<span>${esc(name)}</span><small>${number(count)}</small></button>`;
    const activeCategories=categories().filter(c=>c.active),orderedCategories=activeCategories.filter(c=>!c.parent_id).flatMap(c=>[c,...activeCategories.filter(child=>child.parent_id===c.id)]);
    const catNav=navButton('all',t('all'),summary.total,'layers')+orderedCategories.map(c=>navButton(c.id,categoryName(c),c.item_count,c.parent_id?'package':'folder-open')).join('')+navButton('uncategorized',t('uncategorized'),summary.uncategorized||0);
    root.innerHTML=`<div class="inv-heading"><div><h2>${t('inventory')}</h2><p class="inv-muted">${t('subtitle')}</p></div><div class="inv-actions">${button('refresh',t('refresh'),'refresh-cw','',state.loading?'disabled':'')}${canManage?button('import',t('import'),'upload')+button('add',t('add'),'plus'):''}${capable('receive')?button('choose-receive',t('receive'),'package-plus','inv-primary'):''}</div></div>
      ${state.error||state.quickPending&&!state.saving?`<div class="inv-error" role="alert"><span>${esc(state.error||t('unconfirmed'))}</span>${state.quickPending?button('retry-stock',t('retryStock'),'refresh-cw','',state.saving||state.loading?'disabled':''):button('refresh',t('retry'),'refresh-cw')}</div>`:''}
      ${state.message?`<div class="inv-status" role="status">${icon('circle-check')}<span>${esc(state.message)}</span></div>`:''}
      <div class="inv-stats">${[['total','package',t('items')],['categories','folders',t('categories')],['low','triangle-alert',t('threshold')],['out','package-x',t('zero')]].map(([key,name,note])=>`<button type="button" class="inv-panel inv-stat" data-inv-stat="${key}"><span class="inv-stat-label">${icon(name)}${t(key)}</span><strong>${data?number(summary[key]):'—'}</strong><span class="inv-caption">${note}</span></button>`).join('')}</div>
      <div class="inv-mobile-category">${field(t('category'),`<select class="inv-control" id="inv-mobile-category"><option value="all">${t('all')}</option>${categoryOptions(state.category)}<option value="uncategorized" ${state.category==='uncategorized'?'selected':''}>${t('uncategorized')}</option></select>`)}${canManage?button('categories',t('manage'),'folder-pen'):''}</div>
      <div class="inv-workspace"><aside class="inv-panel inv-category-nav"><h3 class="inv-category-heading">${t('categories')}</h3>${catNav}${canManage?button('categories',t('manage'),'folder-pen','inv-category-manage'):''}</aside><div class="inv-content">
        <div class="inv-tabs" role="group" aria-label="${t('inventory')}">${button('stock',t('stock'),'package','inv-tab',`aria-pressed="${state.tab==='stock'}"`)}${button('history',t('movements'),'history','inv-tab',`aria-pressed="${state.tab==='history'}"`)}${button('export',t('export'),'download','',state.exporting||!data?'disabled':'')}${!Object.values(data?.permissions||{}).some(Boolean)?`<span class="inv-pill">${t('readOnly')}</span>`:''}</div>
        ${state.tab==='history'?renderHistory():renderStock()}
        ${state.loadedAt?`<p class="inv-muted">${t('lastloaded')}: ${esc(new Intl.DateTimeFormat(isArabic()?'ar-EG':'en-GB',{hour:'2-digit',minute:'2-digit'}).format(state.loadedAt))}</p>`:''}
      </div></div>${capable('receive')||canManage?`<div class="inv-mobile-actions">${canManage?button('add',t('add'),'plus'):''}${capable('receive')?button('choose-receive',t('receive'),'package-plus','inv-primary'):''}</div>`:''}`;
    if(el('inv-mobile-category'))el('inv-mobile-category').value=state.category;
    icons();restoreFocus(focused);
  }
  function renderStock(){
    const data=state.report,rows=data?.items||[],manage=capable('manage');
    const selected=[...state.selected.values()];
    const title=state.category==='all'?t('all'):categoryName(categories().find(c=>c.id===state.category));
    const skeleton=Array.from({length:4},()=>'<div class="inv-skeleton"></div>').join('');
    return `<section class="inv-panel" aria-busy="${state.loading}"><div class="inv-list-heading"><h3>${esc(title)}</h3><span class="inv-caption" aria-live="polite">${data?`${number(data.total)} ${t('items')}`:t('loading')}</span></div>
      <div class="inv-tools"><label class="inv-search">${icon('search')}<input id="inv-search" type="search" maxlength="120" value="${esc(state.query)}" placeholder="${t('search')}" aria-label="${t('search')}"></label><div class="inv-filterbar">${['all','low','out','unknown','review'].map(key=>`<button class="inv-tab" type="button" data-inv-status="${key}" aria-pressed="${state.status===key}">${t(key==='all'?'allstatus':key)}</button>`).join('')}<select id="inv-sort" class="inv-control" aria-label="${t('sort')}">${[['status','statussort'],['name','namesort'],['quantity','quantitysort']].map(([key,label])=>`<option value="${key}" ${state.sort===key?'selected':''}>${t(label)}</option>`).join('')}</select></div></div>
      ${selected.length?`<div class="inv-bulk"><span>${number(selected.length)} ${t('selected')}</span><select id="inv-bulk-category" class="inv-control" aria-label="${t('category')}">${categoryOptions('',false,false)}</select>${button('assign',t('assign'),'folder-input','',state.saving?'disabled':'')}${button('unselect',t('clear'),'x')}</div>`:''}
      ${!data&&state.loading?skeleton:rows.length?`<table class="inv-table"><thead><tr><th>${manage?`<label class="inv-check"><input type="checkbox" id="inv-select-page" aria-label="${t('selectpage')}" ${rows.every(i=>state.selected.has(i.id))?'checked':''}></label>`:''}</th><th>${t('name')}</th><th>${t('category')}</th><th>${t('current')}</th><th>${t('minimum')}</th><th>${t('details')}</th></tr></thead><tbody>${rows.map(item=>`<tr><td>${manage?`<label class="inv-check"><input type="checkbox" data-inv-select="${item.id}" aria-label="${t('select')}: ${esc(itemName(item))}" ${state.selected.has(item.id)?'checked':''}></label>`:''}</td><td><button type="button" class="inv-item" data-inv-item="${item.id}"><bdi>${esc(itemName(item))}</bdi></button></td><td><span class="inv-pill">${esc(categoryName(categories().find(c=>c.id===item.category_id)))}</span></td><td data-label="${t('current')}"><div class="inv-stock-line">${stockControl(item)}<div class="inv-stock-meta"><span class="inv-caption ${!item.unit?'inv-review':''}">${esc(item.unit||t('unitmissing'))}</span><div class="inv-stock-status">${pill(item)}</div></div></div></td><td data-label="${t('minimum')}"><span class="inv-number">${number(item.minimum)}</span></td><td><button type="button" class="inv-icon-button" data-inv-item="${item.id}" aria-label="${t('details')}: ${esc(itemName(item))}">${icon('sliders-horizontal')}</button></td></tr>`).join('')}</tbody></table>`:data?.summary.total===0?empty(t('empty'),t('emptybody'),manage?button('add',t('add'),'plus','inv-primary')+button('import',t('import'),'upload'):''):empty(t('nomatches'),t('nomatchesbody'),button('clear',t('clear'),'filter-x'))}
      ${data?pagination(data.total,state.page,data.size||20):''}</section>`;
  }
  function renderHistory(){
    const history=state.history;
    return `<section class="inv-panel" aria-busy="${state.historyLoading}"><div class="inv-list-heading"><h3>${t('movements')}</h3>${state.historyItem?button('all-history',t('showall'),'layers'):''}</div><div class="inv-tools"><label class="inv-search">${icon('search')}<input id="inv-history-query" type="search" maxlength="120" value="${esc(state.historyQuery)}" placeholder="${t('historysearch')}" aria-label="${t('historysearch')}"></label><div class="inv-filterbar"><select class="inv-control" id="inv-history-kind" aria-label="${t('movements')}"><option value="">${t('allkinds')}</option>${['opening','receive','use','count','waste','reversal'].map(k=>`<option value="${k}" ${state.historyKind===k?'selected':''}>${t(k+'kind')}</option>`).join('')}</select>${field(t('start'),input('start',state.historyStart,'id="inv-history-start" type="date"'))}${field(t('end'),input('end',state.historyEnd,'id="inv-history-end" type="date"'))}${button('history-apply',t('apply'),'check')}</div></div>
      ${!history&&state.historyLoading?'<div class="inv-skeleton"></div>':history?.rows.length?`<div class="inv-movements">${history.rows.map(row=>`<article class="inv-movement"><div><strong><bdi>${esc(itemName({name:row.item_name,name_en:row.item_name_en,name_ar:row.item_name_ar}))}</bdi></strong> <span class="inv-pill">${t(row.kind+'kind')}</span><p class="inv-caption">${esc(row.movement_date)} · ${t('staff')}: ${esc(row.actor_name)}</p><p>${row.quantity>0?'+':''}${number(row.quantity)} <bdi>${esc(row.unit)}</bdi> · ${t('before')} ${number(row.before_quantity)} → ${t('after')} ${number(row.after_quantity)}</p>${row.reason?`<p>${esc(row.reason)}</p>`:''}${row.reference?`<p class="inv-caption"><bdi>${esc(row.reference)}</bdi></p>`:''}<span class="inv-caption">${esc(isArabic()&&row.category_name_ar?row.category_name_ar:row.category_name)}</span></div><div class="inv-actions">${button('movement-item',t('details'),'sliders-horizontal','',`data-id="${row.item_id}"`)}${capable('adjust')&&['receive','use','waste'].includes(row.kind)?button('reverse',t('reverse'),'undo-2','',`data-movement="${row.id}" data-id="${row.item_id}"`):''}</div></article>`).join('')}</div>`:empty(t('nohistory'),t('historybody'))}${history?pagination(history.total,state.historyPage,30,'history'):''}</section>`;
  }
  async function refresh(options={}){
    if(!allowed()||!actor()){if(state.report)reset();return;}
    const context=signature();if(state.actor&&state.actor!==context)reset();state.actor=context;
    if(!options.force&&state.report&&Date.now()-state.loadedAt<30000){render();return;}
    const token=++state.token;state.loading=true;state.error='';render();
    try{
      const {data,error}=await db.rpc('get_inventory',{p_filters:{language:isArabic()?'ar':'en',query:state.query,category:state.category,status:state.status,sort:state.sort,page:state.page,size:20}});
      if(token!==state.token||context!==signature())return;if(error)throw error;
      state.report=data;state.loadedAt=Date.now();state.error='';
      if(state.quickPending&&!data.permissions?.[state.quickPending.operation]){state.quickPending=null;state.error=errorText({message:'INVENTORY_ACCESS'});}
      if(data.total>0&&state.page>Math.ceil(data.total/20)){state.page=Math.ceil(data.total/20);state.loading=false;return refresh({force:true});}
      if(!data.permissions?.manage)state.selected.clear();
    }catch(error){if(token===state.token&&context===signature())state.error=error?.code==='PGRST202'||error?.code==='42P01'?t('notavailable'):t('failed');}
    finally{if(token===state.token&&context===signature()){state.loading=false;render();}}
  }
  async function loadHistory(){
    if(!allowed()||!actor())return;const token=++state.historyToken,context=signature();state.historyLoading=true;render();
    try{const {data,error}=await db.rpc('get_inventory_movements',{p_filters:{page:state.historyPage,item_id:state.historyItem,kind:state.historyKind,start:state.historyStart,end:state.historyEnd,query:state.historyQuery}});if(token!==state.historyToken||context!==signature())return;if(error)throw error;state.history=data;}
    catch(error){if(token===state.historyToken&&context===signature())state.error=errorText(error);}
    finally{if(token===state.historyToken&&context===signature()){state.historyLoading=false;render();}}
  }
  async function quickStock(operation,id){
    if(state.saving||state.loading||state.dialog||!allowed()||!actor()||!capable(operation))return;
    if(typeof navigator!=='undefined'&&navigator.onLine===false){state.error=t('offline');render();return;}
    const context=signature(),focusId=`inv-stock-${operation}-${id}`;
    if(state.quickPending&&(state.quickPending.context!==context||state.quickPending.operation!==operation||state.quickPending.payload.id!==id))return;
    if(!state.quickPending){
      const item=state.report?.items.find(row=>row.id===id);
      if(!item||item.quantity==null||!item.unit||(operation==='use'?Number(item.quantity)<1:Number(item.quantity)>999999999))return;
      state.quickPending={context,operation,id:newRequestId(),payload:{id,revision:item.revision,quantity:1,date:today()}};
    }
    const pending=state.quickPending;state.saving=true;state.error='';state.message='';render();
    try{
      const{error}=await db.rpc('inventory_write',{p_operation:pending.operation,p_payload:pending.payload,p_request_id:pending.id});
      if(context!==signature())return;if(error)throw error;
      state.quickPending=null;state.selected.clear();state.message=t('saved');await refresh({force:true});if(state.tab==='history')await loadHistory();
    }catch(error){
      if(context===signature()){
        if(/INVENTORY_/.test(String(error?.message||''))||['22023','23505','40001','42501','23514'].includes(error?.code)){
          state.quickPending=null;await refresh({force:true});state.error=errorText(error);
        }else state.error=t('unconfirmed');
      }
    }finally{
      if(context===signature()){state.saving=false;render();if(visible()&&document.activeElement===document.body)el(focusId)?.focus({preventScroll:true});}
    }
  }
  async function write(operation,payload){
    if(state.saving)return false;
    if(typeof navigator!=='undefined'&&navigator.onLine===false){showDialogError(t('offline'));return false;}
    const context=signature(),fingerprint=JSON.stringify([context,operation,payload]);
    if(state.pending?.fingerprint!==fingerprint)state.pending={fingerprint,id:newRequestId()};
    const requestId=state.pending.id;state.saving=true;state.error='';setDialogBusy(true);
    try{const {error}=await db.rpc('inventory_write',{p_operation:operation,p_payload:payload,p_request_id:requestId});if(context!==signature())return false;if(error)throw error;
      state.pending=null;state.selected.clear();state.message=t('saved');closeDialog(true,true);await refresh({force:true});if(state.tab==='history')await loadHistory();return true;
    }catch(error){if(context===signature()){if(state.dialog)showDialogError(errorText(error));else{state.error=errorText(error);render();}}return false;}
    finally{if(context===signature()){state.saving=false;setDialogBusy(false);render();}}
  }
  function setDialogBusy(busy){const overlay=el('inventory-overlay');if(!overlay)return;overlay.setAttribute('aria-busy',String(busy));overlay.querySelectorAll('button,input,select,textarea').forEach(node=>{if(busy){node.dataset.wasDisabled=String(node.disabled);node.disabled=true;}else if('wasDisabled'in node.dataset){node.disabled=node.dataset.wasDisabled==='true';delete node.dataset.wasDisabled;}});}
  function showDialogError(message){const node=el('inv-dialog-error');if(node){node.hidden=false;node.textContent=message;node.scrollIntoView({block:'nearest'});}}
  function closeDialog(restore=true,force=false){if(state.saving&&!force)return;state.dialogToken++;el('inventory-overlay')?.remove();state.dialog=null;document.body.classList.remove('inventory-dialog-open');if(restore&&state.returnFocus?.isConnected)state.returnFocus.focus({preventScroll:true});state.returnFocus=null;}
  function openDialog(mode,extra={}){
    if(state.saving)return;const previous=state.returnFocus,focused=document.activeElement;closeDialog(false);state.returnFocus=focused?.isConnected?focused:previous;state.dialog={mode,...extra};renderDialog();
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
        body=`<div class="inv-detail-stat"><div><span class="inv-caption">${t('current')}</span><strong>${number(item.quantity)}</strong> <bdi>${esc(item.unit||t('unitmissing'))}</bdi></div>${pill(item)}</div>`+body;
        if(item.quantity==null||!item.unit)body+=`<p class="inv-review">${t('needsetup')}</p>`;
        submit=capable('manage');
      }
    }else if(['receive','use','reverse'].includes(mode)){
      body=`<div class="inv-detail-stat"><div><strong><bdi>${esc(itemName(item))}</bdi></strong><p class="inv-muted">${t('current')}: ${number(item.quantity)} <bdi>${esc(item.unit)}</bdi></p></div></div><div class="inv-form-grid">${mode!=='reverse'?field(t('quantity'),numeric('quantity',null,true)):''}${field(t('date'),input('date',today(),`type="date" required min="2000-01-01" max="${today()}"`))}${field(t('reference'),input('reference','','maxlength="160"'))}${field(t('reason'),`<textarea class="inv-control" name="reason" maxlength="1000" ${mode==='reverse'?'required':''}></textarea>`,true)}</div><div id="inv-balance-preview" class="inv-muted" aria-live="polite"></div>`;
    }else if(mode==='choose-receive'){
      title=t('receive');body=`<p class="inv-muted">${t('itemrequired')}</p><label class="inv-search">${icon('search')}<input id="inv-picker-search" type="search" maxlength="120" aria-label="${t('search')}" placeholder="${t('search')}"></label><div id="inv-picker-results" style="margin-top:16px"></div>`;submit=false;
    }else if(mode==='categories'){
      title=t('manage');submit=false;body=button('category-add',t('newcategory'),'folder-plus','inv-primary')+categories().filter(c=>c.active).map(c=>`<div class="inv-category-row"><div><strong>${esc(categoryName(c))}</strong><span class="inv-caption">${number(c.item_count)} ${t('items')}</span></div><div class="inv-actions">${button('category-edit',t('editcategory'),'pencil','',`data-category="${c.id}"`)}${button('category-archive',t('archivecategory'),'archive','',`data-category="${c.id}"`)}</div></div>`).join('');
    }else if(mode==='category_save'){
      title=t(dialog.category?'editcategory':'newcategory');const category=dialog.category||{};
      body=`<div class="inv-form-grid">${field(t('english'),input('name',category.name||'','required maxlength="80"'))}${field(t('arabic'),input('name_ar',category.name_ar||'','maxlength="80"'))}${!dialog.category?field(t('parent'),`<select name="parent_id" class="inv-control"><option value="">${t('notset')}</option>${categories().filter(c=>c.active&&!c.parent_id).map(c=>`<option value="${c.id}">${esc(categoryName(c))}</option>`).join('')}</select>`,true):''}</div>`;
    }else if(mode==='import'){
      wide=true;body=`<p class="inv-muted">${t('importhelp')}</p><div class="inv-form-grid" style="margin-top:16px">${field(t('file'),'<input class="inv-control" id="inv-import-file" type="file" accept=".csv,text/csv" required>')}${field(t('importdate'),input('date',today(),`type="date" required min="2000-01-01" max="${today()}"`)+`<span class="inv-caption">${t('countdatehelp')}</span>`)}</div><div id="inv-import-preview" class="inv-import-list"></div>`;
    }else if(mode==='category_archive'){
      title=t('archivecategory');body=`<p>${esc(t('archivecategorybody'))}</p>`;
    }else if(mode==='assign'){
      title=t('assign');body=`<p class="inv-muted">${number(state.selected.size)} ${t('selected')} · ${t('bulkhelp')}</p>${field(t('category'),`<select name="category_id" class="inv-control" required>${categoryOptions(dialog.category_id,false,false)}</select>`)}`;
    }
    const overlay=document.createElement('div');overlay.id='inventory-overlay';overlay.className='inv-overlay';overlay.setAttribute('role','presentation');
    overlay.innerHTML=`<section role="dialog" aria-modal="true" aria-labelledby="inv-dialog-title" class="inv-dialog ${wide?'inv-wide':''}"><div class="inv-dialog-header"><div><h3 id="inv-dialog-title">${esc(title)}</h3>${itemName(item)?`<p class="inv-muted"><bdi>${esc(itemName(item))}</bdi></p>`:''}</div><button type="button" class="inv-icon-button" data-inv-action="close" aria-label="${t('close')}">${icon('x')}</button></div><form id="inv-dialog-form" class="inv-form"><div class="inv-dialog-body">${body}<div id="inv-dialog-error" class="inv-error" role="alert" hidden></div></div><div class="inv-dialog-footer">${button('close',t(submit?'cancel':'close'),'x')}${submit?`<button type="submit" class="inv-button inv-primary" id="inv-dialog-submit">${icon('check')}<span>${t(mode==='import'?'import':mode==='category_archive'?'confirm':'save')}</span></button>`:''}</div></form></section>`;
    el('inventory-overlay')?.remove();document.body.appendChild(overlay);document.body.classList.add('inventory-dialog-open');
    if(mode==='edit'&&!capable('manage'))overlay.querySelectorAll('input,select,textarea').forEach(node=>node.disabled=true);
    if((mode==='add'||mode==='edit')&&!capable('adjust'))overlay.querySelector('input[name="quantity"]')?.setAttribute('disabled','');
    if(mode==='import')el('inv-dialog-submit').disabled=true;
    icons();requestAnimationFrame(()=>overlay.querySelector('input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled)')?.focus());
    if(mode==='choose-receive')void picker('');
  }
  async function openItem(id,mode='edit',movementId=''){
    const context=signature(),token=++state.dialogToken;
    try{const{data,error}=await db.rpc('get_inventory',{p_filters:{id,page:1,size:1}});if(context!==signature()||token!==state.dialogToken||!visible())return;if(error)throw error;let item=data.items?.find(row=>row.id===id);
      if(!item){state.error=errorText({message:'INVENTORY_ITEM'});render();return;}
      const cap=mode==='edit'?'view':mode==='receive'?'receive':mode==='use'?'use':'adjust';if(cap!=='view'&&!capable(cap))return;
      openDialog(mode,{item,movementId});
    }catch(error){if(context===signature()){state.error=errorText(error);render();}}
  }
  let pickerToken=0;
  async function picker(query){const token=++pickerToken,context=signature();try{const{data,error}=await db.rpc('get_inventory',{p_filters:{language:isArabic()?'ar':'en',query,page:1,size:20}});if(context!==signature()||token!==pickerToken||state.dialog?.mode!=='choose-receive')return;if(error)throw error;el('inv-picker-results').innerHTML=data.items.map(i=>`<div class="inv-category-row"><div><strong><bdi>${esc(itemName(i))}</bdi></strong><p class="inv-muted">${number(i.quantity)} <bdi>${esc(i.unit||t('unitmissing'))}</bdi></p></div>${button('receive-picked',t('receive'),'package-plus','',`data-id="${i.id}" ${i.quantity==null||!i.unit?'disabled':''}`)}${button('movement-item',t('details'),'sliders-horizontal','',`data-id="${i.id}"`)}</div>`).join('')||empty(t('nomatches'),t('nomatchesbody'));icons();}catch(error){if(token===pickerToken)showDialogError(errorText(error));}}
  async function previewImport(file){
    if(!file||state.dialog?.mode!=='import')return;const dialog=state.dialog,context=signature();el('inv-dialog-submit').disabled=true;
    try{if(file.size>1048576)throw new Error('INVENTORY_CSV_SIZE');const rows=model.parseCSV(await file.text(),categories());if(context!==signature()||state.dialog!==dialog)return;dialog.rows=rows;
      el('inv-import-preview').innerHTML=`<p class="inv-muted">${number(rows.length)} ${t('items')} · ${t('importready')}</p>`+rows.map((row,index)=>`<div class="inv-import-row"><div><bdi>${esc(itemName(row))}</bdi><span class="inv-caption">${esc(row.unit||t('unitmissing'))}</span></div>${field(t('category'),`<select class="inv-control" data-import-category="${index}">${categoryOptions(row.category_id,true)}</select>`)}<span><span class="inv-caption">${t('current')}</span><strong>${number(row.quantity)}</strong></span><span><span class="inv-caption">${t('minimum')}</span><strong>${number(row.minimum)}</strong></span></div>`).join('');
      el('inv-dialog-error').hidden=true;el('inv-dialog-submit').disabled=false;
    }catch(error){if(state.dialog===dialog){dialog.rows=null;showDialogError(errorText(error));}}
  }
  async function submit(event){
    event.preventDefault();if(state.saving||!state.dialog)return;const dialog=state.dialog,form=new FormData(event.target),mode=dialog.mode,item=dialog.item;let operation=mode,payload={};
    try{
      if(mode==='add'||mode==='edit'){
        if(!capable('manage'))return;operation='item_save';payload=Object.fromEntries(['name_en','name_ar','category_id','unit'].map(key=>[key,String(form.get(key)||'').trim()]));payload.minimum=model.numeric(form.get('minimum'));if(!payload.name_en&&!payload.name_ar)throw Error('INVENTORY_NAME');
        if(mode==='edit'){payload.id=item.id;payload.revision=item.revision;if(item.quantity!=null&&item.unit)payload.unit=item.unit;}
        if(mode==='add'||item.quantity==null&&capable('adjust')){payload.quantity=model.numeric(form.get('quantity'));payload.date=today();}
      }else if(['receive','use','reverse'].includes(mode)){
        payload={id:item.id,revision:item.revision,date:String(form.get('date')||''),reason:String(form.get('reason')||'').trim(),reference:String(form.get('reference')||'').trim()};if(mode==='reverse')payload.movement_id=dialog.movementId;else payload.quantity=model.numeric(form.get('quantity'));
      }else if(mode==='category_save'){
        payload={name:String(form.get('name')||'').trim(),name_ar:String(form.get('name_ar')||'').trim(),parent_id:String(form.get('parent_id')||'')};if(dialog.category){payload.id=dialog.category.id;payload.revision=dialog.category.revision;}
      }else if(mode==='category_archive'){payload={id:dialog.category.id,revision:dialog.category.revision};}
      else if(mode==='assign'){payload={category_id:String(form.get('category_id')||''),items:[...state.selected.values()].map(i=>({id:i.id,revision:i.revision}))};}
      else if(mode==='import'){if(!dialog.rows?.length)return;payload={date:String(form.get('date')||''),rows:dialog.rows};}
      else return;
      await write(operation,payload);
    }catch(error){showDialogError(errorText(error));}
  }
  async function exportCSV(){
    if(state.exporting||!allowed())return;state.exporting=true;render();const context=signature(),collected=[];
    try{for(let page=1;page<=1000;page++){const{data,error}=await db.rpc('get_inventory',{p_filters:{language:isArabic()?'ar':'en',query:state.query,category:state.category,status:state.status,sort:'name',page,size:100}});if(context!==signature())return;if(error)throw error;collected.push(...data.items);if(collected.length>=data.total||data.items.length===0)break;}
      const url=URL.createObjectURL(new Blob([model.csv(collected,categories())],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='lumin-inventory-'+today()+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){if(context===signature())state.error=errorText(error);}finally{if(context===signature()){state.exporting=false;render();}}
  }
  function filtersChanged(){clearTimeout(state.timer);state.page=1;state.selected.clear();state.message='';void refresh({force:true});}
  function action(event){
    const target=event.target.closest('[data-inv-action],[data-inv-category],[data-inv-status],[data-inv-item],[data-inv-stat]');if(!target||target.disabled)return;
    if(target.dataset.invCategory){state.category=target.dataset.invCategory;filtersChanged();return;}
    if(target.dataset.invStatus){state.status=target.dataset.invStatus;filtersChanged();return;}
    if(target.dataset.invItem){void openItem(target.dataset.invItem);return;}
    if(target.dataset.invStat){const key=target.dataset.invStat;if(key==='categories'){if(capable('manage'))openDialog('categories');return;}state.tab='stock';state.query='';state.category='all';state.status=key==='total'?'all':key;filtersChanged();return;}
    const name=target.dataset.invAction;
    if(name==='close'){closeDialog();return;}if(state.saving)return;
    if(name==='quick-receive'||name==='quick-use'){void quickStock(name==='quick-receive'?'receive':'use',target.dataset.id);return;}
    if(name==='retry-stock'){if(state.quickPending)void quickStock(state.quickPending.operation,state.quickPending.payload.id);return;}
    if(name==='refresh'){void refresh({force:true});if(state.tab==='history')void loadHistory();return;}
    if(name==='clear'){Object.assign(state,{query:'',category:'all',status:'all'});filtersChanged();return;}
    if(name==='unselect'){state.selected.clear();render();return;}
    if(name==='assign'){if(capable('manage')&&state.selected.size)openDialog('assign',{category_id:el('inv-bulk-category')?.value||''});return;}
    if(name==='stock'||name==='history'){state.tab=name;if(name==='history')void loadHistory();else render();return;}
    if(name==='stock-next'||name==='stock-previous'){state.page+=name.endsWith('next')?1:-1;void refresh({force:true});return;}
    if(name==='history-next'||name==='history-previous'){state.historyPage+=name.endsWith('next')?1:-1;void loadHistory();return;}
    if(name==='all-history'){state.historyItem='';state.historyPage=1;void loadHistory();return;}
    if(name==='history-apply'){state.historyKind=el('inv-history-kind').value;state.historyStart=el('inv-history-start').value;state.historyEnd=el('inv-history-end').value;state.historyQuery=el('inv-history-query').value;state.historyPage=1;void loadHistory();return;}
    if(name==='movement-item'){void openItem(target.dataset.id);return;}
    if(name==='reverse'){void openItem(target.dataset.id,'reverse',target.dataset.movement);return;}
    if(['receive','use','receive-picked'].includes(name)){void openItem(target.dataset.id,name==='receive-picked'?'receive':name);return;}
    if(name==='category-edit'||name==='category-archive'){if(capable('manage'))openDialog(name==='category-edit'?'category_save':'category_archive',{category:categories().find(c=>c.id===target.dataset.category)});return;}
    if(name==='category-add'){if(capable('manage'))openDialog('category_save');return;}
    if(name==='choose-receive'){if(capable('receive'))openDialog(name);return;}
    if(name==='add'||name==='import'||name==='categories'){if(capable('manage'))openDialog(name);return;}
    if(name==='export')void exportCSV();
  }
  function change(event){const node=event.target;
    if(node.id==='inv-mobile-category'){state.category=node.value;filtersChanged();}
    else if(node.id==='inv-sort'){state.sort=node.value;filtersChanged();}
    else if(node.dataset.invSelect){const row=state.report?.items.find(i=>i.id===node.dataset.invSelect);if(row){if(node.checked)state.selected.set(row.id,row);else state.selected.delete(row.id);render();}}
    else if(node.id==='inv-select-page'){for(const row of state.report?.items||[])if(node.checked)state.selected.set(row.id,row);else state.selected.delete(row.id);render();}
    else if(node.id==='inv-import-file')void previewImport(node.files[0]);
    else if(node.dataset.importCategory!=null&&state.dialog?.rows)state.dialog.rows[Number(node.dataset.importCategory)].category_id=node.value||null;
  }
  function permissionChanged(node){const group=node.closest('.inv-permissions');if(!group||node.tagName!=='INPUT')return;const view=group.querySelector('input[value="inventory"]');if(!view)return;if(node===view&&!view.checked)group.querySelectorAll('input').forEach(input=>{input.checked=false;});else if(node.checked&&model.permissions.some(p=>p.key===node.value))view.checked=true;}
  function inputChanged(event){const node=event.target;
    if(node.id==='inv-search'){state.query=node.value;state.page=1;state.selected.clear();state.token++;clearTimeout(state.timer);state.timer=setTimeout(()=>void refresh({force:true}),250);}
    if(node.id==='inv-picker-search'){clearTimeout(state.timer);const value=node.value;state.timer=setTimeout(()=>void picker(value),200);}
    if(node.name==='quantity'&&state.dialog?.item&&el('inv-balance-preview')){try{const qty=model.numeric(node.value),item=state.dialog.item;const after=qty==null?null:item.quantity==null?null:Number(item.quantity)+(state.dialog.mode==='receive'?qty:-qty);el('inv-balance-preview').textContent=`${t('before')} ${number(item.quantity)} → ${t('after')} ${number(after)} ${item.unit}`;}catch(_){el('inv-balance-preview').textContent='';}}
  }
  function keydown(event){const overlay=el('inventory-overlay');if(!overlay)return;if(event.key==='Escape'){event.preventDefault();closeDialog();return;}if(event.key==='Tab'){const nodes=Array.from(overlay.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')).filter(node=>node.getClientRects().length);if(!nodes.length)return;const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}}
  function init(){const root=el('view-inventory');if(!root||root.dataset.inventoryBound)return;root.dataset.inventoryBound='true';document.addEventListener('click',event=>{if(root.contains(event.target)||el('inventory-overlay')?.contains(event.target))action(event);if(event.target===el('inventory-overlay'))closeDialog();});document.addEventListener('change',event=>{permissionChanged(event.target);if(root.contains(event.target)||el('inventory-overlay')?.contains(event.target))change(event);});document.addEventListener('input',event=>{if(root.contains(event.target)||el('inventory-overlay')?.contains(event.target))inputChanged(event);});document.addEventListener('submit',event=>{if(event.target.id==='inv-dialog-form')void submit(event);});document.addEventListener('keydown',keydown);}
  function invalidate(){state.loadedAt=0;state.selected.clear();if(!allowed()){reset();return;}if(visible())void refresh({force:true});}
  function languageChanged(){const label=el('clinic-management-tab-inventory')?.querySelector('span');if(label)label.textContent=t('inventory');if(state.dialog)closeDialog();state.loadedAt=0;if(visible()){render();return refresh({force:true});}}
  function leave(){state.historyToken++;pickerToken++;closeDialog(false,true);}
  host.LuminInventory={init,refresh,reset,invalidate,languageChanged,loadHistory,leave,summary:()=>state.report?.summary||null};
  if(typeof document!=='undefined')document.addEventListener('DOMContentLoaded',init);
})(typeof window==='undefined'?globalThis:window);
