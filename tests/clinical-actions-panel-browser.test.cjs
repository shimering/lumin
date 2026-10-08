const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {}
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp('    (?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}
const head = html.slice(0, html.indexOf('</head>') + 7).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const chartStart = html.indexOf('    <section id="view-chart"');
const chart = html.slice(chartStart, html.indexOf('</section>', chartStart) + 10).replace('class="hidden space-y-6"', 'class="space-y-6"');

test('clinical rail preserves selection, applies correct scopes and fits desktop, tablet and phone layouts', { skip: !chromium, timeout: 120000 }, async t => {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(head + '<body><div id="app-header" style="height:56px"></div>' + chart
        + '<style>body{margin:0;padding:16px;background:#f8fafc}#chart-side-panels{--chart-media-sticky-top:72px}.tooth-card{min-height:120px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px}.fixture-surface{min-width:44px;min-height:44px;border-radius:12px;background:#eff6ff}</style></body>');
      return;
    }
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'application/javascript');
    response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addScriptTag({ path: path.join(root, 'vendor/lucide.min.js') });
  const functions = ['escapeHtml', 'emptyChartSelection', 'chartSelectionTargets', 'setChartSelectionTargets', 'toggleSelectedChartTooth',
    'toggleSurface', 'updateSelectionUI', 'activeDentalSpecialties', 'closeChartProcedureMenu', 'renderChartSpecialtyRail',
    'renderChartProcedureMenu', 'renderClinicalActionSelectors', 'setClinicalOperationStatus', 'renderClinicalOperationStatusSelector',
    'renderChartOperationOptions', 'updateClinicalOperationPreview', 'applySelectedDentalOperation', 'applySurfaceCondition',
    'applyToothStatus', 'applyMouthOperation', 'bindGlobalClickEvents', 'updateAppViewportDimensions'].map(source).join('\n');
  await page.addScriptTag({ content: `
    let currentUiLanguage='en', activePatientId='patient-1', activeClinicalOperationStatus='P';
    let activeSelection={tooth:null,slot:null,surfaces:[],targets:[]};
    const CHART_SURFACES=['center','top','bottom','left','right'], SLOT_BY_PRIMARY_TOOTH={};
    const OPERATION_STATUSES={P:{color:'#dc2626'},In:{color:'#2563eb'},C:{color:'#16a34a'},E:{color:'#000'}};
    const chartPatientMedia={collapsed:true}, chartAppointments={collapsed:true};
    let openChartSpecialtyMenuId='', chartProcedureMenuFilter='', dentalCustomizationLoaded=true;
    let dentalSpecialties=[{id:'restoration',name:'Restoration',iconName:'dental-restorative',active:true},{id:'endo',name:'Endo',iconName:'dental-endodontics',active:true}];
    let dentalOperations=[
      {id:'composite',name:'Composite filling',specialtyId:'restoration',active:true,actionScope:'surface',code:'composite',price:500,steps:[]},
      {id:'crown',name:'Crown',specialtyId:'restoration',active:true,actionScope:'tooth',code:'crown',price:1500,steps:[]},
      {id:'root-canal',name:'Root canal',specialtyId:'endo',active:true,actionScope:'tooth',code:'root-canal',price:1200,steps:[]},
      {id:'mouth',name:'Whole-mouth examination',specialtyId:'endo',active:true,actionScope:'mouth',code:'mouth',price:200,steps:[]},
      {id:'inactive',name:'Inactive procedure',specialtyId:'endo',active:false,actionScope:'tooth',price:0}
    ];
    let patients=[{id:'patient-1',chartState:{}},{id:'patient-2',chartState:{}}], missingPatient=false;
    window.savedCharts=[]; window.alerts=[];
    function getActivePatient(){return missingPatient ? null : patients.find(patient=>patient.id===activePatientId);}
    function chartToothLabel(id){return 'UL'+id;}
    function surfaceAbbreviation(id,surface){return surface==='center'?'O':surface;}
    function renderToothVisuals(){}
    function formatInvoiceMoney(value){return value+' EGP';}
    function renderFindingsList(){document.getElementById('findings-container').textContent=JSON.stringify(getActivePatient().chartState);}
    function saveActivePatientChart(){window.savedCharts.push(JSON.parse(JSON.stringify(getActivePatient().chartState)));}
    function getOrCreateChartTooth(patient,tooth){return patient.chartState[tooth] ||= {surfaces:{},wholeOperations:[]};}
    function ensureWholeOperations(tooth){return tooth.wholeOperations ||= [];}
    function chartSurfaceFindings(value){return value||[];}
    function storeChartSurfaceFindings(tooth,surface,findings){tooth.surfaces[surface]=findings;}
    function normaliseOperationStatus(status){return status;}
    function chartFindingDefaultPrice(){return 0;}
    let nextId=0;function createChartFindingId(){return 'finding-'+(++nextId);}
    function chartFindingStorageRecord(code,status,createdAt,id,price,batchId){return {id:id||createChartFindingId(),code,status,price,batchId};}
    function createChartFindingSteps(){return [];}
    function dentalOperationByCode(code){return dentalOperations.find(operation=>operation.code===code);}
    async function syncImplantProgressFromChartOperation(){}
    function ensureChartMeta(patient){return patient.chartState._meta ||= {mouthOperations:[]};}
    function chartMouthFindings(patient){return ensureChartMeta(patient).mouthOperations;}
    function ensureMouthOperations(patient){return ensureChartMeta(patient).mouthOperations;}
    function storeMouthOperations(patient,findings){ensureChartMeta(patient).mouthOperations=findings;}
    function chartAppointmentsCanView(){return true;}
    function renderChartAppointmentsPanel(){document.getElementById('chart-appointments-body').hidden=chartAppointments.collapsed;updateChartSidePanelLayout();}
    function renderChartMediaPanel(){document.getElementById('chart-clinical-workspace').classList.toggle('is-media-collapsed',chartPatientMedia.collapsed);updateChartSidePanelLayout();}
    function alert(message){window.alerts.push(message);}
    function clearSelectedTooth(){}
    const toothDentitionLongPressSuppressClickUntil=0;
    function beginToothDentitionLongPress(){}
    function moveToothDentitionLongPress(){}
    function finishToothDentitionLongPress(){}
    function closeFindingToothEditors(){}
    ${functions}
    ${fs.readFileSync(path.join(root, 'lumin-chart-appointments.js'), 'utf8').match(/function updateChartSidePanelLayout\(\) \{[\s\S]*?\n\}/)[0]}
    document.getElementById('upper-arch').innerHTML=Array.from({length:16},(_,i)=>'<div class="tooth-card" id="tooth-card-'+(i+1)+'" data-tooth-card="'+(i+1)+'" data-slot="'+(i+1)+'" role="button" tabindex="0"><span>UL'+(i+1)+'</span><button type="button" class="fixture-surface" data-tooth="'+(i+1)+'" data-surface="center" id="tooth-'+(i+1)+'-center">O</button></div>').join('');
    document.getElementById('lower-arch').innerHTML=Array.from({length:16},(_,i)=>'<div class="tooth-card" id="tooth-card-'+(i+17)+'" data-tooth-card="'+(i+17)+'" data-slot="'+(i+17)+'" role="button" tabindex="0"><span>LL'+(i+1)+'</span><button type="button" class="fixture-surface" data-tooth="'+(i+17)+'" data-surface="center" id="tooth-'+(i+17)+'-center">O</button></div>').join('');
    bindGlobalClickEvents();
    renderClinicalActionSelectors();renderChartMediaPanel();renderChartAppointmentsPanel();
  ` });
  await page.addScriptTag({ path: path.join(root, 'lumin-mobile-nav.js') });
  await page.addScriptTag({ path: path.join(root, 'lumin-specialty-picker.js') });
  await page.addScriptTag({ path: path.join(root, 'lumin-clinical-actions.js') });
  await page.evaluate(() => { document.dispatchEvent(new Event('DOMContentLoaded')); updateSelectionUI(); });
  const screenshots = path.join(os.tmpdir(), 'lumin-clinical-actions-panel');
  fs.mkdirSync(screenshots, { recursive: true });
  for (const viewport of [{width:1440,height:900},{width:1024,height:768},{width:800,height:600},{width:768,height:1024},{width:390,height:844},{width:320,height:568}]) {
    await page.setViewportSize(viewport);
    await page.evaluate(()=>document.documentElement.classList.toggle('chart-media-landscape',matchMedia('(min-width: 768px) and (orientation: landscape)').matches));
    for (const language of ['en', 'ar']) {
      await page.evaluate(language => {
        currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';
        activeSelection=emptyChartSelection();updateSelectionUI();window.scrollTo(0,0);
      }, language);
      const panel=page.locator('#action-palette-card'), toggle=page.locator('#chart-actions-toggle');
      assert.equal(await toggle.getAttribute('aria-expanded'),'false');
      if(viewport.width<768)assert.equal(await panel.isVisible(),false,'The collapsed mobile panel has no floating bar');
      await page.locator('#tooth-card-1').click({position:{x:10,y:10}});
      assert.equal(await toggle.getAttribute('aria-expanded'),'true');
      if(viewport.width<768){const box=await panel.boundingBox();assert.ok(Math.abs(box.height-viewport.height/2)<2,JSON.stringify({viewport,box}));}
      assert.equal(await page.evaluate(()=>document.activeElement.tagName==='INPUT'),false,'Selecting a tooth never opens the keyboard');
      assert.equal(await page.locator('[data-clinical-operation="inactive"]').count(),0);
      await page.locator('#chart-actions-search').fill('root');
      assert.equal(await page.locator('[data-clinical-operation]').count(),1);
      await page.locator('[data-clinical-operation="root-canal"]').click();
      assert.equal(await toggle.getAttribute('aria-expanded'),'true','Choosing a procedure keeps the panel open');
      assert.deepEqual(await page.evaluate(()=>chartSelectionTargets().map(target=>target.tooth)),['1']);
      await page.evaluate(()=>{collapseChartSidePanels();updateSelectionUI();});
      assert.equal(await toggle.getAttribute('aria-expanded'),'false','Reopening the chart stays collapsed with a retained selection');
      assert.deepEqual(await page.evaluate(()=>chartSelectionTargets().map(target=>target.tooth)),['1']);
      assert.equal(await page.locator('#chart-operation-select').inputValue(),'root-canal','Reopening preserves the procedure draft');
      assert.equal(await page.locator('#chart-clinical-workspace').evaluate(node=>node.classList.contains('is-chart-rail-collapsed')),true);
      if(viewport.width<768){
        assert.equal(await panel.isVisible(),false);
        await page.evaluate(()=>toggleClinicalActionsPanel());
      }else await toggle.click();
      assert.equal(await toggle.getAttribute('aria-expanded'),'true','The desktop panel still opens manually');
      await page.locator('#chart-operation-status-select').selectOption('In');
      assert.equal(await toggle.getAttribute('aria-expanded'),'true','Changing status keeps the panel open');
      assert.equal(await page.locator('#chart-apply-operation-button').isEnabled(),true);
      const apply=await page.locator('#chart-apply-operation-button').boundingBox();
      assert.ok(apply.width>=44&&apply.height>=44,JSON.stringify({viewport,language,apply}));
      assert.ok(apply.x>=0&&apply.x+apply.width<=viewport.width+1,JSON.stringify({viewport,language,apply}));
      assert.ok(apply.y>=0&&apply.y+apply.height<=viewport.height+1,JSON.stringify({viewport,language,apply}));
      if(viewport.width>=768){const chartBox=await page.locator('.chart-clinical-column').boundingBox(),box=await panel.boundingBox();assert.ok(box.x>=chartBox.x+chartBox.width,'Panel stays on the physical right in both languages');}
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      if(viewport.width===1440||viewport.width===320)await page.screenshot({path:path.join(screenshots,`clinical-actions-${viewport.width}-${language}.png`)});
      await toggle.click();
      assert.deepEqual(await page.evaluate(()=>chartSelectionTargets().map(target=>target.tooth)),['1']);
      await page.locator('#tooth-card-2').click({position:{x:10,y:10}});
      assert.equal(await toggle.getAttribute('aria-expanded'),'true','Adding another tooth reopens the panel');
      assert.deepEqual(await page.evaluate(()=>chartSelectionTargets().map(target=>target.tooth)),['1','2']);
      await page.locator('#chart-apply-operation-button').click();
      assert.equal(await toggle.getAttribute('aria-expanded'),'false','Apply closes the panel after adding the treatment');
      assert.deepEqual(await page.evaluate(()=>chartSelectionTargets().map(target=>target.tooth)),['1','2'],'Apply preserves selected teeth');
      assert.deepEqual(await page.evaluate(()=>['1','2'].map(id=>getActivePatient().chartState[id].wholeOperations.at(-1).status)),['In','In']);
      await page.evaluate(()=>clearClinicalActionsSelection());
      assert.equal(await toggle.getAttribute('aria-expanded'),'false');
      assert.equal(await page.evaluate(()=>chartSelectionTargets().length),0);
    }
  }
  await page.setViewportSize({width:1440,height:900});
  await page.evaluate(()=>{currentUiLanguage='en';document.documentElement.dir='ltr';activeSelection=emptyChartSelection();updateSelectionUI();toggleSelectedChartTooth('3',3);resetClinicalActionsFilters();});
  await page.locator('[data-clinical-operation="composite"]').click();
  await page.locator('#chart-operation-status-select').selectOption('C');
  await page.locator('#chart-apply-operation-button').click();
  assert.equal(await page.locator('#chart-actions-toggle').getAttribute('aria-expanded'),'false','Surface Apply closes the panel');
  assert.equal(await page.evaluate(()=>getActivePatient().chartState['3'].surfaces.center.at(-1).status),'C');
  assert.equal(await page.locator('#chart-apply-operation-button').isEnabled(),false,'Surface procedures require surfaces after applying');
  await page.locator('#tooth-3-center').click();
  assert.equal(await page.locator('#chart-apply-operation-button').isEnabled(),true);
  await page.evaluate(()=>{chartPatientMedia.collapsed=false;renderChartMediaPanel();});
  assert.equal(await page.locator('#chart-actions-toggle').getAttribute('aria-expanded'),'false','Viewer opens without a competing clinical pane');
  assert.deepEqual(await page.evaluate(()=>chartSelectionTargets().map(target=>target.tooth)),['3']);
  await page.evaluate(()=>{chartAppointments.collapsed=false;renderChartAppointmentsPanel();collapseChartSidePanels();updateSelectionUI();});
  assert.deepEqual(await page.evaluate(()=>({media:chartPatientMedia.collapsed,appointments:chartAppointments.collapsed,actions:clinicalActionsPanel.open})),{media:true,appointments:true,actions:false},'Returning to the chart collapses every side panel');
  assert.equal(await page.locator('#chart-appointments-body').isVisible(),false);
  await page.locator('#chart-actions-toggle').click();
  assert.equal(await page.evaluate(()=>chartPatientMedia.collapsed),true);
  await page.locator('#chart-actions-clear-selection').click();
  await page.locator('#chart-actions-toggle').click();
  await page.locator('[data-clinical-operation="mouth"]').click();
  assert.equal(await page.locator('#chart-apply-operation-button').isEnabled(),true,'Mouth procedures remain available without a tooth');
  await page.locator('#chart-apply-operation-button').click();
  assert.equal(await page.evaluate(()=>chartMouthFindings(getActivePatient()).length),1);
  assert.equal(await page.locator('#chart-actions-toggle').getAttribute('aria-expanded'),'false','Whole-mouth Apply closes the panel');
  await page.locator('#chart-actions-toggle').click();
  await page.locator('#chart-actions-search').fill('unmatched');
  assert.match(await page.locator('#chart-actions-operations').textContent(),/No matching procedures/);
  await page.locator('#chart-actions-operations button').click();
  assert.equal(await page.locator('[data-clinical-operation]').count(),4);
  await page.locator('#chart-actions-specialty-trigger').click();
  await page.locator('[data-clinical-specialty="endo"]').click();
  assert.equal(await page.locator('[data-clinical-operation]').count(),2);
  await page.evaluate(()=>{resetClinicalActionsFilters();toggleSelectedChartTooth('4',4);});
  await page.locator('[data-clinical-operation="crown"] svg').click();
  assert.equal(await page.locator('#chart-actions-toggle').getAttribute('aria-expanded'),'true','Clicking a procedure icon also keeps the panel open');
  const savesBeforeFailure=await page.evaluate(()=>window.savedCharts.length);
  await page.evaluate(()=>{missingPatient=true;});
  await page.locator('#chart-apply-operation-button').click();
  assert.equal(await page.locator('#chart-actions-toggle').getAttribute('aria-expanded'),'true','Unsuccessful Apply keeps the panel open');
  assert.equal(await page.evaluate(()=>window.savedCharts.length),savesBeforeFailure);
  await page.evaluate(()=>{missingPatient=false;});
  await page.locator('#chart-apply-operation-button').click();
  assert.equal(await page.locator('#chart-actions-toggle').getAttribute('aria-expanded'),'false');
  await page.evaluate(()=>{activePatientId='patient-2';activeSelection=emptyChartSelection();updateSelectionUI();});
  assert.equal(await page.locator('#chart-actions-toggle').getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('#chart-operation-select').inputValue(),'');
  assert.equal(await page.locator('#chart-actions-search').inputValue(),'');
  assert.equal(await page.locator('#chart-actions-specialty-filter').inputValue(),'');
  assert.equal(await page.evaluate(()=>Object.keys(getActivePatient().chartState).length),0,'Patient change does not carry draft work into another chart');
  await t.test('specialty icon menu supports keyboard selection and stays inside mobile and RTL bounds', async () => {
    for(const viewport of [{width:1440,height:900},{width:800,height:600},{width:390,height:844},{width:320,height:568}])for(const language of ['en','ar']){
      await page.setViewportSize(viewport);
      await page.evaluate(language=>{
        currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';
        activeSelection=emptyChartSelection();resetClinicalActionsFilters();updateSelectionUI();toggleSelectedChartTooth('1',1);
      },language);
      const trigger=page.locator('#chart-actions-specialty-trigger'),menu=page.locator('#chart-actions-specialty-menu');
      await trigger.click();
      assert.equal(await trigger.getAttribute('aria-expanded'),'true');
      assert.equal(await menu.getAttribute('dir'),language==='ar'?'rtl':'ltr');
      assert.equal(await menu.locator('[role="option"] .chart-specialty-icon').count(),3);
      assert.match(await menu.locator('[data-clinical-specialty="endo"] img').getAttribute('src'),/specialties-3d\/dental-endodontics.webp/);
      assert.deepEqual(await menu.locator('img').evaluateAll(async images=>Promise.all(images.map(async img=>{img.loading='eager';await img.decode();return [img.naturalWidth,img.naturalHeight];}))),[[64,64],[64,64],[64,64]],'The menu loads the optimized generated assets');
      const box=await menu.boundingBox();
      assert.ok(box.x>=0&&box.x+box.width<=viewport.width+1&&box.y>=0&&box.y+box.height<=viewport.height+1,JSON.stringify({viewport,language,box}));
      if(viewport.width<768){const sheet=await page.locator('#action-palette-card').boundingBox();assert.ok(box.y>=sheet.y&&box.y+box.height<=sheet.y+sheet.height+1,'The menu stays in the half-screen sheet');}
      const option=await menu.locator('[data-clinical-specialty="endo"]').boundingBox();
      assert.ok(option.height>=44,'Specialty choices are touch sized');
      if(viewport.width===1440||viewport.width===390)await page.screenshot({path:path.join(screenshots,`specialty-menu-${viewport.width}-${language}.png`)});
      await page.keyboard.press('End');await page.keyboard.press('Enter');
      assert.equal(await menu.isVisible(),false);
      assert.match(await trigger.textContent(),/Endo/);
      assert.match(await trigger.locator('img').getAttribute('src'),/dental-endodontics.webp/);
      assert.equal(await page.locator('[data-clinical-operation]').count(),2,'The illustrated menu filters procedures');
      assert.deepEqual(await page.evaluate(()=>chartSelectionTargets().map(target=>target.tooth)),['1'],'Filtering preserves selected teeth');
      assert.equal(await page.locator('#chart-actions-toggle').getAttribute('aria-expanded'),'true','Filtering keeps Clinical Actions open');
      await trigger.press('ArrowDown');
      await page.keyboard.press('Escape');
      assert.equal(await menu.isVisible(),false);
      assert.equal(await page.locator('#chart-actions-toggle').getAttribute('aria-expanded'),'true','Escape closes the specialty menu first');
      await trigger.click();
      await menu.locator('[data-clinical-specialty=""]').click();
      assert.equal(await page.locator('[data-clinical-operation]').count(),4);
      await trigger.click();
      await page.evaluate(()=>setClinicalActionsPanelOpen(false));
      assert.equal(await menu.isVisible(),false,'Closing the sheet removes the portal menu');
    }
  });
  await t.test('mobile half-screen sheet supports multiple teeth and native swipe dismissal without a floating bar', async st => {
    const touch=await page.context().newCDPSession(page);
    st.after(()=>touch.detach());
    await touch.send('Network.setUserAgentOverride',{userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'});
    await page.evaluate(()=>{
      activePatientId='patient-1';
      dentalOperations.push(...Array.from({length:40},(_,i)=>({id:'extra-'+i,name:'Additional procedure '+i,specialtyId:'endo',active:true,actionScope:'tooth',code:'extra-'+i,price:100,steps:[]})));
    });
    const swipe=async(selector,dx,dy,cancel=false)=>{
      const box=await page.locator(selector).boundingBox();
      const x=box.x+(selector==='.chart-actions-content'?2:box.width/2),y=box.y+Math.min(10,box.height/2);
      await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
      for(let step=1;step<=4;step++)await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*step/4,y:y+dy*step/4}]});
      const transform=await page.locator('#action-palette-card').evaluate(node=>getComputedStyle(node).transform);
      await touch.send('Input.dispatchTouchEvent',{type:cancel?'touchCancel':'touchEnd',touchPoints:[]});
      return transform;
    };
    for(const viewport of [{width:390,height:844},{width:320,height:568},{width:844,height:390}])for(const language of ['en','ar']){
      await page.setViewportSize(viewport);
      await page.evaluate(language=>{
        currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';
        activeSelection=emptyChartSelection();resetClinicalActionsFilters();updateSelectionUI();updateAppViewportDimensions();
      },language);
      const panel=page.locator('#action-palette-card');
      assert.equal(await panel.isVisible(),false);
      await page.locator('#tooth-card-1').evaluate(node=>node.scrollIntoView({block:'start'}));
      await page.locator('#tooth-card-1').click({position:{x:10,y:10}});
      assert.equal(await panel.isVisible(),true);
      const box=await panel.boundingBox();
      assert.ok(Math.abs(box.height-viewport.height/2)<2,JSON.stringify({viewport,language,box}));
      assert.ok(Math.abs(box.y-viewport.height/2)<2);
      assert.equal(await page.locator('.chart-clinical-column').evaluate(node=>node.inert),false,'The upper chart stays interactive for multiple selection');
      await page.locator('#tooth-card-2').click({position:{x:10,y:10}});
      assert.deepEqual(await page.evaluate(()=>chartSelectionTargets().map(target=>target.tooth)),['1','2']);
      await page.evaluate(()=>chooseClinicalActionsOperation('root-canal'));
      const content=page.locator('.chart-actions-content');
      await content.evaluate(node=>node.scrollTop=100);
      assert.ok(await content.evaluate(node=>node.scrollTop)>0,'Procedures scroll inside the half-screen sheet');
      await swipe('.chart-actions-content',0,65);
      assert.equal(await page.evaluate(()=>clinicalActionsPanel.open),true,'A list scrolled away from the top never dismisses');
      await content.evaluate(node=>node.scrollTop=0);
      await swipe('.chart-actions-content',0,-60);
      assert.equal(await page.evaluate(()=>clinicalActionsPanel.open),true,'Upward scrolling does not dismiss');
      await swipe('.chart-actions-sheet-handle',0,20);
      assert.equal(await page.evaluate(()=>clinicalActionsPanel.open),true,'Short pulls return the sheet');
      await swipe('.chart-actions-sheet-handle',65,10);
      assert.equal(await page.evaluate(()=>clinicalActionsPanel.open),true,'Horizontal swipes do not dismiss');
      await swipe('.chart-actions-sheet-handle',0,100,true);
      assert.equal(await page.evaluate(()=>clinicalActionsPanel.open),true,'Cancelled touches do not dismiss');
      const apply=await page.locator('#chart-apply-operation-button').boundingBox();
      assert.ok(apply.width>=44&&apply.height>=44&&apply.y>=box.y&&apply.y+apply.height<=viewport.height+1,JSON.stringify({viewport,language,apply}));
      if(viewport.width===390||viewport.width===844)await page.screenshot({path:path.join(screenshots,`mobile-half-sheet-${viewport.width}-${language}.png`)});
      assert.notEqual(await swipe('.chart-actions-sheet-handle',0,140),'none','The sheet follows a downward pull');
      assert.equal(await panel.isVisible(),false,'Swiping down removes the entire panel');
      await page.evaluate(()=>updateSelectionUI());
      assert.equal(await panel.isVisible(),false,'A refresh does not reopen a dismissed sheet');
      assert.deepEqual(await page.evaluate(()=>chartSelectionTargets().map(target=>target.tooth)),['1','2']);
      assert.equal(await page.locator('#chart-operation-select').inputValue(),'root-canal','Dismissal retains the procedure draft');
      await page.locator('#tooth-card-3').click({position:{x:10,y:10}});
      assert.equal(await panel.isVisible(),true,'Selecting another tooth reopens the sheet');
      await page.locator('#chart-apply-operation-button').click();
      assert.equal(await panel.isVisible(),false,'Apply removes the panel without a floating bar');
      assert.equal(await page.evaluate(()=>document.activeElement.dataset.toothCard),'3','Focus returns to the selected tooth');
    }
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>{
      document.documentElement.style.zoom='.85';updateAppViewportDimensions();
      activeSelection=emptyChartSelection();updateSelectionUI();toggleSelectedChartTooth('1',1);
    });
    assert.ok(Math.abs((await page.locator('#action-palette-card').boundingBox()).height-422)<2,'The sheet stays at half the visible viewport with app scaling');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#action-palette-card').isVisible(),false);
    await page.evaluate(()=>{document.documentElement.style.removeProperty('zoom');updateAppViewportDimensions();});
  });
  assert.deepEqual(await page.evaluate(()=>window.alerts),[]);
  assert.deepEqual(errors,[]);
});
