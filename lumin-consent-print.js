(function(root){
  'use strict';
  const e=value=>root.LuminConsentDocument.escape(value);
  const t=(en,ar)=>(typeof currentUiLanguage!=='undefined'?currentUiLanguage:document.documentElement.lang)==='ar'?ar:en;
  const defaults={header_text_en:'',header_text_ar:'',footer_text_en:'',footer_text_ar:'',header_height_mm:18,footer_height_mm:12,header_font_px:14,footer_font_px:11,logo_visible:true,logo_width_mm:34,logo_align:'center',signatures_visible:true};
  const limits={header_height_mm:[0,70],footer_height_mm:[0,50],header_font_px:[8,32],footer_font_px:[8,32],logo_width_mm:[10,80]};
  const pendingViews=new WeakMap();
  function normalize(value={}){
    const result={...defaults};
    for(const key of ['header_text_en','header_text_ar','footer_text_en','footer_text_ar'])result[key]=String(value[key]??'').slice(0,600);
    for(const [key,[min,max]] of Object.entries(limits)){const number=Number(value[key]??defaults[key]);result[key]=Number.isFinite(number)?Math.min(max,Math.max(min,number)):defaults[key];}
    for(const key of ['logo_visible','signatures_visible'])result[key]=value[key]!==false;
    if(['start','center','end'].includes(value.logo_align))result.logo_align=value.logo_align;
    return result;
  }
  function logo(value){return typeof value==='string'&&value.length<1500000&&/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(value)?value:'';}
  async function load(){
    const [layout,image]=await Promise.all([db.from('consent_print_settings').select('*').eq('id',1).single(),db.from('prescription_print_settings').select('logo_data_url').eq('id',1).maybeSingle()]);
    if(layout.error)throw layout.error;if(image.error)throw image.error;
    return {settings:normalize(layout.data),logo:logo(image.data?.logo_data_url),updatedAt:layout.data.updated_at};
  }
  function reserve(){
    const view=root.open(new URL('consent-print.html',root.location.href).href,'_blank');
    if(!view)throw new Error(t('Allow pop-ups for Lumin to open the consent print view.','اسمح بالنوافذ المنبثقة لموقع Lumin لفتح صفحة طباعة الموافقة.'));
    const ready=new Promise((resolve,reject)=>{
      const cleanup=()=>{root.removeEventListener('message',receive);clearTimeout(timeout);};
      const receive=event=>{if(event.source===view&&event.origin===root.location.origin&&event.data==='lumin-consent-print-ready'){cleanup();resolve();}};
      const timeout=setTimeout(()=>{cleanup();reject(new Error(t('Print view could not load. Please retry.','تعذر تحميل صفحة الطباعة. حاول مجدداً.')));},30000);
      root.addEventListener('message',receive);
    });
    ready.catch(()=>{});pendingViews.set(view,ready);
    return view;
  }
  function body(record,configuration){
    const s=normalize(configuration.settings),image=logo(configuration.logo),ar=record.language==='ar',tr=(en,arabic)=>ar?arabic:en;
    const header=s['header_text_'+record.language],footer=s['footer_text_'+record.language];
    const signatures=s.signatures_visible?`<div class="consent-print-signatures"><p>${tr('Patient / guardian name and signature','اسم وتوقيع المريض / ولي الأمر')}<br>${tr('Relationship (if guardian)','صلة القرابة (لولي الأمر)')}<br>${tr('Date','التاريخ')}: __________________</p><p>${tr('Treating doctor signature','توقيع الطبيب المعالج')}<br>${e(ar&&record.doctor_name_ar?record.doctor_name_ar:record.doctor_name)}<br>${tr('Date','التاريخ')}: __________________</p><p>${tr('Witness / interpreter (if needed)','الشاهد / المترجم (عند الحاجة)')}<br>${tr('Name and signature','الاسم والتوقيع')}: __________________</p></div>`:'';
    const template=document.createElement('template');template.innerHTML=root.LuminConsentDocument.html(root.LuminConsentDocument.read(record.content,record.body));
    const blocks=[];
    for(const node of template.content.children){
      if(node.matches('.consent-table-print-wrap')){
        // Separate table rows prevent nested-table fragments covering repeated letterhead.
        const table=node.querySelector('table'),rows=[...table.rows];
        rows.forEach((row,index)=>{const part=table.cloneNode(false);part.append(table.querySelector('colgroup').cloneNode(true));const section=document.createElement('tbody');section.append(row.cloneNode(true));part.append(section);blocks.push(`<div class="consent-table-print-wrap consent-table-part ${index===0?'is-first':''} ${index===rows.length-1?'is-last':''}">${part.outerHTML}</div>`);});
      }else if(node.matches('ol,ul')){
        [...node.children].forEach((item,index)=>{const list=node.cloneNode(false);if(node.tagName==='OL')list.start=index+1;list.append(item.cloneNode(true));blocks.push(list.outerHTML);});
      }else blocks.push(node.outerHTML);
    }
    if(signatures)blocks.push(signatures);
    return `<main id="consent-print-root"><div class="consent-copy consent-rich-content"><table class="consent-print-page" role="presentation"><thead><tr><td><header class="consent-page-header" style="min-height:${s.header_height_mm}mm;font-size:${s.header_font_px}px">${s.logo_visible&&image?`<div style="text-align:${s.logo_align}"><img class="consent-clinic-logo" src="${image}" alt="${tr('Clinic logo','شعار العيادة')}" style="width:${s.logo_width_mm}mm"/></div>`:''}${header?`<div class="consent-letterhead-text">${e(header)}</div>`:''}</header></td></tr></thead><tfoot><tr><td><div class="consent-footer-spacer" aria-hidden="true" style="min-height:${s.footer_height_mm}mm;font-size:${s.footer_font_px}px">${e(footer)}</div></td></tr></tfoot><tbody>${blocks.map(block=>`<tr><td>${block}</td></tr>`).join('')}</tbody></table></div></main><footer class="consent-page-footer" style="min-height:${s.footer_height_mm}mm;font-size:${s.footer_font_px}px">${e(footer)}</footer>`;
  }
  async function print(record,{view,isCurrent=()=>true}={}){
    view=view||reserve();
    try{
      const [configuration]=await Promise.all([load(),pendingViews.get(view)]);
      if(view.closed||!isCurrent()){view.close();return;}
      const ar=record.language==='ar';view.document.documentElement.lang=ar?'ar':'en';view.document.documentElement.dir=ar?'rtl':'ltr';view.document.title=record.title;
      view.document.body.innerHTML=body(record,configuration);
      const families=[...new Set(root.LuminConsentDocument.read(record.content,record.body).ops.map(op=>op.attributes?.font).filter(Boolean))];
      if(view.document.fonts){await Promise.allSettled(families.map(font=>view.document.fonts.load(`14px "${font}"`,ar?'نص الموافقة':'Consent')));await view.document.fonts.ready;}
      await Promise.allSettled([...view.document.images].map(image=>image.decode()));
      if(view.closed||!isCurrent()){view.close();return;}
      // Android can fire afterprint before its native preview has captured the page.
      // Keep this dedicated document alive; it never contains the patient editor.
      view.focus();view.print();
    }catch(error){if(!view.closed)view.close();throw error;}
  }
  async function mountAdmin(container){
    const slot=document.createElement('details');slot.className='consent-panel consent-print-admin';container.prepend(slot);
    slot.innerHTML=`<summary><i data-lucide="printer"></i>${t('Consent print layout','تنسيق طباعة الموافقات')}</summary><p class="consent-hint" role="status">${t('Loading print settings…','جارٍ تحميل إعدادات الطباعة…')}</p>`;
    try{
      const configuration=await load();if(!slot.isConnected)return;
      const s=configuration.settings;
      const number=(key,en,ar)=>`<label class="consent-field">${t(en,ar)}<input type="number" name="${key}" min="${limits[key][0]}" max="${limits[key][1]}" step="1" value="${s[key]}" required></label>`;
      const text=(key,en,ar)=>`<label class="consent-field">${t(en,ar)}<textarea name="${key}" maxlength="600" rows="3" dir="${key.endsWith('_ar')?'rtl':'ltr'}">${e(s[key])}</textarea></label>`;
      slot.innerHTML=`<summary><i data-lucide="printer"></i>${t('Consent print layout','تنسيق طباعة الموافقات')}</summary><p class="consent-hint">${t('Set the repeated header and footer. Leave text empty to remove it. The logo is shared with Admin → Print form.','اضبط الرأس والتذييل المتكررين. اترك النص فارغاً لإزالته. الشعار هو نفس شعار الإدارة ← نموذج الطباعة.')}</p><form data-consent-print-settings><div class="consent-form-grid">${text('header_text_en','Header text (English)','نص الرأس (إنجليزي)')}${text('header_text_ar','Header text (Arabic)','نص الرأس (عربي)')}${number('header_height_mm','Header minimum height (mm)','أقل ارتفاع للرأس (مم)')}${number('header_font_px','Header text size (px)','حجم نص الرأس (بكسل)')}${text('footer_text_en','Footer text (English)','نص التذييل (إنجليزي)')}${text('footer_text_ar','Footer text (Arabic)','نص التذييل (عربي)')}${number('footer_height_mm','Footer minimum height (mm)','أقل ارتفاع للتذييل (مم)')}${number('footer_font_px','Footer text size (px)','حجم نص التذييل (بكسل)')}${number('logo_width_mm','Logo width (mm)','عرض الشعار (مم)')}<label class="consent-field">${t('Logo position','موضع الشعار')}<select name="logo_align">${[['start','Start','البداية'],['center','Center','الوسط'],['end','End','النهاية']].map(([key,en,ar])=>`<option value="${key}" ${s.logo_align===key?'selected':''}>${t(en,ar)}</option>`).join('')}</select></label></div><div class="consent-actions"><label class="consent-check"><input type="checkbox" name="logo_visible" ${s.logo_visible?'checked':''}>${t('Show clinic logo','إظهار شعار العيادة')}</label><label class="consent-check"><input type="checkbox" name="signatures_visible" ${s.signatures_visible?'checked':''}>${t('Show signature section','إظهار قسم التوقيعات')}</label></div><div class="consent-print-logo-preview">${configuration.logo?`<img src="${configuration.logo}" alt="${t('Clinic logo','شعار العيادة')}">`:`<p class="consent-hint">${t('Add your clinic logo in Admin → Print form.','أضف شعار العيادة في الإدارة ← نموذج الطباعة.')}</p>`}</div><div class="consent-actions"><button type="submit" class="consent-btn consent-primary"><i data-lucide="save"></i>${t('Save print layout','حفظ تنسيق الطباعة')}</button><span data-print-layout-message role="status"></span></div></form>`;
      const form=slot.querySelector('form');
      const preview=()=>{const image=slot.querySelector('.consent-print-logo-preview img');if(image){image.style.width=form.elements.logo_width_mm.value+'mm';image.hidden=!form.elements.logo_visible.checked;}slot.querySelector('.consent-print-logo-preview').style.textAlign=form.elements.logo_align.value;};
      form.addEventListener('input',preview);preview();
      form.addEventListener('submit',async event=>{
        event.preventDefault();if(!form.reportValidity())return;const button=form.querySelector('button'),message=form.querySelector('[data-print-layout-message]');button.disabled=true;
        try{
          const values=Object.fromEntries(new FormData(form));for(const key of ['logo_visible','signatures_visible'])values[key]=form.elements[key].checked;
          const saved=await db.from('consent_print_settings').update(normalize(values)).eq('id',1).eq('updated_at',configuration.updatedAt).select('updated_at').maybeSingle();
          if(saved.error)throw saved.error;if(!saved.data)throw new Error(t('Settings changed on another device. Refresh this page.','تغيرت الإعدادات على جهاز آخر. حدث الصفحة.'));
          configuration.updatedAt=saved.data.updated_at;message.textContent=t('Print layout saved.','تم حفظ تنسيق الطباعة.');
        }catch(error){message.textContent=error.message;}finally{button.disabled=false;}
      });
    }catch(error){slot.querySelector('[role=status]').textContent=error.message;}
    if(root.lucide)root.lucide.createIcons();
  }
  root.LuminConsentPrint={normalize,body,reserve,print,mountAdmin};
})(window);
