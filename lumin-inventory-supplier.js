/* Review a complete stock shortlist before creating a supplier capability link. */
(function(host){
  'use strict';
  let session=null;
  const model=()=>host.LuminSupplierListModel;
  const e=value=>model().escape(value);
  const t=(en,ar)=>session?.deps.arabic()?ar:en;
  const language=()=>session?.deps.arabic()?'ar':'en';
  const icon=name=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
  const button=(action,label,name,extra='',disabled=false,attrs='')=>`<button type="button" class="inv-button ${extra}" data-supplier-action="${action}" ${attrs} ${disabled?'disabled':''}>${icon(name)}<span>${e(label)}</span></button>`;
  const current=value=>session===value&&value.deps.allowed()&&value.context===value.deps.context();
  function close(force=false){if(!session||session.saving&&!force)return;const previous=session.focus;clearTimeout(session.searchTimer);session=null;document.getElementById('inventory-supplier-overlay')?.remove();document.body.classList.remove('inventory-supplier-open');if(previous?.isConnected)previous.focus({preventScroll:true});}
  function checkAccess(){if(session&&!current(session))close(true);}
  function selected(){return session.items.filter(item=>!session.removed.has(item.id));}
  function paintPhoto(s,item){
    if(!current(s))return;const photo=document.querySelector(`[data-supplier-thumb="${item.id}"]`);if(!photo)return;
    const source=model().thumbnail(s.thumbnails.get(item.id));photo.classList.toggle('inv-supplier-thumb-loading',Boolean(item.image_version&&!source&&!s.photoErrors.has(item.id)));
    if(source){const image=document.createElement('img');image.src=source;image.alt=model().name(item,language());image.width=image.height=44;photo.replaceChildren(image);}
  }
  async function loadPhotos(s){
    if(s.photoRead)return s.photoRead;
    const queue=s.items.filter(item=>item.image_version&&!s.thumbnails.has(item.id));
    const run=async()=>{while(queue.length&&current(s)){const item=queue.shift();try{const photo=await host.LuminInventoryImages.thumbnail(item);if(current(s)){s.thumbnails.set(item.id,photo);s.photoErrors.delete(item.id);}}catch(_){if(current(s))s.photoErrors.add(item.id);}paintPhoto(s,item);}};
    s.photoRead=Promise.all(Array.from({length:Math.min(4,queue.length)},run));
    try{await s.photoRead;}finally{s.photoRead=null;}
  }
  function supplierUrl(token){
    if(!/^[a-f0-9]{64}$/.test(token||''))throw Error('invalid');
    const url=new URL('supplier-list.html',location.href);url.hash='';url.search='';url.searchParams.set('s',token);return url.href;
  }
  function date(value){
    const parsed=new Date(value);return Number.isFinite(parsed.getTime())?new Intl.DateTimeFormat(language()==='ar'?'ar-EG':'en-GB',{dateStyle:'medium',timeZone:'Africa/Cairo'}).format(parsed):'—';
  }
  function libraryBody(s){
    const rows=s.report?.items||[],total=s.report?.total||0,filtered=Boolean(s.query||s.status!=='all');
    const filters=`<div class="inv-supplier-library-tools"><label class="inv-field"><span>${t('Search saved lists','البحث في القوائم المحفوظة')}</span><input type="search" name="supplier-search" maxlength="120" class="inv-control" value="${e(s.query)}" placeholder="${t('List name or reference','اسم القائمة أو رقمها')}"></label><label class="inv-field"><span>${t('Link status','حالة الرابط')}</span><select name="supplier-status" class="inv-control">${[['all','All lists','كل القوائم'],['active','Active links','الروابط السارية'],['expired','Expired links','الروابط المنتهية']].map(([key,en,ar])=>`<option value="${key}" ${s.status===key?'selected':''}>${t(en,ar)}</option>`).join('')}</select></label><label class="inv-field"><span>${t('Order by','ترتيب حسب')}</span><select name="supplier-sort" class="inv-control">${[['newest','Recently updated','آخر تحديث'],['oldest','Oldest first','الأقدم أولاً'],['name','List name','اسم القائمة']].map(([key,en,ar])=>`<option value="${key}" ${s.sort===key?'selected':''}>${t(en,ar)}</option>`).join('')}</select></label></div>`;
    let content='';
    if(s.busy)content=`<div class="inv-supplier-library-loading" role="status" aria-label="${t('Loading supplier lists','جار تحميل قوائم الموردين')}"><div class="inv-skeleton"></div><div class="inv-skeleton"></div><div class="inv-skeleton"></div></div>`;
    else if(s.error)content=`<div class="inv-empty inv-supplier-empty">${icon('wifi-off')}<h4>${t('Could not load saved lists','تعذر تحميل القوائم المحفوظة')}</h4>${button('retry-library',t('Try again','حاول مجدداً'),'refresh-cw')}</div>`;
    else if(!rows.length)content=`<div class="inv-empty inv-supplier-empty">${icon('clipboard-list')}<h4>${filtered?t('No matching lists','لا توجد قوائم مطابقة'):t('No supplier lists yet','لا توجد قوائم موردين بعد')}</h4><p>${filtered?t('Try another name or link status.','جرّب اسماً أو حالة رابط أخرى.'):t('Create a list from low or out-of-stock items. Saved lists will be arranged here.','أنشئ قائمة من الأصناف المنخفضة أو النافدة. ستجد قوائمك المحفوظة مرتبة هنا.')}</p>${button(filtered?'clear-library':'start',filtered?t('Clear filters','مسح عوامل التصفية'):t('Create supplier list','إنشاء قائمة المورد'),filtered?'filter-x':'list-plus','inv-primary')}</div>`;
    else content=`<p class="inv-caption" role="status">${new Intl.NumberFormat(language()).format(total)} ${t('saved lists','قوائم محفوظة')}</p><div class="inv-supplier-library-list">${rows.map(row=>{
      const expired=Date.parse(row.expires_at)<=Date.now();
      return `<article class="inv-supplier-saved" data-supplier-list="${e(row.id)}"><div class="inv-supplier-saved-heading"><span class="inv-supplier-saved-icon">${icon('clipboard-list')}</span><div><h4><bdi>${e(row.name||row.reference)}</bdi></h4><p class="inv-caption"><bdi>${e(row.reference)}</bdi> · ${new Intl.NumberFormat(language()).format(row.item_count)} ${t('items','أصناف')}</p></div><span class="inv-pill ${expired?'inv-amber':'inv-green'}">${expired?t('Expired','منتهي'):t('Active','ساري')}</span></div><dl class="inv-supplier-saved-dates"><div><dt>${t('Created','تاريخ الإنشاء')}</dt><dd>${e(date(row.created_at))}</dd></div><div><dt>${t('Updated','آخر تحديث')}</dt><dd>${e(date(row.updated_at))}</dd></div><div><dt>${t('Link expires','انتهاء الرابط')}</dt><dd>${e(date(row.expires_at))}</dd></div></dl><div class="inv-supplier-saved-actions">${button('edit-saved',t('Edit list','تعديل القائمة'),'pencil','',false,`data-id="${e(row.id)}"`)}${button('share-saved',t('Share link','مشاركة الرابط'),'share-2','',expired,`data-id="${e(row.id)}"`)}${button('delete-saved',t('Delete list','حذف القائمة'),'trash-2','inv-danger',false,`data-id="${e(row.id)}"`)}</div></article>`;
    }).join('')}</div>${total>20?`<div class="inv-supplier-library-pages">${button('library-prev',t('Previous','السابق'),'chevron-left','',s.page<=1)}<span>${s.page} / ${Math.ceil(total/20)}</span>${button('library-next',t('Next','التالي'),'chevron-right','',s.page*20>=total)}</div>`:''}`;
    return `<p class="inv-supplier-intro">${t('Find, edit and share your saved supplier lists. Edits update the existing link.','ابحث عن قوائم الموردين المحفوظة وعدّلها وشاركها. تُحدّث التعديلات الرابط الحالي.')}</p>${filters}${s.notice?`<p class="inv-status" role="status">${e(s.notice)}</p>`:''}${content}`;
  }
  async function loadLibrary(){
    const s=session;if(!s||s.saving)return;clearTimeout(s.searchTimer);s.step='library';s.editing=false;s.fromLibrary=true;
    const token=++s.libraryToken;s.busy=true;s.error='';render();
    try{
      const {data,error}=await s.deps.db.rpc('get_inventory_supplier_lists',{p_query:s.query,p_status:s.status,p_sort:s.sort,p_page:s.page,p_size:20});
      if(!current(s)||token!==s.libraryToken||s.step!=='library')return;if(error)throw error;
      if(!Array.isArray(data?.items)||!Number.isFinite(data.total))throw Error('invalid');s.report=data;
      if(!data.items.length&&data.total>0&&s.page>1){s.page=Math.ceil(data.total/20);s.busy=false;await loadLibrary();return;}
    }catch(_){if(current(s)&&token===s.libraryToken)s.error=t('Could not load supplier lists. Please try again.','تعذر تحميل قوائم الموردين. حاول مجدداً.');}
    finally{if(current(s)&&token===s.libraryToken){s.busy=false;render();}else checkAccess();}
  }
  async function openSavedDocument(id,mode){
    const s=session;if(!s||s.busy)return;clearTimeout(s.searchTimer);s.busy=true;s.error='';render();
    try{
      const {data,error}=await s.deps.db.rpc('get_inventory_supplier_list',{p_id:id});if(!current(s))return;if(error)throw error;
      if(!Array.isArray(data?.items)||!data.id||!Number.isFinite(data.revision))throw Error('invalid');
      s.document=data;s.saved=data;s.requestId=null;s.notice='';s.fromLibrary=true;
      if(mode==='share-saved'){s.url=supplierUrl(data.token);s.step='share';}
      else if(mode==='delete-saved')s.step='delete';
      else{
        s.editing=true;s.step='review';s.listName=data.name||'';s.removed=new Set();s.photoErrors=new Set();
        s.items=data.items.map((item,index)=>({...item,id:String(index+1)}));
        s.quantities=new Map(s.items.map(item=>[item.id,item.requested_quantity??1]));
        s.thumbnails=new Map(s.items.map(item=>[item.id,model().thumbnail(item.image_data_url)]));
      }
    }catch(_){if(current(s))s.error=t('This list could not be opened. Refresh the saved lists and try again.','تعذر فتح هذه القائمة. حدّث القوائم المحفوظة وحاول مجدداً.');}
    finally{if(current(s)){s.busy=false;render();document.getElementById('supplier-dialog-title')?.focus();}else checkAccess();}
  }
  function writeError(error){
    if(/INVENTORY_SUPPLIER_STALE/.test(error?.message||''))return t('This list changed in another session. Cancel and reopen it before saving.','تغيرت هذه القائمة في جلسة أخرى. ألغِ العملية وأعد فتحها قبل الحفظ.');
    if(/INVENTORY_SUPPLIER_MISSING/.test(error?.message||''))return t('This list was deleted. Return to the saved lists.','تم حذف هذه القائمة. ارجع إلى القوائم المحفوظة.');
    return t('Could not save the change. Your edits are kept; try again.','تعذر حفظ التغيير. تم الاحتفاظ بتعديلاتك؛ حاول مجدداً.');
  }
  async function saveEdited(){
    const s=session;if(!s||!s.editing||s.busy||!selected().length)return;
    const name=document.querySelector('[name="supplier-list-name"]');if(!name.reportValidity())return;s.listName=name.value;
    for(const input of document.querySelectorAll('#inventory-supplier-overlay [name="supplier-quantity"]')){
      const value=Number(input.value);input.setCustomValidity(Number.isInteger(value)&&value>=1&&value<=1000000?'':t('Enter a whole quantity from 1 to 1,000,000.','أدخل كمية صحيحة من ١ إلى ١٬٠٠٠٬٠٠٠.'));if(!input.reportValidity())return;
    }
    s.requestId ||= s.deps.uuid();s.busy=true;s.saving=true;s.error='';render();let saved=false;
    try{
      const {error}=await s.deps.db.rpc('save_inventory_supplier_list',{p_id:s.document.id,p_revision:s.document.revision,p_name:s.listName,p_items:selected().map(item=>({position:Number(item.id),requested_quantity:Number(s.quantities.get(item.id)??1)})),p_request_id:s.requestId});
      if(!current(s))return;if(error)throw error;saved=true;s.notice=t('Supplier list updated. The shared link now shows your changes.','تم تحديث قائمة المورد. يعرض الرابط المشترك تعديلاتك الآن.');
    }catch(error){if(current(s))s.error=writeError(error);}
    finally{if(current(s)){s.busy=false;s.saving=false;if(saved)await loadLibrary();else render();document.getElementById('supplier-dialog-title')?.focus();}else checkAccess();}
  }
  async function deleteSaved(){
    const s=session;if(!s||s.step!=='delete'||s.busy)return;s.requestId ||= s.deps.uuid();s.busy=true;s.saving=true;s.error='';render();let deleted=false;
    try{
      const {error}=await s.deps.db.rpc('delete_inventory_supplier_list',{p_id:s.document.id,p_revision:s.document.revision,p_request_id:s.requestId});
      if(!current(s))return;if(error)throw error;deleted=true;s.notice=t('Supplier list deleted. Its shared link is no longer available.','تم حذف قائمة المورد. لم يعد رابطها المشترك متاحاً.');
    }catch(error){if(current(s))s.error=writeError(error);}
    finally{if(current(s)){s.busy=false;s.saving=false;if(deleted)await loadLibrary();else render();document.getElementById('supplier-dialog-title')?.focus();}else checkAccess();}
  }
  function render(){
    if(!session)return;if(!current(session)){close(true);return;}
    const s=session,overlay=document.getElementById('inventory-supplier-overlay'),active=document.activeElement?.dataset.supplierAction;
    const focusWasInside=overlay.contains(document.activeElement);
    const field=document.activeElement?.name,caret=document.activeElement?.selectionStart;
    const title=s.step==='library'?t('Supplier lists','قوائم الموردين'):s.step==='delete'?t('Delete supplier list','حذف قائمة المورد'):s.step==='scope'?t('Create supplier list','إنشاء قائمة المورد'):s.step==='share'?t('Supplier page is ready','صفحة المورد جاهزة'):s.editing?t('Edit supplier list','تعديل قائمة المورد'):t('Review supplier list','مراجعة قائمة المورد');
    let body='',footer='';
    if(s.step==='library'){
      body=libraryBody(s);
      footer=button('close',t('Done','تم'),'check')+button('start',t('Create supplier list','إنشاء قائمة المورد'),'list-plus','inv-primary',s.busy);
    }else if(s.step==='delete'){
      body=`<div class="inv-supplier-delete">${icon('trash-2')}<h4><bdi>${e(s.document.name||s.document.reference)}</bdi></h4><p>${t('Delete this saved list? Its shared link will stop working. Inventory stock will stay as it is.','هل تريد حذف هذه القائمة المحفوظة؟ سيتوقف رابطها المشترك عن العمل، وتبقى كميات المخزون كما هي.')}</p></div>`;
      footer=button('library',t('Cancel','إلغاء'),'x','',s.saving)+button('confirm-delete',t('Delete list','حذف القائمة'),'trash-2','inv-danger',s.saving);
    }else if(s.step==='scope'){
      body=`<p class="inv-supplier-intro">${t('Choose which items to include. You can remove items before creating the page.','اختر الأصناف المراد تضمينها. يمكنك إزالة أصناف قبل إنشاء الصفحة.')}</p><fieldset class="inv-supplier-options"><legend class="inv-visually-hidden">${t('Stock status','حالة المخزون')}</legend>${[['out','Out of stock only','الأصناف النافدة فقط','Recorded quantity is zero.','الأصناف التي كميتها المسجلة صفر.'],['low','Low stock only','المخزون المنخفض فقط','Above zero and at or below the minimum.','الكمية أكبر من صفر وعند الحد الأدنى أو أقل.'],['both','Low & out of stock','المخزون المنخفض والنافد','All items that need restocking.','كل الأصناف التي تحتاج إلى إعادة توفير.']].map(([value,en,ar,help,helpAr])=>`<label class="inv-supplier-option"><input type="radio" name="supplier-scope" value="${value}" ${s.scope===value?'checked':''}><span><strong>${t(en,ar)}</strong><small>${t(help,helpAr)}</small></span></label>`).join('')}</fieldset>`;
      footer=button(s.fromLibrary?'library':'close',t('Cancel','إلغاء'),'x')+button('review',t('Review items','مراجعة الأصناف'),'list-checks','inv-primary',s.busy);
    }else if(s.step==='review'){
      const items=selected(),locale=language(),format=value=>value==null?'—':new Intl.NumberFormat(locale,{maximumFractionDigits:3}).format(value);
      const editName=s.editing?`<label class="inv-field inv-supplier-name"><span>${t('List name','اسم القائمة')}</span><input name="supplier-list-name" class="inv-control" maxlength="120" value="${e(s.listName)}" placeholder="${e(s.document.reference)}"></label>`:'';
      body=s.busy&&!s.saving?`<p class="inv-supplier-intro" role="status">${t('Loading all matching items…','جار تحميل كل الأصناف المطابقة…')}</p><div class="inv-skeleton"></div><div class="inv-skeleton"></div><div class="inv-skeleton"></div>`:`<p class="inv-supplier-intro">${s.editing?t('Update the name, quantities or included items. Saving updates the existing shared link.','عدّل الاسم أو الكميات أو الأصناف المدرجة. يؤدي الحفظ إلى تحديث الرابط المشترك الحالي.'):t('Remove anything you do not need. Only the remaining items will appear on the supplier page.','أزل ما لا تحتاجه. ستظهر الأصناف المتبقية فقط في صفحة المورد.')}</p>${editName}<div class="inv-supplier-summary" role="status">${format(items.length)} ${t('items selected','أصناف محددة')}${s.removed.size?button('restore',t('Restore removed items','استعادة الأصناف المزالة'),'rotate-ccw'):''}</div>${items.length?model().groups(items,locale).map(group=>`<section class="inv-supplier-group"><h4>${icon('folder-open')}<bdi>${e(group.label)}</bdi></h4><ul>${group.items.map(item=>`<li data-supplier-item="${e(item.id)}"><div><strong><bdi>${e(model().name(item,locale))}</bdi></strong><small>${s.editing?e(model().unit(item.unit,locale)||'—'):`${t('Stock','المخزون')}: ${format(item.quantity)} · ${t('Minimum','الحد الأدنى')}: ${format(item.minimum)}${item.unit?' · '+e(model().unit(item.unit,locale)):''}`}</small></div><button type="button" class="inv-icon-button inv-supplier-remove" data-supplier-action="remove" data-id="${e(item.id)}" aria-label="${e(t('Remove from list','إزالة من القائمة')+': '+model().name(item,locale))}">${icon('x')}</button></li>`).join('')}</ul></section>`).join(''):`<div class="inv-empty inv-supplier-empty">${icon('package-check')}<h4>${t('No items to include','لا توجد أصناف لتضمينها')}</h4><p>${s.removed.size?t('Restore items or choose another stock status.','استعد الأصناف أو اختر حالة مخزون أخرى.'):t('There are no matching items. Choose another stock status.','لا توجد أصناف مطابقة. اختر حالة مخزون أخرى.')}</p>${button(s.removed.size?'restore':'back',s.removed.size?t('Restore items','استعادة الأصناف'):t('Choose stock status','اختيار حالة المخزون'),'arrow-left')}</div>`}<p class="inv-caption">${s.editing?t('The saved item names, units and photos are kept. The link expiry date stays the same.','تُحفظ أسماء الأصناف ووحداتها وصورها. يبقى تاريخ انتهاء صلاحية الرابط كما هو.'):t('The shared page shows names, stock units and main categories. It is a saved list, valid for 30 days.','تُظهر الصفحة المشتركة الأسماء ووحدات المخزون والتصنيفات الرئيسية. وهي قائمة محفوظة صالحة لمدة ٣٠ يوماً.')}</p>`;
      footer=button(s.editing?'library':'back',s.editing?t('Cancel','إلغاء'):t('Back','رجوع'),'arrow-left','',s.busy)+button(s.editing?'save-edit':'create',s.editing?t('Save changes','حفظ التغييرات'):t('Create supplier page','إنشاء صفحة المورد'),s.editing?'save':'file-plus-2','inv-primary',s.busy||!items.length);
    }else{
      body=`<div class="inv-supplier-ready">${icon('circle-check')}<h4>${t('Ready to share with your supplier','جاهزة للمشاركة مع المورد')}</h4><p>${t('This page contains only the items you reviewed. The link expires on','تحتوي هذه الصفحة على الأصناف التي راجعتها فقط. تنتهي صلاحية الرابط في')} ${e(LuminDates.format(s.saved.expires_at))}</p></div><label class="inv-field"><span>${t('Supplier page link','رابط صفحة المورد')}</span><input class="inv-control inv-supplier-link" readonly dir="ltr" value="${e(s.url)}" aria-label="${t('Supplier page link','رابط صفحة المورد')}"></label><div class="inv-supplier-share-actions">${button('copy',t('Copy link','نسخ الرابط'),'copy','inv-primary')}<a class="inv-button" href="${e(s.url)}" target="_blank" rel="noopener noreferrer">${icon('external-link')}<span>${t('Open page','فتح الصفحة')}</span></a>${navigator.share?button('share',t('Share','مشاركة'),'share-2'):''}</div><p class="inv-caption" role="status" data-supplier-notice>${e(s.notice||'')}</p>`;
      footer=button(s.fromLibrary?'library':'close',t('Done','تم'),'check');
    }
    overlay.innerHTML=`<section class="inv-dialog inv-supplier-dialog" role="dialog" aria-modal="true" aria-labelledby="supplier-dialog-title" aria-busy="${s.busy}" dir="${language()==='ar'?'rtl':'ltr'}"><div class="inv-dialog-header"><h3 id="supplier-dialog-title" tabindex="-1">${title}</h3><button type="button" class="inv-icon-button" data-supplier-action="close" aria-label="${t('Close','إغلاق')}" ${s.saving?'disabled':''}>${icon('x')}</button></div><div class="inv-dialog-body">${body}<p class="inv-error" role="alert" ${s.error?'':'hidden'}>${e(s.error)}</p></div><div class="inv-dialog-footer">${footer}</div></section>`;
    if(s.step==='review')for(const row of overlay.querySelectorAll('[data-supplier-item]')){
      const item=s.items.find(item=>item.id===row.dataset.supplierItem),value=s.quantities.get(item.id)??1,label=t('Quantity wanted','الكمية المطلوبة'),itemLabel=label+': '+model().name(item,language());
      const heading=document.createElement('div');heading.className='inv-supplier-item-heading';const photo=document.createElement('span');photo.className='inv-supplier-thumb';photo.dataset.supplierThumb=item.id;photo.innerHTML=icon('image');heading.appendChild(photo);heading.appendChild(row.querySelector('strong'));row.firstElementChild.prepend(heading);paintPhoto(s,item);
      const control=document.createElement('div');control.className='inv-supplier-wanted';
      control.innerHTML=`<span>${label}</span><span class="inv-supplier-stepper" dir="ltr" role="group" aria-label="${e(itemLabel)}"><button type="button" class="inv-icon-button" data-supplier-action="wanted-minus" data-id="${e(item.id)}" aria-label="${e(t('Decrease quantity wanted','تقليل الكمية المطلوبة')+': '+model().name(item,language()))}" ${Number(value)<=1?'disabled':''}>${icon('minus')}</button><input name="supplier-quantity" type="number" inputmode="numeric" min="1" max="1000000" step="1" value="${e(value)}" data-id="${e(item.id)}" aria-label="${e(itemLabel)}" required><button type="button" class="inv-icon-button" data-supplier-action="wanted-plus" data-id="${e(item.id)}" aria-label="${e(t('Increase quantity wanted','زيادة الكمية المطلوبة')+': '+model().name(item,language()))}" ${Number(value)>=1000000?'disabled':''}>${icon('plus')}</button></span>`;
      row.firstElementChild.appendChild(control);
    }
    if(s.saving)overlay.querySelectorAll('button,input').forEach(node=>node.disabled=true);
    if(s.saving){const label=overlay.querySelector('[data-supplier-action="create"] span,[data-supplier-action="save-edit"] span,[data-supplier-action="confirm-delete"] span');if(label)label.textContent=t('Saving…','جار الحفظ…');}
    if(host.lucide)host.lucide.createIcons();
    if(active)overlay.querySelector(`[data-supplier-action="${active}"]:not(:disabled)`)?.focus({preventScroll:true});
    if(field==='supplier-search'){const search=overlay.querySelector('[name="supplier-search"]');if(search){search.focus({preventScroll:true});if(caret!=null)search.setSelectionRange(caret,caret);}}
    if(focusWasInside&&!overlay.contains(document.activeElement))document.getElementById('supplier-dialog-title')?.focus({preventScroll:true});
  }
  async function review(){
    const s=session;if(!s||s.busy)return;s.step='review';s.items=[];s.removed.clear();s.thumbnails.clear();s.photoErrors.clear();s.busy=true;s.error='';render();
    try{const {data,error}=await s.deps.db.rpc('get_inventory_supplier_candidates',{p_scope:s.scope});if(!current(s))return;if(error)throw error;if(!Array.isArray(data))throw Error('invalid');s.items=data;s.quantities=new Map(data.map(item=>[item.id,1]));}
    catch(_){if(current(s))s.error=t('Could not load the items. Go back and try again.','تعذر تحميل الأصناف. ارجع وحاول مجدداً.');}
    finally{if(current(s)){s.busy=false;render();if(!s.error)void loadPhotos(s);document.getElementById('supplier-dialog-title')?.focus();}else checkAccess();}
  }
  async function create(){
    const s=session;if(!s||s.busy||!selected().length)return;
    for(const input of document.querySelectorAll('#inventory-supplier-overlay [name="supplier-quantity"]')){
      const value=Number(input.value);input.setCustomValidity(Number.isInteger(value)&&value>=1&&value<=1000000?'':t('Enter a whole quantity from 1 to 1,000,000.','أدخل كمية صحيحة من ١ إلى ١٬٠٠٠٬٠٠٠.'));if(!input.reportValidity())return;
    }
    s.requestId ||= s.deps.uuid();s.busy=true;s.saving=true;s.error='';render();
    try{
      await loadPhotos(s);if(!current(s))return;if(selected().some(item=>item.image_version&&!s.thumbnails.has(item.id)))throw Error('SUPPLIER_PHOTO');
      const {data,error}=await s.deps.db.rpc('create_inventory_supplier_list',{p_scope:s.scope,p_items:selected().map(item=>({id:item.id,revision:item.revision,requested_quantity:Number(s.quantities.get(item.id)??1),image_version:item.image_version||null,image_data_url:s.thumbnails.get(item.id)||''})),p_request_id:s.requestId,p_language:language()});
      if(!current(s))return;if(error)throw error;if(!/^[a-f0-9]{64}$/.test(data?.token)||!Number.isFinite(Date.parse(data.expires_at)))throw Error('invalid');
      s.saved=data;s.url=supplierUrl(data.token);s.step='share';
    }catch(error){if(current(s))s.error=/SUPPLIER_PHOTO/.test(error?.message||'')?t('Some item photos could not load. Try again to include them.','تعذر تحميل بعض صور الأصناف. حاول مجدداً لتضمينها.'):/INVENTORY_SUPPLIER_STALE/.test(error?.message||'')?t('Stock or photos changed since your review. Go back and review the items again.','تغير المخزون أو الصور منذ المراجعة. ارجع وراجع الأصناف مرة أخرى.'):t('Could not create the page. Your selection is kept; try again.','تعذر إنشاء الصفحة. تم الاحتفاظ باختيارك؛ حاول مجدداً.');}
    finally{if(current(s)){s.busy=false;s.saving=false;render();document.getElementById('supplier-dialog-title')?.focus();}else checkAccess();}
  }
  async function action(event){
    const target=event.target.closest('[data-supplier-action]');if(!target||target.disabled||!session)return;checkAccess();if(!session)return;const s=session,name=target.dataset.supplierAction;
    if(name==='close'){close();return;}
    if(name==='library'&&!s.saving){await loadLibrary();return;}
    if(s.busy)return;
    if(name==='start'){s.step='scope';s.editing=false;s.fromLibrary=true;s.error='';s.notice='';s.requestId=null;render();document.getElementById('supplier-dialog-title')?.focus();return;}
    if(name==='retry-library'){await loadLibrary();return;}
    if(name==='clear-library'){s.query='';s.status='all';s.page=1;await loadLibrary();return;}
    if(name==='library-prev'||name==='library-next'){s.page+=name==='library-next'?1:-1;await loadLibrary();return;}
    if(['edit-saved','share-saved','delete-saved'].includes(name)){await openSavedDocument(target.dataset.id,name);return;}
    if(name==='save-edit'){await saveEdited();return;}
    if(name==='confirm-delete'){await deleteSaved();return;}
    if(name==='back'){s.step='scope';s.error='';s.requestId=null;render();return;}
    if(name==='review'){await review();return;}if(name==='create'){await create();return;}
    if(name==='wanted-plus'||name==='wanted-minus'){
      const id=target.dataset.id,value=Number(s.quantities.get(id)??1),next=Math.max(1,Math.min(1000000,(Number.isFinite(value)?Math.trunc(value):1)+(name==='wanted-plus'?1:-1)));
      s.quantities.set(id,next);s.requestId=null;const group=target.closest('.inv-supplier-stepper'),input=group.querySelector('input');input.value=next;input.setCustomValidity('');group.querySelector('[data-supplier-action="wanted-minus"]').disabled=next<=1;group.querySelector('[data-supplier-action="wanted-plus"]').disabled=next>=1000000;return;
    }
    if(name==='remove'||name==='restore'){const body=document.querySelector('#inventory-supplier-overlay .inv-dialog-body'),scroll=body.scrollTop;const ids=selected().map(item=>item.id),index=ids.indexOf(target.dataset.id);if(name==='remove')s.removed.add(target.dataset.id);else s.removed.clear();s.requestId=null;render();bodyReplaceScroll(scroll);const next=ids[index+1]||ids[index-1];(document.querySelector(`[data-supplier-item="${next}"] button`)||document.querySelector('[data-supplier-action="restore"]')||document.querySelector('[data-supplier-action="back"]'))?.focus({preventScroll:true});return;}
    if(name==='copy'||name==='share')try{
      if(name==='share'){await navigator.share({title:t('Supplier list','قائمة المورد'),url:s.url});return;}
      await navigator.clipboard.writeText(s.url);if(current(s)){s.notice=t('Link copied','تم نسخ الرابط');document.querySelector('[data-supplier-notice]').textContent=s.notice;}
    }catch(error){if(name==='copy'&&current(s)){const input=document.querySelector('.inv-supplier-link');input.focus();input.select();s.notice=t('Select and copy the link above.','حدد الرابط أعلاه وانسخه.');document.querySelector('[data-supplier-notice]').textContent=s.notice;}else if(error.name!=='AbortError'&&current(s)){document.querySelector('[data-supplier-notice]').textContent=t('Use Copy link to share the page.','استخدم نسخ الرابط لمشاركة الصفحة.');}}
  }
  function bodyReplaceScroll(scroll){const body=document.querySelector('#inventory-supplier-overlay .inv-dialog-body');if(body)body.scrollTop=scroll;}
  function open(deps,view='scope'){
    if(!deps.allowed()||session)return;
    session={deps,context:deps.context(),focus:document.activeElement,step:view,fromLibrary:view==='library',editing:false,page:1,query:'',status:'all',sort:'newest',libraryToken:0,report:null,scope:'both',items:[],removed:new Set(),quantities:new Map(),thumbnails:new Map(),photoErrors:new Set(),photoRead:null,busy:false,saving:false,error:''};
    const overlay=document.createElement('div');overlay.id='inventory-supplier-overlay';overlay.className='inv-overlay';document.body.appendChild(overlay);document.body.classList.add('inventory-supplier-open');
    overlay.addEventListener('click',event=>{if(event.target===overlay)close();else void action(event);});
    overlay.addEventListener('change',event=>{if(!session||session.saving)return;if(event.target.name==='supplier-scope')session.scope=event.target.value;if(event.target.name==='supplier-status'||event.target.name==='supplier-sort'){session[event.target.name==='supplier-status'?'status':'sort']=event.target.value;session.page=1;void loadLibrary();}});
    overlay.addEventListener('input',event=>{if(!session||session.saving)return;if(event.target.name==='supplier-search'){session.query=event.target.value;session.page=1;clearTimeout(session.searchTimer);session.searchTimer=setTimeout(()=>{if(session?.step==='library')void loadLibrary();},250);}if(event.target.name==='supplier-list-name'){session.listName=event.target.value;session.requestId=null;}if(event.target.name==='supplier-quantity'&&session){const input=event.target,value=Number(input.value),group=input.closest('.inv-supplier-stepper');session.quantities.set(input.dataset.id,input.value);session.requestId=null;input.setCustomValidity('');group.querySelector('[data-supplier-action="wanted-minus"]').disabled=value<=1;group.querySelector('[data-supplier-action="wanted-plus"]').disabled=value>=1000000;}});
    overlay.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}if(event.key==='Tab'){const nodes=[...overlay.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')].filter(node=>node.getClientRects().length);if(!nodes.length){event.preventDefault();document.getElementById('supplier-dialog-title')?.focus();return;}const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}});
    render();document.getElementById('supplier-dialog-title')?.focus();if(view==='library')void loadLibrary();
  }
  host.LuminInventorySupplier={open,openSaved:deps=>open(deps,'library'),close,checkAccess,hasPendingWrites:()=>Boolean(session?.saving)};
})(window);
