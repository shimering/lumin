(function(){
  'use strict';
  const root=document.getElementById('supplier-list'),model=LuminSupplierListModel,e=model.escape;
  let data=null,language='en',busy=false,loading=false,sequence=0,expiryTimer,controller;
  const t=(en,ar)=>language==='ar'?ar:en;
  const icon=name=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
  const token=()=>new URL(location.href).searchParams.get('s')||'';
  const date=value=>new Intl.DateTimeFormat(language,{dateStyle:'medium',timeZone:'Africa/Cairo'}).format(new Date(value));
  const count=value=>new Intl.NumberFormat(language).format(value);
  function icons(){if(window.lucide)lucide.createIcons();}
  function locale(){document.documentElement.lang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';}
  function unavailable(retry){
    data=null;clearTimeout(expiryTimer);locale();root.setAttribute('aria-busy','false');
    document.title=t('Supplier list unavailable','قائمة المورد غير متاحة')+' · Lumin';
    root.innerHTML=`<section class="sl-status" role="status">${icon(retry?'wifi-off':'link-2-off')}<h1>${t(retry?'Could not load supplier list':'Supplier list unavailable',retry?'تعذر تحميل قائمة المورد':'قائمة المورد غير متاحة')}</h1><p>${t(retry?'Check your connection and try again.':'This link may have expired. Ask the clinic for a new list.',retry?'تحقق من اتصالك بالإنترنت وحاول مجدداً.':'قد تكون صلاحية الرابط انتهت. اطلب قائمة جديدة من العيادة.')}</p>${retry?`<button data-sl-action="retry">${t('Try again','حاول مجدداً')}</button>`:''}<button data-sl-action="language">${language==='ar'?'English':'العربية'}</button></section>`;icons();
  }
  function render(){
    locale();root.setAttribute('aria-busy','false');document.title=t('Supplier list','قائمة المورد')+' · '+data.clinic_name;
    let index=0;
    root.innerHTML=`<div class="sl-toolbar"><button data-sl-action="language">${icon('languages')}${language==='ar'?'English':'العربية'}</button><div class="sl-actions"><button class="sl-primary" data-sl-action="link">${icon('link')}${t('Share link','مشاركة الرابط')}</button><button data-sl-action="jpg">${icon('image')}${t('Share JPG','مشاركة صورة JPG')}</button><button data-sl-action="print">${icon('printer')}${t('Print','طباعة')}</button></div></div><article class="sl-document"><header class="sl-header"><div class="sl-brand"><div class="sl-mark">${icon('clipboard-list')}</div><div><p class="sl-clinic"><bdi>${e(data.clinic_name)}</bdi></p><h1>${t('Supplier list','قائمة المورد')}</h1></div></div><div class="sl-meta"><span class="sl-count">${count(data.items.length)} ${t('items','أصناف')}</span><span dir="ltr">${e(data.reference)}</span><span>${t('Created','تاريخ الإنشاء')}: ${e(date(data.created_at))}</span></div></header>${model.groups(data.items,language).map(group=>`<section class="sl-group"><h2>${icon('folder-open')}<bdi>${e(group.label)}</bdi></h2><ul>${group.items.map(item=>`<li class="sl-row"><span class="sl-number">${count(++index)}</span><bdi class="sl-name">${e(model.name(item,language))}</bdi><bdi class="sl-unit">${e(model.unit(item.unit,language)||'—')}</bdi></li>`).join('')}</ul></section>`).join('')}<p class="sl-footer">${t('Prepared by','أُعدت بواسطة')} <bdi>${e(data.clinic_name)}</bdi> · ${t('Link valid until','الرابط صالح حتى')} ${e(date(data.expires_at))}</p></article><p class="sl-notice" role="status" aria-live="polite"></p><div class="sl-copy" hidden><input readonly dir="ltr" aria-label="${t('Supplier page link','رابط صفحة المورد')}"><button data-sl-action="copy">${icon('copy')}${t('Copy link','نسخ الرابط')}</button></div>`;icons();
    const ordered=model.groups(data.items,language).flatMap(group=>group.items);
    root.querySelectorAll('.sl-row').forEach((row,index)=>{
      const item=ordered[index],quantity=document.createElement('strong');quantity.className='sl-quantity';quantity.textContent=count(item.requested_quantity??1);row.querySelector('.sl-unit').prepend(quantity);
      const photo=document.createElement('span');photo.className='sl-thumb';const source=model.thumbnail(item.image_data_url);
      if(source){const image=document.createElement('img');image.src=source;image.alt=model.name(item,language);image.width=image.height=44;image.decoding='async';image.addEventListener('error',()=>{photo.innerHTML=icon('image');icons();},{once:true});photo.appendChild(image);}else photo.innerHTML=icon('image');
      row.insertBefore(photo,row.querySelector('.sl-name'));
    });icons();
    root.querySelectorAll('.sl-group').forEach(group=>{const heading=document.createElement('div');heading.className='sl-column-heading';heading.innerHTML=`<span>${t('Item','الصنف')}</span><span>${t('Quantity wanted','الكمية المطلوبة')}</span>`;group.querySelector('ul').before(heading);});
    clearTimeout(expiryTimer);expiryTimer=setTimeout(()=>{if(data&&Date.parse(data.expires_at)<=Date.now())unavailable(false);else load();},Math.min(Math.max(0,Date.parse(data.expires_at)-Date.now()),2147483647));
  }
  function notice(text){const node=root.querySelector('.sl-notice');if(node)node.textContent=text;}
  function shareUrl(){const url=new URL('supplier-list.html',location.href);url.hash='';url.search='';url.searchParams.set('s',token());return url.href;}
  function showCopy(){const panel=root.querySelector('.sl-copy');panel.hidden=false;const input=panel.querySelector('input');input.value=shareUrl();input.focus();input.select();notice(t('Copy this link to share the page.','انسخ هذا الرابط لمشاركة الصفحة.'));}
  async function shareLink(){
    const url=shareUrl();
    if(navigator.share)try{await navigator.share({title:document.title,url});return;}catch(error){if(error.name==='AbortError')return;}
    try{await navigator.clipboard.writeText(url);notice(t('Link copied. Ready to share.','تم نسخ الرابط. جاهز للمشاركة.'));}catch(_){showCopy();}
  }
  // Draw the document directly so exports work on mobile without a screenshot service.
  // Long lists split into numbered JPGs rather than exceeding mobile canvas limits.
  async function jpgFiles(snapshot,exportLanguage){
    await document.fonts.ready;
    const photos=new Map();await Promise.all([...new Set(snapshot.items.map(item=>model.thumbnail(item.image_data_url)).filter(Boolean))].map(async source=>{const image=new Image();image.src=source;try{await image.decode();photos.set(source,image);}catch(_){/* Keep the document readable if an older thumbnail is invalid. */}}));
    const rtl=exportLanguage==='ar',tr=(en,ar)=>rtl?ar:en,width=1200,edge=72,contentWidth=width-edge*2;
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=9000;
    const ctx=canvas.getContext('2d');if(!ctx)throw Error('canvas');
    const text=(value,x,y,size=24,color='#17263b',weight=400,maxWidth)=>{ctx.font=`${weight} ${size}px "Segoe UI",Tahoma,Arial,sans-serif`;ctx.fillStyle=color;ctx.direction=rtl?'rtl':'ltr';ctx.textAlign=rtl?'right':'left';if(maxWidth)ctx.fillText(value,x,y,maxWidth);else ctx.fillText(value,x,y);};
    const start=rtl?width-edge:edge;
    function wrap(value,maxWidth,size=26){ctx.font=`400 ${size}px "Segoe UI",Tahoma,Arial,sans-serif`;const lines=[];let line='';for(const word of String(value||'').split(/\s+/)){if(ctx.measureText((line?line+' ':'')+word).width>maxWidth&&line){lines.push(line);line=word;}else line+=(line?' ':'')+word;}if(line)lines.push(line);return lines.length?lines:[''];}
    const rows=[];let index=0;
    for(const group of model.groups(snapshot.items,exportLanguage)){
      rows.push({type:'category',label:group.label,height:124});
      for(const item of group.items){const lines=wrap(model.name(item,exportLanguage),contentWidth-344);rows.push({type:'item',index:++index,lines,photo:photos.get(model.thumbnail(item.image_data_url)),quantity:item.requested_quantity??1,unit:model.unit(item.unit,exportLanguage)||'—',height:Math.max(88,lines.length*38+32)});}
    }
    const pages=[];let page=[],height=0;
    for(const row of rows){if(height+row.height>7600&&page.length){pages.push(page);const lastCategory=[...page].reverse().find(row=>row.type==='category');page=row.type==='item'&&lastCategory?[{...lastCategory}]:[];height=page.reduce((sum,row)=>sum+row.height,0);}page.push(row);height+=row.height;}if(page.length)pages.push(page);
    const files=[];
    for(let p=0;p<pages.length;p++){
      canvas.height=400+pages[p].reduce((sum,row)=>sum+row.height,0);ctx.fillStyle='#ffffff';ctx.fillRect(0,0,width,canvas.height);
      ctx.fillStyle='#eff6ff';ctx.fillRect(0,0,width,240);
      text(snapshot.clinic_name,start,80,25,'#64748b',600,contentWidth);
      text(tr('Supplier list','قائمة المورد'),start,140,44,'#17263b',600);
      const meta=`${snapshot.reference} · ${new Intl.NumberFormat(exportLanguage).format(snapshot.items.length)} ${tr('items','أصناف')} · ${new Intl.DateTimeFormat(exportLanguage,{dateStyle:'medium',timeZone:'Africa/Cairo'}).format(new Date(snapshot.created_at))}`;
      text(meta,start,190,22,'#64748b',400,contentWidth);let y=260;
      for(const row of pages[p]){
        if(row.type==='category'){ctx.fillStyle='#f8fafc';ctx.fillRect(edge,y+12,contentWidth,60);text(row.label,rtl?start-16:start+16,y+52,24,'#475569',600,contentWidth-32);text(tr('Item','الصنف'),rtl?start-138:start+138,y+106,20,'#94a3b8');text(tr('Quantity wanted','الكمية المطلوبة'),rtl?edge+150:width-edge-150,y+106,20,'#94a3b8',400,150);}
        else{const x=rtl?start-138:start+138,photoX=rtl?start-118:start+54,quantityX=rtl?edge+150:width-edge-150;text(new Intl.NumberFormat(exportLanguage).format(row.index),start,y+44,20,'#94a3b8');ctx.fillStyle='#f8fafc';ctx.fillRect(photoX,y+8,64,64);if(row.photo)ctx.drawImage(row.photo,photoX,y+8,64,64);for(let line=0;line<row.lines.length;line++)text(row.lines[line],x,y+44+line*38,26,'#17263b',400,contentWidth-344);text(new Intl.NumberFormat(exportLanguage).format(row.quantity),quantityX,y+34,26,'#17263b',600,150);text(row.unit,quantityX,y+62,20,'#64748b',400,150);ctx.fillStyle='#e2e8f0';ctx.fillRect(edge,y+row.height-1,contentWidth,1);}y+=row.height;
      }
      text(`${tr('Prepared by','أُعدت بواسطة')} ${snapshot.clinic_name} · ${p+1} / ${pages.length}`,start,canvas.height-60,21,'#94a3b8',400,contentWidth);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.94));if(!blob)throw Error('image');files.push(new File([blob],`${snapshot.reference}${pages.length>1?'-'+(p+1):''}.jpg`,{type:'image/jpeg'}));
    }
    canvas.width=canvas.height=0;return files;
  }
  async function shareJpg(){
    if(busy||!data)return;busy=true;const snapshot=data,revision=sequence,exportLanguage=language;root.querySelector('[data-sl-action=jpg]').disabled=true;notice(t('Preparing JPG…','جار تجهيز صورة JPG…'));
    try{
      const files=await jpgFiles(snapshot,exportLanguage);if(revision!==sequence||snapshot!==data)return;
      if(navigator.canShare?.({files})&&navigator.share)try{await navigator.share({files,title:document.title});notice('');return;}catch(error){if(error.name==='AbortError'){notice('');return;}}
      for(const file of files){const url=URL.createObjectURL(file),anchor=document.createElement('a');anchor.href=url;anchor.download=file.name;document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
      notice(t('JPG downloaded. You can share it from your downloads.','تم تنزيل صورة JPG. يمكنك مشاركتها من التنزيلات.'));
    }catch(_){notice(t('Could not prepare the image. Try again or share the link.','تعذر تجهيز الصورة. حاول مجدداً أو شارك الرابط.'));}
    finally{busy=false;const button=root.querySelector('[data-sl-action=jpg]');if(button)button.disabled=false;}
  }
  async function load(){
    if(loading)return;const capability=token();if(!/^[a-f0-9]{64}$/.test(capability)){unavailable(false);return;}
    loading=true;const revision=sequence;controller=new AbortController();const timeout=setTimeout(()=>controller?.abort(),15000);
    try{
      const response=await fetch(`${LuminPublicConfig.supabaseUrl}/functions/v1/inventory-supplier-view`,{method:'POST',headers:{'Content-Type':'application/json',apikey:LuminPublicConfig.supabaseAnonKey},body:JSON.stringify({token:capability}),cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:controller.signal});
      if(response.status===404){if(revision===sequence)unavailable(false);return;}
      if(revision!==sequence)return;if(!response.ok)throw Error('request');const next=await response.json();if(revision!==sequence)return;
      if(!next||Date.parse(next.expires_at)<=Date.now()){unavailable(false);return;}
      if(!Array.isArray(next.items)||!next.items.length||!Number.isFinite(Date.parse(next.expires_at))||!Number.isFinite(Date.parse(next.created_at)))throw Error('invalid');
      if(!data){language=next.language==='ar'?'ar':'en';data=next;render();}
    }catch(_){if(revision===sequence)unavailable(true);}
    finally{clearTimeout(timeout);if(revision===sequence){loading=false;controller=null;}}
  }
  root.addEventListener('click',event=>{const action=event.target.closest('[data-sl-action]')?.dataset.slAction;if(action==='retry')load();if(action==='language'){if(busy)return;language=language==='ar'?'en':'ar';if(data)render();else unavailable(false);}if(action==='link'||action==='copy')void shareLink();if(action==='jpg')void shareJpg();if(action==='print')window.print();});
  window.addEventListener('popstate',()=>{sequence++;controller?.abort();loading=false;data=null;load();});
  window.addEventListener('online',()=>load());document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});
  document.addEventListener('gesturestart',event=>event.preventDefault(),{passive:false});document.addEventListener('touchmove',event=>{if(event.touches.length>1)event.preventDefault();},{passive:false});
  load();
})();
