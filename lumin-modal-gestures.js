(function(root){
  'use strict';
  if(root.LuminModalGestures)return;
  const doc=root.document;
  const layers='.consent-overlay,.modal-overlay,.modal-backdrop,.dialog-overlay,.appointment-card-popover-layer,#chart-media-backdrop,[data-modal-backdrop],[id^="modal-"],[id$="-modal"],[id$="-modal-overlay"]';
  const dialogs=layers+',[aria-modal="true"],[role="dialog"]';
  const semantic='[aria-modal="true"],[role="dialog"]';
  // Keep backdrop swipes from becoming dismissal clicks while leaving form gestures native.
  let gesture=null,blockedClick=null;
  const visible=node=>!node.hidden&&node.getClientRects().length&&root.getComputedStyle(node).visibility!=='hidden';
  function layerFor(target){
    for(let node=target;node&&node!==doc.body;node=node.parentElement){
      if(!node.matches?.(layers)&&!node.matches?.(semantic)&&!node.querySelector?.(semantic))continue;
      if(!visible(node))continue;
      const style=root.getComputedStyle(node),rect=node.getBoundingClientRect();
      if(['fixed','absolute'].includes(style.position)&&rect.width>=root.innerWidth*.9&&rect.height>=root.innerHeight*.8)return node;
    }
    return null;
  }
  function begin(event,point,kind){
    const layer=layerFor(event.target);blockedClick=null;
    gesture=layer?{layer,x:point.clientX,y:point.clientY,moved:false,outside:event.target===layer,kind}:null;
  }
  function move(event,point,kind){
    if(!gesture||gesture.kind!==kind)return;
    if(Math.hypot(point.clientX-gesture.x,point.clientY-gesture.y)>8)gesture.moved=true;
    if(gesture.outside){if(event.cancelable)event.preventDefault();event.stopPropagation();}
  }
  function finish(event,kind,cancelled=false){
    if(!gesture||gesture.kind!==kind)return;
    if(gesture.moved||cancelled){
      blockedClick={layer:gesture.layer,until:root.performance.now()+750};
      if(gesture.outside&&event.cancelable)event.preventDefault();
    }
    if((gesture.moved||cancelled)&&(gesture.outside||event.target===gesture.layer))event.stopPropagation();
    gesture=null;
  }
  doc.addEventListener('pointerdown',event=>{if(event.isPrimary&&event.button===0)begin(event,event,'pointer');},true);
  doc.addEventListener('pointermove',event=>move(event,event,'pointer'),{capture:true,passive:false});
  doc.addEventListener('pointerup',event=>finish(event,'pointer'),true);
  doc.addEventListener('pointercancel',event=>finish(event,'pointer',true),true);
  doc.addEventListener('touchstart',event=>{if(event.touches.length===1)begin(event,event.touches[0],'touch');},{capture:true,passive:true});
  doc.addEventListener('touchmove',event=>{if(event.touches[0])move(event,event.touches[0],'touch');},{capture:true,passive:false});
  doc.addEventListener('touchend',event=>{if(!event.touches.length)finish(event,'touch');},{capture:true,passive:false});
  doc.addEventListener('touchcancel',event=>finish(event,'touch',true),{capture:true,passive:false});
  doc.addEventListener('click',event=>{
    if(event.detail&&blockedClick&&root.performance.now()<blockedClick.until&&event.target===blockedClick.layer){
      blockedClick=null;event.preventDefault();event.stopImmediatePropagation();
    }
  },true);
  root.LuminModalGestures={hasOpenDialog:()=>[...doc.querySelectorAll(dialogs)].some(visible)};
})(window);
