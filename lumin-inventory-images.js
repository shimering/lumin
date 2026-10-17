/* Private inventory photos. Only optimized bytes leave the browser. */
(function(host){
  'use strict';
  const limit=300*1024,records=new Map(),cache=new Map(),pending=new Map(),busy=new Set(),errors=new Map(),loading=new Map();
  let config=null,generation=0,observer=null;
  const words={add:['Add image','إضافة صورة'],change:['Change image','تغيير الصورة'],remove:['Remove image','إزالة الصورة'],empty:['No image added','لم تتم إضافة صورة'],saving:['Optimizing and saving…','جار تحسين الصورة وحفظها…'],retry:['Retry photo','إعادة محاولة الصورة'],load:['Load image','تحميل الصورة'],failed:['Photo unavailable. Try again.','الصورة غير متاحة. حاول مجدداً.'],saved:['Photo saved','تم حفظ الصورة'],image_size:['Choose an image smaller than 15 MB.','اختر صورة أصغر من ١٥ ميجابايت.'],image_format:['Choose a JPEG, PNG or WebP image.','اختر صورة JPEG أو PNG أو WebP.'],image_changed:['This photo changed. Refresh inventory and try again.','تم تغيير الصورة. حدّث المخزون وحاول مجدداً.'],invalid_session:['Sign in again to access photos.','سجل الدخول مجدداً للوصول إلى الصور.'],access_denied:['You do not have permission to change this photo.','ليست لديك صلاحية تغيير هذه الصورة.'],drive_not_connected:['Connect Google Drive in settings first.','اربط Google Drive من الإعدادات أولاً.'],saveFailed:['Could not save the photo. Retry to confirm it safely.','تعذر حفظ الصورة. أعد المحاولة لتأكيد حفظها بأمان.']};
  Object.assign(words,{paste:['Paste image','لصق صورة'],paste_hint:['Paste an image here with Ctrl+V or ⌘V.','الصق صورة هنا باستخدام Ctrl+V أو ⌘V.'],clipboard_empty:['Copy an image first, then paste it here.','انسخ صورة أولاً، ثم الصقها هنا.'],clipboard_denied:['Allow clipboard access, or use Ctrl+V / ⌘V here.','اسمح بالوصول إلى الحافظة، أو استخدم Ctrl+V / ⌘V هنا.'],clipboard_unavailable:['Use Ctrl+V / ⌘V here, or choose an image file.','استخدم Ctrl+V / ⌘V هنا، أو اختر ملف صورة.']});
  const t=key=>(words[key]||words.failed)[config?.arabic()?1:0];
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon=name=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
  const frames=id=>[...document.querySelectorAll('[data-inv-photo]')].filter(n=>n.dataset.invPhoto===id);
  const key=item=>item.id+':'+item.image_version;
  function remember(versionKey,blob){const previous=cache.get(versionKey);if(previous)URL.revokeObjectURL(previous);cache.set(versionKey,URL.createObjectURL(blob));while(cache.size>60){const oldest=cache.keys().next().value;URL.revokeObjectURL(cache.get(oldest));cache.delete(oldest);}}
  function clear(){generation++;observer?.disconnect();observer=null;cache.forEach(value=>URL.revokeObjectURL(value));cache.clear();records.clear();pending.clear();busy.clear();errors.clear();loading.clear();}
  async function request(item,method='GET',form){
    const token=await config.token();if(!token)throw Object.assign(Error(),{code:'invalid_session'});
    const url=config.endpoint()+'/'+encodeURIComponent(item.id)+'?v='+encodeURIComponent(item.image_version||'');
    const response=await fetch(url,{method,headers:{Authorization:'Bearer '+token},body:form,cache:'no-store',signal:AbortSignal.timeout(method==='GET'?25000:75000)});
    if(!response.ok){const data=await response.json().catch(()=>({}));throw Object.assign(Error(),{code:response.status===401?'invalid_session':response.status===403?'access_denied':['not_connected','not_configured','reconnect_required'].includes(data.code)?'drive_not_connected':data.code||'saveFailed'});}
    return method==='GET'?response.blob():response.json();
  }
  function paint(id,renderIcons=true){
    const record=records.get(id);if(!record)return;const {item,manage}=record,source=cache.get(key(item)),error=errors.get(id),saving=busy.has(id),retry=pending.has(id),lang=config.arabic();
    let changed=false;
    for(const node of frames(id)){
      const signature=JSON.stringify([item.image_version,source,error,saving,retry,manage,lang,config.name(item)]);if(node.dataset.photoState===signature)continue;node.dataset.photoState=signature;
      changed=true;
      const focused=node.contains(document.activeElement),focusedAction=focused?document.activeElement.dataset.invPhotoAction:null;
      node.setAttribute('aria-busy',String(saving));node.setAttribute('aria-label',config.name(item));node.setAttribute('role','group');
      if(manage){node.tabIndex=0;node.setAttribute('aria-description',t('paste_hint'));}else{node.removeAttribute('tabindex');node.removeAttribute('aria-description');}
      const controls=manage?`<div class="inv-photo-actions">${item.image_version?`<button type="button" class="inv-icon-button" data-inv-photo-action="choose" aria-label="${t('change')}" title="${t('change')}" ${saving?'disabled':''}>${icon('image-up')}</button>`:''}<button type="button" class="${item.image_version?'inv-icon-button':'inv-button'}" data-inv-photo-action="paste" aria-label="${t('paste')}" title="${t('paste')}" ${saving?'disabled':''}>${icon('clipboard-paste')}${item.image_version?'':`<span>${t('paste')}</span>`}</button>${item.image_version&&node.classList.contains('inv-photo-detail')?`<button type="button" class="inv-icon-button inv-danger" data-inv-photo-action="remove" aria-label="${t('remove')}" ${saving?'disabled':''}>${icon('trash-2')}</button>`:''}</div>`:'';
      node.innerHTML=(source?`<img src="${source}" alt="${esc(config.name(item))}" draggable="false" loading="lazy" decoding="async" width="${item.image_width||960}" height="${item.image_height||540}">`:item.image_version?`<div class="inv-photo-loading" ${error?'':'aria-hidden="true"'}>${error?'':icon('image')}</div>`:manage?`<button type="button" class="inv-photo-add" data-inv-photo-action="choose" ${saving?'disabled':''}>${icon('image-plus')}<span>${t('add')}</span></button>`:`<div class="inv-photo-empty">${icon('image')}<span>${t('empty')}</span></div>`)+controls+(saving?`<div class="inv-photo-progress" role="status">${t('saving')}</div>`:error?`<div class="inv-photo-error" role="alert"><span>${esc(t(error))}</span>${retry||item.image_version?`<button type="button" class="inv-button" data-inv-photo-action="retry">${icon('refresh-cw')}<span>${t(retry?'retry':'load')}</span></button>`:''}</div>`:'');
      if(focused&&manage)(focusedAction&&node.querySelector(`[data-inv-photo-action="${focusedAction}"]:enabled`)||node).focus({preventScroll:true});
      if(item.image_version&&!source&&!error&&!saving){if(observer)observer.observe(node);else void load(id);}
    }
    if(changed&&renderIcons)config.icons?.();return changed;
  }
  function sync(root,items,manage){
    if(!config||!root)return;
    if(!observer&&typeof IntersectionObserver!=='undefined')observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);void load(entry.target.dataset.invPhoto);}},{rootMargin:'160px'});
    let changed=false;for(const item of items||[]){if(!root.querySelector(`[data-inv-photo="${item.id}"]`))continue;records.set(item.id,{item:{...item},manage});if(paint(item.id,false))changed=true;}if(changed)config.icons?.();
  }
  async function load(id){
    const item=records.get(id)?.item;if(!item?.image_version||cache.has(key(item))||loading.has(key(item)))return;
    const versionKey=key(item),context=generation;loading.set(versionKey,true);
    try{const blob=await request(item);if(context!==generation)return;if(!['image/webp','image/jpeg'].includes(blob.type)||blob.size>limit)throw Error();
      remember(versionKey,blob);errors.delete(id);
    }catch(error){if(context===generation)errors.set(id,words[error.code]?error.code:'failed');}
    finally{if(context===generation){loading.delete(versionKey);paint(id);}}
  }
  async function optimize(file){
    if(!/^image\/(jpeg|png|webp)$/.test(file.type))throw Object.assign(Error(),{code:'image_format'});
    if(file.size>15*1024*1024)throw Object.assign(Error(),{code:'image_size'});
    let bitmap;
    try{bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});}catch(_){throw Object.assign(Error(),{code:'image_format'});}
    try{
      if(bitmap.width*bitmap.height>40000000)throw Object.assign(Error(),{code:'image_size'});
      const scale=Math.min(1,960/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
      for(const quality of [.82,.7,.55,.4]){const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',quality));if(blob&&blob.size<=limit&&['image/webp','image/jpeg'].includes(blob.type))return blob;}
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.65));if(blob&&blob.size<=limit)return blob;
      throw Object.assign(Error(),{code:'image_size'});
    }finally{bitmap.close();}
  }
  async function ingest(id,source,context=generation){
    const record=records.get(id);if(context!==generation||!record?.manage||busy.has(id))return;busy.add(id);errors.delete(id);paint(id);
    try{const file=typeof source==='function'?await source():source;if(context!==generation)return;const blob=await optimize(file);if(context!==generation)return;if(!records.get(id)?.manage)throw Object.assign(Error(),{code:'access_denied'});pending.set(id,{blob,version:config.uuid(),item:{...record.item}});await save(id);}
    catch(error){if(context===generation)errors.set(id,words[error.code]?error.code:'saveFailed');}
    finally{if(context===generation){busy.delete(id);paint(id);}}
  }
  function choose(id){
    const record=records.get(id);if(!record?.manage||busy.has(id))return;
    const context=generation;
    const input=document.createElement('input');input.type='file';input.accept='image/jpeg,image/png,image/webp';input.hidden=true;document.body.appendChild(input);
    input.addEventListener('cancel',()=>input.remove(),{once:true});input.addEventListener('change',()=>{
      const file=input.files[0];input.remove();if(file)void ingest(id,file,context);
    },{once:true});input.click();
  }
  function paste(id){
    return ingest(id,async()=>{
      if(!navigator.clipboard?.read)throw Object.assign(Error(),{code:'clipboard_unavailable'});
      try{const items=await navigator.clipboard.read();for(const item of items){const type=['image/png','image/jpeg','image/webp'].find(value=>item.types.includes(value));if(type)return await item.getType(type);}throw Object.assign(Error(),{code:'clipboard_empty'});}
      catch(error){if(error.name==='NotAllowedError')throw Object.assign(Error(),{code:'clipboard_denied'});throw error;}
    });
  }
  async function save(id){
    const task=pending.get(id),record=records.get(id);if(!task||!record?.manage)return;const context=generation;
    const form=new FormData();form.set('image',task.blob,task.blob.type==='image/webp'?'item.webp':'item.jpg');form.set('version',task.version);form.set('expected',task.item.image_version||'');
    try{const data=await request(task.item,'POST',form);if(context!==generation)return;pending.delete(id);errors.delete(id);const item={...record.item,...data};records.set(id,{...record,item});remember(key(item),task.blob);config.changed(id,data);}
    catch(error){if(context===generation){if(['image_changed','access_denied','invalid_session'].includes(error.code))pending.delete(id);errors.set(id,words[error.code]?error.code:'saveFailed');if(error.code==='image_changed')void config.refresh();}}
  }
  async function remove(id){
    const record=records.get(id);if(!record?.manage||busy.has(id))return;const context=generation;busy.add(id);errors.delete(id);paint(id);
    try{const data=await request(record.item,'DELETE');if(context!==generation)return;pending.delete(id);const old=cache.get(key(record.item));if(old){URL.revokeObjectURL(old);cache.delete(key(record.item));}records.set(id,{...record,item:{...record.item,...data}});config.changed(id,data);}
    catch(error){if(context===generation){errors.set(id,words[error.code]?error.code:'saveFailed');if(error.code==='image_changed')void config.refresh();}}
    finally{if(context===generation){busy.delete(id);paint(id);}}
  }
  function init(options){config=options;if(host.__inventoryPhotoBound)return;host.__inventoryPhotoBound=true;document.addEventListener('error',event=>{const node=event.target;if(!node.matches?.('.inv-photo img'))return;const id=node.closest('[data-inv-photo]').dataset.invPhoto,item=records.get(id)?.item;if(!item)return;const value=cache.get(key(item));if(value){URL.revokeObjectURL(value);cache.delete(key(item));}errors.set(id,'failed');paint(id);},true);document.addEventListener('paste',event=>{
      if(event.defaultPrevented||event.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return;
      const frame=event.target.closest?.('[data-inv-photo]');if(!frame||!records.get(frame.dataset.invPhoto)?.manage)return;
      const file=[...(event.clipboardData?.files||[])].find(value=>value.type.startsWith('image/'));if(!file)return;
      event.preventDefault();void ingest(frame.dataset.invPhoto,file);
    });document.addEventListener('click',async event=>{const button=event.target.closest('[data-inv-photo-action]'),frame=button?.closest('[data-inv-photo]');if(!frame||button.disabled)return;const id=frame.dataset.invPhoto,action=button.dataset.invPhotoAction;if(action==='choose')void choose(id);else if(action==='paste')void paste(id);else if(action==='remove')void remove(id);else if(action==='retry'&&!busy.has(id)){errors.delete(id);if(pending.has(id)){const context=generation;busy.add(id);paint(id);try{await save(id);}finally{if(context===generation){busy.delete(id);paint(id);}}}else{paint(id);void load(id);}}});}
  host.LuminInventoryImages={init,sync,clear,optimize};
})(typeof window==='undefined'?globalThis:window);
