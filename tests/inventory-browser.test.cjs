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
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261016213858_simplify_inventory_items.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261017061336_retire_inventory_minimum_steps.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261017063353_bilingual_inventory_names.sql'),'utf8'));
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
    let db={rpc:async(name,args)=>{const result=await window.fixtureRPC(name,args,currentSession.user.id);if(name==='inventory_write'&&!result.error&&window.simulateInventoryRealtime)window.LuminInventory.invalidate();if(name==='inventory_write'&&!result.error&&window.dropReceiptReply&&args.p_operation==='receive'){window.dropReceiptReply=false;return{error:{message:'Response lost after commit'}};}return result;}};
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
  assert.equal(await page.locator('#inv-sort').inputValue(),'name','Name is the default sort');
  assert.equal(await page.locator('.inv-mobile-actions').count(),0,'The floating mobile bar is removed');
  const categories=await db.query('select id,key from public.inventory_categories');
  const anesthesia=categories.rows.find(c=>c.key==='anaesthesia').id,surgical=categories.rows.find(c=>c.key==='surgical').id;
  const anesthesiaItem=(await db.query("select id from public.inventory_items where name='Anasthesia (Blue)'")).rows[0].id;
  const stockStep=operation=>page.locator(`#inv-stock-${operation}-${anesthesiaItem}`);
  const waitStock=async quantity=>{
    await page.waitForFunction(({id,quantity})=>{const node=document.getElementById('inv-stock-receive-'+id);return node&&!node.disabled&&node.parentElement.querySelector('.inv-number').textContent.replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632))===String(quantity);},{id:anesthesiaItem,quantity});
    assert.equal(Number((await db.query('select quantity from public.inventory_items where id=$1',[anesthesiaItem])).rows[0].quantity),quantity);
  };
  const firstQuickWrite=requests.length;
  await page.evaluate(id=>{window.dropReceiptReply=true;document.getElementById('inv-stock-receive-'+id).click();document.getElementById('inv-stock-receive-'+id).click();},anesthesiaItem);
  await page.waitForFunction(()=>document.querySelector('#view-inventory [data-inv-action="retry-stock"]')&&!document.querySelector('.inv-stock-stepper[aria-busy="true"]'));
  assert.equal(requests.slice(firstQuickWrite).filter(r=>r.name==='inventory_write').length,1,'Rapid clicks post once');
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
  assert.equal(Number(await page.locator('[data-inv-stat="out"] strong').textContent()),(await db.query('select count(*)::int n from public.inventory_items where quantity=0')).rows[0].n,'Summary counts update in place');
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
  assert.equal(await unitSelect.count(),1);assert.equal(await unitSelect.isDisabled(),true,'A unit used by posted movements stays locked');
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
  assert.equal(await page.locator('#inventory-overlay [name="reference"],#inventory-overlay [name="reason"]').count(),0,'Receive form only needs quantity and movement date');
  await page.locator('#inventory-overlay [name="quantity"]').fill('2');
  await page.evaluate(()=>{window.dropReceiptReply=true;});
  await page.locator('#inv-dialog-submit').click();
  await page.waitForFunction(()=>document.getElementById('inv-dialog-error')?.hidden===false);
  await page.locator('#inv-dialog-submit').click();
  await page.waitForFunction(()=>!document.getElementById('inventory-overlay'));
  assert.equal(Number((await db.query('select quantity from public.inventory_items where id=$1',[anesthesiaItem])).rows[0].quantity),4);
  for(const quantity of [3,2,1]){await stockStep('use').click();await waitStock(quantity);}
  assert.equal(Number((await db.query('select quantity from public.inventory_items where id=$1',[anesthesiaItem])).rows[0].quantity),1);
  await page.locator('[data-inv-action="history"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.inv-movement').length>0);
  assert.ok((await page.locator('.inv-movement').allTextContents()).some(text=>text.includes('Usage')));
  await page.evaluate(async()=>{currentUiLanguage='ar';document.documentElement.dir='rtl';await LuminInventory.languageChanged();});
  assert.ok((await page.locator('.inv-movement strong').allTextContents()).includes('مخدر أزرق'));
  await page.evaluate(async()=>{currentUiLanguage='en';document.documentElement.dir='ltr';await LuminInventory.languageChanged();});
  await page.locator('[data-inv-action="stock"]').click();
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
  for(const language of ['en','ar'])for(const width of [320,390,480,820,1024,1440]){
    await page.setViewportSize({width,height:1100});
    await page.evaluate(async lang=>{currentUiLanguage=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';await LuminInventory.languageChanged();},language);
    const overflow=await page.locator('#view-inventory').evaluate(node=>node.scrollWidth>node.clientWidth+1);assert.equal(overflow,false,`${language} ${width}`);
    const controls=await page.locator('#view-inventory button:visible').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect()).filter(r=>r.width<43||r.height<43));assert.equal(controls.length,0,`Touch sizes ${language} ${width}`);
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
    if(width<1024){assert.equal(await page.locator('#inv-mobile-category').isVisible(),true);await page.locator('#inv-mobile-category').selectOption(surgical);await page.waitForFunction(()=>!document.querySelector('#view-inventory [aria-busy="true"]'));await page.locator('#inv-mobile-category').selectOption('all');await page.waitForFunction(()=>!document.querySelector('#view-inventory [aria-busy="true"]'));}
    if(process.env.LUMIN_INVENTORY_SCREENSHOTS&&((language==='en'&&width===1440)||(language==='ar'&&width===390))){fs.mkdirSync(process.env.LUMIN_INVENTORY_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.LUMIN_INVENTORY_SCREENSHOTS,`inventory-${language}-${width}.png`),fullPage:width>=768});}
  }
  await page.setViewportSize({width:390,height:900});
  assert.equal(await page.locator('.inv-heading [data-inv-action="choose-receive"]').isVisible(),true,'Receive stays available in the heading');
  await page.locator('[data-inv-action="categories"]:visible').first().click();
  await page.locator('#inv-manage-tab-items').click();
  await page.locator('[data-inv-action="managed-add"]').click();
  assert.equal(await page.locator('.inv-dialog').evaluate(node=>Math.abs(node.getBoundingClientRect().bottom-window.innerHeight)<2),true,'Mobile dialog is a bottom sheet');
  await page.keyboard.press('Escape');await page.locator('#inv-management-search').waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('#inventory-overlay').count(),0);
  await page.evaluate(async()=>{currentSession={user:{id:'00000000-0000-4000-8000-000000000002'}};currentUserAccess={active:true,isAdmin:false,permissions:new Set(['inventory'])};LuminInventory.reset();await switchClinicManagementTab('overview');});
  assert.equal(await page.locator('#clinic-management-tab-inventory').getAttribute('aria-selected'),'true','Inventory-only staff land on their authorized tab');
  assert.equal(await page.locator('#clinic-management-tab-overview').isVisible(),false);
  assert.equal(await page.locator('#view-inventory [data-inv-action="add"]').count(),0);
  assert.equal(await page.locator('#view-inventory [data-inv-action="choose-receive"]').count(),0);
  assert.equal(await page.locator('.inv-stock-step:enabled').count(),0,'Read-only staff cannot use stock buttons');
  await page.locator('.inv-item').first().click();assert.equal(await page.locator('#inv-dialog-submit').count(),0);
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
