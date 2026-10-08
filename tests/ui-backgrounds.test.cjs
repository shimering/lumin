const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),os=require('node:os'),path=require('node:path'),test=require('node:test');
let chromium;try{({chromium}=require('playwright'));}catch(_){}
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
function source(name){
  const start=html.search(new RegExp('    (?:async )?function '+name+'\\('));
  assert.ok(start>=0,name);return html.slice(start,html.indexOf('\n    }',start)+6);
}
test('background preferences, app-wide surfaces and dashboard shadow gutters',{skip:!chromium,timeout:120000},async t=>{
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,''));return;}
    const file=path.resolve(root,'.'+pathname);
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||undefined});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:')?route.continue():route.abort());
  await page.goto('http://127.0.0.1:'+server.address().port+'/');
  await page.addScriptTag({path:path.join(root,'vendor/lucide.min.js')});
  await page.addScriptTag({path:path.join(__dirname,'fixtures/ui-backgrounds-bootstrap.js')});
  await page.addScriptTag({content:['userUiTheme','normaliseUiTint','normaliseUiScale','userUiScale','normaliseUiBackground','userUiBackground',
    'syncUiBackgroundControl','handleUiBackgroundChange','syncUiThemeToggle','syncUiScaleControl','applyUiTheme','resetUiTheme',
    'syncUiThemeFromSession','refreshUiThemePreference','handleThemeToggle','handleThemeTintChange','handleUiScaleChange',
    'saveUiAppearance','updateAppViewportDimensions','updateDashboardViewportHeight','scheduleDashboardViewportUpdate'].map(source).join('\n')});
  await page.evaluate(()=>{
    document.getElementById('auth-gate').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');
    showFixtureView('settings');syncUiThemeFromSession(currentSession);lucide.createIcons();
  });
  const shots=path.join(os.tmpdir(),'lumin-backgrounds');fs.mkdirSync(shots,{recursive:true});
  await t.test('all backgrounds cover every page and remain independent of card and status colors',async()=>{
    for(const background of ['pearl','mist','sage','linen','dots','default']){
      await page.evaluate(async background=>{await handleUiBackgroundChange(background);},background);
      assert.equal(await page.locator('body').getAttribute('data-ui-background'),background);
      assert.equal(await page.locator('input[name="settings-app-background"]:checked').inputValue(),background);
      assert.equal(await page.evaluate(()=>remoteUser.user_metadata.lumin_ui_background),background);
      const paint=await page.locator('body').evaluate(body=>[getComputedStyle(body).backgroundColor,getComputedStyle(body).backgroundImage]);
      const face=await page.locator('#settings-appearance-card').evaluate(card=>getComputedStyle(card).backgroundImage);
      for(const view of ['dashboard','patients','chart','prices']){
        await page.evaluate(view=>showFixtureView(view),view);
        assert.deepEqual(await page.locator('body').evaluate(body=>[getComputedStyle(body).backgroundColor,getComputedStyle(body).backgroundImage]),paint);
        assert.equal(await page.locator('#app-main').evaluate(main=>getComputedStyle(main).backgroundColor),'rgba(0, 0, 0, 0)');
        assert.equal(await page.locator('#dashboard-schedule-card').evaluate(card=>getComputedStyle(card).backgroundImage),face);
      }
      await page.evaluate(()=>showFixtureView('settings'));
    }
    assert.deepEqual(await page.evaluate(()=>writes[0]),{lumin_ui_background:'pearl'});
    await page.evaluate(async()=>{await handleUiBackgroundChange('sage');await handleThemeToggle(false);await handleThemeTintChange('rose');await handleUiScaleChange(90);});
    assert.equal(await page.locator('body').getAttribute('data-ui-background'),'sage','Theme, tint and scale preserve the background');
    await page.evaluate(()=>{resetUiTheme();syncUiThemeFromSession(currentSession);});
    assert.equal(await page.locator('body').getAttribute('data-ui-background'),'sage','Session restoration loads the saved choice');
    await page.evaluate(async()=>{remoteUser.user_metadata.lumin_ui_background='linen';await refreshUiThemePreference();});
    assert.equal(await page.locator('body').getAttribute('data-ui-background'),'linen','Reading account metadata loads another device choice');
    await page.evaluate(()=>applyUiTheme('raised','blue',100,'dots'));
    assert.deepEqual(await page.locator('[data-ui-background-preset]').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).backgroundSize)),['auto','auto','auto, auto','auto, auto','auto, auto','24px 24px']);
  });
  await t.test('failed and stale saves preserve the correct account background',async()=>{
    await page.evaluate(async()=>{applyUiTheme('raised','blue',100,'sage');failSave=true;await handleUiBackgroundChange('linen');failSave=false;});
    assert.equal(await page.locator('body').getAttribute('data-ui-background'),'sage');
    assert.match(await page.locator('#settings-theme-message').textContent(),/Could not save/);
    assert.equal(await page.locator('input[name="settings-app-background"]:checked').inputValue(),'sage');
    await page.evaluate(()=>{deferSave=true;window.pendingSave=handleUiBackgroundChange('mist');});
    assert.equal(await page.locator('input[name="settings-app-background"]:disabled').count(),6);
    await page.evaluate(async()=>{
      currentSession={user:{id:'user-2',user_metadata:{lumin_ui_theme:'raised',lumin_ui_background:'pearl'}}};
      syncUiThemeFromSession(currentSession);resolveSave();await pendingSave;deferSave=false;
    });
    assert.equal(await page.locator('body').getAttribute('data-ui-background'),'pearl','Old responses cannot replace the current account choice');
    assert.equal(await page.locator('input[name="settings-app-background"]:disabled').count(),0);
    await page.evaluate(()=>resetUiTheme());
    assert.equal(await page.locator('body').getAttribute('data-ui-background'),'default','Sign-out clears personal background choices');
    assert.equal(await page.evaluate(()=>userUiBackground({user_metadata:{lumin_ui_background:'url(evil)'}})),'default');
  });
  await t.test('mobile and RTL controls fit; dashboard shadows have unclipped gutters',async()=>{
    for(const viewport of [{width:1920,height:1080},{width:1440,height:900},{width:1024,height:768},{width:390,height:844},{width:320,height:568}])for(const dir of ['ltr','rtl']){
      await page.setViewportSize(viewport);
      await page.evaluate(dir=>{document.documentElement.dir=dir;applyUiTheme('raised','blue',100,'mist');showFixtureView('dashboard');},dir);
      assert.equal(await page.locator('#view-dashboard').evaluate(node=>getComputedStyle(node).overflow),'visible');
      if(viewport.width>=1024){
        const panel=await page.locator('#dashboard-schedule-card').boundingBox();
        assert.ok(panel.y+panel.height<=viewport.height-30,'Shadow has room to fade before the viewport edge');
        assert.equal(await page.locator('#dashboard-appointments-list').evaluate(node=>getComputedStyle(node).overflowY),'auto');
        await page.screenshot({path:path.join(shots,'dashboard-'+viewport.width+'-'+dir+'.png')});
      }
      await page.evaluate(()=>showFixtureView('settings'));
      const choices=await page.locator('.lumin-background-option').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().toJSON()));
      assert.ok(choices.every(box=>box.width>=44&&box.height>=44&&box.x>=0&&box.x+box.width<=viewport.width+1));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      if(viewport.width===1440||viewport.width===390)await page.locator('#settings-appearance-card').screenshot({path:path.join(shots,'appearance-'+viewport.width+'-'+dir+'.png')});
    }
    await page.locator('input[name="settings-app-background"][value="mist"]').focus();await page.keyboard.press('ArrowRight');
    await page.waitForFunction(()=>themeSaveRequest===null);
    assert.notEqual(await page.locator('input[name="settings-app-background"]:checked').inputValue(),'mist');
  });
  assert.deepEqual(errors,[]);
});
