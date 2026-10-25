const test=require('node:test'),assert=require('node:assert/strict');
const document=require('../lumin-consent-document.js');
const model=require('../lumin-consent-model.js');
test('rich consent documents preserve formatting, safely render data and fill atomic variables',()=>{
  const value={ops:[{insert:'موافقة ',attributes:{bold:true,font:'Amiri',size:'24px'}},{insert:'{{patient_name}}'},{insert:'\n',attributes:{header:2,direction:'rtl'}},{insert:'Risk <script>alert(1)</script>',attributes:{italic:true,underline:true}},{insert:'\n',attributes:{list:'bullet'}}]};
  const tokenized=document.tokenize(value);assert.ok(tokenized.ops.some(op=>op.insert.consentVariable==='patient_name'));
  const filled=document.resolve(tokenized,{patient_name:'Mariam <img src=x>'});
  const html=document.html(filled);assert.match(html,/<strong>/);assert.match(html,/font-family:Amiri/);assert.match(html,/font-size:24px/);assert.match(html,/<h2 style="direction:rtl">/);assert.match(html,/<ul><li>/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script|<img|onerror=/);
  const draft=model.draft({...model.templates[0],id:'template',revision:1,content_en:document.fromText('{{patient_name}}\n{{doctor_name}}'),body_en:'{{patient_name}}\n{{doctor_name}}'},{id:'patient',name:'Mariam'},{full_name:'Dr. Noor'},{language:'en'});
  assert.equal(document.text(draft.content),'Mariam\nDr. Noor');assert.equal(draft.body,document.text(draft.content));assert.ok(draft.alternate_content);
  assert.equal(document.text(document.read({ops:[{insert:{image:'javascript:alert(1)'}}]},'Legacy text')),'Legacy text');
  for(const attributes of [{link:'javascript:alert(1)'},{font:'Arial;position:fixed'},{size:'99999px'},{color:'red;display:none'},{onclick:'alert(1)'},{header:99}])assert.throws(()=>document.normalize({ops:[{insert:'Unsafe',attributes}]}));
  assert.throws(()=>document.normalize({ops:[{insert:'x'.repeat(40002)}]}));
  const table={ops:[{insert:'Type',attributes:{bold:true}},{insert:'\n',attributes:{table:'row-a',cellWidth:'200px',cellHeight:'64px'}},{insert:'Amount'},{insert:'\n',attributes:{table:'row-a',cellWidth:'120px',cellHeight:'64px'}},{insert:'After table\n'}]};
  const tableHtml=document.html(table);assert.match(tableHtml,/<table/);assert.match(tableHtml,/<col style="width:62.5%"/);assert.match(tableHtml,/<tr style="height:64px">/);assert.match(tableHtml,/<strong>Type<\/strong>/);assert.match(tableHtml,/<\/table>.*After table/);assert.equal(document.text(table),'Type\nAmount\nAfter table');
  for(const attributes of [{table:'<script>'},{cellWidth:'9999px'},{cellHeight:'1px'},{cellWidth:'url(unsafe)'},{table:22}])assert.throws(()=>document.normalize({ops:[{insert:'Cell\n',attributes}]}));
});
