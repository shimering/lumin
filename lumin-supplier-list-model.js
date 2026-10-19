/* Shared supplier document presentation. No clinic state or network access. */
(function(host){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const name=(item,language)=>language==='ar'?(item.name_ar||item.name_en):(item.name_en||item.name_ar);
  const category=(item,language)=>(language==='ar'?(item.category_name_ar||item.category_name):(item.category_name||item.category_name_ar))||(language==='ar'?'غير مصنف':'Uncategorized');
  function groups(items,language){
    const map=new Map();
    for(const item of items){const key=JSON.stringify([item.category_name||'',item.category_name_ar||'']);if(!map.has(key))map.set(key,{label:category(item,language),items:[]});map.get(key).items.push(item);}
    return [...map.values()].sort((a,b)=>a.label.localeCompare(b.label,language,{numeric:true})).map(group=>({...group,items:group.items.slice().sort((a,b)=>(name(a,language)||'').localeCompare(name(b,language)||'',language,{numeric:true}))}));
  }
  const unit=(value,language)=>language==='ar'?({Box:'علبة',Bottle:'زجاجة',Pack:'عبوة',Piece:'قطعة',Roll:'لفة',Tube:'أنبوب',Syringe:'سرنجة',Cartridge:'خرطوشة',Vial:'قارورة',Jar:'مرطبان',Pair:'زوج',Set:'طقم',Bag:'كيس',Kit:'مجموعة'}[value]||value):value;
  const thumbnail=value=>typeof value==='string'&&value.length<=24000&&/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+={0,2}$/.test(value)?value:'';
  host.LuminSupplierListModel={escape,name,category,groups,unit,thumbnail};
  if(typeof module!=='undefined')module.exports=host.LuminSupplierListModel;
})(typeof window==='undefined'?globalThis:window);
