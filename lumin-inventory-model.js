/* Shared inventory rules. No DOM, credentials, or network requests. */
(function (host) {
  'use strict';
  const permissions = Object.freeze([
    {key:'inventory_manage',label:'Manage inventory items and categories',ar:'إدارة أصناف المخزون وتصنيفاته'},
    {key:'inventory_receive',label:'Receive inventory stock',ar:'استلام المخزون'},
    {key:'inventory_use',label:'Record inventory usage',ar:'تسجيل استهلاك المخزون'},
    {key:'inventory_adjust',label:'Count and adjust inventory',ar:'جرد المخزون وتسويته'}
  ]);
  function numeric(value) {
    if (value == null || String(value).trim()==='') return null;
    const text=String(value).trim().replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)).replace(/٫/g,'.').replace(/٬/g,'');
    if (!/^\d+(?:\.\d{1,3})?$/.test(text) || Number(text)>1000000000) throw new Error('INVENTORY_NUMBER');
    return Number(text);
  }
  function status(item) {
    return item.quantity==null?'unknown':Number(item.quantity)===0?'out':item.minimum==null?'unconfigured':Number(item.quantity)<=Number(item.minimum)?'low':'healthy';
  }
  function needsReview(item) { return item.quantity==null||item.minimum==null||!String(item.unit||'').trim()||!item.category_id||Boolean(item.review_note); }
  function parseCells(input) {
    const text=String(input).replace(/^\uFEFF/,'');
    if(text.length>1048576)throw new Error('INVENTORY_CSV_SIZE');
    let row=[],cell='',quoted=false,afterQuote=false;const rows=[];
    for(let i=0;i<text.length;i++){
      const c=text[i];
      if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;afterQuote=true;}}else cell+=c;continue;}
      if(c==='"'){if(cell!==''||afterQuote)throw new Error('INVENTORY_CSV_FORMAT');quoted=true;}
      else if(c===','){row.push(cell);cell='';afterQuote=false;}
      else if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(v=>v.trim()!==''))rows.push(row);row=[];cell='';afterQuote=false;}
      else{if(afterQuote&&!/\s/.test(c))throw new Error('INVENTORY_CSV_FORMAT');if(!afterQuote)cell+=c;}
    }
    if(quoted)throw new Error('INVENTORY_CSV_FORMAT');
    row.push(cell);if(row.some(v=>v.trim()!==''))rows.push(row);
    return rows;
  }
  function proposeCategory(name,source,categories) {
    const normalized=String(source||'').trim().toLowerCase();
    const exact=categories.find(c=>c.active!==false&&[c.name,c.name_ar].some(n=>String(n||'').trim().toLowerCase()===normalized));
    if(exact&&exact.key!=='consumables')return exact.id;
    if(!/consumables|مستهلكات/.test(normalized))return exact?.id||null;
    const value=String(name).toLowerCase();
    const key=/anasth|anaesth|anesth|needles?|مخدر|إبر|ابر/.test(value)?'anaesthesia'
      :/gloves?|masks?|صابون|كحول/.test(value)?'infection'
      :/blades?|sutures?|خيوط|شفرات/.test(value)?'surgical'
      :/polishing|articulating|تلميع|إطباق/.test(value)?'clinical'
      :/napkin|suction|cotton|overshoe|أكواب|اكواب|مناديل/.test(value)?'patient':null;
    return categories.find(c=>c.key===key&&c.active!==false)?.id||exact?.id||null;
  }
  function parseCSV(input,categories=[]) {
    const cells=parseCells(input);if(cells.length<2)throw new Error('INVENTORY_CSV_EMPTY');
    const header=cells[0].map(c=>c.trim().toLowerCase());
    const column=(...names)=>header.findIndex(h=>names.includes(h));
    const ix={name:column('الصنف','item','item name','name'),category:column('التصنيف','category'),quantity:column('الكمية الحالية','current quantity','quantity','current stock'),minimum:column('الحد الأدنى','الحد الادنى','minimum','minimum stock'),unit:column('الوحدة','unit','stock unit'),reference:column('reference','notes','ملاحظات','المرجع')};
    if([ix.name,ix.quantity,ix.minimum,ix.unit].some(i=>i<0))throw new Error('INVENTORY_CSV_HEADERS');
    if(cells.length>501)throw new Error('INVENTORY_CSV_SIZE');
    const seen=new Set();
    return cells.slice(1).map((r,index)=>{
      const get=key=>ix[key]<0?'':String(r[ix[key]]??'').trim();
      const name=get('name'),source=get('category'),unit=get('unit'),reference=get('reference');
      if(!name||name.length>160||unit.length>40||r.length>header.length)throw new Error('INVENTORY_CSV_ROW:'+(index+2));
      const key=source.toLowerCase()+':'+name.toLowerCase();if(seen.has(key))throw new Error('INVENTORY_CSV_DUPLICATE:'+(index+2));seen.add(key);
      let quantity,minimum;try{quantity=numeric(get('quantity'));minimum=numeric(get('minimum'));}catch(_){throw new Error('INVENTORY_CSV_NUMBER:'+(index+2));}
      const review=[];
      if(/napkin/i.test(name)&&minimum===235)review.push('Confirm source minimum 235.');
      if(reference&&quantity!=null&&minimum!=null&&quantity<=minimum&&/جيدة|good|✅/i.test(reference))review.push('Source note conflicts with recorded minimum.');
      return {name,quantity,minimum,unit,category_id:proposeCategory(name,source,categories),notes:'',review_note:review.join(' '),
        source_data:{category:source,name,quantity:get('quantity'),minimum:get('minimum'),unit,reference}};
    });
  }
  function csv(items,categories=[]) {
    const safe=value=>{let s=String(value??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
    return '\uFEFF'+[['Category','Item','Current quantity','Minimum','Unit','Reference'],...items.map(i=>[
      categories.find(c=>c.id===i.category_id)?.name||'',i.name,i.quantity??'',i.minimum??'',i.unit,i.source_data?.reference||i.notes||''
    ])].map(row=>row.map(safe).join(',')).join('\r\n');
  }
  const api={permissions,numeric,status,needsReview,parseCells,parseCSV,proposeCategory,csv};host.LuminInventoryModel=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window==='undefined'?globalThis:window);
