const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const {webcrypto}=require('node:crypto');
const model=require('../lumin-quotation-model.js');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const future=()=>new Date(Date.now()+30*864e5).toISOString();

function fixture(name,options={}) {
  let handle;
  const writes=[];
  const patient={id:id(90),chart_state:{3:{wholeOperations:[{id:id(1),code:'crown',price:500,status:'P'},{id:id(2),code:'crown',price:200,status:'In'}]}}};
  const record={id:id(99),patient_id:patient.id,selected_ids:[id(1)],token:'a'.repeat(64),language:'en',revision:1,expires_at:future(),revoked_at:null};
  const settings={id:1,clinic_name:'Fixture clinic',whatsapp_phone:'201001234567',logo_data_url:''};
  const operations=[{code:'crown',name:'Crown',action_scope:'whole',visual_code:'zirconia_crown',price:500}];
  const source={...record,patient_name:'Fixture patient',chart_state:patient.chart_state,operations,clinic:{name:settings.clinic_name,whatsapp:settings.whatsapp_phone,logo:''}};
  const state={patient,record,settings,operations,source,printSettings:{logo_data_url:'data:image/png;base64,Zm9ybWxvZ28=',footer_text:'PRIVATE FORM CONTENT'}};
  function client(service) {
    return {
      auth:{getUser:async()=>({data:{user:options.badSession?null:{id:id(80)}},error:options.badSession?'bad':null})},
      rpc:async(name,args)=>{
        assert.equal(name,'quotation_source');assert.ok(service);
        return {data:args.p_token===record.token&&!options.unavailable?state.source:null,error:options.sourceError?'failed':null};
      },
      from(table) {
        const filters=[],query={operation:'read',payload:null,
          select(columns){query.columns=columns;return query;},eq(key,value){filters.push([key,value]);return query;},is(key,value){filters.push([key,value]);return query;},order(){return query;},limit(){return query;},
          insert(payload){query.operation='insert';query.payload=payload;return query;},update(payload){query.operation='update';query.payload=payload;return query;},
          single(){return Promise.resolve(result());},maybeSingle(){return Promise.resolve(result());},then(resolve,reject){return Promise.resolve(result()).then(resolve,reject);}
        };
        function result() {
          if(query.operation!=='read') {
            assert.ok(service,'Writes require service role');
            if(options.casFailure)return {data:null,error:null};
            writes.push({table,operation:query.operation,payload:query.payload,filters});
            return {data:table==='quotation_settings'?{...settings,...query.payload}:{...record,...query.payload},error:null};
          }
          if(table==='user_profiles')return {data:{active:!options.inactive,access_roles:{is_admin:options.admin!==false,role_permissions:options.noChart?[]:[{page_key:'chart',can_view:true}]}},error:null};
          if(table==='patients')return {data:options.patientDenied?null:patient,error:null};
          if(table==='quotation_settings')return {data:settings,error:null};
          if(table==='prescription_print_settings') {assert.ok(service);assert.equal(query.columns,'logo_data_url');return {data:state.printSettings,error:options.logoError?'failed':null};}
          if(table==='dental_operations')return {data:operations,error:null};
          if(table==='patient_quotations')return {data:filters.every(([key,value])=>record[key]===value)?record:null,error:null};
          throw new Error(table);
        }
        return query;
      }
    };
  }
  const sourceCode=fs.readFileSync(path.join(__dirname,'../supabase/functions',name,'index.ts'),'utf8').replace(/^import .*;\r?\n/gm,'');
  const context=vm.createContext({Request,Response,crypto:webcrypto,LuminQuotationModel:model,createClient:(_url,key)=>client(key==='service'),Deno:{env:{get:key=>key==='SUPABASE_SERVICE_ROLE_KEY'?'service':'anon'},serve:handler=>{handle=handler;}}});
  new vm.Script(stripTypeScriptTypes(sourceCode)).runInContext(context);
  return {state,writes,async call(body,auth=true,method='POST'){
    const response=await handle(new Request('https://fixture.invalid/',{method,headers:{'content-type':'application/json',...(auth?{authorization:'Bearer fixture'}:{})},...(method==='POST'?{body:JSON.stringify(body)}:{})}));
    return {status:response.status,headers:response.headers,body:await response.json()};
  }};
}

test('patient endpoint projects selected treatments and never returns private source data',async()=>{
  const app=fixture('quotation-view');
  app.state.patient.chart_state[3].wholeOperations[0].notes='PRIVATE CLINICAL NOTE';
  app.state.source.phone='PRIVATE PHONE';app.state.source.medical_history='PRIVATE HISTORY';
  const result=await app.call({token:'a'.repeat(64)},false);
  assert.equal(result.status,200);assert.equal(result.body.items.length,1);assert.equal(result.body.total,500);
  assert.deepEqual(Object.keys(result.body).sort(),['clinic','currency','expiresAt','items','language','patientName','reference','refreshedAt','teeth','total'].sort());
  assert.doesNotMatch(JSON.stringify(result.body),/PRIVATE|chart_state|selected_ids|token|created_by/);
  assert.match(result.headers.get('cache-control'),/no-store/);assert.equal(result.headers.get('referrer-policy'),'no-referrer');
  assert.equal((await app.call({token:'d'.repeat(64)},false)).status,404);
  assert.equal((await app.call({token:'bad'},false)).status,404);
  assert.equal((await fixture('quotation-view',{unavailable:true}).call({token:'a'.repeat(64)},false)).status,404);
  assert.equal((await fixture('quotation-view',{sourceError:true}).call({token:'a'.repeat(64)},false)).status,503);
  assert.equal((await app.call({},false,'GET')).status,405);
});

test('management checks verified staff, chart permissions, and caller patient access before writing',async()=>{
  const body={action:'create',patient_id:id(90),selected_ids:[id(1)],expires_at:future()};
  for(const [options,auth,status] of [[{},false,401],[{badSession:true},true,401],[{inactive:true},true,403],[{admin:false,noChart:true},true,403],[{patientDenied:true},true,404]]) {
    const app=fixture('quotation-manage',options);
    assert.equal((await app.call(body,auth)).status,status);assert.equal(app.writes.length,0);
  }
  const app=fixture('quotation-manage',{admin:false});
  assert.equal((await app.call({action:'save_settings'})).status,403);assert.equal(app.writes.length,0);
});

test('creation requires current planned IDs and makes a random private link',async()=>{
  const app=fixture('quotation-manage');
  const body={action:'create',patient_id:id(90),selected_ids:[id(2)],expires_at:future()};
  assert.equal((await app.call(body)).status,409);assert.equal(app.writes.length,0);
  body.selected_ids=[id(1)];body.expires_at=new Date(Date.now()-1000).toISOString();
  assert.equal((await app.call(body)).status,400);
  body.expires_at= future();const result=await app.call(body);
  assert.equal(result.status,200);assert.match(result.body.quotation.token,/^[a-f0-9]{64}$/);assert.notEqual(result.body.quotation.token,'a'.repeat(64));
  assert.deepEqual(Array.from(app.writes[0].payload.selected_ids),[id(1)]);
  app.state.settings.whatsapp_phone='';assert.equal((await app.call(body)).status,409);
});

test('updates keep the token, allow expiry edits after completion, and reject stale or revoked edits',async()=>{
  const app=fixture('quotation-manage');
  const body={action:'update',patient_id:id(90),id:id(99),revision:1,selected_ids:[id(1)],expires_at:future()};
  app.state.patient.chart_state[3].wholeOperations[0].status='C';
  const result=await app.call(body);
  assert.equal(result.status,200);assert.equal(result.body.quotation.token,'a'.repeat(64));assert.equal(result.body.quotation.revision,2);
  assert.ok(app.writes[0].filters.some(([key,value])=>key==='revision'&&value===1));
  assert.equal((await app.call({...body,selected_ids:[id(2)]})).status,409);
  assert.equal((await app.call({...body,revision:9})).status,409);
  assert.equal((await app.call({...body,id:id(98)})).status,404);
  app.state.record.revoked_at=new Date().toISOString();assert.equal((await app.call(body)).status,409);
  const concurrent=fixture('quotation-manage',{casFailure:true});assert.equal((await concurrent.call(body)).status,409);
});

test('revocation and administrator branding validate their writes',async()=>{
  const app=fixture('quotation-manage');
  const result=await app.call({action:'revoke',patient_id:id(90),id:id(99),revision:1});
  assert.equal(result.status,200);assert.ok(result.body.quotation.revoked_at);assert.equal(result.body.quotation.revision,2);
  assert.equal((await app.call({action:'save_settings',clinic_name:'Clinic',whatsapp_phone:'bad'})).status,400);
  assert.equal((await app.call({action:'save_settings',clinic_name:'Clinic',whatsapp_phone:'+20 100 1234567',logo_data_url:''})).status,200);
  assert.equal(app.writes.at(-1).payload.whatsapp_phone,'201001234567');
  assert.equal(Object.hasOwn(app.writes.at(-1).payload,'logo_data_url'),false);
});

test('staff branding follows the current form logo and legacy quotation writes cannot change it',async()=>{
  const app=fixture('quotation-manage',{admin:false});
  app.state.settings.logo_data_url='LEGACY QUOTATION LOGO';
  const first=await app.call({action:'settings'});
  assert.equal(first.status,200);assert.equal(first.body.settings.logo_data_url,app.state.printSettings.logo_data_url);
  assert.doesNotMatch(JSON.stringify(first.body),/PRIVATE FORM CONTENT|footer_text|LEGACY/);
  app.state.printSettings.logo_data_url='data:image/webp;base64,dXBkYXRlZA==';
  assert.equal((await app.call({action:'settings'})).body.settings.logo_data_url,app.state.printSettings.logo_data_url);
  app.state.printSettings.logo_data_url=null;
  assert.equal((await app.call({action:'settings'})).body.settings.logo_data_url,'');
  const admin=fixture('quotation-manage');
  const saved=await admin.call({action:'save_settings',clinic_name:'Clinic',whatsapp_phone:'+20 1001234567',logo_data_url:'data:image/svg+xml;base64,abcd'});
  assert.equal(saved.status,200);assert.equal(saved.body.settings.logo_data_url,admin.state.printSettings.logo_data_url);
  assert.equal(Object.hasOwn(admin.writes[0].payload,'logo_data_url'),false);
  assert.equal((await fixture('quotation-manage',{logoError:true}).call({action:'settings'})).status,503);
});
