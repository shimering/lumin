(function(root){
  'use strict';
  const doc=()=>root.LuminConsentDocument;
  const instances=new WeakMap();let registered=false,sequence=0;
  const language=()=>typeof currentUiLanguage!=='undefined'?currentUiLanguage:document.documentElement.lang;
  const t=(en,ar)=>language()==='ar'?ar:en;
  const e=value=>doc().escape(value);
  const i=name=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
  function register(){
    if(registered)return;registered=true;
    root.LuminConsentTables.register();
    for(const key of ['font','size','align','direction']){
      const format=root.Quill.import('attributors/style/'+key);
      if(key==='font')format.whitelist=doc().fonts;if(key==='size')format.whitelist=doc().sizes;
      root.Quill.register(format,true);
    }
    const Embed=root.Quill.import('blots/embed');
    class Variable extends Embed{
      static blotName='consentVariable';static tagName='span';static className='consent-variable-label';
      static create(value){const node=super.create();if(!doc().variables.some(row=>row[0]===value))throw new Error('variable');node.dataset.variable=value;node.setAttribute('contenteditable','false');node.setAttribute('dir','ltr');node.textContent='{{'+value+'}}';return node;}
      static value(node){return node.dataset.variable;}
    }
    root.Quill.register(Variable,true);
  }
  function mount(container,options){
    register();const id='consent-writing-'+(++sequence),direction=options.language==='ar'?'rtl':'ltr',events=new AbortController();
    const command=(name,label,icon,value='')=>`<button type="button" class="consent-editor-tool" data-editor-command="${name}" data-value="${e(value)}" title="${label}" aria-label="${label}" ${['bold','italic','underline','strike','list','align','direction'].includes(name)?'aria-pressed="false"':''}>${i(icon)}</button>`;
    container.classList.add('consent-editor');container.dataset.editorName=options.name;container.dir=direction;
    container.innerHTML=`<div class="consent-editor-heading"><label id="${id}-label" for="${id}">${e(options.label)}</label><button type="button" class="consent-editor-tool" data-editor-command="expand" aria-label="${t('Expand editor','توسيع المحرر')}" title="${t('Expand editor','توسيع المحرر')}">${i('maximize-2')}</button></div><div class="consent-editor-toolbar" role="toolbar" aria-label="${t('Text formatting','تنسيق النص')}" dir="${language()==='ar'?'rtl':'ltr'}"><div class="consent-editor-toolgroup"><select data-editor-format="font" aria-label="${t('Font','الخط')}"><option value="">${t('Default font','الخط الافتراضي')}</option>${doc().fonts.map(font=>`<option value="${e(font)}" style="font-family:${e(font)}">${e(font)}${font==='Amiri'?' · أميري':''}</option>`).join('')}</select><select data-editor-format="size" aria-label="${t('Text size','حجم النص')}"><option value="">${t('Size','الحجم')}</option>${doc().sizes.map(size=>`<option value="${size}">${parseInt(size)}</option>`).join('')}</select><select data-editor-format="header" aria-label="${t('Paragraph style','نمط الفقرة')}"><option value="">${t('Paragraph','فقرة')}</option><option value="1">${t('Heading 1','عنوان ١')}</option><option value="2">${t('Heading 2','عنوان ٢')}</option><option value="3">${t('Heading 3','عنوان ٣')}</option></select></div><div class="consent-editor-toolgroup">${command('bold',t('Bold (Ctrl+B)','عريض (Ctrl+B)'),'bold')}${command('italic',t('Italic (Ctrl+I)','مائل (Ctrl+I)'),'italic')}${command('underline',t('Underline (Ctrl+U)','تسطير (Ctrl+U)'),'underline')}${command('strike',t('Strikethrough','شطب'),'strikethrough')}<label class="consent-editor-color" title="${t('Text color','لون النص')}">${i('palette')}<input type="color" value="#334155" data-editor-format="color" aria-label="${t('Text color','لون النص')}"/></label></div><div class="consent-editor-toolgroup">${command('list',t('Bullet list','قائمة نقطية'),'list','bullet')}${command('list',t('Numbered list','قائمة مرقمة'),'list-ordered','ordered')}${command('indent',t('Increase indent','زيادة المسافة البادئة'),'indent-increase','+1')}${command('indent',t('Decrease indent','تقليل المسافة البادئة'),'indent-decrease','-1')}</div><div class="consent-editor-toolgroup">${command('align',t('Align left','محاذاة لليسار'),'align-left','left')}${command('align',t('Align center','توسيط'),'align-center','center')}${command('align',t('Align right','محاذاة لليمين'),'align-right','right')}${command('align',t('Justify','ضبط النص'),'align-justify','justify')}${command('direction',t('Right-to-left text','اتجاه من اليمين إلى اليسار'),'pilcrow-right','rtl')}</div><div class="consent-editor-toolgroup">${command('undo',t('Undo','تراجع'),'undo-2')}${command('redo',t('Redo','إعادة'),'redo-2')}${command('clear',t('Clear formatting','مسح التنسيق'),'remove-formatting')}</div></div><div id="${id}" class="consent-editor-canvas" role="group" aria-labelledby="${id}-label" dir="${direction}"></div><textarea name="${e(options.name)}" data-consent-plain dir="${direction}" hidden></textarea><div class="consent-editor-status" aria-live="polite"></div><details class="consent-editor-variables" open><summary>${i('braces')}${t('Insert a field','إدراج حقل')}</summary><div class="consent-variable-buttons">${doc().variables.map(([key,en,ar],index)=>`<button type="button" class="consent-variable-button consent-variable-tone-${index%4}" data-editor-variable="${key}" title="${e('{{'+key+'}}')}">${e(language()==='ar'?ar:en)}</button>`).join('')}</div><p>${options.values?t('Click a label to insert this patient’s details at the cursor.','اضغط على اسم الحقل لإدراج بيانات هذا المريض عند المؤشر.'):t('Click a label to insert an automatic field at the cursor.','اضغط على اسم الحقل لإدراج حقل تلقائي عند المؤشر.')}</p></details>`;
    container.querySelector('.consent-editor-toolbar').insertAdjacentHTML('beforeend',`<div class="consent-editor-toolgroup">${command('table',t('Insert table','إدراج جدول'),'table-2')}</div>`);
    const quill=new root.Quill(container.querySelector('.consent-editor-canvas'),{theme:null,modules:{toolbar:false,table:true,history:{delay:600,maxStack:100,userOnly:false}},formats:['bold','italic','underline','strike','font','size','color','background','header','indent','align','direction','list','script','blockquote','consentVariable','table','cellWidth','cellHeight']});
    quill.root.setAttribute('role','textbox');quill.root.setAttribute('aria-multiline','true');quill.root.setAttribute('aria-label',options.label);quill.root.setAttribute('dir',direction);quill.root.setAttribute('lang',options.language);
    const values=()=>typeof options.values==='function'?options.values():options.values;
    const source=doc().tokenize(doc().read(options.document,options.text));
    quill.setContents(options.values?doc().resolve(source,values()):source,'silent');quill.history.clear();
    const hidden=container.querySelector('[data-consent-plain]'),status=container.querySelector('.consent-editor-status');
    let lastRange={index:0,length:0},disposed=false,version=0;
    function sync(source){
      try{const value=doc().normalize(quill.getContents());hidden.value=doc().text(value);status.textContent=`${hidden.value.length.toLocaleString(language()==='ar'?'ar-EG':'en-GB')} / 40,000`;status.classList.remove('is-error');}
      catch{status.textContent=t('This document is too long or has unsupported formatting.','المستند طويل جداً أو يحتوي على تنسيق غير مدعوم.');status.classList.add('is-error');}
      if(source!=='silent'){version++;hidden.dispatchEvent(new Event('input',{bubbles:true}));options.onChange?.();}updateToolbar();
    }
    function selection(){const range=quill.getSelection()||lastRange;return {index:Math.min(range.index,quill.getLength()-1),length:Math.min(range.length,Math.max(0,quill.getLength()-1-range.index))};}
    function restore(){const range=selection();quill.focus({preventScroll:true});quill.setSelection(range,'silent');return range;}
    function updateToolbar(){
      const formats=quill.getFormat(selection());
      container.querySelectorAll('[data-editor-command][aria-pressed]').forEach(button=>{const key=button.dataset.editorCommand,value=button.dataset.value;button.setAttribute('aria-pressed',String(value?formats[key]===value:formats[key]===true));});
      container.querySelectorAll('select[data-editor-format]').forEach(select=>{const value=formats[select.dataset.editorFormat];select.value=Array.isArray(value)?'':value||'';});
    }
    function run(name,value){
      const range=restore(),formats=quill.getFormat(range);
      if(name==='table')tableUI.insert();
      else if(name==='undo')quill.history.undo();
      else if(name==='redo')quill.history.redo();
      else if(name==='clear')quill.removeFormat(range.index,range.length,'user');
      else if(name==='indent')quill.format('indent',value,'user');
      else if(['list','align','direction'].includes(name))quill.format(name,formats[name]===value?false:value,'user');
      else quill.format(name,!formats[name],'user');updateToolbar();
    }
    container.addEventListener('mousedown',event=>{if(event.target.closest('button'))event.preventDefault();},{signal:events.signal});
    container.addEventListener('click',event=>{
      const variable=event.target.closest('[data-editor-variable]');
      if(variable){const range=restore(),key=variable.dataset.editorVariable;quill.history.cutoff();if(range.length)quill.deleteText(range.index,range.length,'user');if(options.values){const value=String(values()[key]??'');quill.insertText(range.index,value,'user');quill.setSelection(range.index+value.length,0,'silent');}else{quill.insertEmbed(range.index,'consentVariable',key,'user');quill.setSelection(range.index+1,0,'silent');}quill.history.cutoff();return;}
      const trigger=event.target.closest('[data-editor-command]');if(!trigger||trigger.disabled)return;
      if(trigger.dataset.editorCommand==='expand'){const expanded=container.classList.toggle('is-expanded');trigger.setAttribute('aria-label',expanded?t('Collapse editor','تصغير المحرر'):t('Expand editor','توسيع المحرر'));return;}
      run(trigger.dataset.editorCommand,trigger.dataset.value);
    },{signal:events.signal});
    container.addEventListener('keydown',event=>{
      if(!container.classList.contains('is-expanded'))return;
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();container.classList.remove('is-expanded');container.querySelector('[data-editor-command="expand"]').focus();}
      if(event.key==='Tab'){
        const controls=[...container.querySelectorAll('button,select,input,[contenteditable="true"]')].filter(node=>!node.disabled&&node.getClientRects().length),first=controls[0],last=controls.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();event.stopPropagation();last?.focus();}
        if(!event.shiftKey&&document.activeElement===last){event.preventDefault();event.stopPropagation();first?.focus();}
      }
    },{signal:events.signal});
    container.querySelectorAll('[data-editor-format]').forEach(control=>control.addEventListener('change',()=>{restore();const key=control.dataset.editorFormat;quill.format(key,key==='header'?(Number(control.value)||false):(control.value||false),'user');updateToolbar();},{signal:events.signal}));
    // Quill accepts only registered formats. DOMPurify also strips active pasted HTML.
    quill.root.addEventListener('paste',event=>{
      const html=event.clipboardData?.getData('text/html');if(!html)return;
      event.preventDefault();event.stopImmediatePropagation();const range=restore();
      const clean=root.DOMPurify.sanitize(html,{ALLOWED_TAGS:['p','br','div','span','strong','b','em','i','u','s','strike','h1','h2','h3','blockquote','ul','ol','li','sub','sup','table','tbody','thead','tr','td','th'],ALLOWED_ATTR:['style','dir'],ALLOW_DATA_ATTR:false});
      const contents=quill.clipboard.convert({html:clean});const Delta=root.Quill.import('delta');quill.updateContents(new Delta().retain(range.index).delete(range.length).concat(contents),'user');quill.setSelection(range.index+contents.length(),0,'silent');
    },{capture:true,signal:events.signal});
    quill.on('selection-change',range=>{if(range)lastRange=range;updateToolbar();});
    quill.on('text-change',(_delta,_old,source)=>sync(source));sync('silent');
    const api={quill,get version(){return version;},getDocument(){return doc().normalize(quill.getContents());},getText(){return doc().text(api.getDocument());},setDocument(value,source='api'){quill.setContents(doc().normalize(value),source);sync('silent');},setDisabled(value){quill.enable(!value);container.querySelectorAll('button,select,input').forEach(node=>node.disabled=value);},validate(){try{if(api.getText().length>40000||(options.required&&!api.getText()))throw new Error('empty');return true;}catch{status.textContent=t('Enter consent text within 40,000 characters.','أدخل نص الموافقة في حدود ٤٠٬٠٠٠ حرف.');status.classList.add('is-error');quill.focus();return false;}},replaceText(before,after){const index=quill.getText().indexOf(before);if(index<0||before===after)return;const Delta=root.Quill.import('delta');quill.updateContents(new Delta().retain(index).delete(before.length).insert(after,quill.getFormat(index,1)),'api');},dispose(){if(disposed)return;disposed=true;quill.enable(false);quill.off('text-change');quill.off('selection-change');instances.delete(container);}};
    const tableUI=root.LuminConsentTables.mount(container,quill),disable=api.setDisabled,dispose=api.dispose;
    api.setDisabled=value=>{disable(value);tableUI.setDisabled(value);};api.dispose=()=>{events.abort();tableUI.dispose();dispose();};
    instances.set(container,api);container.consentEditor=api;if(root.lucide)lucide.createIcons();return api;
  }
  root.LuminConsentEditor={mount,get:element=>instances.get(element)};
})(window);
