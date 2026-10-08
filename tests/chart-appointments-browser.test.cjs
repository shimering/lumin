const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {}
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}
const helpers = ['coalesceRefreshRead', 'contentRefreshContext', 'appointmentRecordsAfterLocalWrites', 'appointmentDateKey',
  'canonicalAppointmentStatus', 'normaliseHexColor', 'appointmentStatusColor', 'appointmentColorRgbChannels', 'openPatientChart'].map(source).join('\n');

test('chart sidebar fits four cards, scrolls independently, collapses, navigates, and animates realtime removals in English and Arabic', { skip: !chromium && 'Playwright unavailable' }, async t => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')); return; }
    const target = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', target.endsWith('.css') ? 'text/css' : 'application/javascript');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true, channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', timezoneId: 'Africa/Cairo' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/thumbnail/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="#151b23"/><path d="M120 60 Q155 30 190 60 L180 180 L165 180 L155 110 L140 180 L125 180 Z M210 60 Q245 30 280 60 L270 180 L255 180 L245 110 L230 180 L215 180 Z" fill="#b4bac4" stroke="#697386" stroke-width="6"/></svg>' }));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base);
  await page.addScriptTag({ url: base + '/vendor/lucide.min.js' });
  await page.addScriptTag({ content: `
    let currentSession={user:{id:'staff'}}, currentUserAccess={active:true}, currentUiLanguage='en', canReadAppointments=true;
    let activePatientId='patient-0', activeWorkspacePatientId='patient-0', activeSelection, selectedFindingIds, invoicedFindingIds;
    let chartSalaryTransfersByFindingId, chartInvoiceItemsByFindingId, chartInvoiceStatePatientId, patientMediaToothPicker=null;
    let patientMediaUploadContext=null, patientMediaDetailsError=false;
    const APPOINTMENT_STATUSES=['Scheduled','Confirmed','Checked in','In progress','Completed','Cancelled','No-show'];
    const DEFAULT_APPOINTMENT_STATUS_COLORS={Scheduled:'#2563eb',Confirmed:'#0891b2','Checked in':'#10b981','In progress':'#7c3aed',Completed:'#16a34a',Cancelled:'#e11d48','No-show':'#f59e0b'};
    let appointmentStatusColors={...DEFAULT_APPOINTMENT_STATUS_COLORS};
    const APPOINTMENT_SELECT_FIELDS='id,patient_id,appointment_at,status,patients(name)';
    let appointmentWriteRevision=0; const appointmentSavedRecords=new Map(), coalescedRefreshReads=new Map();
    const stableJsonStringify=JSON.stringify;
    function hasPageAccess(page) { return page==='appointments' ? canReadAppointments : true; }
    function escapeHtml(value) { const node=document.createElement('span');node.textContent=String(value);return node.innerHTML.replaceAll('"','&quot;'); }
    function arabicUiPhrase(value) { return {'Scheduled':'مجدول','Confirmed':'مؤكد','Checked in':'تم تسجيل الحضور','In progress':'قيد التنفيذ'}[value] || value; }
    function getKnownPatient(id) { return {id,name:'Ahmed Hassan'}; }
    function getStorageServerConfig() { return {url:location.origin,key:'fixture'}; }
    function patientMediaToothIds(details) { return details?.tooth_ids || []; }
    function patientMediaTeethLabel() { return 'UR6'; }
    function patientMediaToothLabel(value) { return value; }
    function patientMediaDisplayName(file) { return file.mediaDetails?.display_name || file.filename; }
    function emptyChartSelection() { return {}; } function rememberPatientWorkspaceOrigin() {}
    async function switchView(view) { window.openedChart={view,patientId:activePatientId}; }
    function normaliseAppointmentRecord(record) { return {id:record.id,patientId:record.patient_id,isNote:!record.patient_id,startAt:record.appointment_at,date:appointmentDateKey(new Date(record.appointment_at)),status:canonicalAppointmentStatus(record.status),patient:record.patients?.name}; }
    window.serverRows=Array.from({length:12},(_,i)=>({id:String(i),patient_id:'patient-'+i,appointment_at:new Date(new Date().setHours(8+i,0,0,0)).toISOString(),status:APPOINTMENT_STATUSES[i%4],patients:{name:i===3?'A very long patient name that should remain inside the card':'Patient '+(i+1)}}));
    window.queryCount=0;window.failReads=false;
    const db={from(){return {select(){return this},gte(){return this},lt(){return this},order(){return this},async range(){window.queryCount++;return window.failReads?{error:Error('Offline')}:{data:structuredClone(window.serverRows)};}}}};
    ${helpers}
  ` });
  await page.addScriptTag({ url: base + '/lumin-chart-media.js?v=11' });
  await page.addScriptTag({ url: base + '/lumin-chart-appointments.js?v=1' });
  await page.evaluate(async () => {
    document.getElementById('auth-gate').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');
    document.querySelectorAll('#app-main > section, #app-main > div').forEach(element => element.classList.add('hidden'));
    ['patient-workspace-sheet','patient-workspace-header','view-chart'].forEach(id => document.getElementById(id).classList.remove('hidden'));
    document.getElementById('findings-container').innerHTML=Array.from({length:25}, () => '<article style="height:100px;padding:20px">Clinical finding</article>').join('');
    chartPatientMedia.patientId=activePatientId;chartPatientMedia.status='ready';chartPatientMedia.collapsed=false;
    chartPatientMedia.files=Array.from({length:12},(_,i)=>({filename:'xray'+i+'.png',relativePath:'patient/Periapical/xray'+i+'.png',category:'Periapical',uploadedAt:new Date().toISOString(),mediaDetails:{tooth_ids:['3'],display_name:'Before treatment',note:'Clinical review'}}));
    document.dispatchEvent(new Event('DOMContentLoaded'));
    renderChartMediaPanel();await loadChartAppointments();
  });
  const screenshots = process.env.LUMIN_APPOINTMENTS_SCREENSHOT_DIR || path.join(os.tmpdir(), 'lumin-chart-appointments-preview');
  fs.mkdirSync(screenshots, { recursive: true });
  for (const viewport of [{width:1440,height:1000},{width:1366,height:768},{width:1024,height:768},{width:800,height:600},{width:834,height:1112},{width:390,height:844},{width:320,height:568}]) {
    await page.setViewportSize(viewport);
    for (const language of ['en', 'ar']) {
      await page.evaluate(language => {
        currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';
        chartPatientMedia.collapsed=true;renderChartMediaPanel();
        chartPatientMedia.collapsed=!chartMediaIsLandscape();chartAppointments.collapsed=false;
        renderChartMediaPanel();renderChartAppointmentsPanel();window.scrollTo(0,0);
      }, language);
      const panel=page.locator('#chart-appointments-panel'), body=page.locator('#chart-appointments-body');
      await panel.scrollIntoViewIfNeeded();
      assert.ok(await panel.isVisible());
      assert.equal(await page.locator('.chart-appointment-card').count(),12);
      assert.match(await page.locator('#chart-appointments-title').textContent(),language==='ar'?/مواعيد اليوم/:/Today’s appointments/);
      await body.evaluate(node => { node.scrollTop=0; });
      const bounds=await body.boundingBox();
      for(let i=0;i<4;i++) {
        const card=await page.locator('.chart-appointment-card').nth(i).boundingBox();
        assert.ok(card.height>=44 && card.y>=bounds.y && card.y+card.height<=bounds.y+bounds.height+1, JSON.stringify({viewport,language,i,card,bounds}));
      }
      const before=await page.evaluate(()=>({page:scrollY,xray:document.getElementById('chart-media-panel-body').scrollTop}));
      await body.evaluate(node => { node.scrollTop=100; });
      assert.deepEqual(await page.evaluate(()=>({page:scrollY,xray:document.getElementById('chart-media-panel-body').scrollTop})),before,'queue scroll does not move chart or X-rays');
      await body.evaluate(node => { node.scrollTop=0; });
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,JSON.stringify({viewport,language}));
      if(viewport.width===1440) {
        const media=await page.locator('#chart-media-panel').boundingBox(), queue=await panel.boundingBox();
        assert.ok(Math.abs(media.height/queue.height-2)<.03,'2:1 split when there is room');
        await page.locator('#chart-side-panels').screenshot({path:path.join(screenshots,'sidebar-'+language+'.png')});
        const positions=await page.evaluate(()=>({page:scrollY,queue:document.getElementById('chart-appointments-body').scrollTop}));
        await page.locator('#chart-media-panel-body').evaluate(node=>{node.scrollTop=100;});
        assert.deepEqual(await page.evaluate(()=>({page:scrollY,queue:document.getElementById('chart-appointments-body').scrollTop})),positions,'X-ray scrolling is independent');
        assert.ok(await page.locator('#chart-media-panel-body').evaluate(node=>node.scrollTop>0));
        await page.locator('#chart-media-panel-body').evaluate(node=>{node.scrollTop=0;});
        await page.evaluate(()=>window.scrollBy(0,400));
        const stuck=await page.locator('#chart-side-panels').boundingBox();
        await page.evaluate(()=>window.scrollBy(0,200));
        assert.ok(Math.abs((await page.locator('#chart-side-panels').boundingBox()).y-stuck.y)<2,'both panels stay beside the chart while it scrolls');
      }
      if(viewport.width===390 && language==='ar') await panel.screenshot({path:path.join(screenshots,'mobile-ar.png')});
      if(viewport.width>=768 && viewport.width>viewport.height) {
        assert.equal(await page.locator('#chart-media-collapse').getAttribute('aria-controls'),'chart-media-panel-body chart-appointments-body');
        await page.locator('#chart-media-collapse').click();
        assert.equal(await body.isVisible(),false,'X-ray collapse also hides appointment cards');
        assert.equal(await page.locator('#chart-media-panel-body').isVisible(),false);
        assert.equal(await page.locator('#chart-appointments-collapse').getAttribute('aria-expanded'),'false');
        assert.match(await page.locator('#chart-media-collapse').getAttribute('aria-label'),language==='ar'?/توسيع الأشعة والمواعيد/:/Expand X-rays and appointments/);
        assert.ok((await page.locator('#chart-side-panels').boundingBox()).width<=57,'both collapsed panels share a narrow rail');
        await page.locator('#chart-media-collapse').click();
        assert.equal(await body.isVisible(),true,'X-ray expand restores appointment cards');
        assert.equal(await page.locator('#chart-media-panel-body').isVisible(),true);
        assert.equal(await page.locator('#chart-appointments-collapse').getAttribute('aria-expanded'),'true');
        assert.ok((await page.locator('#chart-side-panels').boundingBox()).width>=272);
      }
      await page.locator('#chart-appointments-collapse').click();
      assert.equal(await body.isVisible(),false);
      await page.locator('#chart-appointments-collapse').click();
      assert.equal(await body.isVisible(),true);
    }
  }
  await page.setViewportSize({width:1440,height:900});
  await page.evaluate(()=>{currentUiLanguage='en';document.documentElement.dir='ltr';chartPatientMedia.collapsed=false;renderChartMediaPanel();renderChartAppointmentsPanel();window.scrollTo(0,0);});
  await page.locator('.chart-appointment-card').nth(1).click();
  assert.deepEqual(await page.evaluate(()=>window.openedChart),{view:'chart',patientId:'patient-1'});
  const initialShadow=await page.locator('[data-appointment-id="2"]').evaluate(node=>getComputedStyle(node).boxShadow);
  await page.evaluate(async()=>{serverRows[2].status='In progress';await loadChartAppointments({refresh:true});});
  assert.notEqual(await page.locator('[data-appointment-id="2"]').evaluate(node=>getComputedStyle(node).boxShadow),initialShadow);
  await page.emulateMedia({reducedMotion:'no-preference'});
  for(const language of ['en','ar']) {
    await page.evaluate(async language=>{
      currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';
      serverRows[0].status='Completed';serverRows[1].status='Cancelled';await loadChartAppointments({refresh:true});
      window.exitKeys=[...chartAppointments.exits.values()].map(animation=>animation.effect.getKeyframes());
    },language);
    assert.equal(await page.locator('[data-appointment-id="0"]').isDisabled(),true);
    assert.equal(await page.evaluate(()=>window.exitKeys.length),2);
    assert.ok(await page.evaluate(()=>window.exitKeys.every(keys=>keys[1].transform==='translateX(110%)')),'both statuses move to the physical right');
    await page.waitForFunction(()=>!document.querySelector('[data-appointment-id="0"]')&&!document.querySelector('[data-appointment-id="1"]'));
    assert.equal(await page.locator('#chart-appointments-count').textContent(),'10');
    await page.evaluate(async()=>{serverRows[0].status='Confirmed';serverRows[1].status='Scheduled';await loadChartAppointments({refresh:true});});
  }
  await page.evaluate(async()=>{failReads=true;await loadChartAppointments({refresh:true});});
  assert.equal(await page.locator('.chart-appointment-card').count(),12,'failed background refresh retains patients');
  assert.ok(await page.locator('#chart-appointments-feedback').isVisible());
  await page.evaluate(async()=>{failReads=false;serverRows=serverRows.map(row=>({...row,status:'Completed'}));await loadChartAppointments({refresh:true});});
  await page.waitForSelector('.chart-appointments-empty');
  assert.equal(await page.locator('#chart-appointments-count').textContent(),'0');
  await page.evaluate(()=>{canReadAppointments=false;renderChartAppointmentsPanel();});
  assert.equal(await page.locator('#chart-appointments-panel').isVisible(),false);
  assert.deepEqual(errors,[]);
});
