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
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}
const navStart = html.indexOf('      // Synchronously update navigation rail');
const navUpdate = html.slice(navStart, html.indexOf('      syncNavMountLocation();', navStart));

test('one navbar highlight slides through stationary icon boxes, retargets smoothly, and fits RTL and scaled layouts', {skip: !chromium && 'Playwright unavailable'}, async t => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')); return; }
    const target = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', target.endsWith('.css') ? 'text/css' : 'application/javascript'); res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport: {width:1440, height:1000}, reducedMotion:'reduce'}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  for (const file of ['vendor/lucide.min.js', 'lumin-nav-motion.js', 'lumin-mobile-nav.js']) await page.addScriptTag({path:path.join(root, file)});
  await page.addScriptTag({content: `
    let currentUiLanguage='en', mobileHeaderOverlayOpen=false;
    function hasPageAccess(){return true;} function canOpenPatientsPage(){return true;}
    function closeMobileHeaderOverlay(){} function openAppointmentsView(){switchView('appointments');}
    function toggleQuickCreateMenu(){}
    function switchView(viewName) { ${navUpdate} syncNavMountLocation(); }
    ${source('syncNavMountLocation')}
    ${source('updateAppViewportDimensions')}
    document.getElementById('auth-gate').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');
    const mobileNavigation=LuminMobileNav.create({source:document.getElementById('app-primary-nav'),shell:document.getElementById('app-shell'),
      getLanguage:()=>currentUiLanguage,onQuickCreate(){},closeQuickCreate(){},onLayout(){}});
    window.addEventListener('resize',()=>{updateAppViewportDimensions();syncNavMountLocation();});
    document.dispatchEvent(new Event('DOMContentLoaded'));
    switchView('dashboard');
    if(window.lucide)lucide.createIcons();
  `});
  const screenshots = path.join(os.tmpdir(), 'lumin-nav-highlight-preview'); fs.mkdirSync(screenshots, {recursive:true});
  const frames = () => page.evaluate(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  for (const viewport of [{width:1440,height:1000},{width:834,height:1112},{width:390,height:844},{width:320,height:568}]) {
    await page.setViewportSize(viewport);
    for (const theme of ['flat','raised']) for (const dir of ['ltr','rtl']) for (const scale of [.8,1.25]) {
      await page.emulateMedia({reducedMotion:'reduce'});
      await page.evaluate(({theme,dir,scale})=>{
        document.body.classList.toggle('lumin-raised',theme==='raised');document.body.dataset.uiTint='violet';
        document.documentElement.dir=dir;currentUiLanguage=dir==='rtl'?'ar':'en';
        document.documentElement.style.zoom=String(scale);document.documentElement.style.setProperty('--lumin-app-scale',String(scale));
        updateAppViewportDimensions();window.scrollTo(0,0);
        switchView('dashboard');
      },{theme,dir,scale});
      await frames();
      const phone = viewport.width < 768;
      const selector = phone ? '#lumin-mobile-nav .lumin-mobile-nav-bar' : '#app-primary-nav';
      const ids = phone ? ['mobile-nav-dashboard','mobile-nav-whatsapp','mobile-nav-patients'] : ['nav-btn-dashboard','nav-btn-whatsapp','nav-btn-patients'];
      await page.evaluate(selector=>{window.movingHighlight=document.querySelector(selector+' > .lumin-nav-highlight');}, selector);
      const start = await page.locator(selector+' > .lumin-nav-highlight').boundingBox();
      const positions = await page.locator(selector+' > button').evaluateAll(buttons=>buttons.filter(button=>button.getClientRects().length).map(button=>({id:button.id,box:button.getBoundingClientRect().toJSON()})));
      assert.ok(start,JSON.stringify({viewport,theme,dir,scale}));
      await page.emulateMedia({reducedMotion:'no-preference'});
      await page.locator('#'+ids[1]).click();
      await frames();
      const movement = await page.evaluate(selector=>{
        const element=document.querySelector(selector+' > .lumin-nav-highlight'), animation=element.getAnimations()[0];
        if(!animation)return null;
        animation.pause();animation.currentTime=210;
        return {same:element===window.movingHighlight,rect:element.getBoundingClientRect().toJSON(),opacity:getComputedStyle(element).opacity,count:document.querySelectorAll(selector+' > .lumin-nav-highlight').length};
      },selector);
      assert.ok(movement,JSON.stringify({viewport,theme,dir,scale}));
      assert.equal(movement.same,true,'Mobile rerenders keep the same highlight element');
      assert.equal(movement.count,1);assert.equal(movement.opacity,'1','The highlight stays visible throughout the slide');
      const destination = await page.locator('#'+ids[1]).boundingBox();
      const axis = phone || viewport.width < 1024 ? 'x' : 'y';
      assert.ok(movement.rect[axis] > Math.min(start[axis],destination[axis])+1 && movement.rect[axis] < Math.max(start[axis],destination[axis])-1,'Highlight passes through the space between icons');
      const after = await page.locator(selector+' > button').evaluateAll(buttons=>buttons.filter(button=>button.getClientRects().length).map(button=>({id:button.id,box:button.getBoundingClientRect().toJSON()})));
      for(let i=0;i<positions.length;i++)for(const key of ['x','y','width','height'])assert.ok(Math.abs(positions[i].box[key]-after[i].box[key])<.8,'Icon boxes stay stationary');
      if(theme==='raised' && dir==='ltr' && scale===1.25) {
        await page.evaluate(selector=>{document.querySelector(selector+' > .lumin-nav-highlight').getAnimations()[0].currentTime=90;},selector);
        await page.screenshot({path:path.join(screenshots,'navbar-moving-'+viewport.width+'.png')});
      }
      const retarget = await page.evaluate(({selector,id})=>{
        const element=document.querySelector(selector+' > .lumin-nav-highlight'), old=element.getAnimations()[0];
        old.currentTime=90;const before=element.getBoundingClientRect().toJSON();
        document.getElementById(id).click();LuminNavHighlight.create(document.querySelector(selector)).refresh();
        const animation=element.getAnimations()[0];animation.pause();animation.currentTime=0;
        return {before,after:element.getBoundingClientRect().toJSON()};
      },{selector,id:ids[2]});
      for(const key of ['x','y'])assert.ok(Math.abs(retarget.before[key]-retarget.after[key])<.8,'Rapid navigation continues from the visible position');
      await page.evaluate(selector=>document.querySelector(selector+' > .lumin-nav-highlight').getAnimations()[0].finish(),selector);
      await frames();
      const final = await page.locator(selector+' > .lumin-nav-highlight').boundingBox(), target = await page.locator('#'+ids[2]).boundingBox();
      for(const key of ['x','y','width','height'])assert.ok(Math.abs(final[key]-target[key])<1.5,JSON.stringify({viewport,theme,dir,scale,key,final,target}));
      await page.emulateMedia({reducedMotion:'reduce'});
      await page.evaluate(()=>switchView('dashboard'));await frames();
      assert.equal(await page.locator(selector+' > .lumin-nav-highlight').evaluate(node=>node.getAnimations().length),0,'Reduced motion switches immediately');
      if(theme==='raised' && dir==='ltr' && scale===1.25)await page.screenshot({path:path.join(screenshots,'navbar-'+viewport.width+'.png')});
    }
  }
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{document.documentElement.style.zoom='1';document.documentElement.style.setProperty('--lumin-app-scale','1');switchView('settings');});
  await frames();
  assert.equal(await page.locator('#mobile-nav-more').getAttribute('aria-current'),'page');
  const more = await page.locator('#mobile-nav-more').boundingBox(), highlight = await page.locator('.lumin-mobile-nav-bar > .lumin-nav-highlight').boundingBox();
  assert.ok(Math.abs(more.x-highlight.x)<1 && Math.abs(more.width-highlight.width)<1,'Pages inside More highlight the More box');
  await page.evaluate(()=>{document.getElementById('nav-btn-settings').classList.add('hidden');mobileNavigation.refresh();});
  await frames();
  assert.equal(await page.locator('.lumin-mobile-nav-bar > .lumin-nav-highlight').isVisible(),false,'Restricted destinations never retain a highlight');
  assert.deepEqual(errors,[]);
});
