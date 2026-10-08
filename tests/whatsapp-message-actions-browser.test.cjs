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
const helpers = ['compareWhatsAppMessages','mergeWhatsAppMessages','getWhatsAppMessageCursorFilter','loadWhatsAppMessages','loadOlderWhatsAppMessages','handleWhatsAppMessagesScroll',
  'syncNewWhatsAppMessages','renderWhatsAppMessages','selectWhatsAppConversation','renderWhatsAppView',
  'initWhatsAppSwipeGestures','initWhatsAppChatSwipeToClose','handleWhatsAppInputFocus','handleWhatsAppInputBlur'].map(source).join('\n');

test('WhatsApp chat opens without composer focus; long press, dismissal, deletion, and refresh work across layouts', { skip: !chromium && 'Playwright unavailable' }, async t => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type','text/html'); res.end(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')); return; }
    const target = path.resolve(root,'.' + decodeURIComponent(url.pathname));
    if (!target.startsWith(root+path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.statusCode=404;res.end();return; }
    res.setHeader('Content-Type',target.endsWith('.css')?'text/css':'application/javascript');res.end(fs.readFileSync(target));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser = await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined});
  t.after(()=>browser.close());
  const context = await browser.newContext({viewport:{width:800,height:1100},hasTouch:true,reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']});
  const page = await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const base=`http://127.0.0.1:${server.address().port}`;
  await page.goto(base);
  await page.addScriptTag({url:base+'/vendor/lucide.min.js'});
  await page.addScriptTag({content:`
    let currentUiLanguage='en',activeWhatsAppConversationId=null,activeWhatsAppConversation=null;
    let whatsappMessages=[],whatsappConversations=[{id:'chat-1',phone:'201000000000',patient_name:'Test patient'}];
    let whatsappMessagesConversationId=null,whatsappMessagesHasOlder=false,whatsappMessagesLoadingInitial=false;
    let whatsappMessagesLoadingOlder=false,whatsappMessagesSyncing=false,whatsappMessagesRequestToken=0;
    let whatsappActiveReplyMessage=null,waChatSwipeGesture=null,waLongPressTimer=null;
    let waTouchStartX=0,waTouchStartY=0,waSwipedRow=null,waSwipedTrack=null,waSwipedIcon=null,waIsSwiping=false,waSwipeIsOutgoing=false;
    const WHATSAPP_MESSAGE_COLUMNS='*',WHATSAPP_MESSAGE_PAGE_SIZE=10,WHATSAPP_MESSAGE_SYNC_PAGE_SIZE=100;
    window.rows=Array.from({length:8},(_,i)=>({id:'message-'+i,conversation_id:'chat-1',sender:i%3===0?'patient':i%3===1?'staff':'ai',sender_name:i%3===0?'Test patient':'Clinic team',content:i===7?'A long message '+ 'clinical details '.repeat(20):'Message '+i,message_type:'text',status:'read',created_at:new Date(Date.UTC(2026,9,8,8,i)).toISOString()}));
    window.queryCount=0;window.deleteCalls=[];window.failDelete=false;window.delayDelete=false;
    function hasPageAccess(){return true;}
    function escapeHtml(value){const node=document.createElement('span');node.textContent=String(value);return node.innerHTML.replaceAll('"','&quot;');}
    function resolvePatientForWhatsApp(){return null;}function formatWhatsAppContactDisplay(value){return value;}
    function renderActiveWhatsAppAiState(){}function renderWhatsAppConversationsList(){window.previewRefreshes=(window.previewRefreshes||0)+1;}
    function formatWhatsAppTime(value){return new Date(value).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'});}
    function clearWhatsAppReplyMessage(){whatsappActiveReplyMessage=null;}
    function triggerWhatsAppReplyById(id){whatsappActiveReplyMessage=whatsappMessages.find(row=>row.id===id);document.getElementById('whatsapp-reply-input').focus();}
    async function sendWhatsAppReaction(id,emoji){window.reaction={id,emoji};}
    function showAppointmentNotificationToast(title,message){window.toast={title,message};}
    function resetWhatsAppWindowScroll(){}function scheduleWhatsAppMobileViewportUpdate(){}
    function isActiveWhatsAppChatVisible(){return !!activeWhatsAppConversationId;}
    async function markWhatsAppConversationRead(){}async function ensureWhatsAppLoaded(){}
    async function fetchWhatsAppConversations(){renderWhatsAppConversationsList();}
    const db={from(){const q={ids:null,direction:false,limitCount:100,cursor:null,
      select(){return this},eq(){return this},in(key,ids){this.ids=ids;return this},
      order(key,options){this.direction=options.ascending;return this},limit(count){this.limitCount=count;return this},or(cursor){this.cursor=cursor;return this},
      then(resolve,reject){window.queryCount++;let data=structuredClone(window.rows);if(this.ids)data=data.filter(row=>this.ids.includes(row.id));if(this.cursor){const match=this.cursor.match(/created_at.gt.([^,]+)/);if(match)data=data.filter(row=>row.created_at>match[1]);}data.sort((a,b)=>(this.direction?1:-1)*a.created_at.localeCompare(b.created_at));return Promise.resolve({data:data.slice(0,this.limitCount)}).then(resolve,reject);}};return q;},
      async rpc(name,params){window.deleteCalls.push({name,params});if(window.delayDelete)await new Promise(resolve=>window.finishDelete=resolve);if(window.failDelete)return {error:Error('Offline')};window.rows=window.rows.filter(row=>row.id!==params.p_message_id);return {data:{message_id:params.p_message_id,conversation_id:params.p_conversation_id,scope:'lumin'}};}};
    ${helpers}
  `});
  await page.addScriptTag({url:base+'/lumin-whatsapp-actions.js?v=1'});
  await page.evaluate(async()=>{
    document.getElementById('auth-gate').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');
    document.querySelectorAll('#app-main > section,#app-main > div').forEach(el=>el.classList.add('hidden'));
    document.getElementById('view-whatsapp').classList.remove('hidden');
    document.body.classList.add('whatsapp-view-active');
    await renderWhatsAppView();
  });
  assert.notEqual(await page.evaluate(()=>document.activeElement.id),'whatsapp-reply-input','opening WhatsApp on a tablet must not focus composer');
  await page.waitForTimeout(160);
  assert.notEqual(await page.evaluate(()=>document.activeElement.id),'whatsapp-reply-input','no delayed composer focus');

  const screenshots=process.env.LUMIN_WHATSAPP_SCREENSHOT_DIR || path.join(os.tmpdir(),'lumin-whatsapp-message-actions');
  fs.mkdirSync(screenshots,{recursive:true});
  for (const viewport of [{width:320,height:568},{width:390,height:844},{width:800,height:1100},{width:1024,height:768},{width:1440,height:1000}]) {
    await page.setViewportSize(viewport);
    for (const language of ['en','ar']) {
      await page.evaluate(async language=>{
        currentUiLanguage=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';
        document.body.classList.toggle('lumin-raised',language==='ar');
        await selectWhatsAppConversation('chat-1');
      },language);
      assert.notEqual(await page.evaluate(()=>document.activeElement.id),'whatsapp-reply-input');
      await page.locator('#whatsapp-msg-message-7 .wa-message-more').click();
      const geometry=await page.locator('.wa-message-menu').evaluate(el=>{
        const r=el.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,dir:el.dir,
          targets:[...el.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return {width:r.width,height:r.height};})};
      });
      assert.ok(geometry.x>=0 && geometry.y>=0 && geometry.right<=geometry.width+1 && geometry.bottom<=geometry.height+1,JSON.stringify({viewport,language,geometry}));
      assert.equal(geometry.dir,language==='ar'?'rtl':'ltr');
      assert.ok(geometry.targets.every(r=>r.width>=44 && r.height>=44),'44px menu targets');
      assert.equal(await page.locator('#whatsapp-msg-message-7 p').first().evaluate(el=>getComputedStyle(el).userSelect),'none');
      assert.ok(await page.locator('#whatsapp-msg-message-7').evaluate(el=>el.classList.contains('wa-message-selected')));
      assert.match(await page.locator('#whatsapp-msg-message-7 .whatsapp-msg-bubble-track').evaluate(el=>getComputedStyle(el).boxShadow),/167, 243, 208/,'selection glow remains visible in both themes');
      await page.locator('[data-wa-action="delete"]').click();
      assert.equal(await page.locator('.wa-message-delete-body').isVisible(),true);
      assert.equal(await page.locator('[data-wa-action="confirm-delete"]').count(),1);
      assert.equal(await page.locator('[data-wa-action="delete-everyone"]').count(),0);
      if (viewport.width===800 || viewport.width===390) await page.screenshot({path:path.join(screenshots,viewport.width+'-'+language+'.png')});
      await page.locator('[data-wa-action="cancel"]').click();
      assert.equal(await page.locator('.wa-message-menu').count(),0);
    }
  }
  await page.setViewportSize({width:800,height:1100});
  await page.evaluate(async()=>{currentUiLanguage='en';document.documentElement.dir='ltr';await selectWhatsAppConversation('chat-1');});
  const bubble=page.locator('#whatsapp-msg-message-7 p').first();
  const box=await bubble.boundingBox();
  const touch=await context.newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+20,y:box.y+20}]});
  await page.waitForTimeout(170);
  assert.ok(await page.locator('#whatsapp-msg-message-7').evaluate(el=>el.classList.contains('wa-message-pressing')),'press feedback appears before menu');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.wa-message-menu').count(),1,'real touch hold opens menu');
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.equal(await page.evaluate(()=>window.getSelection().toString()),'','hold does not select text');
  await page.keyboard.press('Tab');
  assert.ok(await page.locator('.wa-message-menu').evaluate(el=>el.contains(document.activeElement)),'keyboard focus stays inside menu');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.wa-message-menu').count(),0);

  // Movement, multitouch, and pointer cancellation must cancel long press.
  for (const action of ['move','cancel','multitouch']) {
    await bubble.dispatchEvent('pointerdown',{button:0,pointerId:1,isPrimary:true,clientX:100,clientY:100});
    if(action==='move')await page.dispatchEvent('body','pointermove',{pointerId:1,clientX:100,clientY:130});
    if(action==='cancel')await page.dispatchEvent('body','pointercancel',{pointerId:1});
    if(action==='multitouch')await page.locator('#whatsapp-messages-container').dispatchEvent('touchstart',{touches:[{identifier:1,clientX:100,clientY:100},{identifier:2,clientX:130,clientY:100}]});
    await page.waitForTimeout(450);
    assert.equal(await page.locator('.wa-message-menu').count(),0,action+' cancels hold');
  }
  await page.locator('#whatsapp-msg-message-7 .wa-message-more').click();
  await page.locator('[data-wa-action="copy"]').click();
  await page.waitForFunction(()=>window.toast?.message);
  assert.match(await page.evaluate(()=>window.toast.message),/copied/);
  await page.locator('#whatsapp-msg-message-7 .wa-message-more').click();
  await page.locator('[data-wa-reaction="👍"]').click();
  assert.deepEqual(await page.evaluate(()=>window.reaction),{id:'message-7',emoji:'👍'});
  await page.locator('#whatsapp-msg-message-7 .wa-message-more').click();
  await page.locator('[data-wa-action="reply"]').click();
  assert.equal(await page.evaluate(()=>document.activeElement.id),'whatsapp-reply-input','explicit reply still focuses the composer');
  await page.evaluate(()=>document.getElementById('whatsapp-reply-input').blur());

  await page.locator('#whatsapp-msg-message-7 .wa-message-more').click();
  await page.locator('[data-wa-action="delete"]').click();
  await page.evaluate(()=>{window.failDelete=true;});
  await page.locator('[data-wa-action="confirm-delete"]').click();
  await page.waitForFunction(()=>document.querySelector('.wa-message-delete-error')?.hidden===false);
  assert.equal(await page.locator('#whatsapp-msg-message-7').count(),1,'failed deletion retains message');
  await page.evaluate(()=>{window.failDelete=false;window.delayDelete=true;});
  await page.locator('[data-wa-action="confirm-delete"]').click();
  await page.waitForFunction(()=>typeof window.finishDelete==='function');
  assert.equal(await page.locator('[data-wa-action="confirm-delete"]').isDisabled(),true,'duplicate deletion is disabled');
  await page.evaluate(()=>window.finishDelete());
  await page.waitForFunction(()=>!document.getElementById('whatsapp-msg-message-7'));
  assert.equal(await page.locator('.wa-message-menu').count(),0);
  await page.evaluate(async()=>{window.delayDelete=false;await syncNewWhatsAppMessages();await selectWhatsAppConversation('chat-1');});
  assert.equal(await page.locator('#whatsapp-msg-message-7').count(),0,'delete survives refresh and reopening');
  assert.deepEqual(await page.evaluate(()=>window.deleteCalls.at(-1)),{name:'delete_whatsapp_message_from_lumin',params:{p_message_id:'message-7',p_conversation_id:'chat-1'}});
  await page.evaluate(async()=>{
    whatsappActiveReplyMessage=whatsappMessages.find(row=>row.id==='message-0');
    openWhatsAppMessageMenu(null,'message-0');window.rows=window.rows.filter(row=>row.id!=='message-0');
    await syncNewWhatsAppMessages();
  });
  assert.equal(await page.locator('#whatsapp-msg-message-0').count(),0,'another device’s deletion is reconciled');
  assert.equal(await page.evaluate(()=>whatsappActiveReplyMessage),null,'deleted reply target is cleared');
  assert.equal(await page.locator('.wa-message-menu').count(),0,'remote deletion closes stale menu');
  const reconciled=await page.evaluate(async()=>{
    window.rows=Array.from({length:205},(_,i)=>({id:'history-'+i,conversation_id:'chat-1',sender:'patient',content:'History '+i,message_type:'text',created_at:new Date(Date.UTC(2026,9,8,8,i)).toISOString()}));
    whatsappMessages=structuredClone(window.rows);
    window.rows=window.rows.filter(row=>!['history-0','history-101'].includes(row.id));
    window.rows[0].reaction='❤️';
    const queries=window.queryCount;await syncNewWhatsAppMessages();
    return {queries:window.queryCount-queries,count:whatsappMessages.length,first:whatsappMessages[0].id,reaction:whatsappMessages[0].reaction,last:whatsappMessages.at(-1).id};
  });
  assert.deepEqual(reconciled,{queries:4,count:203,first:'history-1',reaction:'❤️',last:'history-204'},'loaded history reconciles deletion and reactions in bounded batches');
  assert.deepEqual(errors,[]);
});
