const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium,webkit}=require('playwright'),root=path.resolve(__dirname,'..');

test('printed consent matches the actual draft table, typography, paragraph gaps and list positions',{timeout:90000},async t=>{
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/favicon.ico'){res.writeHead(204).end();return;}
    if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'+['lumin-app.css','lumin-theme.css','lumin-consents.css','vendor/quill/quill.core-2.0.2.css','lumin-consent-editor.css'].map(file=>`<link rel="stylesheet" href="/${file}">`).join('')+'</head><body class="lumin-raised"><main style="padding:24px;max-width:1240px;margin:auto"><div id="editor"></div><button id="print">Print</button></main></body></html>');return;}
    const file=path.resolve(root,'.'+decodeURIComponent(pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':file.endsWith('.ttf')?'font/ttf':'application/javascript');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser=process.env.LUMIN_TEST_WEBKIT_PATH?await webkit.launch({headless:true,executablePath:process.env.LUMIN_TEST_WEBKIT_PATH}):await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||'chrome'});t.after(()=>browser.close());
  const apple=Boolean(process.env.LUMIN_TEST_APPLE_TOUCH),context=await browser.newContext({viewport:{width:1320,height:1000},hasTouch:apple});
  await context.addInitScript(apple=>{
    window.print=()=>{};
    if(apple){Object.defineProperty(navigator,'platform',{configurable:true,get:()=> 'MacIntel'});Object.defineProperty(navigator,'maxTouchPoints',{configurable:true,get:()=>5});}
    const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{if(blob.type==='application/pdf')window.fixturePdfBlob=blob;return create(blob);};
    let renderer;Object.defineProperty(window,'html2canvas',{configurable:true,get:()=>renderer,set(value){renderer=(element,options)=>{
      const metrics=element=>{const table=element.querySelector('.consent-pdf-flow table');return {width:table.getBoundingClientRect().width,columns:[...table.rows[0].cells].map(cell=>cell.getBoundingClientRect().width)};};
      window.fixtureStageTables=[metrics(element)];const onclone=options.onclone;
      return value(element,{...options,onclone(clone){onclone(clone);fixtureStageTables.push(metrics(clone.querySelector('.consent-pdf-stage')));}});
    };}});
  },apple);
  context.on('page',view=>view.on('console',message=>{if(message.type()==='error')console.log('Print comparison:',message.text());}));
  const page=await context.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
  for(const file of ['vendor/quill/quill-2.0.2.js','vendor/dompurify/purify-3.4.17.min.js','lumin-consent-document.js','lumin-consent-tables.js','lumin-consent-editor.js','lumin-consent-print.js'])await page.addScriptTag({path:path.join(root,file)});
  const inspect=node=>{
    const tables=[...node.querySelectorAll('table:not([role])')],table=tables[0],first=table.rows[0].cells[0].getBoundingClientRect();
    const blocks=[...node.querySelectorAll('p,li')].filter(item=>!item.closest('table:not([role])'));
    const style=node=>{const s=getComputedStyle(node);return Object.fromEntries(['fontFamily','fontSize','fontWeight','lineHeight','whiteSpace','letterSpacing','paddingInlineStart','paddingInlineEnd','marginTop','marginBottom','direction','textAlign'].map(key=>[key,s[key]]));};
    return {width:table.getBoundingClientRect().width,columns:[...table.rows[0].cells].map(cell=>cell.getBoundingClientRect().width),rows:tables.flatMap(table=>[...table.rows].map(row=>row.getBoundingClientRect().height)),cells:tables.flatMap(table=>[...table.querySelectorAll('td')].map(style)),blocks:blocks.map(block=>({text:block.textContent.replace(/\ufeff/g,''),top:block.getBoundingClientRect().top-first.top,height:block.getBoundingClientRect().height,style:style(block)}))};
  };
  const folder=path.join(os.tmpdir(),'lumin-consent-draft-match');fs.mkdirSync(folder,{recursive:true});
  for(const language of ['ar','en']){
    await page.evaluate(language=>{
      window.currentUiLanguage=language;document.documentElement.lang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';
      const ar=language==='ar',ops=[];
      for(let row=0;row<6;row++)for(let col=0;col<2;col++){
        ops.push({insert:col?(ar?'قيمة تجريبية':'Example value'):(ar?'بيانات النموذج':'Form details'),attributes:{font:'Arial',size:'10px'}});
        ops.push({insert:'\n',attributes:{table:'row-'+row,cellWidth:col?'309px':'160px',cellHeight:'auto',lineSpacing:'1',direction:ar?'rtl':'ltr'}});
      }
      for(let section=0;section<2;section++){
        if(section===0)ops.push({insert:ar?'الأسنان: 6┘ / └6':'Teeth: 6┘ / └6',attributes:{font:'Arial',size:'10px'}},{insert:'\n',attributes:{lineSpacing:'1.25',direction:ar?'rtl':'ltr'}});
        ops.push({insert:ar?'شرح العلاج':'Treatment explanation',attributes:{font:'Arial',size:'12px',bold:true}},{insert:'\n',attributes:{lineSpacing:'1.25',direction:ar?'rtl':'ltr'}});
        ops.push({insert:ar?'تم شرح تفاصيل العلاج والمواعيد والتكلفة.':'The treatment, appointments and fee were explained.',attributes:{font:'Arial',size:'10px'}},{insert:'\n',attributes:{lineSpacing:'1.25',direction:ar?'rtl':'ltr'}});
        for(let item=0;item<5;item++)ops.push({insert:ar?'حضور المواعيد واتباع تعليمات الطبيب المعالج.':'Attend appointments and follow the treating doctor’s instructions.',attributes:{font:'Arial',size:'10px'}},{insert:'\n',attributes:{list:'bullet',lineSpacing:'1.25',direction:ar?'rtl':'ltr'}});
        ops.push({insert:'\n',attributes:{lineSpacing:'1.25'}});
      }
      window.fixtureEditor?.dispose();document.querySelector('#editor').replaceChildren();window.record={language,title:'Draft comparison',content:LuminConsentDocument.normalize({ops}),doctor_name:'Doctor'};
      window.fixtureEditor=LuminConsentEditor.mount(document.querySelector('#editor'),{name:'body',label:'Consent',language,document:record.content});
      window.db={from(){return {select(){return this;},eq(){return this;},async single(){return {data:{logo_visible:false,signatures_visible:false},error:null};},async maybeSingle(){return {data:{logo_data_url:null},error:null};}};}};
      document.querySelector('#print').onclick=()=>{window.printJob=LuminConsentPrint.print(record,{source:fixtureEditor.quill.root});};
    },language);
    await page.evaluate(()=>document.fonts.ready);
    await page.waitForFunction(()=>document.querySelector('#editor .ql-editor table').style.width==='469px');
    const spacing=await page.locator('#editor .ql-editor').evaluate(node=>{
      node.focus();const table=node.querySelector('table'),after=table.nextElementSibling,style=getComputedStyle(node);
      return {above:table.getBoundingClientRect().top-node.getBoundingClientRect().top-parseFloat(style.paddingTop),below:after.getBoundingClientRect().top-table.getBoundingClientRect().bottom,focusBox:style.boxShadow};
    });
    assert.ok(Math.abs(spacing.above)<1,`${language}: the first table starts at the content edge without a blank area`);
    assert.ok(Math.abs(spacing.below)<1,`${language}: the following text starts directly below the table`);
    assert.equal(spacing.focusBox,'none','Focusing the wording does not draw a separating box inside the document');
    const expected=await page.locator('#editor .ql-editor').evaluate(inspect);
    const popup=page.waitForEvent('popup');await page.locator('#print').click();const view=await popup;await view.waitForFunction(()=>document.documentElement.dataset.consentPrintPrepared==='true');await page.evaluate(()=>window.printJob);
    for(const media of ['screen','print']){
      await view.emulateMedia({media});const actual=await view.locator('.consent-copy').evaluate(inspect);
      assert.ok(Math.abs(actual.width-expected.width)<1,`${language}/${media}: ${expected.width}px draft table became ${actual.width}px`);
      actual.columns.forEach((width,index)=>assert.ok(Math.abs(width-expected.columns[index])<1,`${language}/${media}: column ${index} width changed`));
      assert.deepEqual(actual.cells,expected.cells,`${language}/${media}: cell typography and padding must match the draft`);
      assert.equal(actual.blocks.length,expected.blocks.length);
      actual.rows.forEach((height,index)=>assert.ok(Math.abs(height-expected.rows[index])<1,`Row ${index} height changed: ${expected.rows[index]} → ${height}`));
      actual.blocks.forEach((block,index)=>{
        const source=expected.blocks[index];assert.equal(block.text,source.text);assert.deepEqual(block.style,source.style,`${language}/${media}: block ${index} style changed`);
        assert.ok(Math.abs(block.height-source.height)<1,`${language}/${media}: block ${index} height changed: ${source.height} → ${block.height}`);
        assert.ok(Math.abs(block.top-source.top)<1.2,`${language}/${media}: block ${index} moved: ${source.top} → ${block.top}`);
      });
    }
    await view.emulateMedia({media:'screen'});await view.locator('.consent-print-controls').evaluate(node=>node.style.display='none');
    await page.locator('#editor .consent-table-stage').evaluate(node=>node.style.maxHeight='none');await page.locator('#editor .ql-editor').evaluate(node=>node.style.maxHeight='none');
    await page.locator('#editor .ql-editor').screenshot({path:path.join(folder,`draft-${language}.png`)});await view.locator('#consent-print-root').screenshot({path:path.join(folder,`print-${language}.png`)});
    if(apple){
      assert.match(await view.locator('[data-print-pdf]').getAttribute('href'),/^blob:/,'The iPad PDF is prepared from the same captured draft');
      for(const bounds of await view.evaluate(()=>fixtureStageTables)){
        assert.ok(Math.abs(bounds.width-expected.width)<1,'The PDF renderer keeps the measured draft table width');
        bounds.columns.forEach((width,index)=>assert.ok(Math.abs(width-expected.columns[index])<1,'The PDF renderer keeps each draft column width'));
      }
      const encoded=await view.evaluate(async()=>{const bytes=new Uint8Array(await fixturePdfBlob.arrayBuffer());let data='';for(const byte of bytes)data+=String.fromCharCode(byte);return btoa(data);});
      fs.writeFileSync(path.join(folder,`ipad-print-${language}.pdf`),Buffer.from(encoded,'base64'));
    }else await view.pdf({path:path.join(folder,`print-${language}.pdf`),format:'A4',printBackground:true});
    await view.close();
  }
  console.log('Draft/print comparisons:',folder);
});
