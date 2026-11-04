const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname,'..');
const html = fs.readFileSync(path.join(root,'index.html'),'utf8');
let chromium;
try { ({chromium} = require('playwright')); } catch (_) {}
function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0,name);
  return html.slice(start,html.indexOf('\n    }',start) + 6);
}
async function fixture(t) {
  const head = html.slice(0,html.indexOf('</head>')+7).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  const server = http.createServer((req,res) => {
    const url = new URL(req.url,'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type','text/html'); res.end(head+'<body class="lumin-raised"><main style="max-width:1200px;margin:auto;padding:24px"><div id="patient-invoices-list" style="display:grid;gap:24px"></div></main><div id="view-dashboard" class="hidden"></div><div id="view-finances" class="hidden"></div></body></html>'); return; }
    const file = path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if (!file.startsWith(root+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {res.statusCode=404;res.end();return;}
    res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => {server.close(resolve);server.closeAllConnections();}));
  const browser = await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:1280,height:1100}}), errors=[];
  page.on('pageerror',error => errors.push(error.message));
  await page.route('**/*',route => route.request().url().startsWith('http://127.0.0.1:') ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addScriptTag({path:path.join(root,'vendor/lucide.min.js')});
  await page.addScriptTag({path:path.join(root,'lumin-dates.js')});
  await page.addScriptTag({content:`
    let currentUiLanguage='en',currentSession={user:{id:'staff'}},activeInvoicePatientId='patient',activePatientId='patient';
    const INVOICE_SELECT_FIELDS='fixture',SLOT_BY_PRIMARY_TOOTH={},CHART_SURFACES=[];
    let permissions=true;window.rpcCalls=[];window.refreshes=0;window.chartRefreshes=0;window.failRpc=false;window.holdRpc=false;window.paymentTarget=null;
    const baseItem={id:10,unitPrice:3000,quantity:1,operationName:'Root canal treatment (premolar)',operationCode:'root',operationStatus:'In',toothId:'4',surfaces:[],doctorName:'Dr Mohamed Gazzar'};
    const base={patientId:'patient',invoiceDate:'2026-11-03',status:'unpaid',updatedAt:'initial',loyaltyDiscount:0,manualDiscountType:'amount',manualDiscountValue:300,manualDiscount:300,paidAmount:500,releasedAmount:200,items:[baseItem],payments:[{amount:500,allocations:[{invoiceItemId:10,amount:500}]}],releases:[{id:21,amount:200,releaseDate:'2026-11-03'}]};
    window.fixtureInvoices=[{...structuredClone(base),id:1},{...structuredClone(base),id:2,manualDiscount:0,manualDiscountValue:0,paidAmount:0,releasedAmount:0,payments:[],releases:[],items:[{...baseItem,id:20}]}];
    const db={from(){return {select(){return this},eq(k,id){this.id=id;return this},single(){return Promise.resolve({data:structuredClone(fixtureInvoices.find(invoice=>invoice.id===this.id)),error:null})}}},async rpc(name,args){
      rpcCalls.push({name,args});if(holdRpc)await new Promise(resolve=>window.finishRpc=resolve);if(failRpc)return {error:{message:'Save failed'}};
      const invoice=fixtureInvoices.find(invoice=>invoice.id===args.p_invoice_id);
      if(name==='set_patient_invoice_discount'){invoice.manualDiscountType=args.p_discount_type;invoice.manualDiscountValue=args.p_discount_value;invoice.manualDiscount=args.p_discount_type==='percent'?Math.round(3000*args.p_discount_value)/100:args.p_discount_value;}
      if(name==='release_patient_invoice'){const amount=invoiceRemaining(invoice);invoice.releases.unshift({id:99,amount,releaseDate:'2026-11-04'});invoice.releasedAmount+=amount;}
      if(name==='undo_latest_invoice_release'){invoice.releasedAmount-=invoice.releases.shift().amount;}
      invoice.updatedAt='write-'+rpcCalls.length;return {data:{},error:null};
    }};
    function normaliseInvoiceRecord(record){return record}function hasPageAccess(){return permissions}
    function dentalOperationByCode(){return {}}function palmerQuadrantForSlot(){return {abbreviation:'LL'}}function isPrimaryToothId(){return false}
    function chartToothLabel(id){return 'Tooth '+id}function palmerNotationSVG(){return '<span>4</span>'}function surfaceAbbreviation(_,surface){return surface}
    function operationStatusDefinition(){return {key:'In',label:'In progress'}}function invoiceDoctorSalaryActionMarkup(){return ''}
    function invalidateLoyaltyInvoiceViews(){}function showAppointmentNotificationToast(){}function refreshChartFindingInvoiceState(){chartRefreshes++;return Promise.resolve()}
    function renderDashboard(){}function refreshActiveFinanceTab(){return Promise.resolve()}
    function openInvoicePaymentModal(id,item){paymentTarget=[id,item]}function openInvoiceLinkedPayments(){}function openInvoiceDateEditor(){}function deletePatientInvoice(){}function deletePatientInvoiceItem(){}
    function escapeHtml(value){return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}
    ${['formatInvoiceMoney','formatInvoiceDate','invoiceNumber','invoiceTotal','invoiceRemaining','invoiceItemTotal','invoiceItemPatientTotal','invoiceItemPaidAmount','invoiceItemRemaining','canRecordInvoicePayment','canReleaseInvoice','canUndoInvoiceRelease','invoiceDisplayStatus'].map(source).join('\n')}
    async function renderPatientInvoices(){refreshes++;LuminInvoiceCards.setInvoices(fixtureInvoices);document.getElementById('patient-invoices-list').innerHTML=fixtureInvoices.map(invoice=>LuminInvoiceCards.markup(invoice)).join('');lucide.createIcons();}
  `});
  await page.addScriptTag({path:path.join(root,'lumin-invoice-cards.js')});
  await page.evaluate(() => renderPatientInvoices());
  return {page,errors};
}
const card = '#patient-invoices-list [data-invoice-card="1"]';
const second = '#patient-invoices-list [data-invoice-card="2"]';
const action = (name,scope=card) => `${scope} [data-invoice-action="${name}"]`;
async function drawerReady(page,scope=card) {
  await page.locator(`${scope} .invoice-drawer-panel [type="submit"]`).waitFor();
  await page.waitForFunction(selector => {
    const drawer=document.querySelector(selector);
    return drawer && getComputedStyle(drawer).opacity==='1' && Math.abs(drawer.clientHeight-drawer.scrollHeight)<=1;
  },`${scope} .invoice-inline-drawer`);
}

test('discount and release undo independently restore balances using the existing saved actions',{skip:!chromium},async t => {
  const {page,errors}=await fixture(t);
  assert.equal(await page.locator(`${card} [data-invoice-balance]`).textContent(),'EGP 2,000');
  await page.locator(action('remove-discount')).click();await drawerReady(page);
  assert.equal(await page.locator(`${card} [data-invoice-projection]`).textContent(),'EGP 2,300');
  await page.locator(`${card} [type="submit"]`).click();
  await page.waitForFunction(() => refreshes===2);
  assert.equal(await page.locator(action('remove-discount')).count(),0);
  assert.equal(await page.locator(`${card} .is-release strong`).textContent(),'EGP 200');
  assert.equal(await page.locator(`${card} [data-invoice-balance]`).textContent(),'EGP 2,300');
  await page.locator(action('undo-release')).click();await drawerReady(page);
  assert.equal(await page.locator(`${card} [data-invoice-projection]`).textContent(),'EGP 2,500');
  await page.locator(`${card} [type="submit"]`).click();await page.waitForFunction(() => refreshes===3);
  assert.deepEqual(await page.evaluate(() => rpcCalls),[
    {name:'set_patient_invoice_discount',args:{p_invoice_id:1,p_discount_type:'amount',p_discount_value:0}},
    {name:'undo_latest_invoice_release',args:{p_invoice_id:1}}
  ]);
  assert.equal(await page.locator(`${card} [data-invoice-balance]`).textContent(),'EGP 2,500');
  assert.equal(await page.evaluate(() => fixtureInvoices[0].paidAmount),500);
  assert.equal(await page.evaluate(() => chartRefreshes),2);
  assert.deepEqual(errors,[]);
});

test('discount preview validates balance limits; release remains a full-balance action; failures keep the drawer usable',{skip:!chromium},async t => {
  const {page,errors}=await fixture(t);
  await page.locator(action('discount')).click();await drawerReady(page);
  await page.locator(`${card} [data-invoice-value]`).fill('2400');
  assert.equal(await page.locator(`${card} [type="submit"]`).isDisabled(),true);
  await page.locator(`${card} [data-invoice-value]`).fill('600');
  assert.equal(await page.locator(`${card} [data-invoice-projection]`).textContent(),'EGP 1,700');
  await page.locator(`${card} [data-invoice-type]`).selectOption('percent');
  assert.equal(await page.locator(`${card} [data-invoice-value]`).inputValue(),'20');
  await page.evaluate(() => {failRpc=true;});
  await page.locator(`${card} [type="submit"]`).click();
  await page.locator(`${card} [data-invoice-error]`).waitFor();
  assert.equal(await page.locator(`${card} [data-invoice-error]`).textContent(),'Save failed');
  assert.equal(await page.locator(`${card} [type="submit"]`).isDisabled(),false);
  await page.evaluate(() => {failRpc=false;});
  await page.locator(`${card} [type="submit"]`).click();await page.waitForFunction(() => refreshes===2);
  assert.equal(await page.locator(`${card} .is-discount strong`).textContent(),'EGP 600');
  await page.locator(action('release')).click();await drawerReady(page);
  assert.equal(await page.locator(`${card} .invoice-release-amount strong`).textContent(),'EGP 1,700');
  await page.locator(`${card} [type="submit"]`).click();await page.waitForFunction(() => refreshes===3);
  assert.equal(await page.locator(`${card} [data-invoice-balance]`).textContent(),'EGP 0');
  await page.locator(action('undo-release')).click();await drawerReady(page);
  await page.locator(`${card} [type="submit"]`).click();await page.waitForFunction(() => refreshes===4);
  assert.equal(await page.locator(`${card} [data-invoice-balance]`).textContent(),'EGP 1,700');
  assert.equal(await page.locator(`${card} .is-discount strong`).textContent(),'EGP 600');
  assert.equal(await page.locator(`${card} .is-release strong`).textContent(),'EGP 200');
  assert.deepEqual(errors,[]);
});

test('stale invoices require another review, repeated submissions do not duplicate writes, and payment routing is preserved',{skip:!chromium},async t => {
  const {page,errors}=await fixture(t);
  await page.locator(action('release')).click();await drawerReady(page);
  await page.evaluate(() => {fixtureInvoices[0].paidAmount+=100;});
  await page.locator(`${card} [type="submit"]`).click();await page.locator(`${card} [data-invoice-error]`).waitFor();
  assert.equal(await page.evaluate(() => rpcCalls.length),0);
  assert.match(await page.locator(`${card} [data-invoice-error]`).textContent(),/invoice changed/);
  assert.equal(await page.locator(`${card} .invoice-release-amount strong`).textContent(),'EGP 1,900');
  await page.evaluate(() => {holdRpc=true;});
  await page.locator(`${card} [type="submit"]`).click();await page.waitForFunction(() => !!window.finishRpc);
  await page.evaluate(() => {document.querySelector('[data-invoice-form]').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  assert.equal(await page.evaluate(() => rpcCalls.length),1);
  await page.evaluate(() => {finishRpc();});await page.waitForFunction(() => refreshes===2);
  await page.locator(action('pay',second)).click();assert.deepEqual(await page.evaluate(() => paymentTarget),[2,null]);
  await page.locator(`${second} .invoice-item-menu summary`).click();await page.locator(action('pay-item',second)).click();
  assert.deepEqual(await page.evaluate(() => paymentTarget),[2,20]);
  assert.deepEqual(errors,[]);
});

test('inline cards fit phone, tablet and desktop layouts in English and Arabic, with visible touch-sized undo controls',{skip:!chromium},async t => {
  const {page,errors}=await fixture(t);
  for (const width of [320,390,834,1280]) {
    await page.setViewportSize({width,height:1100});
    for (const language of ['en','ar']) {
      await page.evaluate(language => {currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';return renderPatientInvoices();},language);
      for (const name of ['remove-discount','undo-release']) {
        const target=page.locator(action(name)),bounds=await target.boundingBox();
        assert.ok(bounds.width>=44 && bounds.height>=44,`${width}/${language}/${name} meets touch sizing`);
        assert.equal(await target.evaluate(node => getComputedStyle(node).borderWidth),'0px');
      }
      await page.locator(action('discount')).click();await drawerReady(page);
      const dimensions=await page.evaluate(() => ({overflow:document.documentElement.scrollWidth>innerWidth,drawer:document.querySelector('.invoice-inline-drawer.is-open').getBoundingClientRect().toJSON()}));
      assert.equal(dimensions.overflow,false,`${width}/${language} fits the page`);
      assert.ok(dimensions.drawer.x>=0 && dimensions.drawer.right<=width);
      assert.equal(await page.locator(`${card} [data-invoice-value]`).evaluate(node => node.getAttribute('aria-invalid')),'false');
      if (process.env.LUMIN_MEDIA_SCREENSHOT_DIR && (width===1280 || width===320)) await page.screenshot({path:path.join(process.env.LUMIN_MEDIA_SCREENSHOT_DIR,`invoice-inline-drawer-${width}-${language}.png`),fullPage:true});
      await page.locator(`${card} .invoice-card-icon-button`).press('Escape');
      assert.equal(await page.locator(action('discount')).getAttribute('aria-expanded'),'false');
      if (process.env.LUMIN_MEDIA_SCREENSHOT_DIR && language==='en') await page.screenshot({path:path.join(process.env.LUMIN_MEDIA_SCREENSHOT_DIR,`invoice-inline-${width}.png`),fullPage:true});
    }
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator(`${card} .invoice-inline-drawer`).evaluate(node => getComputedStyle(node).transitionDuration),'0s');
  await page.evaluate(() => {permissions=false;return renderPatientInvoices();});
  assert.equal(await page.locator(action('remove-discount')).count(),0);
  assert.equal(await page.locator(action('undo-release')).count(),0);
  assert.equal(await page.locator(action('discount')).isDisabled(),true);
  assert.deepEqual(errors,[]);
});
