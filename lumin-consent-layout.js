(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;root.LuminConsentLayout=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  const defaults={logo_visible:true,logo_width_mm:34,logo_align:'center',logo_pages:'all',logo_offset_mm:0,margin_top_mm:0,margin_bottom_mm:0,margin_left_mm:12,margin_right_mm:12,frame:'none'};
  const limits={logo_width_mm:[10,80],logo_offset_mm:[0,40],margin_top_mm:[0,35],margin_bottom_mm:[0,35],margin_left_mm:[8,35],margin_right_mm:[8,35]};
  function normalize(value={},base={}){
    const result={...defaults};
    for(const source of [base,value]){
      if(!source||typeof source!=='object')continue;
      for(const [key,[min,max]] of Object.entries(limits))if(source[key]!==undefined){const number=Number(source[key]);if(Number.isFinite(number))result[key]=Math.min(max,Math.max(min,number));}
      if(typeof source.logo_visible==='boolean')result.logo_visible=source.logo_visible;
      if(['start','center','end','left','right'].includes(source.logo_align))result.logo_align=source.logo_align;
      if(['all','first'].includes(source.logo_pages))result.logo_pages=source.logo_pages;
      if(['none','single','double','rounded'].includes(source.frame))result.frame=source.frame;
    }
    if(result.frame!=='none')for(const key of ['margin_top_mm','margin_bottom_mm','margin_left_mm','margin_right_mm'])result[key]=Math.max(8,result[key]);
    return result;
  }
  function styles(value){const s=normalize(value);return Object.entries(s).filter(([key])=>key.startsWith('margin_')).map(([key,number])=>`--consent-${key.replaceAll('_','-')}:${number}mm`).join(';');}
  function frameMarkup(value){const s=normalize(value);if(s.frame==='none')return '';const inset=Math.min(s.margin_top_mm,s.margin_bottom_mm,s.margin_left_mm,s.margin_right_mm)/2;return `<div class="consent-paper-frame is-${s.frame}" style="inset:${inset}mm" aria-hidden="true"></div>`;}
  function logoMarkup(value,image,language='en'){
    const s=normalize(value);if(!s.logo_visible||typeof image!=='string'||image.length>1500000||!/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(image))return '';
    return `<div class="consent-letterhead-logo" data-consent-letterhead-logo data-logo-pages="${s.logo_pages}" style="text-align:${s.logo_align};padding-top:${s.logo_offset_mm}mm"><img class="consent-clinic-logo" src="${image}" alt="${language==='ar'?'شعار العيادة':'Clinic logo'}" style="width:${s.logo_width_mm}mm"></div>`;
  }
  function needsPages(value){const s=normalize(value);return s.logo_pages==='first'||s.frame!=='none'||s.margin_top_mm!==0||s.margin_bottom_mm!==0||s.margin_left_mm!==12||s.margin_right_mm!==12;}
  function mount(container,{record,editors=[],locked=false,language=()=>record.language,onChange=()=>{},isCurrent=()=>true}={}){
    const doc=container.ownerDocument,t=(en,ar)=>(typeof currentUiLanguage!=='undefined'?currentUiLanguage:doc.documentElement.lang)==='ar'?ar:en,e=root.LuminConsentDocument.escape;
    let disposed=false,configuration=null,s=normalize(record.print_layout),override=record.print_layout||{};
    container.className='consent-layout-panel';
    container.dataset.layoutLocked=String(locked);
    container.innerHTML=`<details ${locked?'':'open'}><summary><i data-lucide="panels-top-left"></i><span>${t('Page layout & clinic logo','تنسيق الصفحة وشعار العيادة')}</span><span class="consent-layout-format">A4</span></summary><div class="consent-layout-controls"><p class="consent-hint" data-layout-message role="status">${t('Loading clinic letterhead…','جارٍ تحميل ترويسة العيادة…')}</p><div class="consent-layout-options"></div></div></details>`;
    const previews=[];
    const text=(key,en,ar,min,max)=>`<label class="consent-field">${t(en,ar)}<span class="consent-layout-number"><input type="number" min="${min}" max="${max}" step="1" name="layout_${key}" data-layout-key="${key}" value="${s[key]}" ${locked?'disabled':''}><span>${t('mm','مم')}</span></span></label>`;
    const select=(key,en,ar,options)=>`<label class="consent-field">${t(en,ar)}<select name="layout_${key}" data-layout-key="${key}" ${locked?'disabled':''}>${options.map(([value,en,ar])=>`<option value="${value}">${t(en,ar)}</option>`).join('')}</select></label>`;
    function physicalAlignment(){return s.logo_align==='start'?(language()==='ar'?'right':'left'):s.logo_align==='end'?(language()==='ar'?'left':'right'):s.logo_align;}
    function controls(){
      container.querySelector('.consent-layout-options').innerHTML=`<label class="consent-check consent-layout-toggle"><input type="checkbox" name="layout_logo_visible" data-layout-key="logo_visible" ${s.logo_visible?'checked':''} ${locked?'disabled':''}>${t('Include clinic logo','إظهار شعار العيادة')}</label><div class="consent-layout-grid">${text('logo_width_mm','Logo width','عرض الشعار',10,80)}${select('logo_align','Logo position','موضع الشعار',[['left','Left','يسار'],['center','Center','وسط'],['right','Right','يمين']])}${text('logo_offset_mm','Space above logo','المسافة أعلى الشعار',0,40)}${select('logo_pages','Show logo on','إظهار الشعار في',[['first','First page only','الصفحة الأولى فقط'],['all','Every page','كل الصفحات']])}${select('frame','Page frame','إطار الصفحة',[['none','No frame','بدون إطار'],['single','Single line','خط واحد'],['double','Double line','خطان'],['rounded','Rounded corners','زوايا دائرية']])}</div><div class="consent-layout-section"><span>${t('Page margins','هوامش الصفحة')}</span><div class="consent-layout-grid is-margins">${text('margin_top_mm','Top','أعلى',0,35)}${text('margin_bottom_mm','Bottom','أسفل',0,35)}${text('margin_left_mm','Left','يسار',8,35)}${text('margin_right_mm','Right','يمين',8,35)}</div></div><p class="consent-hint">${locked?t('Reopen this consent to edit its page layout.','أعد فتح الموافقة لتعديل تنسيق الصفحة.'):t('These choices are saved with this consent. Frames keep at least 8 mm of space inside the page.','تُحفظ هذه الاختيارات مع الموافقة. تتطلب الإطارات هوامش لا تقل عن ٨ مم.')}</p>`;
      updateControls();
    }
    function updateControls(){for(const input of container.querySelectorAll('[data-layout-key]')){const key=input.dataset.layoutKey;if(input.type==='checkbox')input.checked=s[key];else input.value=key==='logo_align'?physicalAlignment():s[key];}}
    function preparePreview(copy,canvas,lang){
      canvas.classList.add('consent-layout-paper');
      const header=doc.createElement('header'),footer=doc.createElement('footer');header.className='consent-draft-letterhead';footer.className='consent-draft-page-footer';
      copy.before(header);copy.after(footer);previews.push({canvas,header,footer,lang});
    }
    for(const editor of editors){const copy=editor.quill.root,canvas=copy.parentElement;preparePreview(copy,canvas,copy.lang||record.language);}
    if(!editors.length)for(const panel of container.parentElement.querySelectorAll('[data-consent-language-panel]')){
      const copy=panel.querySelector('.consent-copy');if(!copy)continue;const canvas=doc.createElement('div');copy.before(canvas);canvas.append(copy);copy.classList.add('consent-layout-read-copy');preparePreview(copy,canvas,panel.dataset.consentLanguagePanel);
    }
    function preview(){
      const settings=configuration?.settings||{},image=configuration?.logo||'';
      for(const {canvas,header,footer,lang} of previews){
        canvas.style.cssText=styles(s);canvas.dataset.frame=s.frame;canvas.querySelector(':scope>.consent-paper-frame')?.remove();canvas.insertAdjacentHTML('afterbegin',frameMarkup(s));
        header.dir=lang==='ar'?'rtl':'ltr';header.style.minHeight=(settings.header_height_mm??18)+'mm';header.style.fontSize=(settings.header_font_px??14)+'px';
        header.innerHTML=logoMarkup(s,image,lang)+(settings['header_text_'+lang]?`<div class="consent-letterhead-text">${e(settings['header_text_'+lang])}</div>`:'');
        header.hidden=false;footer.textContent=settings['footer_text_'+lang]||'';footer.style.minHeight=(settings.footer_height_mm??12)+'mm';footer.style.fontSize=(settings.footer_font_px??11)+'px';
      }
    }
    container.addEventListener('input',event=>{
      if(locked||!event.target.matches('[data-layout-key]'))return;
      const values={};for(const input of container.querySelectorAll('[data-layout-key]'))values[input.dataset.layoutKey]=input.type==='checkbox'?input.checked:input.value;
      s=normalize(values);override={...s};if(event.target.type!=='number')updateControls();preview();onChange({...override});
    });
    container.addEventListener('change',()=>updateControls());
    const api={setLanguage(){updateControls();},dispose(){disposed=true;},get value(){return override;},ready:null};
    controls();preview();
    api.ready=(async()=>{
      try{configuration=await root.LuminConsentPrint.load();if(disposed||!isCurrent()||!container.isConnected)return;s=normalize(override,configuration.settings);updateControls();preview();container.querySelector('[data-layout-message]').textContent=configuration.logo?t('Clinic logo and page layout are shown in the draft below.','يظهر شعار العيادة وتنسيق الصفحة في المسودة أدناه.'):t('Add your clinic logo in Admin → Print form to preview it here.','أضف شعار العيادة من الإدارة ← نموذج الطباعة ليظهر هنا.');}
      catch{if(!disposed&&container.isConnected)container.querySelector('[data-layout-message]').textContent=t('Clinic letterhead could not load. Reopen the consent to retry.','تعذر تحميل ترويسة العيادة. أعد فتح الموافقة للمحاولة.');}
      if(root.lucide)root.lucide.createIcons();
    })();
    if(root.lucide)root.lucide.createIcons();return api;
  }
  return {defaults,limits,normalize,styles,frameMarkup,logoMarkup,needsPages,mount};
});
