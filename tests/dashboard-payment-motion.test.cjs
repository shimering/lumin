const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {}

function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = html.slice(start);
  return tail.slice(0, tail.indexOf('\n    }') + 6);
}

async function fixture(t, viewport, dir = 'ltr', reduced = false, scale = 1) {
  const stripped = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(stripped); return; }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.statusCode = 404; res.end(); return;
    }
    res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:') ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addScriptTag({ path: path.join(root, 'vendor/lucide.min.js') });
  await page.addScriptTag({ path: path.join(root, 'lumin-dashboard-motion.js') });
  await page.addScriptTag({ content: `
    let currentUiLanguage = '${dir === 'rtl' ? 'ar' : 'en'}', currentSession = {user:{id:'staff'}};
    let activePaymentInvoiceId=null, activePaymentInvoiceItemId=null, activePaymentInvoice=null, invoicePaymentSaving=false;
    let financeInvoicesLoaded=true,financePaymentsLoaded=true,financeDeptsLoaded=true,financeOverviewLoaded=true;
    let activePatientId=null,activeInvoicePatientId=null,activeWorkspacePatientId=null,dashboardInvoiceRenderToken=0;
    const patients=[],paymentMethods=[{id:'cash',name:'Cash',active:true}],INVOICE_SELECT_FIELDS='fixture';
    const dashboardInvoiceCache=new Map(),DASHBOARD_INVOICE_CACHE_TTL=15000;
    const appointmentDayFormatter={format:()=> '4 October 2026'},dashboardSelectedDate=new Date('2026-10-04T12:00:00Z');
    const entries=[{patientId:'patient',patient:'Test patient'}];
    window.fixtureInvoices=[101,102,103].map(id=>({id,patientId:'patient',patientName:'Test patient '+id,
      paidAmount:250,releasedAmount:0,loyaltyDiscount:0,manualDiscount:0,status:'partial',
      items:[{id:1,operationName:'Composite restoration',unitPrice:1000,quantity:1}],payments:[]}));
    window.paymentWrites=0;window.refreshes=0;window.animationRecords=[];
    const nativeAnimate=Element.prototype.animate;
    Element.prototype.animate=function(frames,timing){
      animationRecords.push({id:this.id,card:this.getAttribute('data-refresh-key'),indicator:this.hasAttribute('data-invoice-payment-indicator'),
        frames,timing,rect:this.getBoundingClientRect().toJSON(),localWidth:this.offsetWidth,at:performance.now()});
      return nativeAnimate.call(this,frames,timing);
    };
    const db={from:table=>({select(){return this},eq(key,id){this.id=id;return this},
      single(){return Promise.resolve({data:structuredClone(fixtureInvoices.find(row=>row.id===this.id)),error:null})},
      insert(payload){paymentWrites++;return new Promise(resolve=>{window.resolvePayment=(error=null)=>{
        if(!error)fixtureInvoices.find(row=>row.id===payload.invoice_id).paidAmount+=payload.amount;
        resolve({error});};});}})};
    function normaliseInvoiceRecord(row){return row}
    function ensurePaymentMethodsLoaded(){return Promise.resolve()}
    function canRecordInvoicePayment(){return true}function canReleaseInvoice(){return false}
    function canViewDashboardInvoices(){return true}function hasPageAccess(){return false}
    function invoiceLoyaltyBadge(){return ''}function translateUiTree(){}
    function showAppointmentNotificationToast(){}
    function appointmentDateKey(){return '2026-10-04'}
    function stableJsonStringify(value){return JSON.stringify(value)}
    function escapeHtml(value){return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')}
    function setAdminMessage(id,message){const el=document.getElementById(id);el.textContent=message;el.classList.toggle('hidden',!message)}
    function fetchInvoiceRecords(){return Promise.resolve(fixtureInvoices.map(row=>structuredClone(row)))}
    function renderDashboard(){refreshes++;return renderDashboardInvoices(entries)}
    ${['formatInvoiceMoney','invoiceNumber','invoiceTotal','invoiceRemaining','invoicePaymentPercent','invoiceDisplayStatus',
      'contentRefreshContext','beginContentRefresh','finishContentRefresh','failContentRefresh','setStableHtml',
      'invoicePaymentIndicatorMarkup','dashboardInvoiceCardMarkup','dashboardInvoiceCacheKey','loadDashboardInvoiceRecords',
      'renderDashboardInvoices','openInvoicePaymentModal','closePaymentModal','saveInvoicePayment'].map(source).join('\n')}
    document.documentElement.dir='${dir}';document.body.classList.add('lumin-raised','dashboard-active');
    document.documentElement.classList.toggle('lumin-app-scaled',${scale}!==1);
    document.documentElement.style.setProperty('--lumin-app-scale','${scale}');
    document.documentElement.style.setProperty('--lumin-app-viewport-height','${viewport.height / scale}px');
    document.getElementById('auth-gate').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');
    document.getElementById('dashboard-schedule-card').hidden=true;
    document.getElementById('dashboard-scroll-panels').style.gridTemplate='minmax(0,1fr) / minmax(0,1fr)';
    document.getElementById('view-dashboard').classList.add('hidden');
    requestAnimationFrame(()=>document.getElementById('view-dashboard').classList.remove('hidden'));
    void renderDashboardInvoices(entries);
  ` });
  await page.locator('#dashboard-invoices-list article').first().waitFor();
  return { page, errors };
}

const card = '#dashboard-invoices-list > [data-refresh-key="101"]';
const pay = `${card} button[onclick^="openInvoicePaymentModal"]`;
const indicator = `${card} [data-invoice-payment-indicator]`;

test('successful dashboard payment grows from Pay, returns to the ring, reveals a tick, slides right, and rearranges rows', {skip: !chromium}, async t => {
  const {page,errors}=await fixture(t,{width:1440,height:1100});
  assert.equal(await page.locator('#view-dashboard').evaluate(el=>getComputedStyle(el).animationDuration),'0.2s');
  const buttonRect=await page.locator(pay).boundingBox();
  await page.locator(pay).click();
  await page.waitForFunction(()=>activePaymentInvoice && document.activeElement.id==='payment-amount');
  const opening=await page.evaluate(()=>animationRecords[0]);
  assert.equal(opening.timing.duration,300);
  const coords=opening.frames[0].transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+), ([-\d.]+)\)/).slice(1).map(Number);
  assert.ok(Math.abs(coords[0]-(buttonRect.x+buttonRect.width/2-opening.rect.x-opening.rect.width/2))<2);
  assert.ok(Math.abs(coords[1]-(buttonRect.y+buttonRect.height/2-opening.rect.y-opening.rect.height/2))<2);
  assert.ok(Math.abs(coords[2]*opening.rect.width-buttonRect.width)<2);
  assert.ok(Math.abs(coords[3]*opening.rect.height-buttonRect.height)<2);
  if(process.env.LUMIN_MOTION_SCREENSHOTS)await page.screenshot({path:path.join(process.env.LUMIN_MOTION_SCREENSHOTS,'dashboard-payment-desktop.png')});
  await page.locator('#payment-method').selectOption('cash');
  await page.locator('#payment-save-button').click();
  await page.evaluate(()=>{saveInvoicePayment({preventDefault(){}});closePaymentModal();renderDashboardInvoices(entries)});
  assert.equal(await page.evaluate(()=>paymentWrites),1,'duplicate submit cannot create another payment');
  assert.equal(await page.locator('#modal-payment').isVisible(),true,'form stays visible during the write');
  await page.evaluate(()=>resolvePayment());
  await page.waitForFunction(()=>document.getElementById('modal-payment').classList.contains('is-payment-closing'));
  const targetRect=await page.locator(indicator).boundingBox();
  const closing=await page.evaluate(()=>animationRecords.find(record=>record.frames.at(-1).borderRadius==='50%'));
  const closeCoords=closing.frames.at(-1).transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+), ([-\d.]+)\)/).slice(1).map(Number);
  assert.ok(Math.abs(closeCoords[0]-(targetRect.x+targetRect.width/2-closing.rect.x-closing.rect.width/2))<2);
  assert.ok(Math.abs(closeCoords[1]-(targetRect.y+targetRect.height/2-closing.rect.y-closing.rect.height/2))<2);
  await page.evaluate(()=>{dashboardInvoiceCache.clear();return renderDashboardInvoices(entries)});
  assert.equal(await page.locator(card).count(),1,'realtime cannot remove the destination during motion');
  await page.locator(`${indicator} svg[data-lucide="check"]`).waitFor();
  assert.equal(await page.locator(indicator).getAttribute('data-payment-percent'),'100');
  await page.waitForFunction(()=>animationRecords.some(record=>record.card==='101'&&record.frames.at(-1).transform==='translateX(100%)'));
  assert.equal(await page.locator(card).count(),1,'the row remains during its exit animation');
  await page.waitForFunction(()=>animationRecords.some(record=>record.card==='102'&&record.frames[0].transform.startsWith('translateY(')));
  await page.waitForFunction(()=>!invoicePaymentSaving);
  assert.equal(await page.locator(card).count(),0);
  assert.equal(await page.locator('#dashboard-invoices-list article').count(),2);
  assert.equal(await page.evaluate(()=>LuminDashboardMotion.isHoldingInvoices()),false);
  assert.deepEqual(errors,[]);
});

test('partial payments and failures keep the invoice available on mobile, tablet, RTL, and reduced motion', {skip: !chromium}, async t => {
  for(const [width,height,dir,reduced,scale] of [[390,844,'rtl',false,1],[820,1180,'ltr',false,1],[1440,900,'ltr',true,1],[390,844,'rtl',false,0.8],[390,844,'ltr',false,1.25]]){
    await t.test(`${width}px ${dir} at ${scale*100}%${reduced?' reduced motion':''}`,async t=>{
      const {page,errors}=await fixture(t,{width,height},dir,reduced,scale);
      await page.locator(pay).click();
      await page.waitForFunction(()=>activePaymentInvoice&&document.activeElement.id==='payment-amount');
      const dialog=await page.locator('#modal-payment [role="dialog"]').boundingBox();
      assert.ok(dialog.x>=0&&dialog.x+dialog.width<=width+1&&dialog.y>=0&&dialog.y+dialog.height<=height+1,'dialog fits the device');
      for(const button of await page.locator('#modal-payment button').all()){
        const box=await button.boundingBox();assert.ok(box.width>=43.9&&box.height>=43.9,'44px touch target');
      }
      if(process.env.LUMIN_MOTION_SCREENSHOTS)await page.screenshot({path:path.join(process.env.LUMIN_MOTION_SCREENSHOTS,`dashboard-payment-${width}-${dir}.png`)});
      await page.locator('#payment-amount').fill('250');
      await page.locator('#payment-method').selectOption('cash');
      await page.locator('#payment-save-button').click();
      await page.evaluate(()=>resolvePayment({message:'Connection interrupted'}));
      await page.waitForFunction(()=>!invoicePaymentSaving);
      assert.equal(await page.locator('#modal-payment').isVisible(),true);
      assert.match(await page.locator('#payment-form-message').textContent(),/Connection interrupted/);
      assert.equal(await page.locator(indicator).getAttribute('data-payment-percent'),'25');
      assert.equal(await page.locator('#payment-save-button').isEnabled(),true);
      await page.locator('#payment-save-button').click();
      await page.evaluate(()=>resolvePayment());
      await page.waitForFunction(()=>!invoicePaymentSaving);
      await page.waitForFunction(()=>document.querySelector('[data-refresh-key="101"] [data-invoice-payment-indicator]').dataset.paymentPercent==='50');
      assert.equal(await page.locator(`${indicator} svg[data-lucide="check"]`).count(),0);
      assert.equal(await page.locator(card).count(),1,'partial invoice stays in the list');
      assert.equal(await page.locator('#modal-payment').isVisible(),false);
      if(reduced)assert.equal(await page.evaluate(()=>animationRecords.length),0);
      await page.locator(pay).click();
      await page.waitForFunction(()=>activePaymentInvoice&&document.activeElement.id==='payment-amount');
      assert.match(await page.locator('#payment-save-button').textContent(),/Add payment/,'opening again restores the submit label');
      await page.locator('#modal-payment button[aria-label="Close payment form"]').click();
      assert.equal(await page.locator('#modal-payment').isVisible(),false);
      assert.equal(await page.locator(pay).evaluate(el=>document.activeElement===el),true,'dismissal restores focus');
      assert.deepEqual(errors,[]);
    });
  }
});

test('scaled layouts keep both animation destinations accurate and an in-flight refresh cannot interrupt success', {skip: !chromium}, async t => {
  for(const scale of [0.8,1.25])await t.test(`${scale*100}% UI scale`,async t=>{
    const {page,errors}=await fixture(t,{width:1440,height:1100},'ltr',false,scale);
    const origin=await page.locator(pay).boundingBox();
    await page.locator(pay).click();
    await page.waitForFunction(()=>activePaymentInvoice&&document.activeElement.id==='payment-amount');
    const opening=await page.evaluate(()=>animationRecords[0]);
    const zoom=opening.rect.width/opening.localWidth;
    const openingCoords=opening.frames[0].transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/).slice(1).map(Number);
    assert.ok(Math.abs(openingCoords[0]*zoom-(origin.x+origin.width/2-opening.rect.x-opening.rect.width/2))<2);
    assert.ok(Math.abs(openingCoords[1]*zoom-(origin.y+origin.height/2-opening.rect.y-opening.rect.height/2))<2);
    const target=await page.locator(indicator).boundingBox();
    await page.evaluate(()=>{
      window.immediateFetch=fetchInvoiceRecords;
      fetchInvoiceRecords=()=>new Promise(resolve=>window.resolveInvoiceRead=()=>resolve(fixtureInvoices.map(row=>structuredClone(row))));
      dashboardInvoiceCache.clear();window.pendingRefresh=renderDashboardInvoices(entries);
    });
    await page.waitForFunction(()=>typeof resolveInvoiceRead==='function');
    await page.locator('#payment-method').selectOption('cash');
    await page.locator('#payment-save-button').click();
    await page.evaluate(()=>{resolvePayment();resolveInvoiceRead();fetchInvoiceRecords=immediateFetch;return pendingRefresh});
    assert.equal(await page.locator(card).count(),1,'a previously started refresh retains the destination');
    await page.waitForFunction(()=>animationRecords.some(record=>record.frames.at(-1).borderRadius==='50%'));
    const closing=await page.evaluate(()=>animationRecords.find(record=>record.frames.at(-1).borderRadius==='50%'));
    const closeZoom=closing.rect.width/closing.localWidth;
    const coords=closing.frames.at(-1).transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/).slice(1).map(Number);
    assert.ok(Math.abs(coords[0]*closeZoom-(target.x+target.width/2-closing.rect.x-closing.rect.width/2))<2);
    assert.ok(Math.abs(coords[1]*closeZoom-(target.y+target.height/2-closing.rect.y-closing.rect.height/2))<2);
    await page.waitForFunction(()=>!invoicePaymentSaving);
    assert.equal(await page.locator(card).count(),0);
    assert.deepEqual(errors,[]);
  });
});

test('dismissing during opening cancels motion and prevents a late read from taking focus', {skip: !chromium}, async t=>{
  const {page,errors}=await fixture(t,{width:390,height:844});
  await page.evaluate(()=>{
    window.openingForm=openInvoicePaymentModal(101,null,document.querySelector('[data-refresh-key="101"] button[onclick^="openInvoicePaymentModal"]'));
    closePaymentModal();return openingForm;
  });
  assert.equal(await page.locator('#modal-payment').isVisible(),false);
  assert.equal(await page.evaluate(()=>activePaymentInvoice),null);
  assert.equal(await page.locator(pay).evaluate(el=>document.activeElement===el),true);
  assert.equal(await page.evaluate(()=>LuminDashboardMotion.isHoldingInvoices()),false);
  assert.deepEqual(errors,[]);
});
