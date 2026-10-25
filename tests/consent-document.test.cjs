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
  const fields=document.resolve(document.fromText('Fee: {{implant_total}} / {{implant_total}} · {{doctor_name_ar}}'),{implant_total:'25,000',doctor_name_ar:'د. نور'},{bind:true,keepEmpty:true});
  assert.equal(document.text(fields),'Fee: 25,000 / 25,000 · د. نور');
  const bound=fields.ops.filter(op=>op.attributes?.consentField==='implant_total');assert.equal(bound.length,2);assert.notEqual(bound[0].attributes.consentFieldId,bound[1].attributes.consentFieldId);
  assert.throws(()=>document.normalize({ops:[{insert:'Fee',attributes:{consentField:'unexpected'}}]}));
  assert.equal(document.dimensionValid('cellHeight','16px'),true);assert.equal(document.dimensionValid('cellHeight','auto'),true);assert.equal(document.dimensionValid('cellHeight','15px'),false);assert.equal(document.dimensionValid('cellWidth','auto'),false);
  assert.match(document.html({ops:[{insert:'Short'},{insert:'\n',attributes:{table:'row-fit',cellHeight:'auto',cellWidth:'160px'}}]}),/<tr style="height:auto">/);
  for(const spacing of document.lineSpacings){const value={ops:[{insert:'Line'},{insert:'\n',attributes:{lineSpacing:spacing}}]};assert.match(document.html(value),new RegExp('line-height:'+spacing));}
  assert.match(document.html({ops:[{insert:'Cell'},{insert:'\n',attributes:{table:'row-spacing',lineSpacing:'1.25',cellHeight:'auto'}}]}),/td style="line-height:1.25"/);
  for(const value of [0,'0','4','1;display:none',1.5])assert.throws(()=>document.normalize({ops:[{insert:'Text\n',attributes:{lineSpacing:value}}]}));

});
