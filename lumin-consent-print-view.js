(function(root){
  'use strict';
  const doc=root.document,button=doc.querySelector('[data-print-consent]'),back=doc.querySelector('[data-print-back]'),status=doc.querySelector('[data-print-status]'),pdfLink=doc.querySelector('[data-print-pdf]'),download=doc.querySelector('[data-download-pdf]');
  let prepared=false,automaticRequested=false,automaticAttempted=false,scheduled=false,pdfUrl=null,options=null;
  const t=(en,ar)=>doc.documentElement.lang==='ar'?ar:en;
  function openPdf(){
    if(!prepared)return;
    automaticAttempted=true;
    if(pdfUrl)pdfLink.click();
    else void api.prepare(options).then(()=>{if(pdfUrl)openPdf();});
  }
  function tryAutomaticOpen(){
    if(!prepared||!pdfUrl||!automaticRequested||automaticAttempted||scheduled||doc.visibilityState!=='visible')return;
    scheduled=true;
    root.requestAnimationFrame(()=>root.requestAnimationFrame(()=>{
      scheduled=false;if(doc.visibilityState!=='visible'||automaticAttempted)return;
      openPdf();
    }));
  }
  button.addEventListener('click',openPdf);
  pdfLink.addEventListener('click',()=>{automaticAttempted=true;});
  back.addEventListener('click',()=>{if(root.opener&&!root.opener.closed)root.opener.focus();root.close();});
  doc.addEventListener('visibilitychange',tryAutomaticOpen);
  const api={ready:false,async prepare(value){
    options=value;
    const {language,title,fonts=[],createPdfUrl=file=>root.URL.createObjectURL(file)}=value;
    prepared=false;button.disabled=true;
    doc.documentElement.lang=language==='ar'?'ar':'en';doc.documentElement.dir=language==='ar'?'rtl':'ltr';doc.title=title;
    button.querySelector('span').textContent=t('Open PDF','فتح PDF');back.querySelector('span').textContent=t('Back to consent','العودة إلى الموافقة');
    pdfLink.querySelector('span').textContent=t('Open PDF','فتح PDF');download.querySelector('span').textContent=t('Download PDF','تنزيل PDF');
    status.textContent=t('Preparing PDF…','جارٍ تجهيز ملف PDF…');
    doc.querySelector('[data-consent-print-document]').hidden=false;
    doc.documentElement.dataset.consentPdfReady='false';
    try{
      if(doc.fonts){await Promise.allSettled(fonts.map(font=>doc.fonts.load(`14px "${font}"`,language==='ar'?'نص الموافقة':'Consent')));await doc.fonts.ready;}
      await Promise.allSettled([...doc.querySelectorAll('[data-consent-print-document] img')].map(image=>image.decode()));
      const {consentPdf}=await import('./lumin-consent-pdf.mjs?v=4');
      const bytes=await consentPdf(doc);
      const file=new File([bytes],(title||t('Consent','موافقة')).replace(/[\\/:*?"<>|\u0000-\u001f]/g,' ').slice(0,100)+'.pdf',{type:'application/pdf'});
      pdfUrl=createPdfUrl(file);pdfLink.href=download.href=pdfUrl;download.download=file.name;
      pdfLink.hidden=false;download.hidden=false;
      doc.documentElement.dataset.consentPdfReady='true';
      status.textContent=t('Your PDF is ready. Open it to print or save a copy.','ملف PDF جاهز. افتحه للطباعة أو احفظ نسخة منه.');
    }catch(error){
      console.error('Consent PDF preparation failed',error);
      button.querySelector('span').textContent=t('Retry PDF export','إعادة تصدير PDF');
      status.textContent=t('The PDF could not be prepared. Retry the export or return to your consent.','تعذر تجهيز ملف PDF. أعد محاولة التصدير أو عد إلى الموافقة.');
    }
    prepared=true;button.disabled=false;
    doc.documentElement.dataset.consentPrintPrepared='true';if(root.lucide)root.lucide.createIcons();
  },autoOpen(){automaticRequested=true;tryAutomaticOpen();}};
  root.LuminConsentPrintView=api;
  root.addEventListener('load',()=>{api.ready=true;if(root.opener)root.opener.postMessage('lumin-consent-print-ready',root.location.origin);},{once:true});
})(window);
