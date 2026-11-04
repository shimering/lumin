const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright'),root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
function source(name){const start=html.search(new RegExp('    (?:async )?function '+name+'\\('));assert.ok(start>=0,name);const tail=html.slice(start);return tail.slice(0,tail.indexOf('\n    }')+6);}
test('clinic sections work without an overview, with shared alerts, permissions and bilingual layouts',async t=>{
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,''));return;}
    const file=path.resolve(root,'.'+decodeURIComponent(pathname));
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||'chrome'});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:')?route.continue():route.abort());
  await page.goto('http://127.0.0.1:'+server.address().port+'/');
  await page.addScriptTag({path:path.join(root,'lumin-dates.js')});
  await page.addScriptTag({path:path.join(root,'vendor/lucide.min.js')});

  await page.addScriptTag({content:`
    let currentUiLanguage='en',currentSession={user:{id:'actor'}},currentUserAccess={active:true,isAdmin:false,permissions:new Set(['finances','inventory','analytics','hr','finance_depts'])},activeClinicManagementTab='finances',activeFinanceTab='invoices',activeHrDoctorDetailsId=null,hrDirectoryLoaded=false,hrDoctorPayrollLoadedMonth='';
    window.calls=[];window.failAlerts=false;window.deferAlerts=false;window.deferred=[];window.clinicDay='2026-11-04';
    function firstAuthorizedView(){return 'dashboard'}async function switchView(view){window.fallbackView=view}
    function formatInvoiceMoney(value){return 'EGP '+Number(value).toLocaleString('en-US')}
    function hrClinicDateValue(){return clinicDay}function currentHrMonth(){return '2026-11'}
    const hrDirectoryUsers=[{userId:'a',active:true,isDoctor:true},{userId:'staff',active:true,isDoctor:false}],hrAttendanceSessions=[{user_id:'staff',work_date:'2026-11-03',check_in_at:'yesterday'}],hrSalaryAdvances=[],hrPayrollPeriod={status:'draft'};
    function hrDoctorMetrics(){return{salary:300}}function hrUserMetrics(){return{salary:500,paid:false}}
    async function refreshHrDirectory(options={}){calls.push({name:'hr-directory',options});hrDirectoryLoaded=true;return true}
    async function openHrDoctorDetails(id){activeHrDoctorDetailsId=id}async function loadHrDoctorSettlementCases(){calls.push({name:'hr-detail'})}
    async function switchFinanceTab(tab){activeFinanceTab=tab;calls.push({name:'finance-tab',tab})}async function refreshActiveAnalyticsTab(){calls.push({name:'analytics'})}
    window.LuminInventory={init(){},async refresh(){calls.push({name:'inventory'})},leave(){}};
    const db={rpc:async(name,args)=>{
      calls.push({name,args});if(name!=='get_clinic_management_overview')throw Error('Unexpected RPC '+name);
      const data={finance:hasPageAccess('finances')||hasPageAccess('analytics')?{debt_total:126000,debt_patient_count:34,unpaid_expense_count:3,unpaid_expense_total:18200}:null,
        hr:hasPageAccess('hr')?{payroll_invoice_count:4,payroll_doctor_count:3,payroll_amount:980,payroll_preview:[{doctor_id:'a',doctor_name:'Dr. Ahmed',patient_name:'Mariam Hassan',invoice_id:1042,operation_name:'Composite',doctor_amount:180,day:'2026-11-03'}]}:null};
      if(deferAlerts)await new Promise(resolve=>deferred.push(resolve));
      return failAlerts?{error:{message:'Offline'}}:{data};
    }};
    ${source('hasPageAccess')}${source('firstAuthorizedClinicManagementTab')}${source('switchClinicManagementTab')}
    document.getElementById('auth-gate').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');
    document.querySelectorAll('main>section').forEach(node=>node.classList.add('hidden'));
    document.getElementById('view-clinic-management').classList.remove('hidden');window.location.hash='clinic-management';
  `});
  await page.addScriptTag({path:path.join(root,'lumin-clinic-management.js')});
  await page.evaluate(async()=>{LuminClinicManagement.init();await switchClinicManagementTab()});
  assert.equal(await page.locator('#clinic-management-tab-overview,#view-clinic-overview,#cm-range-toolbar,#cm-stats,#cm-payroll-panel,#cm-cash-chart').count(),0,'The overview page and controls are absent from the DOM');
  assert.deepEqual(await page.locator('[data-clinic-management-tab]').evaluateAll(nodes=>nodes.map(node=>node.dataset.clinicManagementTab)),['finances','inventory','analytics','hr']);
  assert.equal(await page.evaluate(()=>activeClinicManagementTab),'finances','Finances is the default clinic section');
  assert.equal(await page.locator('#view-finances').isVisible(),true);
  assert.equal(await page.evaluate(()=>typeof LuminClinicManagement.loadPayroll),'undefined','The deleted page no longer has a payroll loader');
  assert.deepEqual(await page.evaluate(()=>calls.find(call=>call.name==='get_clinic_management_overview').args),{p_start_date:'2026-11-04',p_end_date:'2026-11-04'});
  assert.equal(await page.evaluate(()=>calls.filter(call=>call.name==='hr-directory').length),0,'Opening Finances never loads the removed page\'s HR data');
  for(const tab of ['inventory','analytics','hr','finances']){
    await page.locator('#clinic-management-tab-'+tab).click();
    assert.equal(await page.locator('#clinic-management-tab-'+tab).getAttribute('aria-selected'),'true');
    for(const candidate of ['finances','inventory','analytics','hr'])assert.equal(await page.locator('#view-'+candidate).isVisible(),candidate===tab,'Only the selected section is visible');
  }
  await page.evaluate(async()=>{await switchClinicManagementTab('overview')});
  assert.equal(await page.evaluate(()=>activeClinicManagementTab),'finances','An obsolete overview selection falls back to a remaining section');
  await page.locator('#clinic-management-tab-finances').focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(()=>activeClinicManagementTab),'inventory');
  await page.keyboard.press('End');assert.equal(await page.evaluate(()=>activeClinicManagementTab),'hr');
  await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>activeClinicManagementTab),'finances');

  await page.evaluate(async()=>{hrDoctorPayrollLoadedMonth='2026-11';await LuminClinicManagement.refresh()});
  assert.equal(await page.locator('#cm-alert-count').textContent(),'5','The action center reuses already-loaded HR data');
  await page.locator('#cm-alert-bell').click();assert.equal(await page.locator('.cm-alert-row').count(),5);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#cm-alert-menu').isVisible(),false);
  assert.equal(await page.locator('#cm-alert-bell').evaluate(node=>node===document.activeElement),true);
  await page.locator('#cm-alert-bell').click();await page.locator('#view-clinic-management h2').click();assert.equal(await page.locator('#cm-alert-menu').isVisible(),false);
  await page.locator('#cm-alert-bell').click();await page.locator('.cm-alert-row .cm-button').first().click();
  assert.match(await page.locator('.cm-payment-preview-row').textContent(),/Mariam Hassan/);
  await page.locator('.cm-payment-preview-actions button').click();
  assert.equal(await page.evaluate(()=>activeClinicManagementTab),'hr');assert.equal(await page.evaluate(()=>activeHrDoctorDetailsId),'a');
  assert.equal(await page.locator('#hr-doctor-payroll-day').inputValue(),'2026-11-03','Alerts still open the original procedure day in HR');
  await page.evaluate(async()=>{await LuminClinicManagement.navigate('expenses')});assert.equal(await page.evaluate(()=>activeFinanceTab),'expenses');
  await page.evaluate(async()=>{await LuminClinicManagement.navigate('balances')});assert.equal(await page.evaluate(()=>activeFinanceTab),'depts');
  await page.evaluate(()=>{activeFinanceTab='invoices'});

  for(const language of ['en','ar'])for(const width of [320,390,820,1024,1440]){
    const height=1100;await page.setViewportSize({width,height});
    await page.evaluate(async language=>{currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';document.body.classList.add('lumin-raised');LuminClinicManagement.languageChanged();await switchClinicManagementTab('finances')},language);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,'No shell overflow: '+language+' '+width);
    await page.locator('#clinic-management-tab-finances').focus();await page.keyboard.press(language==='ar'?'ArrowLeft':'ArrowRight');
    assert.equal(await page.evaluate(()=>activeClinicManagementTab),'inventory','Keyboard navigation follows the reading direction');
    await page.keyboard.press('Home');
    const targets=await page.locator('#view-clinic-management button:visible').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().toJSON()));
    assert.ok(targets.every(box=>box.width>=43.9&&box.height>=43.9),'44px clinic header touch targets');
    await page.locator('#cm-alert-bell').click();const box=await page.locator('#cm-alert-menu').boundingBox();
    assert.ok(box.x>=0&&box.x+box.width<=width+1&&box.y+box.height<=height+1,'Alerts stay within the viewport');
    assert.match(await page.locator('#cm-alert-menu').textContent(),language==='ar'?/رواتب أطباء/:/Doctor payroll/);
    await page.locator('.cm-alert-row .cm-button').first().click();
    assert.match(await page.locator('.cm-payment-preview-row').textContent(),/Mariam Hassan/);
    const action=await page.locator('.cm-payment-preview-actions button').boundingBox();
    assert.ok(action.width>=44&&action.height>=44&&action.x>=0&&action.x+action.width<=width+1);
    await page.keyboard.press('Escape');
    if(process.env.LUMIN_CM_SCREENSHOT_DIR){fs.mkdirSync(process.env.LUMIN_CM_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.LUMIN_CM_SCREENSHOT_DIR,`clinic-${language}-${width}.png`),fullPage:true});}
  }
  await page.evaluate(async()=>{currentUiLanguage='en';document.documentElement.dir='ltr';failAlerts=true;await LuminClinicManagement.refresh({force:true})});
  await page.locator('#cm-alert-bell').click();assert.match(await page.locator('#cm-alert-body').textContent(),/could not be refreshed/);
  await page.evaluate(()=>{failAlerts=false});await page.locator('.cm-error button').click();
  await page.waitForFunction(()=>!document.querySelector('#cm-alert-body .cm-error'));await page.keyboard.press('Escape');

  for(const tab of ['inventory','analytics','hr','finances']){
    await page.evaluate(async tab=>{currentUserAccess.permissions=new Set([tab]);hrDoctorPayrollLoadedMonth='';activeClinicManagementTab='finances';LuminClinicManagement.reset();await switchClinicManagementTab('overview')},tab);
    assert.equal(await page.evaluate(()=>activeClinicManagementTab),tab,'Single-section users reach their authorized section');
    assert.equal(await page.locator('#cm-alert-bell').isVisible(),tab!=='inventory');
    for(const candidate of ['finances','inventory','analytics','hr'])assert.equal(await page.locator('#clinic-management-tab-'+candidate).isVisible(),candidate===tab);
  }
  await page.evaluate(async()=>{currentUserAccess.permissions=new Set();await switchClinicManagementTab()});
  assert.equal(await page.evaluate(()=>fallbackView),'dashboard','Users without clinic access return to an authorized page');
  await page.evaluate(async()=>{currentUserAccess.permissions=new Set(['finances','analytics','hr']);LuminClinicManagement.reset();await switchClinicManagementTab('finances');await LuminClinicManagement.refresh()});
  await page.evaluate(()=>{deferAlerts=true;void LuminClinicManagement.refresh({force:true})});await page.waitForFunction(()=>deferred.length===1);
  await page.evaluate(async()=>{currentSession={user:{id:'other'}};currentUserAccess.permissions=new Set(['analytics']);deferAlerts=false;LuminClinicManagement.reset();await switchClinicManagementTab('analytics');await LuminClinicManagement.refresh();deferred.splice(0).forEach(resolve=>resolve())});
  assert.equal(await page.locator('#cm-alert-count').isVisible(),false,'A late response from the previous account cannot restore its alerts');
  assert.doesNotMatch(await page.locator('#cm-alert-body').textContent(),/Mariam|Doctor payroll|Patient balance/);
  await page.evaluate(async()=>{clinicDay='2026-11-05';await LuminClinicManagement.refresh()});
  assert.deepEqual(await page.evaluate(()=>calls.filter(call=>call.name==='get_clinic_management_overview').at(-1).args),{p_start_date:'2026-11-05',p_end_date:'2026-11-05'},'Alerts follow the clinic date without overview date controls');
  assert.equal(await page.evaluate(()=>calls.filter(call=>call.name==='get_clinic_doctor_day_payroll').length),0);
  assert.deepEqual(errors,[]);
});
