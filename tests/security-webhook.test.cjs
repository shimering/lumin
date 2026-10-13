const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {stripTypeScriptTypes} = require('node:module');
const {webcrypto, createHmac} = require('node:crypto');

function fixture(options = {}) {
  let handler;
  const calls = [], logs = [];
  const client = {
    auth: {getUser: async token => ({data:{user:token === 'staff' ? {id:'staff-id'} : null},error:null})},
    from(table) {
      return {select(){return this},eq(){return this},async maybeSingle(){
        if (table === 'clinic_settings') return {data:{whatsapp_verify_token:'private-verification-token',whatsapp_business_account_id:'fixture-waba',whatsapp_access_token:'private-provider-token'},error:null};
        if (table === 'user_profiles') return {data:{active:options.active !== false,access_roles:{is_admin:options.admin || false,role_permissions:options.denied ? [] : [{page_key:'whatsapp',can_view:true}]}},error:null};
        throw Error('Unexpected table: '+table);
      }};
    }
  };
  const context = vm.createContext({Request,Response,URL,TextEncoder,TextDecoder,AbortSignal,crypto:webcrypto,
    console:{log:(...v)=>logs.push(v),warn:(...v)=>logs.push(v),error:(...v)=>logs.push(v)},
    Deno:{env:{get:name=>name === 'WHATSAPP_APP_SECRET' ? options.secret === false ? '' : 'fixture-app-secret' : 'fixture'},serve:f=>{handler=f}},
    createClient:()=>client,fetch:async(url,init)=>{calls.push({url,init});return Response.json({data:[]})}
  });
  const code=fs.readFileSync('supabase/functions/whatsapp-webhook/index.ts','utf8').replace(/^import .*;\r?\n/gm,'');
  new vm.Script(stripTypeScriptTypes(code)).runInContext(context);
  return {calls,logs,context,handle:request=>handler(request),async request(body,headers={},method='POST') {
    return handler(new Request('https://fixture.invalid/?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1',{
      method,headers:{'content-type':'application/json',...headers},...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{})
    }));
  }};
}

test('staff actions require a verified session, active profile and WhatsApp permission',async()=>{
  for(const [options,headers,status] of [[{}, {},401],[{}, {authorization:'Bearer anon'},401],[{active:false},{authorization:'Bearer staff'},403],[{denied:true},{authorization:'Bearer staff'},403]]) {
    const f=fixture(options),response=await f.request({action:'list_templates'},headers);
    assert.equal(response.status,status);assert.equal(f.calls.length,0);
  }
  for(const options of [{},{denied:true,admin:true}]) {
    const f=fixture(options),response=await f.request({action:'list_templates'},{authorization:'Bearer staff'});
    assert.equal(response.status,200);assert.equal(f.calls.length,1);assert.ok(f.calls[0].init.signal);
  }
});

test('Meta events require a valid signature over the exact body',async()=>{
  const body=JSON.stringify({object:'whatsapp_business_account',entry:[]});
  const signature='sha256='+createHmac('sha256','fixture-app-secret').update(body).digest('hex');
  assert.equal((await fixture().request(body)).status,401);
  assert.equal((await fixture().request(body+' ',{'x-hub-signature-256':signature})).status,401);
  assert.equal((await fixture({secret:false}).request(body,{'x-hub-signature-256':signature})).status,401);
  assert.equal((await fixture().request(body,{'x-hub-signature-256':signature})).status,200);
});

test('verification failures never log expected or received tokens',async()=>{
  const f=fixture();assert.equal((await f.request(null,{},'GET')).status,403);
  assert.doesNotMatch(JSON.stringify(f.logs),/private-verification-token|wrong/);
});

test('streaming input without Content-Length stops at the payload limit',async()=>{
  const f=fixture();let cancelled=false,reads=0;
  const body=new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}});
  const response=await f.handle(new Request('https://fixture.invalid/',{method:'POST',body,duplex:'half'}));
  assert.equal(response.status,413);assert.equal(cancelled,true);assert.ok(reads<=28);assert.equal(f.calls.length,0);
});

test('conversation resolution preserves existing records, shared-phone ambiguity, explicit linking and provider identifiers',async()=>{
  const f=fixture();
  let existing=null,inserted=null,matches=[];
  f.context.findPatientsByPhone=async()=>matches;
  const db={from(){return{select(){return this},eq(){return this},or(){return this},maybeSingle:async()=>({data:existing}),insert(value){inserted=value;return this},single:async()=>({data:{id:'new',...inserted},error:null})}}};
  existing={id:'existing'};
  assert.equal((await f.context.findOrCreateWhatsAppConversation(db,{phone:'201001234567'},'Hello')).id,'existing');assert.equal(inserted,null);
  existing=null;matches=[{id:'a',name:'A'},{id:'b',name:'B'}];
  await f.context.findOrCreateWhatsAppConversation(db,{phone:'201001234567'},'Template preview');assert.equal(inserted.patient_id,null);assert.equal(inserted.last_message,'Template preview');
  matches=[{id:'a',name:'Family A'}];
  await f.context.findOrCreateWhatsAppConversation(db,{phone:'201001234567'},'Hello');assert.equal(inserted.patient_id,'a');assert.equal(inserted.patient_name,'Family A');
  await f.context.findOrCreateWhatsAppConversation(db,{phone:'EG.123456',patient_id:'explicit'},'Voice');assert.equal(inserted.phone,'EG.123456');assert.equal(inserted.patient_id,'explicit');
});

test('AI cannot search another sender phone; family IDs are limited to the sender matches',async()=>{
  const f=fixture(),conversation={id:'conversation',phone:'201001234567',patient_id:'linked'};
  const denied=await f.context.handleGeminiToolCall({}, {name:'lookup_patient',args:{phone:'201009999999'}},conversation);
  assert.equal(denied.error,'PATIENT_IDENTITY_REQUIRED');
  f.context.findPatientsByPhone=async()=>[{id:'family-a'},{id:'family-b'}];
  assert.equal(await f.context.whatsappPatientIsAllowed({},conversation,'family-b'),true);
  assert.equal(await f.context.whatsappPatientIsAllowed({},conversation,'unrelated'),false);
  assert.equal(await f.context.whatsappPatientIsAllowed({},conversation,'linked'),true);
});
