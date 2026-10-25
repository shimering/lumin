(function(root){
  'use strict';
  const doc=root.document,button=doc.querySelector('[data-print-consent]'),back=doc.querySelector('[data-print-back]'),status=doc.querySelector('[data-print-status]');
  let prepared=false,automaticRequested=false,automaticAttempted=false,scheduled=false;
  const t=(en,ar)=>doc.documentElement.lang==='ar'?ar:en;
  function openPrint(){
    if(!prepared)return;
    // Keep this synchronous: tablet browsers may require a direct tap in this tab.
    automaticAttempted=true;root.focus();root.print();
  }
  function tryAutomaticPrint(){
    if(!prepared||!automaticRequested||automaticAttempted||scheduled||doc.visibilityState!=='visible')return;
    scheduled=true;
    root.requestAnimationFrame(()=>root.requestAnimationFrame(()=>{
      scheduled=false;if(doc.visibilityState!=='visible'||automaticAttempted)return;
      openPrint();
    }));
  }
  button.addEventListener('click',openPrint);
  back.addEventListener('click',()=>{if(root.opener&&!root.opener.closed)root.opener.focus();root.close();});
  doc.addEventListener('visibilitychange',tryAutomaticPrint);
  const api={ready:false,async prepare({language,title,fonts=[]}){
    doc.documentElement.lang=language==='ar'?'ar':'en';doc.documentElement.dir=language==='ar'?'rtl':'ltr';doc.title=title;
    button.querySelector('span').textContent=t('Print / Save as PDF','طباعة / حفظ PDF');back.querySelector('span').textContent=t('Back to consent','العودة إلى الموافقة');
    status.textContent=t('Preparing consent…','جارٍ تجهيز الموافقة…');
    doc.querySelector('[data-consent-print-document]').hidden=false;
    if(doc.fonts){await Promise.allSettled(fonts.map(font=>doc.fonts.load(`14px "${font}"`,language==='ar'?'نص الموافقة':'Consent')));await doc.fonts.ready;}
    await Promise.allSettled([...doc.querySelectorAll('[data-consent-print-document] img')].map(image=>image.decode()));
    prepared=true;button.disabled=false;status.textContent=t('Print or save a PDF of this consent.','اطبع هذه الموافقة أو احفظها كملف PDF.');
    doc.documentElement.dataset.consentPrintPrepared='true';if(root.lucide)root.lucide.createIcons();
  },autoPrint(){automaticRequested=true;tryAutomaticPrint();}};
  root.LuminConsentPrintView=api;
  root.addEventListener('load',()=>{api.ready=true;if(root.opener)root.opener.postMessage('lumin-consent-print-ready',root.location.origin);},{once:true});
})(window);
