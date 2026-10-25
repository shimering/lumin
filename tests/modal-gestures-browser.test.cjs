const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
test('outside swipes keep popups open while internal scrolling, deliberate taps and close confirmation work',{timeout:90000},async t=>{
  const server=http.createServer((req,res)=>res.setHeader('Content-Type','text/html').end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}#workspace{height:1600px;background:#f8fafc}.layer{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0f172a66}.layer[hidden]{display:none}.panel{width:280px;height:240px;background:white;overflow:auto;overscroll-behavior:contain}.panel p{height:850px}button{min-height:44px}</style><div id="workspace"><div id="destination" hidden></div><div id="modal-fixture" class="layer"><section class="panel"><button id="close">Close</button><p>Scrollable form</p></section></div></div>'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const browser=await chromium.launch({headless:true,channel:process.env.LUMIN_TEST_BROWSER_CHANNEL||'chrome'});t.after(()=>browser.close());
  const page=await browser.newPage({hasTouch:true}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addScriptTag({path:path.resolve('lumin-modal-gestures.js')});await page.addScriptTag({path:path.resolve('lumin-patient-swipe.js')});
  await page.evaluate(()=>{
    window.closes=0;window.confirmations=0;window.allowClose=false;window.backCount=0;window.backdropPresses=0;
    window.confirm=()=>{confirmations++;return allowClose;};
    const layer=document.querySelector('.layer');window.closePopup=()=>{if(confirm('Discard changes?')){closes++;layer.hidden=true;}};
    layer.addEventListener('pointerdown',event=>{if(event.target===layer)backdropPresses++;});
    layer.addEventListener('click',event=>{if(event.target===layer){closes++;layer.hidden=true;}});
    document.getElementById('close').onclick=closePopup;
    window.swipe=LuminPatientSwipe.create({surface:document.getElementById('workspace'),enabled:()=>true,isBlocked:()=>LuminModalGestures.hasOpenDialog(),getDestination:()=>document.getElementById('destination'),onBack:()=>{backCount++;}});
    window.outsideSwipe=(kind,inside=false,cancel=false)=>{
      const layer=document.querySelector('.layer'),target=inside?layer.querySelector('.panel'):layer;
      if(kind==='touch'){
        const emit=(type,x,y,end=false)=>{const point=new Touch({identifier:1,target,clientX:x,clientY:y});return target.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:end?[]:[point],changedTouches:[point]}));};
        emit('touchstart',10,20);window.lastMoveAllowed=emit('touchmove',240,30);emit(cancel?'touchcancel':'touchend',240,30,true);
      }else{
        const emit=(type,x,y)=>target.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,isPrimary:true,pointerId:1,pointerType:'mouse',button:0,clientX:x,clientY:y}));
        emit('pointerdown',10,20);emit('pointermove',240,30);emit(cancel?'pointercancel':'pointerup',240,30);
      }
      layer.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1}));
    };
  });
  for(const width of [390,820,1280])for(const language of ['en','ar']){
    await page.setViewportSize({width,height:900});await page.evaluate(language=>{document.documentElement.dir=language==='ar'?'rtl':'ltr';},language);
    for(const shape of ['legacy','consent','semantic']){
      await page.evaluate(shape=>{const layer=document.querySelector('.layer');layer.hidden=false;layer.id=shape==='legacy'?'modal-fixture':'popup-fixture';layer.classList.toggle('consent-overlay',shape==='consent');layer.querySelector('.panel').setAttribute('role',shape!=='legacy'?'dialog':'region');},shape);
      assert.equal(await page.evaluate(()=>LuminModalGestures.hasOpenDialog()),true);
      for(const kind of ['touch','pointer'])for(const inside of [false,true])for(const cancel of [false,true]){
        await page.evaluate(({kind,inside,cancel})=>outsideSwipe(kind,inside,cancel),{kind,inside,cancel});
        assert.equal(await page.locator('.layer').isVisible(),true,`${width}/${language}/${shape}/${kind}/${inside}/${cancel}`);
        assert.equal(await page.evaluate(()=>backCount),0);assert.equal(await page.evaluate(()=>confirmations),0,'A swipe must not invoke dismissal or confirmation');
        if(kind==='touch'&&!inside)assert.equal(await page.evaluate(()=>lastMoveAllowed),false,'Backdrop movement must not scroll the background');
        if(kind==='touch'&&inside)assert.equal(await page.evaluate(()=>lastMoveAllowed),true,'Content scrolling remains native');
      }
    }
  }
  // A real tablet touch stream must not scroll the background or dismiss the popup.
  const session=await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:10,y:100}]});
  await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:10,y:350}]});
  await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.equal(await page.locator('.layer').isVisible(),true);assert.equal(await page.evaluate(()=>scrollY),0);
  const panel=await page.locator('.panel').boundingBox();
  await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:panel.x+120,y:panel.y+180}]});
  await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:panel.x+120,y:panel.y+60}]});
  await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForFunction(()=>document.querySelector('.panel').scrollTop>0);assert.equal(await page.locator('.layer').isVisible(),true);
  await page.locator('#close').click();assert.equal(await page.evaluate(()=>confirmations),1);assert.equal(await page.locator('.layer').isVisible(),true);
  await page.evaluate(()=>allowClose=true);await page.locator('#close').click();assert.equal(await page.locator('.layer').isVisible(),false);assert.equal(await page.evaluate(()=>LuminModalGestures.hasOpenDialog()),false);
  // A deliberate new backdrop tap keeps its existing behavior after a swipe.
  await page.evaluate(()=>{document.querySelector('.layer').hidden=false;outsideSwipe('touch');});
  const presses=await page.evaluate(()=>backdropPresses);await page.mouse.click(10,100);assert.equal(await page.locator('.layer').isVisible(),false);assert.equal(await page.evaluate(()=>backdropPresses),presses+1,'Deliberate backdrop taps retain pointer initialization');
  assert.deepEqual(errors,[]);
});
