const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {}
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const toothNotes = fs.readFileSync(path.join(root, 'lumin-tooth-notes.js'), 'utf8');
function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}
async function assertToothActionOrder(page) {
  const positions = await page.locator('.chart-tooth-actions').evaluateAll(actions => actions.map(action => ({
    upper: Number(action.closest('[data-tooth-card]').dataset.slot) <= 16,
    xray: action.querySelector('.chart-tooth-xray-indicator').getBoundingClientRect().toJSON(),
    notes: action.querySelector('.chart-tooth-note-indicator').getBoundingClientRect().toJSON()
  })));
  for (const { upper, xray, notes } of positions) {
    assert.ok(Math.abs(xray.x - notes.x) < 1, 'Icons stay vertically aligned');
    assert.ok(upper ? notes.bottom <= xray.top : xray.bottom <= notes.top,
      'X-ray icons face the gap between arches; notes face their own arch');
  }
}
const notesHelpers = ['escapeHtml', 'normaliseChartCreatedAt', 'normaliseChartOperationNoteRoot',
  'normaliseChartOperationNote', 'normaliseChartOperationNotes', 'collectDocumentedFindings',
  'chartFindingCreatedAtTimestamp', 'chartFindingNoteTextMarkup'].map(source).join('\n');
const fixtureData = `
  let currentUiLanguage='en';
  const CHART_OPERATION_NOTE_TYPES=['general','endo'], ENDO_ROOT_OPTIONS=['MB','DB','P','D','M'], CHART_META_KEY='_meta';
  const PRIMARY_TOOTH_BY_SLOT={4:'A',5:'B',6:'C',7:'D',8:'E',9:'F',10:'G',11:'H',12:'I',13:'J'};
  const SLOT_BY_PRIMARY_TOOTH={A:4};
  function note(text, type='general') { return {id:'10000000-0000-4000-8000-000000000001',type,text,
    roots:type==='endo'?[{id:'20000000-0000-4000-8000-000000000001',canal:'MB',length:21.5,referencePoint:'Buccal cusp'}]:[]}; }
  function finding(id,code,notes=[],batchId=null) { return {id,code,notes,batchId,status:'P',price:0}; }
  let patient={id:'patient-1',name:'Ahmed Hassan',chartState:{
    '3':{whole:[finding('crown','Crown',[note('Existing crown note')]),finding('endo-3','Root canal',[note('Endo details','endo')],'batch'),finding('empty','New restoration')],
      surfaces:{mesial:[finding('surface','Composite',[note('<img src=x onerror=alert(1)>\\nReview contact')])],occlusal:[finding('surface','Composite',[note('Duplicate surface')])] }},
    '4':{whole:[finding('endo-4','Root canal',[note('Endo details','endo')],'batch')]},
    '5':{whole:[finding('other','Extraction',[note('Other tooth private note')])]},
    'A':{whole:[finding('primary','Primary crown',[note('Primary tooth note')])]}
  }};
  function getActivePatient(){return patient;}
  function dentalOperationLabel(code){return code;}
  function chartWholeFindings(data){return data.whole||[];}
  function chartSurfaceFindings(value){return value||[];}
  function chartMouthFindings(){return [finding('mouth','Mouth exam',[note('Mouth-only note')])];}
  function normaliseOrthoVisits(value){return value||[];}
  function chartFindingBatchTotal(){return 0;}
`;

test('tooth shortcuts use existing whole, surface, primary and shared batch notes without duplicating surfaces', () => {
  const context = vm.createContext({ document:{addEventListener(){}}, chartToothLabel:id=>'Tooth '+id });
  vm.runInContext(fixtureData + notesHelpers + toothNotes, context);
  assert.equal(context.chartToothNoteFindings('3').length, 4);
  assert.equal(context.chartToothNoteFindings('4').length, 1);
  assert.equal(context.chartToothNoteFindings('A')[0].id, 'primary');
  assert.equal(context.chartToothNoteFindings('32').length, 0);
  const markup = context.chartToothNotePreviewMarkup('3');
  assert.match(markup, /Existing crown note/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;<br>Review contact/);
  assert.match(markup, /MB · 21.5 mm/);
  assert.match(markup, /data-finding-ids="endo-3,endo-4" data-tooth-ids="3,4"/);
  assert.doesNotMatch(markup, /Duplicate surface|Other tooth private note|Mouth-only note|<img/);
  assert.equal((markup.match(/class="tooth-notes-note"/g)||[]).length, 3);
  vm.runInContext("currentUiLanguage='ar'", context);
  assert.match(context.chartToothNotePreviewMarkup('32'), /لا توجد نتائج على هذا السن/);
});

test('tooth notes open and edit in the sidebar, stay live, and fit expanded, collapsed and mobile charts', {skip:!chromium && 'Playwright unavailable'}, async t => {
  const server = http.createServer((req,res) => {
    const url = new URL(req.url,'http://localhost');
    if(url.pathname==='/') {res.setHeader('Content-Type','text/html');res.end(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,''));return;}
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.statusCode=404;res.end();return;}
    res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||undefined});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce',hasTouch:true}), errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/thumbnail/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#334155"/></svg>'}));
  const base=`http://127.0.0.1:${server.address().port}`;
  await page.goto(base);
  await page.addScriptTag({path:path.join(root,'vendor/lucide.min.js')});
  const helpers=['isPrimaryToothId','palmerPositionForSlot','palmerQuadrantForSlot','palmerQuadrantLabel','palmerToothNotation','chartToothLabel',
    'renderToothHTML','renderEmptyToothHTML','toothDentitionLongPressTarget','chartFindingIdsFromControl','chartFindingToothIdsFromControl',
    'chartFindingGroupFromControl','chartFindingNoteTargetLabel','chartFindingNotePreviewMarkup','positionChartFindingNotePreview',
    'showChartFindingNotePreview','toggleChartFindingNotePreview','cancelChartFindingNotePreviewClose','scheduleChartFindingNotePreviewClose',
    'closeChartFindingNotePreview','setupChartFindingNotePreview','createChartFindingId','newChartFindingNoteRoot','newChartFindingNote',
    'setChartFindingNotesMessage','syncChartFindingNotesDraftFromEditor','renderChartFindingNotesEditor','openChartFindingNoteEditor',
    'closeChartFindingNoteEditor','addChartFindingNote','deleteChartFindingNote','changeChartFindingNoteType','addChartFindingNoteRoot',
    'deleteChartFindingNoteRoot','validatedChartFindingNotesDraft','saveChartFindingNotes','setStableHtml'].map(source).join('\n');
  await page.addScriptTag({content:fixtureData+notesHelpers+helpers+`
    let activePatientId=patient.id, activeWorkspacePatientId=patient.id, canReadChart=true;
    let openChartFindingNoteTrigger=null, chartFindingNotePreviewCloseTimer=null, editingChartFindingNoteIds=[], editingChartFindingNoteToothIds=[], chartFindingNotesDraft=[], chartFindingNotesEditorSession=0;
    let patientMediaToothPicker=null;
    let currentSession={user:{id:'staff'}};
    function appointmentDateKey(date){return date.toISOString().slice(0,10);}
    function canonicalAppointmentStatus(status){return status;}
    function appointmentStatusColor(){return '#2563eb';}
    function appointmentColorRgbChannels(){return '37,99,235';}
    function arabicUiPhrase(value){return value;}
    function hasPageAccess(){return canReadChart;}
    function chartToothHasFinding(){return false;}
    function getKnownPatient(){return patient;}
    function getStorageServerConfig(){return {url:location.origin};}
    function patientMediaToothIds(details){return details?.tooth_ids||[];}
    function patientMediaToothLabel(value){return value;}
    function patientMediaTeethLabel(){return '';}
    function patientMediaDisplayName(file){return file.filename;}
    function patientMediaFileUrl(file){return location.origin+'/files/'+file.relativePath;}
    function normalizePatientMediaTeeth(ids){return [...new Set(ids)];}
    function generateRealisticToothPhoto(){return '<svg width="40" height="100" viewBox="0 0 40 100"><path d="M4 24 Q0 0 20 4 Q40 0 36 24 L31 90 L22 90 L19 58 L10 90 Z" fill="#f3f0e9" stroke="#cbd5e1"/></svg>';}
    function generateSurfaceMapSVG(){return '<div style="height:40px"></div>';}
    window.selections=0;
    function setChartSelectionTargets(targets){window.selectedTargets=targets;}
    function updateSelectionUI(){}
    function renderChartFindingTeeth(){}
    function renderFindingsList(){renderChartToothNoteIndicators();}
    function showAppointmentNotificationToast(){}
    window.failSave=false;
    window.holdSaves=false;window.heldSaves=[];
    const db={async rpc(name,args){window.savedRequest={name,args};const savedPatient=patient;
      if(window.holdSaves)await new Promise(resolve=>window.heldSaves.push(resolve));
      if(window.failSave)return {error:Error('Offline')};
      const next=structuredClone(savedPatient.chartState);
      for(const data of Object.values(next))for(const group of [data.whole||[],...Object.values(data.surfaces||{})])
        for(const finding of group)if(args.p_finding_ids.includes(finding.id))finding.notes=structuredClone(args.p_notes);
      return {data:next};
    }};
  `});
  await page.addScriptTag({path:path.join(root,'lumin-mobile-nav.js')});
  await page.addScriptTag({path:path.join(root,'lumin-chart-media.js')});
  await page.addScriptTag({path:path.join(root,'lumin-tooth-notes.js')});
  await page.addScriptTag({path:path.join(root,'lumin-chart-appointments.js')});
  await page.evaluate(()=>{
    document.getElementById('auth-gate').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');
    document.querySelectorAll('#app-main > section, #app-main > div').forEach(node=>node.classList.add('hidden'));
    ['patient-workspace-sheet','patient-workspace-header','view-chart'].forEach(id=>document.getElementById(id).classList.remove('hidden'));
    for(const [id,offset] of [['upper-arch',0],['lower-arch',16]])document.getElementById(id).innerHTML=Array.from({length:16},(_,i)=>renderToothHTML({slot:i+offset+1,toothId:String(i+offset+1),dentition:'permanent'})).join('');
    chartPatientMedia.patientId=patient.id;chartPatientMedia.status='ready';
    chartPatientMedia.files=['3','4'].map(id=>({filename:'tooth-'+id+'.png',relativePath:'patient-1/Periapical/tooth-'+id+'.png',category:'Periapical',mediaDetails:{tooth_ids:[id]}}));
    chartPatientMedia.filterToothIds=['3','4'];chartPatientMedia.selectedPath=chartPatientMedia.files[1].relativePath;
    chartAppointments.status='ready';chartAppointments.dateKey=appointmentDateKey(new Date());
    chartAppointments.records=Array.from({length:6},(_,i)=>({id:String(i),patientId:'queue-'+i,patient:'Patient '+i,date:chartAppointments.dateKey,startAt:new Date(Date.now()+i*3600000).toISOString(),status:'Scheduled'}));
    document.dispatchEvent(new Event('DOMContentLoaded'));setupChartFindingNotePreview();renderChartMediaPanel();renderChartToothNoteIndicators();
    document.addEventListener('click',event=>{if(event.target.closest('[data-tooth-card]'))window.selections++;});
  });
  const trigger=page.locator('[data-tooth-note-trigger="3"]'), notesPanel=page.locator('#chart-tooth-notes-panel');
  assert.equal(await page.locator('[data-tooth-note-trigger]').count(),32);
  assert.equal(await trigger.getAttribute('data-note-count'),'3');
  await trigger.focus();await page.keyboard.press('Enter');
  await notesPanel.waitFor({state:'visible'});
  assert.equal(await notesPanel.locator('.tooth-notes-finding').count(),4);
  assert.equal(await page.locator('#chart-finding-note-popover').isVisible(),false,'Tooth notes do not open a popover');
  assert.equal(await page.locator('#chart-media-panel-body').isVisible(),false,'Notes use the X-ray section of the sidebar');
  assert.equal(await trigger.getAttribute('aria-expanded'),'true');
  assert.deepEqual(await page.evaluate(()=>({selected:window.selections,longPress:toothDentitionLongPressTarget(document.querySelector('[data-tooth-note-trigger="3"]'))})),{selected:0,longPress:null});
  const crown=notesPanel.locator('[data-finding-id="crown"]');
  await crown.locator('button').click();
  assert.equal(await page.locator('#modal-chart-finding-notes').isVisible(),false,'Editing stays inside the sidebar');
  assert.ok(await notesPanel.locator('#chart-finding-notes-form').isVisible());
  await page.locator('[data-chart-note-text]').fill('Updated from tooth shortcut');
  await page.locator('#add-endo-chart-note').click();
  await page.locator('[data-endo-root-length]').fill('22.5');await page.locator('[data-endo-root-reference]').fill('Palatal cusp');
  await page.evaluate(()=>window.failSave=true);await page.locator('#save-chart-finding-notes').click();
  await page.waitForFunction(()=>document.getElementById('chart-finding-notes-message').textContent.includes('Offline'));
  assert.equal(await page.locator('[data-chart-note-text]').first().inputValue(),'Updated from tooth shortcut');
  await page.evaluate(()=>window.failSave=false);await page.locator('#save-chart-finding-notes').click();
  await notesPanel.locator('.tooth-notes-editor-host').waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(()=>({name:window.savedRequest.name,ids:window.savedRequest.args.p_finding_ids,patient:window.savedRequest.args.p_patient_id})),{name:'set_patient_chart_finding_notes',ids:['crown'],patient:'patient-1'});
  assert.equal(await trigger.getAttribute('data-note-count'),'4');
  assert.match(await crown.textContent(),/Updated from tooth shortcut[\s\S]*22.5 mm[\s\S]*Palatal cusp/,'Saved notes return to the sidebar list');
  await page.evaluate(()=>{patient.chartState['3'].whole[0].notes=[note('Updated diagnostic note')];renderFindingsList();});
  assert.match(await crown.textContent(),/Updated diagnostic note/,'An open shortcut refreshes from the original finding data');
  await notesPanel.locator('[data-finding-id="endo-3"] button').click();
  await page.locator('[data-chart-note-text]').fill('Shared batch update');await page.locator('#save-chart-finding-notes').click();
  await notesPanel.locator('.tooth-notes-editor-host').waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(()=>window.savedRequest.args.p_finding_ids),['endo-3','endo-4']);
  assert.equal(await page.evaluate(()=>patient.chartState['4'].whole[0].notes[0].text),'Shared batch update');
  const screenshots=path.join(os.tmpdir(),'lumin-tooth-notes-preview');fs.mkdirSync(screenshots,{recursive:true});
  for(const viewport of [{width:1440,height:1000},{width:1024,height:768},{width:800,height:600},{width:834,height:1112},{width:390,height:844},{width:320,height:568}]) {
    await page.setViewportSize(viewport);
    for(const language of ['en','ar']) {
      await page.evaluate(language=>{currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';chartPatientMedia.collapsed=true;renderChartMediaPanel();renderChartToothNoteIndicators();},language);
      await trigger.scrollIntoViewIfNeeded();
      const landscape=viewport.width>=768&&viewport.width>viewport.height;
      assert.equal(await trigger.evaluate(node=>getComputedStyle(node.parentElement).flexDirection),'column');
      await assertToothActionOrder(page);
      for(const selector of ['[data-tooth-note-trigger="3"]','[data-tooth-xray-slot="3"] button']){
        const box=await page.locator(selector).boundingBox();assert.ok(box.width>=44&&box.height>=44);
      }
      if(landscape) {
        await page.locator('#chart-media-collapse').click();
        assert.equal(await trigger.evaluate(node=>getComputedStyle(node.parentElement).flexDirection),'column');
        await assertToothActionOrder(page);
        assert.equal(await page.locator('#upper-arch').evaluate(node=>getComputedStyle(node).minWidth),'768px');
      }
      await trigger.click();
      try { await notesPanel.waitFor({state:'visible',timeout:3000}); }
      catch(error) { await page.screenshot({path:path.join(screenshots,'failure.png')});t.diagnostic(JSON.stringify({viewport,language}));throw error; }
      assert.equal(await notesPanel.getAttribute('dir'),language==='ar'?'rtl':'ltr');
      const box=await notesPanel.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=viewport.width+1&&box.y+box.height<=viewport.height+1,JSON.stringify({viewport,box}));
      assert.equal(await page.locator('#chart-finding-note-popover').isVisible(),false);
      await notesPanel.locator('.tooth-notes-content').evaluate(node=>{node.scrollTop=50;node.dispatchEvent(new Event('scroll'));});
      assert.equal(await notesPanel.isVisible(),true,'Scrolling the note list keeps it open');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      if(landscape) {
        assert.ok(await page.locator('#chart-appointments-body').isVisible(),'Appointments stay below the notes');
        const queue=await page.locator('#chart-appointments-body').boundingBox();
        assert.ok(queue.height>=4*44+3*6+24,'Four appointment cards still fit');
      }
      if((viewport.width===1440&&language==='en')||(viewport.width===390&&language==='ar'))await page.screenshot({path:path.join(screenshots,`notes-${viewport.width}-${language}.png`)});
      await notesPanel.locator('[data-finding-id="crown"] button').click();
      await notesPanel.locator('[data-chart-note-text]').fill('Unsaved sidebar draft');
      assert.match(await page.locator('#save-chart-finding-notes').textContent(),language==='ar'?/حفظ الملاحظات/:/Save notes/);
      await page.evaluate(()=>{renderFindingsList();renderChartMediaPanel();});
      assert.equal(await notesPanel.locator('[data-chart-note-text]').inputValue(),'Unsaved sidebar draft','Live updates preserve unsaved text');
      const editor=await notesPanel.locator('#chart-finding-notes-editor').boundingBox();
      assert.ok(editor.height>=40,JSON.stringify({viewport,language,editor}));
      assert.equal(await notesPanel.evaluate(node=>node.scrollWidth>node.clientWidth),false,'The editor fits the narrow sidebar');
      await page.locator('#chart-media-collapse').click();
      assert.equal(await trigger.getAttribute('aria-expanded'),'false');
      if(landscape) {
        assert.equal(await page.locator('#chart-appointments-body').isVisible(),false,'Notes share the collapse button with appointments');
        await page.locator('#chart-media-collapse').click();
      } else {
        await trigger.click();
      }
      assert.equal(await notesPanel.locator('[data-chart-note-text]').inputValue(),'Unsaved sidebar draft','Collapsing and reopening preserves the draft');
      await page.locator('#save-chart-finding-notes').focus();
      if(!landscape) {
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(()=>document.getElementById('chart-media-panel').contains(document.activeElement)),true,'The mobile notes editor traps focus inside its sheet');
      }
      await page.screenshot({path:path.join(screenshots,`notes-editor-${viewport.width}-${language}.png`)});
      await page.evaluate(()=>closeChartFindingNoteEditor());
      await page.locator(landscape ? '.tooth-notes-header button' : '#chart-media-tab-xrays').click();
      assert.ok(await page.locator('#chart-media-panel-body').isVisible(),'The X-ray button switches back inside the same sidebar');
      assert.equal(await trigger.getAttribute('aria-expanded'),'false');
      assert.deepEqual(await page.evaluate(()=>chartPatientMedia.filterToothIds),['3','4'],'Notes preserve the multiple-tooth X-ray filter');
      assert.match(await page.locator('.chart-media-caption h4').textContent(),/tooth-4.png/,'Notes preserve the selected X-ray');
      if(!landscape) await page.locator('#chart-media-collapse').click();
    }
  }
  await t.test('phone tabs retain drafts and X-ray selections; downward swipes dismiss without stealing scrolling', async st => {
    const touch=await page.context().newCDPSession(page);
    st.after(()=>touch.detach());
    await touch.send('Network.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'});
    const swipe=async(selector,dx,dy,cancel=false)=>{
      const box=await page.locator(selector).boundingBox(), x=box.x+box.width/2, y=box.y+Math.min(12,box.height/2);
      await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
      for(let step=1;step<=4;step++)await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*step/4,y:y+dy*step/4}]});
      const transform=await page.locator('#chart-media-panel').evaluate(node=>getComputedStyle(node).transform);
      await touch.send('Input.dispatchTouchEvent',{type:cancel?'touchCancel':'touchEnd',touchPoints:[]});
      return transform;
    };
    for(const viewport of [{width:390,height:844},{width:320,height:568},{width:844,height:390}])for(const language of ['en','ar']){
      await page.setViewportSize(viewport);
      await page.evaluate(language=>{
        currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';
        closeChartToothNotesPanel({render:false});chartPatientMedia.collapsed=true;renderChartMediaPanel();
      },language);
      await trigger.scrollIntoViewIfNeeded();await trigger.click();
      assert.equal(await page.locator('.chart-clinical-column').evaluate(node=>node.inert),true,'The expanded panel locks the background chart');
      await trigger.evaluate(node=>node.focus());
      assert.equal(await page.evaluate(()=>document.getElementById('chart-media-panel').contains(document.activeElement)),true,'Focus stays in the expanded panel');
      assert.equal(await page.locator('#chart-media-tabs').isVisible(),true);
      assert.equal(await page.locator('#chart-media-tab-notes').getAttribute('aria-selected'),'true');
      for(const tab of ['xrays','notes']){
        const box=await page.locator('#chart-media-tab-'+tab).boundingBox();assert.ok(box.width>=44&&box.height>=44);
      }
      await notesPanel.locator('[data-finding-id="crown"] button').click();
      await page.locator('[data-chart-note-text]').fill('Mobile unsaved draft '+language);
      const editor=await page.locator('#chart-finding-notes-editor').boundingBox();assert.ok(editor.height>=40,JSON.stringify({viewport,language,editor}));
      const save=await page.locator('#save-chart-finding-notes').boundingBox();assert.ok(save.y>=0&&save.y+save.height<=viewport.height+1,'Save stays inside the phone viewport');
      const xray=await page.evaluate(()=>({path:chartPatientMedia.selectedPath,teeth:[...chartPatientMedia.filterToothIds]}));
      await page.locator('#chart-media-tab-xrays').tap();
      assert.equal(await notesPanel.isVisible(),false);
      assert.equal(await page.locator('#chart-media-panel-body').isVisible(),true);
      await page.locator('#chart-media-tab-xrays').press(language==='ar'?'ArrowLeft':'ArrowRight');
      assert.equal(await page.locator('#chart-media-tab-notes').getAttribute('aria-selected'),'true');
      assert.equal(await page.locator('[data-chart-note-text]').inputValue(),'Mobile unsaved draft '+language);
      assert.deepEqual(await page.evaluate(()=>({path:chartPatientMedia.selectedPath,teeth:[...chartPatientMedia.filterToothIds]})),xray);
      const panelBox=await page.locator('#chart-media-panel').boundingBox();
      const outsideY=Math.max(3,panelBox.y/2), outsideX=viewport.width/2;
      const beforeOutside=await page.evaluate(()=>({x:scrollX,y:scrollY}));
      await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:outsideX,y:outsideY}]});
      await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:outsideX+80,y:outsideY}]});
      await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      assert.equal(await page.evaluate(()=>chartPatientMedia.collapsed),false,'Swiping outside does not dismiss or navigate');
      assert.deepEqual(await page.evaluate(()=>({x:scrollX,y:scrollY})),beforeOutside,'Swiping outside cannot scroll the chart');
      await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:outsideX,y:outsideY}]});
      await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:outsideX,y:outsideY+100}]});
      await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      assert.equal(await page.evaluate(()=>chartPatientMedia.collapsed),false,'Dragging from the backdrop into the panel is ignored');
      await page.touchscreen.tap(outsideX,outsideY);
      await page.waitForFunction(()=>chartPatientMedia.collapsed);
      assert.equal(await page.locator('.chart-clinical-column').evaluate(node=>node.inert),false,'Tapping outside unlocks the chart');
      await trigger.click();
      assert.equal(await page.locator('[data-chart-note-text]').inputValue(),'Mobile unsaved draft '+language,'Outside dismissal retains the draft');
      await swipe('.chart-media-sheet-handle',0,20);
      assert.equal(await page.evaluate(()=>chartPatientMedia.collapsed),false,'A short pull returns the sheet');
      await swipe('.chart-media-sheet-handle',65,10);
      assert.equal(await page.evaluate(()=>chartPatientMedia.collapsed),false,'Horizontal gestures do not dismiss');
      await swipe('.chart-media-sheet-handle',0,100,true);
      assert.equal(await page.evaluate(()=>chartPatientMedia.collapsed),false,'Cancelled touches do not dismiss');
      await page.screenshot({path:path.join(screenshots,`mobile-tabs-${viewport.width}-${language}.png`)});
      const transform=await swipe('.chart-media-sheet-handle',0,140);
      assert.notEqual(transform,'none','The panel follows the downward drag');
      assert.equal(await page.evaluate(()=>chartPatientMedia.collapsed),true);
      assert.equal(await page.locator('#chart-media-backdrop').isVisible(),false);
      assert.equal(await page.evaluate(()=>document.body.classList.contains('chart-media-sheet-open')),false);
      assert.equal(await page.locator('.chart-clinical-column').evaluate(node=>node.inert),false);
      assert.equal(await page.evaluate(()=>document.activeElement.dataset.toothNoteTrigger),'3','Swipe dismissal returns focus to the tooth');
      await trigger.click();
      assert.equal(await page.locator('[data-chart-note-text]').inputValue(),'Mobile unsaved draft '+language,'Swiping down keeps the unsaved draft');
      await page.evaluate(()=>closeChartFindingNoteEditor());
      const content=notesPanel.locator('.tooth-notes-content');
      await content.evaluate(node=>node.scrollTop=50);
      assert.ok(await content.evaluate(node=>node.scrollTop)>0);
      await swipe('.tooth-notes-content',0,60);
      assert.equal(await page.evaluate(()=>chartPatientMedia.collapsed),false,'Scrolling a note list never dismisses from an existing scroll position');
      await content.evaluate(node=>node.scrollTop=0);
      await swipe('.tooth-notes-content',0,-70);
      assert.equal(await page.evaluate(()=>chartPatientMedia.collapsed),false,'Upward swipes scroll normally');
      // A native fling consumes a tap to stop scrolling; wait for it to settle.
      await content.evaluate(node=>new Promise(resolve=>{
        let previous=node.scrollTop,stable=0;
        const frame=()=>{const next=node.scrollTop;stable=next===previous?stable+1:0;previous=next;if(stable>=8)resolve();else requestAnimationFrame(frame);};
        requestAnimationFrame(frame);
      }));
      await page.locator('#chart-media-tab-xrays').tap();
      await page.locator('#chart-media-panel-body').waitFor({state:'visible',timeout:3000});
      await page.locator('#chart-media-panel-body').evaluate(node=>node.scrollTop=100);
      await swipe('#chart-media-panel-body',0,60);
      assert.equal(await page.evaluate(()=>chartPatientMedia.collapsed),false,'X-ray scrolling stays independent of dismissal');
      await page.locator('#chart-media-collapse').click();
    }
    await page.setViewportSize({width:390,height:844});
    await page.emulateMedia({reducedMotion:'no-preference'});
    await trigger.click();
    await page.evaluate(async()=>{await chartMediaSheetAnimation?.finished.catch(()=>{});});
    await swipe('.chart-media-sheet-handle',0,20);
    assert.equal(await page.evaluate(()=>chartMediaSheetAnimation?.playState),'running','A short pull animates back into place');
    await page.evaluate(async()=>{await chartMediaSheetAnimation?.finished.catch(()=>{});});
    await swipe('.chart-media-sheet-handle',0,140);
    assert.equal(await page.evaluate(()=>chartMediaSheetAnimation?.playState),'running','Swipe dismissal animates from the dragged position');
    await page.evaluate(async()=>{await chartMediaSheetAnimation?.finished.catch(()=>{});});
    assert.equal(await page.evaluate(()=>document.body.classList.contains('chart-media-sheet-open')),false,'Animated dismissal restores scrolling');
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(()=>{
      closeChartToothNotesPanel({render:false});chartPatientMedia.lastToothId='4';chartPatientMedia.collapsed=false;renderChartMediaPanel();
    });
    await page.locator('#chart-media-tab-notes').tap();
    assert.equal(await page.evaluate(()=>chartToothNotesPanel.toothId),'4','Notes follows the most recently opened X-ray tooth');
    await page.locator('#chart-media-collapse').click();
    await page.evaluate(()=>{
      closeChartToothNotesPanel({render:false});chartPatientMedia.lastToothId='';chartPatientMedia.filterToothIds=[];chartPatientMedia.collapsed=false;renderChartMediaPanel();
    });
    await page.locator('#chart-media-tab-notes').tap();
    assert.equal(await notesPanel.locator('.tooth-notes-empty button').isVisible(),true,'Notes offers tooth selection when there is no tooth context');
    await page.locator('#chart-media-collapse').click();
    await page.evaluate(()=>{chartPatientMedia.filterToothIds=['3','4'];chartPatientMedia.selectedPath=chartPatientMedia.files[1].relativePath;});
    await touch.send('Network.setUserAgentOverride',{userAgent:''});
  });
  await page.setViewportSize({width:1440,height:1000});
  await trigger.click();
  await page.locator('[data-tooth-xray-slot="4"] button').click();
  assert.equal(await notesPanel.isVisible(),false,'A tooth X-ray icon switches the sidebar back to X-rays');
  assert.deepEqual(await page.evaluate(()=>chartPatientMedia.filterToothIds),['3']);
  await page.evaluate(()=>{currentSession=null;renderChartAppointmentsPanel();});
  await trigger.click();
  await page.locator('#chart-media-collapse').click();
  assert.ok((await page.locator('#chart-media-panel').boundingBox()).height<=150,'Notes collapse to the compact rail when appointments are unavailable');
  await page.locator('#chart-media-collapse').click();
  await notesPanel.locator('.tooth-notes-header button').click();
  await page.evaluate(()=>{currentSession={user:{id:'staff'}};renderChartAppointmentsPanel();});
  await page.setViewportSize({width:320,height:568});
  await page.locator('#chart-media-collapse').click();
  await page.locator('[data-tooth-note-trigger="32"]').click();
  await notesPanel.locator('[data-note-tooth="32"]').click();
  assert.equal(await page.evaluate(()=>window.selectedTargets[0].tooth),'32');
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>{currentUiLanguage='en';document.documentElement.dir='ltr';});
  await trigger.click();
  await notesPanel.locator('[data-finding-id="crown"] button').click();
  await page.locator('[data-chart-note-text]').fill('Original patient pending save');
  await page.evaluate(()=>{window.holdSaves=true;window.oldSave=saveChartFindingNotes({preventDefault(){}});});
  await page.evaluate(async()=>{
    window.previousPatient=patient;
    patient={id:'patient-2',name:'Other patient',chartState:{'3':{whole:[finding('new-crown','Crown',[note('New patient note')])],surfaces:{}}}};
    activePatientId=patient.id;await loadChartPatientMedia();renderChartToothNoteIndicators();
  });
  assert.equal(await notesPanel.isVisible(),false,'Changing patients clears the previous notes panel');
  assert.equal(await page.locator('#modal-chart-finding-notes').isVisible(),false);
  await trigger.click();
  assert.doesNotMatch(await notesPanel.textContent(),/Original patient pending save|Updated diagnostic note/);
  await notesPanel.locator('[data-finding-id="new-crown"] button').click();
  await page.locator('[data-chart-note-text]').fill('New patient pending save');
  await page.evaluate(()=>{window.newSave=saveChartFindingNotes({preventDefault(){}});});
  await page.evaluate(async()=>{window.heldSaves[0]();await window.oldSave;});
  assert.equal(await page.locator('[data-chart-note-text]').inputValue(),'New patient pending save','A late save cannot replace another patient’s draft');
  assert.equal(await page.locator('#save-chart-finding-notes').isDisabled(),true,'A late save cannot unlock another pending save');
  await page.evaluate(async()=>{window.heldSaves[1]();await window.newSave;window.holdSaves=false;});
  assert.match(await notesPanel.textContent(),/New patient pending save/);
  assert.equal(await page.evaluate(()=>window.previousPatient.chartState['3'].whole[0].notes[0].text),'Original patient pending save');
  await page.evaluate(()=>{canReadChart=false;renderChartToothNoteIndicators();});assert.equal(await trigger.isDisabled(),true);
  assert.equal(await notesPanel.isVisible(),false,'Removing chart access hides the notes');
  assert.deepEqual(errors,[]);
});
