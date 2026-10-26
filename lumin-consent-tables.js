(function(root){
  'use strict';
  let registered=false;
  const text=(en,ar)=>((typeof currentUiLanguage!=='undefined'?currentUiLanguage:document.documentElement.lang)==='ar'?ar:en);
  function register(){
    if(registered)return;registered=true;
    const {StyleAttributor,Scope}=root.Quill.import('parchment');
    for(const [key,style] of [['cellWidth','width'],['cellHeight','height']]){
      class Dimension extends StyleAttributor{add(node,value){return root.LuminConsentDocument.dimensionValid(key,value)&&super.add(node,value);}}
      root.Quill.register(new Dimension(key,style,{scope:Scope.BLOCK_ATTRIBUTE}),true);
    }
  }
  function mount(container,quill){
    const canvas=container.querySelector('.consent-editor-canvas'),stage=document.createElement('div');stage.className='consent-table-stage';canvas.before(stage);stage.appendChild(canvas);
    const overlay=document.createElement('div');overlay.className='consent-table-overlay';overlay.hidden=true;stage.appendChild(overlay);
    const menu=document.createElement('div');menu.className='consent-table-menu';menu.hidden=true;
    const labels={row:text('Add row','إضافة صف'),column:text('Add column','إضافة عمود'),'fit-row':text('Fit row to text','ملاءمة الصف للنص'),'delete-row':text('Delete row','حذف الصف'),'delete-column':text('Delete column','حذف العمود'),'delete-table':text('Delete table','حذف الجدول')};
    menu.innerHTML=Object.entries(labels).map(([action,label])=>`<button type="button" class="consent-table-action" data-table-action="${action}"><i data-lucide="${action==='row'?'rows-3':action==='column'?'columns-3':action==='fit-row'?'move-vertical':'trash-2'}" aria-hidden="true"></i>${label}</button>`).join('');stage.before(menu);
    const tableModule=quill.getModule('table');let active=null,drag=null,disabled=false,disposed=false,frame=0,stamp='',renderedTable=null;
    const cellBlot=cell=>root.Quill.find(cell),offset=cell=>cellBlot(cell).offset(quill.scroll);
    function layout(){quill.root.querySelectorAll('table').forEach(table=>{const cells=[...(table.rows[0]?.cells||[])];table.style.width=cells.reduce((sum,cell)=>sum+(parseInt(cell.style.width)||160),0)+'px';});}
    function select(cell){if(!cell)return;quill.focus({preventScroll:true});quill.setSelection(offset(cell),0,'silent');active=cell.closest('table');}
    function formatCells(cells,key,value){cells.forEach(cell=>cellBlot(cell)?.format(key,value));quill.update('user');layout();}
    function defaults(table){[...table.rows].forEach(row=>[...row.cells].forEach((cell,index)=>{const blot=cellBlot(cell);if(!cell.style.width)blot.format('cellWidth',table.rows[0].cells[index]?.style.width||'160px');if(!cell.style.height)blot.format('cellHeight','44px');}));quill.update('user');layout();}
    function refresh(){
      if(disposed)return;layout();if(drag)return;
      const selected=tableModule.getTable()[0]?.domNode;
      if(selected)active=selected;
      if(!active?.isConnected||!container.contains(active)||disabled){overlay.hidden=true;menu.hidden=true;return;}
      overlay.hidden=false;menu.hidden=false;
      const bounds=active.getBoundingClientRect(),host=stage.getBoundingClientRect(),rtl=getComputedStyle(active).direction==='rtl';
      Object.assign(overlay.style,{left:bounds.left-host.left+stage.scrollLeft+'px',top:bounds.top-host.top+stage.scrollTop+'px',width:bounds.width+'px',height:bounds.height+'px'});
      const columns=[...(active.rows[0]?.cells||[])],rows=[...active.rows];
      const nextStamp=JSON.stringify([rtl,columns.map(cell=>cell.getBoundingClientRect().width),rows.map(row=>row.getBoundingClientRect().height)]);
      if(stamp===nextStamp&&renderedTable===active)return;stamp=nextStamp;renderedTable=active;
      const handle=(axis,index,position,value)=>`<button type="button" class="consent-table-resize is-${axis}" data-table-resize="${axis}" data-index="${index}" role="separator" aria-orientation="${axis==='column'?'vertical':'horizontal'}" aria-label="${axis==='column'?text('Column width','عرض العمود'):text('Row height','ارتفاع الصف')} ${index+1}" aria-valuemin="${axis==='column'?64:16}" aria-valuemax="${axis==='column'?640:480}" aria-valuenow="${value}" style="${position}" title="${text('Drag to resize; use arrow keys for fine adjustments','اسحب لتغيير الحجم؛ استخدم الأسهم للضبط الدقيق')}"><span></span></button>`;
      overlay.innerHTML=columns.map((cell,index)=>{const rect=cell.getBoundingClientRect();return handle('column',index,`left:${(rtl?rect.left:rect.right)-bounds.left-22}px;top:-48px`,parseInt(cell.style.width)||160);}).join('')+rows.map((row,index)=>handle('row',index,`${rtl?'right':'left'}:-48px;top:${row.getBoundingClientRect().bottom-bounds.top-22}px`,parseInt(row.cells[0]?.style.height)||Math.round(row.getBoundingClientRect().height))).join('')+`<button type="button" class="consent-table-edge consent-table-action" data-table-action="column" aria-label="${labels.column}" title="${labels.column}" style="${rtl?'right':'left'}:calc(100% + 4px);top:0"><i data-lucide="plus" aria-hidden="true"></i></button><button type="button" class="consent-table-edge consent-table-action" data-table-action="row" aria-label="${labels.row}" title="${labels.row}" style="top:calc(100% + 4px);${rtl?'right':'left'}:0"><i data-lucide="plus" aria-hidden="true"></i></button>`;
      menu.querySelector('[data-table-action="row"]').disabled=rows.length>=50;menu.querySelector('[data-table-action="column"]').disabled=columns.length>=12;
      overlay.querySelector('[data-table-action="row"]').disabled=rows.length>=50;overlay.querySelector('[data-table-action="column"]').disabled=columns.length>=12;
      if(root.lucide)lucide.createIcons();
    }
    function schedule(){if(!frame&&!disposed)frame=requestAnimationFrame(()=>{frame=0;refresh();});}
    function insert(){
      if(disabled)return;
      if(!tableModule.getTable()[0]){quill.history.cutoff();const range=quill.getSelection();if(range){if(range.length)quill.deleteText(range.index,range.length,'user');if(quill.getLine(range.index)[1]>0){quill.insertText(range.index,'\n','user');quill.setSelection(range.index+1,0,'silent');}}tableModule.insertTable(2,2);active=tableModule.getTable()[0]?.domNode;if(active)defaults(active);quill.history.cutoff();}
      refresh();
    }
    function action(name){
      if(disabled||!active?.isConnected)return;const table=active,rows=[...table.rows],columns=rows[0].cells.length;
      quill.history.cutoff();
      if(name==='row'&&rows.length<50){select(rows.at(-1).cells[0]);tableModule.insertRowBelow();defaults(table);select(table.rows[table.rows.length-1].cells[0]);}
      if(name==='column'&&columns<12){select(rows[0].cells[columns-1]);tableModule.insertColumnRight();defaults(table);select(table.rows[0].cells[columns]);}
      if(name==='fit-row'){const selected=tableModule.getTable()[1]?.domNode||rows[0];formatCells([...selected.cells],'cellHeight','auto');}
      if(name.startsWith('delete-')){
        if(!tableModule.getTable()[0])select(rows[0].cells[0]);
        if(name==='delete-table'||(name==='delete-row'&&rows.length===1)||(name==='delete-column'&&columns===1)){tableModule.deleteTable();active=null;}
        else if(name==='delete-row')tableModule.deleteRow();else tableModule.deleteColumn();
      }
      quill.history.cutoff();refresh();
    }
    function click(event){const button=event.target.closest('[data-table-action]');if(button&&!button.disabled){event.preventDefault();event.stopPropagation();action(button.dataset.tableAction);}}
    menu.addEventListener('click',click);overlay.addEventListener('click',click);
    function dimensions(axis,index){return axis==='column'?[...active.rows].map(row=>row.cells[index]).filter(Boolean):[...active.rows[index].cells];}
    function resize(axis,index,value){const key=axis==='column'?'cellWidth':'cellHeight';formatCells(dimensions(axis,index),key,Math.max(axis==='column'?64:16,Math.min(axis==='column'?640:480,Math.round(value)))+'px');}
    overlay.addEventListener('pointerdown',event=>{
      const handle=event.target.closest('[data-table-resize]');if(!handle||disabled||event.button!==0)return;event.preventDefault();event.stopPropagation();
      drag={axis:handle.dataset.tableResize,index:Number(handle.dataset.index),start:event.clientX,y:event.clientY,value:Number(handle.getAttribute('aria-valuenow')),rtl:getComputedStyle(active).direction==='rtl',handle};
      quill.history.cutoff();handle.setPointerCapture(event.pointerId);handle.classList.add('is-dragging');
    });
    overlay.addEventListener('pointermove',event=>{if(!drag)return;event.preventDefault();resize(drag.axis,drag.index,drag.value+(drag.axis==='column'?(event.clientX-drag.start)*(drag.rtl?-1:1):event.clientY-drag.y));});
    function finish(){if(!drag)return;drag=null;quill.history.cutoff();refresh();}
    overlay.addEventListener('pointerup',finish);overlay.addEventListener('pointercancel',finish);
    overlay.addEventListener('keydown',event=>{const handle=event.target.closest('[data-table-resize]');if(!handle||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const axis=handle.dataset.tableResize,index=Number(handle.dataset.index),rtl=getComputedStyle(active).direction==='rtl',sign=(event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:1)*(axis==='column'&&rtl?-1:1);resize(axis,index,Number(handle.getAttribute('aria-valuenow'))+sign*8);refresh();overlay.querySelector(`[data-table-resize="${axis}"][data-index="${index}"]`)?.focus();});
    function rootPointer(event){const cell=event.target.closest('td');if(cell){active=cell.closest('table');schedule();}else{active=null;overlay.hidden=true;menu.hidden=true;}}
    quill.root.addEventListener('pointerup',rootPointer);quill.on('selection-change',schedule);quill.on('text-change',schedule);stage.addEventListener('scroll',schedule);
    layout();
    const observer=new ResizeObserver(schedule);observer.observe(stage);schedule();
    return {insert,refresh:schedule,setDisabled(value){disabled=value;menu.querySelectorAll('button').forEach(button=>button.disabled=value);refresh();},dispose(){disposed=true;observer.disconnect();cancelAnimationFrame(frame);quill.off('selection-change',schedule);quill.off('text-change',schedule);quill.root.removeEventListener('pointerup',rootPointer);}};
  }
  root.LuminConsentTables={register,mount};
})(window);
