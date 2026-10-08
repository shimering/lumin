(function () {
  'use strict';
  const container=document.getElementById('patient-quotation');
  let language='en',preferred=false,data=null,request=0,controller=null,loading=false,expiryTimer,retryState=false;
  const token=()=>location.hash.slice(1);
  const t=(en,ar)=>language==='ar'?ar:en;
  function setLanguage(value) {
    language=value;preferred=true;
    document.documentElement.lang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';
    if(data)render();else unavailable(retryState);
  }
  function unavailable(retry) {
    retryState=retry;
    data=null;clearTimeout(expiryTimer);container.setAttribute('aria-busy','false');
    container.classList.remove('q-document');container.dir=language==='ar'?'rtl':'ltr';
    container.innerHTML=`<section class="q-page-status" role="status"><i data-lucide="${retry?'wifi-off':'link-2-off'}" aria-hidden="true"></i><h1>${t(retry?'Could not load quotation':'Quotation unavailable',retry?'تعذر تحميل عرض الأسعار':'عرض الأسعار غير متاح')}</h1><p>${t(retry?'Check your connection and try again.':'This link may have expired or been disabled. Please contact your clinic.',retry?'تحقق من اتصالك بالإنترنت وحاول مجدداً.':'قد يكون الرابط منتهياً أو معطلاً. يرجى التواصل مع العيادة.')}</p>${retry?`<button type="button" class="q-button q-primary" data-retry>${t('Try again','حاول مجدداً')}</button>`:''}<button type="button" class="q-button" data-language>${language==='ar'?'English':'العربية'}</button></section>`;
    container.querySelector('[data-retry]')?.addEventListener('click',()=>load());
    container.querySelector('[data-language]')?.addEventListener('click',()=>setLanguage(language==='ar'?'en':'ar'));
    if(window.lucide)lucide.createIcons();
  }
  function render() {
    LuminQuotationView.render(container,data,language,{onLanguage:setLanguage});
    container.setAttribute('aria-busy','false');
    clearTimeout(expiryTimer);
    const remaining=new Date(data.expiresAt).getTime()-Date.now();
    expiryTimer=setTimeout(()=>{if(data&&new Date(data.expiresAt)<=new Date())unavailable(false);else load();},Math.max(0,Math.min(remaining,2147483647)));
  }
  async function load() {
    if(loading)return;
    const capability=token();
    if(!/^[a-f0-9]{64}$/.test(capability)){unavailable(false);return;}
    if(data&&new Date(data.expiresAt)<=new Date()){unavailable(false);return;}
    const revision=request;
    loading=true;const currentController=new AbortController();controller=currentController;
    const abortTimer=setTimeout(()=>currentController.abort(),15000);
    try {
      const response=await fetch(`${LuminPublicConfig.supabaseUrl}/functions/v1/quotation-view`,{
        method:'POST',headers:{'Content-Type':'application/json',apikey:LuminPublicConfig.supabaseAnonKey},
        body:JSON.stringify({token:capability}),cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:currentController.signal
      });
      if(revision!==request)return;
      if(response.status===404){unavailable(false);return;}
      if(!response.ok)throw new Error('request');
      const next=await response.json();
      if(revision!==request)return;
      if(!Array.isArray(next.items)||!Array.isArray(next.teeth)||!Number.isFinite(next.total)||!Number.isFinite(new Date(next.expiresAt).getTime())||new Date(next.expiresAt)<=new Date())throw new Error('invalid');
      if(!preferred){language=next.language==='ar'?'ar':'en';document.documentElement.lang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';}
      const comparable=value=>JSON.stringify(value&&{...value,refreshedAt:undefined});
      if(comparable(data)!==comparable(next)){data=next;render();}
    } catch(_){if(revision===request)unavailable(true);}
    finally{clearTimeout(abortTimer);if(revision===request){loading=false;controller=null;}}
  }
  // Patient information stays in memory, with no offline or local-storage copy.
  window.addEventListener('hashchange',()=>{request++;controller?.abort();loading=false;data=null;clearTimeout(expiryTimer);container.classList.remove('q-document');container.replaceChildren();container.setAttribute('aria-busy','true');load();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});
  window.addEventListener('online',()=>load());
  document.addEventListener('gesturestart',event=>event.preventDefault(),{passive:false});
  document.addEventListener('touchmove',event=>{if(event.touches.length>1)event.preventDefault();},{passive:false});
  setInterval(()=>{if(!document.hidden)load();},30000);
  load();
})();
