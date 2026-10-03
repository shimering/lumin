const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
let chromium;
try { ({chromium} = require('playwright')); } catch (_) {}
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp('    (?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}
const helpers = ['chartFindingBillingMultiplier', 'chartFindingBatchTotal', 'chartFindingInvoiceAmounts', 'formatInvoiceMoney', 'renderFindingInvoiceToolbar'].map(source).join('\n');
function setup(ids=[], invoiced=[]) {
  const classes = new Set(['hidden']);
  const button = {disabled:true, innerHTML:'', attributes:{}, classList:{toggle(name, value){if(value)classes.add(name);else classes.delete(name);}},
    setAttribute(name,value){this.attributes[name]=value;},getAttribute(name){return this.attributes[name];}};
  const context = vm.createContext({currentUiLanguage:'en',chartInvoiceStateLoading:false,
    selectedFindingIds:new Set(ids),invoicedFindingIds:new Set(invoiced),
    document:{getElementById:id=>id==='findings-invoice-button'?button:null},
    setStableHtml(element,markup){element.innerHTML=markup;return true;},renderChartFindingIcons(){},escapeHtml:value=>String(value)});
  vm.runInContext(helpers,context);
  return {context,button,classes};
}
test('selection total stays in the invoice button after removing the instruction strip',()=>{
  const {context,button,classes}=setup(['a','b','paid','zero','deleted'],['paid']);
  const findings=[{id:'a',price:1100},{id:'b',price:250.75},{id:'paid',price:999},{id:'zero',price:0}];
  context.renderFindingInvoiceToolbar(findings);
  assert.match(button.innerHTML,/Selected total.*EGP 1,350.75/);
  assert.match(button.attributes['aria-label'],/Add 2 selected operations to invoice.*EGP 1,350.75/);
  assert.deepEqual([...context.selectedFindingIds],['a','b']);
  assert.equal(button.disabled,false);assert.ok(classes.has('inline-flex'));
  findings[1].price=400;
  context.renderFindingInvoiceToolbar(findings);
  assert.match(button.innerHTML,/EGP 1,500/,'Editing a selected price updates the sum');
  context.invoicedFindingIds.add('a');
  context.renderFindingInvoiceToolbar(findings);
  assert.match(button.innerHTML,/EGP 400/);
});
test('batch totals use billed quantities and split rounding rather than repeating the full group price',()=>{
  const {context,button}=setup(['a','b','c']);
  const batch={id:'a',price:1000,batchId:'batch',billingMultiplier:1,memberFindings:['a','b','c'].map(id=>({id,price:1000}))};
  context.renderFindingInvoiceToolbar([batch]);
  assert.match(button.innerHTML,/EGP 1,000/);
  context.selectedFindingIds=new Set(['a','b']);
  context.renderFindingInvoiceToolbar([batch]);
  assert.match(button.innerHTML,/EGP 666.66/);
  batch.billingMultiplier=2;
  context.renderFindingInvoiceToolbar([batch]);
  assert.match(button.innerHTML,/EGP 1,333.34/);
});
test('orthodontic selections total visits without charging the parent package or previously invoiced visits',()=>{
  const {context,button}=setup(['package','v1','v2','v3'],['v3']);
  context.renderFindingInvoiceToolbar([{id:'package',price:10000,isOrthoPackage:true,orthoVisits:[{id:'v1',price:100.5},{id:'v2',price:200.25},{id:'v3',price:200}]}]);
  assert.match(button.innerHTML,/EGP 300.75/);
  assert.deepEqual([...context.selectedFindingIds],['v1','v2']);
});
test('empty, loading and Arabic selection states remain accessible',()=>{
  const {context,button,classes}=setup(['a']);
  context.currentUiLanguage='ar';
  context.renderFindingInvoiceToolbar([{id:'a',price:1100}]);
  assert.match(button.innerHTML,/إجمالي المحدد.*EGP 1,100/);
  assert.match(button.attributes['aria-label'],/إضافة 1 من الإجراءات المحددة/);
  context.chartInvoiceStateLoading=true;
  context.renderFindingInvoiceToolbar([{id:'a',price:1100}]);
  assert.equal(button.disabled,true);assert.ok(classes.has('hidden'));assert.equal(button.attributes['aria-hidden'],'true');
  context.chartInvoiceStateLoading=false;context.selectedFindingIds.clear();
  context.renderFindingInvoiceToolbar([{id:'a',price:1100}]);
  assert.ok(classes.has('hidden'));assert.equal(button.disabled,true);
});
test('chart voice commands and duplicate chart toolbar controls are fully removed',()=>{
  assert.doesNotMatch(html,/CHAIRSIDE VOICE|chart-voice-|settings-voice-|LUMIN_VOICE|LuminVoice|luminVoice|syncVoice|handlePatientWorkspaceVoice|voice-scribe-engine/);
  assert.doesNotMatch(html,/id="(?:findings-invoice-toolbar|findings-invoice-selection-summary|chart-attachments-button)"|class="chart-media-toolbar"/);
  assert.match(html,/function invoiceSelectedFindings\(/);
  assert.match(html,/id="setting-whatsapp-gemini-key"/,'Shared WhatsApp AI settings remain available');
});

test('the invoice button shows an elegant total on phones, tablets and desktops in both languages', {skip:!chromium&&'Playwright unavailable'},async t=>{
  const head=html.slice(0,html.indexOf('</head>')+7).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  const markup=html.match(/<button id="findings-invoice-button"[\s\S]*?<\/button>/)[0];
  const fixture=head+'<body class="lumin-raised"><main style="padding:24px"><h1>Dental chart</h1><p>Selected procedures</p></main>'+markup+'</body></html>';
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(fixture);return;}
    const target=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!target.startsWith(root+path.sep)||!fs.existsSync(target)||!fs.statSync(target).isFile()){res.statusCode=404;res.end();return;}
    res.setHeader('Content-Type',target.endsWith('.css')?'text/css':'application/javascript');res.end(fs.readFileSync(target));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||undefined});t.after(()=>browser.close());
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addScriptTag({path:path.join(root,'vendor/lucide.min.js')});
  await page.addScriptTag({content:`
    let currentUiLanguage='en',chartInvoiceStateLoading=false,selectedFindingIds=new Set(['a','b']);
    const invoicedFindingIds=new Set(),findings=[{id:'a',price:1100},{id:'b',price:250.75}];
    function setStableHtml(element,markup){element.innerHTML=markup;return true;}
    function renderChartFindingIcons(){if(window.lucide)lucide.createIcons();}
    function escapeHtml(value){return String(value);}
    function invoiceSelectedFindings(){window.lastInvoiceSelection=[...selectedFindingIds];}
    ${helpers}
  `});
  for(const viewport of [{width:390,height:844},{width:834,height:1112},{width:1020,height:884},{width:1440,height:900}]){
    await page.setViewportSize(viewport);
    for(const language of ['en','ar']){
      await page.evaluate(language=>{currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';document.documentElement.style.setProperty('--mobile-nav-height',innerWidth<1024?'88px':'0px');renderFindingInvoiceToolbar(findings);},language);
      const button=page.locator('#findings-invoice-button');
      assert.ok(await button.isVisible());
      assert.equal(await button.locator('strong').textContent(),'EGP 1,350.75');
      const bounds=await button.boundingBox();
      assert.ok(bounds.width>=180&&bounds.height>=44&&bounds.x>=0&&bounds.x+bounds.width<=viewport.width);
      assert.ok(bounds.y+bounds.height<viewport.height-(viewport.width<1024?88:0),'Button stays above navigation');
      const styles=await button.evaluate(button=>({border:getComputedStyle(button).borderWidth,label:parseFloat(getComputedStyle(button.querySelector('.finding-invoice-button-label')).fontSize),total:parseFloat(getComputedStyle(button.querySelector('.finding-invoice-button-total')).fontSize),overflow:document.documentElement.scrollWidth>innerWidth}));
      assert.equal(styles.border,'0px');assert.ok(styles.total<styles.label);assert.equal(styles.overflow,false);
      await button.click();assert.deepEqual(await page.evaluate(()=>window.lastInvoiceSelection),['a','b']);
      if(process.env.LUMIN_MEDIA_SCREENSHOT_DIR&&viewport.width===1020)await page.screenshot({path:path.join(process.env.LUMIN_MEDIA_SCREENSHOT_DIR,`chart-invoice-selected-total-${language}.png`)});
    }
  }
  assert.deepEqual(errors,[]);
});
