const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {}
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp('    (?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  const tail = html.slice(start);
  const end = tail.slice(1).search(/\n    (?:async )?function /);
  return tail.slice(0, end + 1);
}
const helpers = [
  'patientNumberValue', 'formatPatientNumber', 'normalizePatientPhone', 'normalisePatientRecord', 'getKnownPatient',
  'setStableHtml', 'appointmentPatientDisplayValue', 'appointmentModalUsesNote', 'setAppointmentModalEntryMode',
  'toggleAppointmentNoteMode', 'appointmentPatientRecord', 'syncAppointmentSaveButton',
  'invalidateAppointmentPatientSearch', 'closeAppointmentPatientResults', 'resetAppointmentPatientSearch',
  'showAppointmentPatientResults', 'handleAppointmentPatientSearchBlur', 'retryAppointmentPatientSearch', 'renderAppointmentPatientMatches', 'searchAppointmentPatients',
  'filterAppointmentPatients', 'selectAppointmentPatient', 'handleAppointmentPatientOptionPointerDown',
  'handleAppointmentPatientSearchKeydown', 'renderAppointmentPatientOptions', 'renderAppointmentDoctorOptions',
  'refreshAppointmentVisitTypeSelector', 'appointmentVisitTypeForEntry', 'setAppointmentDurationSelection',
  'appointmentDateFromInput', 'updateAppointmentModalDateLabel', 'openAppointmentModal', 'closeAppointmentModal',
  'saveAppointment', 'patientNumberConflict', 'handleSavePatient',
  'appointmentMinutesAtClientY', 'updateAppointmentRangePreview', 'clearAppointmentRangeGesture', 'beginAppointmentRangeSelection'
];

test('appointment patient search opens immediately and only fetches five summaries on typing', { skip: !chromium }, async t => {
  const fixture = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(fixture); return; }
    const target = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', target.endsWith('.css') ? 'text/css' : 'text/javascript');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:') ? route.continue() : route.abort());
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.addScriptTag({ url: 'http://127.0.0.1:' + server.address().port + '/vendor/lucide.min.js' });
  await page.clock.install();
  const state = html.slice(html.indexOf('    let appointmentPatientMatches ='), html.indexOf('    const recentLocalAppointmentChanges ='));
  await page.addScriptTag({ content: `
    let currentSession={user:{id:'staff'}},currentUiLanguage='en',targetedLoadingGeneration=0,allowed=true;
    let patients=[],patientDirectoryRows=[],patientDirectoryTotal=0,patientDirectoryLoaded=false,patientsLoaded=false;
    const patientProcedureState={patientsById:new Map()},PATIENT_QUERY_PAGE_SIZE=10;
    let editingAppointmentId=null,appointmentModalEntryMode='patient',editingPatientId=null,patientModalReturnToAppointment=false;
    let appointmentSelectedDate=new Date(2026,9,4),appointmentVisibleMonth=new Date(2026,9,1),selectedAppointmentId=null;
    const appointmentStaff=[{userId:'doctor',fullName:'Test doctor',canReceiveAppointments:true}];
    const appointmentVisitTypes=[{id:'check',name:'Check-up',active:true}];
    const currentUserAccess={userId:'doctor'},APPOINTMENT_TIME_STEP=15;
    const APPOINTMENT_RANGE_LONG_PRESS_DELAY=450,APPOINTMENT_RANGE_MOVE_TOLERANCE=12;
    let appointmentRangeSelectionGesture=null,appointmentRangeSelectionActive=false;
    let appointmentPeriodSwipeClickGuardUntil=0,appointmentDaySwipeClickGuardUntil=0;
    let appointmentDaySwipeGesture=null,appointmentDayTouchGesture=null;
    const appointmentDayFormatter=new Intl.DateTimeFormat('en',{dateStyle:'long'});
    let appointments=[{id:'existing',patientId:'existing-patient',patient:'Existing patient',patientPhone:'01012345678',assignedUserId:'doctor',visitTypeId:'check',duration:45,startAt:new Date(2026,9,4,10,15).toISOString(),status:'Confirmed',notes:'Keep these notes'}];
    ${state}
    window.fixture={requests:[],inserts:[],bulkReads:0};
    function canModifyAppointments(){return allowed} function hasPageAccess(){return true}
    function ensureAppointmentsLoaded(){return Promise.resolve(true)}
    function ensureAppointmentVisitTypesLoaded(){return Promise.resolve(true)}
    function ensurePatientsLoaded(){fixture.bulkReads++;throw Error('Bulk patient loading forbidden')}
    function fetchPatientsFromDB(){fixture.bulkReads++;throw Error('Bulk patient loading forbidden')}
    function escapeHtml(value){const el=document.createElement('span');el.textContent=String(value??'');return el.innerHTML}
    function escapeAppointmentText(value){return escapeHtml(value)}
    function appointmentDateKey(date){return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-')}
    function appointmentTimeInputFromMinutes(minutes){return String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0')}
    function appointmentTimeFromMinutes(minutes){return appointmentTimeInputFromMinutes(minutes)}
    function appointmentDurationLabel(minutes){return minutes+' min'}
    function closeNewPatientModal(){patientModalReturnToAppointment=false;document.getElementById('modal-new-patient').classList.add('hidden')}
    function setPatientFormMessage(){}
    function resetAppointmentDaySwipeVisual(){}
    function markLocalAppointmentChange(){}
    function replaceAppointmentRecord(data){return {id:data.id,startAt:data.appointment_at,status:data.status}}
    function queueGoogleCalendarAppointmentSync(){}
    function queueAppointmentPushNotification(){}
    function renderAppointments(){}
    function realtimeViewIsVisible(){return false}
    function openPatientChart(){throw Error('Appointment registration must stay in the form')}
    const db={
      rpc(name,args){
        if(name!=='search_appointment_patients')throw Error(name);
        let resolve,reject;
        const promise=new Promise((a,b)=>{resolve=a;reject=b});
        const request={query:args.p_query,resolve,reject,signal:null};
        fixture.requests.push(request);
        return {abortSignal(signal){request.signal=signal;return promise}};
      },
      from(table){
        const query={insert(payload){fixture.inserts.push({table,payload});this.payload=payload;return this},select(){return this},single(){
          if(table==='patients'){const record=this.payload[0];return Promise.resolve({data:{...record,id:'new-patient',patient_number:99},error:null})}
          return Promise.resolve({data:{...this.payload,id:'saved'},error:null});
        }};
        return query;
      }
    };
    ${helpers.map(source).join('\n')}
    document.getElementById('auth-gate').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');
  ` });
  const input = page.locator('#appointment-patient-search');
  const options = page.locator('#appointment-patient-results [role="option"]');
  const count = () => page.evaluate(() => fixture.requests.length);
  const open = () => page.evaluate(() => openAppointmentModal(null, 555, 75));
  const respond = (index, data, error = null) => page.evaluate(({ index, data, error }) => fixture.requests[index].resolve({ data, error }), { index, data, error });
  const patient = (id, name = id) => ({ id, name, patient_number: 42, phone: '01012345678' });
  const finish = () => page.evaluate(() => new Promise(resolve => queueMicrotask(resolve)));

  await t.test('first open retains the range and makes no patient requests on focus or empty input', async () => {
    await page.evaluate(()=>{
      const surface=document.createElement('div');surface.style.cssText='position:fixed;top:0;left:0;height:960px;width:300px';
      surface.setPointerCapture=()=>{};document.body.appendChild(surface);window.rangeSurface=surface;
      beginAppointmentRangeSelection({button:0,isPrimary:true,pointerId:1,target:surface,currentTarget:surface,clientX:100,clientY:360});
    });
    await page.clock.runFor(450);
    await page.evaluate(()=>{
      appointmentRangeSelectionGesture.onFinish({pointerId:1,clientY:390,preventDefault(){},stopPropagation(){}});
      rangeSurface.remove();
    });
    assert.equal(await page.locator('#modal-appointment').isVisible(),true);
    assert.equal(await page.locator('#appointment-time').inputValue(),'09:00');
    assert.equal(await page.locator('#appointment-duration').inputValue(),'45');
    assert.equal(await count(),0);
    await open();
    assert.equal(await page.locator('#modal-appointment').isVisible(), true);
    assert.equal(await page.locator('#appointment-time').inputValue(), '09:15');
    assert.equal(await page.locator('#appointment-duration').inputValue(), '75');
    assert.equal(await page.locator('#appointment-date').inputValue(), '2026-10-04');
    assert.equal(await input.isEnabled(), true);
    await input.focus(); await input.fill('   '); await page.clock.runFor(1000);
    assert.equal(await count(), 0); assert.equal(await page.evaluate(() => fixture.bulkReads), 0);
    assert.equal(await page.locator('#btn-save-appointment').isDisabled(), true);
  });
  await t.test('typing debounces from the first character, caps results, and saves without a directory', async () => {
    await input.fill('A'); await page.clock.runFor(249); assert.equal(await count(), 0);
    await page.clock.runFor(1); assert.equal(await count(), 1);
    assert.equal(await input.getAttribute('aria-busy'), 'true');
    await respond(0, Array.from({ length: 6 }, (_, i) => patient('p'+i, 'Patient '+i)));
    await finish(); assert.equal(await options.count(), 5);
    assert.equal(await page.evaluate(() => patients.length), 0);
    assert.equal(await page.evaluate(() => appointmentPatientSearchRecords.get('p0').recordComplete), false);
    await input.press('ArrowDown'); await input.press('Enter');
    assert.equal(await input.inputValue(), 'Patient 1');
    assert.equal(await page.locator('#btn-save-appointment').isEnabled(), true);
    await page.locator('#appointment-assigned-user-id').selectOption('');
    assert.equal(await page.locator('#btn-save-appointment').isDisabled(), true);
    await page.locator('#appointment-assigned-user-id').selectOption('doctor');
    assert.equal(await page.locator('#btn-save-appointment').isEnabled(), true);
    await input.focus(); await page.clock.runFor(1000); assert.equal(await count(), 1);
    await page.evaluate(() => saveAppointment({preventDefault(){}}));
    assert.equal(await page.evaluate(() => fixture.inserts[0].payload.patient_id), 'p1');
    assert.equal(await page.evaluate(() => fixture.bulkReads), 0);
  });
  await t.test('late responses cannot replace newer searches or a selected patient', async () => {
    await open(); await input.fill('old'); await page.clock.runFor(250);
    const oldIndex = (await count())-1;
    await input.fill('new'); await page.clock.runFor(250); const newIndex = (await count())-1;
    assert.equal(await page.evaluate(i => fixture.requests[i].signal.aborted, oldIndex), true);
    await respond(newIndex, [patient('fresh', 'Fresh patient')]); await finish();
    await respond(oldIndex, [patient('stale')]); await finish();
    assert.match(await options.first().textContent(), /Fresh patient/);
    await options.first().tap();
    assert.equal(await input.inputValue(), 'Fresh patient');
    assert.equal(await page.locator('#appointment-patient-results').isVisible(), false);
    await page.evaluate(() => renderAppointmentPatientOptions());
    assert.equal(await input.inputValue(), 'Fresh patient');
  });
  await t.test('clearing, closing, changing modes, and changing account or access discard pending reads', async () => {
    for (const action of ['clear','close','note','account','access']) {
      await page.evaluate(() => {currentSession={user:{id:'staff'}};allowed=true;targetedLoadingGeneration=0});
      await open(); await input.fill(action); await page.clock.runFor(250); const index=(await count())-1;
      await page.evaluate(action => {
        if(action==='clear'){document.getElementById('appointment-patient-search').value='';filterAppointmentPatients()}
        if(action==='close')closeAppointmentModal();
        if(action==='note')setAppointmentModalEntryMode('note');
        if(action==='account')currentSession={user:{id:'another'}};
        if(action==='access')targetedLoadingGeneration++;
      },action);
      await respond(index,[patient('forbidden-'+action)]);await finish();
      assert.equal(await page.evaluate(id=>appointmentPatientSearchRecords.has(id),'forbidden-'+action),false);
      if(action==='close'){await open();assert.equal(await input.inputValue(),'')}
    }
    await page.evaluate(() => {currentSession={user:{id:'staff'}};targetedLoadingGeneration=0});
  });
  await t.test('errors offer a bounded retry and empty input does not bulk load', async () => {
    await open();await input.fill('missing');await page.clock.runFor(250);let index=(await count())-1;
    await respond(index,null,{message:'Offline'});await finish();
    const retry=page.locator('.appointment-patient-search-retry');
    assert.equal(await retry.isVisible(),true);assert.equal(await retry.evaluate(el=>el.disabled),false);
    await retry.click();await page.clock.runFor(250);index=(await count())-1;
    await respond(index,[]);await finish();
    assert.match(await page.locator('#appointment-patient-results').textContent(),/No patients match/);
    const before=await count();
    await input.fill('');await page.clock.runFor(1000);assert.equal(await count(),before);
    assert.equal(await page.evaluate(()=>fixture.bulkReads),0);
  });
  await t.test('Android tablet composition fetches five live matches before committing the word', async st => {
    await page.setViewportSize({width:800,height:1280});
    const keyboard=await page.context().newCDPSession(page);
    st.after(()=>keyboard.detach());
    await keyboard.send('Network.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 14; SM-X610) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'});
    await page.evaluate(()=>{
      window.composingInputEvents=[];
      document.getElementById('appointment-patient-search').addEventListener('input',event=>composingInputEvents.push(event.isComposing));
    });
    for(const [dir,first,second] of [['ltr','A','Ahmed'],['rtl','أ','أحمد']]) {
      await page.evaluate(dir=>{document.documentElement.dir=dir;currentUiLanguage=dir==='rtl'?'ar':'en'},dir);
      await open();await input.tap();const before=await count();
      await keyboard.send('Input.imeSetComposition',{text:first,selectionStart:first.length,selectionEnd:first.length});
      assert.equal(await page.evaluate(()=>composingInputEvents.at(-1)),true,'Exercise actual composing input events');
      await page.clock.runFor(249);assert.equal(await count(),before);
      await page.clock.runFor(1);assert.equal(await count(),before+1,'Fetch while the keyboard is still composing');
      await keyboard.send('Input.imeSetComposition',{text:second,selectionStart:second.length,selectionEnd:second.length});
      await page.clock.runFor(250);assert.equal(await count(),before+2);
      assert.equal(await page.evaluate(index=>fixture.requests[index].signal.aborted,before),true);
      assert.equal(await page.evaluate(index=>fixture.requests[index].query,before+1),second);
      await respond(before+1,Array.from({length:6},(_,i)=>patient('ime-'+i,second+' '+i)));await finish();
      assert.equal(await options.count(),5);
      await respond(before,[patient('ime-stale')]);await finish();
      assert.match(await options.first().textContent(),new RegExp(second));
      await input.dispatchEvent('keydown',{key:'Enter',isComposing:true});
      assert.equal(await page.locator('#appointment-patient-id').inputValue(),'','Composing Enter does not select or submit');
      await options.first().tap();
      assert.equal(await page.locator('#appointment-patient-id').inputValue(),'ime-0');
      await input.dispatchEvent('input',{isComposing:true,inputType:'insertCompositionText'});
      await input.dispatchEvent('compositionend',{data:second});
      await input.dispatchEvent('input',{isComposing:false,inputType:'insertText'});
      await page.clock.runFor(1000);
      assert.equal(await page.locator('#appointment-patient-id').inputValue(),'ime-0','Composition completion retains the chosen patient');
      assert.equal(await count(),before+2);
      assert.equal(await page.locator('#btn-save-appointment').isEnabled(),true);
      await keyboard.send('Input.insertText',{text:''});
    }
    await keyboard.send('Network.setUserAgentOverride',{userAgent:''});
    assert.equal(await page.evaluate(()=>fixture.bulkReads),0);
  });
  await t.test('editing and new-patient registration retain the selected patient without bulk requests', async () => {
    await page.evaluate(() => openAppointmentModal('existing'));
    assert.equal(await input.inputValue(),'Existing patient');
    assert.equal(await page.locator('#appointment-time').inputValue(),'10:15');
    assert.equal(await page.locator('#appointment-notes').inputValue(),'Keep these notes');
    assert.equal(await page.locator('#btn-save-appointment').isEnabled(),true);
    await open();
    await page.evaluate(async()=>{
      patientModalReturnToAppointment=true;
      document.getElementById('form-first-name').value='New';
      document.getElementById('form-last-name').value='Patient';
      document.getElementById('form-age').value='25';
      document.getElementById('form-phone').value='01012345678';
      await handleSavePatient({preventDefault(){}});
    });
    assert.equal(await input.inputValue(),'New Patient');
    assert.equal(await page.locator('#appointment-patient-id').inputValue(),'new-patient');
    assert.equal(await page.evaluate(()=>fixture.bulkReads),0);
    assert.equal(await page.evaluate(()=>patientsLoaded),false);
    assert.equal(await page.locator('#appointment-duration').inputValue(),'75');
  });
  await t.test('results fit mobile, tablet, desktop, and Arabic layouts with touch targets', async () => {
    for (const [width,height] of [[390,844],[820,1180],[1440,900]]) for(const dir of ['ltr','rtl']) {
      await page.setViewportSize({width,height});
      await page.evaluate(dir=>{document.documentElement.dir=dir;currentUiLanguage=dir==='rtl'?'ar':'en'},dir);
      await open();await input.fill(dir==='rtl'?'أحمد':'Patient');await page.clock.runFor(250);
      await respond((await count())-1,[patient('layout',dir==='rtl'?'أحمد محمد':'Patient with a long name that fits on all devices')]);await finish();
      const box=await page.locator('#appointment-patient-results').boundingBox();
      assert.ok(box.x>=0&&box.x+box.width<=width+1,JSON.stringify({width,dir,box}));
      const option=await options.first().boundingBox();assert.ok(option.height>=44&&option.width>=44);
      assert.equal(await options.first().evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');
      await options.first().tap();assert.equal(await page.locator('#appointment-patient-id').inputValue(),'layout');
    }
  });
  assert.deepEqual(errors,[]);
});
