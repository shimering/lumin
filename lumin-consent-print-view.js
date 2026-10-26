(function(root){
  'use strict';
  const doc=root.document,button=doc.querySelector('[data-print-consent]'),back=doc.querySelector('[data-print-back]'),status=doc.querySelector('[data-print-status]'),pdfLink=doc.querySelector('[data-print-pdf]');
  // iPadOS can identify itself as a Mac, including in home-screen mode.
  const appleTouch=/iPad|iPhone|iPod/.test(root.navigator.userAgent)||(/Mac/.test(root.navigator.platform)&&root.navigator.maxTouchPoints>1);
  let prepared=false,automaticRequested=false,automaticAttempted=false,scheduled=false,pdfUrl=null;
  const t=(en,ar)=>doc.documentElement.lang==='ar'?ar:en;
  function openPrint(){
    if(!prepared)return;
    // Keep this synchronous: tablet browsers may require a direct tap in this tab.
    automaticAttempted=true;
    if(appleTouch&&pdfUrl){pdfLink.click();return;}
    root.print();
  }
  function tryAutomaticPrint(){
    if(appleTouch||!prepared||!automaticRequested||automaticAttempted||scheduled||doc.visibilityState!=='visible')return;
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
    pdfLink.querySelector('span').textContent=t('Open PDF','فتح PDF');
    status.textContent=t('Preparing consent…','جارٍ تجهيز الموافقة…');
    doc.querySelector('[data-consent-print-document]').hidden=false;
    if(doc.fonts){await Promise.allSettled(fonts.map(font=>doc.fonts.load(`14px "${font}"`,language==='ar'?'نص الموافقة':'Consent')));await doc.fonts.ready;}
    await Promise.allSettled([...doc.querySelectorAll('[data-consent-print-document] img')].map(image=>image.decode()));
    if(appleTouch){
      try{
        const {consentPdf}=await import('./lumin-consent-pdf.mjs?v=2');
        const bytes=await consentPdf(doc);
        const file=new File([bytes],(title||t('Consent','موافقة')).replace(/[\\/:*?"<>|\u0000-\u001f]/g,' ').slice(0,100)+'.pdf',{type:'application/pdf'});
        if(pdfUrl)root.URL.revokeObjectURL(pdfUrl);
        pdfUrl=root.URL.createObjectURL(file);pdfLink.href=pdfUrl;pdfLink.hidden=false;
        button.querySelector('span').textContent=t('Open PDF to print','فتح PDF للطباعة');
        status.textContent=t('Open the PDF, then choose Share → Print. Your consent keeps its page layout.','افتح PDF، ثم اختر مشاركة ← طباعة. تحتفظ الموافقة بتنسيق الصفحة.');
      }catch(error){
        // Retain native printing and the document if a required offline asset fails.
        console.error('Consent PDF preparation failed',error);
        status.textContent=t('PDF could not be prepared. Use Print, or return to the consent and try again.','تعذر تجهيز PDF. استخدم طباعة، أو عد إلى الموافقة وحاول مجدداً.');
      }
    }else status.textContent=t('Print or save a PDF of this consent.','اطبع هذه الموافقة أو احفظها كملف PDF.');
    prepared=true;button.disabled=false;
    doc.documentElement.dataset.consentPrintPrepared='true';if(root.lucide)root.lucide.createIcons();
  },autoPrint(){automaticRequested=true;tryAutomaticPrint();}};
  root.LuminConsentPrintView=api;
  root.addEventListener('load',()=>{api.ready=true;if(root.opener)root.opener.postMessage('lumin-consent-print-ready',root.location.origin);},{once:true});
})(window);
