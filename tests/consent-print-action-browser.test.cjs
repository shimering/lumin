const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright'),{PDFDocument}=require('pdf-lib'),root=path.resolve(__dirname,'..');

test('consent exports a PDF on every device, defers opening until visible, downloads and retries without native printing',{timeout:90000},async t=>{
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><textarea>Original consent editor</textarea><button id="print">Export PDF</button>');return;}
    const file=path.resolve(root,'.'+decodeURIComponent(pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':file.endsWith('.ttf')?'font/ttf':'application/javascript');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||'chrome'});t.after(()=>browser.close());
  const context=await browser.newContext({hasTouch:true,viewport:{width:820,height:940}}),errors=[];
  context.on('page',view=>view.on('pageerror',error=>errors.push(error.message)));
  await context.addInitScript(()=>{
    window.printCalls=0;window.pdfOpenRequests=0;window.fixtureHidden=true;window.capturePdfOpen=true;
    Object.defineProperty(Document.prototype,'visibilityState',{get:()=>window.fixtureHidden?'hidden':'visible'});
    window.print=()=>{window.printCalls++;};
    window.addEventListener('click',event=>{if(event.target.closest?.('[data-print-pdf]')){window.pdfOpenRequests++;if(window.capturePdfOpen)event.preventDefault();}},true);
  });
  const page=await context.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
  for(const file of ['lumin-consent-document.js','lumin-consent-print.js'])await page.addScriptTag({path:path.join(root,file)});
  await page.evaluate(()=>{
    window.addEventListener('message',event=>{if(event.data==='lumin-consent-print-ready')event.stopImmediatePropagation();});
    window.db={from(){return {select(){return this;},eq(){return this;},async single(){return {data:{logo_visible:false},error:null};},async maybeSingle(){return {data:{logo_data_url:null},error:null};}};}};
    document.querySelector('#print').onclick=()=>{window.job=LuminConsentPrint.print({title:'Consent / test',language:window.printLanguage,body:window.printLanguage==='ar'?'نص الموافقة':'Consent wording',doctor_name:'Doctor'});};
  });
  for(const [width,language] of [[390,'ar'],[820,'en'],[1320,'ar']]){
    await page.setViewportSize({width,height:940});await page.evaluate(language=>{window.printLanguage=language;},language);
    const popup=page.waitForEvent('popup');await page.locator('#print').click();const view=await popup;await view.setViewportSize({width,height:940});
    await view.waitForFunction(()=>document.documentElement.dataset.consentPrintPrepared==='true');await page.evaluate(()=>window.job);
    assert.equal(await view.evaluate(()=>document.documentElement.dataset.consentPdfReady),'true');
    assert.equal(await view.evaluate(()=>pdfOpenRequests),0,'A background tab waits until visible');
    assert.equal(await view.locator('[data-print-consent]').isEnabled(),true);
    const bytes=Buffer.from(await view.evaluate(async()=>Array.from(new Uint8Array(await (await opener.fetch(document.querySelector('[data-print-pdf]').href)).arrayBuffer()))));
    const pdf=await PDFDocument.load(bytes);assert.equal(pdf.getPageCount(),1);assert.equal(pdf.getTitle(),'Consent / test');assert.equal(pdf.catalog.getOrCreateViewerPreferences().getPrintScaling(),'None');
    await view.evaluate(race=>{fixtureHidden=false;document.dispatchEvent(new Event('visibilitychange'));if(race)document.querySelector('[data-print-consent]').click();},width===1320);
    await view.waitForFunction(()=>pdfOpenRequests===1);await view.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await view.evaluate(()=>pdfOpenRequests),1,'A tap cancels a queued automatic open');
    assert.equal(await view.evaluate(()=>printCalls),0,'No browser HTML print dialog is used');
    assert.equal(await view.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const downloading=view.waitForEvent('download');await view.locator('[data-download-pdf]').click();const download=await downloading;
    assert.equal(download.suggestedFilename(),'Consent   test.pdf');assert.equal(await download.failure(),null);
    await view.locator('[data-print-consent]').click();assert.equal(await view.evaluate(()=>pdfOpenRequests),2);
    await view.emulateMedia({media:'print'});assert.equal(await view.locator('[data-consent-print-controls]').isVisible(),false);await view.emulateMedia({media:'screen'});
    if(width===1320){
      const url=await view.locator('[data-print-pdf]').getAttribute('href');await view.evaluate(()=>{capturePdfOpen=false;});
      await view.locator('[data-print-consent]').click();await view.waitForURL('blob:**',{waitUntil:'commit'});
      assert.equal(view.url(),url,'The already reserved tab opens the actual generated PDF');
      // The editor retains the file URL after the generating document navigates away.
      assert.equal(await page.evaluate(async url=>(await fetch(url)).status,url),200);
    }
    await view.close();assert.equal(await page.locator('textarea').inputValue(),'Original consent editor');
  }
  // A transient renderer error keeps a retry button; the next attempt produces the file.
  await context.route('**/lumin-consent-pdf.mjs?*',route=>{
    const source=fs.readFileSync(path.join(root,'lumin-consent-pdf.mjs'),'utf8').replace('export async function consentPdf(document) {','export async function consentPdf(document) { if(!window.fixtureRetried){window.fixtureRetried=true;throw new Error("Fixture renderer failure");}');
    return route.fulfill({contentType:'application/javascript',body:source});
  });
  await page.evaluate(()=>{window.printLanguage='en';});const popup=page.waitForEvent('popup');await page.locator('#print').click();const view=await popup;
  await view.waitForFunction(()=>document.documentElement.dataset.consentPrintPrepared==='true');assert.equal(await view.evaluate(()=>document.documentElement.dataset.consentPdfReady),'false');
  assert.match(await view.locator('[data-print-consent]').innerText(),/Retry PDF/);assert.equal(await view.locator('[data-download-pdf]').isVisible(),false);
  await view.locator('[data-print-consent]').click();await view.waitForFunction(()=>document.documentElement.dataset.consentPdfReady==='true');
  assert.equal(await view.evaluate(()=>pdfOpenRequests),1);assert.equal(await view.evaluate(()=>printCalls),0);
  await view.close();assert.deepEqual(errors,[]);
});
