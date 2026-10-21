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
  await page.addScriptTag({path:path.join(root,'lumin-dates.js')});
  await page.addScriptTag({url: base + '/vendor/lucide.min.js'});
  await page.addScriptTag({content: html.slice(html.indexOf('    const luminLucideIcons ='),html.indexOf('    let patients = []'))});
  await page.addScriptTag({url: base + '/lumin-dental-i18n.js'});
  await page.addScriptTag({url: base + '/lumin-appointment-operations.js'});
  await page.addScriptTag({url: base + '/lumin-appointment-details.js'});
  const helpers = ['appointmentModalUsesNote','setAppointmentModalEntryMode','selectAppointmentPatient','syncAppointmentSaveButton',
    'appointmentDateFromInput','setAppointmentDurationSelection','updateAppointmentModalDateLabel',
    'openAppointmentModal','closeAppointmentModal','saveAppointment','normaliseAppointmentRecord','renderDashboard',
    'isPrimaryToothId','palmerPositionForSlot','palmerQuadrantForSlot','palmerToothNotation','palmerQuadrantLabel','palmerNotationSVG','wholeMouthIconSVG',
    'normaliseSpecialtyIconName','specialtyIconMarkup','appointmentPopoverText','appointmentPopoverAnchor',
    'positionAppointmentCardPopover','closeAppointmentCardPopover','openAppointmentCardPopover','changeAppointmentCardStatus','setupAppointmentCardPopover','blockAppointmentCardPopoverTouchThrough'];
  await page.addScriptTag({content: `
    let currentUiLanguage='en', currentSession={user:{id:'staff'}}, targetedLoadingGeneration=0, allowed=true;
    let editingAppointmentId=null, appointmentModalEntryMode='patient',appointmentModalOpenSequence=0,patientModalReturnToAppointment=false;
    const appointmentPatientSearchRecords=new Map(),recentLocalAppointmentChanges=new Map();
    const patients=[{id:'p1',name:'Patient One',age:30},{id:'p2',name:'Patient Two',age:24}];
    const appointmentStaff=[{userId:'doctor',fullName:'Dr. Lumin',canReceiveAppointments:true}];
    const appointmentVisitTypes=[{id:'check',name:'Check-up',active:true}],APPOINTMENT_TIME_STEP=15,APPOINTMENT_SELECT_FIELDS='id,operations';
    let appointments=[], appointmentSelectedDate=new Date(2026,9,14),appointmentVisibleMonth=new Date(2026,9,1),selectedAppointmentId=null;
    const currentUserAccess={isDoctor:true},appointmentToday=appointmentSelectedDate,dashboardSelectedDate=appointmentSelectedDate;
    const appointmentDayFormatter=LuminDates.formatter(),appointmentTimeFormatter=new Intl.DateTimeFormat('en',{hour:'numeric',minute:'2-digit'});
    let dashboardInvoiceRenderToken=0,expandedDashboardAppointmentId=null,appointmentsLoaded=true;
    let appointmentCardPopoverId=null,appointmentCalendarMode='day',whatsappTemplatePickerScope=null,appointmentCardPopoverTouchGuard=null;
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
    function hasPageAccess(page){return !fixture.denied?.includes(page)} function canModifyAppointments(){return allowed}
    function escapeAppointmentText(value){return String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;').replaceAll("'",'&#39;')}
    function escapeHtml(value){return escapeAppointmentText(value)}
    function appointmentDateKey(date){return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-')}
    function appointmentTimeInputFromMinutes(n){return String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0')}
    function appointmentTimeFromMinutes(n){return appointmentTimeInputFromMinutes(n)}
    function appointmentDurationLabel(n){return n+' min'}
    function appointmentPatientRecord(id){return patients.find(p=>p.id===id)||appointmentPatientSearchRecords.get(id)}
    function appointmentPatientDisplayValue(p){return p.name}
    function resetAppointmentPatientSearch(){} function closeAppointmentPatientResults(){} function renderAppointmentPatientOptions(){}
    function ensureAppointmentStaffLoaded(){return Promise.resolve(true)} function ensureAppointmentsLoaded(){return Promise.resolve(true)} function ensureAppointmentVisitTypesLoaded(){return Promise.resolve(true)}
    function renderAppointmentDoctorOptions(id){document.getElementById('appointment-assigned-user-id').innerHTML='<option value="doctor">Dr. Lumin</option>';return true}
    function refreshAppointmentVisitTypeSelector(){document.getElementById('appointment-type').innerHTML='<option value="check">Check-up</option>'}
    function appointmentVisitTypeForEntry(entry){return appointmentVisitTypes.find(type=>type.id===entry.visitTypeId)||appointmentVisitTypes[0]}
    function appointmentStaffMember(id){return appointmentStaff.find(staff=>staff.userId===id)||appointmentStaff[0]} function normaliseHexColor(c){return c}
    function canonicalAppointmentStatus(s){return s} function markLocalAppointmentChange(){}
    function appointmentTimeRange(entry){return entry.time} function arabicUiPhrase(value){return value}
    function whatsAppSplitControlMarkup(){return ''}
    function queueGoogleCalendarAppointmentSync(){} function queueAppointmentPushNotification(){}
    function renderAppointments(){renderDashboard()} function realtimeViewIsVisible(){return false}
    function replaceAppointmentRecord(row){const entry=normaliseAppointmentRecord(row);appointments=appointments.filter(a=>a.id!==row.id);appointments.push(entry);return entry}
    function openPatientWorkspace(patientId,tab){fixture.workspace={patientId,tab};return Promise.resolve()}
    function openPatientChart(patientId,view){fixture.chart={patientId,view};return Promise.resolve()}
    function deleteAppointment(id){fixture.deleted=id}
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
    function savedRow(payload,id){const old=appointments.find(entry=>entry.id===id);const row={patient_id:old?.patientId,assigned_user_id:old?.assignedUserId,appointment_at:old?.startAt,appointment_type:old?.type,visit_type_id:old?.visitTypeId,status:old?.status,notes:old?.notes,duration_minutes:old?.duration,operations:old?.operations||[],...payload,id};row.operations=row.operations.flatMap(link=>fixture.options.filter(o=>JSON.stringify(o.finding_ids)===JSON.stringify(link.finding_ids)));row.patients=patients.find(p=>p.id===row.patient_id);return row;}
    function updateAppointmentRecordWithRetry(id,payload){fixture.writes.push(payload);if(fixture.writePending)return new Promise(resolve=>{fixture.finishWrite=()=>resolve({data:savedRow(payload,id)})});return Promise.resolve(fixture.writeFail?{error:Error('Offline')}:{data:savedRow(payload,id)})}
    const db={rpc(name,args){
      if(name==='get_appointment_operation_catalog')return Promise.resolve({data:fixture.options.map(o=>({code:o.code,name:o.name,category_name:o.code==='crown'?'Crown':'Restoration',icon_name:o.code==='crown'?'dental-crown':'dental-restorative'}))});
      if(name!=='get_patient_appointment_operations')throw Error(name);
      if(fixture.pending)return new Promise(resolve=>fixture.resolvers.push(resolve));
      return Promise.resolve(fixture.fail?{error:Error('offline')}:{data:args.p_patient_id==='p1'?fixture.options:[]});
    },from(){return {insert(payload){this.payload=payload;fixture.writes.push(payload);return this},select(){return this},single(){return Promise.resolve({data:savedRow(this.payload,'a'+fixture.writes.length)})}}}};
    ${helpers.map(source).join('\n')}
    document.getElementById('auth-gate').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');
    document.getElementById('view-dashboard').classList.remove('hidden');
    setupAppointmentCardPopover();
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
    assert.equal(await popup.locator('[data-edit-appointment-popover]').count(),0);
    assert.equal(await popup.locator('header [data-delete-appointment-popover]').count(),1);
    assert.equal(await popup.locator('[data-delete-appointment-popover]').count(),1);
    assert.equal(await popup.locator('[data-close-appointment-popover]').isVisible(),width>=768);
    assert.equal(await popup.locator('.appointment-sheet-handle').isVisible(),width<768);
    await popup.evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished)));
    const deleteSize=await popup.locator('[data-delete-appointment-popover]').boundingBox();
    assert.ok(deleteSize.width>=44&&deleteSize.height>=44);
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
    for(const field of ['schedule','doctor']) {
      await popup.locator(`[data-edit-appointment-detail="${field}"]`).click();
      const editor=page.locator('#appointment-detail-editor');
      await editor.locator(field==='schedule'?'[data-lumin-date-text]':'#appointment-detail-doctor').waitFor();
      assert.equal(await editor.evaluate(node=>node.scrollWidth>node.clientWidth),false,'detail editor fits its viewport');
      const bounds=await editor.boundingBox();
      assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1&&bounds.y+bounds.height<=height+1,JSON.stringify({field,width,language,bounds}));
      if(field==='schedule')assert.equal(await editor.locator('[data-lumin-date-text]').inputValue(),'14/10/2026');
      if(width===390||width===1440)await editor.screenshot({path:path.join(screenshots,`appointment-${field}-${width}-${language}.png`)});
      await editor.locator('[data-detail-cancel]').click();
    }
    await operations.locator('.dashboard-operation-link').click();
    assert.deepEqual(await page.evaluate(()=>fixture.chart),{patientId:'p1',view:'appointments'});
    assert.equal(await popup.isVisible(),false,'chart navigation closes appointment details');
  }
  await page.evaluate(()=>openAppointmentCardPopover('a2'));
  await page.locator('#appointment-card-popover [data-operation-appointment]').click();
  assert.equal(await page.locator('#appointment-card-popover').isVisible(),false,'editing closes the appointment popup');
  assert.equal(await picker.isVisible(),true);
  assert.equal(await page.locator('#modal-appointment').isVisible(),false,'details operations open directly');
  await page.locator('[data-operation-cancel]').click();
  assert.equal(await page.locator('#appointment-card-popover').isVisible(),true,'cancel returns to appointment details');
  await page.evaluate(()=>{closeAppointmentCardPopover();closeAppointmentModal()});

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
  await t.test('details edit schedule, doctor, visit type and operations independently with retry and fast links', async () => {
    await page.setViewportSize({width:1440,height:1000});
    await page.evaluate(()=>{
      closeAppointmentModal();currentUiLanguage='en';document.documentElement.dir='ltr';
      appointmentStaff.push({userId:'doctor-2',fullName:'Dr. Salma',canReceiveAppointments:true});
      appointmentVisitTypes.push({id:'emergency',name:'Emergency',active:true});
      openAppointmentCardPopover('a2');
    });
    const popup=page.locator('#appointment-card-popover'),dialog=page.locator('#appointment-detail-editor');
    const status=popup.locator('[data-appointment-popover-status]'),visit=popup.locator('[data-appointment-popover-visit-type]');
    const boxes=await popup.evaluate(node=>['status','visit-type'].map(name=>node.querySelector(`[data-appointment-detail-card="${name}"]`).getBoundingClientRect().toJSON()));
    assert.ok(Math.abs(boxes[0].y-boxes[1].y)<2&&boxes[1].x>boxes[0].x,'visit type sits beside status: '+JSON.stringify(boxes));
    assert.equal(await popup.locator('[data-appointment-detail-card="fast-links"] button').count(),2);
    assert.equal(await popup.evaluate(node=>{
      const status=node.querySelector('[data-appointment-detail-card="status"]');
      const operations=node.querySelector('[data-add-appointment-operations]');
      const links=node.querySelector('[data-appointment-detail-card="fast-links"]');
      return Boolean(status.compareDocumentPosition(operations)&Node.DOCUMENT_POSITION_FOLLOWING)&&Boolean(operations.compareDocumentPosition(links)&Node.DOCUMENT_POSITION_FOLLOWING);
    }),true);
    await status.selectOption('Confirmed');
    await page.waitForFunction(()=>appointments.find(a=>a.id==='a2').status==='Confirmed');
    await visit.selectOption('emergency');
    await page.waitForFunction(()=>appointments.find(a=>a.id==='a2').visitTypeId==='emergency');
    assert.deepEqual(await page.evaluate(()=>fixture.writes.at(-1)),{visit_type_id:'emergency',appointment_type:'Emergency'});
    assert.equal(await popup.locator('[data-edit-appointment-popover]').count(),0,'general edit action is removed from details');
    await page.evaluate(()=>openAppointmentModal('a2'));
    assert.equal(await page.locator('#appointment-clinical-fields').isVisible(),false,'edit appointment has no status or visit controls');
    await page.evaluate(()=>{document.getElementById('appointment-status').value='Cancelled';document.getElementById('appointment-notes').value='Updated note';});
    await page.evaluate(()=>saveAppointment({preventDefault(){}}));
    assert.equal(await page.evaluate(()=>appointments.find(a=>a.id==='a2').status),'Confirmed','general edits preserve the live status');
    assert.equal(await page.evaluate(()=>appointments.find(a=>a.id==='a2').visitTypeId),'emergency');
    assert.equal(await page.evaluate(()=>['status','visit_type_id','appointment_type'].some(key=>key in fixture.writes.at(-1))),false);
    await page.evaluate(()=>openAppointmentCardPopover('a2'));
    await popup.locator('[data-edit-appointment-detail="schedule"]').click();
    assert.equal(await dialog.isVisible(),true);
    const beforeInvalid=await page.evaluate(()=>fixture.writes.length);
    await dialog.locator('[data-lumin-date-text]').fill('31/02/2026');
    await dialog.locator('[data-detail-save]').click();
    assert.equal(await page.evaluate(()=>fixture.writes.length),beforeInvalid,'invalid dates cannot save');
    await dialog.locator('[data-lumin-date-text]').fill('25/12/2026');
    await dialog.locator('#appointment-detail-time').fill('14:15');
    await dialog.locator('#appointment-detail-duration').selectOption('45');
    await dialog.locator('[data-detail-save]').click();
    await dialog.waitFor({state:'hidden'});
    assert.deepEqual(await page.evaluate(()=>Object.keys(fixture.writes.at(-1)).sort()),['appointment_at','duration_minutes']);
    assert.deepEqual(await page.evaluate(()=>{const entry=appointments.find(a=>a.id==='a2'),date=new Date(entry.startAt);return [entry.date,date.getHours(),date.getMinutes(),entry.duration,entry.status,entry.visitTypeId]}),['2026-12-25',14,15,45,'Confirmed','emergency']);
    await popup.locator('[data-edit-appointment-detail="schedule"]').click();
    const beforeCancel=await page.evaluate(()=>fixture.writes.length);
    await dialog.locator('#appointment-detail-time').fill('18:00');
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(),false);
    assert.equal(await popup.isVisible(),true,'Escape closes only the editor');
    assert.equal(await page.evaluate(()=>fixture.writes.length),beforeCancel);
    await popup.locator('[data-edit-appointment-detail="doctor"]').click();
    await dialog.locator('#appointment-detail-doctor').selectOption('doctor-2');
    await dialog.locator('[data-detail-save]').click();
    await dialog.waitFor({state:'hidden'});
    assert.deepEqual(await page.evaluate(()=>fixture.writes.at(-1)),{assigned_user_id:'doctor-2'});
    assert.equal(await page.evaluate(()=>appointments.find(a=>a.id==='a2').doctor),'Dr. Salma');
    await popup.locator('[data-edit-appointment-detail="doctor"]').click();
    await dialog.locator('#appointment-detail-doctor').selectOption('doctor');
    await page.evaluate(()=>{fixture.writeFail=true;});
    await dialog.locator('[data-detail-save]').click();
    await dialog.locator('[data-detail-error]').waitFor();
    assert.match(await dialog.locator('[data-detail-error]').textContent(),/Offline/);
    assert.equal(await page.evaluate(()=>appointments.find(a=>a.id==='a2').assignedUserId),'doctor-2');
    await page.evaluate(()=>{fixture.writeFail=false;});
    await dialog.locator('[data-detail-save]').click();
    await dialog.waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>appointments.find(a=>a.id==='a2').assignedUserId),'doctor');
    await popup.locator('[data-add-appointment-operations]').click();
    assert.equal(await page.locator('#modal-appointment').isVisible(),false);
    await picker.locator('input[type="checkbox"]').first().uncheck();
    await apply.click();
    await picker.waitFor({state:'hidden'});
    assert.deepEqual(await page.evaluate(()=>fixture.writes.at(-1)),{operations:[]});
    assert.equal(await popup.locator('[data-appointment-detail-card="operations"]').count(),0);
    await popup.locator('[data-add-appointment-operations]').click();
    await picker.locator('input[type="checkbox"]').first().check();
    await page.evaluate(()=>{fixture.writeFail=true;});
    await apply.click();
    await picker.locator('[data-operation-save-error]').waitFor();
    assert.equal(await page.evaluate(()=>appointments.find(a=>a.id==='a2').operations.length),0);
    await page.evaluate(()=>{fixture.writeFail=false;});
    await apply.click();
    await picker.waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>appointments.find(a=>a.id==='a2').operations.length),1);
    assert.deepEqual(await page.evaluate(()=>Object.keys(fixture.writes.at(-1))),['operations']);
    await popup.locator('[data-open-appointment-patient-profile]').click();
    assert.deepEqual(await page.evaluate(()=>fixture.workspace),{patientId:'p1',tab:'profile'});
    await page.evaluate(()=>openAppointmentCardPopover('a2'));
    await popup.locator('[data-open-appointment-patient-chart]').click();
    assert.deepEqual(await page.evaluate(()=>fixture.chart),{patientId:'p1',view:'appointments'});
    await page.evaluate(()=>{allowed=false;fixture.denied=['chart'];openAppointmentCardPopover('a2')});
    for(const selector of ['[data-edit-appointment-detail="schedule"]','[data-edit-appointment-detail="doctor"]','[data-appointment-popover-status]','[data-appointment-popover-visit-type]','[data-add-appointment-operations]','[data-open-appointment-patient-chart]','[data-delete-appointment-popover]'])assert.equal(await popup.locator(selector).isDisabled(),true);
    assert.equal(await popup.locator('[data-open-appointment-patient-profile]').isEnabled(),true);
    await page.evaluate(()=>{allowed=true;fixture.denied=[];openAppointmentCardPopover('a2')});
    await popup.locator('[data-edit-appointment-detail="doctor"]').click();
    await dialog.locator('#appointment-detail-doctor').selectOption('doctor-2');
    await page.evaluate(()=>{fixture.writePending=true;});
    await dialog.locator('[data-detail-save]').click();
    assert.equal(await dialog.locator('[data-detail-save]').isDisabled(),true);
    await page.evaluate(()=>{currentSession={user:{id:'another-account'}};fixture.finishWrite();});
    await dialog.waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>appointments.find(a=>a.id==='a2').assignedUserId),'doctor','a late save cannot populate another account');
    await page.evaluate(()=>{currentSession={user:{id:'staff'}};fixture.writePending=false;closeAppointmentCardPopover()});
  });
  await t.test('mobile swipe and outside dismissal consume the gesture without activating background buttons', async () => {
    const popup=page.locator('#appointment-card-popover');
    const touch=await page.context().newCDPSession(page);
    await page.evaluate(()=>{
      fixture.backgroundClicks=0;fixture.backgroundPresses=0;
      const button=document.createElement('button');button.id='fixture-background-action';
      button.textContent='Background action';button.style.cssText='position:fixed;top:0;left:0;width:120px;height:44px;z-index:1';
      button.addEventListener('click',()=>fixture.backgroundClicks++);
      button.addEventListener('pointerdown',()=>fixture.backgroundPresses++);
      document.body.append(button);
    });
    const drag=async(x,y,dx,dy)=>{
      await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
      for(let step=1;step<=5;step++) {
        await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*step/5,y:y+dy*step/5}]});
        await page.waitForTimeout(20);
      }
    };
    const end=()=>touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    for(const [width,language] of [[390,'en'],[390,'ar'],[320,'ar']]) {
      await page.setViewportSize({width,height:844});
      await page.evaluate(language=>{
        currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';
        document.body.style.overflow='auto';openAppointmentCardPopover('a2');
      },language);
      await popup.locator('[data-delete-appointment-popover]').click();
      assert.equal(await page.evaluate(()=>fixture.deleted),'a2','header delete keeps the existing delete action');
      await page.mouse.move(20,20);await page.mouse.down();
      assert.equal(await popup.isVisible(),true,'pointerdown keeps the backdrop in place');
      await page.mouse.up();await popup.waitFor({state:'hidden'});
      assert.equal(await page.evaluate(()=>document.body.style.overflow),'auto','closing restores the previous scroll setting');
      await page.evaluate(()=>openAppointmentCardPopover('a2'));
      await page.touchscreen.tap(20,20);await popup.waitFor({state:'hidden'});
      await page.evaluate(()=>openAppointmentCardPopover('a2'));
      await popup.evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished)));
      const handle=await popup.locator('.appointment-sheet-handle').boundingBox();
      const x=width/2,y=handle.y+12;
      await drag(x,y,0,30);await end();
      assert.equal(await popup.isVisible(),true,'a short pull returns the sheet to its position');
      assert.equal(await popup.evaluate(node=>node.style.translate),'');
      await drag(x,y,80,5);await end();
      assert.equal(await popup.isVisible(),true,'horizontal movement does not close the sheet');
      await drag(x,y,0,140);
      await touch.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
      assert.equal(await popup.isVisible(),true,'a cancelled gesture does not dismiss');
      assert.equal(await popup.evaluate(node=>node.style.translate),'');
      await popup.evaluate(node=>{node.scrollTop=120});
      const header=await popup.locator('header').boundingBox();
      await drag(12,header.y+header.height+50,0,60);await end();
      assert.equal(await popup.isVisible(),true,'scrolling down within the body preserves the panel');
      await popup.evaluate(node=>{node.scrollTop=0});
      await page.waitForTimeout(200);
      await drag(x,y,0,140);
      assert.equal(await popup.evaluate(node=>node.classList.contains('is-sheet-dragging')),true,'the sheet follows the finger');
      await end();await popup.waitFor({state:'hidden'});
      assert.deepEqual(await page.evaluate(()=>[fixture.backgroundClicks,fixture.backgroundPresses]),[0,0],'dismissing never presses the action behind the backdrop');
      await page.evaluate(()=>openAppointmentCardPopover('a2'));
      await popup.evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished)));
      await popup.focus();await page.keyboard.press('Shift+Tab');
      assert.equal(await popup.locator('[data-open-appointment-patient-chart]').evaluate(node=>node===document.activeElement),true,'keyboard focus stays inside the panel: '+await page.evaluate(()=>document.activeElement.outerHTML));
      await page.keyboard.press('Escape');await popup.waitFor({state:'hidden'});
    }
    await touch.detach();
    await page.evaluate(()=>{document.getElementById('fixture-background-action').remove();document.body.style.overflow='';});
  });
  await page.evaluate(()=>{allowed=false;});
  await page.evaluate(()=>renderAppointmentOperations());
  assert.equal(await choose.isDisabled(),true);
  await page.evaluate(()=>{allowed=true;selectAppointmentPatient('p2');});
  await page.evaluate(()=>setAppointmentModalEntryMode('note'));
  assert.equal(await page.locator('#appointment-operations-field').isVisible(),false);
  assert.deepEqual(errors,[]);
  assert.deepEqual(await page.evaluate(()=>fixture.alerts),[]);
});
