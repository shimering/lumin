const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {}
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp('    (?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}
const moneyHelpers = ['formatInvoiceMoney','invoiceTotal','invoiceItemTotal','invoiceItemPatientTotal',
  'invoiceItemPaidAmount','invoiceItemPaymentPercent','invoiceItemPaymentIndicatorMarkup',
  'chartFindingPaymentButton','chartFindingInvoiceColumn'].map(source).join('\n');
function invoice(id, paid, discount = 0) {
  return { id, paidAmount:paid, manualDiscount:discount, loyaltyDiscount:0,
    items:[{id:id*10,unitPrice:400,quantity:1,operationName:'Crown',toothId:'3'},
      {id:id*10+1,unitPrice:600,quantity:1,operationName:'Root canal',toothId:'4'}],
    payments:[{amount:paid,allocations:[{invoiceItemId:id*10,amount:Math.min(paid,400)},
      {invoiceItemId:id*10+1,amount:Math.max(0,paid-400)}]}] };
}
function setup() {
  const context = vm.createContext({ currentUiLanguage:'en', chartInvoiceItemsByFindingId:new Map(),
    escapeHtml:value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]),
    invoiceNumber:id => 'INV-' + id, chartToothLabel:id => 'Tooth ' + id });
  vm.runInContext(moneyHelpers,context);
  return context;
}

test('the fraction uses the procedure allocation and discounted invoiced price snapshot', () => {
  const context = setup(), record = invoice(1,300,150);
  context.chartInvoiceItemsByFindingId.set('crown',{invoice:record,item:record.items[0]});
  const markup = context.chartFindingInvoiceColumn(['crown']);
  assert.match(markup,/EGP 300 \/ 378\.57/);
  assert.match(markup,/data-invoice-id="1" data-item-id="10"/);
  assert.match(markup,/finding-invoice-badge [^"]*">Invoiced/);
  context.currentUiLanguage = 'ar';
  assert.match(context.chartFindingInvoiceColumn(['crown']),/مفوترة/);
  assert.match(context.chartFindingInvoiceColumn(['crown']),/المدفوع للإجراء \/ إجمالي الإجراء المفوتر/);
});

test('a batch totals its distinct invoice items and keeps each procedure payment button', () => {
  const context = setup(), first = invoice(1,300), second = invoice(2,1000);
  context.chartInvoiceItemsByFindingId.set('a',{invoice:first,item:first.items[0]});
  context.chartInvoiceItemsByFindingId.set('b',{invoice:first,item:first.items[1]});
  context.chartInvoiceItemsByFindingId.set('c',{invoice:second,item:second.items[0]});
  assert.match(context.chartFindingInvoiceColumn(['a','b']),/EGP 300 \/ 1,000/);
  const markup = context.chartFindingInvoiceColumn(['a','b','c'],{partial:true});
  assert.match(markup,/EGP 700 \/ 1,400/);
  assert.match(markup,/Partly invoiced/);
  assert.equal((markup.match(/data-item-id=/g)||[]).length,3);
  context.chartInvoiceItemsByFindingId.set('alias',{invoice:first,item:first.items[0]});
  assert.equal(context.chartFindingInvoiceColumn(['a','a','alias']),context.chartFindingInvoiceColumn(['a']), 'Multiple references to one invoice item cannot inflate the amount');
  assert.equal(context.chartFindingInvoiceColumn(['not-invoiced']),'');
});

test('zero-paid and fully-paid procedures show their own amounts and payment action', () => {
  const context = setup();
  for (const paid of [0,1000]) {
    const record = invoice(1,paid);
    context.chartInvoiceItemsByFindingId.set('a',{invoice:record,item:record.items[0]});
    assert.ok(context.chartFindingInvoiceColumn(['a']).includes(`EGP ${paid ? '400' : '0'} / 400`));
  }
  assert.match(context.chartFindingInvoiceColumn(['a']),/data-lucide="check"/);
});

test('invoice column stays beside the tick and below the badge without overlapping clinical names or dates', {skip:!chromium && 'Playwright unavailable'}, async t => {
  const head = html.slice(0,html.indexOf('</head>')+7).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  const fixture = head + '<body class="lumin-raised"><main style="min-width:0;padding:24px"><h2 style="margin-bottom:24px;font-weight:600">Documented findings</h2><div id="findings-container" class="clinical-findings-list space-y-2 bg-slate-50/60 p-3"></div></main></body></html>';
  const server = http.createServer((req,res) => {
    const url = new URL(req.url,'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type','text/html'); res.end(fixture); return; }
    const target = path.resolve(root,'.' + decodeURIComponent(url.pathname));
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {res.statusCode=404;res.end();return;}
    res.setHeader('Content-Type',target.endsWith('.css') ? 'text/css' : 'application/javascript');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => {server.close(resolve);server.closeAllConnections();}));
  const browser = await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined});
  t.after(() => browser.close());
  const page = await browser.newPage({timezoneId:'Africa/Cairo'}), errors = [];
  page.on('pageerror',error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addScriptTag({path:path.join(root,'vendor/lucide.min.js')});
  await page.addScriptTag({content:`
    let currentUiLanguage='en', documentedFindingsTab='treatment', documentedFindingsStatusFilter='all', chartInvoiceStateLoading=false;
    let openChartFindingNoteTrigger=null, chartDoctorsLoaded=true;
    const selectedFindingIds=new Set(), invoicedFindingIds=new Set(['paid','partial','steps','b1','v1']);
    const chartSalaryTransfersByFindingId=new Map(), expandedFindingProcedureSteps=new Set(['steps']),collapsedOrthoFindings=new Set();
    const chartDoctors=[], SLOT_BY_PRIMARY_TOOTH={}, FINDING_SURFACE_TOGGLE_ORDER=[];
    const OPERATION_STATUSES={P:{key:'P',label:'Planned',color:'#dc2626'},C:{key:'C',label:'Completed',color:'#16a34a'},In:{key:'In',label:'In progress',color:'#2563eb'}};
    const base={kind:'whole',toothId:'3',toothIds:['3'],surfaces:[],price:400,notes:[],createdAt:'2026-09-23T09:00:00',beginDate:'2026-09-29T08:00:00',steps:[]};
    const findings=[
      {...base,id:'planned',code:'Composite filling (minimal)',status:'P'},
      {...base,id:'steps',code:'Root canal treatment (molar) with a long clinical description',status:'C',steps:[{id:'s1',name:'Preparation',percentage:100,status:'C'}]},
      {...base,id:'paid',code:'Endo Three Canals',status:'C'},
      {...base,id:'partial',code:'Endo Four Canals',status:'C'},
      {...base,id:'b1',code:'Composite filling batch',status:'P',batchId:'batch',toothIds:['3','4'],memberFindings:[{...base,id:'b1'},{...base,id:'b2',toothId:'4'}]},
      {...base,id:'ortho',code:'Orthodontic package',status:'P',isOrthoPackage:true,orthoVisits:[{id:'v1',visitNumber:1,date:base.createdAt,price:100,status:'C',notes:''}]},
    ];
    const paidInvoice=${JSON.stringify(invoice(1,1000))}, partialInvoice=${JSON.stringify(invoice(2,300,150))};
    const chartInvoiceItemsByFindingId=new Map([
      ['paid',{invoice:paidInvoice,item:paidInvoice.items[0]}],
      ['steps',{invoice:paidInvoice,item:paidInvoice.items[1]}],
      ['partial',{invoice:partialInvoice,item:partialInvoice.items[0]}],
      ['b1',{invoice:partialInvoice,item:partialInvoice.items[1]}],
      ['v1',{invoice:partialInvoice,item:partialInvoice.items[1]}],
    ]);
    function escapeHtml(value){const node=document.createElement('span');node.textContent=String(value);return node.innerHTML.replaceAll('"','&quot;');}
    const fixturePatient={id:'test',chartState:{findings}};
    let activeFixturePatient=fixturePatient, dateSaveFails=false, dateSaveCount=0;
    const dateImplantSyncs=[];
    function getActivePatient(){return activeFixturePatient;}
    function clonePatientChart(chart){return JSON.parse(JSON.stringify(chart));}
    function updateChartFindingsByIds(patient,ids,updater){let updated=false;findings.forEach(finding=>{if(ids.includes(finding.id)){Object.assign(finding,updater({...finding}));updated=true;} (finding.memberFindings||[]).forEach(member=>{if(ids.includes(member.id)){Object.assign(member,updater({...member}));updated=true;}})});return updated;}
    async function saveActivePatientChart(patient,{previousChartState}={}){dateSaveCount++;if(dateSaveFails){findings.forEach((finding,i)=>Object.assign(finding,previousChartState.findings[i]));return false;}return true;}
    function renderChartFindingTeeth(){}
    const CHART_META_KEY='_meta';
    function ensureWholeOperations(data){return data.findings||[];}
    async function syncImplantProgressFromChartOperation(patient,tooth,finding){dateImplantSyncs.push(finding.id);}

    function collectDocumentedFindings(){return findings;}
    function renderDocumentedFindingsTabs(){}
    function renderFindingInvoiceToolbar(){}
    function normaliseChartFindingSteps(steps){return steps||[];}
    function normaliseChartOperationNotes(notes){return notes||[];}
    function normaliseOrthoVisits(visits){return visits||[];}
    function chartFindingBillingMultiplier(){return 1;}
    function chartFindingBatchTotal(finding){return finding.price;}
    function appointmentColorRgba(){return '#eef2ff';}
    function dentalProcedureStepsTotal(steps){return steps.reduce((sum,step)=>sum+step.percentage,0);}
    function dentalOperationLabel(code){return code;}
    function chartToothLabel(id){return 'Tooth '+id;}
    function palmerNotationSVG(){return '<svg width="40" height="28"><text x="12" y="20">6</text></svg>';}
    function formatChartOperationCreatedAt(){return '23 Sep 2026 at 09:00';}
    ${['chartFindingCreatedAtTimestamp','chartOperationDateInputValue'].map(source).join('\n')}
    function setStableHtml(element,markup){element.innerHTML=markup;return true;}
    function reconcileChartFindingNode(){}
    function renderChartFindingIcons(){if(window.lucide)lucide.createIcons();}
    function invoiceNumber(id){return 'INV-'+id;}
    function openInvoicePaymentModal(invoiceId,itemId){window.lastPayment=[invoiceId,itemId];}
    ${moneyHelpers}
    ${['openFindingDateEditor','openFindingBeginDateEditor','chartFindingIdsFromControl','chartFindingToothIdsFromControl','normaliseOperationStatus','operationStatusDefinition','operationStatusSelectOptions','chartDoctorSelectOptions','chartProcedureStepStatusOptions','toggleFindingSelectionFromControl','toggleFindingCardSelection','renderFindingsList'].map(source).join('\n')}
  `});
  await page.addScriptTag({path:path.join(root,'lumin-chart-dates.js')});
  const screenshots = process.env.LUMIN_MEDIA_SCREENSHOT_DIR || path.join(os.tmpdir(),'lumin-invoice-column');
  fs.mkdirSync(screenshots,{recursive:true});
  for (const viewport of [{width:390,height:844},{width:834,height:1112},{width:1180,height:820},{width:1937,height:1280}]) {
    await page.setViewportSize(viewport);
    for (const language of ['en','ar']) {
      await page.evaluate(language => {currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';renderFindingsList();},language);
      const paid = page.locator('[data-refresh-key="paid"]');
      assert.equal(await paid.locator('.finding-invoice-badge').textContent(),language==='ar'?'مفوترة':'Invoiced');
      assert.equal(await paid.locator('.finding-invoice-amount').textContent(),'EGP 400 / 400');
      assert.equal(await page.locator('[data-refresh-key="partial"] .finding-invoice-amount').textContent(),'EGP 300 / 378.57');
      assert.equal(await page.locator('[data-refresh-key="b1"] .finding-invoice-badge').textContent(),language==='ar'?'مفوترة جزئياً':'Partly invoiced');
      assert.equal(await page.locator('.ortho-visit-invoice .finding-invoice-amount').textContent(),'EGP 0 / 471.43');
      const geometry = await page.evaluate(() => {
        const rect = element => {const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
        const rows=[...document.querySelectorAll('.finding-row')].map(row => ({summary:rect(row.querySelector('.finding-row-summary')),invoice:rect(row.querySelector('.finding-row-actions > .finding-invoice-control')),dates:rect(row.querySelector('.finding-dates-group'))}));
        const paid=document.querySelector('[data-refresh-key="paid"]');
        return {rows,badge:rect(paid.querySelector('.finding-invoice-badge')),button:rect(paid.querySelector('[data-item-id]')),amount:rect(paid.querySelector('.finding-invoice-amount')),overflow:document.documentElement.scrollWidth>innerWidth};
      });
      const overlaps=(a,b)=>a.x<b.right-1&&b.x<a.right-1&&a.y<b.bottom-1&&b.y<a.bottom-1;
      assert.equal(geometry.overflow,false,`${viewport.width} ${language} page overflow`);
      for(const row of geometry.rows){assert.equal(overlaps(row.summary,row.invoice),false);assert.equal(overlaps(row.invoice,row.dates),false);assert.ok(Math.abs(row.invoice.x-geometry.rows[0].invoice.x)<2,'Invoice column aligns across row types');}
      assert.equal(overlaps(geometry.badge,geometry.button),false,'Badge is beside the tick');
      assert.ok(geometry.amount.y>=geometry.badge.bottom,'Paid fraction is beneath the badge');
      assert.ok(Math.abs(geometry.amount.x+geometry.amount.width/2-geometry.badge.x-geometry.badge.width/2)<2,'Paid fraction aligns directly beneath the badge');
      assert.ok(geometry.button.width>=44&&geometry.button.height>=44);
      assert.equal(await page.locator('.finding-operation-heading .finding-invoice-badge').count(),0);
      await paid.locator('[data-item-id="10"]').click();
      assert.deepEqual(await page.evaluate(()=>window.lastPayment),['1','10']);
      const planningButton = paid.locator('.finding-date-control button');
      const beforeSize = await paid.boundingBox();
      const beforeDate = await page.evaluate(() => findings.find(f=>f.id==='paid').createdAt);
      const beforeBegin = await page.evaluate(() => findings.find(f=>f.id==='paid').beginDate);
      const beforeSaves = await page.evaluate(() => dateSaveCount);
      await planningButton.click();
      const dateDialog = page.locator('#chart-finding-date-dialog');
      assert.ok(await dateDialog.isVisible());
      assert.equal(await dateDialog.locator('h2').textContent(),language==='ar'?'تعديل تاريخ التخطيط':'Edit planning date');
      assert.equal(await dateDialog.locator('input').inputValue(),await page.evaluate(value=>chartOperationDateInputValue(value),beforeDate));
      const afterSize = await paid.boundingBox();
      assert.equal(afterSize.width,beforeSize.width);
      assert.equal(afterSize.height,beforeSize.height,'Editing a date does not expand the clinical row');
      assert.equal(await page.evaluate(()=>selectedFindingIds.size),0,'Date pencils do not toggle invoice selection');
      assert.equal(await paid.locator('.finding-date-editor, .finding-begin-date-editor').count(),0);
      const dialogBounds = await dateDialog.boundingBox();
      assert.ok(dialogBounds.x>=0&&dialogBounds.y>=0&&dialogBounds.x+dialogBounds.width<=viewport.width+1&&dialogBounds.y+dialogBounds.height<=viewport.height+1);
      if(viewport.width>=768){assert.ok(Math.abs(dialogBounds.x+dialogBounds.width/2-viewport.width/2)<2);assert.ok(Math.abs(dialogBounds.y+dialogBounds.height/2-viewport.height/2)<2,'Desktop and tablet dialogs are centered');}
      if(viewport.width<768)assert.ok(Math.abs(dialogBounds.y+dialogBounds.height-viewport.height)<2,'Mobile uses a bottom sheet');
      for(const button of await dateDialog.locator('button').all()) {
        const bounds=await button.boundingBox();assert.ok(bounds.width>=44&&bounds.height>=44,'Dialog touch targets');
      }
      for(let i=0;i<6;i++) {
        await page.keyboard.press('Tab');
        assert.ok(await dateDialog.evaluate(dialog=>dialog.contains(document.activeElement)),'Keyboard focus stays in the modal');
      }
      await dateDialog.locator('input').fill('2026-10-02T11:45');
      if(viewport.width===1180&&language==='en')await page.screenshot({path:path.join(screenshots,'finding-date-dialog-desktop.png')});
      if(viewport.width===390&&language==='ar')await page.screenshot({path:path.join(screenshots,'finding-date-dialog-mobile-ar.png')});
      await dateDialog.locator('[data-date-cancel]').click();
      assert.equal(await page.evaluate(()=>dateSaveCount),beforeSaves);
      assert.equal(await page.evaluate(()=>findings.find(f=>f.id==='paid').createdAt),beforeDate);
      await planningButton.click();
      await page.keyboard.press('Escape');
      assert.ok(!(await dateDialog.isVisible()));
      await planningButton.click();
      await dateDialog.locator('input').fill('');
      await dateDialog.locator('[data-date-save]').click();
      assert.ok(await dateDialog.isVisible());
      assert.equal(await page.evaluate(()=>dateSaveCount),beforeSaves,'Blank dates cannot be saved');
      await dateDialog.locator('input').fill('2026-10-02T11:45');
      await dateDialog.locator('[data-date-save]').click();
      await dateDialog.waitFor({state:'hidden'});
      assert.equal(await page.evaluate(()=>findings.find(f=>f.id==='paid').createdAt),new Date('2026-10-02T08:45:00Z').toISOString());
      assert.equal(await page.evaluate(()=>findings.find(f=>f.id==='paid').beginDate),beforeBegin,'Planning edit preserves the begin date');
      await paid.locator('.finding-begin-date-control button').click();
      await dateDialog.locator('input').fill('2026-10-03T08:15');
      await page.evaluate(()=>{dateSaveFails=true;});
      const previousSyncs=await page.evaluate(()=>dateImplantSyncs.length);
      await dateDialog.locator('[data-date-save]').click();
      await dateDialog.locator('#chart-finding-date-error').waitFor({state:'visible'});
      assert.equal(await page.evaluate(()=>findings.find(f=>f.id==='paid').beginDate),beforeBegin,'Failed saves restore the persisted date');
      assert.equal(await page.evaluate(()=>dateImplantSyncs.length),previousSyncs,'Rejected date edits cannot sync implant progress');
      assert.equal(await dateDialog.locator('input').inputValue(),'2026-10-03T08:15','Retry preserves the entered date');
      await page.evaluate(()=>{dateSaveFails=false;});
      await dateDialog.locator('[data-date-save]').click();
      await dateDialog.waitFor({state:'hidden'});
      assert.equal(await page.evaluate(()=>findings.find(f=>f.id==='paid').beginDate),new Date('2026-10-03T05:15:00Z').toISOString());
      assert.equal(await page.evaluate(()=>findings.find(f=>f.id==='paid').status),'C');
      await page.locator('[data-refresh-key="b1"] .finding-date-control button').click();
      await dateDialog.locator('input').fill('2026-10-01T09:30');
      await dateDialog.locator('[data-date-save]').click();
      await dateDialog.waitFor({state:'hidden'});
      assert.ok(await page.evaluate(()=>findings.find(f=>f.id==='b1').memberFindings.every(f=>f.createdAt===new Date('2026-10-01T09:30').toISOString())),'A batch date edit updates every selected procedure');
      await planningButton.click();
      const savedCount=await page.evaluate(()=>dateSaveCount);
      await page.evaluate(()=>{activeFixturePatient={id:'another-patient',chartState:{}};renderFindingsList();});
      assert.ok(!(await dateDialog.isVisible()),'Changing patients closes the date dialog');
      assert.equal(await page.evaluate(()=>dateSaveCount),savedCount);
      await page.evaluate(()=>{activeFixturePatient=fixturePatient;renderFindingsList();});
      if(viewport.width===1937&&language==='en')await page.screenshot({path:path.join(screenshots,'finding-invoice-column-desktop.png')});
      if(viewport.width===834&&language==='ar')await page.screenshot({path:path.join(screenshots,'finding-invoice-column-tablet-ar.png')});
    }
  }
  assert.deepEqual(errors,[]);
});
