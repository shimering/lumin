const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium,webkit}=require('playwright'),{PDFDocument}=require('pdf-lib'),root=path.resolve(__dirname,'..');

test('iPad consent printing opens a locally prepared PDF with saved fonts, spacing and table dimensions',{timeout:120000},async t=>{
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><textarea>Original consent editor</textarea><button id="print">Print consent</button>');return;}
    const file=path.resolve(root,'.'+decodeURIComponent(pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':file.endsWith('.ttf')?'font/ttf':'application/javascript');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser=process.env.LUMIN_TEST_WEBKIT_PATH?await webkit.launch({headless:true,executablePath:process.env.LUMIN_TEST_WEBKIT_PATH}):await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||'chrome'});t.after(()=>browser.close());
  const folder=path.join(os.tmpdir(),'lumin-consent-ipad-print');fs.mkdirSync(folder,{recursive:true});
  for(const [width,language,desktopIdentity] of [[820,'ar',false],[1024,'en',true]]){
    const context=await browser.newContext({hasTouch:true,viewport:{width,height:1000},userAgent:desktopIdentity?'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15':'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'});
    const errors=[],external=[];
    await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith('http://127.0.0.1:')||!/^https?:/.test(url))return route.continue();external.push(url);return route.abort();});
    await context.addInitScript(()=>{
      Object.defineProperty(navigator,'platform',{configurable:true,get:()=> 'MacIntel'});Object.defineProperty(navigator,'maxTouchPoints',{configurable:true,get:()=>5});
      window.printCalls=0;window.print=()=>{window.printCalls++;dispatchEvent(new Event('afterprint'));};
      const createObjectURL=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{if(blob.type==='application/pdf')window.fixturePdfBlob=blob;return createObjectURL(blob);};
      let renderer;Object.defineProperty(window,'html2canvas',{configurable:true,get:()=>renderer,set(value){renderer=(element,options)=>{
        const clip=element.querySelector('.consent-pdf-clip').getBoundingClientRect(),walker=document.createTreeWalker(element.querySelector('.consent-pdf-flow'),NodeFilter.SHOW_TEXT),cuts=[];
        while(walker.nextNode()){
          // Amiri's font bounding box includes large unused ascender/descender
          // space outside the line box. Its actual glyphs are checked in previews.
          if(!walker.currentNode.textContent.trim()||getComputedStyle(walker.currentNode.parentElement).fontFamily.includes('Amiri'))continue;const range=document.createRange();range.selectNodeContents(walker.currentNode);
          for(const rect of range.getClientRects())for(const edge of [clip.top,clip.bottom])if(rect.top<edge-.5&&rect.bottom>edge+.5)cuts.push({top:rect.top,bottom:rect.bottom,edge});
        }
        (window.fixturePageCuts??=[]).push(cuts);return value(element,options);
      };}});
      window.addEventListener('error',event=>{window.lastError=event.message;});
    });
    context.on('page',view=>{view.on('pageerror',error=>errors.push(error.message));view.on('console',message=>{if(message.type()==='error')console.log('Print console:',message.text());});});
    const page=await context.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
    for(const file of ['lumin-consent-document.js','lumin-consent-print.js'])await page.addScriptTag({path:path.join(root,file)});
    await page.evaluate(language=>{
      const ar=language==='ar',ops=[{insert:ar?'موافقة زراعة الأسنان':'Dental implant consent',attributes:{font:ar?'Amiri':'Georgia',size:'24px',bold:true}},{insert:'\n',attributes:{direction:ar?'rtl':'ltr',align:'center',lineSpacing:'1.25'}},{insert:ar?'الاسم:     مريض تجريبي':'Name:     Test patient',attributes:{font:'Arial',size:'16px'}},{insert:'\n',attributes:{lineSpacing:'2'}}];
      for(let row=0;row<32;row++)for(let col=0;col<2;col++){
        ops.push({insert:col?(ar?'قيمة الرسوم المتفق عليها':'Agreed treatment fee'):(ar?'جلسة الزراعة والتركيب':'Implant visit'),attributes:{font:ar?'Amiri':'Georgia',size:'18px'}});
        ops.push({insert:'\n',attributes:{table:'row-'+row,cellWidth:col?'120px':'220px',cellHeight:row%2?'auto':'64px',lineSpacing:'1.25',direction:ar?'rtl':'ltr'}});
      }
      ops.push({insert:'\n'});
      for(let col=0;col<3;col++)ops.push({insert:ar?'جدول عريض':'Wide table'},{insert:'\n',attributes:{table:'wide-row',cellWidth:'640px',cellHeight:'44px'}});
      // This paragraph is taller than one sheet and must split between lines.
      ops.push({insert:(ar?'تم شرح تفاصيل العلاج والمواعيد والتكلفة للمريض. ':'The treatment, appointment schedule and agreed fee have been explained. ').repeat(160),attributes:{font:ar?'Amiri':'Georgia',size:'16px'}});
      ops.push({insert:'\n',attributes:{lineSpacing:'1.5'}});
      ops.push({insert:'END OF CONSENT',attributes:{bold:true}},{insert:'\n'});
      window.record={title:ar?'موافقة الأسنان':'Dental consent',language,content:LuminConsentDocument.normalize({ops}),doctor_name:'Dr. Test'};
      window.db={from(){return {select(){return this;},eq(){return this;},async single(){return {data:{header_text_en:'CLINIC HEADER',header_text_ar:'CLINIC HEADER',footer_text_en:'CLINIC FOOTER',footer_text_ar:'CLINIC FOOTER',logo_visible:false},error:null};},async maybeSingle(){return {data:{logo_data_url:null},error:null};}};}};
      document.querySelector('#print').onclick=()=>{window.job=LuminConsentPrint.print(record);};
    },language);
    const popup=page.waitForEvent('popup');await page.locator('#print').click();const view=await popup;
    await view.waitForFunction(()=>document.documentElement.dataset.consentPrintPrepared==='true',null,{timeout:60000});await page.evaluate(()=>window.job);
    assert.equal(await view.evaluate(()=>printCalls),0,'iPad printing must not depend on an ignored automatic window.print call');
    assert.equal(await view.locator('[data-print-pdf]').isVisible(),true,await view.locator('[data-print-status]').innerText());
    assert.equal(await view.locator('[data-print-consent]').isEnabled(),true);
    assert.equal(await view.locator('.consent-pdf-stage').count(),0,'Temporary page/canvas resources are released');
    assert.deepEqual(await view.evaluate(()=>fixturePageCuts.flat()),[],'Every PDF page boundary must fall between complete text lines');
    for(const media of ['screen','print']){
      await view.emulateMedia({media});
      const metrics=await view.locator('.consent-document-table').first().evaluate(table=>({width:table.getBoundingClientRect().width,columns:[...table.rows[0].cells].map(cell=>cell.getBoundingClientRect().width),height:table.rows[0].getBoundingClientRect().height,padding:getComputedStyle(table.rows[0].cells[0]).paddingInlineStart}));
      assert.ok(Math.abs(metrics.width-340)<2,`${media}: the 340px saved table must not stretch across the sheet (${metrics.width})`);
      assert.ok(Math.abs(metrics.columns[0]/metrics.columns[1]-220/120)<.03);
      assert.ok(metrics.height>=63,'A saved row height is retained as the minimum, allowing wrapped text to grow');assert.equal(metrics.padding,'12px');
      assert.equal(await view.locator('.consent-document-table tr').first().evaluate(row=>row.style.height),'64px');
      assert.equal(await view.locator('.consent-document-table td').first().evaluate(cell=>getComputedStyle(cell).lineHeight),'17.5px');
      assert.equal(await view.locator('.consent-document-table td span').first().evaluate(span=>getComputedStyle(span).fontSize),'18px');
      assert.equal(await view.locator('.consent-document-table').last().evaluate(table=>table.getBoundingClientRect().width<=table.parentElement.getBoundingClientRect().width+1),true,'Oversized tables fit the available paper width');
      assert.equal(await view.locator('.consent-print-page>tbody>tr').nth(1).locator('p').evaluate(node=>getComputedStyle(node).whiteSpace),'pre-wrap');
    }
    await view.emulateMedia({media:'screen'});
    const encoded=await view.evaluate(async()=>{const bytes=new Uint8Array(await fixturePdfBlob.arrayBuffer());let data='';for(const byte of bytes)data+=String.fromCharCode(byte);return btoa(data);});
    const bytes=Buffer.from(encoded,'base64'),pdf=await PDFDocument.load(bytes);
    assert.ok(pdf.getPageCount()>=4,'Long consents must retain every table row and split long paragraphs onto further sheets');
    assert.equal(pdf.catalog.getOrCreateViewerPreferences().getPrintScaling(),'None');
    for(const pdfPage of pdf.getPages()){assert.ok(Math.abs(pdfPage.getWidth()-595.28)<.1);assert.ok(Math.abs(pdfPage.getHeight()-841.89)<.1);}
    fs.writeFileSync(path.join(folder,`consent-ipad-${language}.pdf`),bytes);
    await view.screenshot({path:path.join(folder,`consent-ipad-${language}.png`),fullPage:true});
    if(process.env.LUMIN_TEST_WEBKIT_PATH)await view.evaluate(()=>document.querySelector('[data-print-pdf]').addEventListener('click',event=>{event.preventDefault();window.pdfOpenRequests=(window.pdfOpenRequests||0)+1;}));
    for(let attempt=0;attempt<2;attempt++){
      if(process.env.LUMIN_TEST_WEBKIT_PATH){
        // Windows WebKit has no PDF viewer. Check the same direct-tap link action;
        // Chromium below exercises the real local PDF viewer navigation.
        await view.locator('[data-print-consent]').click();assert.equal(await view.evaluate(()=>pdfOpenRequests),attempt+1);
      }else{
        const opened=context.waitForEvent('page');await view.locator('[data-print-consent]').click();const pdfView=await opened;
        await pdfView.waitForURL('blob:**',{waitUntil:'commit'});assert.ok(pdfView.url().startsWith('blob:'),'The print tap opens the already prepared local PDF');
        await pdfView.close();
      }
    }
    assert.equal(await page.locator('textarea').inputValue(),'Original consent editor');
    if(desktopIdentity){
      await context.route('**/lumin-consent-pdf.mjs?*',route=>route.fulfill({contentType:'application/javascript',body:'export async function consentPdf(){throw new Error("Fixture PDF failure");}'}));
      const failedPopup=page.waitForEvent('popup');await page.locator('#print').click();const failedView=await failedPopup;
      await failedView.waitForFunction(()=>document.documentElement.dataset.consentPrintPrepared==='true');await page.evaluate(()=>window.job);
      assert.equal(await failedView.locator('[data-print-pdf]').isVisible(),false);
      assert.equal(await failedView.locator('[data-print-consent]').isEnabled(),true,'A PDF error must retain a usable native print action');
      await failedView.locator('[data-print-consent]').click();assert.equal(await failedView.evaluate(()=>printCalls),1);
      assert.equal(await failedView.locator('#consent-print-root').isVisible(),true);await failedView.close();
    }
    assert.deepEqual(errors,[]);assert.deepEqual(external,[],'PDF preparation uses bundled assets and makes no external requests');
    await context.close();
  }
  console.log('iPad consent PDF previews:',folder);
});
