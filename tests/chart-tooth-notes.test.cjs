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

test('notes open and save through the diagnostic editor, stay live, and fit expanded, collapsed and mobile charts', {skip:!chromium && 'Playwright unavailable'}, async t => {
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
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}), errors=[];
  page.on('pageerror',error=>errors.push(error.message));
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
    let openChartFindingNoteTrigger=null, chartFindingNotePreviewCloseTimer=null, editingChartFindingNoteIds=[], editingChartFindingNoteToothIds=[], chartFindingNotesDraft=[];
    let patientMediaToothPicker=null;
    function hasPageAccess(){return canReadChart;}
    function chartToothHasFinding(){return false;}
    function getKnownPatient(){return patient;}
    function getStorageServerConfig(){return {url:location.origin};}
    function patientMediaToothIds(details){return details?.tooth_ids||[];}
    function patientMediaToothLabel(value){return value;}
    function patientMediaTeethLabel(){return '';}
    function patientMediaDisplayName(file){return file.filename;}
    function generateRealisticToothPhoto(){return '<svg width="40" height="100" viewBox="0 0 40 100"><path d="M4 24 Q0 0 20 4 Q40 0 36 24 L31 90 L22 90 L19 58 L10 90 Z" fill="#f3f0e9" stroke="#cbd5e1"/></svg>';}
    function generateSurfaceMapSVG(){return '<div style="height:40px"></div>';}
    window.selections=0;
    function setChartSelectionTargets(targets){window.selectedTargets=targets;}
    function updateSelectionUI(){}
    function renderChartFindingTeeth(){}
    function renderFindingsList(){renderChartToothNoteIndicators();}
    function showAppointmentNotificationToast(){}
    window.failSave=false;
    const db={async rpc(name,args){window.savedRequest={name,args};if(window.failSave)return {error:Error('Offline')};
      const next=structuredClone(patient.chartState);
      for(const data of Object.values(next))for(const group of [data.whole||[],...Object.values(data.surfaces||{})])
        for(const finding of group)if(args.p_finding_ids.includes(finding.id))finding.notes=structuredClone(args.p_notes);
      return {data:next};
    }};
  `});
  await page.addScriptTag({path:path.join(root,'lumin-chart-media.js')});
  await page.addScriptTag({path:path.join(root,'lumin-tooth-notes.js')});
  await page.evaluate(()=>{
    document.getElementById('auth-gate').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');
    document.querySelectorAll('#app-main > section, #app-main > div').forEach(node=>node.classList.add('hidden'));
    ['patient-workspace-sheet','patient-workspace-header','view-chart'].forEach(id=>document.getElementById(id).classList.remove('hidden'));
    for(const [id,offset] of [['upper-arch',0],['lower-arch',16]])document.getElementById(id).innerHTML=Array.from({length:16},(_,i)=>renderToothHTML({slot:i+offset+1,toothId:String(i+offset+1),dentition:'permanent'})).join('');
    chartPatientMedia.patientId=patient.id;chartPatientMedia.status='ready';
    document.dispatchEvent(new Event('DOMContentLoaded'));setupChartFindingNotePreview();renderChartMediaPanel();renderChartToothNoteIndicators();
    document.addEventListener('click',event=>{if(event.target.closest('[data-tooth-card]'))window.selections++;});
  });
  const trigger=page.locator('[data-tooth-note-trigger="3"]'), popover=page.locator('#chart-finding-note-popover');
  assert.equal(await page.locator('[data-tooth-note-trigger]').count(),32);
  assert.equal(await trigger.getAttribute('data-note-count'),'3');
  await trigger.focus();await page.keyboard.press('Enter');
  await popover.waitFor({state:'visible'});
  assert.equal(await popover.locator('.tooth-notes-finding').count(),4);
  assert.deepEqual(await page.evaluate(()=>({selected:window.selections,longPress:toothDentitionLongPressTarget(document.querySelector('[data-tooth-note-trigger="3"]'))})),{selected:0,longPress:null});
  const crown=popover.locator('[data-finding-id="crown"]');
  await crown.locator('button').click();
  await page.locator('[data-chart-note-text]').fill('Updated from tooth shortcut');
  await page.locator('#add-endo-chart-note').click();
  await page.locator('[data-endo-root-length]').fill('22.5');await page.locator('[data-endo-root-reference]').fill('Palatal cusp');
  await page.evaluate(()=>window.failSave=true);await page.locator('#save-chart-finding-notes').click();
  await page.waitForFunction(()=>document.getElementById('chart-finding-notes-message').textContent.includes('Offline'));
  assert.equal(await page.locator('[data-chart-note-text]').first().inputValue(),'Updated from tooth shortcut');
  await page.evaluate(()=>window.failSave=false);await page.locator('#save-chart-finding-notes').click();
  await page.locator('#modal-chart-finding-notes').waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(()=>({name:window.savedRequest.name,ids:window.savedRequest.args.p_finding_ids,patient:window.savedRequest.args.p_patient_id})),{name:'set_patient_chart_finding_notes',ids:['crown'],patient:'patient-1'});
  assert.equal(await trigger.getAttribute('data-note-count'),'4');
  await trigger.click();assert.match(await crown.textContent(),/Updated from tooth shortcut[\s\S]*22.5 mm[\s\S]*Palatal cusp/);
  await page.evaluate(()=>{patient.chartState['3'].whole[0].notes=[note('Updated diagnostic note')];renderFindingsList();});
  assert.match(await crown.textContent(),/Updated diagnostic note/,'An open shortcut refreshes from the original finding data');
  await popover.locator('[data-finding-id="endo-3"] button').click();
  await page.locator('[data-chart-note-text]').fill('Shared batch update');await page.locator('#save-chart-finding-notes').click();
  await page.locator('#modal-chart-finding-notes').waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(()=>window.savedRequest.args.p_finding_ids),['endo-3','endo-4']);
  assert.equal(await page.evaluate(()=>patient.chartState['4'].whole[0].notes[0].text),'Shared batch update');
  const screenshots=path.join(os.tmpdir(),'lumin-tooth-notes-preview');fs.mkdirSync(screenshots,{recursive:true});
  for(const viewport of [{width:1440,height:1000},{width:1024,height:768},{width:834,height:1112},{width:390,height:844},{width:320,height:568}]) {
    await page.setViewportSize(viewport);
    for(const language of ['en','ar']) {
      await page.evaluate(language=>{currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';chartPatientMedia.collapsed=true;renderChartMediaPanel();renderChartToothNoteIndicators();},language);
      await trigger.scrollIntoViewIfNeeded();
      const landscape=viewport.width>=768&&viewport.width>viewport.height;
      assert.equal(await trigger.evaluate(node=>getComputedStyle(node.parentElement).flexDirection),landscape?'row':'column');
      for(const selector of ['[data-tooth-note-trigger="3"]','[data-tooth-xray-slot="3"] button']){
        const box=await page.locator(selector).boundingBox();assert.ok(box.width>=44&&box.height>=44);
      }
      if(landscape) {
        await page.locator('#chart-media-collapse').click();
        assert.equal(await trigger.evaluate(node=>getComputedStyle(node.parentElement).flexDirection),'column');
        assert.equal(await page.locator('#upper-arch').evaluate(node=>getComputedStyle(node).minWidth),'768px');
      }
      await trigger.click();
      try { await popover.waitFor({state:'visible',timeout:3000}); }
      catch(error) { await page.screenshot({path:path.join(screenshots,'failure.png')});t.diagnostic(JSON.stringify({viewport,language}));throw error; }
      assert.equal(await popover.getAttribute('dir'),language==='ar'?'rtl':'ltr');
      const box=await popover.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=viewport.width+1&&box.y+box.height<=viewport.height+1,JSON.stringify({viewport,box}));
      await popover.locator('.tooth-notes-content').evaluate(node=>{node.scrollTop=50;node.dispatchEvent(new Event('scroll'));});
      assert.equal(await popover.isVisible(),true,'Scrolling the note list keeps it open');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      if((viewport.width===1440&&language==='en')||(viewport.width===390&&language==='ar'))await page.screenshot({path:path.join(screenshots,`notes-${viewport.width}-${language}.png`)});
      await popover.locator('.tooth-notes-header button').click();assert.equal(await trigger.evaluate(node=>node===document.activeElement),true);
    }
  }
  await page.locator('[data-tooth-note-trigger="32"]').click();
  await popover.locator('[data-note-tooth="32"]').click();
  assert.equal(await page.evaluate(()=>window.selectedTargets[0].tooth),'32');
  await page.evaluate(()=>{canReadChart=false;renderChartToothNoteIndicators();});assert.equal(await trigger.isDisabled(),true);
  assert.deepEqual(errors,[]);
});
