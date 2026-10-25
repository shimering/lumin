const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
test('consent bullets, numbering and wrapped lines indent from the correct side in English and Arabic',async t=>{
  const source=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const head=source.slice(0,source.indexOf('</head>')+7).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end(head+'<body class="lumin-raised"><main style="max-width:1080px;margin:16px auto;padding:8px"><div id="fixture"></div><div id="printed" class="consent-copy consent-rich-content"></div></main></body>');return;}
    const file=path.resolve(root,'.'+decodeURIComponent(pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.ttf')?'font/ttf':'application/javascript');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||'chrome'});t.after(()=>browser.close());
  const page=await browser.newPage();await page.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:')?route.continue():route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  for(const file of ['vendor/lucide.min.js','vendor/quill/quill-2.0.2.js','vendor/dompurify/purify-3.4.17.min.js','lumin-consent-document.js','lumin-consent-editor.js'])await page.addScriptTag({path:path.join(root,file)});
  for(const width of [390,820,1320])for(const scenario of ['en','ar','mixed']){
    await page.setViewportSize({width,height:1000});
    await page.evaluate(scenario=>{
      const arabic=scenario!=='en',language=scenario==='ar'?'ar':'en';document.documentElement.dir=language==='ar'?'rtl':'ltr';window.currentUiLanguage=language;
      window.fixtureEditor?.dispose();document.getElementById('fixture').replaceChildren();
      const baseline=arabic?'فقرة قبل القائمة':'Paragraph before the list';
      const long=(arabic?'يجب المحافظة على نظافة الأسنان وحضور المواعيد واتباع تعليمات الطبيب المعالج. ':'Maintain oral hygiene, attend review appointments and follow the treating doctor’s instructions. ').repeat(6);
      const nested=arabic?'بند فرعي داخل القائمة':'A nested list item';
      window.fixtureEditor=LuminConsentEditor.mount(document.getElementById('fixture'),{name:'body',label:'Consent',language,text:baseline+'\n'+long+'\n'+nested+'\n'});
      const quill=fixtureEditor.quill;quill.setSelection(baseline.length+1,long.length+nested.length+2);
      window.fixtureList={baseline,long,nested,direction:arabic?'rtl':'ltr'};
    },scenario);
    await page.locator('[data-editor-command="list"][data-value="bullet"]').click();
    await page.evaluate(scenario=>{
      const {baseline,long}=fixtureList,quill=fixtureEditor.quill;
      if(scenario==='mixed')quill.formatLine(baseline.length+1,quill.getLength()-baseline.length-1,'direction','rtl');
      quill.formatLine(baseline.length+long.length+2,1,'indent',1);
      const print=document.getElementById('printed');print.dir=scenario==='ar'?'rtl':'ltr';print.innerHTML=LuminConsentDocument.html(fixtureEditor.getDocument());
    },scenario);
    const metrics=await page.evaluate(()=>{
      function lines(node){
        const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT),rows=new Map();let text;
        while(text=walker.nextNode()){
          if(text.parentElement.closest('.ql-ui'))continue;
          for(let index=0;index<text.length;index++){
            if(/\s/.test(text.data[index]))continue;const range=document.createRange();range.setStart(text,index);range.setEnd(text,index+1);const rect=range.getBoundingClientRect(),top=Math.round(rect.top);
            if(!rows.has(top))rows.set(top,fixtureList.direction==='rtl'?rect.right:rect.left);
          }
        }return [...rows.values()];
      }
      function inspect(selector){
        const items=[...document.querySelectorAll(selector)],a=items[0],b=items[1],bounds=a.getBoundingClientRect(),nestedBounds=b.getBoundingClientRect(),starts=lines(a),nested=lines(b);
        return {indent:fixtureList.direction==='rtl'?bounds.right-starts[0]:starts[0]-bounds.left,nestedIndent:fixtureList.direction==='rtl'?nestedBounds.right-nested[0]:nested[0]-nestedBounds.left,starts,font:parseFloat(getComputedStyle(a).fontSize)};
      }
      return {editor:inspect('.ql-editor li'),print:inspect('#printed li'),overflow:document.documentElement.scrollWidth>innerWidth};
    });
    assert.ok(metrics.editor.indent>=metrics.editor.font*1.4,`${width}/${scenario}: list text needs a start-side inset: ${JSON.stringify(metrics.editor)}`);
    assert.ok(metrics.editor.nestedIndent>=metrics.editor.indent+metrics.editor.font*1.4,`${width}/${scenario}: nested text needs an extra inset`);
    assert.ok(metrics.editor.starts.length>1);
    assert.ok(Math.abs(metrics.editor.starts[0]-metrics.editor.starts[1])<2,`${width}/${scenario}: wrapped lines must align with list text`);
    assert.equal(metrics.overflow,false);
    const printStarts=metrics.print.starts;assert.ok(printStarts.length>1);assert.ok(Math.abs(printStarts[0]-printStarts[1])<2,`${width}/${scenario}: printed wrapped lines must align`);
    if(width===390&&scenario==='ar'||width===1320&&scenario==='en'){
      const shots=path.join(os.tmpdir(),'lumin-consent-list-layout');fs.mkdirSync(shots,{recursive:true});
      await page.evaluate(()=>getSelection().removeAllRanges());await page.screenshot({path:path.join(shots,`lists-${width}-${scenario}.png`),fullPage:true});
    }
    await page.evaluate(()=>fixtureEditor.quill.setSelection(fixtureList.baseline.length+1,fixtureList.long.length));
    await page.locator('[data-editor-command="list"][data-value="ordered"]').click();
    assert.equal(await page.locator('.ql-editor li[data-list="ordered"]').count(),1);
  }
});
