const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright'),{PGlite}=require('@electric-sql/pglite');
const model=require('../lumin-inventory-model.js'),root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
function source(name){const start=html.search(new RegExp('    (?:async )?function '+name+'\\('));assert.ok(start>=0,name);return html.slice(start,html.indexOf('\n    }',start)+6);}
test('inventory page uses the real SQL ledger for imports, categories, stock flows, permissions, mobile and RTL',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(fs.readFileSync(path.join(__dirname,'fixtures/inventory.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261016203800_clinic_inventory.sql'),'utf8'));
  let queue=Promise.resolve();const requests=[];
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||'chrome'});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'});page.setDefaultTimeout(7000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('fixtureRPC',(name,args,actor)=>{
    const run=queue.then(async()=>{
      requests.push({name,args,actor});await db.exec('reset role');await db.query("select set_config('test.actor',$1,false)",[actor]);await db.exec('set role authenticated');
      try{
        const result=name==='get_inventory'?await db.query('select public.get_inventory($1) data',[JSON.stringify(args.p_filters)]):name==='get_inventory_movements'?await db.query('select public.get_inventory_movements($1) data',[JSON.stringify(args.p_filters)]):name==='inventory_write'?await db.query('select public.inventory_write($1,$2,$3) data',[args.p_operation,JSON.stringify(args.p_payload),args.p_request_id]):null;
        if(!result)throw Error('Unexpected RPC '+name);return{data:result.rows[0].data};
      }catch(error){return{error:{message:error.message,code:error.code}};}
    });queue=run.catch(()=>{});return run;
  });
  await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,''));
  for(const file of ['lumin-app.css','lumin-theme.css','lumin-clinic-management.css','lumin-inventory.css'])await page.addStyleTag({path:path.join(root,file)});
  await page.addScriptTag({path:path.join(root,'vendor/lucide.min.js')});
  await page.addScriptTag({content:`
    let currentUiLanguage='en',currentSession={user:{id:'${uuid(1)}'}},currentUserAccess={active:true,isAdmin:true,permissions:new Set(['inventory','inventory_manage','inventory_receive','inventory_use','inventory_adjust'])},activeClinicManagementTab='overview',activeFinanceTab='invoices';
    let db={rpc:async(name,args)=>{const result=await window.fixtureRPC(name,args,currentSession.user.id);if(window.dropReceiptReply&&name==='inventory_write'&&args.p_operation==='receive'&&!result.error){window.dropReceiptReply=false;return{error:{message:'Response lost after commit'}};}return result;}};
    function firstAuthorizedView(){return 'clinic-management'}
    function hrClinicDateValue(){return '2026-10-16'}
    async function switchFinanceTab(){}async function refreshActiveAnalyticsTab(){}async function refreshHrDirectory(){}async function ensureDentalCustomizationLoaded(){}
    ${source('hasPageAccess')}${source('firstAuthorizedClinicManagementTab')}${source('switchClinicManagementTab')}
    document.getElementById('auth-gate').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');document.querySelectorAll('main>section').forEach(node=>node.classList.add('hidden'));document.getElementById('view-clinic-management').classList.remove('hidden');
  `});
  for(const file of ['lumin-inventory-model.js','lumin-inventory.js'])await page.addScriptTag({path:path.join(root,file)});
  await page.evaluate(async()=>{LuminInventory.init();await switchClinicManagementTab('inventory')});
  assert.equal(await page.locator('#view-inventory').isVisible(),true);
  assert.match(await page.locator('#view-inventory').textContent(),/Your inventory starts here/);
  const csv=process.env.LUMIN_INVENTORY_CSV?fs.readFileSync(process.env.LUMIN_INVENTORY_CSV,'utf8'):'التصنيف,الصنف,الكمية الحالية,الحد الأدنى,الوحدة,,Reference\nConsumables (مستهلكات يومية),Anasthesia (Blue),2,3,Box,,\nConsumables (مستهلكات يومية),Cotton pack,,,pack,,\nConsumables (مستهلكات يومية),Napkin,8,235,,,\nConsumables (مستهلكات يومية),Gloves,0,1,Box,,\n';
  const expected=model.parseCSV(csv);
  await page.locator('[data-inv-action="import"]').first().click();
  await page.locator('#inv-import-file').setInputFiles({name:'clinic.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
  await page.waitForFunction(()=>document.querySelectorAll('.inv-import-row').length>0);
  assert.equal(await page.locator('.inv-import-row').count(),expected.length);
  assert.equal(await page.locator('#inventory-overlay input[name="expiry"]').count(),0);
  await page.locator('#inv-dialog-submit').click();
  await page.waitForFunction(()=>!document.getElementById('inventory-overlay')||!document.getElementById('inv-dialog-error')?.hidden);
  assert.equal(await page.locator('#inventory-overlay').count(),0,JSON.stringify({error:await page.locator('#inv-dialog-error').textContent().catch(()=>''),crypto:await page.evaluate(()=>typeof crypto.randomUUID),last:requests.at(-1)}));
  await page.waitForFunction(n=>document.querySelector('[data-inv-stat="total"] strong')?.textContent===String(n),expected.length);
  assert.equal(await page.locator('.inv-table tbody tr').count(),expected.length);
  const categories=await db.query('select id,key from public.inventory_categories');
  const anesthesia=categories.rows.find(c=>c.key==='anaesthesia').id,surgical=categories.rows.find(c=>c.key==='surgical').id;
  const anesthesiaItem=(await db.query("select id from public.inventory_items where name='Anasthesia (Blue)'")).rows[0].id;
  await page.locator(`[data-inv-category="${anesthesia}"]`).click();
  await page.waitForFunction(()=>!document.querySelector('#view-inventory [aria-busy="true"]'));
  assert.ok(await page.locator('.inv-table tbody tr').count()>=1);
  await page.locator(`[data-inv-item="${anesthesiaItem}"]`).first().click();
  await page.locator('#inventory-overlay select[name="category_id"]').selectOption(surgical);
  await page.locator('#inv-dialog-submit').click();
  await page.waitForFunction(()=>!document.getElementById('inventory-overlay'));
  assert.equal(Number((await db.query('select quantity from public.inventory_items where id=$1',[anesthesiaItem])).rows[0].quantity),2);
  await page.locator('[data-inv-category="all"]').click();
  await page.locator('#inv-search').fill('Anasthesia');
  await page.waitForFunction(()=>document.querySelectorAll('.inv-table tbody tr').length===1);
  await page.locator(`[data-inv-item="${anesthesiaItem}"]`).first().click();
  await page.locator('#inventory-overlay [data-inv-action="receive"]').click();
  await page.locator('#inventory-overlay [name="quantity"]').fill('2');
  await page.evaluate(()=>{window.dropReceiptReply=true;});
  await page.locator('#inv-dialog-submit').click();
  await page.waitForFunction(()=>document.getElementById('inv-dialog-error')?.hidden===false);
  await page.locator('#inv-dialog-submit').click();
  await page.waitForFunction(()=>!document.getElementById('inventory-overlay'));
  assert.equal(Number((await db.query('select quantity from public.inventory_items where id=$1',[anesthesiaItem])).rows[0].quantity),4);
  await page.locator(`[data-inv-item="${anesthesiaItem}"]`).first().click();
  await page.locator('#inventory-overlay [data-inv-action="use"]').click();
  await page.locator('#inventory-overlay [name="quantity"]').fill('3');
  await page.locator('#inv-dialog-submit').click();
  await page.waitForFunction(()=>!document.getElementById('inventory-overlay'));
  assert.equal(Number((await db.query('select quantity from public.inventory_items where id=$1',[anesthesiaItem])).rows[0].quantity),1);
  await page.locator('[data-inv-action="history"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.inv-movement').length>0);
  assert.ok((await page.locator('.inv-movement').allTextContents()).some(text=>text.includes('Usage')));
  await page.locator('[data-inv-action="stock"]').click();
  await page.locator('#inv-search').fill('Cotton pack');
  await page.waitForFunction(()=>document.querySelector('.inv-item')?.textContent==='Cotton pack');
  await page.locator('.inv-item').click();
  assert.equal(await page.locator('#inventory-overlay [data-inv-action="receive"]').isDisabled(),true);
  await page.locator('#inventory-overlay [data-inv-action="count"]').click();
  await page.locator('#inventory-overlay [name="quantity"]').fill('10');
  await page.locator('#inventory-overlay [name="reason"]').fill('Physical opening count');
  await page.locator('#inv-dialog-submit').click();
  await page.waitForFunction(()=>!document.getElementById('inventory-overlay'));
  assert.equal(Number((await db.query("select quantity from public.inventory_items where name='Cotton pack'")).rows[0].quantity),10);
  await page.locator('[data-inv-action="categories"]:visible').first().click();
  await page.locator('[data-inv-action="category-add"]').click();
  await page.locator('#inventory-overlay [name="name"]').fill('Restorative');
  await page.locator('#inventory-overlay [name="name_ar"]').fill('مواد ترميمية');
  await page.locator('#inv-dialog-submit').click();
  await page.waitForFunction(()=>!document.getElementById('inventory-overlay'));
  await page.locator('[data-inv-action="clear"]').count().then(async count=>{if(count)await page.locator('[data-inv-action="clear"]').first().click();else await page.locator('#inv-search').fill('');});
  await page.waitForFunction(()=>document.querySelectorAll('.inv-table tbody tr').length>1);
  for(const language of ['en','ar'])for(const width of [320,390,820,1024,1440]){
    await page.setViewportSize({width,height:1100});
    await page.evaluate(lang=>{currentUiLanguage=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';LuminInventory.languageChanged();},language);
    const overflow=await page.locator('#view-inventory').evaluate(node=>node.scrollWidth>node.clientWidth+1);assert.equal(overflow,false,`${language} ${width}`);
    const controls=await page.locator('#view-inventory button:visible').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect()).filter(r=>r.width<43||r.height<43));assert.equal(controls.length,0,`Touch sizes ${language} ${width}`);
    if(width<1024){assert.equal(await page.locator('#inv-mobile-category').isVisible(),true);await page.locator('#inv-mobile-category').selectOption(surgical);await page.waitForFunction(()=>!document.querySelector('#view-inventory [aria-busy="true"]'));await page.locator('#inv-mobile-category').selectOption('all');await page.waitForFunction(()=>!document.querySelector('#view-inventory [aria-busy="true"]'));}
    if(process.env.LUMIN_INVENTORY_SCREENSHOTS&&((language==='en'&&width===1440)||(language==='ar'&&width===390))){fs.mkdirSync(process.env.LUMIN_INVENTORY_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.LUMIN_INVENTORY_SCREENSHOTS,`inventory-${language}-${width}.png`),fullPage:true});}
  }
  await page.setViewportSize({width:390,height:900});
  await page.locator('[data-inv-action="add"]:visible').click();
  assert.equal(await page.locator('.inv-dialog').evaluate(node=>Math.abs(node.getBoundingClientRect().bottom-window.innerHeight)<2),true,'Mobile dialog is a bottom sheet');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#inventory-overlay').count(),0);
  await page.evaluate(async()=>{currentSession={user:{id:'00000000-0000-4000-8000-000000000002'}};currentUserAccess={active:true,isAdmin:false,permissions:new Set(['inventory'])};LuminInventory.reset();await switchClinicManagementTab('overview');});
  assert.equal(await page.locator('#clinic-management-tab-inventory').getAttribute('aria-selected'),'true','Inventory-only staff land on their authorized tab');
  assert.equal(await page.locator('#clinic-management-tab-overview').isVisible(),false);
  assert.equal(await page.locator('#view-inventory [data-inv-action="add"]').count(),0);
  assert.equal(await page.locator('#view-inventory [data-inv-action="choose-receive"]').count(),0);
  await page.locator('.inv-item').first().click();assert.equal(await page.locator('#inv-dialog-submit').count(),0);
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{currentUserAccess.active=false;LuminInventory.invalidate();});assert.equal(await page.locator('#view-inventory').textContent(),'');
  assert.ok(requests.some(r=>r.name==='inventory_write'&&r.args.p_operation==='import'));assert.deepEqual(errors,[]);
});
