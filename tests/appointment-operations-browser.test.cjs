const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}

test('optional appointment operations save, edit and open the chart across desktop, tablet and mobile RTL', async t => {
  const fixture = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(fixture); return; }
    const target = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', target.endsWith('.css') ? 'text/css' : 'application/javascript');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || 'chrome', executablePath: process.env.LUMIN_TEST_BROWSER_EXECUTABLE || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.goto(base);
  await page.addScriptTag({url: base + '/vendor/lucide.min.js'});
  await page.addScriptTag({content: html.slice(html.indexOf('    const luminLucideIcons ='),html.indexOf('    let patients = []'))});
  await page.addScriptTag({url: base + '/lumin-dental-i18n.js'});
  await page.addScriptTag({url: base + '/lumin-appointment-operations.js'});
  const helpers = ['appointmentModalUsesNote','setAppointmentModalEntryMode','selectAppointmentPatient','syncAppointmentSaveButton',
    'appointmentDateFromInput','setAppointmentDurationSelection','updateAppointmentModalDateLabel',
    'openAppointmentModal','closeAppointmentModal','saveAppointment','normaliseAppointmentRecord','renderDashboard',
    'isPrimaryToothId','palmerPositionForSlot','palmerQuadrantForSlot','palmerToothNotation','palmerQuadrantLabel','palmerNotationSVG','wholeMouthIconSVG',
    'normaliseSpecialtyIconName','specialtyIconMarkup','appointmentPopoverText','appointmentPopoverAnchor',
    'positionAppointmentCardPopover','closeAppointmentCardPopover','openAppointmentCardPopover'];
  await page.addScriptTag({content: `
    let currentUiLanguage='en', currentSession={user:{id:'staff'}}, targetedLoadingGeneration=0, allowed=true;
    let editingAppointmentId=null, appointmentModalEntryMode='patient',appointmentModalOpenSequence=0,patientModalReturnToAppointment=false;
    const appointmentPatientSearchRecords=new Map(),recentLocalAppointmentChanges=new Map();
    const patients=[{id:'p1',name:'Patient One',age:30},{id:'p2',name:'Patient Two',age:24}];
    const appointmentStaff=[{userId:'doctor',fullName:'Dr. Lumin',canReceiveAppointments:true}];
    const appointmentVisitTypes=[{id:'check',name:'Check-up',active:true}],APPOINTMENT_TIME_STEP=15,APPOINTMENT_SELECT_FIELDS='id,operations';
    let appointments=[], appointmentSelectedDate=new Date(2026,9,14),appointmentVisibleMonth=new Date(2026,9,1),selectedAppointmentId=null;
    const currentUserAccess={isDoctor:true},appointmentToday=appointmentSelectedDate,dashboardSelectedDate=appointmentSelectedDate;
    const appointmentDayFormatter=new Intl.DateTimeFormat('en',{dateStyle:'long'}),appointmentTimeFormatter=new Intl.DateTimeFormat('en',{hour:'numeric',minute:'2-digit'});
    let dashboardInvoiceRenderToken=0,expandedDashboardAppointmentId=null,appointmentsLoaded=true;
    let appointmentCardPopoverId=null,appointmentCalendarMode='day',whatsappTemplatePickerScope=null;
    ${html.slice(html.indexOf('    const PRIMARY_TOOTH_BY_SLOT ='),html.indexOf('    const CONDITION_LABELS ='))}
    ${html.slice(html.indexOf('    const SPECIALTY_ICON_OPTIONS ='),html.indexOf('    const DEFAULT_SPECIALTY_ACCENT_COLOR ='))}
    ${html.match(/    const APPOINTMENT_STATUSES = [^\n]+/)[0]}
    const appointmentShortDateFormatter=appointmentDayFormatter;
    const dashboardDayCache=new Map(),dashboardStatusPicker={markup:entry=>'<span>'+entry.status+'</span>',retainTrigger(){}};
    window.fixture={writes:[],alerts:[],chart:null,fail:false,pending:false,resolvers:[],options:[
      {finding_ids:['f1'],code:'filling',name:'Composite restoration',status:'P',tooth_ids:['11'],surfaces:['B','O']},
      {finding_ids:['f2','f3'],code:'crown',name:'A long operation name that should wrap without pushing controls beyond the viewport',status:'In',tooth_ids:['12','13'],surfaces:[]},
      {finding_ids:['f4'],code:'completed',name:'Completed crown',status:'C',tooth_ids:['14'],surfaces:[]}
    ]};
    function hasPageAccess(){return true} function canModifyAppointments(){return allowed}
    function escapeAppointmentText(value){return String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;').replaceAll("'",'&#39;')}
    function escapeHtml(value){return escapeAppointmentText(value)}
    function appointmentDateKey(date){return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-')}
    function appointmentTimeInputFromMinutes(n){return String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0')}
    function appointmentTimeFromMinutes(n){return appointmentTimeInputFromMinutes(n)}
    function appointmentDurationLabel(n){return n+' min'}
    function appointmentPatientRecord(id){return patients.find(p=>p.id===id)||appointmentPatientSearchRecords.get(id)}
    function appointmentPatientDisplayValue(p){return p.name}
    function resetAppointmentPatientSearch(){} function closeAppointmentPatientResults(){} function renderAppointmentPatientOptions(){}
    function ensureAppointmentsLoaded(){return Promise.resolve(true)} function ensureAppointmentVisitTypesLoaded(){return Promise.resolve(true)}
    function renderAppointmentDoctorOptions(id){document.getElementById('appointment-assigned-user-id').innerHTML='<option value="doctor">Dr. Lumin</option>';return true}
    function refreshAppointmentVisitTypeSelector(){document.getElementById('appointment-type').innerHTML='<option value="check">Check-up</option>'}
    function appointmentVisitTypeForEntry(){return appointmentVisitTypes[0]}
    function appointmentStaffMember(){return appointmentStaff[0]} function normaliseHexColor(c){return c}
    function canonicalAppointmentStatus(s){return s} function markLocalAppointmentChange(){}
    function appointmentTimeRange(entry){return entry.time} function arabicUiPhrase(value){return value}
    function whatsAppSplitControlMarkup(){return ''} function changeAppointmentCardStatus(){}
    function queueGoogleCalendarAppointmentSync(){} function queueAppointmentPushNotification(){}
    function renderAppointments(){renderDashboard()} function realtimeViewIsVisible(){return false}
    function replaceAppointmentRecord(row){const entry=normaliseAppointmentRecord(row);appointments=appointments.filter(a=>a.id!==row.id);appointments.push(entry);return entry}
    function openPatientChart(patientId,view){fixture.chart={patientId,view};return Promise.resolve()}
    function refreshMyAttendanceState(){} function ensureDashboardAppointmentsLoaded(){}
    function canViewDashboardInvoices(){return false} function syncDashboardMobileTabs(){}
    function renderDashboardDoctorFilter(){return {label:'Dr. Lumin'}} function dashboardAppointmentsForDate(){return appointments}
    function dashboardDayContext(){return 'fixture'} function sameAppointmentDate(){return true}
    function patientAgeLabel(){return '30 yrs'} function normaliseCallPhone(){return ''} function normaliseWhatsAppPhone(){return ''}
    function appointmentColorRgba(){return '#eff6ff'} function appointmentTextColor(){return '#1d4ed8'}
    function checkedInWaitIndicatorMarkup(){return ''} function appointmentVisitTypeBadgeMarkup(){return '<span>Check-up</span>'}
    function dashboardMobileContactActionsMarkup(){return ''} function refreshWhatsAppTemplatePickerAnchor(){} function ensureAppointmentWaitIndicatorTimer(){}
    function setStableHtml(node,markup){node.innerHTML=markup;return true}
    window.alert=message=>fixture.alerts.push(message);
    function savedRow(payload,id){return {...payload,id,operations:(payload.operations||[]).flatMap(link=>fixture.options.filter(o=>JSON.stringify(o.finding_ids)===JSON.stringify(link.finding_ids))),patients:patients.find(p=>p.id===payload.patient_id)}}
    function updateAppointmentRecordWithRetry(id,payload){fixture.writes.push(payload);return Promise.resolve({data:savedRow(payload,id)})}
    const db={rpc(name,args){
      if(name==='get_appointment_operation_catalog')return Promise.resolve({data:fixture.options.map(o=>({code:o.code,name:o.name,category_name:o.code==='crown'?'Crown':'Restoration',icon_name:o.code==='crown'?'dental-crown':'dental-restorative'}))});
      if(name!=='get_patient_appointment_operations')throw Error(name);
      if(fixture.pending)return new Promise(resolve=>fixture.resolvers.push(resolve));
      return Promise.resolve(fixture.fail?{error:Error('offline')}:{data:args.p_patient_id==='p1'?fixture.options:[]});
    },from(){return {insert(payload){this.payload=payload;fixture.writes.push(payload);return this},select(){return this},single(){return Promise.resolve({data:savedRow(this.payload,'a'+fixture.writes.length)})}}}};
    ${helpers.map(source).join('\n')}
    document.getElementById('auth-gate').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');
    document.getElementById('view-dashboard').classList.remove('hidden');
  `});
  const choose = page.locator('#appointment-operations-choose');
  const picker = page.locator('#appointment-operation-picker');
  const apply = page.locator('[data-operation-apply]');
  const screenshots = process.env.LUMIN_OPERATIONS_SCREENSHOT_DIR || path.join(os.tmpdir(), 'lumin-appointment-operations-preview');
  fs.mkdirSync(screenshots,{recursive:true});
  const open = () => page.evaluate(async () => { await openAppointmentModal(); selectAppointmentPatient('p1'); });
  await open();
  await page.evaluate(()=>saveAppointment({preventDefault(){}}));
  assert.deepEqual(await page.evaluate(()=>fixture.writes[0].operations), [], 'appointment saves without operations');
  assert.equal(await page.locator('.dashboard-appointment-operations').count(),0);
  await open(); await choose.click();
  assert.equal(await page.locator('.appointment-operation-option').count(),2,'only planned and in-progress operations are available');
  assert.equal(await page.locator('.appointment-operation-option .dental-specialty-icon').count(),2);
  assert.match(await page.locator('.appointment-operation-option').first().locator('img').getAttribute('src'),/dental-restorative/);
  assert.equal(await page.locator('.appointment-operation-option').first().locator('.palmer-value').textContent(),'3');
  assert.equal(await page.locator('.appointment-operation-option').first().locator('.palmer-bracket').getAttribute('d'),'M7 4 V23 H36');
  await page.locator('.appointment-operation-option').first().click();
  await page.locator('[data-operation-cancel]').click();
  assert.equal(await page.locator('.appointment-operation-selected .appointment-operation-row').count(),0,'cancel discards draft links');
  await choose.click();
  await page.locator('.appointment-operation-option').first().click();
  await page.locator('.appointment-operation-option').nth(1).click();
  await apply.click();
  assert.equal(await page.locator('.appointment-operation-row').count(),2);
  await page.evaluate(()=>saveAppointment({preventDefault(){}}));
  assert.deepEqual(await page.evaluate(()=>fixture.alerts),[]);
  assert.equal(await page.locator('.dashboard-operation-link').count(),2,JSON.stringify(await page.evaluate(()=>({writes:fixture.writes,appointments,errors:fixture.alerts}))));
  await page.locator('.dashboard-operation-link').first().click();
  assert.deepEqual(await page.evaluate(()=>fixture.chart),{patientId:'p1',view:'dashboard'});
  await page.locator('[data-operation-appointment]').click();
  assert.equal(await picker.isVisible(),true,'dashboard edit opens the picker');
  await page.locator('[data-operation-cancel]').click();
  await page.locator('.appointment-operation-remove').first().click();
  await page.evaluate(()=>saveAppointment({preventDefault(){}}));
  assert.equal(await page.locator('.dashboard-operation-link').count(),1,'removal persists after saving');
  await page.locator('.dashboard-appointment-operations').screenshot({path:path.join(screenshots,'dashboard-desktop.png')});
  await page.evaluate(()=>{
    fixture.options[1].tooth_ids=['8','9','24','25','E','F','O','P'];
    appointments.find(a=>a.id==='a2').operations=[structuredClone(fixture.options[1])];
    const anchor=document.createElement('button');anchor.type='button';anchor.dataset.timelineAppointmentId='a2';anchor.textContent='Appointment';document.body.append(anchor);
  });

  for(const [width,height] of [[1440,1000],[834,1112],[390,844],[320,568]]) for(const language of ['en','ar']) {
    await page.setViewportSize({width,height});
    await page.evaluate(language=>{currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';openAppointmentCardPopover('a2');},language);
    const popup=page.locator('#appointment-card-popover'),operations=popup.locator('[data-appointment-detail-card="operations"]');
    assert.equal(await operations.isVisible(),true,'appointment page popup includes linked treatments');
    assert.equal(await operations.locator('.palmer-symbol').count(),8);
    assert.deepEqual(await operations.locator('.palmer-value').allTextContents(),['1','1','1','1','A','A','A','A']);
    assert.deepEqual(await operations.locator('.palmer-bracket').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('d'))),
      ['M33 4 V23 H4','M7 4 V23 H36','M7 24 V5 H36','M33 24 V5 H4','M33 4 V23 H4','M7 4 V23 H36','M7 24 V5 H36','M33 24 V5 H4']);
    assert.match(await operations.locator('img').getAttribute('src'),/dental-crown/);
    assert.equal(await operations.locator('img').evaluate(image=>image.complete&&image.naturalWidth>0),true);
    assert.equal(await operations.locator('.appointment-operation-tooth').first().evaluate(node=>getComputedStyle(node).direction),'ltr','Palmer brackets keep their anatomical orientation in Arabic');
    assert.equal(await popup.evaluate(node=>node.scrollWidth>node.clientWidth),false,'operation details never cause popup horizontal scroll');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await operations.scrollIntoViewIfNeeded();
    if(width===1440||width===390)await popup.screenshot({path:path.join(screenshots,`appointment-popup-${width}-${language}.png`)});
    await operations.locator('.dashboard-operation-link').click();
    assert.deepEqual(await page.evaluate(()=>fixture.chart),{patientId:'p1',view:'appointments'});
    assert.equal(await popup.isVisible(),false,'chart navigation closes appointment details');
  }
  await page.evaluate(()=>openAppointmentCardPopover('a2'));
  await page.locator('#appointment-card-popover [data-operation-appointment]').click();
  assert.equal(await page.locator('#appointment-card-popover').isVisible(),false,'editing closes the appointment popup');
  assert.equal(await picker.isVisible(),true);
  await page.locator('[data-operation-cancel]').click();
  await page.evaluate(()=>closeAppointmentModal());

  for (const [width,height] of [[1440,1000],[834,1112],[390,844],[320,568]]) {
    await page.setViewportSize({width,height});
    for (const language of ['en','ar']) {
      await page.evaluate(language=>{currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';},language);
      await open(); await choose.click();
      await page.locator('.appointment-operation-option').first().click();
      const bounds=await page.locator('.appointment-operation-dialog').boundingBox();
      assert.ok(bounds.x>=-1&&bounds.x+bounds.width<=width+1&&bounds.y>=-1&&bounds.y+bounds.height<=height+1,JSON.stringify({width,language,bounds}));
      if(width<768)assert.ok(Math.abs(bounds.y+bounds.height-height)<2,'mobile picker is a bottom sheet');
      for(const selector of ['[data-operation-close]','[data-operation-cancel]','[data-operation-apply]']) {
        const size=await page.locator(selector).boundingBox();assert.ok(size.width>=44&&size.height>=44);
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert.equal(await page.locator('#appointment-operation-count').textContent(),language==='ar'?'1 محدد':'1 selected');
      if(width===1440||width===390)await picker.screenshot({path:path.join(screenshots,`picker-${width}-${language}.png`)});
      await page.locator('#appointment-operation-search').fill('11');
      assert.equal(await page.locator('.appointment-operation-option').count(),1);
      await page.keyboard.press('Escape');assert.equal(await picker.isVisible(),false);
      assert.equal(await choose.evaluate(node=>node===document.activeElement),true);
      await page.evaluate(()=>closeAppointmentModal());
      if(width===390) {
        await page.evaluate(()=>renderDashboard());
        await page.locator('[data-dashboard-appointment-card]').last().screenshot({path:path.join(screenshots,`dashboard-390-${language}.png`)});
      }
    }
  }
  await open();await page.evaluate(()=>{fixture.fail=true;});await choose.click();
  assert.equal(await apply.isDisabled(),true);assert.match(await picker.textContent(),/Could not load|تعذر تحميل/);
  await page.evaluate(()=>{fixture.fail=false;});await page.locator('.appointment-operation-empty button').click();
  assert.equal(await page.locator('.appointment-operation-option').count(),2);
  await page.locator('[data-operation-cancel]').click();
  await page.evaluate(()=>{fixture.pending=true;void openAppointmentOperationPicker();});
  assert.equal(await page.locator('.appointment-operation-skeleton').isVisible(),true);
  await page.evaluate(()=>selectAppointmentPatient('p2'));
  await page.evaluate(()=>{fixture.resolvers[0]({data:fixture.options});fixture.pending=false;});
  assert.equal(await picker.isVisible(),false,'changing patients closes the picker');
  assert.equal(await page.evaluate(()=>appointmentOperationState.selected.length),0);
  await choose.click();assert.equal(await page.locator('.appointment-operation-option').count(),0,'old response cannot populate another patient');
  await page.locator('[data-operation-cancel]').click();
  await page.evaluate(()=>{fixture.options[0].status='C';});
  await page.evaluate(async()=>{await openAppointmentModal('a2');});
  await choose.click();
  assert.equal(await page.locator('.appointment-operation-option').count(),1,'unlinked completed treatments cannot be newly selected');
  await page.locator('[data-operation-cancel]').click();
  await page.evaluate(()=>{allowed=false;});
  await page.evaluate(()=>renderAppointmentOperations());
  assert.equal(await choose.isDisabled(),true);
  await page.evaluate(()=>{allowed=true;selectAppointmentPatient('p2');});
  await page.evaluate(()=>setAppointmentModalEntryMode('note'));
  assert.equal(await page.locator('#appointment-operations-field').isVisible(),false);
  assert.deepEqual(errors,[]);
  assert.deepEqual(await page.evaluate(()=>fixture.alerts),[]);
});
