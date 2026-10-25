const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('index.html','utf8'),implant=require('../lumin-implant-consent.js');
function load(start,next,context){vm.createContext(context);vm.runInContext(source.slice(source.indexOf(start),source.indexOf(next,source.indexOf(start))),context);return context;}
test('chart synchronization preserves a custom implant type even before the progress page has loaded',async()=>{
  let saved={implant_type:'Patient-specific Nobel',implant_size:'4 x 10',delivery_date:'2027-04-25',healing_collar:true,notes:'Reviewed'},payload;
  const context={window:{LuminImplantConsent:implant},console,implantProgressRecords:[],dentalOperationByCode:()=>({code:'custom',name:'Implant with crown',isImplantProcedure:true,implantType:'Default Straumann'}),normaliseOperationStatus:status=>status,addMonthsToDate:()=> '2027-02-25',refreshImplantProgress:()=>{},db:{from(){return {select(){return this;},eq(){return this;},async maybeSingle(){return {data:saved,error:null};},async upsert(value){payload=value;return {error:null};}};}}};
  load('async function syncImplantProgressFromChartOperation(', 'async function deleteImplantProgressByFindingId(',context);
  const finding={id:'finding',code:'custom',status:'In',createdAt:'2026-10-25T12:00:00Z'};
  await context.syncImplantProgressFromChartOperation({id:'patient'},'36',finding,null);
  assert.equal(payload.implant_type,'Patient-specific Nobel');assert.equal(payload.delivery_date,'2027-04-25');assert.equal(payload.healing_collar,true);assert.equal(payload.operation_code,'custom');
  saved=null;await context.syncImplantProgressFromChartOperation({id:'patient'},'36',finding,null);assert.equal(payload.implant_type,'Default Straumann');
});
test('editing a progress implant type preserves the assigned procedure and writes the new type',async()=>{
  const values={'implant-form-id':'record','implant-form-patient-id':'patient','implant-form-finding-id':'finding','implant-form-procedure-date':'2026-10-25','implant-form-delivery-date':'2027-04-25','implant-form-tooth':'36','implant-form-type':'  Astra  ','implant-form-size':'4 x 10','implant-form-status':'In','implant-form-notes':''},controls=Object.fromEntries(Object.entries(values).map(([id,value])=>[id,{value}]));
  controls['implant-save-button']={};controls['implant-form-healing-collar']={checked:true};controls['implant-form-message']={classList:{remove(){}}};let payload;
  const context={document:{getElementById:id=>controls[id]},console,currentUiLanguage:'en',patients:[],implantProgressRecords:[{id:'record',operation_code:'custom-implant',operation_name:'Clinic implant with zirconia'}],resolveToothSlotNumber:()=>36,closeImplantModal:()=>{},refreshImplantProgress:async()=>{},showAppointmentNotificationToast:()=>{},db:{from(){return {update(value){payload=value;return this;},async eq(){return {error:null};}};}}};
  load('async function saveImplantRecordForm(', 'async function quickEditImplantSize(',context);
  await context.saveImplantRecordForm({preventDefault(){}});
  assert.equal(payload.implant_type,'Astra');assert.equal(payload.operation_code,'custom-implant');assert.equal(payload.operation_name,'Clinic implant with zirconia');assert.equal(controls['implant-save-button'].disabled,false);
});
test('Admin saves implant metadata and enables progress tracking for a new implant procedure',async()=>{
  const values={'admin-operation-name':'Implant with zirconia','admin-operation-specialty':'implantology','admin-operation-scope':'whole','admin-operation-visual-code':'implant','admin-operation-price':'12000','admin-operation-sort-order':'10','admin-operation-implant-type':'Straumann'},controls=Object.fromEntries(Object.entries(values).map(([id,value])=>[id,{value}]));
  controls['admin-operation-save-button']={};for(const key of ['admin-operation-active','admin-operation-is-implant'])controls[key]={checked:true};for(const key of ['admin-operation-has-steps','admin-operation-is-ortho-package'])controls[key]={checked:false};let payload;
  const context={document:{getElementById:id=>controls[id]},hasPageAccess:()=>true,editingDentalOperationId:null,dentalOperations:[],currentUiLanguage:'en',dentalOperationCode:()=> 'custom-implant',fetchDentalCustomization:async()=>{},resetDentalOperationForm(){},setAdminMessage(){},lucide:{createIcons(){}},db:{from(){return {insert(value){payload=value;return this;},select(){return this;},async single(){return {data:{id:'new'},error:null};}};}}};
  load('async function saveDentalOperation(', 'async function setDentalSpecialtyActive(',context);
  await context.saveDentalOperation({preventDefault(){}});
  assert.equal(payload.is_implant_procedure,true);assert.equal(payload.implant_type,'Straumann');assert.equal(payload.track_implant_progress,true);assert.equal(payload.price,12000);
});
