const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os'),{execFileSync}=require('node:child_process');
const {chromium}=require('playwright'),{PDFDocument}=require('pdf-lib'),root=path.resolve(__dirname,'..');
test('Arabic consent printing produces populated A4 pages under app scaling and RTL',{timeout:120000},async t=>{
  const pdfPython=process.env.LUMIN_PDF_PYTHON;if(!pdfPython){t.skip('Set LUMIN_PDF_PYTHON to Python with pypdf for PDF verification');return;}
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  const server=http.createServer((req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname;if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}const file=path.resolve(root,'.'+decodeURIComponent(pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.ttf')?'font/ttf':'application/javascript');res.end(fs.readFileSync(file));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||'chrome'});t.after(()=>browser.close());
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:')?route.continue():route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  for(const file of ['lumin-consent-document.js','lumin-consent-model.js'])await page.addScriptTag({path:path.join(root,file)});
  await page.evaluate(()=>{window.hasPageAccess=()=>true;window.patientWorkspaceId=()=> 'fixture-patient';window.currentSession={user:{id:'staff'}};window.currentUiLanguage='ar';window.print=()=>{window.printCalls=(window.printCalls||0)+1;};});
  await page.addScriptTag({content:fs.readFileSync(path.join(root,'lumin-consents.js'),'utf8').replace('root.LuminConsents={render,','root.LuminConsents={printFixture:printRecord,render,')});
  const folder=path.join(os.tmpdir(),'lumin-consent-print');fs.mkdirSync(folder,{recursive:true});
  let expectedPages=null;
  for(const width of [1320,390])for(const scale of [1,.8]){
    await page.setViewportSize({width,height:940});
    await page.evaluate(({width,scale})=>{document.documentElement.dir='rtl';document.documentElement.classList.toggle('lumin-app-scaled',scale!==1);document.documentElement.style.setProperty('--lumin-app-scale',scale);document.documentElement.style.setProperty('--lumin-app-viewport-width',width/scale+'px');document.documentElement.style.setProperty('--lumin-app-viewport-height',940/scale+'px');document.body.style.overflow='hidden';
      const ops=[{insert:'موافقة زراعة الأسنان\n',attributes:{bold:true,font:'Amiri'}}];for(let i=0;i<22;i++){ops.push({insert:'هذه فقرة لاختبار الطباعة باللغة العربية. تمت مناقشة تفاصيل العلاج والتكلفة والزيارات مع الطبيب المعالج. أوافق على الإجراءات الموضحة في هذا المستند.'});ops.push({insert:'\n',attributes:{direction:'rtl',align:'right'}});}for(let row=0;row<6;row++)for(let col=0;col<2;col++){ops.push({insert:col?'قيمة الرسوم المتفق عليها':'جلسة الزراعة والتركيب'});ops.push({insert:'\n',attributes:{table:'row-'+row,cellWidth:col?'309px':'160px',cellHeight:'44px'}});}const content=LuminConsentDocument.normalize({ops});window.printFixtureRecord={id:'fixture-consent',patient_id:'fixture-patient',patient_data:{name:'مريض تجريبي',number:'TEST'},title:'موافقة زراعة الأسنان',doctor_name:'Doctor Test',doctor_name_ar:'طبيب تجريبي',language:'ar',body:LuminConsentDocument.text(content),content,status:'draft',created_at:'2026-10-25T12:00:00Z',template_revision:1};return LuminConsents.printFixture(printFixtureRecord);
    },{width,scale});
    await page.emulateMedia({media:'print'});await page.evaluate(()=>document.fonts.ready);
    const file=path.join(folder,'arabic-consent.pdf');await page.pdf({path:file,format:'A4',preferCSSPageSize:true,printBackground:true});const pdf=await PDFDocument.load(fs.readFileSync(file));
    const pages=JSON.parse(execFileSync(pdfPython,['-c','import json,sys; from pypdf import PdfReader; print(json.dumps([p.extract_text() for p in PdfReader(sys.argv[1]).pages]))',file],{encoding:'utf8'}));
    console.log(JSON.stringify({width,scale,pages:pdf.getPageCount(),textPerPage:pages.map(page=>page.trim().length)}));
    if(expectedPages===null)expectedPages=pdf.getPageCount();else assert.equal(pdf.getPageCount(),expectedPages,'App viewport and zoom must not affect print pagination');
    if(process.env.LUMIN_PDFTOPPM){for(let p=1;p<=pdf.getPageCount();p++){const raster=execFileSync(process.env.LUMIN_PDFTOPPM,['-f',String(p),'-singlefile','-r','30',file],{maxBuffer:10000000}),header=/^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(raster.subarray(0,80).toString('latin1'));assert.ok(header);let ink=0;for(let i=header[0].length;i<raster.length;i+=3)if(raster[i]<200&&raster[i+1]<200&&raster[i+2]<200)ink++;assert.ok(ink>80,'Printed PDF page must have visible text');}}
    assert.ok(pages.length>0);assert.ok(pages.every(page=>page.trim().length>30),`Blank printed page at ${width}/${scale}`);
    await page.emulateMedia({media:'screen'});await page.evaluate(()=>dispatchEvent(new Event('afterprint')));
  }
  assert.deepEqual(errors,[]);console.log('Arabic PDF preview:',folder);
});
