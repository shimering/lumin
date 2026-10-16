const test=require('node:test'),assert=require('node:assert/strict');
const model=require('../lumin-inventory-model.js');
const categories=['patient','anaesthesia','infection','clinical','surgical','consumables'].map(key=>({id:key,key,name:key==='consumables'?'Consumables':key,active:true}));
const source='التصنيف,الصنف,الكمية الحالية,الحد الأدنى,الوحدة,,Reference\r\nConsumables (مستهلكات يومية),Anasthesia (Blue),2,3,Box,,\r\nConsumables (مستهلكات يومية),Cotton pack,,,pack,,\r\nConsumables (مستهلكات يومية),Napkin,8,235,,,\r\nConsumables (مستهلكات يومية),"أكواب، ورق",6,8,,,كمية جيدة ✅\r\n';
test('CSV import preserves unknowns, zero, source values, quoted text and category suggestions',()=>{
  const rows=model.parseCSV(source,categories);assert.equal(rows.length,4);
  assert.equal(rows[0].category_id,'anaesthesia');assert.equal(rows[0].unit,'Box');
  assert.equal(rows[1].quantity,null);assert.equal(rows[1].minimum,null);assert.equal(model.status(rows[1]),'unknown');
  assert.equal(rows[2].minimum,235);assert.equal(rows[2].unit,'');assert.match(rows[2].review_note,/235/);
  assert.equal(rows[3].source_data.reference,'كمية جيدة ✅');assert.equal(rows[3].category_id,'patient');assert.match(rows[3].review_note,/conflicts/);
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
