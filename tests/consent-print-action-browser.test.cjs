const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright'),root=path.resolve(__dirname,'..');
test('consent print tab defers automatic printing until visible and supports a direct tablet print tap',{timeout:60000},async t=>{
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><textarea>Original consent editor</textarea><button id="print">Print consent</button>');return;}
    const file=path.resolve(root,'.'+decodeURIComponent(pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':file.endsWith('.ttf')?'font/ttf':'application/javascript');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||'chrome'});t.after(()=>browser.close());
  const context=await browser.newContext({hasTouch:true,viewport:{width:820,height:940}});
  await context.addInitScript(()=>{
    window.printCalls=0;window.printTaps=[];window.fixtureHidden=true;
    Object.defineProperty(document,'visibilityState',{get:()=>window.fixtureHidden?'hidden':'visible'});
    window.print=()=>{window.printCalls++;if(window.lastPrintTap)window.printTaps.push({...window.lastPrintTap,active:navigator.userActivation.isActive});window.dispatchEvent(new Event('afterprint'));};
  });
  const page=await context.newPage(),errors=[];context.on('page',view=>view.on('pageerror',error=>errors.push(error.message)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  for(const file of ['lumin-consent-document.js','lumin-consent-print.js'])await page.addScriptTag({path:path.join(root,file)});
  await page.evaluate(()=>{
    // Simulate a mobile tab activation dropping its initial ready message.
    window.addEventListener('message',event=>{if(event.data==='lumin-consent-print-ready')event.stopImmediatePropagation();});
    window.db={from(){return {select(){return this;},eq(){return this;},async single(){return {data:{logo_visible:false},error:null};},async maybeSingle(){return {data:{logo_data_url:null},error:null};}};}};
    document.querySelector('#print').onclick=()=>{window.job=LuminConsentPrint.print({title:'Consent',language:window.printLanguage,body:window.printLanguage==='ar'?'نص الموافقة':'Consent wording',doctor_name:'Doctor'});};
  });
  for(const [width,language] of [[390,'ar'],[820,'en'],[1320,'ar']]){
    await page.setViewportSize({width,height:940});await page.evaluate(language=>{window.printLanguage=language;},language);
    const popup=page.waitForEvent('popup');await page.locator('#print').click();const view=await popup;await view.setViewportSize({width,height:940});
    await view.waitForFunction(()=>document.documentElement.dataset.consentPrintPrepared==='true');await page.evaluate(()=>window.job);
    assert.equal(await view.evaluate(()=>printCalls),0,'A background print tab must not issue an ignored automatic print request');
    assert.equal(await view.locator('[data-print-consent]').isEnabled(),true);
    await view.evaluate(race=>{fixtureHidden=false;document.dispatchEvent(new Event('visibilitychange'));if(race)document.querySelector('[data-print-consent]').click();},width===1320);await view.waitForFunction(()=>printCalls===1);
    await view.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await view.evaluate(()=>printCalls),1,'A manual tap cancels a queued automatic print request');
    assert.equal(await view.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await view.evaluate(()=>document.addEventListener('click',event=>{if(event.target.closest('[data-print-consent]'))window.lastPrintTap={trusted:event.isTrusted,active:navigator.userActivation.isActive};},true));
    await view.locator('[data-print-consent]').click();assert.equal(await view.evaluate(()=>printCalls),2);
    assert.deepEqual(await view.evaluate(()=>printTaps),[{trusted:true,active:true}],'Manual printing is requested synchronously from a trusted user tap');
    assert.equal(await view.locator('#consent-print-root').isVisible(),true,'Early afterprint must retain the consent');
    await view.locator('[data-print-consent]').click();assert.equal(await view.evaluate(()=>printCalls),3,'The print action remains available after cancelling a print dialog');
    if(width===390)await view.screenshot({path:path.join(os.tmpdir(),'lumin-consent-print-action-ar.png'),fullPage:true});
    await view.emulateMedia({media:'print'});assert.equal(await view.locator('[data-consent-print-controls]').isVisible(),false);assert.equal(await view.locator('button:visible').count(),0);
    await view.emulateMedia({media:'screen'});const closed=view.waitForEvent('close');await view.locator('[data-print-back]').click().catch(error=>{if(!view.isClosed())throw error;});await closed;
    assert.equal(await page.locator('textarea').inputValue(),'Original consent editor');
  }
  assert.deepEqual(errors,[]);
});
