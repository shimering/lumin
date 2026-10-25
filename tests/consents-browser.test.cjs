const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {chromium}=require('playwright');
const model=require('../lumin-consent-model.js');
const root=path.resolve(__dirname,'..');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('clinic templates, patient drafts, finalization, printing, procedure prompts and bilingual device layouts', {timeout:120000},async t=>{
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
    const file=path.resolve(root,'.'+decodeURIComponent(pathname));
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||'chrome'});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1320,height:940},timezoneId:'Africa/Cairo'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',dialog=>dialog.accept());
  await page.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:')?route.continue():route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addScriptTag({path:path.join(root,'vendor/lucide.min.js')});
  await page.addScriptTag({path:path.join(root,'lumin-consent-model.js')});
  const doctors=[{user_id:id(80),full_name:'Dr. Noor'},{user_id:id(81),full_name:'Dr. Omar'}];
  const patient={id:id(90),name:'مريم عبد الرحمن / Mariam Hassan',patient_number:274,birth_date:'1990-01-02',phone:'01012345678',age:36,gender:'female',address:'Cairo',chart_state:{3:{wholeOperations:[{code:'implant',id:id(1),doctorId:doctors[1].user_id,createdAt:'2026-10-20'}]}}};
  await page.evaluate(({templates,patient,doctors,idB})=>{
    window.currentSession={user:{id:'staff'}};window.currentUiLanguage='en';window.activeWorkspacePatientId=patient.id;
    window.fixture={templates,patients:[patient,{...patient,id:idB,name:'Second patient',patient_number:275}],doctors,consents:[],admin:true,allowed:true,delay:0,writes:0};
    window.hasPageAccess=page=>page==='admin'?fixture.admin:fixture.allowed;
    window.patientWorkspaceId=()=>activeWorkspacePatientId;
    window.getKnownPatient=pid=>fixture.patients.find(patient=>patient.id===pid);
    window.updatePatientWorkspaceNavigation=(patient,tab)=>{document.querySelectorAll('[data-patient-workspace-tab]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.patientWorkspaceTab===tab)));};
    window.dentalOperationByCode=code=>({code,name:code==='implant'?'Dental implant':'Orthodontic package'});
    window.chartToothLabel=tooth=>'Tooth '+tooth;
    window.print=()=>{window.printCalls=(window.printCalls||0)+1;};
    const operations=[{code:'implant',name:'Dental implant',active:true},{code:'ortho',name:'Orthodontic package',active:true}];
    window.db={rpc:async()=>({data:doctors,error:null}),from(table){
      const filters=[],q={kind:'select',payload:null,start:0,end:999,one:false,sorts:[],
        select(){return q;},eq(key,value){filters.push(row=>row[key]===value);return q;},contains(key,values){filters.push(row=>values.every(value=>row[key]?.includes(value)));return q;},
        order(key,options={}){q.sorts.push([key,options.ascending!==false]);return q;},limit(value){q.end=q.start+value-1;return q;},range(start,end){q.start=start;q.end=end;return q;},
        insert(payload){q.kind='insert';q.payload=payload;return q;},update(payload){q.kind='update';q.payload=payload;return q;},single(){q.one=true;return q;},maybeSingle(){q.one=true;return q;},
        then(resolve,reject){return new Promise(done=>setTimeout(done,fixture.delay)).then(()=>{
          const rows=table==='consent_templates'?fixture.templates:table==='patients'?fixture.patients:table==='dental_operations'?operations:fixture.consents;
          let selected=rows.filter(row=>filters.every(filter=>filter(row)));
          if(q.kind==='insert'){
            const now=new Date().toISOString();const record={id:crypto.randomUUID(),active:true,procedure_codes:[],revision:1,created_at:now,updated_at:now,...q.payload};
            if(table==='patient_consents')record.finalized_at=record.status==='finalized'?now:null;
            rows.push(record);selected=[record];fixture.writes++;
          }else if(q.kind==='update'){
            selected.forEach(record=>Object.assign(record,q.payload,{revision:record.revision+1,updated_at:new Date().toISOString(),...(table==='patient_consents'?{finalized_at:q.payload.status==='finalized'?new Date().toISOString():null}:{})}));fixture.writes++;
          }
          for(const [key,asc] of [...q.sorts].reverse())selected.sort((a,b)=>String(a[key]||'').localeCompare(String(b[key]||''))*(asc?1:-1));
          const data=selected.slice(q.start,q.end+1);return {data:JSON.parse(JSON.stringify(q.one?data[0]||null:data)),error:null};
        }).then(resolve,reject);}
      };return q;
    }};
    document.getElementById('auth-gate').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');
    document.querySelectorAll('main>section').forEach(section=>section.classList.add('hidden'));
    document.getElementById('patient-workspace-sheet').classList.remove('hidden');
    document.getElementById('patient-workspace-header').classList.remove('hidden');
    document.getElementById('view-patient-consents').classList.remove('hidden');
    document.body.classList.add('lumin-raised');
  },{templates:model.templates.map((template,index)=>({...template,id:id(20+index),revision:1,active:true,created_at:'2026-10-25'})),patient,doctors,idB:id(91)});
  await page.addScriptTag({path:path.join(root,'lumin-consents.js')});
  const click=action=>page.locator(`[data-consent-action="${action}"]:visible`).first().click();
  const dialog=page.locator('.consent-dialog');
  const showAdmin=async()=>{
    await page.evaluate(async()=>{LuminConsents.beforeNavigate();document.getElementById('patient-workspace-sheet').classList.add('hidden');document.getElementById('view-admin').classList.remove('hidden');document.getElementById('admin-panel-access').classList.add('hidden');document.getElementById('admin-panel-consents').classList.remove('hidden');await LuminConsents.renderAdmin();});
  };
  const showPatient=async()=>{
    await page.evaluate(async()=>{LuminConsents.beforeNavigate();document.getElementById('view-admin').classList.add('hidden');document.getElementById('patient-workspace-sheet').classList.remove('hidden');await LuminConsents.render();});
  };
  await showAdmin();
  assert.equal(await page.locator('#admin-panel-consents .consent-card').count(),7);
  await page.locator(`[data-template-id="${id(20)}"] [data-consent-action="template-edit"]`).click();
  await dialog.locator('[name="procedure_codes"][value="implant"]').check();
  await dialog.locator('[name="body_en"]').fill(model.templates[0].body_en+'\nClinic reviewed clause.');
  await click('template-save');await dialog.waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>fixture.templates[0].revision),2);
  await page.locator('#admin-panel-consents [data-consent-action="template-new"]').click();
  await dialog.locator('[name="title_en"]').fill('Clinic custom consent');
  await dialog.locator('[name="title_ar"]').fill('موافقة خاصة بالعيادة');
  await dialog.locator('[name="body_en"]').fill('Patient: {{patient_name}}\nDoctor: {{doctor_name}}\nClinic-specific wording.');
  await dialog.locator('[name="procedure_codes"][value="ortho"]').check();
  await click('template-save');await dialog.waitFor({state:'detached'});
  const customTemplate=await page.evaluate(()=>fixture.templates.at(-1));
  assert.deepEqual(customTemplate.procedure_codes,['ortho']);
  await page.locator(`[data-template-id="${customTemplate.id}"] [data-consent-action="template-edit"]`).click();
  await dialog.locator('[name="active"]').uncheck();await click('template-save');await dialog.waitFor({state:'detached'});
  await showPatient();await click('new');
  assert.equal(await dialog.locator(`[data-template-id="${customTemplate.id}"]`).count(),0,'Archived templates remain out of new consent choices');
  await dialog.locator(`[data-template-id="${id(20)}"]`).click();
  assert.equal(await dialog.locator('[name="doctor_name"]').inputValue(),'Dr. Omar','Treating doctor comes from the chart');
  let body=await dialog.locator('[name="body"]').inputValue();
  assert.match(body,/Mariam Hassan/);assert.match(body,/274/);assert.match(body,/1990-01-02/);assert.match(body,/Clinic reviewed clause/);
  await dialog.locator('[name="doctor_id"]').selectOption(id(80));
  body=await dialog.locator('[name="body"]').inputValue();assert.match(body,/Treating doctor: Dr\. Noor/);
  await dialog.locator('[name="body"]').fill(body+'\nPatient-specific clause.');
  await dialog.locator('[name="procedure_name"]').fill('Implant at site 36');
  await click('save-draft');await page.waitForFunction(()=>fixture.consents.length===1);
  await page.waitForFunction(()=>document.querySelector('[data-consent-action="save-draft"]')?.disabled===false);
  const consentId=await page.evaluate(()=>fixture.consents[0].id);
  await click('close');
  assert.equal(await page.locator('#view-patient-consents .consent-card').count(),1);
  await showAdmin();await page.locator(`[data-template-id="${id(20)}"] [data-consent-action="template-edit"]`).click();
  await dialog.locator('[name="body_en"]').fill('New universal version for future patients.');await click('template-save');await dialog.waitFor({state:'detached'});
  await showPatient();await click('open');
  assert.match(await dialog.locator('[name="body"]').inputValue(),/Patient-specific clause/);
  assert.match(await dialog.locator('[name="body"]').inputValue(),/Procedure \/ teeth: Implant at site 36/);
  assert.doesNotMatch(await dialog.locator('[name="body"]').inputValue(),/New universal version/);
  await click('finalize');await page.waitForFunction(()=>fixture.consents[0].status==='finalized');
  await dialog.locator('.consent-copy').waitFor();assert.equal(await dialog.locator('textarea,input').count(),0);
  await click('print');assert.equal(await page.evaluate(()=>printCalls),1);
  await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('#consent-print-root').isVisible(),true);
  assert.equal(await page.locator('#app-shell').isVisible(),false);
  assert.match(await page.locator('#consent-print-root').innerText(),/Patient-specific clause/);
  assert.ok(await page.locator('#consent-print-root').evaluate(node=>node.scrollWidth<=document.documentElement.clientWidth+1));
  const shots=path.join(os.tmpdir(),'lumin-consents-preview');fs.mkdirSync(shots,{recursive:true});
  await page.screenshot({path:path.join(shots,'consent-print.png'),fullPage:true});
  await page.emulateMedia({media:'screen'});await page.evaluate(()=>dispatchEvent(new Event('afterprint')));await click('close');
  // An applied multi-tooth/surface procedure creates one prompt and keeps context.
  await page.evaluate(()=>{
    const patient=fixture.patients[0];patient.chartState={3:{surfaces:{left:[{id:'00000000-0000-4000-8000-000000000002',code:'implant',createdAt:'applied'}],right:[{id:'00000000-0000-4000-8000-000000000002',code:'implant',createdAt:'applied'}]}}};
    LuminConsents.procedureApplied(patient,'implant','applied');
  });
  await page.locator('[data-consent-action="accept-prompt"]').waitFor();await click('skip-prompt');assert.equal(await page.evaluate(()=>fixture.consents.length),1);
  await page.evaluate(()=>LuminConsents.procedureApplied(fixture.patients[0],'implant','applied'));
  await page.locator('[data-consent-action="accept-prompt"]').waitFor();await click('accept-prompt');await dialog.locator('[name="body"]').waitFor();
  assert.match(await dialog.locator('[name="procedure_name"]').inputValue(),/Dental implant · Tooth 3/);
  await click('save-draft');await page.waitForFunction(()=>fixture.consents.length===2);
  assert.equal(await page.evaluate(()=>fixture.consents[1].finding_ids.length),1);
  await page.waitForFunction(()=>document.querySelector('[data-consent-action="save-draft"]')?.disabled===false);await click('close');
  const draftId=await page.evaluate(()=>fixture.consents[1].id);
  await page.locator(`[data-consent-id="${draftId}"] [data-consent-action="open"]`).click();
  await dialog.locator('[name="body"]').fill('Unsaved local wording');
  await click('print');assert.match(await dialog.locator('[data-consent-feedback]').innerText(),/Save your changes/);
  await page.evaluate(()=>fixture.consents[1].revision++);await click('save-draft');
  await page.waitForFunction(()=>document.querySelector('[data-consent-feedback]')?.textContent.includes('another device'));
  assert.equal(await dialog.locator('[name="body"]').inputValue(),'Unsaved local wording','Conflicts retain the local draft for review');
  await click('close');
  for(const width of [390,820,1320])for(const language of ['en','ar']){
    await page.setViewportSize({width,height:940});
    await page.evaluate(async language=>{currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';await LuminConsents.render();},language);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`history ${width}/${language}`);
    await click('new');await dialog.locator(`[data-template-id="${id(21)}"]`).click();
    assert.equal(await dialog.locator('[name="body"]').getAttribute('dir'),language==='ar'?'rtl':'ltr');
    const bounds=await dialog.boundingBox();assert.ok(bounds.x>=-1&&bounds.x+bounds.width<=width+1);
    assert.ok(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
    for(const control of await dialog.locator('button:visible,input:visible,select:visible').all()){
      const rect=await control.boundingBox();assert.ok(rect.height>=43.9&&rect.width>=43.9);
    }
    await dialog.locator('[data-consent-action="close"]').first().focus();await page.keyboard.press('Shift+Tab');
    assert.equal(await dialog.locator('[data-consent-action="finalize"]').evaluate(node=>node===document.activeElement),true);
    if([390,1320].includes(width))await page.screenshot({path:path.join(shots,`consent-${width}-${language}.png`)});
    await click('close');
  }
  await page.evaluate(async()=>{activeWorkspacePatientId=fixture.patients[1].id;LuminConsents.reset();await LuminConsents.render();});
  assert.equal(await page.locator('#view-patient-consents .consent-card').count(),0,'History is patient specific');
  await page.evaluate(()=>{fixture.delay=100;LuminConsents.openNew();LuminConsents.beforeNavigate();activeWorkspacePatientId=fixture.patients[0].id;});
  await page.waitForTimeout(200);assert.equal(await dialog.count(),0,'Late reads cannot reopen a previous patient dialog');
  await page.evaluate(()=>{fixture.allowed=false;LuminConsents.reset();});
  assert.equal(await page.locator('#view-patient-consents').innerText(),'');
  assert.equal(await page.evaluate(()=>fixture.consents.find(record=>record.id===fixture.consents[0].id).id),consentId);
  assert.deepEqual(errors,[]);console.log('Consent previews:',shots);
});
