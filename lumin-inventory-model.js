/* Shared inventory rules. No DOM, credentials, or network requests. */
(function (host) {
  'use strict';
  const permissions = Object.freeze([
    {key:'inventory_manage',label:'Manage inventory items and categories',ar:'إدارة أصناف المخزون وتصنيفاته'},
    {key:'inventory_receive',label:'Receive inventory stock',ar:'استلام المخزون'},
    {key:'inventory_use',label:'Record inventory usage',ar:'تسجيل استهلاك المخزون'},
    {key:'inventory_adjust',label:'Set opening stock',ar:'تحديد الرصيد الافتتاحي'}
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
  function names(item) {
    if(item.name_en!=null||item.name_ar!=null)return {name_en:item.name_en||'',name_ar:item.name_ar||''};
    const name=String(item.name||'');
    return /[\u0600-\u06ff]/.test(name)?{name_en:'',name_ar:name}:{name_en:name,name_ar:''};
  }
  function itemName(item,language='en') {
    const value=names(item);
    return (language==='ar'?value.name_ar||value.name_en:value.name_en||value.name_ar)||item.name||'';
  }
  function categoryPath(category,categories=[]) {
    const path=[],seen=new Set();let current=category;
    while(current&&!seen.has(current.id)&&path.length<3){path.unshift(current);seen.add(current.id);current=categories.find(c=>c.id===current.parent_id);}
    return path;
  }
  function categoryTree(categories=[],language='en') {
    const active=categories.filter(c=>c.active!==false),seen=new Set(),rows=[];
    const label=c=>language==='ar'&&c.name_ar?c.name_ar:c.name;
    const visit=(parent,depth)=>active.filter(c=>(c.parent_id||null)===parent).sort((a,b)=>label(a).localeCompare(label(b),language)).forEach(c=>{
      if(seen.has(c.id)||depth>2)return;seen.add(c.id);rows.push({...c,depth});visit(c.id,depth+1);
    });
    visit(null,0);return rows;
  }
  function categoryMoveTargets(category,categories=[],language='en') {
    if(!category?.parent_id)return [];
    const descendants=new Set([category.id]);let height=0;
    for(let depth=1;depth<=2;depth++){const children=categories.filter(c=>descendants.has(c.parent_id)&&!descendants.has(c.id));if(!children.length)break;children.forEach(c=>descendants.add(c.id));height=depth;}
    return categoryTree(categories,language).filter(c=>!descendants.has(c.id)&&c.depth+1+height<=2);
  }
  function resolveCategory(parts,categories) {
    let parent=null,match=null;
    for(const part of parts){
      if(!part)continue;
      const aliases=[part,...part.split(/[()]/)].map(s=>s.trim().toLowerCase()).filter(Boolean);
      match=categories.find(c=>c.active!==false&&(c.parent_id||null)===parent&&[c.name,c.name_ar].some(name=>aliases.includes(String(name||'').trim().toLowerCase())));
      if(!match)return null;parent=match.id;
    }
    return match?.id||null;
  }
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
    const ix={name:column('الصنف','item','item name','name'),name_en:column('english name','english item name','الاسم بالإنجليزية','اسم الصنف بالإنجليزية'),name_ar:column('arabic name','arabic item name','الاسم بالعربية','اسم الصنف بالعربية'),category:column('التصنيف','category'),subcategory:column('subcategory','sub category','التصنيف الفرعي'),subcategory2:column('second subcategory','subcategory 2','التصنيف الفرعي الثاني'),quantity:column('الكمية الحالية','current quantity','quantity','current stock'),minimum:column('الحد الأدنى','الحد الادنى','minimum','minimum stock'),unit:column('الوحدة','unit','stock unit')};
    if(Math.max(ix.name,ix.name_en,ix.name_ar)<0||[ix.quantity,ix.minimum,ix.unit].some(i=>i<0))throw new Error('INVENTORY_CSV_HEADERS');
    if(cells.length>501)throw new Error('INVENTORY_CSV_SIZE');
    const seen=new Set();
    return cells.slice(1).map((r,index)=>{
      const get=key=>ix[key]<0?'':String(r[ix[key]]??'').trim();
      const translated=ix.name_en>=0||ix.name_ar>=0?{name_en:get('name_en'),name_ar:get('name_ar')}:names({name:get('name')});
      const name=itemName(translated),source=get('category'),unit=get('unit');
      if(!name||translated.name_en.length>160||translated.name_ar.length>160||unit.length>40||r.length>header.length||get('subcategory2')&&!get('subcategory'))throw new Error('INVENTORY_CSV_ROW:'+(index+2));
      for(const value of new Set(Object.values(translated).filter(Boolean).map(n=>n.toLowerCase()))){if(seen.has(value))throw new Error('INVENTORY_CSV_DUPLICATE:'+(index+2));seen.add(value);}
      let quantity,minimum;try{quantity=numeric(get('quantity'));minimum=numeric(get('minimum'));}catch(_){throw new Error('INVENTORY_CSV_NUMBER:'+(index+2));}
      const category_id=ix.subcategory>=0||ix.subcategory2>=0?resolveCategory([source,get('subcategory'),get('subcategory2')],categories):proposeCategory(name,source,categories);
      return {name,...translated,quantity,minimum,unit,category_id};
    });
  }
  function csv(items,categories=[]) {
    const safe=value=>{let s=String(value??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
    return '\uFEFF'+[['Category','Item','Current quantity','Minimum','Unit','English name','Arabic name','Subcategory','Second subcategory'],...items.map(i=>{
      const path=categoryPath(categories.find(c=>c.id===i.category_id),categories);
      return [path[0]?.name||'',itemName(i),i.quantity??'',i.minimum??'',i.unit,names(i).name_en,names(i).name_ar,path[1]?.name||'',path[2]?.name||''];
    })].map(row=>row.map(safe).join(',')).join('\r\n');
  }
  const api={permissions,units,numeric,status,needsReview,names,itemName,categoryPath,categoryTree,categoryMoveTargets,parseCells,parseCSV,proposeCategory,csv};host.LuminInventoryModel=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window==='undefined'?globalThis:window);
