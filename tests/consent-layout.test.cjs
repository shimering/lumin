const test=require('node:test'),assert=require('node:assert/strict');
const layout=require('../lumin-consent-layout.js'),doc=require('../lumin-consent-document.js');
const fs=require('node:fs'),vm=require('node:vm');
test('signature labels inherit clinic visibility, remain bilingual and render only safe text',()=>{
  const saved=layout.normalize({signature_labels_ar:{patient:'توقيع المريض'},signature_divider:false},{signatures_visible:false});
  assert.equal(saved.signatures_visible,false);assert.equal(saved.signature_labels_ar.date,'التاريخ');assert.equal(saved.signature_labels_en.patient,'Patient / guardian name and signature');
  assert.equal(layout.signatureMarkup(saved,{doctor_name:'Doctor'},'ar'),'');
  const html=layout.signatureMarkup({...saved,signatures_visible:true,signature_labels_ar:{patient:'<img onerror=alert(1)>'}},{doctor_name:'<script>Doctor</script>'},'ar');
  assert.match(html,/without-divider/);assert.match(html,/dir="rtl"/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img|<script/);
});
test('consent layouts inherit clinic defaults, validate dimensions and retain safe frame margins',()=>{
  assert.equal(layout.normalize({}, {logo_width_mm:48,logo_visible:false}).logo_width_mm,48);
  assert.equal(layout.normalize({}, {logo_visible:false}).logo_visible,false);
  const framed=layout.normalize({frame:'double',margin_top_mm:0,margin_bottom_mm:0,logo_width_mm:999});
  assert.equal(framed.margin_top_mm,8);assert.equal(framed.margin_bottom_mm,8);assert.equal(framed.logo_width_mm,80);
  assert.equal(layout.needsPages({logo_pages:'first'}),true);assert.equal(layout.needsPages({}),false);
  assert.match(layout.frameMarkup(framed),/is-double/);assert.doesNotMatch(layout.logoMarkup({logo_visible:false},'image'),/img/);
});
test('Palmer teeth retain plain text and chart bracket geometry in both writing directions',()=>{
  for(const [token,path] of [['6┘','M33 4 V23 H4'],['└6','M7 4 V23 H36'],['┌5','M7 24 V5 H36'],['5┐','M33 24 V5 H4'],['└A','M7 4 V23 H36']]){
    const content=doc.withPalmer(doc.fromText('Implant '+token+' / '+token));
    assert.equal(content.ops.filter(op=>op.insert.consentTooth).length,2);assert.equal(doc.text(content),'Implant '+token+' / '+token);
    const html=doc.html(content);assert.ok(html.includes('d="'+path+'"'));assert.match(html,/dir="ltr"/);assert.doesNotMatch(html,/undefined/);
  }
  for(const value of ['99┘','┘6','<svg>','┌Z'])assert.throws(()=>doc.normalize({ops:[{insert:{consentTooth:value}}]}));
});
test('consent Palmer glyphs reuse the actual chart renderer and retain its quadrant geometry',()=>{
  const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8'),context=vm.createContext({escapeHtml:doc.escape,SLOT_BY_PRIMARY_TOOTH:{},isPrimaryToothId:value=>/^[A-T]$/.test(String(value))});
  for(const name of ['palmerPositionForSlot','palmerQuadrantForSlot','palmerNotationSVG']){
    const start=html.indexOf('    function '+name+'('),end=html.indexOf('\n    }',start);assert.ok(start>=0&&end>start);vm.runInContext(html.slice(start,end+6),context);
  }
  const previous=globalThis.palmerNotationSVG;let calls=0;
  try{
    globalThis.palmerNotationSVG=(...args)=>{calls++;return context.palmerNotationSVG(...args);};
    for(const [token,id,slot] of [['6┘','3',3],['└6','14',14],['┌5','20',20],['5┐','29',29],['└A','A',9]]){
      const actual=doc.palmerSvg(token),chart=context.palmerNotationSVG(id,slot);assert.equal(/d="([^"]+)"/.exec(actual)[1],/d="([^"]+)"/.exec(chart)[1]);
    }
    assert.equal(calls,5);
  }finally{if(previous)globalThis.palmerNotationSVG=previous;else delete globalThis.palmerNotationSVG;}
});
