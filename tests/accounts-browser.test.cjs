const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const KEY = 'lumin-saved-accounts-v1';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
function source(name) {
  const start = html.search(new RegExp('    (?:async )?function '+name+'\\('));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}
function jwt(id, expired = false) {
  return [Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),
    Buffer.from(JSON.stringify({sub:id,exp:Math.floor(Date.now()/1000)+(expired?-60:3600),role:'authenticated'})).toString('base64url'),'fixture'].join('.');
}
const bootstrap = `
  const A=${JSON.stringify(A)},B=${JSON.stringify(B)};
  let currentUiLanguage=new URLSearchParams(location.search).get('lang')||'en';
  let currentSession=null,currentUserAccess=null;
  window.reloads=0;window.beforeSwitches=0;window.unsaved=false;window.failInstall=false;
  function normaliseHexColor(value){return value||'#2563eb'}
  ${source('accessConfigurationError')}
  ${source('loadCurrentUserAccess')}
  const db=supabase.createClient(location.origin+'/supabase','public-fixture-key',{
    auth:{storageKey:'fixture-active',persistSession:true,autoRefreshToken:false,detectSessionInUrl:false},
    global:{fetch:(...args)=>LuminAccounts.fetch(...args)}
  });
  const realSetSession=db.auth.setSession.bind(db.auth);
  db.auth.setSession=async pair=>window.failInstall?{error:new Error('Fixture install failed')}:realSetSession(pair);
  window.primary=db;
  LuminAccounts.init({db,session:()=>currentSession,access:()=>currentUserAccess,language:()=>currentUiLanguage,
    settings:()=>{window.settingsOpened=true},loadAccess:loadCurrentUserAccess,authStorageKey:'fixture-active',
    createClient:()=>supabase.createClient(location.origin+'/supabase','public-fixture-key',{
      auth:{storageKey:'fixture-probe',persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}),
    hasUnsavedChanges:()=>window.unsaved,beforeSwitch:async()=>{window.beforeSwitches++},resume:async()=>{},reload:()=>{window.reloads++}});
  db.auth.onAuthStateChange((event,session)=>{if(event!=='INITIAL_SESSION')LuminAccounts.authChanged(event,session)});
  window.fixtureReady=(async()=>{
    let saved=(await db.auth.getSession()).data.session;
    if(!saved){const result=await db.auth.setSession({access_token:${JSON.stringify(jwt(A))},refresh_token:'refresh-a'});saved=result.data.session;}
    currentSession=saved;currentUserAccess=await loadCurrentUserAccess(saved);
    LuminAccounts.authorized(saved,currentUserAccess);
    document.documentElement.dir=currentUiLanguage==='ar'?'rtl':'ltr';document.documentElement.lang=currentUiLanguage;
    document.getElementById('auth-gate').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');
    document.querySelectorAll('#app-main>section').forEach(node=>node.classList.add('hidden'));
    document.getElementById('view-settings').classList.remove('hidden');
    document.getElementById('settings-user-name').textContent=currentUserAccess.fullName;
    document.getElementById('current-user-name').textContent=currentUserAccess.fullName;
    document.getElementById('current-user-role').textContent=currentUserAccess.roleName;
  })();
  window.switchView=()=>{};
`;

test('saved account switching uses isolated real Auth clients and responsive accessible controls', async t => {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (data, status = 200) => {res.writeHead(status, {'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    if (url.pathname.startsWith('/supabase/')) {
      let body = ''; for await (const chunk of req) body += chunk;
      calls.push({url:url.pathname,method:req.method,authorization:req.headers.authorization,body});
      let id; try {id=JSON.parse(Buffer.from((req.headers.authorization||'').split('.')[1],'base64url')).sub;} catch (_) {}
      if (url.pathname.endsWith('/auth/v1/user')) return send({id,email:id===A?'ahmed@clinic.test':'sara@clinic.test',user_metadata:{}});
      if (url.pathname.endsWith('/auth/v1/token')) {
        const refresh=JSON.parse(body).refresh_token;
        if(refresh==='invalid')return send({msg:'Invalid Refresh Token',code:'refresh_token_not_found'},400);
        return send({access_token:jwt(B),refresh_token:'refresh-b-rotated',token_type:'bearer',expires_in:3600,user:{id:B,email:'sara@clinic.test'}});
      }
      if (url.pathname.endsWith('/functions/v1/user-login')) {
        const credentials=JSON.parse(body);
        if(credentials.password!=='correct')return send({error:'Invalid login'},401);
        const target=credentials.identifier==='ahmed'?A:B;
        return send({access_token:jwt(target),refresh_token:target===A?'refresh-a':'refresh-b'});
      }
      if (url.pathname.endsWith('/rest/v1/user_profiles')) {
        const requested=url.searchParams.get('user_id')?.slice(3);
        return send({user_id:requested,email:requested===A?'ahmed@clinic.test':'sara@clinic.test',full_name:requested===A?'Dr. Ahmed':'Dr. Sara',login_name:requested===A?'ahmed':'sara',active:true,is_doctor:true,ui_language:requested===A?'en':'ar',
          access_roles:{id:'role-'+requested,name:requested===A?'Administrator':'Doctor',is_admin:requested===A,role_permissions:[{page_key:'patients',can_view:true,can_modify:true}]}});
      }
      if (url.pathname.endsWith('/rest/v1/slow')) return; // aborted when an identity is replaced
      return send({});
    }
    if (url.pathname === '/') {
      res.setHeader('Content-Type','text/html');
      if(url.searchParams.has('full'))return res.end(html);
      return res.end(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace('</body>',`<script src="vendor/supabase.js"></script><script src="vendor/lucide.min.js"></script><script src="lumin-accounts.js"></script><script>${bootstrap}</script></body>`));
    }
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return res.writeHead(404).end();
    res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||'chrome'});
  t.after(()=>browser.close());
  async function fixture(options={}) {
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    t.after(()=>context.close());
    await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/?'+(options.lang?'lang='+options.lang:''));
    await page.evaluate(()=>fixtureReady);
    return {page,context,errors};
  }
  async function open(page){await page.locator('#btn-current-user').click();}
  async function trustCurrent(page){await page.locator('#la-remember-current').check();await page.locator('#la-trust-current').check();}
  async function add(page, {trust=false,password='correct',identifier='sara'}={}) {
    await page.locator('[data-account-action="add"]').click();
    await page.locator('#la-identifier').fill(identifier);await page.locator('#la-password').fill(password);
    if(trust)await page.locator('#la-trust').check();
    await page.locator('[form="la-login-form"]').click();
  }
  async function saved(page){return page.evaluate(key=>JSON.parse(localStorage.getItem(key)||'[]'),KEY);}
  async function reload(page){await page.reload();await page.evaluate(()=>fixtureReady);}

  await t.test('two trusted accounts switch both ways, survive reload, and never store passwords',async()=>{
    const {page,errors}=await fixture();await open(page);await trustCurrent(page);await add(page,{trust:true});
    await page.waitForFunction(()=>reloads===1);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('fixture-active')).user.id),B);
    assert.deepEqual((await saved(page)).map(item=>item.id).sort(),[A,B].sort());
    assert.equal(await page.evaluate(()=>Object.values(localStorage).some(value=>value.includes('correct'))),false);
    await reload(page);await open(page);
    assert.match(await page.locator('.la-current').textContent(),/Dr. Sara/);
    assert.equal(await page.evaluate(()=>currentUserAccess.isAdmin),false);
    assert.equal(await page.evaluate(()=>currentUserAccess.language),'ar');
    await page.locator(`[data-account-action="select"][data-account-id="${A}"]`).click();
    await page.waitForFunction(()=>reloads===1);await reload(page);
    assert.equal(await page.evaluate(()=>currentSession.user.id),A);
    assert.equal(await page.evaluate(()=>currentUserAccess.isAdmin),true);
    assert.equal(calls.filter(call=>call.url.endsWith('/auth/v1/logout')).length,0,'switching never revokes the previous session');
    assert.deepEqual(errors,[]);
  });

  await t.test('remembered names require a password, failed sign-in preserves the active account',async()=>{
    const {page}=await fixture();await open(page);await add(page,{password:'wrong'});
    await page.waitForFunction(()=>!document.querySelector('.la-working'));
    assert.equal(await page.evaluate(()=>currentSession.user.id),A);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('fixture-active')).user.id),A);
    assert.equal(await page.locator('#la-password').inputValue(),'');
    assert.equal((await saved(page)).length,0);
    await page.locator('#la-password').fill('correct');await page.locator('[form="la-login-form"]').click();
    await page.waitForFunction(()=>reloads===1);assert.equal((await saved(page))[0].session,null);
    await reload(page);await open(page);await add(page,{identifier:'ahmed'});await page.waitForFunction(()=>reloads===1);await reload(page);await open(page);
    await page.locator(`[data-account-action="select"][data-account-id="${B}"]`).click();
    assert.equal(await page.locator('#la-identifier').inputValue(),'sara');
    assert.equal(await page.locator('#la-password').isVisible(),true);
    assert.equal(await page.evaluate(()=>currentSession.user.id),A);
  });

  await t.test('rotated tokens are retained and revoked sessions request sign-in',async()=>{
    const {page}=await fixture();await page.evaluate(({KEY,B,token})=>localStorage.setItem(KEY,JSON.stringify([{id:B,name:'Dr. Sara',login:'sara',trusted:true,session:{access_token:token,refresh_token:'refresh-b'}}])),{KEY,B,token:jwt(B,true)});
    await open(page);await page.locator(`[data-account-action="select"][data-account-id="${B}"]`).click();await page.waitForFunction(()=>reloads===1);
    assert.equal((await saved(page))[0].session.refresh_token,'refresh-b-rotated');
    const other=await fixture();await other.page.evaluate(({KEY,B,token})=>localStorage.setItem(KEY,JSON.stringify([{id:B,name:'Dr. Sara',login:'sara',trusted:true,session:{access_token:token,refresh_token:'invalid'}}])),{KEY,B,token:jwt(B,true)});
    await open(other.page);await other.page.locator(`[data-account-action="select"][data-account-id="${B}"]`).click();
    await other.page.waitForFunction(()=>document.querySelector('#la-password')&&!document.querySelector('.la-working'));
    assert.equal((await saved(other.page))[0].session,null);
    assert.equal(await other.page.evaluate(()=>currentSession.user.id),A);
  });

  await t.test('deactivated accounts and network failures cannot replace the current identity',async()=>{
    const {page}=await fixture();
    await page.route('**/supabase/rest/v1/user_profiles*',route=>route.fulfill({json:{active:false,user_id:B}}));
    await open(page);await add(page,{trust:true});await page.waitForFunction(()=>!document.querySelector('.la-working'));
    assert.match(await page.locator('#la-error').textContent(),/not active/);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('fixture-active')).user.id),A);
    await page.unroute('**/supabase/rest/v1/user_profiles*');
    await page.route('**/supabase/rest/v1/user_profiles*',route=>route.fulfill({status:503,json:{message:'Temporary unavailable'}}));
    await page.locator('#la-password').fill('correct');await page.locator('[form="la-login-form"]').click();
    await page.waitForFunction(()=>!document.querySelector('.la-working'));
    assert.equal(await page.evaluate(()=>reloads),0);
    assert.equal(await page.evaluate(()=>currentSession.user.id),A);
  });

  await t.test('removal and sign-out clear saved credentials; removing current keeps it open',async()=>{
    const {page}=await fixture();await open(page);await trustCurrent(page);
    await page.evaluate(()=>localStorage.setItem('lumin-dental-remembered-login','ahmed'));
    await page.locator('[data-account-action="remove"]').click();
    assert.deepEqual(await saved(page),[]);
    assert.equal(await page.evaluate(()=>localStorage.getItem('lumin-dental-remembered-login')),null);
    assert.equal(await page.evaluate(()=>currentSession.user.id),A);
    await trustCurrent(page);await page.evaluate(()=>LuminAccounts.signedOut(currentSession.user.id));
    assert.equal((await saved(page))[0].session,null);
  });

  await t.test('unsaved work can cancel switching and switching aborts old requests',async()=>{
    const {page}=await fixture();await page.evaluate(({KEY,B,token})=>localStorage.setItem(KEY,JSON.stringify([{id:B,name:'Dr. Sara',login:'sara',trusted:true,session:{access_token:token,refresh_token:'refresh-b'}}])),{KEY,B,token:jwt(B)});
    await page.evaluate(()=>{window.unsaved=true;window.slowResult='pending';LuminAccounts.fetch(location.origin+'/supabase/rest/v1/slow').catch(error=>{window.slowResult=error.name})});
    await open(page);await page.locator(`[data-account-action="select"][data-account-id="${B}"]`).click();
    assert.equal(await page.locator('.la-discard').isVisible(),true);
    await page.locator('[data-account-action="cancel-discard"]').click();assert.equal(await page.evaluate(()=>reloads),0);
    await page.locator(`[data-account-action="select"][data-account-id="${B}"]`).click();
    await page.locator('[data-account-action="discard"]').click();await page.waitForFunction(()=>reloads===1);
    assert.equal(await page.evaluate(()=>slowResult),'AbortError');
    assert.equal(await page.evaluate(()=>LuminAccounts.fetch(location.origin+'/supabase/rest/v1/patients').then(()=>false,error=>error.name)),'AbortError');
    assert.equal(await page.locator('#app-shell').isVisible(),false);
  });

  await t.test('unavailable storage leaves the old account usable and reports the problem',async()=>{
    const {page}=await fixture();await open(page);await trustCurrent(page);await page.keyboard.press('Escape');
    await page.evaluate(({KEY,B,token})=>{
      const items=JSON.parse(localStorage.getItem(KEY));items.push({id:B,name:'Dr. Sara',login:'sara',trusted:true,session:{access_token:token,refresh_token:'refresh-b'}});
      localStorage.setItem(KEY,JSON.stringify(items));
      const original=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value){if(key===KEY)throw new DOMException('Quota full','QuotaExceededError');return original.call(this,key,value)};
    },{KEY,B,token:jwt(B)});
    await open(page);await page.locator(`[data-account-action="select"][data-account-id="${B}"]`).click();
    await page.waitForFunction(()=>!document.querySelector('.la-working'));
    assert.match(await page.locator('#la-error').textContent(),/Allow site storage/);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('fixture-active')).user.id),A);
    assert.equal(await page.locator('#app-shell').isVisible(),true);
  });

  await t.test('real Auth sign-out invalidates the saved session and hides the old workspace',async()=>{
    const {page}=await fixture();await open(page);await trustCurrent(page);await page.keyboard.press('Escape');
    await page.evaluate(()=>primary.auth.signOut({scope:'local'}));await page.waitForFunction(()=>reloads===1);
    assert.equal((await saved(page))[0].session,null);
    assert.equal(await page.evaluate(()=>localStorage.getItem('fixture-active')),null);
    assert.equal(await page.locator('#app-shell').isVisible(),false);
  });

  await t.test('another tab switches identity immediately while same-account refreshes stay in place',async()=>{
    const {page,context}=await fixture();const other=await context.newPage();await other.goto(origin);await other.evaluate(()=>fixtureReady);
    await page.evaluate(()=>LuminAccounts.authChanged('TOKEN_REFRESHED',currentSession));
    assert.equal(await page.evaluate(()=>reloads),0);
    await open(page);await add(page,{trust:true});await page.waitForFunction(()=>reloads===1);
    await other.waitForFunction(()=>reloads===1);
    assert.equal(await other.locator('#app-shell').isVisible(),false);
    await reload(other);assert.equal(await other.evaluate(()=>currentSession.user.id),B);
  });

  await t.test('English and Arabic layouts fit desktop, iPad and phone with keyboard focus and 44px controls',async()=>{
    for (const language of ['en','ar']) {
      const {page,errors}=await fixture({lang:language});
      for(const [width,height] of [[1440,1000],[820,1180],[390,844],[320,568]]) {
        await page.setViewportSize({width,height});
        // My Settings is also available when the mobile header is collapsed.
        await page.locator('#settings-accounts-card button').scrollIntoViewIfNeeded();
        await page.locator('#settings-accounts-card button').click();
        assert.match(await page.locator('#la-title').textContent(),language==='ar'?/حساباتك/:/Your accounts/);
        const box=await page.locator('.la-panel').boundingBox();
        assert.ok(box.x>=-1&&box.x+box.width<=width+1&&box.y>=0&&box.y+box.height<=height+1,JSON.stringify({width,box}));
        const targets=await page.locator('.la-panel button:visible:not(:disabled)').evaluateAll(nodes=>nodes.map(n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})));
        assert.ok(targets.every(box=>box.width>=43.9&&box.height>=43.9),'44px buttons');
        await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.closest('.la-panel')!==null),true);
        await page.locator('[data-account-action="add"]').click();
        assert.equal(await page.locator('#la-identifier').evaluate(node=>node===document.activeElement),true);
        assert.equal(await page.locator('#la-trust').isChecked(),false,'Password-free switching requires explicit opt-in');
        await page.locator('#la-remember').uncheck();assert.equal(await page.locator('#la-trust').isDisabled(),true);
        if(process.env.LUMIN_ACCOUNTS_SCREENSHOT_DIR){fs.mkdirSync(process.env.LUMIN_ACCOUNTS_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.LUMIN_ACCOUNTS_SCREENSHOT_DIR,`accounts-${language}-${width}.png`)});}
        await page.keyboard.press('Escape');assert.equal(await page.locator('.la-panel').count(),0);
      }
      assert.deepEqual(errors,[]);
    }
  });

  await t.test('the complete app initializes the switcher at the signed-out gate',async()=>{
    const context=await browser.newContext();t.after(()=>context.close());
    await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/?full=1');
    await page.waitForFunction(()=>typeof LuminAccounts!=='undefined'&&document.querySelector('#login-form:not(.hidden)'));
    await page.locator('#login-remember-identifier').check();assert.equal(await page.locator('#login-trust-account').isEnabled(),true);
    assert.deepEqual(errors,[]);
  });

  await t.test('account sheets stay within the viewport and keep touch targets at reduced and enlarged app scales',async()=>{
    const {page}=await fixture();
    for(const width of [390,820,1440])for(const scale of [.8,1.25]) {
      await page.setViewportSize({width,height:900});
      await page.evaluate(scale=>{document.documentElement.classList.add('lumin-app-scaled');document.documentElement.style.setProperty('--lumin-app-scale',String(scale));},scale);
      await page.locator('#settings-accounts-card button').click();
      const box=await page.locator('.la-panel').boundingBox();
      assert.ok(box.x>=-1&&box.x+box.width<=width+1&&box.y>=-1&&box.y+box.height<=901,JSON.stringify({width,scale,box}));
      const sizes=await page.locator('.la-panel button:visible:not(:disabled)').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().toJSON()));
      assert.ok(sizes.every(box=>box.width>=43.9&&box.height>=43.9),JSON.stringify({width,scale,sizes}));
      await page.keyboard.press('Escape');
    }
  });
});
