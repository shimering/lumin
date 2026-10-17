const test=require('node:test'),assert=require('node:assert/strict');
const model=require('../lumin-inventory-model.js');
const categories=['patient','anaesthesia','infection','clinical','surgical','consumables'].map(key=>({id:key,key,name:key==='consumables'?'Consumables':key,active:true}));
const source='التصنيف,الصنف,الكمية الحالية,الحد الأدنى,الوحدة,,Reference\r\nConsumables (مستهلكات يومية),Anasthesia (Blue),2,3,Box,,\r\nConsumables (مستهلكات يومية),Cotton pack,,,pack,,\r\nConsumables (مستهلكات يومية),Napkin,8,235,,,\r\nConsumables (مستهلكات يومية),"أكواب، ورق",6,8,,,كمية جيدة ✅\r\n';
test('CSV import preserves unknowns, zero, source values, quoted text and category suggestions',()=>{
  const rows=model.parseCSV(source,categories);assert.equal(rows.length,4);
  assert.equal(rows[0].category_id,'anaesthesia');assert.equal(rows[0].unit,'Box');
  assert.equal(rows[1].quantity,null);assert.equal(rows[1].minimum,null);assert.equal(model.status(rows[1]),'unknown');
  assert.equal(rows[2].minimum,235);assert.equal(rows[2].unit,'');
  assert.equal(rows[3].category_id,'patient');
  for(const row of rows)assert.deepEqual(Object.keys(row).sort(),['category_id','minimum','name','name_ar','name_en','quantity','unit']);
  assert.equal(rows[0].name_en,'Anasthesia (Blue)');assert.equal(rows[3].name_ar,'أكواب، ورق');
  assert.deepEqual(model.parseCells('a,b\n"a, b","line\nwith ""quote"""'),[['a','b'],['a, b','line\nwith "quote"']]);
  assert.equal(model.numeric('٠'),0);assert.equal(model.numeric('١٢٫٥'),12.5);assert.equal(model.numeric(''),null);
  assert.equal(model.status({quantity:0,minimum:null}),'out');assert.equal(model.status({quantity:5,minimum:5}),'low');assert.equal(model.status({quantity:5,minimum:null}),'unconfigured');
});
test('CSV importer rejects malformed, duplicate and invalid rows instead of partially importing',()=>{
  for(const value of ['NaN','Infinity','-1','1.2345','1000000001'])assert.throws(()=>model.numeric(value));
  assert.throws(()=>model.parseCells('a,b\n"bad'),/FORMAT/);
  assert.throws(()=>model.parseCSV('Item,Quantity\na,1'),/HEADERS/);
  assert.throws(()=>model.parseCSV('Item,Quantity,Minimum,Unit\na,1,2,Box\na,3,4,Box'),/DUPLICATE/);
  assert.throws(()=>model.parseCSV('Item,Quantity,Minimum,Unit\na,no,2,Box'),/NUMBER/);
  const untrusted=model.parseCSV('Item,Quantity,Minimum,Unit\n"<img src=x onerror=alert(1)>",0,1,Box');assert.equal(untrusted[0].name,'<img src=x onerror=alert(1)>');
});
test('CSV export keeps unknown quantities empty and protects spreadsheet formulas',()=>{
  const output=model.csv([{name:'=HYPERLINK("bad")',quantity:null,minimum:0,unit:'Box'}]);
  const cells=model.parseCells(output);assert.equal(cells[1][1][0],"'");assert.equal(cells[1][2],'');assert.equal(cells[1][3],'0');
});
test('bilingual names follow language with a fallback and survive CSV export/import',()=>{
  const item={name:'Legacy',name_en:'Paper cups',name_ar:'أكواب ورقية',quantity:0,minimum:2,unit:'Box'};
  assert.equal(model.itemName(item,'en'),'Paper cups');assert.equal(model.itemName(item,'ar'),'أكواب ورقية');
  assert.equal(model.itemName({name:'قديم'},'en'),'قديم');assert.equal(model.itemName({name_en:'Box',name_ar:''},'ar'),'Box');
  const [row]=model.parseCSV(model.csv([item]));
  assert.equal(row.name_en,item.name_en);assert.equal(row.name_ar,item.name_ar);assert.equal(row.quantity,0);
  const arabic=model.parseCSV('الاسم بالإنجليزية,الاسم بالعربية,الكمية الحالية,الحد الأدنى,الوحدة\n,صابون,0,1,Bottle');
  assert.equal(arabic[0].name,'صابون');assert.equal(arabic[0].name_en,'');
  assert.throws(()=>model.parseCSV('English name,Arabic name,Quantity,Minimum,Unit\nA,صنف,0,1,Box\nB,صنف,0,1,Box'),/DUPLICATE/);
  assert.throws(()=>model.parseCSV('English name,Arabic name,Quantity,Minimum,Unit\n,,0,1,Box'),/ROW/);
});
test('three-level category paths round-trip through CSV in both languages',()=>{
  const tree=[{id:'r',name:'Restorative',name_ar:'حشو',parent_id:null},{id:'m',name:'Composites',name_ar:'كومبوزيت',parent_id:'r'},{id:'l',name:'Ivoclar',name_ar:'إيفوكلار',parent_id:'m'}];
  assert.deepEqual(model.categoryTree(tree.slice().reverse()).map(c=>c.depth),[0,1,2]);
  assert.deepEqual(model.categoryPath(tree[2],tree).map(c=>c.id),['r','m','l']);
  const [row]=model.parseCSV(model.csv([{name:'Composite A1',category_id:'l',unit:'syringe',quantity:2,minimum:1}],tree),tree);
  assert.equal(row.category_id,'l');assert.equal(row.quantity,2);
  const [arabic]=model.parseCSV('التصنيف,التصنيف الفرعي,التصنيف الفرعي الثاني,الصنف,الكمية الحالية,الحد الأدنى,الوحدة\nحشو,كومبوزيت,إيفوكلار,A2,0,1,syringe',tree);
  assert.equal(arabic.category_id,'l');
  assert.throws(()=>model.parseCSV('Category,Subcategory,Second subcategory,Item,Quantity,Minimum,Unit\nRestorative,,Ivoclar,A2,0,1,syringe',tree),/ROW/);
});
