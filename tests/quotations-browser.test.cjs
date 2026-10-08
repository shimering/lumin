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
const operations=[{code:'rct',name:'Root canal treatment',price:3500,action_scope:'whole',visual_code:'rct'},{code:'crown',name:'Zirconia crown',price:5500,action_scope:'whole',visual_code:'zirconia_crown'},{code:'composite',name:'Composite restoration',price:1400,action_scope:'surface',visual_code:'composite'},{code:'scaling',name:'Scaling and polishing',price:900,action_scope:'mouth',visual_code:'none'}];
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
  listeners.fetch({request:{method:'GET',url:'https://clinic.invalid/quotation.html',mode:'navigate'},respondWith:promise=>{response=promise;}});
  const result=await response;
  assert.equal(result.status,503);assert.equal(calls[0].cache,'no-store');assert.match(result.headers.get('cache-control'),/no-store/);
  assert.doesNotMatch(await result.text(),/sign in|password|patient-quotation/i);
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
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||'chrome'});
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
  assert.match(await page.locator('.q-total').textContent(),/11,300/);
  assert.equal(calls[0].method(),'POST');assert.equal(calls[0].postDataJSON().token,'a'.repeat(64));assert.equal(calls[0].headers().referer,undefined);
  for(const viewport of [{width:390,height:844},{width:834,height:1112},{width:1440,height:1000}]) {
    await page.setViewportSize(viewport);
    for(const language of ['en','ar']) {
      if(await page.locator('html').getAttribute('lang')!==language)await page.locator('[data-q-language]').click();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      const buttons=await page.locator('.q-tooth:not(:disabled),.q-button').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {w:r.width,h:r.height};}));
      assert.ok(buttons.every(button=>button.w>=43.9&&button.h>=43.9));
      await page.locator('.q-procedure').filter({hasText:'Root canal treatment'}).click();
      assert.equal(await page.locator('[data-q-tooth="3"]').getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('[data-q-tooth="19"]').getAttribute('aria-pressed'),'false');
      await page.locator('.q-procedure').filter({hasText:'Composite restoration'}).click();
      assert.equal(await page.locator('[data-q-tooth="19"]').getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('[data-q-tooth="19"] .q-surface.q-planned').count(),2);
      assert.equal(await page.locator('[data-q-tooth="3"] [id*="rct-layer-"]').evaluate(node=>getComputedStyle(node).display),'block');
    }
  }
  await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('[data-q-print]').isVisible(),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  if(process.env.LUMIN_QUOTATION_SCREENSHOTS){await page.emulateMedia({media:'screen'});await page.setViewportSize({width:1200,height:1100});await page.locator('[data-q-language]').click();await page.screenshot({path:path.join(process.env.LUMIN_QUOTATION_SCREENSHOTS,'quotation-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(process.env.LUMIN_QUOTATION_SCREENSHOTS,'quotation-mobile.png'),fullPage:true});}
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

test('the same token follows form logo changes, prices and completion, then clears patient information on revocation or network failure',async t=>{
  const {page,base,errors}=await setup(t);
  let response=sample(),status=200,offline=false;
  response.clinic.logo=formLogo;
  await page.route('**/functions/v1/quotation-view',route=>offline?route.abort('failed'):route.fulfill({status,json:status===200?response:{error:'Quotation unavailable.'}}));
  await page.goto(base+'/quotation.html#'+'a'.repeat(64));await page.waitForSelector('.q-procedure');
  assert.equal(await page.locator('.q-clinic-logo').getAttribute('src'),formLogo);
  const updatedLogo=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=2;const ctx=canvas.getContext('2d');ctx.fillStyle='#2563eb';ctx.fillRect(0,0,2,2);return canvas.toDataURL('image/png');});
  response.clinic.logo=updatedLogo;
  response.items=response.items.filter(item=>item.visualCode!=='rct');response.total=7800;
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>document.querySelectorAll('.q-procedure').length===3);
  assert.match(await page.locator('.q-total').textContent(),/7,800/);
  assert.equal(await page.locator('.q-clinic-logo').getAttribute('src'),updatedLogo);
  response.clinic.logo='';await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>!document.querySelector('.q-clinic-logo'));
  status=404;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForSelector('.q-page-status h1');
  assert.doesNotMatch(await page.locator('main').textContent(),/Omar|7,800|Noura/);
  assert.equal(await page.locator('.q-procedure').count(),0);
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
  for(const filename of ['lumin-quotation-model.js','lumin-tooth-anatomy.js','lumin-quotation-view.js'])await page.addScriptTag({path:path.join(root,filename)});
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
    ${['openPatientWorkspace','openPatientWorkspaceTab','updatePatientWorkspaceNavigation','chartFindingBillingMultiplier','chartFindingBatchTotal','chartFindingInvoiceAmounts','formatInvoiceMoney','renderFindingInvoiceToolbar'].map(source).join('\n')}
  `});
  await page.addScriptTag({path:path.join(root,'lumin-quotations.js')});
  await page.evaluate(()=>{document.getElementById('patient-workspace-header').classList.remove('hidden');updatePatientWorkspaceNavigation(patient,'chart');});
  await page.evaluate(()=>renderFindingInvoiceToolbar([{id:patient.chartState[3].wholeOperations[0].id,price:3500},{id:patient.chartState[3].wholeOperations[1].id,price:5500}]));
  for(const viewport of [{width:390,height:844},{width:834,height:1112},{width:1440,height:900}]) {
    await page.setViewportSize(viewport);
    const a=await page.locator('#findings-invoice-button').boundingBox(),b=await page.locator('#findings-quotation-button').boundingBox();
    assert.ok(b.x>=a.x+a.width&&b.x+b.width<=viewport.width&&b.width>=44&&b.height>=44);
  }
  await page.locator('#findings-invoice-button').click();assert.deepEqual(await page.evaluate(()=>window.invoiceSelection),[id(1),id(2)]);
  await page.locator('#findings-quotation-button').click();await page.waitForSelector('#quotation-expiry');
  assert.equal(await page.locator('#quotation-preview .q-procedure').count(),1);
  assert.equal(await page.locator('#quotation-preview .q-clinic-logo').getAttribute('src'),formLogo);
  assert.match(await page.locator('.q-feedback:not([hidden])').textContent(),/Only selected/);
  await page.locator('[data-quote-action=save]').click();await page.waitForSelector('.q-link-field');
  const payload=await page.evaluate(()=>window.payloads.find(body=>body.action==='create'));
  assert.deepEqual(payload.selected_ids,[id(2)]);assert.ok(new Date(payload.expires_at)>new Date());
  assert.match(await page.locator('.q-link-field input').inputValue(),/quotation\.html#[b]{64}$/);
  await page.keyboard.press('Escape');assert.equal(await page.locator('.q-overlay').count(),0);
  await page.locator('#history').click();await page.waitForSelector('.q-history-card');
  assert.equal(await page.evaluate(()=>window.openedView),'patient-quotations');
  assert.equal(await page.locator('[data-patient-workspace-tab=quotations]').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('.q-overlay').count(),0);
  await page.locator('[data-quote-action=edit]').click();await page.waitForSelector('#quotation-expiry');
  await page.locator('[data-quote-procedure][value="'+id(4)+'"]').check();
  await page.locator('[data-quote-procedure][value="'+id(2)+'"]').uncheck();
  assert.equal(await page.locator('#quotation-preview .q-procedure').count(),1);
  assert.match(await page.locator('#quotation-preview .q-procedure').textContent(),/Scaling/);
  await page.locator('[data-quote-action=save]').click();
  await page.waitForFunction(()=>window.payloads.some(body=>body.action==='update'));
  const edited=await page.evaluate(()=>window.payloads.find(body=>body.action==='update'));
  assert.deepEqual(edited.selected_ids,[id(4)]);assert.equal(edited.revision,1);
  await page.waitForFunction(()=>document.querySelector('.q-history-value')?.textContent.includes('900'));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-patient-workspace-tab=quotations]').evaluate(node=>node===document.activeElement),true);
  await page.evaluate(()=>{savedQuote.expires_at=new Date(Date.now()-864e5).toISOString();renderPatientQuotations();});
  await page.waitForFunction(()=>document.querySelector('.q-history-card .q-badge')?.textContent==='Expired');
  await page.locator('.q-history-card [data-quote-action=edit]').click();await page.waitForSelector('#quotation-expiry');
  assert.equal(await page.locator('.q-link-field').count(),0);
  await page.locator('[data-quote-action=save]').click();await page.waitForSelector('.q-link-field');
  assert.match(await page.locator('.q-link-field input').inputValue(),/quotation\.html#[b]{64}$/);
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
