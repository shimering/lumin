const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium,webkit}=require('playwright'),{PDFDocument}=require('pdf-lib'),root=path.resolve(__dirname,'..');

test('consent page frames, margins, first-page logos and Palmer symbols survive native and iPad printing',{timeout:120000},async t=>{
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><link rel="stylesheet" href="/lumin-app.css"><link rel="stylesheet" href="/vendor/quill/quill.core-2.0.2.css"><link rel="stylesheet" href="/lumin-consent-editor.css"><link rel="stylesheet" href="/lumin-consent-layout.css"></head><body><button id="print">Print</button><div id="editor"></div></body></html>');return;}
    const file=path.resolve(root,'.'+decodeURIComponent(pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':file.endsWith('.ttf')?'font/ttf':'application/javascript');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser=process.env.LUMIN_TEST_WEBKIT_PATH?await webkit.launch({headless:true,executablePath:process.env.LUMIN_TEST_WEBKIT_PATH}):await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||'chrome'});t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:1024,height:1000},hasTouch:true});
  await context.addInitScript(()=>{Object.defineProperty(navigator,'platform',{configurable:true,get:()=> 'MacIntel'});Object.defineProperty(navigator,'maxTouchPoints',{configurable:true,get:()=>5});window.print=()=>{};const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{if(blob.type==='application/pdf')window.fixturePdf=blob;return create(blob);};});
  const page=await context.newPage(),errors=[];context.on('page',view=>view.on('pageerror',error=>errors.push(error.message)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  for(const file of ['vendor/quill/quill-2.0.2.js','lumin-consent-document.js','lumin-consent-tables.js','lumin-consent-editor.js','lumin-consent-layout.js','lumin-consent-print.js'])await page.addScriptTag({path:path.join(root,file)});
  await page.evaluate(image=>{
    window.currentUiLanguage='ar';document.documentElement.lang='ar';document.documentElement.dir='rtl';
    window.db={from(){return {select(){return this;},eq(){return this;},async single(){return {data:{header_text_ar:'CLINIC HEADER',footer_text_ar:'CLINIC FOOTER',logo_visible:true},error:null};},async maybeSingle(){return {data:{logo_data_url:image},error:null};}};}};
    const ops=[{insert:'مواضع الزراعة: 6┘ ، └6 ، ┌5 ، 5┐\n'}];
    for(let index=0;index<48;index++)ops.push({insert:'تم شرح تفاصيل العلاج وخياراته والزيارات اللازمة للمريض. تمت مناقشة الرسوم وخطة المتابعة والإجابة عن الأسئلة.'},{insert:'\n',attributes:{lineSpacing:'1.5',direction:'rtl'}});
    window.record={language:'ar',title:'Consent layout',doctor_name:'Doctor',content:LuminConsentDocument.withPalmer({ops}),print_layout:{logo_visible:true,logo_width_mm:42,logo_align:'right',logo_offset_mm:3,logo_pages:'first',frame:'double',margin_top_mm:14,margin_bottom_mm:16,margin_left_mm:18,margin_right_mm:20}};
    document.querySelector('#print').onclick=()=>{window.printJob=LuminConsentPrint.print(record);};
    window.values={implant_teeth:'6┘ / └6'};
    window.editor=LuminConsentEditor.mount(document.querySelector('#editor'),{name:'body',label:'Consent',language:'ar',text:'الأسنان: {{implant_teeth}}',values:()=>values});
  },'data:image/png;base64,'+fs.readFileSync(path.join(root,'icons/dental-icon-v1-192.png')).toString('base64'));
  assert.equal(await page.locator('#editor .consent-palmer-token').count(),2);
  await page.evaluate(()=>{values.implant_teeth='┌5 / 5┐';editor.updateVariables(values);});
  assert.equal(await page.locator('#editor .consent-palmer-token').count(),2);
  assert.match(await page.evaluate(()=>editor.getText()),/┌5 \/ 5┐/,'Bound tooth variables update without losing their actual tooth labels');
  await page.evaluate(()=>{record.print_layout.signature_labels_ar={patient:'توقيع المريض المعدل'};record.print_layout.signature_divider=false;});
  const folder=path.join(os.tmpdir(),'lumin-consent-layout-print');fs.mkdirSync(folder,{recursive:true});
  for(const mode of ['first','all','hidden']){
    await page.evaluate(mode=>{record.print_layout.logo_pages=mode==='all'?'all':'first';record.print_layout.logo_visible=mode!=='hidden';},mode);
    const popup=page.waitForEvent('popup');await page.locator('#print').click();const view=await popup;await view.waitForFunction(()=>document.documentElement.dataset.consentPrintPrepared==='true',null,{timeout:60000});await page.evaluate(()=>window.printJob);
    assert.match(await view.locator('#consent-print-root>.consent-copy .consent-signature-block').innerText(),/توقيع المريض المعدل/);
    assert.equal(await view.locator('#consent-print-root>.consent-copy .consent-signature-block').evaluate(node=>getComputedStyle(node).borderTopStyle),'none');
    const sheets=view.locator('.consent-native-sheet');const count=await sheets.count();assert.ok(count>=2,'A long consent must span multiple physical pages');
    await view.emulateMedia({media:'print'});
    for(let index=0;index<count;index++){
      const sheet=sheets.nth(index),logo=sheet.locator('[data-consent-letterhead-logo]');
      assert.equal(await sheet.locator('.consent-paper-frame.is-double').count(),1,'Every printed page includes the selected frame');
      if(mode==='hidden')assert.equal(await logo.count(),0);else assert.equal(await logo.isVisible(),mode==='all'||index===0,'The logo obeys the first-page/all-pages choice');
      const margins=await sheet.evaluate(node=>{const page=node.getBoundingClientRect(),clip=node.querySelector('.consent-pdf-clip').getBoundingClientRect(),footer=node.querySelector('.consent-pdf-footer').getBoundingClientRect();return {left:clip.left-page.left,right:page.right-clip.right,bottom:page.bottom-footer.bottom};});
      for(const [key,mm] of [['left',18],['right',20],['bottom',16]])assert.ok(Math.abs(margins[key]-mm*96/25.4)<.5,`${key} margin must retain its physical millimeter value`);
    }
    assert.equal(await view.locator('#consent-print-root>.consent-copy .consent-palmer-token svg').count(),4,'All quadrants retain their chart-style symbols');
    const encoded=await view.evaluate(async()=>{let value='';for(const byte of new Uint8Array(await fixturePdf.arrayBuffer()))value+=String.fromCharCode(byte);return btoa(value);});
    const bytes=Buffer.from(encoded,'base64'),pdf=await PDFDocument.load(bytes);assert.equal(pdf.getPageCount(),count,'Native and iPad PDF use the same pagination');
    fs.writeFileSync(path.join(folder,`ipad-${mode}.pdf`),bytes);
    if(!process.env.LUMIN_TEST_WEBKIT_PATH)await view.pdf({path:path.join(folder,`native-${mode}.pdf`),format:'A4',preferCSSPageSize:true,printBackground:true});
    await view.emulateMedia({media:'screen'});await view.screenshot({path:path.join(folder,`layout-${mode}.png`),fullPage:true});await view.close();
  }
  assert.deepEqual(errors,[]);console.log('Consent layout previews:',folder);
});
