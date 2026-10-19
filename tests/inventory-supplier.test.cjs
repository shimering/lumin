const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),model=require('../lumin-supplier-list-model.js');
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
async function database(t){
  const db=new PGlite();t.after(()=>db.close());await db.exec(fs.readFileSync(path.join(__dirname,'fixtures/inventory.sql'),'utf8'));
  for(const file of fs.readdirSync(path.join(root,'supabase/migrations')).filter(name=>/^(20261016203800|20261016213858|20261017061336|20261017063353|20261017073421|20261017075131|20261017144330|20261017162033|20261019054001)_/.test(name)).sort())await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',file),'utf8'));
  await db.exec("create table public.quotation_settings(id integer primary key,clinic_name text);insert into public.quotation_settings values(1,'Lumin Clinic عيادة لومين');");
  const parent=(await db.query("select id from public.inventory_categories where key='anaesthesia'")).rows[0].id;
  await db.query("insert into public.inventory_categories(id,name,name_ar,parent_id) values($1,'Deep subcategory','تصنيف فرعي عميق',$2)",[uuid(100),parent]);
  for(let n=0;n<47;n++)await db.query("insert into public.inventory_items(id,name,name_en,name_ar,category_id,quantity,minimum,unit) values($1,$2,$2,$3,$4,$5,3,'Box')",[uuid(1000+n),'Supply '+String(n).padStart(2,'0'),`صنف ${n}`,uuid(100),n<25?0:1]);
  await db.query("insert into public.inventory_items(id,name,name_en,quantity,minimum,unit) values($1,'Healthy item','Healthy item',20,3,'Box'),($2,'Unknown item','Unknown item',null,3,'Box'),($3,'No minimum','No minimum',2,null,'Box')",[uuid(2000),uuid(2001),uuid(2002)]);
  let queue=Promise.resolve();
  function rpc(name,args={},who=1,role='authenticated'){
    const run=queue.then(async()=>{await db.exec('reset role');await db.query("select set_config('test.actor',$1,false)",[who?uuid(who):'']);await db.exec('set role '+role);try{
      const names=Object.keys(args),result=await db.query(`select public.${name}(${names.map((key,i)=>`${key} => $${i+1}`).join(',')}) data`,names.map(key=>Array.isArray(args[key])||typeof args[key]==='object'?JSON.stringify(args[key]):args[key]));return result.rows[0].data;
    }finally{await db.exec('reset role');}});queue=run.catch(()=>{});return run;
  }
  return{db,rpc};
}
test('supplier lists enforce scope, complete candidates, main categories, minimal snapshots, idempotency and permissions',async t=>{
  const{db,rpc}=await database(t),candidates=scope=>rpc('get_inventory_supplier_candidates',{p_scope:scope});
  const out=await candidates('out'),low=await candidates('low'),both=await candidates('both');
  assert.equal(out.length,25);assert.equal(low.length,22);assert.equal(both.length,47);
  assert.ok(both.every(item=>item.category_name==='Consumables'&&item.category_name_ar==='مستهلكات يومية'));
  const items=both.slice(1).map(({id,revision},index)=>({id,revision,requested_quantity:index===0?3:1})),args={p_scope:'both',p_items:items,p_request_id:uuid(5000),p_language:'en'};
  const saved=await rpc('create_inventory_supplier_list',args);assert.match(saved.token,/^[a-f0-9]{64}$/);
  assert.deepEqual(await rpc('create_inventory_supplier_list',args),saved,'Lost replies reuse the same saved link');
  await assert.rejects(rpc('create_inventory_supplier_list',{...args,p_items:items.slice(1)}),/SUPPLIER_REQUEST/);
  const publicData=await rpc('inventory_supplier_source',{p_token:saved.token},null,'service_role');
  assert.equal(publicData.items.length,46);assert.equal(publicData.items.some(item=>item.name_en==='Supply 00'),false);
  assert.deepEqual(Object.keys(publicData.items[0]).sort(),['category_name','category_name_ar','name_ar','name_en','requested_quantity','unit']);assert.equal(publicData.items[0].requested_quantity,3);
  assert.ok(!JSON.stringify(publicData).includes('"quantity"'));assert.ok(!JSON.stringify(publicData).includes('Deep subcategory'));
  await db.query('update public.inventory_items set quantity=30,revision=revision+1 where id=$1',[items[0].id]);
  assert.deepEqual(await rpc('inventory_supplier_source',{p_token:saved.token},null,'service_role'),publicData,'Published list is immutable');
  await assert.rejects(rpc('create_inventory_supplier_list',{...args,p_request_id:uuid(5001)}),/SUPPLIER_STALE/);
  await assert.rejects(rpc('create_inventory_supplier_list',{...args,p_request_id:uuid(5002),p_items:[]}),/SUPPLIER_INPUT/);
  await assert.rejects(rpc('create_inventory_supplier_list',{...args,p_request_id:uuid(5003),p_items:[items[1],items[1]]}),/SUPPLIER_INPUT/);
  for(const quantity of [0,-1,1.5,1000001,null,'2'])await assert.rejects(rpc('create_inventory_supplier_list',{...args,p_request_id:uuid(5004),p_items:[{...items[1],requested_quantity:quantity}]}),/SUPPLIER_QUANTITY/);
  for(const who of [2,5,6,7,8]){await assert.rejects(rpc('get_inventory_supplier_candidates',{p_scope:'both'},who),/INVENTORY_ACCESS/);await assert.rejects(rpc('create_inventory_supplier_list',{...args,p_request_id:uuid(6000+who)},who),/INVENTORY_ACCESS/);}
  for(const who of [3,4])assert.ok((await rpc('get_inventory_supplier_candidates',{p_scope:'both'},who)).length>20);
  await assert.rejects(rpc('get_inventory_supplier_candidates',{p_scope:'both'},null,'anon'),/permission denied/);
  for(const role of ['anon','authenticated'])await assert.rejects(rpc('inventory_supplier_source',{p_token:saved.token},1,role),/permission denied/);
  for(const value of ['bad','a'.repeat(64),null])assert.equal(await rpc('inventory_supplier_source',{p_token:value},null,'service_role'),null);
  await db.query("update private.inventory_supplier_lists set expires_at=now()-interval '1 second' where id=$1",[saved.id]);
  assert.equal(await rpc('inventory_supplier_source',{p_token:saved.token},null,'service_role'),null);
});

test('supplier review and shared JPG/link page fit mobile, tablet, desktop, English and Arabic',async t=>{
  const{db,rpc}=await database(t);const downloadsPath=path.join(root,'.wrangler/supplier-review/downloads');fs.mkdirSync(downloadsPath,{recursive:true});const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||'chrome',downloadsPath});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:375,height:812},acceptDownloads:true,reducedMotion:'reduce'});page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));let creates=0,dropReply=true,lastSaved;
  await page.exposeFunction('fixtureRPC',async(name,args)=>{try{const data=await rpc(name,args);if(name==='create_inventory_supplier_list'){creates++;lastSaved=data;if(dropReply){dropReply=false;return{error:{message:'Lost response'}};}}return{data};}catch(error){return{error:{message:error.message}};}});
  await page.route('https://supplier.test/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset=utf-8><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:12px;font-family:Arial}*{box-sizing:border-box}.hidden{display:none}</style><link rel="stylesheet" href="lumin-inventory.css"><section id="view-clinic-management"><section id="view-inventory"></section></section><script>var currentSession={user:{id:'${uuid(1)}'}},currentUserAccess={permissions:new Set(['inventory']),isAdmin:true},currentUiLanguage='en';function hasPageAccess(){return true}var db={rpc:(name,args)=>fixtureRPC(name,args)};</script>${['vendor/lucide.min.js','lumin-inventory-model.js','lumin-supplier-list-model.js','lumin-inventory-supplier.js','lumin-inventory.js'].map(file=>`<script src="${file}"></script>`).join('')}`});
    const file=path.join(root,url.pathname.slice(1));if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
    return route.fulfill({contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':'text/html',body:fs.readFileSync(file)});
  });
  await page.goto('https://supplier.test/');await page.evaluate(()=>LuminInventory.refresh());
  const heading=page.locator('.inv-heading');assert.equal(await heading.locator('[data-inv-action=add]').isVisible(),true);assert.equal(await heading.locator('[data-inv-action=choose-receive]').isVisible(),false);
  await heading.locator('[data-inv-action=add]').click();await page.locator('#inventory-overlay [name=name_en]').waitFor();await page.keyboard.press('Escape');
  const supplierAction=name=>page.locator(`[data-supplier-action="${name}"]`);
  await heading.locator('[data-inv-action=supplier-list]').click();assert.equal(creates,0);await page.locator('[name=supplier-scope][value=both]').check();await supplierAction('review').click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-supplier-item]').length===47);assert.equal(creates,0,'Review does not publish anything');
  assert.equal(await page.locator('.inv-supplier-group h4').count(),1);assert.equal(await page.locator('.inv-supplier-group h4').textContent(),'Consumables');
  const removed=await page.locator('[data-supplier-item] strong').first().textContent();await supplierAction('remove').first().click();assert.equal(await page.locator('[data-supplier-item]').count(),46);
  const wanted=page.locator('[name=supplier-quantity]').first();assert.equal(await wanted.inputValue(),'1');assert.equal(await supplierAction('wanted-minus').first().isDisabled(),true);await supplierAction('wanted-plus').first().click();await supplierAction('wanted-plus').first().click();assert.equal(await wanted.inputValue(),'3');await supplierAction('wanted-minus').first().click();assert.equal(await wanted.inputValue(),'2');
  for(const [width,height,lang]of [[320,640,'en'],[508,884,'ar'],[820,1180,'ar'],[1440,1000,'en']]){
    await page.setViewportSize({width,height});await page.evaluate(lang=>{currentUiLanguage=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';},lang);
    // Restore/reremove forces localized review rendering without resetting its selection.
    await supplierAction('restore').click();await supplierAction('remove').first().click();
    assert.equal(await page.locator('.inv-supplier-dialog').evaluate(node=>node.scrollWidth>node.clientWidth+1),false,`Dialog width ${width} ${lang}`);
    assert.equal(await page.locator('#inventory-supplier-overlay .inv-dialog-body').evaluate(node=>node.scrollWidth>node.clientWidth+1),false);
    const bounds=await page.locator('#inventory-supplier-overlay .inv-dialog-footer').boundingBox();assert.ok(bounds.y+bounds.height<=height+1,'Pinned footer is on screen');
    assert.ok((await supplierAction('remove').first().boundingBox()).height>=44);assert.ok((await supplierAction('create').boundingBox()).height>=44);
    assert.equal(await page.locator('[name=supplier-quantity]').first().inputValue(),'2','Quantity survives removal/restoration and viewport changes');assert.ok((await supplierAction('wanted-plus').first().boundingBox()).height>=44);
    if(process.env.LUMIN_SUPPLIER_SCREENSHOTS&&width<768){fs.mkdirSync(process.env.LUMIN_SUPPLIER_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.LUMIN_SUPPLIER_SCREENSHOTS,`supplier-review-${width}-${lang}.png`)});}
  }
  await supplierAction('create').click();await page.getByRole('alert').filter({hasText:'Could not create'}).waitFor();assert.equal(await page.locator('[data-supplier-item]').count(),46,'Lost response keeps the review');
  await supplierAction('create').click();await page.locator('.inv-supplier-link').waitFor();const link=await page.locator('.inv-supplier-link').inputValue();assert.equal(new URL(link).searchParams.get('s'),lastSaved.token);assert.equal(creates,2);
  assert.equal((await db.query('select count(*) count from private.inventory_supplier_lists')).rows[0].count,1);
  const snapshot=await rpc('inventory_supplier_source',{p_token:lastSaved.token},null,'service_role');assert.equal(snapshot.items.some(item=>item.name_en===removed),false);assert.equal(snapshot.items.find(item=>item.name_en==='Supply 01').requested_quantity,2);
  const publicPage=await browser.newPage({viewport:{width:375,height:812},acceptDownloads:true,reducedMotion:'reduce'});publicPage.on('pageerror',error=>errors.push(error.message));
  await publicPage.addInitScript(()=>{Object.defineProperty(navigator,'canShare',{value:()=>false,writable:true,configurable:true});Object.defineProperty(navigator,'share',{value:undefined,writable:true,configurable:true});});
  await publicPage.route('https://pqbayjkypzfxvnksgwwf.supabase.co/functions/v1/inventory-supplier-view',async route=>{
    const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type, apikey'};if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers});
    const token=route.request().postDataJSON().token,data=await rpc('inventory_supplier_source',{p_token:token},null,'service_role');return route.fulfill({status:data?200:404,headers,contentType:'application/json',body:JSON.stringify(data||{})});
  });
  await publicPage.route('https://supplier.test/**',async route=>{const file=path.join(root,new URL(route.request().url()).pathname.slice(1));return route.fulfill({contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':'text/html',body:fs.readFileSync(file)});});
  await publicPage.goto(link);await publicPage.locator('.sl-document').waitFor();assert.equal(await publicPage.locator('.sl-row').count(),46);assert.equal(await publicPage.locator('.sl-group').count(),1);assert.equal(await publicPage.locator('.sl-quantity').first().textContent(),'2');assert.match(await publicPage.locator('.sl-unit').first().textContent(),/Box/);
  for(const width of [320,375,508,820,1440]){await publicPage.setViewportSize({width,height:900});for(const lang of ['en','ar']){if(await publicPage.locator('html').getAttribute('lang')!==lang)await publicPage.locator('[data-sl-action=language]').click();assert.equal(await publicPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${width} ${lang} page fits`);}}
  await publicPage.setViewportSize({width:375,height:812});
  const downloadPromise=publicPage.waitForEvent('download');await publicPage.locator('[data-sl-action=jpg]').click();const download=await downloadPromise;assert.match(download.suggestedFilename(),/^SL-.*\.jpg$/);const jpg=fs.readFileSync(await download.path());assert.equal(jpg[0],255);assert.equal(jpg[1],216);assert.equal(jpg.at(-2),255);assert.equal(jpg.at(-1),217);
  const artifactDir=process.env.LUMIN_SUPPLIER_SCREENSHOTS;
  if(artifactDir){fs.mkdirSync(artifactDir,{recursive:true});fs.writeFileSync(path.join(artifactDir,'supplier-list-ar.jpg'),jpg);await publicPage.screenshot({path:path.join(artifactDir,'supplier-page-mobile-ar.png'),fullPage:true});}
  await publicPage.evaluate(()=>{window.shared=[];navigator.share=async value=>window.shared.push({url:value.url,count:value.files?.length,type:value.files?.[0]?.type});navigator.canShare=()=>true;});
  await publicPage.locator('[data-sl-action=link]').click();await publicPage.waitForFunction(()=>window.shared.length===1);assert.equal((await publicPage.evaluate(()=>window.shared[0])).url,link);
  await publicPage.locator('[data-sl-action=jpg]').click();await publicPage.waitForFunction(()=>window.shared.length===2);assert.equal((await publicPage.evaluate(()=>window.shared[1])).type,'image/jpeg');
  await publicPage.goto('https://supplier.test/supplier-list.html?s=invalid');await publicPage.locator('.sl-status h1').waitFor();assert.equal(await publicPage.locator('.sl-row').count(),0);assert.deepEqual(errors,[]);
});

test('supplier asset route stays private, bypasses offline login and exports safely escaped names',async()=>{
  const{handleRequest}=await import('../workers/lumin.mjs');const env={ASSETS:{fetch:async()=>new Response(fs.readFileSync(path.join(root,'supplier-list.html'),'utf8'))}};
  const response=await handleRequest(new Request('https://clinic.test/supplier-list.html?s='+'a'.repeat(64)),env);assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store, private');assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');assert.match(await response.text(),/id="supplier-list"/);
  assert.equal((await handleRequest(new Request('https://clinic.test/supplier-list.html',{method:'POST'}),env)).status,405);
  assert.equal((await handleRequest(new Request('https://clinic.test/supplier-list?s=abc'),env)).status,308);
  assert.equal(model.escape('<img src=x onerror=alert(1)>'),'&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(model.groups([{name_en:'B',category_name:'Main'},{name_en:'A',category_name:'Main'}],'en')[0].items[0].name_en,'A');
});

test('supplier public endpoint validates capability tokens and never grants inventory access',async()=>{
  const{stripTypeScriptTypes}=require('node:module');
  let source=fs.readFileSync(path.join(root,'supabase/functions/inventory-supplier-view/index.ts'),'utf8');
  source=source.replace(/^import .*;\r?\n/m,'').replace(/^if\(import.meta.main\).*$/m,'');
  const{handleRequest}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
  let reads=0;const token='a'.repeat(64),data={items:[{name_en:'Supply',unit:'Box',category_name:'Main'}]};
  const client={rpc:async(name,args)=>{reads++;assert.equal(name,'inventory_supplier_source');assert.deepEqual(args,{p_token:token});return{data};}};
  const request=body=>new Request('https://api.test',{method:'POST',body:JSON.stringify(body)});
  assert.equal((await handleRequest(new Request('https://api.test'),client)).status,405);
  assert.equal((await handleRequest(new Request('https://api.test',{method:'OPTIONS'}),client)).status,200);
  for(const bad of ['invalid',null,1])assert.equal((await handleRequest(request({token:bad}),client)).status,404);
  assert.equal(reads,0);const response=await handleRequest(request({token}),client);assert.deepEqual(await response.json(),data);assert.equal(response.headers.get('Cache-Control'),'no-store, private');assert.equal(reads,1);
  assert.equal((await handleRequest(request({token}),{rpc:async()=>({data:null})})).status,404);
  assert.equal((await handleRequest(request({token}),{rpc:async()=>({error:{message:'private details'}})})).status,503);
  assert.equal((await handleRequest(request({token:'a'.repeat(3000)}),client)).status,400);
});
