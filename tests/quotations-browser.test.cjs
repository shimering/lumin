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
    res.setHeader('Content-Type',target.endsWith('.html')?'text/html':target.endsWith('.css')?'text/css':target.endsWith('.svg')?'image/svg+xml':'application/javascript');res.end(fs.readFileSync(target));
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

test('the same token refreshes prices and completion, then removes patient information on revocation or a network failure',async t=>{
  const {page,base,errors}=await setup(t);
  let response=sample(),status=200,offline=false;
  await page.route('**/functions/v1/quotation-view',route=>offline?route.abort('failed'):route.fulfill({status,json:status===200?response:{error:'Quotation unavailable.'}}));
  await page.goto(base+'/quotation.html#'+'a'.repeat(64));await page.waitForSelector('.q-procedure');
  response.items=response.items.filter(item=>item.visualCode!=='rct');response.total=7800;
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>document.querySelectorAll('.q-procedure').length===3);
  assert.match(await page.locator('.q-total').textContent(),/7,800/);
  status=404;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForSelector('.q-page-status h1');
  assert.doesNotMatch(await page.locator('main').textContent(),/Omar|7,800|Noura/);
  assert.equal(await page.locator('.q-procedure').count(),0);
  await page.reload();status=200;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForSelector('.q-procedure');
  offline=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForSelector('[data-retry]');
  assert.doesNotMatch(await page.locator('main').textContent(),/Omar|Noura/);
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  assert.deepEqual(errors,[]);
});

test('selection actions stay adjacent; mixed selections quote only planned procedures, and history and settings remain accessible',async t=>{
  const {page,base,errors}=await setup(t);
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const head=html.slice(0,html.indexOf('</head>')+7).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  const group=html.match(/<div id="findings-selection-actions"[\s\S]*?<\/div>/)[0];
  const source=name=>{const start=html.indexOf('    function '+name+'(');return html.slice(start,html.indexOf('\n    }',start)+6);};
  await page.route(base+'/staff',route=>route.fulfill({contentType:'text/html',body:`${head}<body><main>${group}<button id="history" onclick="openPatientQuotations()">History</button><div id="admin-quotation-settings"></div></main></body>`}));
  await page.goto(base+'/staff');
  await page.addScriptTag({path:path.join(root,'vendor/lucide.min.js')});
  for(const filename of ['lumin-quotation-model.js','lumin-tooth-anatomy.js','lumin-quotation-view.js'])await page.addScriptTag({path:path.join(root,filename)});
  await page.addScriptTag({content:`
    let currentUiLanguage='en',currentSession={user:{id:'staff'}},currentUserAccess={isAdmin:true},activePatientId='${id(90)}';
    let selectedFindingIds=new Set(['${id(1)}','${id(2)}']),invoicedFindingIds=new Set(),chartInvoiceStateLoading=false;
    const chart=${JSON.stringify(chart)},dentalOperations=${JSON.stringify(operations)};
    const patient={id:activePatientId,name:'Omar Hassan',phone:'01001234567',chartState:chart};
    const settings={clinic_name:'Noura Dental',logo_data_url:'',whatsapp_phone:'201001234567'};
    let savedQuote=null;window.payloads=[];
    function getActivePatient(){return patient;} function patientWorkspaceId(){return activePatientId;} function hasPageAccess(){return true;}
    async function saveActivePatientChart(){return true;} async function waitForPatientChartSaves(){}
    function setStableHtml(element,markup){element.innerHTML=markup;return true;} function renderChartFindingIcons(){lucide.createIcons();} function escapeHtml(value){return String(value);}
    function showAppointmentNotificationToast(){} function invoiceSelectedFindings(){window.invoiceSelection=[...selectedFindingIds];}
    const db={from(table){const query={select(){return query},eq(){return query},single(){return Promise.resolve({data:{id:patient.id,name:patient.name,phone:patient.phone,chart_state:chart}})},then(resolve){return Promise.resolve({data:dentalOperations}).then(resolve)}};return query;},functions:{async invoke(name,{body}){window.payloads.push(body);if(body.action==='settings')return{data:{settings}};if(body.action==='list')return{data:{quotations:savedQuote?[savedQuote]:[]}};if(body.action==='create'||body.action==='update'){savedQuote={...body,id:'${id(99)}',token:'${'b'.repeat(64)}',patient_id:patient.id,revision:1};return{data:{quotation:savedQuote}};}return{data:{settings}};}}};
    ${['chartFindingBillingMultiplier','chartFindingBatchTotal','chartFindingInvoiceAmounts','formatInvoiceMoney','renderFindingInvoiceToolbar'].map(source).join('\n')}
  `});
  await page.addScriptTag({path:path.join(root,'lumin-quotations.js')});
  await page.evaluate(()=>renderFindingInvoiceToolbar([{id:patient.chartState[3].wholeOperations[0].id,price:3500},{id:patient.chartState[3].wholeOperations[1].id,price:5500}]));
  for(const viewport of [{width:390,height:844},{width:834,height:1112},{width:1440,height:900}]) {
    await page.setViewportSize(viewport);
    const a=await page.locator('#findings-invoice-button').boundingBox(),b=await page.locator('#findings-quotation-button').boundingBox();
    assert.ok(b.x>=a.x+a.width&&b.x+b.width<=viewport.width&&b.width>=44&&b.height>=44);
  }
  await page.locator('#findings-invoice-button').click();assert.deepEqual(await page.evaluate(()=>window.invoiceSelection),[id(1),id(2)]);
  await page.locator('#findings-quotation-button').click();await page.waitForSelector('#quotation-expiry');
  assert.equal(await page.locator('#quotation-preview .q-procedure').count(),1);
  assert.match(await page.locator('.q-feedback:not([hidden])').textContent(),/Only selected/);
  await page.locator('[data-quote-action=save]').click();await page.waitForSelector('.q-link-field');
  const payload=await page.evaluate(()=>window.payloads.find(body=>body.action==='create'));
  assert.deepEqual(payload.selected_ids,[id(2)]);assert.ok(new Date(payload.expires_at)>new Date());
  assert.match(await page.locator('.q-link-field input').inputValue(),/quotation\.html#[b]{64}$/);
  await page.keyboard.press('Escape');assert.equal(await page.locator('.q-overlay').count(),0);
  await page.locator('#history').click();await page.waitForSelector('.q-history-card');
  await page.locator('[data-quote-action=edit]').click();await page.waitForSelector('#quotation-expiry');
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{selectedFindingIds=new Set();renderFindingInvoiceToolbar([]);});
  assert.equal(await page.locator('#findings-selection-actions').isVisible(),false);
  await page.evaluate(()=>{currentUiLanguage='ar';renderQuotationSettings();});await page.waitForSelector('#admin-quotation-settings form');
  assert.match(await page.locator('#admin-quotation-settings h3').textContent(),/إعدادات/);
  assert.equal(await page.locator('#admin-quotation-settings').getAttribute('dir'),'rtl');
  await page.locator('[name=clinic_name]').fill('Updated clinic');
  await page.locator('[name=whatsapp_phone]').fill('+20 1001234567');
  await page.locator('#admin-quotation-settings [type=submit]').click();
  await page.waitForFunction(()=>window.payloads.some(body=>body.action==='save_settings'&&body.clinic_name==='Updated clinic'));
  assert.deepEqual(errors,[]);
});
