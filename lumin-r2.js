/* R2 uses the existing Lumin sign-in. Cloudflare keys never enter the browser. */
(() => {
  const state = {token:'',userId:'',busy:false,checked:false,error:'',connected:false,layout:null};
  const t = (en,ar) => typeof currentUiLanguage !== 'undefined' && currentUiLanguage === 'ar' ? ar : en;
  const endpoint = () => `${location.origin}/r2`;
  const isR2 = url => String(url || '').replace(/\/+$/,'') === endpoint();
  const config = url => isR2(url) ? {url:endpoint(),key:state.token} : null;
  const preset = () => ({id:'preset-cloudflare-r2',name:'Cloudflare R2',url:endpoint(),key:state.token,icon:'cloud',provider:'r2'});
  const presets = list => [...list.filter(p=>p.id !== 'preset-cloudflare-r2' && !isR2(p.url)),preset()];
  const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  async function ensure() {
    const {data,error} = await db.auth.getSession();
    if (error || !data?.session?.access_token) { reset(); throw new Error(t('Sign in again to access R2 storage.','سجّل الدخول مجدداً للوصول إلى تخزين R2.')); }
    const userId = data.session.user.id;
    if (state.userId && state.userId !== userId) reset();
    const changed = state.token !== data.session.access_token;
    state.userId = userId; state.token = data.session.access_token;
    if (changed && typeof preloadChartXrayIndex === 'function') void preloadChartXrayIndex();
    return config(endpoint());
  }
  function reset() { Object.assign(state,{token:'',userId:'',checked:false,connected:false,error:'',layout:null}); }
  function card(p,active,switching,saving) {
    if (p.provider !== 'r2') return null;
    return `<article class="storage-server-card r2-card" data-active="${active}" data-storage-preset-id="preset-cloudflare-r2"><div class="drive-card-heading"><span class="drive-icon">${icon('cloud')}</span><h4>Cloudflare R2</h4><span class="drive-badge ${state.connected ? 'is-connected' : ''}">${active ? t('Active storage','التخزين النشط') : state.connected ? t('Connected','متصل') : t('Cloud storage','تخزين سحابي')}</span></div><p class="drive-note">${t('Private clinic media, available using your Lumin sign-in.','وسائط خاصة بالعيادة متاحة باستخدام حسابك في Lumin.')}</p>${active ? '<span data-active-storage-connection role="status"></span>' : ''}<div class="drive-actions"><button type="button" class="drive-action is-primary" onclick="switchToStoragePreset('preset-cloudflare-r2')" ${saving || switching || active || state.busy ? 'disabled' : ''} aria-pressed="${active}">${icon(switching ? 'loader-circle' : active ? 'check' : 'arrow-right-left')}${switching ? t('Switching…','جارٍ التبديل…') : active ? t('Selected','مُختار') : t('Use Cloudflare R2','استخدام Cloudflare R2')}</button><button type="button" class="drive-action" onclick="LuminR2.test()" ${state.busy || saving ? 'disabled' : ''}>${icon(state.busy ? 'loader-circle' : 'activity')}${state.busy ? t('Working…','جارٍ التنفيذ…') : t('Test R2','اختبار R2')}</button><button type="button" class="drive-action" onclick="LuminR2.organize()" ${state.busy || saving ? 'disabled' : ''}>${icon('folder-tree')}${t('Refresh patient folders','تحديث مجلدات المرضى')}</button></div><p class="drive-note" role="status">${state.checked && !state.error ? t('Connection verified · Up to 64 MB per file.','تم التحقق من الاتصال · حتى 64 ميجابايت لكل ملف.') : t('Switching does not copy existing files.','التبديل لا ينسخ الملفات الموجودة.')}</p><p class="drive-note" role="status">${state.layout ? (state.layout.status==='completed' && state.layout.unlinkedFiles ? t(`${state.layout.completedFiles} files linked · ${state.layout.unlinkedFiles} files need a recorded patient assignment.`, `تم ربط ${state.layout.completedFiles} ملفات · تحتاج ${state.layout.unlinkedFiles} ملفات إلى معرّف مريض محفوظ.`) : t(`${state.layout.completedFiles} / ${state.layout.totalFiles} files verified · ${state.layout.status === 'completed' ? 'Patient-name folders ready in Lumin Clinic.' : 'Checking patient folders…'}`,`تم التحقق من ${state.layout.completedFiles} / ${state.layout.totalFiles} ملفات · ${state.layout.status === 'completed' ? 'مجلدات أسماء المرضى جاهزة داخل Lumin Clinic.' : 'جارٍ فحص مجلدات المرضى…'}`)) : t('Patient-name folders inside Lumin Clinic.','مجلدات بأسماء المرضى داخل Lumin Clinic.')}</p>${state.error ? `<p class="drive-error" role="alert">${escapeHtml(state.error)}</p>` : ''}</article>`;
  }
  function render() {
    const active = isR2(typeof getStorageServerConfig === 'function' ? getStorageServerConfig().url : '');
    if (!active) return;
    for (const id of ['storage-location-card','storage-local-url-field','storage-local-key-field','btn-save-storage']) document.getElementById(id)?.classList.add('hidden');
  }
  async function test() {
    if (state.busy) return false;
    state.busy = true; state.error = ''; renderStorageServerPresets();
    try {
      const config = await ensure();
      const response = await fetch(`${config.url}/api/health`,{headers:{'x-lumin-key':config.key},cache:'no-store',signal:AbortSignal.timeout(15000)});
      const data = await response.json();
      if (!response.ok || data.service !== 'Lumin Cloudflare R2 Storage' || data.status !== 'online') throw new Error(t('Could not connect to R2. Check the connection and try again.','تعذر الاتصال بـ R2. تحقق من الاتصال ثم أعد المحاولة.'));
      if (typeof currentUserAccess !== 'undefined' && currentUserAccess?.isAdmin) {
        const check = await fetch(`${config.url}/api/self-test`,{method:'POST',headers:{'x-lumin-key':config.key},signal:AbortSignal.timeout(15000)});
        if (!check.ok || !(await check.json()).success) throw new Error(t('R2 could not verify file storage. Try again.','تعذر التحقق من حفظ الملفات في R2. أعد المحاولة.'));
      }
      state.connected = true; return true;
    } catch (error) { state.connected = false; state.error = error.message; return false; }
    finally { state.busy = false; state.checked = true; renderStorageServerPresets(); }
  }
  async function organize() {
    if(state.busy || typeof currentUserAccess === 'undefined' || !currentUserAccess?.isAdmin)return;
    window.LuminStorageSync?.close();
    state.busy=true;state.error='';renderStorageServerPresets();
    const invoke=async (path,attempt=0)=>{
      const config=await ensure();
      const response=await fetch(`${config.url}/api/cloud-sync/${path}`,{method:'POST',headers:{'x-lumin-key':config.key},signal:AbortSignal.timeout(120000)});
      const result=await response.json();
      if(response.status===409 && result.code==='sync_busy' && attempt<90){await new Promise(resolve=>setTimeout(resolve,1000));return invoke(path,attempt+1);}
      if(!response.ok)throw new Error(result.error || t('Could not organize the patient folders.','تعذر ترتيب مجلدات المرضى.'));return result;
    };
    try {
      state.layout=await invoke('layout/jobs');renderStorageServerPresets();
      while(state.layout.status==='running'){state.layout=await invoke(`layout/jobs/${encodeURIComponent(state.layout.id)}/step`);renderStorageServerPresets();}
      if(state.layout.status==='completed'){if(typeof resetChartPatientMediaCache==='function')resetChartPatientMediaCache();if(typeof preloadChartXrayIndex==='function')void preloadChartXrayIndex();}
      if(state.layout.status==='failed')throw new Error(state.layout.error || t('Folder organization could not finish. Retry to continue.','تعذر إكمال ترتيب المجلدات. أعد المحاولة للاستكمال.'));
    }catch(error){state.error=error.message;}
    finally{state.busy=false;renderStorageServerPresets();if(!document.getElementById('view-admin')?.classList.contains('hidden')&&!document.getElementById('admin-panel-storage')?.classList.contains('hidden'))window.LuminStorageSync?.open();}
  }
  window.LuminR2 = {endpoint,isR2,config,preset,presets,ensure,reset,card,render,test,organize};
})();
