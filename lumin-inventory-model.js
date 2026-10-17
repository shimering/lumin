/* Shared inventory rules. No DOM, credentials, or network requests. */
(function (host) {
  'use strict';
  const permissions = Object.freeze([
    {key:'inventory_manage',label:'Manage inventory items and categories',ar:'إدارة أصناف المخزون وتصنيفاته'},
    {key:'inventory_receive',label:'Receive inventory stock',ar:'استلام المخزون'},
    {key:'inventory_use',label:'Record inventory usage',ar:'تسجيل استهلاك المخزون'},
    {key:'inventory_adjust',label:'Set opening stock and reverse movements',ar:'تحديد الرصيد الافتتاحي وعكس الحركات'}
  ]);
  const units=Object.freeze([{"value":"Box","ar":"علبة","aliases":["boxes"]},{"value":"Bottle","ar":"زجاجة","aliases":[]},{"value":"Pack","ar":"عبوة","aliases":["packs"]},{"value":"Piece","ar":"قطعة","aliases":["pcs"]},{"value":"Roll","ar":"لفة","aliases":[]},{"value":"Tube","ar":"أنبوب","aliases":[]},{"value":"Syringe","ar":"سرنجة","aliases":[]},{"value":"Cartridge","ar":"خرطوشة","aliases":[]},{"value":"Vial","ar":"قارورة","aliases":[]},{"value":"Jar","ar":"مرطبان","aliases":[]},{"value":"Pair","ar":"زوج","aliases":[]},{"value":"Set","ar":"طقم","aliases":[]},{"value":"Bag","ar":"كيس","aliases":[]},{"value":"Kit","ar":"مجموعة","aliases":[]}]);
  function numeric(value) {
    if (value == null || String(value).trim()==='') return null;
    const text=String(value).trim().replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)).replace(/٫/g,'.').replace(/٬/g,'');
    if (!/^\d+(?:\.\d{1,3})?$/.test(text) || Number(text)>1000000000) throw new Error('INVENTORY_NUMBER');
    return Number(text);
  }
  function status(item) {
    return item.quantity==null?'unknown':Number(item.quantity)===0?'out':item.minimum==null?'unconfigured':Number(item.quantity)<=Number(item.minimum)?'low':'healthy';
  }
  function needsReview(item) { return item.quantity==null||item.minimum==null||!String(item.unit||'').trim()||!item.category_id; }
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
    const ix={name:column('الصنف','item','item name','name'),category:column('التصنيف','category'),quantity:column('الكمية الحالية','current quantity','quantity','current stock'),minimum:column('الحد الأدنى','الحد الادنى','minimum','minimum stock'),unit:column('الوحدة','unit','stock unit')};
    if([ix.name,ix.quantity,ix.minimum,ix.unit].some(i=>i<0))throw new Error('INVENTORY_CSV_HEADERS');
    if(cells.length>501)throw new Error('INVENTORY_CSV_SIZE');
    const seen=new Set();
    return cells.slice(1).map((r,index)=>{
      const get=key=>ix[key]<0?'':String(r[ix[key]]??'').trim();
      const name=get('name'),source=get('category'),unit=get('unit');
      if(!name||name.length>160||unit.length>40||r.length>header.length)throw new Error('INVENTORY_CSV_ROW:'+(index+2));
      const key=name.toLowerCase();if(seen.has(key))throw new Error('INVENTORY_CSV_DUPLICATE:'+(index+2));seen.add(key);
      let quantity,minimum;try{quantity=numeric(get('quantity'));minimum=numeric(get('minimum'));}catch(_){throw new Error('INVENTORY_CSV_NUMBER:'+(index+2));}
      return {name,quantity,minimum,unit,category_id:proposeCategory(name,source,categories)};
    });
  }
  function csv(items,categories=[]) {
    const safe=value=>{let s=String(value??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
    return '\uFEFF'+[['Category','Item','Current quantity','Minimum','Unit'],...items.map(i=>[
      categories.find(c=>c.id===i.category_id)?.name||'',i.name,i.quantity??'',i.minimum??'',i.unit
    ])].map(row=>row.map(safe).join(',')).join('\r\n');
  }
  const api={permissions,units,numeric,status,needsReview,parseCells,parseCSV,proposeCategory,csv};host.LuminInventoryModel=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window==='undefined'?globalThis:window);
