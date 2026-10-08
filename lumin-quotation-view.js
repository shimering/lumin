(function (root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const text = (language,en,ar) => language === 'ar' ? ar : en;
  const money = (amount,language) => new Intl.NumberFormat(language === 'ar' ? 'ar-EG' : 'en-GB',{style:'currency',currency:'EGP',maximumFractionDigits:2}).format(amount);
  const date = (value,language) => new Intl.DateTimeFormat(language === 'ar' ? 'ar-EG' : 'en-GB',{dateStyle:'medium',timeZone:'Africa/Cairo'}).format(new Date(value));
  const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  function targetLabel(item,language) {
    if (item.scope === 'mouth') return text(language,'Whole mouth','الفم بالكامل');
    const teeth = [...new Set(item.targets.map(target => LuminQuotationModel.toothLabel(target.toothId)))];
    const surfaces = [...new Set(item.targets.flatMap(target => target.surfaces.map(surface => {
      const slot=LuminQuotationModel.slotForTooth(target.toothId);
      const right=slot<=8||slot>=25;
      if(surface==='left'||surface==='right')return (surface==='right')===right?text(language,'Mesial','أنسي'):text(language,'Distal','وحشي');
      if(surface==='center')return /molar/.test(LuminToothAnatomy.type(target.toothId,slot))?text(language,'Occlusal','إطباقي'):text(language,'Incisal','قاطعي');
      return surface==='top'?text(language,'Buccal','شدقي'):text(language,'Lingual','لساني');
    })))];
    return teeth.join(' · ') + (surfaces.length ? ' · ' + surfaces.join(', ') : '');
  }
  function chartMarkup(data,language,prefix) {
    function toothMarkup(tooth) {
      if (!tooth.toothId) return '<div class="q-tooth q-tooth-empty" aria-hidden="true"></div>';
      const id = tooth.toothId;
      const related = data.items.filter(item => item.targets.some(target => target.toothId === id));
      const label = LuminQuotationModel.toothLabel(id);
      const name = `${label}${related.length ? ': '+related.map(item => item.name).join(', ') : ''}`;
      const anatomy = LuminToothAnatomy.photo(id,tooth.slot,true).replaceAll('id="',`id="${prefix}-`);
      const surfaces = ['top','left','center','right','bottom'];
      const shapes = {top:'M3 3H37L29 11H11Z',left:'M3 3L11 11V29L3 37Z',center:'M11 11H29V29H11Z',right:'M37 3V37L29 29V11Z',bottom:'M3 37L11 29H29L37 37Z'};
      const matrix = `<svg class="q-matrix" viewBox="0 0 40 40" aria-hidden="true">${surfaces.map(surface => {
        const matching = related.filter(item => item.scope === 'surface' && item.targets.some(target => target.toothId === id && target.surfaces.includes(surface)));
        return `<path d="${shapes[surface]}" class="q-surface${matching.length ? matching.some(item => item.status === 'In') ? ' q-in-progress' : ' q-planned' : ''}"></path>`;
      }).join('')}</svg>`;
      return `<button type="button" class="q-tooth${related.length ? ' q-tooth-treated' : ''}" data-q-tooth="${id}" aria-label="${escape(name)}" aria-pressed="false" ${related.length ? '' : 'disabled'}><span class="q-tooth-label" dir="ltr">${label}</span>${anatomy}${matrix}</button>`;
    }
    const upper = data.teeth.filter(tooth => tooth.slot <= 16).sort((a,b) => a.slot-b.slot);
    const lower = data.teeth.filter(tooth => tooth.slot > 16).sort((a,b) => b.slot-a.slot);
    return `<div class="q-chart-scroll"><div class="q-chart" dir="ltr"><div class="q-quadrants"><span>${text(language,'Upper right','الفك العلوي الأيمن')}</span><span>${text(language,'Upper left','الفك العلوي الأيسر')}</span></div><div class="q-arch">${upper.map(toothMarkup).join('')}</div><div class="q-arch-divider"></div><div class="q-arch">${lower.map(toothMarkup).join('')}</div><div class="q-quadrants"><span>${text(language,'Lower right','الفك السفلي الأيمن')}</span><span>${text(language,'Lower left','الفك السفلي الأيسر')}</span></div></div></div>`;
  }
  function render(container,data,language = 'en',options = {}) {
    const prefix = container.id || 'quotation';
    container.dir = language === 'ar' ? 'rtl' : 'ltr';
    container.classList.add('q-document');
    const clinic = data.clinic || {name:'Lumin Dental',logo:'',whatsapp:''};
    const safeLogo = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(clinic.logo || '') && clinic.logo.length <= 300000;
    const contact = /^[1-9][0-9]{6,14}$/.test(clinic.whatsapp || '');
    container.innerHTML = `<header class="q-brandbar"><div class="q-brand">${safeLogo ? `<img class="q-clinic-logo" src="${escape(clinic.logo)}" alt=""/>` : `<span class="q-brand-icon">${icon('sparkles')}</span>`}<span>${escape(clinic.name)}</span></div>${!options.preview ? `<button type="button" class="q-button q-language" data-q-language>${icon('languages')}${language === 'ar' ? 'English' : 'العربية'}</button>` : ''}</header>
      <div class="q-heading"><div><span class="q-eyebrow">${text(language,'PERSONAL TREATMENT PLAN','خطة علاجك الشخصية')}</span><h1>${text(language,'Your treatment quotation','عرض أسعار علاجك')}</h1><p>${text(language,'Prepared for','أُعدّ من أجل')} <strong dir="auto">${escape(data.patientName)}</strong></p></div><div class="q-reference"><span class="q-badge q-live">${icon('refresh-cw')}${text(language,'Live quotation','عرض أسعار مباشر')}</span><span dir="ltr">${escape(data.reference || '')}</span>${data.expiresAt ? `<span>${text(language,'Valid until','صالح حتى')} ${date(data.expiresAt,language)}</span>` : ''}</div></div>
      <section class="q-panel"><div class="q-section-heading"><div><h2>${text(language,'Your smile, mapped out','خطة علاج ابتسامتك')}</h2><p>${text(language,'Tap a treatment or highlighted tooth to explore your plan.','اضغط على إجراء أو سن محدد لاستعراض خطة علاجك.')}</p></div><div class="q-legend"><span class="q-badge q-planned">${text(language,'Planned','مخطط')}</span><span class="q-badge q-in-progress">${text(language,'In progress','قيد التنفيذ')}</span></div></div>${chartMarkup(data,language,prefix)}</section>
      <div class="q-details-grid"><section class="q-panel"><div class="q-section-heading"><h2>${text(language,'Included treatments','الإجراءات المشمولة')}</h2><span class="q-count">${data.items.length}</span></div><div class="q-procedures">${data.items.length ? data.items.map((item,index) => `<button type="button" class="q-procedure" data-q-item="${index}" aria-pressed="false"><span class="q-procedure-icon">${icon(item.scope === 'mouth' ? 'sparkles' : item.visualCode === 'rct' ? 'activity' : item.visualCode.includes('crown') ? 'gem' : 'layers')}</span><span class="q-procedure-copy"><strong dir="auto">${escape(item.name)}${item.visitNumber ? ` · ${text(language,'Visit','زيارة')} ${item.visitNumber}` : ''}</strong><span dir="auto">${escape(targetLabel(item,language))}</span><span class="q-badge ${item.status === 'In' ? 'q-in-progress' : 'q-planned'}">${item.status === 'In' ? text(language,'In progress','قيد التنفيذ') : text(language,'Planned','مخطط')}</span></span><strong class="q-price">${escape(money(item.amount,language))}</strong></button>`).join('') : `<div class="q-empty">${icon('circle-check')}<h3>${text(language,'No treatments remaining','لا توجد إجراءات متبقية')}</h3><p>${text(language,'All quoted treatments have been completed or removed from the plan.','اكتملت جميع الإجراءات المشمولة أو أُزيلت من الخطة.')}</p></div>`}</div></section>
      <aside class="q-panel q-total-panel"><span class="q-eyebrow">${text(language,'QUOTATION TOTAL','إجمالي عرض الأسعار')}</span><div class="q-total" aria-live="polite">${escape(money(data.total,language))}</div><p class="q-live-note">${icon('refresh-cw')}<span>${text(language,'Prices follow your current treatment plan. Completed treatments are removed automatically.','تتبع الأسعار خطة علاجك الحالية. تُحذف الإجراءات المكتملة تلقائياً.')}</span></p>${!options.preview && contact ? `<a class="q-button q-primary" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" href="https://wa.me/${clinic.whatsapp}?text=${encodeURIComponent(text(language,`Hello, I have a question about quotation ${data.reference}.`,`مرحباً، لدي سؤال عن عرض الأسعار ${data.reference}.`))}">${icon('message-circle')}${text(language,'Contact clinic','تواصل مع العيادة')}</a>` : ''}${!options.preview ? `<button type="button" class="q-button" data-q-print>${icon('printer')}${text(language,'Print quotation','طباعة عرض الأسعار')}</button>` : ''}</aside></div>
      <footer class="q-footer">${text(language,'Prepared with care','أُعدّ بعناية')} · Lumin</footer>`;
    for (const tooth of container.querySelectorAll('[data-q-tooth]')) {
      const id = tooth.dataset.qTooth;
      const related = data.items.filter(item => item.targets.some(target => target.toothId === id));
      for (const item of related) {
        if (item.scope !== 'whole') continue;
        const color = item.status === 'In' ? '#2563eb' : '#d97706';
        const crown = tooth.querySelector('[id*="tooth-crown-overlay-"]');
        const anatomy = tooth.querySelector('[id*="anatomy-group-"]');
        const visual = item.visualCode;
        if (['crown','ceramic_crown','zirconia_crown','temporary_crown','bridge','veneer'].includes(visual) && crown) {crown.style.opacity='1';crown.style.filter=item.status === 'In' ? 'brightness(0) saturate(100%) invert(35%) sepia(96%) saturate(2698%) hue-rotate(214deg) brightness(96%) contrast(96%)' : 'brightness(0) saturate(100%) invert(54%) sepia(93%) saturate(1760%) hue-rotate(5deg) brightness(96%) contrast(95%)';}
        if (visual === 'rct') {const rct=tooth.querySelector('[id*="rct-layer-"]');if(rct){rct.classList.remove('hidden');rct.style.display='block';rct.style.setProperty('--operation-status-color',color);rct.style.setProperty('--operation-status-soft',item.status === 'In' ? '#2563eb3d' : '#d977063d');}}
        if (['missing','extraction_planned'].includes(visual)) {if(anatomy)anatomy.style.opacity='.28';tooth.classList.add('q-extraction');}
        if (visual === 'impacted' && anatomy) anatomy.style.transform='rotate(25deg) scale(.9)';
        if (visual === 'unerupted' && anatomy) anatomy.style.opacity='.3';
        if (['implant','bracket'].includes(visual)) {
          const overlay=tooth.querySelector('[id*="anatomy-overlay-"]');
          if(overlay) overlay.insertAdjacentHTML('beforeend',`<span class="photo-${visual}" style="--operation-status-color:${color}" aria-hidden="true"></span>`);
          if(visual === 'implant' && anatomy) anatomy.style.opacity='.15';
        }
      }
    }
    function select(indices) {
      const selected = indices.map(index => data.items[index]);
      container.querySelectorAll('[data-q-item]').forEach(button => {const pressed=indices.includes(Number(button.dataset.qItem));button.setAttribute('aria-pressed',String(pressed));});
      container.querySelectorAll('[data-q-tooth]').forEach(button => button.setAttribute('aria-pressed',String(selected.some(item => item.scope === 'mouth' || item.targets.some(target => target.toothId === button.dataset.qTooth)))));
    }
    container.querySelectorAll('[data-q-item]').forEach(button => button.addEventListener('click',() => select([Number(button.dataset.qItem)])));
    container.querySelectorAll('[data-q-tooth]').forEach(button => button.addEventListener('click',() => select(data.items.flatMap((item,index) => item.targets.some(target => target.toothId === button.dataset.qTooth) ? [index] : []))));
    container.querySelector('[data-q-language]')?.addEventListener('click',() => options.onLanguage?.(language === 'ar' ? 'en' : 'ar'));
    container.querySelector('[data-q-print]')?.addEventListener('click',() => window.print());
    if (root.lucide) root.lucide.createIcons();
  }
  root.LuminQuotationView = {render,escape,text,money,date,targetLabel,icon};
})(globalThis);
