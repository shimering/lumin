const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright'),{PDFDocument}=require('pdf-lib'),root=path.resolve(__dirname,'..');

test('PDF pages retain frames and explicit Arabic/English bullets, nested numbering and wrapped lines',{timeout:90000},async t=>{
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/favicon.ico'){res.writeHead(204).end();return;}
    if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head>'+['lumin-app.css','vendor/quill/quill.core-2.0.2.css','lumin-consent-editor.css'].map(file=>`<link rel="stylesheet" href="/${file}">`).join('')+'</head><body><div id="editor"></div><button id="export">Export</button></body></html>');return;}
    const file=path.resolve(root,'.'+decodeURIComponent(pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':file.endsWith('.ttf')?'font/ttf':'application/javascript');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||'chrome'});t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:1280,height:1000}}),errors=[];context.on('page',view=>{view.on('pageerror',error=>errors.push(error.message));view.on('console',m=>{if(m.type()==='error')console.log('PDF lists:',m.text());});});
  await context.addInitScript(()=>{
    window.addEventListener('click',event=>{if(event.target.closest?.('[data-print-pdf]'))event.preventDefault();},true);
    let render;Object.defineProperty(window,'html2canvas',{configurable:true,get:()=>render,set(value){render=(stage,options)=>{
      const frame=stage.querySelector('.consent-paper-frame'),clip=stage.querySelector('.consent-pdf-clip').getBoundingClientRect();
      const walker=document.createTreeWalker(stage,NodeFilter.SHOW_TEXT);while(walker.nextNode())if(/[\u0600-\u06ff]/.test(walker.currentNode.textContent)&&/\s/.test(walker.currentNode.textContent))throw new Error('Arabic words must be shaped as complete words before pagination');
      const visible=[...stage.querySelectorAll('.consent-pdf-list-marker')].filter(marker=>{const r=marker.getBoundingClientRect();return r.left>=clip.left-1&&r.right<=clip.right+1&&r.top>=clip.top-1&&r.bottom<=clip.bottom+1;});
      (window.renderedPages??=[]).push({frame:frame?.className,markers:visible.map(marker=>marker.textContent),positions:visible.map(marker=>{
        const item=marker.parentElement,r=marker.getBoundingClientRect(),walker=document.createTreeWalker(item,NodeFilter.SHOW_TEXT),rows=new Map();
        while(walker.nextNode()){const text=walker.currentNode;if(text.parentElement.closest('.consent-pdf-list-marker')||!text.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(text);for(const rect of range.getClientRects())if(rect.width>0){const key=Math.round(rect.top),previous=rows.get(key);rows.set(key,{left:Math.min(previous?.left??Infinity,rect.left),right:Math.max(previous?.right??-Infinity,rect.right)});}}
        const lines=[...rows.values()],rtl=getComputedStyle(item).direction==='rtl';return {rtl,marker:{left:r.left,right:r.right},lines};
      })});return value(stage,options);
    };}});
  });
  const page=await context.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
  for(const file of ['vendor/quill/quill-2.0.2.js','lumin-consent-document.js','lumin-consent-tables.js','lumin-consent-editor.js','lumin-consent-layout.js','lumin-consent-print.js'])await page.addScriptTag({path:path.join(root,file)});
  const folder=path.join(os.tmpdir(),'lumin-consent-pdf-lists');fs.mkdirSync(folder,{recursive:true});
  for(const language of ['en','ar'])for(const frame of ['single','double','rounded','none']){
    const snapshot=frame!=='none';
    await page.evaluate(({language,frame,snapshot})=>{
      const ar=language==='ar',direction=ar?'rtl':'ltr',ops=[];
      document.documentElement.lang=language;document.documentElement.dir=direction;
      ops.push({insert:ar?'موافقة علاج الأسنان':'Dental treatment consent'},{insert:'\n',attributes:{header:2,direction}});
      for(const [indent,text] of [[0,'First item'],[1,'Nested item'],[2,'Deep item'],[1,'Second nested item'],[0,'Second item']])ops.push({insert:ar?'تم شرح العلاج ومناقشة الخيارات المتاحة.':text},{insert:'\n',attributes:{list:'ordered',...(indent?{indent}:{}),direction}});
      ops.push({insert:ar?'تعليمات الرعاية والمتابعة':'Care and follow-up instructions'},{insert:'\n',attributes:{direction}});
      for(let i=0;i<42;i++)ops.push({insert:ar?'يجب المحافظة على نظافة الأسنان وحضور المواعيد واتباع تعليمات الطبيب المعالج. '.repeat(3):'Maintain oral hygiene, attend review appointments and follow the treating doctor’s instructions. '.repeat(3)},{insert:'\n',attributes:{list:'bullet',direction,lineSpacing:'1.5'}});
      ops.push({insert:ar?'الموافقة النهائية':'Final agreement'},{insert:'\n',attributes:{direction}},{insert:ar?'أوافق على خطة العلاج.':'I agree to the treatment plan.'},{insert:'\n',attributes:{list:'ordered',direction}});
      window.record={title:'Consent PDF '+language,language,doctor_name:'Doctor',content:LuminConsentDocument.normalize({ops}),print_layout:{frame,margin_top_mm:12,margin_bottom_mm:12,margin_left_mm:16,margin_right_mm:16}};
      window.fixtureEditor?.dispose();document.querySelector('#editor').replaceChildren();window.fixtureEditor=LuminConsentEditor.mount(document.querySelector('#editor'),{name:'body',label:'Consent',language,document:record.content});
      window.db={from(){return {select(){return this;},eq(){return this;},async single(){return {data:{logo_visible:false,signatures_visible:false,header_text_en:'CLINIC',header_text_ar:'العيادة'},error:null};},async maybeSingle(){return {data:{logo_data_url:null},error:null};}};}};
      document.querySelector('#export').onclick=()=>{window.job=LuminConsentPrint.print(record,{source:snapshot?fixtureEditor.quill.root:null});};
    },{language,frame,snapshot});
    const popup=page.waitForEvent('popup');await page.locator('#export').click();const view=await popup;await view.waitForFunction(()=>document.documentElement.dataset.consentPrintPrepared==='true');await page.evaluate(()=>window.job);assert.equal(await view.evaluate(()=>document.documentElement.dataset.consentPdfReady),'true',await view.locator('[data-print-status]').innerText());
    const pages=await view.evaluate(()=>renderedPages),markers=pages.flatMap(page=>page.markers);
    const first=snapshot?['1.','a.','i.','b.','2.']:['1.','2.','3.','4.','5.'];
    assert.deepEqual(markers,[...first,...Array(42).fill('•'),'1.'],`${language}/${frame}: every marker occurs exactly once, in order, across pages`);
    assert.ok(pages.length>=3,'Long lists span multiple pages');
    for(const page of pages){assert.equal(page.frame,frame==='none'?undefined:'consent-paper-frame is-'+frame);for(const {rtl,marker,lines} of page.positions){
      assert.equal(rtl,language==='ar');if(!lines.length)continue;
      assert.ok(rtl?marker.left>lines[0].right:marker.right<lines[0].left,'Markers sit outside the text');
      if(lines.length>1)assert.ok(Math.abs((rtl?lines[0].right:lines[0].left)-(rtl?lines[1].right:lines[1].left))<1,'Wrapped lines keep a hanging indent');
    }}
    const bytes=Buffer.from(await view.evaluate(async()=>Array.from(new Uint8Array(await (await opener.fetch(document.querySelector('[data-print-pdf]').href)).arrayBuffer()))));
    const pdf=await PDFDocument.load(bytes);assert.equal(pdf.getPageCount(),pages.length);fs.writeFileSync(path.join(folder,`${language}-${frame}.pdf`),bytes);
    await view.close();
  }
  assert.deepEqual(errors,[]);console.log('Consent PDF list previews:',folder);
});
