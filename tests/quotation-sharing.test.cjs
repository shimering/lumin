const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const token='a'.repeat(64);
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const data=()=>({patientName:'محمد حسن الزواوي',total:3500,expiresAt:new Date(Date.now()+864e5).toISOString(),clinic:{name:'عيادة النور',logo:png}});

async function fixture(value=data(),status=200) {
  const {handleRequest}=await import('../workers/lumin.mjs');
  const calls=[];
  const env={ASSETS:{async fetch(request){
    const url=new URL(request.url);
    if(url.pathname==='/quotation.html')return new Response(fs.readFileSync(path.join(root,'quotation.html'),'utf8'),{headers:{'Content-Type':'text/html'}});
    return new Response('static asset');
  }}};
  return {calls,async get(url,method='GET') {
    return handleRequest(new Request('https://clinic.invalid'+url,{method}),env,async(url,options)=>{
      calls.push({url,options});
      assert.match(url,/functions\/v1\/quotation-view$/);
      assert.deepEqual(JSON.parse(options.body),{token});
      assert.equal(options.method,'POST');assert.equal(options.referrerPolicy,'no-referrer');
      return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
    });
  }};
}

test('WhatsApp can read clinic logo, patient name and whole-pound total without running JavaScript',async()=>{
  const app=await fixture();
  const response=await app.get('/quotation.html?q='+token);
  assert.equal(response.status,200);
  const html=await response.text();
  assert.match(html,/<meta property="og:title" content="عرض أسعار العلاج · عيادة النور"/);
  assert.match(html,/<meta property="og:description" content="عرض أسعار العلاج للمريض محمد حسن الزواوي\. الإجمالي ‏٣٬٥٠٠\sج\.م\.‏\."/);
  assert.match(html,new RegExp('<meta property="og:image" content="https://clinic.invalid/quotation-logo\\?q='+token+'"'));
  assert.match(html,new RegExp('<meta property="og:url" content="https://clinic.invalid/quotation.html\\?q='+token+'"'));
  assert.match(html,/<link id="quotation-favicon" rel="icon" type="image\/png"/);
  assert.doesNotMatch(html,/[.٫]٠٠|chart_state|selected_ids|medical_history/);
  assert.match(response.headers.get('Cache-Control'),/no-store, private/);
  assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
  assert.equal(app.calls.length,1);
});

test('clinic logo is an actual image with matching GET and HEAD responses',async()=>{
  const app=await fixture();
  const response=await app.get('/quotation-logo?q='+token);
  assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(png.split(',')[1],'base64'));
  assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
  const head=await app.get('/quotation-logo?q='+token,'HEAD');
  assert.equal(head.status,200);assert.equal(head.headers.get('Content-Type'),'image/png');assert.equal(await head.text(),'');
});

test('unavailable and expired links expose no patient metadata or clinic image',async()=>{
  for(const [value,status] of [[{error:'Unavailable'},404],[{error:'Unavailable'},503],[{...data(),expiresAt:new Date(0).toISOString()},200]]) {
    const app=await fixture(value,status);
    for(const url of ['/quotation.html?q='+token,'/quotation-logo?q='+token]) {
      const response=await app.get(url);
      assert.equal(response.status,status===503?503:404);
      assert.doesNotMatch(await response.text(),/محمد حسن|عيادة النور|٣٬٥٠٠/);
      assert.match(response.headers.get('Cache-Control'),/no-store/);
    }
  }
  const app=await fixture();
  assert.equal((await app.get('/quotation.html?q=invalid')).status,404);
  assert.equal((await app.get('/quotation-logo')).status,404);
  assert.equal((await app.get('/quotation.html?q='+token,'POST')).status,405);
  assert.equal(app.calls.length,0);
});

test('preview metadata escapes custom names and rejects unsafe image data',async()=>{
  const app=await fixture({...data(),patientName:'"><script>bad()</script>',clinic:{name:'A & B <Clinic>',logo:'data:image/svg+xml;base64,PHN2Zy8+'}});
  const html=await (await app.get('/quotation?q='+token)).text();
  assert.match(html,/&quot;&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html,/<script>bad\(\)/);
  assert.match(html,/A &amp; B &lt;Clinic&gt;/);
  assert.match(html,/og:image" content="https:\/\/clinic.invalid\/icons\/dental-icon-v1-512.png/);
  assert.equal((await app.get('/quotation-logo?q='+token)).status,404);
});

test('legacy quotation links still load their public page and ordinary assets pass through',async()=>{
  const app=await fixture();
  for(const pathname of ['/quotation','/quotation.html']) {
    const response=await app.get(pathname+'#'+token);
    assert.equal(response.status,200);assert.match(await response.text(),/id="patient-quotation"/);
  }
  const redirect=await app.get('/quotation/?q='+token);
  assert.equal(redirect.status,308);assert.equal(redirect.headers.get('Location'),'https://clinic.invalid/quotation.html?q='+token);
  assert.equal(await (await app.get('/lumin-app.css')).text(),'static asset');
  assert.equal(app.calls.length,0);
});
