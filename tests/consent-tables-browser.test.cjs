const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright'),root=path.resolve(__dirname,'..');
test('consent tables add edge rows and columns, drag dimensions, persist and print in both directions',{timeout:120000},async t=>{
  const server=http.createServer((req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname;if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/vendor/quill/quill.core-2.0.2.css"><link rel="stylesheet" href="/lumin-consent-editor.css"></head><body style="margin:0;padding:16px;font-family:Arial"><main style="max-width:1000px;margin:auto;min-width:0"><div id="editor"></div><div id="print" class="consent-rich-content"></div></main></body></html>');return;}const file=path.resolve(root,'.'+decodeURIComponent(pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');res.end(fs.readFileSync(file));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||'chrome'});t.after(()=>browser.close());const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  for(const file of ['vendor/lucide.min.js','vendor/quill/quill-2.0.2.js','vendor/dompurify/purify-3.4.17.min.js','lumin-consent-document.js','lumin-consent-tables.js','lumin-consent-editor.js'])await page.addScriptTag({path:path.join(root,file)});
  for(const width of [1320,820,390])for(const language of ['en','ar']){
    await page.setViewportSize({width,height:1000});await page.evaluate(language=>{window.currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';window.editor?.dispose?.();window.editor=LuminConsentEditor.mount(document.getElementById('editor'),{name:'body',label:'Consent',language,text:language==='ar'?'نص الموافقة\n':'Consent wording\n'});editor.quill.setSelection(editor.quill.getLength()-1,0);},language);
    await page.locator('[data-editor-command="table"]').click();await page.waitForFunction(()=>document.querySelectorAll('#editor table td').length===4);
    assert.doesNotMatch(await page.locator('#editor table').innerText(),/Consent wording|نص الموافقة/,'Inserting a table preserves the preceding paragraph');
    await page.evaluate(()=>{const cell=document.querySelector('#editor td');editor.quill.insertText(Quill.find(cell).offset(editor.quill.scroll),'Cell A','user');});
    await page.locator('.consent-table-edge[data-table-action="row"]').click();await page.locator('.consent-table-edge[data-table-action="column"]').click();
    assert.equal(await page.locator('#editor table tr').count(),3);assert.equal(await page.locator('#editor table td').count(),9);
    const column=page.locator('[data-table-resize="column"][data-index="0"]');await column.scrollIntoViewIfNeeded();const cb=await column.boundingBox();
    await page.mouse.move(cb.x+22,cb.y+22);await page.mouse.down();await page.mouse.move(cb.x+22+(language==='ar'?-48:48),cb.y+22,{steps:5});await page.mouse.up();
    await page.waitForFunction(()=>document.querySelector('#editor td').style.width==='208px');
    const row=page.locator('[data-table-resize="row"][data-index="0"]');await row.scrollIntoViewIfNeeded();const rb=await row.boundingBox();await page.mouse.move(rb.x+22,rb.y+22);await page.mouse.down();await page.mouse.move(rb.x+22,rb.y+54,{steps:4});await page.mouse.up();
    await page.waitForFunction(()=>document.querySelector('#editor td').style.height==='76px');
    await column.focus();await page.keyboard.press(language==='ar'?'ArrowLeft':'ArrowRight');await page.waitForFunction(()=>document.querySelector('#editor td').style.width==='216px');
    await page.keyboard.press(language==='ar'?'ArrowRight':'ArrowLeft');await page.waitForFunction(()=>document.querySelector('#editor td').style.width==='208px');
    const saved=await page.evaluate(()=>editor.getDocument());assert.ok(saved.ops.some(op=>op.attributes?.table&&op.attributes.cellWidth==='208px'&&op.attributes.cellHeight==='76px'));
    await page.evaluate(saved=>{editor.setDocument(saved);document.getElementById('print').innerHTML=LuminConsentDocument.html(saved);},saved);
    assert.equal(await page.locator('#editor table td').count(),9);assert.equal(await page.locator('#print table td').count(),9);assert.match(await page.locator('#print').innerText(),/Cell A/);assert.equal(await page.locator('#editor td').first().evaluate(cell=>cell.style.width),'208px');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${width}/${language} page overflow`);
    const beforeClass=await page.locator('#editor').getAttribute('class');await page.locator('[data-editor-command="expand"]').click();assert.ok(await page.locator('.consent-editor.is-expanded').count(),JSON.stringify({width,language,beforeClass,afterClass:await page.locator('#editor').getAttribute('class')}));
    await page.locator('#editor td').first().click();await page.waitForFunction(()=>document.querySelector('.consent-table-overlay')?.hidden===false);
    await page.keyboard.press('Escape');assert.equal(await page.locator('.consent-editor.is-expanded').count(),0);
    if(width===390)await page.screenshot({path:path.join(os.tmpdir(),`lumin-consent-table-${language}.png`),fullPage:true});
  }
  assert.deepEqual(errors,[]);
});
