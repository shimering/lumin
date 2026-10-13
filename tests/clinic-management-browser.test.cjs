const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright'),root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
function source(name){const start=html.search(new RegExp('    (?:async )?function '+name+'\\('));assert.ok(start>=0,name);const tail=html.slice(start);return tail.slice(0,tail.indexOf('\n    }')+6);}
test('clinic overview, dropdown, payroll payment, permissions and bilingual layouts work',async t=>{
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
  await page.addScriptTag({path:path.join(root,'vendor/lucide.min.js')});
  await page.addScriptTag({content:
    "let currentUiLanguage='en',currentSession={user:{id:'actor'}},currentUserAccess={active:true,isAdmin:true,permissions:new Set(['finances','analytics','hr','finance_depts','patients'])},activeClinicManagementTab='overview',activeFinanceTab='invoices',activeHrDoctorDetailsId=null,hrDirectoryLoaded=true;"+
    "window.calls=[];window.paymentCancelled=true;window.payrollPaid=false;window.failPayroll=false;window.empty=false;window.deferDoctor=false;window.deferred=[];"+
    "window.transferComplete=false;window.transferFailure=false;window.deferTransfer=false;window.transferResolvers=[];window.patientRefreshes=0;function renderPatientInvoices(){patientRefreshes++}"+
    "function hasPageAccess(page){return page==='clinic-management'?['finances','analytics','hr'].some(key=>currentUserAccess.permissions.has(key)):currentUserAccess.permissions.has(page)}"+
    "function canModifyHr(){return hasPageAccess('hr')&&currentUserAccess.isAdmin}"+
    "function formatInvoiceMoney(value){return 'EGP '+Number(value).toLocaleString('en-US')}"+
    "function invoiceNumber(value){return 'INV-'+value}function dentalTranslate(value){return value}function canViewPatientInvoices(){return true}function hrClinicDateValue(){return '2026-10-13'}function currentHrMonth(){return '2026-10'}"+
    "const hrDirectoryUsers=[{userId:'a',fullName:'Dr. Ahmed',active:true,isDoctor:true},{userId:'staff',fullName:'Staff',active:true,isDoctor:false}],hrAttendanceSessions=[{user_id:'a',work_date:'2026-10-13',check_in_at:'today'},{user_id:'staff',work_date:'2026-10-12',check_in_at:'yesterday'}],hrSalaryAdvances=[{amount:300}],hrPayrollPeriod={status:'draft'};"+
    "function hrDoctorMetrics(){return{salary:300}}function hrUserMetrics(){return{salary:500,paid:false}}async function refreshHrDirectory(){return true}async function ensureDentalCustomizationLoaded(){}function showAppointmentNotificationToast(){}"+
    "async function openHrSalaryPaymentDialog(config){window.paymentConfig=config;if(paymentCancelled)return false;await config.pay('cash');return true}"+
    "async function openHrDoctorDetails(id){activeHrDoctorDetailsId=id}async function loadHrDoctorSettlementCases(){calls.push({name:'hr-detail'})}"+
    "async function switchFinanceTab(tab){activeFinanceTab=tab}async function refreshActiveAnalyticsTab(){}function openPatientInvoices(patient,view){window.invoiceOpened={patient,view}}"+
    "const patientRows=Array.from({length:25},(_,i)=>({invoice_id:1042+i,invoice_item_id:1042+i,patient_id:'patient-'+i,patient_name:i===0?'Mariam Hassan':'Patient '+i,doctor_id:'a',doctor_name:'Dr. Ahmed',finding_id:'finding-'+i,operation_name:'Composite',tooth:'14',invoice_amount:1200,doctor_amount:i===2?180:360,transferred:true,payment_id:null}));"+
    "const db={rpc:async(name,args)=>{calls.push({name,args});if(name==='hr_pay_doctor_procedures_with_method'){payrollPaid=true;return{data:true}}"+
    "if(name==='transfer_doctor_salary_invoice_item'){if(transferFailure)return{error:{message:'fixture transfer failure'}};if(deferTransfer)await new Promise(resolve=>transferResolvers.push(resolve));transferComplete=true;return{data:true}}"+
    "if(name==='get_clinic_management_overview'){const financial=hasPageAccess('finances')||hasPageAccess('analytics');return{data:{finance:financial?{income_total:184600,expense_total:112400,net_total:72200,debt_total:hasPageAccess('finances')?126000:null,debt_patient_count:hasPageAccess('finances')?34:null,unpaid_expense_count:3,unpaid_expense_total:18200,expense_types:[{name:'Payroll',amount:48000},{name:'Materials',amount:64400}],days:[{day:'2026-10-01',income:100000,expense:60000},{day:'2026-10-13',income:84600,expense:52400}]}:null,hr:hasPageAccess('hr')?{payroll_invoice_count:payrollPaid?0:4,payroll_doctor_count:payrollPaid?0:3,payroll_amount:payrollPaid?0:980,payroll_preview:payrollPaid?[]:[{doctor_id:'a',doctor_name:'Dr. Ahmed',patient_name:'Mariam Hassan',patient_id:'patient-0',invoice_id:1042,invoice_item_id:1042,operation_name:'Composite',doctor_amount:180,day:'2026-10-12'}]}:null}}}"+
    "if(name==='get_clinic_doctor_day_payroll'){if(failPayroll)return{error:{message:'failure'}};const doctor=args.p_user_id||'a';const rows=(empty?[]:patientRows).filter(row=>!args.p_untransferred_only||(!row.payment_id&&row.transferred));const data={doctor_id:doctor,doctors:[{id:'a',name:'Dr. Ahmed'},{id:'b',name:'Dr. Sara'}],day:args.p_day,rows:rows.slice((args.p_page-1)*20,args.p_page*20).map(row=>({...row,doctor_id:doctor,patient_name:doctor==='b'?'Sara patient':row.patient_name,payment_id:payrollPaid?'paid':null})),invoice_count:rows.length,total_count:rows.length,ready_amount:empty||payrollPaid?0:1260,ready_count:2,payroll_amount:180};if(deferDoctor&&doctor==='a')await new Promise(resolve=>deferred.push(resolve));return{data}}return{data:null}}};"+
    source('firstAuthorizedClinicManagementTab')+source('switchClinicManagementTab')+
    "document.getElementById('auth-gate').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');document.querySelectorAll('main>section').forEach(node=>node.classList.add('hidden'));document.getElementById('view-clinic-management').classList.remove('hidden');window.location.hash='clinic-management';"
  });
  await page.addScriptTag({path:path.join(root,'lumin-clinic-management.js')});
  await page.evaluate(async()=>{LuminClinicManagement.init();await switchClinicManagementTab('overview')});
  assert.deepEqual(errors,[]);assert.equal(await page.locator('.cm-invoice-row').count(),20);assert.equal(await page.locator('#cm-alert-count').textContent(),'5');
  assert.equal(await page.locator('#cm-payroll-rows').evaluate(node=>node.scrollHeight>node.clientHeight),true,'Invoice entries scroll inside their own box');
  await page.locator('#cm-alert-bell').click();assert.equal(await page.locator('#cm-alert-menu').isVisible(),true);
  assert.equal(await page.locator('.cm-alert-row').count(),5);await page.keyboard.press('Escape');
  assert.equal(await page.locator('#cm-alert-menu').isVisible(),false);assert.equal(await page.locator('#cm-alert-bell').evaluate(node=>node===document.activeElement),true);
  await page.locator('#cm-alert-bell').click();await page.locator('#cm-payroll-heading').click();assert.equal(await page.locator('#cm-alert-menu').isVisible(),false);
  await page.locator('#cm-alert-bell').click();await page.locator('.cm-alert-row .cm-button').first().click();
  assert.equal(await page.locator('.cm-payment-preview-actions button').count(),1,'Pending payroll has only a redirect to HR');
  assert.equal(await page.locator('[data-salary-transfer-item]').count(),0,'No manual salary transfer buttons');
  await page.locator('.cm-payment-preview-actions button').click();
  assert.equal(await page.evaluate(()=>activeHrDoctorDetailsId),'a');
  assert.equal(await page.locator('#hr-doctor-payroll-day').inputValue(),'2026-10-12');
  await page.evaluate(async()=>{await switchClinicManagementTab('overview');LuminClinicManagement.setDay('2026-10-13');await LuminClinicManagement.loadPayroll()});
  await page.locator('#cm-payroll-footer .cm-button-primary').click();
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='hr_pay_doctor_procedures_with_method').length),0,'Cancel must never record a payment');
  await page.evaluate(()=>{paymentCancelled=false});await page.locator('#cm-payroll-footer .cm-button-primary').click();
  const payment=await page.evaluate(()=>calls.find(c=>c.name==='hr_pay_doctor_procedures_with_method').args);
  assert.deepEqual(payment,{p_user_id:'a',p_scope:'day',p_start_date:'2026-10-13',p_end_date:'2026-10-13',p_finding_ids:null,p_payment_method_id:'cash',p_expected_amount:1260});
  assert.equal(await page.locator('#cm-payroll-footer .cm-button-primary').isDisabled(),true,'Paid day cannot be paid again');
  await page.locator('#cm-payroll-footer .cm-button').first().click();
  assert.equal(await page.locator('#hr-doctor-payroll-scope').inputValue(),'day');assert.equal(await page.locator('#hr-doctor-payroll-day').inputValue(),'2026-10-13');
  await page.evaluate(()=>switchClinicManagementTab('overview'));
  await page.evaluate(()=>{payrollPaid=false;deferDoctor=true;LuminClinicManagement.setDoctor('a')});
  await page.waitForFunction(()=>deferred.length===1);
  await page.evaluate(()=>{deferDoctor=false;LuminClinicManagement.setDoctor('b')});
  await page.waitForFunction(()=>document.querySelector('.cm-patient').textContent.includes('Sara patient'));
  await page.evaluate(()=>deferred.splice(0).forEach(resolve=>resolve()));
  assert.match(await page.locator('.cm-patient').first().textContent(),/Sara patient/,'Late response from the previous doctor is ignored');
  await page.evaluate(()=>LuminClinicManagement.setDoctor('a'));
  await page.waitForFunction(()=>document.querySelector('.cm-patient').textContent.includes('Mariam Hassan'));
  await page.evaluate(()=>LuminClinicManagement.refresh({force:true}));
  await page.locator('#cm-payroll-filter').selectOption('unpaid');
  await page.waitForFunction(()=>calls.some(call=>call.name==='get_clinic_doctor_day_payroll'&&call.args.p_untransferred_only===true));
  await page.locator('#cm-payroll-filter').selectOption('all');
  for(const language of ['en','ar'])for(const width of [320,390,820,1440]){
    await page.setViewportSize({width,height:1100});
    await page.evaluate(language=>{currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';document.body.classList.add('lumin-raised');LuminClinicManagement.languageChanged()},language);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,'No shell overflow: '+language+' '+width);
    assert.equal(await page.locator('#cm-alert-bell').evaluate(node=>getComputedStyle(node).color),'rgb(225, 29, 72)','Alert bell retains red status in the raised theme');
    await page.locator('#cm-alert-bell').click();const box=await page.locator('#cm-alert-menu').boundingBox();
    assert.ok(box.x>=0&&box.x+box.width<=width+1&&box.y+box.height<=1101,'Dropdown stays inside viewport');
    assert.match(await page.locator('#cm-alert-menu').textContent(),language==='ar'?/رواتب أطباء/:/Doctor payroll/);
    await page.locator('.cm-alert-row .cm-button').first().click();
    assert.match(await page.locator('.cm-payment-preview-row').textContent(),/Mariam Hassan/);
    assert.equal(await page.locator('[data-salary-transfer-item]').count(),0);
    const actionBoxes=await page.locator('.cm-payment-preview-actions button').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().toJSON()));
    assert.ok(actionBoxes.every(box=>box.width>=44&&box.height>=44&&box.x>=0&&box.x+box.width<=width+1),'Transfer actions fit and have 44px touch targets');
    await page.keyboard.press('Escape');
    const targets=await page.locator('#view-clinic-management button:visible').evaluateAll(nodes=>nodes.map(n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})));
    assert.ok(targets.every(n=>n.width>=43.9&&n.height>=43.9),'44px touch targets');
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('#cm-alert-bell').evaluate(node=>getComputedStyle(node,'::before').animationName),'none');
  await page.evaluate(()=>{currentUserAccess.permissions.delete('patients')});
  await page.locator('#cm-alert-bell').click();await page.locator('.cm-alert-row .cm-button').first().click();
  assert.equal(await page.locator('[data-salary-transfer-item]').count(),0,'HR access never shows a manual transfer action');
  assert.equal(await page.locator('.cm-payment-preview-actions button').isEnabled(),true,'HR users can review pending payroll without chart access');
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='transfer_doctor_salary_invoice_item').length),0,'Only HR payments use financial write RPCs');
  await page.keyboard.press('Escape');
  await page.evaluate(async()=>{currentUiLanguage='en';document.documentElement.dir='ltr';failPayroll=true;await LuminClinicManagement.loadPayroll()});
  assert.match(await page.locator('#cm-payroll-rows').textContent(),/Could not load/);assert.equal(await page.locator('#cm-payroll-footer .cm-button-primary').isDisabled(),true);
  await page.evaluate(async()=>{failPayroll=false;currentUserAccess.permissions=new Set(['analytics']);LuminClinicManagement.reset();await LuminClinicManagement.refresh({force:true})});
  assert.equal(await page.locator('#cm-payroll-panel').isVisible(),false);assert.equal(await page.locator('#cm-team-panel').isVisible(),false);
  assert.equal(await page.locator('#cm-alert-count').isVisible(),false);assert.equal(await page.locator('#cm-alert-bell').evaluate(node=>node.classList.contains('has-alerts')),false);
  await page.evaluate(()=>{currentUserAccess.permissions=new Set(['finances','analytics','hr']);deferDoctor=true;LuminClinicManagement.reset();void LuminClinicManagement.refresh({force:true})});
  await page.waitForFunction(()=>deferred.length===1);
  await page.evaluate(async()=>{currentSession={user:{id:'other'}};currentUserAccess.permissions=new Set(['analytics']);deferDoctor=false;LuminClinicManagement.reset();await LuminClinicManagement.refresh({force:true});deferred.splice(0).forEach(resolve=>resolve())});
  assert.equal(await page.locator('#cm-payroll-rows').textContent(),'','A response from the previous account cannot populate the payroll list');
  assert.deepEqual(errors,[]);
  if(process.env.LUMIN_CM_SCREENSHOT_DIR){
    fs.mkdirSync(process.env.LUMIN_CM_SCREENSHOT_DIR,{recursive:true});
    await page.evaluate(async()=>{currentUserAccess.permissions=new Set(['finances','analytics','hr','finance_depts','patients']);LuminClinicManagement.reset();await LuminClinicManagement.refresh({force:true})});
    await page.setViewportSize({width:1440,height:1100});
    await page.screenshot({path:path.join(process.env.LUMIN_CM_SCREENSHOT_DIR,'clinic-overview.png'),fullPage:true});
    await page.locator('#cm-alert-bell').click();
    await page.screenshot({path:path.join(process.env.LUMIN_CM_SCREENSHOT_DIR,'clinic-alerts.png'),fullPage:true});
    await page.evaluate(()=>LuminClinicManagement.reviewAlert('payments'));
    await page.screenshot({path:path.join(process.env.LUMIN_CM_SCREENSHOT_DIR,'clinic-transfer-alerts.png'),fullPage:true});
  }
});
