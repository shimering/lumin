const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
function source(name){const start=html.search(new RegExp('    (?:async )?function '+name+'\\('));assert.ok(start>=0,name);return html.slice(start,html.indexOf('\n    }',start)+6);}

test('newest visit preview, three-visit drawer and note/date popup work across devices and languages',async t=>{
  const head=html.slice(0,html.indexOf('</head>')+7).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(head+'<body class="lumin-raised"><main style="max-width:1000px;margin:auto;padding:16px"><div id="findings-container"></div></main></body></html>');return;}
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.statusCode=404;res.end();return;}
    res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||undefined});t.after(()=>browser.close());
  const page=await browser.newPage({timezoneId:'Africa/Cairo'}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addScriptTag({path:path.join(root,'vendor/lucide.min.js')});
  await page.addScriptTag({path:path.join(root,'lumin-ortho-visits.js')});
  await page.addScriptTag({content:`
    let currentUiLanguage='en',currentSession={user:{id:'user'}},chartInvoiceStateLoading=false,chartDoctorsLoaded=true;
    const selectedFindingIds=new Set(),invoicedFindingIds=new Set(),expandedOrthoFindings=new Set();
    const chartDoctors=[{userId:'00000000-0000-4000-8000-000000000001',fullName:'Dr A'},{userId:'00000000-0000-4000-8000-000000000002',fullName:'Dr B'}];
    const OPERATION_STATUSES={P:{key:'P',label:'Planned'},C:{key:'C',label:'Completed'},In:{key:'In',label:'In progress'},E:{key:'E',label:'Existing'}};
    let patient={id:'patient',chartState:{finding:{id:'package',code:'Orthodontic treatment',isOrthoPackage:true,price:5000,doctorId:null,orthoVisits:[]}}},saves=0,failSave=false,hrDirectoryLoaded=true,financeInvoicesLoaded=true;
    const dashboardInvoiceCache=new Map(),rpcCalls=[];
    const db={rpc:async(name,args)=>{rpcCalls.push({name,args});return {error:null};}};
    function getActivePatient(){return patient;}
    function collectDocumentedFindings(patient){return [patient.chartState.finding];}
    function clonePatientChart(chart){return JSON.parse(JSON.stringify(chart));}
    function updateChartFindingById(patient,id,update){if(patient.chartState.finding.id!==id)return false;patient.chartState.finding=update(patient.chartState.finding);return true;}
    function updateChartFindingsByIds(patient,ids,update){return ids.includes(patient.chartState.finding.id)&&updateChartFindingById(patient,patient.chartState.finding.id,update);}
    async function saveActivePatientChart(patient,{previousChartState,afterSave}={}){saves++;if(failSave){if(failSave!=='committed')patient.chartState=previousChartState;return false;}if(afterSave)await afterSave();return true;}
    async function refreshChartFindingInvoiceState(){}
    function dentalOperationLabel(code){return code;}
    function chartFindingInvoiceColumn(){return '';}
    function normaliseChartCreatedAt(value){return new Date(value).toISOString();}
    function createChartFindingId(){return crypto.randomUUID();}
    function escapeHtml(value){const node=document.createElement('span');node.textContent=String(value);return node.innerHTML.replaceAll('"','&quot;');}
    function formatChartOperationCreatedAt(value){return new Intl.DateTimeFormat(currentUiLanguage==='ar'?'ar-EG':'en-GB',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));}
    function normaliseChartFindingSteps(value){return value||[];}
    function chartFindingIdsFromControl(control){return [control.closest('[data-finding-id]').dataset.findingId];}
    function chartFindingGroupFromControl(){return patient.chartState.finding;}
    function showAppointmentNotificationToast(){}
    function alert(message){throw Error(message);}
    function renderFindingsList(){
      syncOrthoVisitDialogContext();
      const finding=patient.chartState.finding;
      document.getElementById('findings-container').innerHTML='<article class="finding-row has-ortho-visits" data-finding-id="package">'+renderOrthoVisitDrawer(finding,finding.orthoVisits,!expandedOrthoFindings.has('package'))+'</article>';
      if(window.lucide)lucide.createIcons();
    }
    function reset(){expandedOrthoFindings.clear();invoicedFindingIds.clear();patient.chartState.finding.doctorId=null;
      patient.chartState.finding.orthoVisits=Array.from({length:5},(_,index)=>({id:'00000000-0000-4000-8000-'+String(index+10).padStart(12,'0'),visitNumber:index+1,status:'C',price:200,notes:'Visit notes '+(index+1),doctorId:null,date:'2026-10-19T12:00:00Z',createdAt:'2026-10-'+String(index+10).padStart(2,'0')+'T12:00:00Z'}));renderFindingsList();}
    ${['chartFindingCreatedAtTimestamp','chartOperationDateInputValue','normaliseOperationStatus','normaliseOrthoVisit','normaliseOrthoVisits','operationStatusDefinition','operationStatusSelectOptions','chartDoctorSelectOptions','toggleOrthoVisitsCollapse','addOrthoVisit','toggleOrthoVisitSelection','updateFindingDoctorFromControl','updateOrthoVisitDoctor','updateOrthoVisitPrice'].map(source).join('\n')}
  `});
  const screenshots=process.env.LUMIN_MEDIA_SCREENSHOT_DIR||path.join(require('node:os').tmpdir(),'lumin-ortho-visits');fs.mkdirSync(screenshots,{recursive:true});
  const card=page.locator('.ortho-visit-card'),dialog=page.locator('#ortho-visit-dialog');
  for(const viewport of [{width:390,height:844},{width:834,height:1112},{width:1440,height:1000}]){
    await page.setViewportSize(viewport);
    for(const language of ['en','ar']){
      await page.evaluate(language=>{currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';reset();},language);
      assert.equal(await card.count(),1);assert.match(await card.locator('.ortho-visit-number').textContent(),/#5/);
      const toggle=page.locator('.ortho-visits-footer [aria-expanded]');assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert.match(await toggle.textContent(),/5/);
      await toggle.click();assert.equal(await card.count(),5);assert.match(await card.first().locator('.ortho-visit-number').textContent(),/#5/);
      const size=await page.locator('.ortho-visits-scroll').evaluate(list=>({height:list.clientHeight,scroll:list.scrollHeight,row:list.firstElementChild.getBoundingClientRect().height,padding:4}));
      assert.ok(size.scroll>size.height,'Older visits scroll');assert.ok(size.height<=size.row*3+20,'At most three visit rows fit');assert.ok(size.height>=size.row*3,'Three visits fit when expanded');
      await page.locator('.ortho-visits-scroll').evaluate(list=>{list.scrollTop=list.scrollHeight;});assert.ok(await card.last().isVisible());
      await toggle.click();assert.equal(await card.count(),1);
      const before=await page.evaluate(()=>saves);
      await card.locator('.ortho-note-button').click();assert.ok(await dialog.isVisible());
      await dialog.locator('textarea').fill('New visit text');await dialog.locator('#ortho-visit-date').fill('2026-10-01T10:30');
      await dialog.locator('[data-visit-cancel]').click();assert.equal(await page.evaluate(()=>saves),before);
      await card.locator('.ortho-visit-date').click();await dialog.locator('textarea').fill('Updated notes <script>');await dialog.locator('#ortho-visit-date').fill('2026-10-01T10:30');
      await dialog.locator('[data-visit-save]').click();await dialog.waitFor({state:'hidden'});
      assert.match(await card.locator('.ortho-visit-number').textContent(),/#5/,'Editing the clinical date does not reorder creation history');
      assert.equal(await card.locator('.ortho-visit-notes').textContent(),'Updated notes <script>');
      assert.equal(await page.evaluate(()=>patient.chartState.finding.orthoVisits.at(-1).date),'2026-10-01T07:30:00.000Z');
      await page.locator('[data-ortho-add-visit]').click();await dialog.locator('textarea').fill('Newly recorded visit');await dialog.locator('#ortho-visit-price').fill('275');
      assert.equal(await dialog.locator('#ortho-visit-status').inputValue(),'C');
      const bounds=await dialog.boundingBox();assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width+1&&bounds.y+bounds.height<=viewport.height+1);
      if(viewport.width<768)assert.ok(Math.abs(bounds.y+bounds.height-viewport.height)<2,'Mobile popup is a bottom sheet');
      if(viewport.width===390&&language==='ar')await page.screenshot({path:path.join(screenshots,'ortho-visit-mobile-ar.png')});
      await dialog.locator('[data-visit-save]').click();await dialog.waitFor({state:'hidden'});
      assert.equal(await card.count(),1);assert.match(await card.locator('.ortho-visit-number').textContent(),/#6/);assert.equal(await card.locator('.ortho-visit-notes').textContent(),'Newly recorded visit');
      assert.equal(await page.evaluate(()=>invoicedFindingIds.size),0,'Saving keeps the select-and-invoice workflow');
      await card.locator('select').selectOption('00000000-0000-4000-8000-000000000002');
      assert.equal(await page.evaluate(()=>patient.chartState.finding.orthoVisits.at(-1).doctorId),'00000000-0000-4000-8000-000000000002');
      assert.equal(await page.evaluate(()=>rpcCalls.at(-1).args.p_finding_ids[0]),await card.getAttribute('data-ortho-visit-id'));
      await page.evaluate(async()=>{
        const select=document.createElement('select');select.innerHTML='<option value="'+chartDoctors[0].userId+'" selected>Dr A</option>';
        document.querySelector('[data-finding-id]').appendChild(select);await updateFindingDoctorFromControl(select);
      });
      assert.equal(await card.locator('select').count(),0,'Inherited doctor is hidden');
      assert.equal(await page.evaluate(()=>patient.chartState.finding.orthoVisits.every(visit=>visit.doctorId===chartDoctors[0].userId)),true);
      await card.locator('.ortho-note-button').click();assert.ok(!(await dialog.locator('[data-visit-doctor-field]').isVisible()));await page.keyboard.press('Escape');
      await page.evaluate(()=>{patient.chartState.finding.doctorId=null;renderFindingsList();});assert.equal(await card.locator('select').count(),1);
      await page.evaluate(()=>{invoicedFindingIds.add(patient.chartState.finding.orthoVisits.at(-1).id);renderFindingsList();});
      assert.ok(await card.locator('.ortho-visit-price input').isDisabled());await card.locator('.ortho-note-button').click();assert.ok(await dialog.locator('#ortho-visit-price').isDisabled());await page.keyboard.press('Escape');
      for(const button of await page.locator('.ortho-visits-section button').all()){const b=await button.boundingBox();assert.ok(b.width>=44&&b.height>=44);}
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'No page overflow');
      if(viewport.width===1440&&language==='en'){await toggle.click();await page.screenshot({path:path.join(screenshots,'ortho-visits-desktop.png')});}
    }
  }
  await page.evaluate(()=>{reset();failSave=true;});await page.locator('[data-ortho-add-visit]').click();await dialog.locator('textarea').fill('Retry this');await dialog.locator('[data-visit-save]').click();
  assert.ok(await dialog.locator('[data-visit-error]').isVisible());assert.equal(await page.evaluate(()=>patient.chartState.finding.orthoVisits.length),5,'Failed save rolls back');
  await page.evaluate(()=>{failSave=false;});await dialog.locator('[data-visit-save]').click();await dialog.waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>patient.chartState.finding.orthoVisits.length),6,'Retry creates exactly one visit');
  await page.evaluate(()=>{reset();failSave='committed';});await page.locator('[data-ortho-add-visit]').click();await dialog.locator('[data-visit-save]').click();
  assert.equal(await page.evaluate(()=>patient.chartState.finding.orthoVisits.length),6);
  await page.evaluate(()=>{failSave=false;});await dialog.locator('[data-visit-save]').click();await dialog.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>patient.chartState.finding.orthoVisits.length),6,'A committed save followed by a refresh error cannot duplicate the visit on retry');
  await page.locator('.ortho-visits-footer [aria-expanded]').click();await page.locator('.ortho-visits-scroll').evaluate(list=>{list.scrollTop=list.scrollHeight;});
  await page.locator('[data-ortho-add-visit]').click();await dialog.locator('[data-visit-save]').click();await dialog.waitFor({state:'hidden'});
  assert.equal(await page.locator('.ortho-visits-scroll').evaluate(list=>list.scrollTop),0,'New visit is immediately visible in an expanded drawer');
  await card.first().locator('.ortho-note-button').click();await page.evaluate(()=>{patient={id:'another',chartState:patient.chartState};syncOrthoVisitDialogContext();});assert.ok(!(await dialog.isVisible()),'Changing patient closes the editor');
  assert.deepEqual(errors,[]);
});
