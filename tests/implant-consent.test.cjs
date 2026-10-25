const test=require('node:test'),assert=require('node:assert/strict');
const implant=require('../lumin-implant-consent.js'),rich=require('../lumin-consent-document.js');
const entry=(id,tooth,price,type='Straumann')=>({finding_id:id,code:'implant',name:'Implant',tooth,tooth_label:tooth,price,implant_type:type,is_implant:true});
test('implant fees and installment rounding keep the agreed total in both languages',()=>{
  const entries=[entry('one','36',10000),entry('two','46',15000,'Nobel')],terms={interval_months:6,first_visit_percent:35,payment_mode:'monthly',monthly_count:3};
  const amounts=implant.totals(entries,terms);
  assert.deepEqual(amounts,{total:2500000,first:875000,remaining:1625000,monthly:541666,last:541668,count:2});
  assert.equal(amounts.first+amounts.monthly*2+amounts.last,amounts.total);
  const english=implant.paragraph(entries,terms,'en'),arabic=implant.paragraph(entries,terms,'ar');
  assert.match(english,/Ninth: Cost:/);assert.match(english,/Total amount: 25,000/);assert.match(english,/8,750 \(35%\)/);assert.match(english,/5,416.68/);assert.match(english,/after 6 month/);assert.match(english,/Implant type Nobel at tooth 46/);
  assert.match(arabic,/تاسعا: التكلفة:/);assert.match(arabic,/الزراعة نوع Nobel في مكان ضرس 46/);assert.match(arabic,/التركيبة الزركون/);
  const two=implant.paragraph(entries,{...terms,payment_mode:'two'},'en');assert.match(two,/remaining amount of 16,250.*after 6 month/);assert.doesNotMatch(two,/monthly installment/);
  for(const percent of [0,100]){const a=implant.totals(entries,{first_visit_percent:percent});assert.equal(a.first+a.remaining,a.total);}
  assert.throws(()=>implant.settings({monthly_count:0}),/implant-settings/);assert.throws(()=>implant.settings({interval_months:0}),/implant-settings/);assert.throws(()=>implant.settings({first_visit_percent:101}),/implant-settings/);
  assert.throws(()=>implant.totals([],{}),/implant-procedures/);assert.throws(()=>implant.totals([entry('one','',100)],{}),/implant-procedures/);assert.throws(()=>implant.totals([entry('one','36',null)],{}),/implant-procedures/);assert.throws(()=>implant.totals([entry('one','36',100,'')],{}),/implant-procedures/);
});
test('assigned chart findings deduplicate surfaces, preserve zero fees and use patient implant overrides',()=>{
  const finding={id:'one',code:'implant',price:0},patient={chart_state:{36:{wholeOperations:[finding],surfaces:{left:[finding],right:[finding]}}}};
  const entries=implant.assignments(patient,()=>({isImplantProcedure:true,implantType:'Default',price:10000,name:'Implant'}),[{finding_id:'one',implant_type:'Changed in progress'}]);
  assert.equal(entries.length,1);assert.equal(entries[0].price,0);assert.equal(entries[0].implant_type,'Changed in progress');assert.equal(entries[0].tooth,'36');
  assert.equal(implant.defaultType({code:'dz_implantation_i9'}),'Economic (dual)');assert.equal(implant.isImplant({isImplantProcedure:true}),true);
  const source={36:{wholeOperations:[{id:'one',code:'implant',price:100.01,batchId:'batch',billingMultiplier:1}]},46:{wholeOperations:[{id:'two',code:'implant',price:100.01,batchId:'batch',billingMultiplier:1}]}};
  const batch=implant.assignments({chartState:source},()=>({isImplantProcedure:true,implantType:'A'}));
  assert.equal(implant.totals(batch,{}).total,10001);assert.equal(implant.totals(batch.slice(0,1),{}).total,5000);assert.equal(implant.totals(batch.slice(1),{}).total,5001);
  assert.match(implant.paragraph(batch,{},'en'),/36: 50; 46: 50.01/);
});
test('generated cost sections reopen without duplication and retain the document formatting',()=>{
  const base=rich.normalize({ops:[{insert:'Patient wording',attributes:{bold:true,font:'Amiri'}},{insert:'\n',attributes:{direction:'rtl'}}]}),entries=[entry('one','36',10000,'Type <script>')];
  for(const language of ['en','ar']){
    const paragraph=implant.paragraph(entries,{},language),saved=rich.normalize(implant.documentWithParagraph(base,paragraph,language));
    assert.equal(rich.text(saved).split(language==='ar'?'تاسعا: التكلفة:':'Ninth: Cost:').length,2);
    assert.deepEqual(rich.normalize(implant.withoutParagraph(saved,paragraph)),base);
    const reopened=rich.normalize(implant.documentWithParagraph(implant.withoutParagraph(saved,paragraph),paragraph,language));assert.equal(rich.text(reopened),rich.text(saved));
    assert.match(rich.html(saved),/&lt;script&gt;/);assert.doesNotMatch(rich.html(saved),/<script>/);
    assert.ok(saved.ops.some(op=>op.attributes?.bold&&op.attributes.font==='Amiri'));
  }
});
