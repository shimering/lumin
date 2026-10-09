const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const vm=require('node:vm');
const {chromium}=require('playwright');
const model=require('../lumin-quotation-model.js');
const root=path.resolve(__dirname,'..');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const formLogo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const operations=[{code:'rct',name:'Root canal treatment',price:3500,action_scope:'whole',visual_code:'rct'},{code:'crown',name:'Zirconium crown',price:5500,action_scope:'whole',visual_code:'zirconia_crown'},{code:'composite',name:'Composite restoration',price:1400,action_scope:'surface',visual_code:'composite'},{code:'scaling',name:'Scaling and polishing',price:900,action_scope:'mouth',visual_code:'none'}];
const chart={3:{wholeOperations:[{id:id(1),code:'rct',price:3500,status:'In'},{id:id(2),code:'crown',price:5500,status:'P'}]},19:{surfaces:{center:[{id:id(3),code:'composite',price:1400,status:'P'}],right:[{id:id(3),code:'composite',price:1400,status:'P'}]}},_meta:{mouthOperations:[{id:id(4),code:'scaling',price:900,status:'P'}]}};
const sample=()=>({reference:'QT-12345678',patientName:'Omar Hassan',language:'en',expiresAt:new Date(Date.now()+30*864e5).toISOString(),clinic:{name:'Noura Dental',logo:'',whatsapp:'201001234567'},...model.publicProjection(chart,operations,[1,2,3,4].map(id))});

test('public quotation navigation stays network-only inside an installed clinic PWA',async()=>{
  const listeners={},calls=[];
  new vm.Script(fs.readFileSync(path.join(root,'sw.js'),'utf8')).runInNewContext({
    self:{location:{origin:'https://clinic.invalid'},addEventListener:(name,handler)=>{listeners[name]=handler;}},URL,Response,
    fetch:async(request,options)=>{calls.push(options);throw new Error('offline');},
    caches:{match(){throw new Error('Must not read an offline patient page or clinic login');},open(){throw new Error('Must not cache patient navigation');}}
  });
  let response;
  for(const path of ['/quotation.html','/quotation?q='+'a'.repeat(64),'/quotation-logo?q='+'a'.repeat(64)]) {
    listeners.fetch({request:{method:'GET',url:'https://clinic.invalid'+path,mode:'navigate'},respondWith:promise=>{response=promise;}});
    const result=await response;
    assert.equal(result.status,503);assert.equal(calls.at(-1).cache,'no-store');assert.match(result.headers.get('cache-control'),/no-store/);
    assert.doesNotMatch(await result.text(),/sign in|password|patient-quotation/i);
  }
});
async function setup(t) {
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    const target=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!target.startsWith(root+path.sep)||!fs.existsSync(target)||!fs.statSync(target).isFile()){res.statusCode=404;res.end();return;}
    res.setHeader('Content-Type',target.endsWith('.html')?'text/html':target.endsWith('.css')?'text/css':target.endsWith('.svg')?'image/svg+xml':target.endsWith('.webp')?'image/webp':'application/javascript');res.end(fs.readFileSync(target));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  // Headless Chrome hides native scrollbars by default; keep them visible for layout and drag checks.
  const browser=await chromium.launch({headless:true,ignoreDefaultArgs:['--hide-scrollbars'],channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||'chrome'});
  t.after(()=>browser.close());
  const context=await browser.newContext({timezoneId:'Africa/Cairo'});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  return {page,context,errors,base:`http://127.0.0.1:${server.address().port}`};
}

test('patient page charts only quoted treatments, works in both languages and viewports, and prints without clipping',async t=>{
  const {page,errors,base}=await setup(t);
  const calls=[];
  await page.route('**/functions/v1/quotation-view',route=>{calls.push(route.request());return route.fulfill({json:sample()});});
  await page.goto(base+'/quotation.html#'+'a'.repeat(64));
  await page.waitForSelector('.q-procedure');
  await page.waitForFunction(()=>[...document.querySelectorAll('.q-tooth img')].every(image=>image.complete&&image.naturalWidth>0));
  assert.equal(await page.locator('.q-procedure').count(),4);
  assert.equal(await page.locator('html').getAttribute('lang'),'ar');
  assert.equal(await page.locator('html').getAttribute('dir'),'rtl');
  assert.match(await page.locator('.q-total').textContent(),/١١٬٣٠٠/);
  assert.equal(await page.locator('[data-q-item="2"] .q-procedure-copy > strong').textContent(),'تاج زركونيا');
  assert.equal(await page.locator('[data-q-item="2"] .q-procedure-copy > strong').evaluate(node=>getComputedStyle(node).direction),'rtl');
  assert.equal(await page.locator('[data-q-item="2"] .q-palmer text').textContent(),'6');
  assert.equal(await page.locator('[data-q-item="2"] .q-palmer path').getAttribute('d'),'M33 4 V23 H4');
  assert.equal(await page.locator('.q-procedure [data-lucide="gem"]').count(),0);
  assert.equal(calls[0].method(),'POST');assert.equal(calls[0].postDataJSON().token,'a'.repeat(64));assert.equal(calls[0].headers().referer,undefined);
  for(const viewport of [{width:320,height:740},{width:390,height:844},{width:768,height:1024},{width:834,height:1112},{width:1052,height:884},{width:1440,height:1000}]) {
    await page.setViewportSize(viewport);
    for(const language of ['en','ar']) {
      if(await page.locator('html').getAttribute('lang')!==language)await page.locator('[data-q-language]').click();
      assert.doesNotMatch(await page.locator('.q-total').textContent(),/[.٫][0-9٠-٩]{2}/);
      for(const price of await page.locator('.q-price').allTextContents())assert.doesNotMatch(price,/[.٫][0-9٠-٩]{2}/);
      const title=page.locator('[data-q-item="2"] .q-procedure-copy > strong');
      assert.equal(await title.textContent(),language==='ar'?'تاج زركونيا':'Zirconium crown');
      const badge=await page.locator('[data-q-item="2"] .q-procedure-teeth').boundingBox(),copy=await title.boundingBox();
      assert.ok(language==='ar'?badge.x>copy.x:badge.x<copy.x);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      const headingFit=await page.locator('.q-heading h1').evaluate(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,width:document.documentElement.clientWidth};});
      assert.ok(headingFit.left>=0&&headingFit.right<=headingFit.width,JSON.stringify({viewport,language,headingFit}));
      const buttons=await page.locator('.q-tooth:not(:disabled),.q-button').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {w:r.width,h:r.height};}));
      assert.ok(buttons.every(button=>button.w>=43.9&&button.h>=43.9));
      await page.locator('[data-q-item="1"]').click();
      assert.equal(await page.locator('[data-q-tooth="3"]').getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('[data-q-tooth="19"]').getAttribute('aria-pressed'),'false');
      await page.locator('[data-q-item="3"]').click();
      assert.equal(await page.locator('[data-q-tooth="19"]').getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('[data-q-tooth="19"] .q-surface.q-planned').count(),2);
      assert.equal(await page.locator('[data-q-tooth="3"] [id*="rct-layer-"]').evaluate(node=>getComputedStyle(node).display),'block');
    }
  }
  await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('[data-q-print]').isVisible(),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  if(process.env.LUMIN_QUOTATION_SCREENSHOTS) {
    await page.emulateMedia({media:'screen'});
    await page.setViewportSize({width:1200,height:1100});
    await page.screenshot({path:path.join(process.env.LUMIN_QUOTATION_SCREENSHOTS,'quotation-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>{window.scrollTo(0,0);return new Promise(requestAnimationFrame);});
    await page.screenshot({path:path.join(process.env.LUMIN_QUOTATION_SCREENSHOTS,'quotation-mobile.png')});
  }
});

test('quotation uses the clinic tooth images and orientations for permanent and primary teeth, with working photo treatment overlays',async t=>{
  const {page,base,errors}=await setup(t);
  const fixtureChart=structuredClone(chart);
  fixtureChart._meta.toothDentition={6:'primary',25:'primary'};
  fixtureChart.C={wholeOperations:[{id:id(5),code:'rct',price:1200,status:'P'}]};
  fixtureChart.P={wholeOperations:[{id:id(6),code:'bracket',price:600,status:'In'}]};
  fixtureChart[20]={wholeOperations:[{id:id(7),code:'implant',price:7000,status:'P'}]};
  const catalog=[...operations,{code:'implant',name:'Implant',action_scope:'whole',visual_code:'implant'},{code:'bracket',name:'Orthodontic bracket',action_scope:'whole',visual_code:'bracket'}];
  const data={...sample(),...model.publicProjection(fixtureChart,catalog,[1,2,3,4,5,6,7].map(id))};
  await page.route('**/functions/v1/quotation-view',route=>route.fulfill({json:data}));
  await page.goto(base+'/quotation.html#'+'a'.repeat(64));
  await page.waitForFunction(()=>document.querySelectorAll('.q-tooth img').length===64&&[...document.querySelectorAll('.q-tooth img')].every(image=>image.complete&&image.naturalWidth>0));
  for(const [tooth,value,bracket] of [['3','6','M33 4 V23 H4'],['19','6','M7 24 V5 H36'],['C','C','M33 4 V23 H4'],['P','A','M33 24 V5 H4']]) {
    const index=data.items.findIndex(item=>item.targets.some(target=>target.toothId===tooth));
    const badge=page.locator(`[data-q-item="${index}"] .q-palmer`);
    assert.equal(await badge.locator('text').textContent(),value);
    assert.equal(await badge.locator('path').getAttribute('d'),bracket);
  }
  const app=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const start=app.indexOf('    function generateRealisticToothPhoto('),end=app.indexOf('\n    }',start)+6;
  const clinic=vm.createContext({showRootsAnatomy:true});
  new vm.Script(fs.readFileSync(path.join(root,'lumin-tooth-anatomy.js'),'utf8')).runInContext(clinic);
  new vm.Script(app.slice(start,end)).runInContext(clinic);
  const reference=await page.context().newPage();
  const head=app.slice(0,app.indexOf('</head>')+7).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  const references=['3','4','8','11','14','19','20','27','C','P'];
  const clinicMarkup=references.map(tooth=>`<div class="tooth-card">${clinic.generateRealisticToothPhoto(tooth,model.slotForTooth(tooth))}</div>`).join('');
  await reference.route(base+'/clinic-chart-reference',route=>route.fulfill({contentType:'text/html',body:`${head}<body><main id="app-shell"><section class="clinical-odontogram-stage">${clinicMarkup}</section></main></body>`}));
  await reference.goto(base+'/clinic-chart-reference');
  await reference.evaluate(()=>{const layer=document.getElementById('rct-layer-3');layer.classList.remove('hidden');layer.classList.add('operation-status-in');});
  assert.equal(await reference.locator('#rct-layer-3').evaluate(node=>getComputedStyle(node).getPropertyValue('--operation-status-color').trim()),'#2563eb');
  for(const toothId of ['3','4','8','11','14','19','20','27','C','P']) {
    const markup=clinic.generateRealisticToothPhoto(toothId,model.slotForTooth(toothId));
    const comparison=await page.evaluate(({toothId,markup})=>{
      const template=document.createElement('template');template.innerHTML=markup;
      const appImage=template.content.querySelector('.tooth-photo');
      const quoteImage=document.querySelector(`[data-q-tooth="${toothId}"] .tooth-photo`);
      return {app:{source:appImage.getAttribute('src'),classes:appImage.className},quotation:{source:quoteImage.getAttribute('src'),classes:quoteImage.className},fit:getComputedStyle(quoteImage).objectFit};
    },{toothId,markup});
    assert.deepEqual(comparison.quotation,comparison.app);assert.equal(comparison.fit,'contain');
    assert.equal(await reference.locator(`#tooth-photo-${toothId}`).evaluate(node=>getComputedStyle(node).transform),await page.locator(`[data-q-tooth="${toothId}"] .tooth-photo:not(.tooth-crown-color-overlay)`).evaluate(node=>getComputedStyle(node).transform));
  }
  assert.equal(await page.locator('[data-q-tooth="C"] .tooth-photo.is-primary-photo.is-upper-photo.is-mirrored-photo').count(),2);
  assert.equal(await page.locator('[data-q-tooth="P"] .tooth-photo.is-primary-photo.is-mirrored-photo:not(.is-upper-photo)').count(),2);
  assert.equal(await page.locator('[data-q-tooth="3"] .tooth-crown-color-overlay').evaluate(node=>getComputedStyle(node).opacity),'1');
  for(const [tooth,color] of [['3','#2563eb'],['C','#d97706']]) {
    const layer=page.locator(`[data-q-tooth="${tooth}"] .photo-rct-mask`);
    assert.equal(await layer.evaluate(node=>getComputedStyle(node).display),'block');
    assert.equal(await layer.evaluate(node=>node.style.getPropertyValue('--operation-status-color')),color);
    assert.ok(await layer.locator('.rct-canal').count()>0);
  }
  assert.equal(await page.locator('[data-q-tooth="20"] .photo-implant').isVisible(),true);
  assert.equal(await page.locator('[data-q-tooth="P"] .photo-bracket').isVisible(),true);
  assert.deepEqual(errors,[]);
});

test('Palmer badges preserve the upper-left orientation and grouped tooth numbers in Arabic',async t=>{
  const {page,base,errors}=await setup(t);
  const batchChart={14:{wholeOperations:[{id:id(10),batchId:id(50),code:'crown',price:3500.25,status:'P'}]},30:{wholeOperations:[{id:id(11),batchId:id(50),code:'crown',price:3500.25,status:'P'}]}};
  const data={...sample(),...model.publicProjection(batchChart,operations,[id(10),id(11)])};
  await page.route('**/functions/v1/quotation-view',route=>route.fulfill({json:data}));
  await page.goto(base+'/quotation.html?q='+'a'.repeat(64));await page.waitForSelector('.q-procedure');
  assert.equal(await page.locator('.q-procedure').count(),1);
  assert.equal(await page.locator('.q-palmer').count(),2);
  assert.deepEqual(await page.locator('.q-palmer text').allTextContents(),['6','6']);
  assert.deepEqual(await page.locator('.q-palmer path').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('d'))),['M7 4 V23 H36','M33 24 V5 H4']);
  assert.match(await page.locator('.q-total').textContent(),/٧٬٠٠١/);
  assert.doesNotMatch(await page.locator('.q-price').textContent(),/[.٫][0-9٠-٩]{2}/);
  await page.setViewportSize({width:320,height:740});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('.q-procedure').click();
  assert.equal(await page.locator('[data-q-tooth="14"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('[data-q-tooth="30"]').getAttribute('aria-pressed'),'true');
  assert.deepEqual(errors,[]);
});

test('the same token follows form logo changes, prices and completion, then clears patient information on revocation or network failure',async t=>{
  const {page,base,errors}=await setup(t);
  let response=sample(),status=200,offline=false;
  response.clinic.logo=formLogo;
  await page.route('**/functions/v1/quotation-view',route=>offline?route.abort('failed'):route.fulfill({status,json:status===200?response:{error:'Quotation unavailable.'}}));
  await page.goto(base+'/quotation.html#'+'a'.repeat(64));await page.waitForSelector('.q-procedure');
  await page.locator('[data-q-language]').click();
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.equal(await page.locator('.q-clinic-logo').getAttribute('src'),formLogo);
  assert.equal(await page.locator('#quotation-favicon').getAttribute('href'),formLogo);
  assert.match(await page.title(),/Noura Dental/);
  const updatedLogo=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=2;const ctx=canvas.getContext('2d');ctx.fillStyle='#2563eb';ctx.fillRect(0,0,2,2);return canvas.toDataURL('image/png');});
  response.clinic.logo=updatedLogo;
  response.items=response.items.filter(item=>item.visualCode!=='rct');response.total=7800;
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>document.querySelectorAll('.q-procedure').length===3);
  assert.match(await page.locator('.q-total').textContent(),/7,800/);
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.equal(await page.locator('.q-clinic-logo').getAttribute('src'),updatedLogo);
  assert.equal(await page.locator('#quotation-favicon').getAttribute('href'),updatedLogo);
  response.clinic.logo='';await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>!document.querySelector('.q-clinic-logo'));
  assert.equal(await page.locator('#quotation-favicon').getAttribute('href'),'favicon.svg');
  status=404;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForSelector('.q-page-status h1');
  assert.doesNotMatch(await page.locator('main').textContent(),/Omar|7,800|Noura/);
  assert.equal(await page.locator('.q-procedure').count(),0);
  assert.doesNotMatch(await page.locator('head').textContent(),/Omar|Noura/);
  assert.doesNotMatch(await page.locator('meta[property="og:description"]').getAttribute('content'),/Omar/);
  await page.reload();status=200;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForSelector('.q-procedure');
  offline=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForSelector('[data-retry]');
  assert.doesNotMatch(await page.locator('main').textContent(),/Omar|Noura/);
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  assert.deepEqual(errors,[]);
});

test('patient Quotations tab supports editing, deletion, pagination and patient switching in bilingual responsive layouts',async t=>{
  const {page,base,errors}=await setup(t);
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const head=html.slice(0,html.indexOf('</head>')+7).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  const group=html.match(/<div id="findings-selection-actions"[\s\S]*?<\/div>/)[0];
  const quotationSection=html.match(/<section id="view-patient-quotations"[\s\S]*?<\/section>/)[0];
  const workspaceHeader=html.match(/<header id="patient-workspace-header"[\s\S]*?<\/header>/)[0];
  const source=name=>{let start=html.indexOf('    function '+name+'(');if(start<0)start=html.indexOf('    async function '+name+'(');assert.ok(start>=0,name);return html.slice(start,html.indexOf('\n    }',start)+6);};
  await page.route(base+'/staff',route=>route.fulfill({contentType:'text/html',body:`${head}<body class="lumin-raised"><div id="app-shell"><main id="app-main" class="w-full p-4 sm:p-6">${workspaceHeader}<div id="chart-selection-fixture">${group}</div><button id="history" onclick="openPatientQuotations()">History</button>${quotationSection}<div id="admin-quotation-settings"></div><form id="admin-prescription-print-form" class="hidden"><section><input id="prescription-print-logo-file" type="file"/></section></form></main></div></body>`}));
  await page.goto(base+'/staff');
  await page.addScriptTag({path:path.join(root,'vendor/lucide.min.js')});
  for(const filename of ['lumin-quotation-model.js','lumin-dental-i18n.js','lumin-tooth-anatomy.js','lumin-quotation-view.js'])await page.addScriptTag({path:path.join(root,filename)});
  await page.addScriptTag({content:`
    let currentUiLanguage='en',currentSession={user:{id:'staff'}},currentUserAccess={isAdmin:true},activePatientId='${id(90)}',activeWorkspacePatientId=activePatientId,patientWorkspaceReturnView='patients';
    let selectedFindingIds=new Set(['${id(1)}','${id(2)}']),invoicedFindingIds=new Set(),chartInvoiceStateLoading=false;
    const chart=${JSON.stringify(chart)},dentalOperations=${JSON.stringify(operations)};
    const patient={id:activePatientId,name:'Omar Hassan',phone:'01001234567',chartState:chart};
    const settings={clinic_name:'Noura Dental',logo_data_url:'${formLogo}',whatsapp_phone:'201001234567'};
    let savedQuote=null;window.payloads=[];window.canChart=true;window.failHistory=false;window.delayHistory=false;
    function getActivePatient(){return patient;} function patientWorkspaceId(){return activePatientId;} function hasPageAccess(page){return page!=='chart'||window.canChart;}
    function rememberPatientWorkspaceOrigin(){} function currentPatientAge(){return null;} function formatPatientNumber(){return '001';}
    function translateUiTree(){} function syncLoyaltyVisibility(){} function canViewPatientLoyalty(){return true;} function canViewPatientAppointments(){return true;} function canViewPatientPrescriptions(){return true;} function canViewPatientInvoices(){return true;}
    async function switchView(name){window.openedView=name;resetQuotationUi();document.getElementById('chart-selection-fixture').classList.toggle('hidden',name!=='chart');document.getElementById('history').hidden=name==='patient-quotations';document.getElementById('view-patient-quotations').classList.toggle('hidden',name!=='patient-quotations');updatePatientWorkspaceNavigation(patient,name==='patient-quotations'?'quotations':'chart');if(name==='patient-quotations')await renderPatientQuotations();}
    async function saveActivePatientChart(){return true;} async function waitForPatientChartSaves(){}
    function setStableHtml(element,markup){element.innerHTML=markup;return true;} function renderChartFindingIcons(){lucide.createIcons();} function escapeHtml(value){return String(value);}
    function showAppointmentNotificationToast(){} function invoiceSelectedFindings(){window.invoiceSelection=[...selectedFindingIds];}
    const db={from(table){const query={select(){return query},eq(){return query},single(){return Promise.resolve({data:{id:patient.id,name:patient.name,phone:patient.phone,chart_state:chart}})},then(resolve){return Promise.resolve({data:dentalOperations}).then(resolve)}};return query;},functions:{async invoke(name,{body}){
      window.payloads.push(body);if(body.action==='settings')return{data:{settings}};
      if(body.action==='list'){
        if(window.failHistory)return{error:{}};
        const rows=window.extraQuotes||(savedQuote&&savedQuote.patient_id===body.patient_id?[savedQuote]:[]),offset=body.offset||0;
        const result={data:{quotations:rows.slice(offset,offset+50),has_more:rows.length>offset+50}};
        if(window.delayHistory)return new Promise(resolve=>window.resolveHistory=()=>resolve(result));return result;
      }
      if(body.action==='get')return{data:{quotation:savedQuote}};
      if(body.action==='delete'){if(window.staleDelete)return{data:{error:'This quotation changed. Reopen it before saving.'}};const deleted_id=savedQuote.id;savedQuote=null;return{data:{deleted_id}};}
      if(body.action==='revoke'){savedQuote={...savedQuote,revoked_at:new Date().toISOString(),revision:savedQuote.revision+1};return{data:{quotation:savedQuote}};}
      if(body.action==='create'||body.action==='update'){savedQuote={...savedQuote,...body,id:'${id(99)}',token:'${'b'.repeat(64)}',patient_id:patient.id,revision:(savedQuote?.revision||0)+1,created_at:savedQuote?.created_at||new Date().toISOString()};return{data:{quotation:savedQuote}};}
      return{data:{settings}};
    }}};
    ${['setupPatientWorkspaceTabScrolling','openPatientWorkspace','openPatientWorkspaceTab','updatePatientWorkspaceNavigation','chartFindingBillingMultiplier','chartFindingBatchTotal','chartFindingInvoiceAmounts','formatInvoiceMoney','renderFindingInvoiceToolbar'].map(source).join('\n')}
  `});
  await page.addScriptTag({path:path.join(root,'lumin-quotations.js')});
  await page.evaluate(()=>{document.getElementById('patient-workspace-header').classList.remove('hidden');setupPatientWorkspaceTabScrolling();updatePatientWorkspaceNavigation(patient,'chart');});
  assert.doesNotMatch(html,/profile-quotations-button/);
  for(const name of ['محمد حسن الزواوي','محمد عبد الرحمن حسن عبد العزيز الزواوي','Alexandria Catherine Montgomery Williams']) {
    for(const viewport of [{width:320,height:740},{width:390,height:844},{width:768,height:1024},{width:834,height:1112},{width:1052,height:884},{width:1304,height:884},{width:1440,height:900}]) {
      await page.setViewportSize(viewport);
      for(const lang of ['en','ar']) {
        await page.evaluate(({name,lang})=>{patient.name=name;currentUiLanguage=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';updatePatientWorkspaceNavigation(patient,'profile');},{name,lang});
        const fit=await page.locator('.patient-workspace-name').evaluate(node=>{
          const range=document.createRange();range.selectNodeContents(node);
          const tab=node.closest('button').getBoundingClientRect(),header=document.getElementById('patient-workspace-header').getBoundingClientRect();
          return {text:node.textContent,ellipsis:getComputedStyle(node).textOverflow,visible:[...range.getClientRects()].every(rect=>rect.left>=tab.left&&rect.right<=tab.right&&rect.top>=header.top&&rect.bottom<=header.bottom&&rect.left>=0&&rect.right<=innerWidth)};
        });
        assert.equal(fit.text,name);assert.notEqual(fit.ellipsis,'ellipsis');assert.equal(fit.visible,true,`${name}, ${viewport.width}px, ${lang}`);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      }
      if(process.env.LUMIN_QUOTATION_SCREENSHOTS&&name==='محمد حسن الزواوي'&&viewport.width===1052)await page.screenshot({path:path.join(process.env.LUMIN_QUOTATION_SCREENSHOTS,'patient-name-tablet.png')});
    }
  }
  await page.evaluate(()=>{patient.name='Omar Hassan';currentUiLanguage='en';document.documentElement.dir='ltr';updatePatientWorkspaceNavigation(patient,'chart');});
  await page.setViewportSize({width:1052,height:884});
  for(const lang of ['en','ar']) {
    await page.evaluate(async lang=>{currentUiLanguage=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';updatePatientWorkspaceNavigation(patient,'profile');await new Promise(requestAnimationFrame);document.querySelector('.patient-workspace-tabs').scrollLeft=0;},lang);
    const tabs=page.locator('.patient-workspace-tabs');
    const scrollbar=await tabs.evaluate(node=>({width:getComputedStyle(node).scrollbarWidth,custom:CSS.supports('selector(::-webkit-scrollbar)'),height:getComputedStyle(node,'::-webkit-scrollbar').height,display:getComputedStyle(node,'::-webkit-scrollbar').display,overflow:getComputedStyle(node).overflowX,space:node.offsetHeight-node.clientHeight,overflowWidth:node.scrollWidth-node.clientWidth}));
    assert.equal(scrollbar.width,scrollbar.custom?'auto':'thin');
    if(scrollbar.custom){assert.equal(scrollbar.height,'8px');assert.ok(scrollbar.space>=7,JSON.stringify(scrollbar));}
    await page.waitForFunction(()=>Math.abs(document.querySelector('.patient-workspace-tabs').scrollLeft)<1,null,{timeout:5000});
    const bounds=await tabs.boundingBox();await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
    await page.mouse.wheel(0,240);
    await page.waitForFunction(()=>Math.abs(Math.abs(document.querySelector('.patient-workspace-tabs').scrollLeft)-240)<1,null,{timeout:5000});
    assert.equal(await tabs.evaluate(node=>Math.sign(node.scrollLeft)),lang==='ar'?-1:1);
    await page.mouse.wheel(0,-240);
    await page.waitForFunction(()=>Math.abs(document.querySelector('.patient-workspace-tabs').scrollLeft)<1,null,{timeout:5000});
    const thumbWidth=await tabs.evaluate(node=>node.clientWidth/node.scrollWidth*node.clientWidth);
    const thumbStart=lang==='ar'?bounds.x+bounds.width-thumbWidth/2:bounds.x+thumbWidth/2;
    await page.mouse.move(thumbStart,bounds.y+bounds.height-4);
    await page.mouse.down();await page.mouse.move(thumbStart+(lang==='ar'?-80:80),bounds.y+bounds.height-4,{steps:8});await page.mouse.up();
    await page.waitForFunction(()=>Math.abs(document.querySelector('.patient-workspace-tabs').scrollLeft)>50,null,{timeout:5000});
    assert.equal(await tabs.evaluate(node=>{
      const rtl=getComputedStyle(node).direction==='rtl';node.scrollLeft=rtl?-(node.scrollWidth-node.clientWidth):node.scrollWidth-node.clientWidth;
      const event=new WheelEvent('wheel',{deltaY:100,cancelable:true});node.dispatchEvent(event);return event.defaultPrevented;
    }),false);
    assert.equal(await tabs.evaluate(node=>{node.scrollLeft=0;const event=new WheelEvent('wheel',{deltaY:100,ctrlKey:true,cancelable:true});node.dispatchEvent(event);return event.defaultPrevented;}),false);
  }
  await page.evaluate(()=>{currentUiLanguage='en';document.documentElement.dir='ltr';updatePatientWorkspaceNavigation(patient,'profile');lucide.createIcons();});
  const hoveredTab=page.locator('[data-patient-workspace-tab="chart"]');
  await page.mouse.move(0,0);
  const normalShadow=await hoveredTab.evaluate(node=>getComputedStyle(node).boxShadow);
  await hoveredTab.hover();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-patient-workspace-tab="chart"]')).boxShadow.includes('59, 130, 246'));
  assert.notEqual(await hoveredTab.evaluate(node=>getComputedStyle(node).boxShadow),normalShadow);
  if(process.env.LUMIN_QUOTATION_SCREENSHOTS)await page.locator('#patient-workspace-header').screenshot({path:path.join(process.env.LUMIN_QUOTATION_SCREENSHOTS,'patient-tabs-hover.png')});
  await page.evaluate(()=>updatePatientWorkspaceNavigation(patient,'chart'));
  await page.evaluate(()=>renderFindingInvoiceToolbar([{id:patient.chartState[3].wholeOperations[0].id,price:3500},{id:patient.chartState[3].wholeOperations[1].id,price:5500}]));
  for(const viewport of [{width:390,height:844},{width:834,height:1112},{width:1440,height:900}]) {
    await page.setViewportSize(viewport);
    const a=await page.locator('#findings-invoice-button').boundingBox(),b=await page.locator('#findings-quotation-button').boundingBox();
    assert.ok(b.x>=a.x+a.width&&b.x+b.width<=viewport.width&&b.width>=44&&b.height>=44);
  }
  await page.locator('#findings-invoice-button').click();assert.deepEqual(await page.evaluate(()=>window.invoiceSelection),[id(1),id(2)]);
  await page.locator('#findings-quotation-button').click();await page.waitForSelector('#quotation-expiry');
  assert.equal(await page.locator('#quotation-preview .q-procedure').count(),1);
  assert.equal(await page.locator('#quotation-preview').getAttribute('dir'),'rtl');
  assert.equal(await page.locator('#quotation-preview .q-procedure-copy > strong').textContent(),'تاج زركونيا');
  assert.equal(await page.locator('#quotation-preview .q-clinic-logo').getAttribute('src'),formLogo);
  assert.match(await page.locator('.q-feedback:not([hidden])').textContent(),/Only selected/);
  await page.locator('[data-quote-action=save]').click();await page.waitForSelector('.q-link-field');
  const payload=await page.evaluate(()=>window.payloads.find(body=>body.action==='create'));
  assert.deepEqual(payload.selected_ids,[id(2)]);assert.ok(new Date(payload.expires_at)>new Date());
  assert.equal(payload.language,'ar');
  assert.match(await page.locator('.q-link-field input').inputValue(),/quotation\.html\?q=[b]{64}$/);
  await page.evaluate(()=>{window.open=url=>{window.sharedQuotationUrl=url;};});
  await page.locator('[data-quote-action=whatsapp]').click();
  const message=new URL(await page.evaluate(()=>window.sharedQuotationUrl)).searchParams.get('text');
  assert.match(message,/مرحباً Omar Hassan، إليك عرض أسعار علاجك/);
  await page.keyboard.press('Escape');assert.equal(await page.locator('.q-overlay').count(),0);
  await page.locator('#history').click();await page.waitForSelector('.q-history-card');
  assert.equal(await page.evaluate(()=>window.openedView),'patient-quotations');
  assert.equal(await page.locator('[data-patient-workspace-tab=quotations]').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('.q-overlay').count(),0);
  await page.locator('[data-quote-action=edit]').click();await page.waitForSelector('#quotation-expiry');
  await page.locator('[data-quote-procedure][value="'+id(4)+'"]').check();
  await page.locator('[data-quote-procedure][value="'+id(2)+'"]').uncheck();
  assert.equal(await page.locator('#quotation-preview .q-procedure').count(),1);
  assert.match(await page.locator('#quotation-preview .q-procedure').textContent(),/تنظيف جير وتلميع الأسنان/);
  await page.locator('[data-quote-action=save]').click();
  await page.waitForFunction(()=>window.payloads.some(body=>body.action==='update'));
  const edited=await page.evaluate(()=>window.payloads.find(body=>body.action==='update'));
  assert.deepEqual(edited.selected_ids,[id(4)]);assert.equal(edited.revision,1);
  assert.equal(edited.language,'ar');
  await page.waitForFunction(()=>document.querySelector('.q-history-value')?.textContent.includes('900'));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-patient-workspace-tab=quotations]').evaluate(node=>node===document.activeElement),true);
  await page.evaluate(()=>{savedQuote.expires_at=new Date(Date.now()-864e5).toISOString();renderPatientQuotations();});
  await page.waitForFunction(()=>document.querySelector('.q-history-card .q-badge')?.textContent==='Expired');
  await page.locator('.q-history-card [data-quote-action=edit]').click();await page.waitForSelector('#quotation-expiry');
  assert.equal(await page.locator('.q-link-field').count(),0);
  await page.locator('[data-quote-action=save]').click();await page.waitForSelector('.q-link-field');
  assert.match(await page.locator('.q-link-field input').inputValue(),/quotation\.html\?q=[b]{64}$/);
  await page.waitForFunction(()=>document.querySelector('.q-history-card .q-badge')?.textContent==='Active');
  await page.keyboard.press('Escape');
  for(const viewport of [{width:390,height:844},{width:834,height:1112},{width:1440,height:900}]){
    await page.setViewportSize(viewport);
    for(const language of ['en','ar']){
      await page.evaluate(lang=>{currentUiLanguage=lang;refreshQuotationLanguage();},language);
      await page.waitForFunction(()=>!document.querySelector('#patient-quotations-content').hasAttribute('aria-busy'));
      assert.equal(await page.locator('#view-patient-quotations').getAttribute('dir'),language==='ar'?'rtl':'ltr');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      const targets=await page.locator('.q-history-actions .q-button,[data-patient-workspace-tab=quotations]').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return [r.width,r.height];}));
      assert.ok(targets.every(([w,h])=>w>=43.9&&h>=43.9));
      if(process.env.LUMIN_QUOTATION_SCREENSHOTS&&language==='en'&&viewport.width!==834)await page.screenshot({path:path.join(process.env.LUMIN_QUOTATION_SCREENSHOTS,viewport.width===390?'quotations-tab-mobile.png':'quotations-tab-desktop.png'),fullPage:true});
    }
  }
  await page.locator('.q-history-card [data-quote-action=delete]').click();
  assert.equal(await page.locator('.q-confirm-dialog').count(),1);
  await page.locator('.q-confirm-dialog [data-quote-action=close]').last().click();
  assert.equal(await page.evaluate(()=>window.payloads.filter(body=>body.action==='delete').length),0);
  await page.locator('.q-history-card [data-quote-action=revoke]').click();
  await page.locator('.q-confirm-dialog [data-quote-action=revoke]').click();
  await page.waitForFunction(()=>document.querySelector('.q-history-card .q-badge')?.textContent==='معطل');
  await page.locator('.q-history-card [data-quote-action=edit]').click();await page.waitForSelector('#quotation-expiry');
  assert.equal(await page.locator('.q-link-field').count(),0);
  assert.equal(await page.locator('[data-quote-action=whatsapp]').count(),0);
  await page.keyboard.press('Escape');
  await page.evaluate(()=>window.staleDelete=true);
  await page.locator('.q-history-card [data-quote-action=delete]').click();await page.locator('.q-confirm-dialog [data-quote-action=delete]').click();
  await page.waitForSelector('[data-quote-feedback]:not([hidden])');
  assert.match(await page.locator('[data-quote-feedback]').textContent(),/تغيّر/);
  await page.keyboard.press('Escape');await page.evaluate(()=>window.staleDelete=false);
  await page.locator('.q-history-card [data-quote-action=delete]').click();await page.locator('.q-confirm-dialog [data-quote-action=delete]').click();
  await page.waitForFunction(()=>!document.querySelector('.q-history-card')&&!document.querySelector('.q-overlay'));
  assert.match(await page.locator('#patient-quotations-content').textContent(),/لا توجد عروض أسعار/);
  await page.evaluate(()=>{window.extraQuotes=Array.from({length:51},(_,i)=>({id:'00000000-0000-4000-8000-'+String(100+i).padStart(12,'0'),patient_id:activePatientId,selected_ids:['${id(4)}'],expires_at:new Date(Date.now()+864e5).toISOString(),token:'b'.repeat(64)}));renderPatientQuotations();});
  await page.waitForFunction(()=>document.querySelectorAll('.q-history-card').length===50);
  await page.locator('[data-quote-action=more]').click();await page.waitForFunction(()=>document.querySelectorAll('.q-history-card').length===51);
  assert.equal(await page.locator('[data-quote-action=more]').count(),0);
  await page.evaluate(()=>{window.extraQuotes=null;savedQuote=null;});
  await page.evaluate(()=>{window.failHistory=true;renderPatientQuotations();});await page.waitForSelector('[data-quote-action=refresh]');
  await page.evaluate(()=>window.failHistory=false);await page.locator('[data-quote-action=refresh]').click();
  await page.waitForSelector('#patient-quotations-content [data-quote-action=chart]');
  await page.evaluate(()=>{savedQuote={id:'${id(99)}',patient_id:activePatientId,selected_ids:['${id(4)}'],expires_at:new Date(Date.now()+864e5).toISOString(),token:'b'.repeat(64)};window.delayHistory=true;renderPatientQuotations();});await page.waitForFunction(()=>Boolean(window.resolveHistory));
  await page.evaluate(()=>{activePatientId='${id(91)}';patient.id=activePatientId;window.delayHistory=false;renderPatientQuotations();});
  await page.waitForSelector('#patient-quotations-content [data-quote-action=chart]');
  await page.evaluate(()=>window.resolveHistory());
  assert.equal(await page.locator('.q-history-card').count(),0);
  await page.evaluate(()=>{window.canChart=false;resetQuotationUi();updatePatientWorkspaceNavigation(patient,'profile');});
  assert.equal(await page.locator('[data-patient-workspace-tab=quotations]').isVisible(),false);
  assert.equal(await page.locator('#patient-quotations-content').textContent(),'');
  await page.evaluate(()=>window.canChart=true);
  await page.evaluate(()=>{selectedFindingIds=new Set();renderFindingInvoiceToolbar([]);});
  assert.equal(await page.locator('#findings-selection-actions').isVisible(),false);
  await page.evaluate(()=>{currentUiLanguage='ar';renderQuotationSettings();});await page.waitForSelector('#admin-quotation-settings form');
  assert.match(await page.locator('#admin-quotation-settings h3').textContent(),/إعدادات/);
  assert.equal(await page.locator('#admin-quotation-settings').getAttribute('dir'),'rtl');
  assert.equal(await page.locator('#admin-quotation-settings .q-logo-preview').getAttribute('src'),formLogo);
  assert.equal(await page.locator('#admin-quotation-settings input[type=file]').count(),0);
  await page.locator('[data-form-logo]').click();
  assert.match(await page.locator('[data-form-logo]').textContent(),/إدارة شعار النموذج/);
  await page.locator('[name=clinic_name]').fill('Updated clinic');
  await page.evaluate(()=>refreshQuotationFormLogo(''));
  assert.equal(await page.locator('#admin-quotation-settings .q-logo-preview').count(),0);
  assert.match(await page.locator('.q-shared-logo').textContent(),/لم يُحفظ شعار/);
  assert.equal(await page.locator('[name=clinic_name]').inputValue(),'Updated clinic');
  await page.evaluate(logo=>refreshQuotationFormLogo(logo),formLogo);
  await page.locator('[name=whatsapp_phone]').fill('+20 1001234567');
  await page.locator('#admin-quotation-settings [type=submit]').click();
  await page.waitForFunction(()=>window.payloads.some(body=>body.action==='save_settings'&&body.clinic_name==='Updated clinic'));
  assert.equal(await page.evaluate(()=>Object.hasOwn(window.payloads.find(body=>body.action==='save_settings'),'logo_data_url')),false);
  assert.deepEqual(errors,[]);
});
