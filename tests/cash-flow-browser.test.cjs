const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname,'..');
const html = fs.readFileSync(path.join(root,'index.html'),'utf8');
function source(name) {
  const start=html.search(new RegExp(`    (?:async )?function ${name}\\(`)); assert.ok(start>=0,name);
  const tail=html.slice(start);return tail.slice(0,tail.indexOf('\n    }')+6);
}
let chromium;try {({chromium}=require('playwright'))}catch(_){}
test('cash flow tabs, touch inspection, ranges and bilingual layouts fit all devices', {skip:!chromium},async t=>{
  const fixture=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(fixture);return}
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.statusCode=404;res.end();return}
    res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections()}));
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||undefined});t.after(()=>browser.close());
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:')?route.continue():route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const dictionary=html.slice(html.indexOf('    const ARABIC_UI_TEXT ='),html.indexOf('\n    });',html.indexOf('    const ARABIC_UI_TEXT ='))+8);
  await page.addScriptTag({content:`
    let currentUiLanguage='en',currentSession={user:{id:'fixture'}},calls=[],failure=false,empty=false;
    const uiTextSources=new WeakMap(),uiTextLastApplied=new WeakMap(),uiAttributeStates=new WeakMap(),TRANSLATABLE_ATTRIBUTES=['placeholder','title','aria-label'];
    const PATIENTS_UI_AR = {};
    ${dictionary}
    ${['isUiTranslationExcluded','arabicUiPhrase','translateUiTextNode','translateUiAttribute','translateUiTree','formatInvoiceMoney'].map(source).join('\n')}
    function hasPageAccess(){return true}
    function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
    const db={rpc:async(name,args)=>{calls.push({name,args});if(failure)return{error:{message:'fixture failure'}};
      const months=[];for(let key=args.p_start_date.slice(0,7);key<=args.p_end_date.slice(0,7);key=cashFlowShiftMonth(key,1)){const i=months.length;months.push({month:key,income:empty?0:8000+i*750,expense:empty?0:6000+i%3*2500,legacy_expense:empty?0:200})}return{data:{months}}}};
    function refreshIncomeStatement(){document.getElementById('analytics-income-flow').textContent='Income statement fixture'}
    document.getElementById('auth-gate').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');
    document.querySelectorAll('main > section').forEach(el=>el.classList.add('hidden'));
    document.getElementById('view-clinic-management').classList.remove('hidden');document.getElementById('view-analytics').classList.remove('hidden');
    document.getElementById('clinic-management-tab-analytics').setAttribute('aria-selected','true');
  `});
  await page.addScriptTag({path:path.join(root,'vendor','lucide.min.js')});
  await page.addScriptTag({path:path.join(root,'lumin-cash-flow.js')});
  assert.deepEqual(errors,[], 'Fixture scripts must initialize successfully');
  await page.evaluate(()=>{for(let el=document.getElementById('view-analytics');el;el=el.parentElement){el.classList.remove('hidden');el.hidden=false}});
  await page.locator('#analytics-tab-cash-flow').click();
  await page.waitForSelector('.cash-chart');assert.equal(await page.locator('#analytics-panel-income-statement').isVisible(),false);
  assert.equal(await page.evaluate(()=>calls.length),1);
  await page.locator('.cash-month').first().click();assert.match(await page.locator('#analytics-cash-detail').textContent(),/EGP/);
  await page.locator('#analytics-tab-income-statement').click();assert.equal(await page.locator('#analytics-income-summary').isVisible(),true);assert.equal(await page.locator('.cash-chart').isVisible(),false);
  await page.locator('#analytics-tab-income-statement').press('ArrowRight');await page.waitForSelector('.cash-chart');
  assert.equal(await page.locator('#analytics-tab-cash-flow').getAttribute('aria-selected'),'true');
  await page.locator('#analytics-cash-start-month').fill('2024-01');await page.locator('#analytics-cash-end-month').fill('2026-12');
  await page.locator('#analytics-panel-cash-flow .cash-button-primary').first().click();await page.waitForFunction(()=>document.querySelectorAll('.cash-month').length===36);
  const before=await page.evaluate(()=>calls.length);await page.locator('#analytics-cash-end-month').fill('2027-01');await page.locator('#analytics-panel-cash-flow .cash-button-primary').first().click();assert.equal(await page.evaluate(()=>calls.length),before);assert.equal(await page.locator('#analytics-cash-range-error').isVisible(),true);
  await page.locator('button[onclick="setCashFlowPreset(\'6\')"]').click();await page.waitForFunction(()=>document.querySelectorAll('.cash-month').length===6);
  for(const language of ['en','ar'])for(const [width,height] of [[390,844],[820,1180],[1440,1000]]) {
    await page.setViewportSize({width,height});
    await page.evaluate(language=>{currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';document.documentElement.lang=language;translateUiTree(document.getElementById('view-analytics'),language);return refreshActiveAnalyticsTab()},language);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,`${language} ${width} shell overflow`);
    assert.equal(await page.locator('.cash-month').count(),6);
    assert.equal(await page.locator('#analytics-panel-income-statement').isVisible(),false);
    const targets=await page.locator('#view-analytics button:visible').evaluateAll(nodes=>nodes.map(node=>({text:node.textContent.trim(),width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height})));
    for(const target of targets)assert.ok(target.width>=44&&target.height>=44,JSON.stringify(target));
    assert.match(await page.locator('#analytics-tab-cash-flow').textContent(),language==='ar'?/التدفق النقدي/:/Cash flow/);
    assert.match(await page.locator('#analytics-cash-detail').textContent(),language==='ar'?/النقد الداخل/:/Money in/);
    await page.locator('.cash-month').first().click();assert.equal(await page.locator('.cash-month').first().getAttribute('aria-pressed'),'true');
    if(process.env.LUMIN_CASH_SCREENSHOT_DIR){fs.mkdirSync(process.env.LUMIN_CASH_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.LUMIN_CASH_SCREENSHOT_DIR,`cash-flow-${language}-${width}.png`),fullPage:true})}
  }
  await page.evaluate(()=>{empty=true;return refreshCashFlow({refresh:true})});assert.match(await page.locator('#analytics-cash-content').textContent(),/لا توجد حركة نقدية/);
  await page.evaluate(()=>{failure=true;return refreshCashFlow({refresh:true})});assert.match(await page.locator('#analytics-cash-content').textContent(),/حاول مرة أخرى/);
  await page.evaluate(()=>{failure=false;empty=false});await page.locator('button[onclick="refreshCashFlow({refresh:true})"]').click();await page.waitForSelector('.cash-chart');
  await page.evaluate(()=>{document.body.classList.add('lumin-raised')});
  assert.match(await page.locator('.cash-card').first().evaluate(el=>getComputedStyle(el).boxShadow),/rgb/);
  assert.deepEqual(errors,[]);
});
