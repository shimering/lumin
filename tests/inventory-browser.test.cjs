const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright'),{PGlite}=require('@electric-sql/pglite');
const model=require('../lumin-inventory-model.js'),root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
function source(name){const start=html.search(new RegExp('    (?:async )?function '+name+'\\('));assert.ok(start>=0,name);return html.slice(start,html.indexOf('\n    }',start)+6);}
test('inventory page retains category context, direct stock edits, management deletion, photos, permissions, mobile and RTL',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(fs.readFileSync(path.join(__dirname,'fixtures/inventory.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261016203800_clinic_inventory.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261016213858_simplify_inventory_items.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261017061336_retire_inventory_minimum_steps.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261017063353_bilingual_inventory_names.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261017073421_inventory_category_hierarchy.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261017075131_inventory_item_images.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261017144330_inventory_organization.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261017162033_retire_inventory_movements.sql'),'utf8'));
  let queue=Promise.resolve();const requests=[];
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||'chrome'});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'});page.setDefaultTimeout(7000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const photoFiles=new Map(),photoWrites=[];let dropPhotoReply=false,photoReads=0;
  await page.route('https://inventory.test/functions/v1/inventory-images/**',async route=>{
    const request=route.request(),url=new URL(request.url()),itemId=url.pathname.split('/').at(-1),method=request.method();
    const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, content-type','Access-Control-Allow-Methods':'GET, POST, DELETE, OPTIONS'};
    if(method==='OPTIONS')return route.fulfill({status:204,headers});
    const result=await (queue=queue.then(async()=>{
      await db.exec('reset role');
      const old=(await db.query('select * from public.inventory_item_images where item_id=$1',[itemId])).rows[0];
      if(method==='GET'){photoReads++;return old&&url.searchParams.get('v')===old.revision?{status:200,headers:{...headers,'Content-Type':old.mime_type},body:photoFiles.get(old.revision)}:{status:404,body:JSON.stringify({code:'image_changed'})};}
      if(method==='DELETE'){await db.query('delete from public.inventory_item_images where item_id=$1',[itemId]);return{status:200,body:JSON.stringify({image_version:null,image_mime:null,image_width:null,image_height:null,image_bytes:null})};}
      const form=await new Request(url,{method:'POST',headers:request.headers(),body:request.postDataBuffer()}).formData(),file=form.get('image'),version=form.get('version'),expected=form.get('expected');
      if(old?.revision!==version&&(old?.revision||'')!==expected)return{status:409,body:JSON.stringify({code:'image_changed'})};
      const bytes=Buffer.from(await file.arrayBuffer());photoWrites.push({version,expected,size:bytes.length,type:file.type});
      if(old?.revision!==version)await db.query("insert into public.inventory_item_images(item_id,revision,drive_file_id,sha256,mime_type,byte_size,width,height,updated_by) values($1,$2,'mock-private-drive',repeat('a',64),$3,$4,960,640,$5) on conflict(item_id) do update set revision=excluded.revision,mime_type=excluded.mime_type,byte_size=excluded.byte_size",[itemId,version,file.type,bytes.length,uuid(1)]);
      photoFiles.set(version,bytes);return{status:200,body:JSON.stringify({image_version:version,image_mime:file.type,image_width:960,image_height:640,image_bytes:bytes.length})};
    }));
    if(dropPhotoReply&&method==='POST'&&result.status===200){dropPhotoReply=false;return route.abort('failed');}
    await route.fulfill({...result,headers:{...headers,...result.headers}});
  });
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
    const SUPABASE_URL='https://inventory.test';let db={auth:{getSession:async()=>({data:{session:{access_token:currentSession.user.id}}})},rpc:async(name,args)=>{if(name==='get_inventory'&&window.holdInventoryReads)await new Promise(resolve=>(window.inventoryReadWaiters||=[]).push(resolve));if(name==='inventory_write'&&['receive','use'].includes(args.p_operation)&&window.holdStockWrites)await new Promise(resolve=>(window.stockWriteWaiters||=[]).push(resolve));const result=await window.fixtureRPC(name,args,currentSession.user.id);if(name==='get_inventory'&&window.holdInventoryReplies)await new Promise(resolve=>(window.inventoryReplyWaiters||=[]).push(resolve));if(name==='inventory_write'&&!result.error&&window.simulateInventoryRealtime)window.LuminInventory.invalidate();if(name==='inventory_write'&&!result.error&&window.dropOrganizationReply&&['assign','item_delete'].includes(args.p_operation)){window.dropOrganizationReply=false;return{error:{message:'Organization response lost after commit'}};}if(name==='inventory_write'&&!result.error&&window.dropReceiptReply&&args.p_operation==='receive'){window.dropReceiptReply=false;return{error:{message:'Response lost after commit'}};}return result;}};
    function firstAuthorizedView(){return 'clinic-management'}
    function hrClinicDateValue(){return '2026-10-16'}
    async function switchFinanceTab(){}async function refreshActiveAnalyticsTab(){}async function refreshHrDirectory(){}async function ensureDentalCustomizationLoaded(){}
    ${source('hasPageAccess')}${source('firstAuthorizedClinicManagementTab')}${source('switchClinicManagementTab')}
    document.getElementById('auth-gate').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');document.querySelectorAll('main>section').forEach(node=>node.classList.add('hidden'));document.getElementById('view-clinic-management').classList.remove('hidden');
  `});
  for(const file of ['lumin-inventory-model.js','lumin-inventory-images.js','lumin-inventory.js'])await page.addScriptTag({path:path.join(root,file)});
  await page.evaluate(async()=>{LuminInventory.init();await switchClinicManagementTab('inventory')});
  assert.equal(await page.locator('#view-inventory').isVisible(),true);
  assert.match(await page.locator('#view-inventory').textContent(),/Your inventory starts here/);
  const csv=process.env.LUMIN_INVENTORY_CSV?fs.readFileSync(process.env.LUMIN_INVENTORY_CSV,'utf8'):'التصنيف,الصنف,الكمية الحالية,الحد الأدنى,الوحدة,,Reference\nConsumables (مستهلكات يومية),Anasthesia (Blue),2,3,Box,,\nConsumables (مستهلكات يومية),Cotton pack,,,pack,,\nConsumables (مستهلكات يومية),Napkin,8,235,,,\nConsumables (مستهلكات يومية),Gloves,0,1,Box,,\n';
  const expected=model.parseCSV(csv);
  assert.equal(await page.locator('[data-inv-action="import"],.inv-content>.inv-tabs').count(),0,'Import and stock/movements/export bar are removed');
  const fixtureRows=model.parseCSV(csv,(await db.query('select * from public.inventory_categories')).rows);
  await page.evaluate(async rows=>{const result=await fixtureRPC('inventory_write',{p_operation:'import',p_payload:{rows},p_request_id:'00000000-0000-4000-8000-000000009990'},currentSession.user.id);if(result.error)throw Error(result.error.message);await LuminInventory.refresh({force:true});},fixtureRows);
  await page.waitForFunction(n=>document.querySelector('[data-inv-stat="total"] strong')?.textContent===String(n),expected.length);
  assert.equal(await page.locator('.inv-table tbody tr').count(),expected.length);
  assert.equal(await page.locator('#inv-sort').inputValue(),'name','Name is the default sort');
  assert.equal(await page.locator('.inv-mobile-actions').count(),0,'The floating mobile bar is removed');
  const categories=await db.query('select id,key from public.inventory_categories');
  const consumables=categories.rows.find(c=>c.key==='consumables').id,anesthesia=categories.rows.find(c=>c.key==='anaesthesia').id,surgical=categories.rows.find(c=>c.key==='surgical').id;
  const anesthesiaItem=(await db.query("select id from public.inventory_items where name='Anasthesia (Blue)'")).rows[0].id;
  const stockStep=operation=>page.locator(`#inv-stock-${operation}-${anesthesiaItem}`);
  const waitStock=async quantity=>{
    await page.waitForFunction(({id,quantity})=>{const node=document.getElementById('inv-stock-receive-'+id);return node&&!node.disabled&&node.parentElement.getAttribute('aria-busy')!=='true'&&node.parentElement.querySelector('.inv-number').textContent.replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632))===String(quantity);},{id:anesthesiaItem,quantity});
    assert.equal(Number((await db.query('select quantity from public.inventory_items where id=$1',[anesthesiaItem])).rows[0].quantity),quantity);
  };
  const firstQuickWrite=requests.length;
  await page.evaluate(id=>{window.dropReceiptReply=true;document.getElementById('inv-stock-receive-'+id).click();},anesthesiaItem);
  await page.waitForFunction(()=>document.querySelector('#view-inventory [data-inv-action="retry-stock"]')&&!document.querySelector('.inv-stock-stepper[aria-busy="true"]'));
  assert.equal(requests.slice(firstQuickWrite).filter(r=>r.name==='inventory_write').length,1,'An uncertain request posts once until explicitly retried');
  await page.evaluate(()=>LuminInventory.refresh({force:true}));
  await waitStock(3);
  await stockStep('receive').click();await waitStock(3);
  const retries=requests.slice(firstQuickWrite).filter(r=>r.name==='inventory_write');
  assert.equal(retries.length,2);assert.equal(retries[0].args.p_request_id,retries[1].args.p_request_id,'A lost reply reuses its request even after realtime refresh');
  assert.equal(await page.locator('#inventory-overlay').count(),0,'Stock buttons update without opening a dialog');
  await page.locator(`[data-inv-select="${anesthesiaItem}"]`).check();
  await stockStep('use').evaluate(node=>node.scrollIntoView({block:'center'}));
  await page.evaluate(id=>{
    window.simulateInventoryRealtime=true;
    const root=document.getElementById('view-inventory');window.stockRootChanges=0;
    window.stockObserver=new MutationObserver(records=>{window.stockRootChanges+=records.length;});window.stockObserver.observe(root,{childList:true});
    window.stockStableNodes={heading:root.querySelector('.inv-heading'),search:document.getElementById('inv-search'),row:root.querySelector('[data-inv-row="'+id+'"]'),button:document.getElementById('inv-stock-receive-'+id),number:document.getElementById('inv-stock-receive-'+id).parentElement.querySelector('.inv-number'),summary:root.querySelector('[data-inv-stat="out"] strong'),scroll:window.scrollY,top:document.getElementById('inv-stock-receive-'+id).getBoundingClientRect().top};
  },anesthesiaItem);
  for(const quantity of [2,1,0]){await stockStep('use').click();await waitStock(quantity);}
  assert.equal(await stockStep('use').isDisabled(),true,'Zero stock cannot be decreased');
  const expectedOut=(await db.query('select count(*)::int n from public.inventory_items where quantity=0')).rows[0].n;await page.waitForFunction(expected=>Number(document.querySelector('[data-inv-stat="out"] strong').textContent)===expected,expectedOut);
  assert.equal(Number(await page.locator('[data-inv-stat="out"] strong').textContent()),expectedOut,'Summary counts update in place');
  for(const quantity of [1,2]){await stockStep('receive').click();await waitStock(quantity);}
  const stable=await page.evaluate(()=>{const n=window.stockStableNodes;window.stockObserver.disconnect();window.simulateInventoryRealtime=false;return{changes:window.stockRootChanges,connected:[n.heading,n.search,n.row,n.button,n.number,n.summary].every(node=>node.isConnected),scroll:Math.abs(window.scrollY-n.scroll),top:Math.abs(n.button.getBoundingClientRect().top-n.top)};});
  assert.equal(stable.changes,0,'Stock clicks and their realtime events never replace the page shell');
  assert.equal(stable.connected,true,'Stock buttons, quantity, summaries and search keep their DOM nodes');
  assert.ok(stable.scroll<2&&stable.top<2,'Stock clicks preserve scroll and row position: '+JSON.stringify(stable));
  assert.equal(await page.locator(`[data-inv-select="${anesthesiaItem}"]`).isChecked(),true,'Stock changes preserve item selection');
  await page.locator('[data-inv-action="unselect"]').click();
  const concurrentItem=(await db.query('select revision from public.inventory_items where id=$1',[anesthesiaItem])).rows[0];
  await page.evaluate(async({id,revision,request})=>{const result=await window.fixtureRPC('inventory_write',{p_operation:'use',p_payload:{id,revision,quantity:1},p_request_id:request},currentSession.user.id);if(result.error)throw Error(result.error.message);},{id:anesthesiaItem,revision:concurrentItem.revision,request:uuid(9000)});
  await stockStep('receive').click();await waitStock(1);
  assert.match(await page.locator('#view-inventory [role="alert"]').textContent(),/record changed/);
  assert.equal(await page.locator('[data-inv-action="retry-stock"]').count(),0,'Stale stock requires a fresh click, never automatic replay');
  await stockStep('receive').click();await waitStock(2);
  assert.equal(await page.locator('.inv-minimum-stepper').count(),0,'Minimum is a plain value');
  await page.locator(`[data-inv-category="${anesthesia}"]`).click();
  await page.waitForFunction(()=>!document.querySelector('#view-inventory [aria-busy="true"]'));
  assert.ok(await page.locator('.inv-table tbody tr').count()>=1);
  await page.locator(`[data-inv-item="${anesthesiaItem}"]`).first().click();
  assert.equal(await page.locator('#inventory-overlay [name="sku"],#inventory-overlay [name="location"],#inventory-overlay [name="supplier"],#inventory-overlay [name="review_note"],#inventory-overlay [name="notes"],.inv-detail-actions,.inv-detail-source').count(),0,'Removed fields and sections are absent');
  assert.equal(await page.locator('[data-inv-action^="minimum-input-"]').count(),0);
  await page.locator('#inventory-overlay [name="minimum"]').fill('4');
  assert.equal(await page.locator('#inventory-overlay [name="name_en"]').inputValue(),'Anasthesia (Blue)');
  assert.equal(await page.locator('#inventory-overlay [name="name_ar"]').getAttribute('dir'),'rtl');
  await page.locator('#inventory-overlay [name="name_ar"]').fill('مخدر أزرق');
  const unitSelect=page.locator('#inventory-overlay select[name="unit"]');
  assert.equal(await unitSelect.count(),1);assert.equal(await unitSelect.isDisabled(),true,'A counted stock unit stays locked');
  assert.equal(await unitSelect.inputValue(),'Box');assert.equal(await unitSelect.locator('option[value="Bottle"]').count(),1);
  assert.equal(Number((await db.query('select minimum from public.inventory_items where id=$1',[anesthesiaItem])).rows[0].minimum),3,'Minimum edits wait for Save');
  if(process.env.LUMIN_INVENTORY_SCREENSHOTS)await page.locator('.inv-dialog').screenshot({path:path.join(process.env.LUMIN_INVENTORY_SCREENSHOTS,'inventory-item-details-en.png')});
  await page.locator('#inventory-overlay select[name="category_id"]').selectOption(surgical);
  await page.locator('#inv-dialog-submit').click();
  await page.waitForFunction(()=>!document.getElementById('inventory-overlay'));
  assert.equal(Number((await db.query('select quantity from public.inventory_items where id=$1',[anesthesiaItem])).rows[0].quantity),2);
  assert.equal(Number((await db.query('select minimum from public.inventory_items where id=$1',[anesthesiaItem])).rows[0].minimum),4);
  await page.locator('[data-inv-category="all"]').click();
  await page.locator('#inv-search').fill('مخدر أزرق');
  await page.waitForFunction(()=>document.querySelectorAll('.inv-table tbody tr').length===1);
  await page.evaluate(async()=>{currentUiLanguage='ar';document.documentElement.dir='rtl';await LuminInventory.languageChanged();});
  assert.equal(await page.locator('.inv-item').textContent(),'مخدر أزرق');
  await page.locator('.inv-item').click();
  assert.equal(await page.locator('#inventory-overlay [name="name_en"]').inputValue(),'Anasthesia (Blue)');
  assert.equal(await page.locator('#inventory-overlay [name="name_ar"]').inputValue(),'مخدر أزرق');
  await page.keyboard.press('Escape');
  await page.evaluate(async()=>{currentUiLanguage='en';document.documentElement.dir='ltr';await LuminInventory.languageChanged();});
  assert.equal(await page.locator('.inv-item').textContent(),'Anasthesia (Blue)');
  await page.locator('#inv-search').fill('Anasthesia');
  await page.waitForFunction(()=>document.querySelectorAll('.inv-table tbody tr').length===1);
  await page.locator('[data-inv-action="choose-receive"]:visible').first().click();
  await page.locator('#inv-picker-search').fill('مخدر أزرق');
  await page.locator('#inv-picker-results strong').filter({hasText:'Anasthesia (Blue)'}).waitFor();
  assert.equal(await page.locator('#inv-picker-results [data-inv-action="movement-item"]').count(),0,'Receive picker has no item-details action');
  await page.locator(`[data-inv-action="receive-picked"][data-id="${anesthesiaItem}"]`).click();
  assert.equal(await page.locator('#inventory-overlay [name="reference"],#inventory-overlay [name="reason"],#inventory-overlay [name="date"]').count(),0,'Receive form only needs quantity');
  await page.locator('#inventory-overlay [name="quantity"]').fill('2');
  await page.evaluate(()=>{window.dropReceiptReply=true;});
  await page.locator('#inv-dialog-submit').click();
  await page.waitForFunction(()=>document.getElementById('inv-dialog-error')?.hidden===false);
  await page.locator('#inv-dialog-submit').click();
  await page.waitForFunction(()=>!document.getElementById('inventory-overlay'));
  assert.equal(Number((await db.query('select quantity from public.inventory_items where id=$1',[anesthesiaItem])).rows[0].quantity),4);
  for(const quantity of [3,2,1]){await stockStep('use').click();await waitStock(quantity);}
  assert.equal(Number((await db.query('select quantity from public.inventory_items where id=$1',[anesthesiaItem])).rows[0].quantity),1);
  await page.locator('#inv-search').fill('Napkin');
  await page.waitForFunction(()=>document.querySelector('.inv-item')?.textContent==='Napkin');
  assert.equal(await page.locator('.inv-stock-stepper:not(.inv-minimum-stepper) button:enabled').count(),0,'Missing stock units cannot be inferred');
  await page.locator('#inv-search').fill('Cotton pack');
  await page.waitForFunction(()=>document.querySelector('.inv-item')?.textContent==='Cotton pack');
  assert.equal(await page.locator('.inv-stock-stepper:not(.inv-minimum-stepper) button:enabled').count(),0,'Unknown opening stock cannot be incremented or decremented');
  await page.locator('.inv-item').click();
  assert.equal(await page.locator('#inventory-overlay select[name="unit"]').inputValue(),'pack','Legacy unit spelling is preserved');
  await page.locator('#inventory-overlay select[name="unit"]').selectOption('Bottle');
  await page.locator('#inventory-overlay [name="quantity"]').fill('10');
  await page.locator('#inv-dialog-submit').click();
  await page.waitForFunction(()=>!document.getElementById('inventory-overlay'));
  assert.equal(Number((await db.query("select quantity from public.inventory_items where name='Cotton pack'")).rows[0].quantity),10);
  await page.locator('[data-inv-action="categories"]:visible').first().click();
  assert.equal(await page.locator('.inv-management-tabs [role="tab"]').count(),2);
  assert.equal(await page.locator('#inv-manage-tab-categories').getAttribute('aria-selected'),'true');
  await page.locator('[data-inv-action="category-add"]').click();
  await page.locator('#inventory-overlay [name="name"]').fill('Restorative');
  await page.locator('#inventory-overlay [name="name_ar"]').fill('مواد ترميمية');
  await page.locator('#inv-dialog-submit').click();
  await page.locator('#inv-manage-tab-categories[aria-selected="true"]').waitFor();
  assert.ok((await page.locator('#inv-management-panel').textContent()).includes('Restorative'));
  const restorative=(await db.query("select id from public.inventory_categories where name='Restorative'")).rows[0].id;
  let parentCategory=restorative;
  for(const name of ['Composites','Ivoclar']){
    await page.locator('[data-inv-action="category-add"]').click();await page.locator('#inventory-overlay [name="name"]').fill(name);await page.locator('#inventory-overlay [name="parent_id"]').selectOption(parentCategory);await page.locator('#inv-dialog-submit').click();await page.locator('#inv-manage-tab-categories[aria-selected="true"]').waitFor();parentCategory=(await db.query('select id from public.inventory_categories where name=$1',[name])).rows[0].id;
  }
  await page.locator('[data-inv-action="category-add"]').click();assert.equal(await page.locator(`#inventory-overlay [name="parent_id"] option[value="${parentCategory}"]`).count(),0,'Final-level categories cannot be chosen as parents');await page.keyboard.press('Escape');await page.locator('#inv-manage-tab-categories').waitFor();
  assert.ok((await page.locator('#inv-management-panel').textContent()).includes('Restorative / Composites / Ivoclar'));
  const renameTargets=(await db.query("select id,name,name_ar,parent_id from public.inventory_categories where id=$1 or name in ('Composites','Ivoclar')",[restorative])).rows;
  for(const category of renameTargets){
    const editCategory=()=>page.locator(`[data-inv-action="category-edit"][data-category="${category.id}"]`);
    await editCategory().click();await page.locator('#inventory-overlay [name="name"]').fill('Renamed '+category.name);await page.locator('#inventory-overlay [name="name_ar"]').fill('اسم تصنيف معدل');await page.locator('#inv-dialog-submit').click();
    await page.waitForFunction(()=>document.getElementById('inv-manage-tab-categories')||!document.getElementById('inv-dialog-error')?.hidden);
    assert.equal(await page.locator('#inv-dialog-error:not([hidden])').count(),0,'Renaming succeeds at every category level');await page.locator('#inv-manage-tab-categories').waitFor();
    const renamed=(await db.query('select name,name_ar,parent_id from public.inventory_categories where id=$1',[category.id])).rows[0];
    assert.deepEqual(renamed,{name:'Renamed '+category.name,name_ar:'اسم تصنيف معدل',parent_id:category.parent_id},'Both names update while the existing parent remains unchanged');
    const renameRequest=requests.filter(r=>r.name==='inventory_write'&&r.args.p_operation==='category_save').at(-1);
    assert.equal(Object.hasOwn(renameRequest.args.p_payload,'parent_id'),false,'Rename never submits a parent change');
    await editCategory().click();await page.locator('#inventory-overlay [name="name"]').fill(category.name);await page.locator('#inventory-overlay [name="name_ar"]').fill(category.name_ar);await page.locator('#inv-dialog-submit').click();await page.locator('#inv-manage-tab-categories').waitFor();
  }
  await page.locator('#inv-manage-tab-items').click();
  await page.locator('#inv-management-search').fill('مخدر أزرق');
  await page.waitForFunction(()=>document.querySelectorAll('.inv-managed-item').length===1);
  assert.equal(await page.locator('.inv-managed-item strong').textContent(),'Anasthesia (Blue)');
  await page.locator('[data-inv-action="managed-edit"]').click();
  await page.locator('#inventory-overlay [name="minimum"]').fill('6');
  await page.locator('#inv-dialog-submit').click();
  await page.locator('#inv-management-search').waitFor();
  assert.equal(await page.locator('#inv-management-search').inputValue(),'مخدر أزرق','Editing returns to the same Items search');
  assert.equal(Number((await db.query('select minimum from public.inventory_items where id=$1',[anesthesiaItem])).rows[0].minimum),6);
  await page.waitForFunction(()=>document.querySelectorAll('.inv-managed-item').length===1);
  await page.locator('[data-inv-action="managed-edit"]').click();await page.keyboard.press('Escape');
  await page.locator('#inv-management-search').waitFor();
  await page.locator('#inv-manage-tab-items').focus();await page.keyboard.press('Home');
  assert.equal(await page.locator('#inv-manage-tab-categories').getAttribute('aria-selected'),'true');
  await page.keyboard.press('End');assert.equal(await page.locator('#inv-manage-tab-items').getAttribute('aria-selected'),'true');
  await page.keyboard.press('Escape');
  await page.locator('[data-inv-action="clear"]').count().then(async count=>{if(count)await page.locator('[data-inv-action="clear"]').first().click();else await page.locator('#inv-search').fill('');});
  await page.waitForFunction(()=>document.querySelectorAll('.inv-table tbody tr').length>1);
  await page.locator('[data-inv-action="categories"]:visible').first().click();
  await page.locator('#inv-manage-tab-items').click();
  await page.locator('#inv-management-search').fill('');
  await page.locator('[data-inv-action="managed-add"]').click();
  await page.locator('#inventory-overlay [name="name_en"]').fill('Long clinical supply name for checking mobile cards');
  await page.locator('#inventory-overlay [name="name_ar"]').fill('اسم طويل لمستلزمات العيادة للتأكد من عرض الأصناف على الهاتف');
  await page.locator('#inventory-overlay [name="unit"]').selectOption('Bottle');
  await page.locator('#inventory-overlay [name="minimum"]').fill('2');
  await page.locator('#inv-dialog-submit').click();
  await page.locator('#inv-management-search').waitFor();await page.keyboard.press('Escape');
  const photo=page.locator(`[data-inv-row="${anesthesiaItem}"] [data-inv-photo]`);
  const sourcePhoto=Buffer.from((await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=2400;canvas.height=1600;const ctx=canvas.getContext('2d'),gradient=ctx.createLinearGradient(0,0,2400,1600);gradient.addColorStop(0,'#e0f2fe');gradient.addColorStop(1,'#1d4ed8');ctx.fillStyle=gradient;ctx.fillRect(0,0,2400,1600);return canvas.toDataURL('image/png').split(',')[1];})),'base64');
  const upload=async node=>{const chooser=page.waitForEvent('filechooser');await node.click();await(await chooser).setFiles({name:'clinic-item.png',mimeType:'image/png',buffer:sourcePhoto});};
  await photo.evaluate(node=>{node.scrollIntoView({block:'center'});window.photoRow=node.closest('tr');window.photoStockButton=window.photoRow.querySelector('.inv-stock-receive');});
  dropPhotoReply=true;await upload(photo.locator('[data-inv-photo-action="choose"]'));
  await photo.locator('[data-inv-photo-action="retry"]').waitFor();
  await photo.locator('[data-inv-photo-action="retry"]').click();await photo.locator('img').waitFor();
  assert.equal(photoWrites.length,2);assert.equal(photoWrites[0].version,photoWrites[1].version,'Lost photo replies reuse the upload identifier');
  assert.equal(await photo.locator('.inv-photo-actions [data-inv-photo-action="choose"] span').count(),0,'Change image is an icon-only control');assert.equal(await photo.locator('.inv-photo-actions [data-inv-photo-action="choose"]').getAttribute('aria-label'),'Change image');
  assert.equal(photoWrites[0].type,'image/webp');assert.ok(photoWrites[0].size<=307200&&photoWrites[0].size<sourcePhoto.length,'Uploads are compressed before transmission');
  assert.deepEqual(await photo.locator('img').evaluate(node=>({width:node.naturalWidth,height:node.naturalHeight})),{width:960,height:640});
  const photoLayout=await photo.evaluate(node=>{const frame=node.getBoundingClientRect(),row=node.closest('tr').getBoundingClientRect(),name=node.closest('tr').cells[1].getBoundingClientRect();return{width:Math.abs(frame.width-row.width),above:frame.bottom<=name.top+1,stable:window.photoRow.isConnected&&window.photoStockButton.isConnected};});
  assert.ok(photoLayout.width<3&&photoLayout.above&&photoLayout.stable,'Photo spans the card above its name without replacing stock controls');
  const uploadedSource=await photo.locator('img').getAttribute('src');await page.evaluate(async()=>{LuminInventoryImages.clear();await LuminInventory.refresh({force:true,background:true});});
  await page.waitForFunction(({id,source})=>{const image=document.querySelector(`[data-inv-photo="${id}"] img`);return image&&image.src!==source&&image.naturalWidth===960;},{id:anesthesiaItem,source:uploadedSource});assert.equal(photoReads,1,'Visible photos load privately after the memory cache is reset');
  if(process.env.LUMIN_INVENTORY_SCREENSHOTS)await photo.locator('..').locator('..').screenshot({path:path.join(process.env.LUMIN_INVENTORY_SCREENSHOTS,'inventory-photo-card-en.png')});
  await page.locator(`[data-inv-item="${anesthesiaItem}"]`).first().click();
  await page.locator('#inventory-overlay [name="name_en"]').fill('Unsaved photo edit');
  const detailPhoto=page.locator('#inventory-overlay [data-inv-photo]');await upload(detailPhoto.locator('[data-inv-photo-action="choose"]'));
  await page.waitForFunction(()=>document.querySelector('#inventory-overlay [data-inv-photo]')?.getAttribute('aria-busy')==='false');
  assert.equal(await page.locator('#inventory-overlay [name="name_en"]').inputValue(),'Unsaved photo edit','Replacing a photo preserves other unsaved fields');
  assert.equal(photoWrites.at(-1).expected,photoWrites[0].version);
  await detailPhoto.locator('[data-inv-photo-action="remove"]').click();await detailPhoto.locator('.inv-photo-add').waitFor();
  assert.equal((await db.query('select count(*)::int n from public.inventory_item_images')).rows[0].n,0);
  await page.keyboard.press('Escape');
  // Clipboard reads are mocked so these checks never read or change the user's clipboard.
  await page.evaluate(base64=>{
    window.clipboardPhoto=new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type:'image/png'});window.clipboardMode='image';window.clipboardReads=0;
    window.readClipboard=async()=>{window.clipboardReads++;if(window.clipboardMode==='denied')throw new DOMException('Denied','NotAllowedError');if(window.clipboardMode==='empty')return[{types:['text/plain']}];if(window.clipboardMode==='hold')await new Promise(resolve=>window.releaseClipboard=resolve);return[{types:['image/png'],getType:async()=>window.clipboardPhoto}];};
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read:window.readClipboard}});
  },sourcePhoto.toString('base64'));
  const beforePaste=photoWrites.length;
  await page.evaluate(()=>{window.clipboardMode='empty';});await photo.locator('[data-inv-photo-action="paste"]').click();
  assert.match(await photo.locator('.inv-photo-error').textContent(),/Copy an image first/);assert.equal(photoWrites.length,beforePaste);
  await page.evaluate(()=>{window.clipboardMode='denied';});await photo.locator('[data-inv-photo-action="paste"]').click();
  assert.match(await photo.locator('.inv-photo-error').textContent(),/Allow clipboard access/);assert.equal(photoWrites.length,beforePaste);
  await page.evaluate(()=>{navigator.clipboard.read=undefined;});await photo.locator('[data-inv-photo-action="paste"]').click();
  assert.match(await photo.locator('.inv-photo-error').textContent(),/Ctrl\+V/);assert.equal(photoWrites.length,beforePaste);
  await page.evaluate(()=>{navigator.clipboard.read=window.readClipboard;window.clipboardMode='image';});
  await photo.locator('[data-inv-photo-action="paste"]').click();await photo.locator('img').waitFor();
  await page.waitForFunction(id=>document.querySelector(`[data-inv-photo="${id}"]`)?.getAttribute('aria-busy')==='false',anesthesiaItem);
  assert.equal(photoWrites.length,beforePaste+1,'Paste image uses the private upload endpoint');assert.equal(photoWrites.at(-1).type,'image/webp');assert.ok(photoWrites.at(-1).size<=307200);
  assert.equal(await photo.locator('[data-inv-photo-action="paste"] span').count(),0,'Existing photos use a compact Paste image icon');
  assert.equal(await photo.evaluate(node=>node.contains(document.activeElement)),true,'Photo updates preserve keyboard focus');
  await page.locator(`[data-inv-item="${anesthesiaItem}"]`).first().click();await page.locator('#inventory-overlay [name="name_en"]').fill('Unsaved clipboard edit');
  const pasteEvent=async(node,type='image/png')=>node.evaluate((target,type)=>{const data=new DataTransfer();data.items.add(new File([window.clipboardPhoto],'clipboard.png',{type}));const event=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});target.dispatchEvent(event);return event.defaultPrevented;},type);
  assert.equal(await pasteEvent(page.locator('#inventory-overlay [name="name_en"]')),false,'Pasting into a text field never uploads a photo');
  assert.equal(photoWrites.length,beforePaste+1);
  await detailPhoto.focus();assert.equal(await pasteEvent(detailPhoto),true);
  await page.waitForFunction(()=>document.querySelector('#inventory-overlay [data-inv-photo]')?.getAttribute('aria-busy')==='false');
  assert.equal(photoWrites.length,beforePaste+2,'Keyboard paste replaces the focused item photo');assert.equal(photoWrites.at(-1).expected,photoWrites.at(-2).version);
  assert.equal(await page.locator('#inventory-overlay [name="name_en"]').inputValue(),'Unsaved clipboard edit');
  await detailPhoto.locator('[data-inv-photo-action="remove"]').click();await detailPhoto.locator('.inv-photo-add').waitFor();
  assert.equal(await pasteEvent(detailPhoto,'image/svg+xml'),true);assert.match(await detailPhoto.locator('.inv-photo-error').textContent(),/JPEG, PNG or WebP/);assert.equal(photoWrites.length,beforePaste+2,'Unsupported clipboard image types never leave the browser');
  await page.keyboard.press('Escape');
  // A clipboard permission/read response arriving after reset must never upload into the new session.
  await page.evaluate(()=>{window.clipboardMode='hold';});await photo.locator('[data-inv-photo-action="paste"]').click();
  await page.waitForFunction(()=>typeof window.releaseClipboard==='function');
  await page.evaluate(async()=>{LuminInventoryImages.clear();await LuminInventory.refresh({force:true,background:true});window.releaseClipboard();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  assert.equal(photoWrites.length,beforePaste+2);assert.equal(await photo.getAttribute('aria-busy'),'false');
  const composites=(await db.query("select id from public.inventory_categories where name='Composites'")).rows[0].id;
  for(const categoryId of [restorative,composites,parentCategory]){
    await page.locator(`[data-inv-category="${categoryId}"]`).click();
    await page.waitForFunction(()=>document.querySelector('#inv-stock-panel')?.getAttribute('aria-busy')==='false');
    await page.locator('[data-inv-action="add"]').first().click();
    assert.equal(await page.locator('#inventory-overlay [name="category_id"]').inputValue(),categoryId,'Header Add inherits the deepest active category');
    await page.keyboard.press('Escape');
    await page.locator('[data-inv-action="categories"]:visible').first().click();await page.locator('#inv-manage-tab-items').click();await page.locator('[data-inv-action="managed-add"]').click();
    assert.equal(await page.locator('#inventory-overlay [name="category_id"]').inputValue(),categoryId,'Managed Add inherits the same category path');
    await page.keyboard.press('Escape');await page.locator('#inv-management-search').waitFor();await page.keyboard.press('Escape');
  }
  await page.locator('[data-inv-action="add"]').first().click();await page.locator('#inventory-overlay [name="name_en"]').fill('Inherited category fixture');await page.locator('#inventory-overlay [name="unit"]').selectOption('Box');await page.locator('#inventory-overlay [name="minimum"]').fill('1');await page.locator('#inv-dialog-submit').click();await page.waitForFunction(()=>!document.getElementById('inventory-overlay'));
  const inheritedItem=(await db.query("select id,category_id from public.inventory_items where name_en='Inherited category fixture'")).rows[0];assert.equal(inheritedItem.category_id,parentCategory);
  await page.locator('[data-inv-action="categories"]:visible').first().click();await page.locator('#inv-manage-tab-items').click();await page.locator('#inv-management-search').fill('Inherited category fixture');await page.waitForFunction(()=>document.querySelectorAll('.inv-managed-item').length===1);
  await page.locator('[data-inv-action="managed-delete"]').click();await page.locator('.inv-delete-copy').waitFor();await page.keyboard.press('Escape');await page.locator('#inv-management-search').waitFor();assert.equal(await page.locator('#inv-management-search').inputValue(),'Inherited category fixture','Cancel Delete returns to the Items list with its search');
  await page.locator('[data-inv-action="managed-delete"]').click();await page.locator('#inv-dialog-submit').click();await page.locator('#inv-management-search').waitFor();await page.waitForFunction(()=>document.querySelectorAll('.inv-managed-item').length===0);
  assert.ok((await db.query('select deleted_at from public.inventory_items where id=$1',[inheritedItem.id])).rows[0].deleted_at,'Managed-list Delete removes the selected item');
  await page.locator('#inv-management-search').fill('');await page.keyboard.press('Escape');await page.locator('[data-inv-category="all"]').click();
  assert.equal(await page.locator('#inv-mobile-category option[value="'+surgical+'"]').count(),0,'Main dropdown contains only main categories');
  await page.locator('#inv-mobile-category').selectOption(restorative);await page.locator('#inv-subcategory option[value="'+parentCategory+'"]').waitFor({state:'attached'});
  assert.equal(await page.locator('#inv-subcategory option[value="'+parentCategory+'"]').textContent(),'Composites / Ivoclar','Second-level paths stay in the subcategory dropdown');
  await page.locator('#inv-subcategory').selectOption(parentCategory);await page.waitForFunction(()=>document.querySelector('.inv-empty'));
  await page.locator('#inv-mobile-category').selectOption('all');await stockStep('receive').waitFor();
  const categoryHandle=id=>page.locator('.inv-category-nav [data-inv-drag-kind="category"][data-id="'+id+'"]');
  const categoryTarget=id=>page.locator('.inv-category-nav [data-inv-drop-category="'+id+'"]');
  await categoryHandle(anesthesia).dragTo(categoryTarget(restorative));
  await page.waitForFunction(({id,parent})=>document.querySelector('.inv-category-nav [data-inv-drop-category="'+id+'"]')?.dataset.invParent===parent,{id:anesthesia,parent:restorative});
  assert.equal((await db.query('select parent_id from public.inventory_categories where id=$1',[anesthesia])).rows[0].parent_id,restorative,'Native category drag reparents its subtree');
  await waitStock(1);await categoryHandle(anesthesia).dragTo(categoryTarget(consumables));
  await page.waitForFunction(({id,parent})=>document.querySelector('.inv-category-nav [data-inv-drop-category="'+id+'"]')?.dataset.invParent===parent,{id:anesthesia,parent:consumables});await waitStock(1);
  const itemHandle=()=>page.locator('[data-inv-drag-kind="item"][data-id="'+anesthesiaItem+'"]');
  await page.evaluate(()=>{window.dropOrganizationReply=true;window.simulateInventoryRealtime=true;window.dragEvents=[];for(const name of ['dragstart','drop','dragend'])document.addEventListener(name,event=>window.dragEvents.push({name,target:event.target.outerHTML?.slice(0,180)}),true);window.moveHeading=document.querySelector('.inv-heading');window.moveStock=document.querySelector('.inv-stock-receive');});
  const firstMove=requests.length;await itemHandle().dragTo(categoryTarget(anesthesia));await page.locator('[data-inv-action="retry-move"]').waitFor().catch(async error=>{throw Error(error.message+' '+JSON.stringify({writes:requests.slice(firstMove),feedback:await page.locator('#inv-feedback').textContent(),events:await page.evaluate(()=>window.dragEvents)}));});await page.locator('[data-inv-action="retry-move"]').click();
  await page.waitForFunction(id=>document.querySelector('[data-inv-row="'+id+'"] td:nth-child(3)')?.textContent==='Anesthesia & needles',anesthesiaItem);await waitStock(1);
  const moveRequests=requests.slice(firstMove).filter(r=>r.name==='inventory_write'&&r.args.p_operation==='assign');assert.equal(moveRequests.length,2);assert.equal(moveRequests[0].args.p_request_id,moveRequests[1].args.p_request_id,'An uncertain drop retries its original request');
  assert.equal(await page.evaluate(()=>window.moveHeading.isConnected&&window.moveStock.isConnected),true,'Item moves retain the shell and stock controls');
  await page.evaluate(()=>{window.simulateInventoryRealtime=false;});
  await page.waitForTimeout(450);await itemHandle().click();await page.locator('#inventory-overlay [name="category_id"]').selectOption(surgical);await page.locator('#inv-dialog-submit').click();await page.waitForFunction(()=>!document.getElementById('inventory-overlay'));await waitStock(1);
  assert.equal((await db.query('select category_id from public.inventory_items where id=$1',[anesthesiaItem])).rows[0].category_id,surgical,'Move control provides the same action without dragging');
  // Delay responses to reproduce the visible refresh loops on a real connection.
  await page.evaluate(()=>{
    window.holdInventoryReads=true;window.inventoryReadWaiters=[];
    window.stableFilters={main:document.getElementById('inv-mobile-category'),sub:document.getElementById('inv-subcategory'),mainOption:document.querySelector('#inv-mobile-category option[value="all"]'),search:document.getElementById('inv-search'),sort:document.getElementById('inv-sort'),icon:document.querySelector('#view-inventory svg')};
    window.filterRootChanges=0;window.filterObserver=new MutationObserver(records=>window.filterRootChanges+=records.length);window.filterObserver.observe(document.getElementById('view-inventory'),{childList:true});
  });
  await page.locator('#inv-mobile-category').selectOption(restorative);await page.locator('#inv-subcategory').selectOption(parentCategory);
  await page.locator('#inv-mobile-category').selectOption(consumables);await page.locator('#inv-subcategory').selectOption(surgical);
  await page.evaluate(()=>{void LuminInventory.refresh({force:true});void LuminInventory.refresh({force:true});});
  assert.equal(await page.evaluate(()=>window.inventoryReadWaiters.length),4,'Identical in-flight filter reads are shared');
  await page.evaluate(()=>{window.holdInventoryReads=false;window.inventoryReadWaiters.splice(0).reverse().forEach(resolve=>resolve());});
  await page.waitForFunction(()=>document.querySelector('#inv-stock-panel')?.getAttribute('aria-busy')==='false');
  assert.equal(await page.locator('#inv-mobile-category').inputValue(),consumables);assert.equal(await page.locator('#inv-subcategory').inputValue(),surgical);
  assert.deepEqual(await page.evaluate(()=>{window.filterObserver.disconnect();return{same:Object.values(window.stableFilters).every(node=>node.isConnected),changes:window.filterRootChanges};}),{same:true,changes:0},'Out-of-order category responses preserve both dropdowns, options, icons and the page shell');
  await page.locator('#inv-mobile-category').selectOption('all');await waitStock(1);
  await page.evaluate(id=>{
    window.holdStockWrites=true;window.stockWriteWaiters=[];window.inventoryReadWaiters=[];document.body.classList.add('lumin-raised');
    const plus=document.getElementById('inv-stock-receive-'+id),minus=document.getElementById('inv-stock-use-'+id);
    window.burstNodes={plus,minus,icon:plus.querySelector('svg'),photoIcon:document.querySelector('[data-inv-row="'+id+'"] .inv-photo svg'),main:document.getElementById('inv-mobile-category')};
    window.burstStyle={opacity:getComputedStyle(plus).opacity,shadow:getComputedStyle(plus).boxShadow};window.burstValues=[];
    for(const operation of ['receive','receive','receive','use','use','use']){document.getElementById('inv-stock-'+operation+'-'+id).click();window.burstValues.push(plus.parentElement.querySelector('.inv-number').textContent);}
  },anesthesiaItem);
  assert.deepEqual(await page.evaluate(()=>window.burstValues),['2','3','4','3','2','1'],'Every rapid click updates the visible quantity immediately');
  assert.equal(await page.evaluate(()=>window.stockWriteWaiters.length),1,'Stock writes are serialized');
  assert.equal(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}),true,'Leaving the page warns while accepted stock clicks are still unsaved');
  assert.deepEqual(await page.evaluate(()=>({enabled:!burstNodes.plus.disabled&&!burstNodes.minus.disabled,same:Object.values(burstNodes).every(node=>node.isConnected),opacity:getComputedStyle(burstNodes.plus).opacity===burstStyle.opacity,shadow:getComputedStyle(burstNodes.plus).boxShadow===burstStyle.shadow})),{enabled:true,same:true,opacity:true,shadow:true},'In-flight stock changes do not dim, depress or replace controls and icons');
  const burstStart=requests.length;await page.evaluate(()=>{window.holdInventoryReads=true;window.holdStockWrites=false;window.stockWriteWaiters.splice(0).forEach(resolve=>resolve());});await waitStock(1);
  assert.equal(requests.slice(burstStart).filter(r=>r.name==='inventory_write').length,6,'Every accepted click is recorded once');
  await page.waitForFunction(()=>window.inventoryReadWaiters.length>0);
  assert.equal(await stockStep('receive').isEnabled(),true,'Reconciliation reads do not lock stock controls');
  await stockStep('receive').click();await waitStock(2);
  await page.evaluate(()=>{window.holdInventoryReads=false;window.inventoryReadWaiters.splice(0).forEach(resolve=>resolve());});
  await stockStep('use').click();await waitStock(1);
  assert.equal(await page.evaluate(()=>Object.values(burstNodes).every(node=>node.isConnected)),true,'Delayed read replies keep the same stock, photo and dropdown nodes');await page.evaluate(()=>document.body.classList.remove('lumin-raised'));
  const uncertainStart=requests.length;
  await page.evaluate(id=>{window.holdStockWrites=true;window.stockWriteWaiters=[];window.dropReceiptReply=true;const button=document.getElementById('inv-stock-receive-'+id);button.click();button.click();},anesthesiaItem);
  await page.evaluate(()=>{window.holdStockWrites=false;window.stockWriteWaiters.splice(0).forEach(resolve=>resolve());});await page.locator('[data-inv-action="retry-stock"]').waitFor();
  assert.equal(Number((await db.query('select quantity from public.inventory_items where id=$1',[anesthesiaItem])).rows[0].quantity),2,'A lost reply stops the remaining queue until confirmation');
  await page.locator('[data-inv-action="retry-stock"]').click();await waitStock(3);
  const uncertainWrites=requests.slice(uncertainStart).filter(r=>r.name==='inventory_write');assert.equal(uncertainWrites.length,3);assert.equal(uncertainWrites[0].args.p_request_id,uncertainWrites[1].args.p_request_id);assert.notEqual(uncertainWrites[1].args.p_request_id,uncertainWrites[2].args.p_request_id,'Only the unsent second click gets a new request');
  await page.evaluate(id=>{document.getElementById('inv-stock-use-'+id).click();document.getElementById('inv-stock-use-'+id).click();},anesthesiaItem);await waitStock(1);
  const beforeConflict=(await db.query('select revision from public.inventory_items where id=$1',[anesthesiaItem])).rows[0];
  await page.evaluate(async({id,revision,request})=>{const result=await window.fixtureRPC('inventory_write',{p_operation:'receive',p_payload:{id,revision,quantity:1},p_request_id:request},currentSession.user.id);if(result.error)throw Error(result.error.message);},{id:anesthesiaItem,revision:beforeConflict.revision,request:uuid(9001)});
  const conflictStart=requests.length;await page.evaluate(id=>{window.holdStockWrites=true;window.stockWriteWaiters=[];const plus=document.getElementById('inv-stock-receive-'+id);plus.click();plus.click();plus.click();window.holdStockWrites=false;window.stockWriteWaiters.splice(0).forEach(resolve=>resolve());},anesthesiaItem);await waitStock(2);
  assert.equal(requests.slice(conflictStart).filter(r=>r.name==='inventory_write').length,1,'A stale revision cancels unsent clicks instead of rebasing them onto another user’s change');assert.match(await page.locator('#view-inventory [role="alert"]').textContent(),/record changed/);
  await stockStep('use').click();await waitStock(1);
  assert.equal(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}),false,'Confirmed stock changes do not block navigation');
  await page.evaluate(()=>{window.holdInventoryReplies=true;window.inventoryReplyWaiters=[];void LuminInventory.refresh({force:true});});await page.waitForFunction(()=>window.inventoryReplyWaiters.length===1);
  const realtimeBase=(await db.query('select revision from public.inventory_items where id=$1',[anesthesiaItem])).rows[0];
  await page.evaluate(async({id,revision,request})=>{await window.fixtureRPC('inventory_write',{p_operation:'receive',p_payload:{id,revision,quantity:1},p_request_id:request},currentSession.user.id);window.holdInventoryReplies=false;LuminInventory.invalidate();},{id:anesthesiaItem,revision:realtimeBase.revision,request:uuid(9002)});
  await waitStock(2);await page.evaluate(()=>window.inventoryReplyWaiters.splice(0).forEach(resolve=>resolve()));
  assert.equal(await stockStep('receive').locator('..').locator('.inv-number').textContent(),'2','An older read cannot undo a newer realtime update');
  await stockStep('use').click();await waitStock(1);
  for(const language of ['en','ar'])for(const width of [320,390,480,820,1024,1440]){
    await page.setViewportSize({width,height:1100});
    await page.evaluate(async lang=>{currentUiLanguage=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';await LuminInventory.languageChanged();},language);
    const overflow=await page.locator('#view-inventory').evaluate(node=>node.scrollWidth>node.clientWidth+1);assert.equal(overflow,false,`${language} ${width}`);
    const controls=await page.locator('#view-inventory button:visible').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect()).filter(r=>r.width<43||r.height<43));assert.equal(controls.length,0,`Touch sizes ${language} ${width}`);
    const overlappingHandles=await page.locator('.inv-category-movable:visible').evaluateAll(nodes=>nodes.filter(node=>{const [handle,category]=[...node.children].map(child=>child.getBoundingClientRect());return Math.min(handle.right,category.right)-Math.max(handle.left,category.left)>1;}).length);assert.equal(overlappingHandles,0,'Move handles keep their own touch targets');
    const brokenSteppers=await page.locator('.inv-stock-stepper').evaluateAll(nodes=>nodes.filter(node=>{const [minus,value,plus]=[...node.children].map(child=>child.getBoundingClientRect()),cell=node.closest('td').getBoundingClientRect();return minus.left>=value.left||value.right>plus.left+1||plus.right>cell.right+1||minus.left<cell.left-1;}).length);assert.equal(brokenSteppers,0,`Stock buttons surround the quantity within its cell: ${language} ${width}`);
    if(width===480){
      await page.locator('[data-inv-action="categories"]:visible').first().click();
      await page.locator('#inv-manage-tab-categories').click();
      if(process.env.LUMIN_INVENTORY_SCREENSHOTS)await page.locator('.inv-dialog').screenshot({path:path.join(process.env.LUMIN_INVENTORY_SCREENSHOTS,'inventory-manage-categories-'+language+'.png')});
      await page.locator('#inv-manage-tab-items').click();
      await page.waitForFunction(()=>document.querySelectorAll('.inv-managed-item').length>0);
      assert.equal(await page.locator('.inv-dialog-body').evaluate(node=>node.scrollWidth>node.clientWidth+1),false,'Management dialog fits on mobile');
      if(process.env.LUMIN_INVENTORY_SCREENSHOTS)await page.locator('.inv-dialog').screenshot({path:path.join(process.env.LUMIN_INVENTORY_SCREENSHOTS,'inventory-manage-items-'+language+'.png')});
      await page.keyboard.press('Escape');
      await stockStep('receive').evaluate(node=>node.scrollIntoView({block:'center'}));
      const before=await stockStep('receive').boundingBox(),scroll=await page.evaluate(()=>window.scrollY);
      const button=await stockStep('receive').elementHandle();
      await stockStep('receive').click();await waitStock(2);await stockStep('use').click();await waitStock(1);
      const after=await stockStep('receive').boundingBox();
      assert.equal(await button.evaluate(node=>node.isConnected),true,'Mobile stock button is retained: '+language);
      assert.ok(Math.abs(before.y-after.y)<2&&Math.abs((await page.evaluate(()=>window.scrollY))-scroll)<2,'Mobile stock changes preserve position: '+language);
    }
    if(width<768){
      const brokenCards=await page.locator('.inv-table tbody tr').evaluateAll(rows=>rows.filter(row=>{
        const [,name,category,stock,minimum]=[...row.cells].map(cell=>cell.getBoundingClientRect());
        return Math.abs((name.top+name.bottom)/2-(category.top+category.bottom)/2)>2||Math.abs(stock.top-minimum.top)>2;
      }).length);assert.equal(brokenCards,0,'Mobile name/category and stock/minimum share rows: '+language+' '+width);
      const misplacedMeta=await page.locator('.inv-stock-line').evaluateAll(nodes=>nodes.filter(node=>{
        const [stock,meta]=[...node.children].map(child=>child.getBoundingClientRect());
        return Math.abs((stock.top+stock.bottom)/2-(meta.top+meta.bottom)/2)>2;
      }).length);assert.equal(misplacedMeta,0,'Unit and status sit beside stock controls: '+language+' '+width);
      if(process.env.LUMIN_INVENTORY_SCREENSHOTS&&width===480){const card=page.locator('.inv-table tbody tr').first();await card.evaluate(node=>node.scrollIntoView({block:'start'}));await card.screenshot({path:path.join(process.env.LUMIN_INVENTORY_SCREENSHOTS,'inventory-mobile-card-'+language+'.png')});}
    }
    if(width<1024){assert.equal(await page.locator('#inv-mobile-category').isVisible(),true);await page.locator('#inv-mobile-category').selectOption(consumables);await page.waitForFunction(()=>!document.querySelector('#view-inventory [aria-busy="true"]'));await page.locator('#inv-subcategory').selectOption(surgical);await page.waitForFunction(()=>!document.querySelector('#view-inventory [aria-busy="true"]'));await page.locator('#inv-mobile-category').selectOption('all');await page.waitForFunction(()=>!document.querySelector('#view-inventory [aria-busy="true"]'));}
    if(process.env.LUMIN_INVENTORY_SCREENSHOTS&&((language==='en'&&width===1440)||(language==='ar'&&width===390))){fs.mkdirSync(process.env.LUMIN_INVENTORY_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.LUMIN_INVENTORY_SCREENSHOTS,`inventory-${language}-${width}.png`),fullPage:width>=768});}
  }
  await page.setViewportSize({width:390,height:900});
  assert.equal(await page.locator('.inv-heading [data-inv-action="choose-receive"]').isVisible(),true,'Receive stays available in the heading');
  await page.locator('[data-inv-action="categories"]:visible').first().click();
  await page.locator('#inv-manage-tab-items').click();
  await page.locator('[data-inv-action="managed-add"]').click();
  assert.equal(await page.locator('.inv-dialog').evaluate(node=>Math.abs(node.getBoundingClientRect().bottom-window.innerHeight)<2),true,'Mobile dialog is a bottom sheet');
  await page.keyboard.press('Escape');await page.locator('#inv-management-search').waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('#inventory-overlay').count(),0);
  await page.evaluate(async()=>{currentUiLanguage='en';document.documentElement.dir='ltr';await LuminInventory.languageChanged();});
  await page.locator('[data-inv-action="categories"]:visible').first().click();await page.locator('#inv-manage-tab-items').click();await page.locator('[data-inv-action="managed-add"]').click();
  await page.locator('#inventory-overlay [name="name_en"]').fill('Delete browser fixture');await page.locator('#inventory-overlay [name="unit"]').selectOption('Box');await page.locator('#inventory-overlay [name="minimum"]').fill('1');await page.locator('#inventory-overlay [name="quantity"]').fill('2');await page.locator('#inv-dialog-submit').click();await page.locator('#inv-management-search').waitFor();await page.keyboard.press('Escape');
  await page.locator('#inv-search').fill('Delete browser fixture');await page.waitForFunction(()=>document.querySelectorAll('.inv-item').length===1);await page.locator('.inv-item').click();
  await page.locator('#inventory-overlay [name="name_en"]').fill('Unsaved name before deletion');await page.locator('[data-inv-action="delete-item"]').click();assert.match(await page.locator('.inv-delete-copy').textContent(),/Remove this item/);await page.keyboard.press('Escape');assert.equal(await page.locator('#inventory-overlay [name="name_en"]').inputValue(),'Unsaved name before deletion','Cancel preserves the detail draft');
  const deleteId=(await db.query("select id from public.inventory_items where name_en='Delete browser fixture'")).rows[0].id;
  await page.locator('[data-inv-action="delete-item"]').click();await page.evaluate(()=>{window.dropOrganizationReply=true;});await page.locator('#inv-dialog-submit').click();await page.locator('#inv-dialog-error:not([hidden])').waitFor();await page.locator('#inv-dialog-submit').click();await page.waitForFunction(()=>!document.getElementById('inventory-overlay'));
  assert.ok((await db.query('select deleted_at from public.inventory_items where id=$1',[deleteId])).rows[0].deleted_at);assert.equal((await db.query("select to_regclass('public.inventory_movements') name")).rows[0].name,null);
  await page.locator('#inv-search').fill('');await stockStep('receive').waitFor();
  await page.evaluate(async()=>{currentSession={user:{id:'00000000-0000-4000-8000-000000000002'}};currentUserAccess={active:true,isAdmin:false,permissions:new Set(['inventory'])};LuminInventory.reset();await switchClinicManagementTab('overview');});
  assert.equal(await page.locator('#clinic-management-tab-inventory').getAttribute('aria-selected'),'true','Inventory-only staff land on their authorized tab');
  assert.equal(await page.locator('#clinic-management-tab-overview').isVisible(),false);
  assert.equal(await page.locator('#view-inventory [data-inv-action="add"]').count(),0);
  assert.equal(await page.locator('#view-inventory [data-inv-action="choose-receive"]').count(),0);
  assert.equal(await page.locator('.inv-stock-step:enabled').count(),0,'Read-only staff cannot use stock buttons');
  assert.equal(await page.locator('[data-inv-drag-kind]').count(),0,'Read-only staff cannot move inventory');
  assert.equal(await page.locator('[data-inv-photo-action="choose"]').count(),0,'Read-only staff cannot upload photos');
  assert.equal(await page.locator('[data-inv-photo-action="paste"]').count(),0,'Read-only staff cannot paste photos');
  const readonlyWrites=photoWrites.length;assert.equal(await pasteEvent(page.locator('[data-inv-photo]').first()),false);assert.equal(photoWrites.length,readonlyWrites);
  await page.locator('.inv-item').first().click();assert.equal(await page.locator('#inv-dialog-submit').count(),0);
  assert.equal(await page.locator('[data-inv-action="delete-item"]').count(),0,'Read-only item details have no Delete action');
  await page.keyboard.press('Escape');
  for(const [who,capability]of [[4,'receive'],[5,'use']]){
    await page.evaluate(async({who,capability})=>{currentSession={user:{id:'00000000-0000-4000-8000-'+String(who).padStart(12,'0')}};currentUserAccess={active:true,isAdmin:false,permissions:new Set(['inventory','inventory_'+capability])};LuminInventory.reset();await switchClinicManagementTab('inventory');},{who,capability});
    assert.equal(await stockStep(capability).isEnabled(),true,`${capability} permission enables only its stock button`);
    assert.equal(await stockStep(capability==='receive'?'use':'receive').isDisabled(),true);
  }
  await page.evaluate(async()=>{currentSession={user:{id:'00000000-0000-4000-8000-000000000003'}};currentUserAccess={active:true,isAdmin:false,permissions:new Set(['inventory','inventory_manage'])};LuminInventory.reset();await switchClinicManagementTab('inventory');});
  assert.equal(await stockStep('receive').isDisabled(),true);assert.equal(await stockStep('use').isDisabled(),true);
  await page.locator(`[data-inv-item="${anesthesiaItem}"]`).first().click();assert.equal(await page.locator('#inventory-overlay [name="minimum"]').isEnabled(),true);
  await page.evaluate(()=>{currentUserAccess.active=false;LuminInventory.invalidate();});assert.equal(await page.locator('#view-inventory').textContent(),'');
  assert.ok(requests.some(r=>r.name==='inventory_write'&&r.args.p_operation==='import'));assert.deepEqual(errors,[]);
});
