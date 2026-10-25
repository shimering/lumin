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
    await page.locator('#editor td').first().click();await page.locator('.consent-table-menu [data-table-action="fit-row"]').click();
    assert.equal(await page.locator('#editor td').first().evaluate(cell=>cell.style.height),'auto');
    assert.ok(await page.locator('#editor tr').first().evaluate(row=>row.getBoundingClientRect().height<76),'A row can shrink to fit its text');
    await page.evaluate(()=>{const cell=document.querySelector('#editor td'),blot=Quill.find(cell);editor.quill.formatText(blot.offset(editor.quill.scroll),blot.length()-1,'size','24px','user');});
    const largeHeight=await page.locator('#editor tr').first().evaluate(row=>row.getBoundingClientRect().height);
    await page.evaluate(()=>{const cell=document.querySelector('#editor td'),blot=Quill.find(cell);editor.quill.formatText(blot.offset(editor.quill.scroll),blot.length()-1,'size','10px','user');});
    assert.ok(await page.locator('#editor tr').first().evaluate(row=>row.getBoundingClientRect().height)<largeHeight,'Auto height follows the word size');
    await page.evaluate(()=>{const saved=editor.getDocument();editor.setDocument(saved);document.getElementById('print').innerHTML=LuminConsentDocument.html(saved);});
    assert.equal(await page.locator('#print tr').first().evaluate(row=>row.style.height),'auto');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${width}/${language} page overflow`);
    const beforeClass=await page.locator('#editor').getAttribute('class');await page.locator('[data-editor-command="expand"]').click();assert.ok(await page.locator('.consent-editor.is-expanded').count(),JSON.stringify({width,language,beforeClass,afterClass:await page.locator('#editor').getAttribute('class')}));
    await page.locator('#editor td').first().click();await page.waitForFunction(()=>document.querySelector('.consent-table-overlay')?.hidden===false);
    await page.keyboard.press('Escape');assert.equal(await page.locator('.consent-editor.is-expanded').count(),0);
    if(width===390)await page.screenshot({path:path.join(os.tmpdir(),`lumin-consent-table-${language}.png`),fullPage:true});
  }
  for(const language of ['en','ar']){
    await page.evaluate(language=>{editor.dispose();currentUiLanguage=language;window.editor=LuminConsentEditor.mount(document.getElementById('editor'),{name:'body',label:'Consent',language,document:{ops:[{insert:'Small ',attributes:{size:'12px'}},{insert:'Large',attributes:{size:'28px'}},{insert:' Plain\n'}]}});editor.quill.setSelection(6,5);},language);
    assert.equal(await page.locator('[data-editor-format="size"]').inputValue(),'28px','The selected word reports its own size');
    await page.locator('[data-editor-format="size"]').selectOption('20px');
    assert.equal(await page.evaluate(()=>editor.quill.getFormat(6,5).size),'20px');assert.equal(await page.evaluate(()=>editor.quill.getFormat(0,5).size),'12px','Changing size is limited to the selection');
    await page.evaluate(()=>editor.quill.setSelection(12,5));assert.equal(await page.locator('[data-editor-format="size"]').inputValue(),'14px','Inherited word size is shown as a number');
    await page.locator('[data-editor-format="size"]').selectOption('10px');assert.equal(await page.evaluate(()=>editor.quill.getFormat(12,5).size),'10px');
  }

  for(const language of ['en','ar']){
    await page.evaluate(language=>{editor.dispose();currentUiLanguage=language;window.editor=LuminConsentEditor.mount(document.getElementById('editor'),{name:'body',label:'Consent',language,text:'First paragraph\nSecond paragraph\nThird paragraph'});editor.quill.setSelection(0,15);},language);
    assert.equal(await page.locator('[data-editor-format="lineSpacing"]').inputValue(),'1.85');
    await page.locator('[data-editor-format="lineSpacing"]').selectOption('1.25');
    assert.equal(await page.evaluate(()=>editor.quill.getFormat(0,1).lineSpacing),'1.25');
    assert.equal(await page.evaluate(()=>editor.quill.getFormat(16,1).lineSpacing),undefined,'Other paragraphs retain their spacing');
    await page.evaluate(()=>editor.quill.setSelection(0,32));
    await page.locator('[data-editor-format="lineSpacing"]').selectOption('2');
    assert.equal(await page.evaluate(()=>editor.quill.getFormat(16,1).lineSpacing),'2');
    await page.evaluate(()=>{const saved=editor.getDocument();editor.setDocument(saved);editor.quill.setSelection(16,0);document.getElementById('print').innerHTML=LuminConsentDocument.html(saved);});
    assert.equal(await page.locator('[data-editor-format="lineSpacing"]').inputValue(),'2');
    assert.equal(await page.locator('#print p').nth(1).evaluate(node=>node.style.lineHeight),'2');
  }
  await page.evaluate(()=>{editor.dispose();window.variables={implant_total:'10,000',doctor_name_ar:'د. نور'};window.editor=LuminConsentEditor.mount(document.getElementById('editor'),{name:'body',label:'Consent',language:'en',text:'Total: {{implant_total}} / {{implant_total}}\nDoctor: {{doctor_name_ar}}',values:()=>variables});variables.implant_total='20,000';editor.updateVariables(variables);});
  assert.match(await page.locator('#editor .ql-editor').innerText(),/20,000 \/ 20,000/,'Repeated variables update independently');
  await page.evaluate(()=>{let index=0;const op=editor.getDocument().ops.find(op=>{if(op.attributes?.consentField==='implant_total')return true;index+=typeof op.insert==='string'?op.insert.length:1;return false;});editor.quill.deleteText(index,op.insert.length,'user');editor.quill.insertText(index,'Custom fee','user');variables.implant_total='30,000';variables.doctor_name_ar='د. عمر';editor.updateVariables(variables);});
  assert.match(await page.locator('#editor .ql-editor').innerText(),/Custom fee \/ 30,000/,'Directly edited variable values remain custom text');
  assert.match(await page.locator('#editor .ql-editor').innerText(),/د. عمر/);
  assert.deepEqual(errors,[]);
});
