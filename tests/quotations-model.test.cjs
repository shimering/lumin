const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const model=require('../lumin-quotation-model.js');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const op=(code,scope='whole',price=100)=>({code,name:code,action_scope:scope,visual_code:code,price});
const finding=(n,status='P',extra={})=>({id:id(n),code:'crown',status,price:100,...extra});

test('creation only selects Plan; the same live selection retains In Progress and removes Completed and Existed',()=>{
  const chart={1:{wholeOperations:[finding(1),finding(2,'In'),finding(3,'C'),finding(4,'E')]}};
  const selected=[1,2,3,4].map(id);
  assert.deepEqual(model.project(chart,[op('crown')],selected,'create').eligibleIds,[id(1)]);
  assert.equal(model.publicProjection(chart,[op('crown')],selected).total,200);
  chart[1].wholeOperations[0].status='C';
  chart[1].wholeOperations[1].price=250.25;
  chart[1].wholeOperations.push(finding(5,'P',{price:9999}));
  const live=model.publicProjection(chart,[op('crown')],selected);
  assert.equal(live.total,250.25);assert.equal(live.items.length,1);assert.equal(live.items[0].status,'In');
  chart[1].wholeOperations=[];
  assert.equal(model.publicProjection(chart,[op('crown')],selected).items.length,0);
});

test('multiple surfaces share one charge, and the public projection does not copy clinical records or metadata',()=>{
  const fill=finding(1,'P',{code:'composite',price:125.75,notes:[{text:'PRIVATE NOTE'}],doctorName:'PRIVATE DOCTOR'});
  const chart={1:{surfaces:{top:[fill],center:[fill]},notes:'PRIVATE TOOTH NOTE'},2:{wholeOperations:[finding(2,'E')]},_meta:{mouthOperations:[finding(3,'P',{code:'scaling',price:50})],secret:'PRIVATE META'}};
  const live=model.publicProjection(chart,[op('composite','surface'),op('scaling','mouth')],[id(1),id(3)]);
  assert.equal(live.total,175.75);assert.equal(live.items.length,2);
  assert.deepEqual(live.items.find(item=>item.scope==='surface').targets,[{toothId:'1',surfaces:['top','center']}]);
  assert.doesNotMatch(JSON.stringify(live),/PRIVATE|doctor|notes|chart_state|eligibleIds/);
});

test('multi-tooth amounts match invoice allocation, including partial selections and completed members',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const source=name=>{const start=html.indexOf('    function '+name+'(');return html.slice(start,html.indexOf('\n    }',start)+6);};
  const context=vm.createContext({});
  vm.runInContext(['chartFindingBillingMultiplier','chartFindingBatchTotal','chartFindingInvoiceAmounts'].map(source).join('\n'),context);
  const members=[1,2,3].map(n=>finding(n,n===2?'C':'P',{batchId:id(99),billingMultiplier:1,price:1000.01}));
  const invoice=context.chartFindingInvoiceAmounts([{...members[0],memberFindings:members}]);
  const chart=Object.fromEntries(members.map((member,index)=>[String(index+1),{wholeOperations:[member]}]));
  const live=model.publicProjection(chart,[op('crown')],members.map(member=>member.id));
  assert.equal(live.total,invoice.get(id(1))+invoice.get(id(3)));
  assert.equal(live.items.length,1);assert.equal(live.items[0].targets.length,2);
  assert.equal(model.publicProjection(chart,[op('crown')],[id(3)]).total,invoice.get(id(3)));
  const tiny=Object.fromEntries([1,2,3,4].map(n=>[String(n),{wholeOperations:[finding(n,'P',{batchId:id(99),billingMultiplier:1,price:.02})]}]));
  const projection=model.publicProjection(tiny,[op('crown')],[1,2,3,4].map(id));
  assert.equal(projection.total,.02);assert.ok(model.collect(tiny,[op('crown')]).every(member=>member.amountCents>=0));
});

test('valid procedure steps determine live status, and payroll-generated findings never enter quotations',()=>{
  const steps=[{id:id(10),name:'Start',percentage:50,status:'C'},{id:id(11),name:'Finish',percentage:50,status:'P'}];
  const chart={1:{wholeOperations:[finding(1,'P',{steps}),finding(2,'P',{isProcedureStep:true,parentFindingId:id(1)})]}};
  assert.equal(model.project(chart,[op('crown')],[id(1)],'create').items.length,0);
  assert.equal(model.publicProjection(chart,[op('crown')],[id(1)]).items[0].status,'In');
  steps[1].status='C';assert.equal(model.publicProjection(chart,[op('crown')],[id(1)]).total,0);
  assert.equal(model.publicProjection(chart,[op('crown')],[id(2)]).items.length,0);
});

test('orthodontic visits use their own price and stable ID without charging a package twice',()=>{
  const chart={1:{wholeOperations:[finding(1,'In',{isOrthoPackage:true,price:5000,orthoVisits:[{id:id(10),status:'P',price:200,visitNumber:1},{id:id(11),status:'C',price:300,visitNumber:2}]})]}};
  const projection=model.project(chart,[op('crown')],[id(1),id(10),id(11)],'create');
  assert.deepEqual(projection.eligibleIds,[id(10)]);assert.equal(projection.total,200);assert.equal(projection.items[0].visitNumber,1);
  chart[1].wholeOperations[0].orthoVisits[0].price=250;
  assert.equal(model.publicProjection(chart,[op('crown')],[id(10)]).total,250);
  chart[1].wholeOperations[0].status='C';
  assert.equal(model.publicProjection(chart,[op('crown')],[id(10)]).total,0);
});

test('catalog fallback prices are live and selected primary teeth survive a dentition change',()=>{
  const chart={A:{wholeOperations:[finding(1,'P',{price:null})]},_meta:{baseDentition:'permanent',toothDentition:{8:'primary',9:'empty'}}};
  const projection=model.publicProjection(chart,[op('crown','whole',250)],[id(1)]);
  assert.equal(projection.total,250);
  assert.ok(projection.teeth.some(tooth=>tooth.toothId==='A'&&tooth.slot===4));
  assert.ok(projection.teeth.some(tooth=>tooth.toothId==='E'&&tooth.slot===8));
  assert.equal(model.toothLabel('A'),'URE');assert.equal(model.toothLabel('3'),'UR6');
});
