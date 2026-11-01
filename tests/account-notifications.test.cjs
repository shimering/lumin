const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('index.html','utf8');
function source(name) {
  const start=html.search(new RegExp('    (?:async )?function '+name+'\\('));
  assert.ok(start>=0,name);return html.slice(start,html.indexOf('\n    }',start)+6);
}
function fixture() {
  const calls=[],stored=new Map(),state={frozen:false};
  const subscription={optedIn:false,id:'subscription',async optIn(){calls.push('opt-in');this.optedIn=true;},async optOut(){calls.push('opt-out');this.optedIn=false;}};
  const OneSignal={
    User:{externalId:'a',PushSubscription:subscription,async addTags(tags){calls.push({tags});}},
    Notifications:{permission:true,isPushSupported:()=>true},
    async login(id){calls.push('login:'+id);this.User.externalId=id;},
    async logout(){calls.push('logout');this.User.externalId=null;}
  };
  const ctx=vm.createContext({console,Promise,navigator:{},OneSignal,
    currentUiLanguage:'en',currentUserAccess:{userId:'a',roleName:'Doctor',language:'en'},
    oneSignalInitialized:true,oneSignalIdentityQueue:Promise.resolve(),appointmentNotificationHostState:{},
    APPOINTMENT_NOTIFICATION_STORAGE_PREFIX:'notifications',
    window:{OneSignal,LuminAccounts:{isTransitioning:()=>state.frozen}},
    localStorage:{getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)},
    hasPageAccess:()=>true,postToLuminHost:message=>calls.push({host:message}),initializeAppointmentNotificationSettings(){}
  });
  vm.runInContext(['appointmentNotificationStorageKey','storedAppointmentNotificationPreference','storeAppointmentNotificationPreference',
    'queueOneSignalIdentity','notificationBelongsToCurrentAccount','disconnectOneSignalIdentity','syncOneSignalState','sendOneSignalIdentity'].map(source).join('\n'),ctx);
  return {ctx,calls,stored,state,OneSignal,subscription};
}

test('each account restores its own notification preference without inheriting the previous subscription state',async()=>{
  const f=fixture();f.ctx.storeAppointmentNotificationPreference(true);
  await f.ctx.sendOneSignalIdentity();assert.equal(f.subscription.optedIn,true);
  await f.ctx.disconnectOneSignalIdentity('a');assert.equal(f.OneSignal.User.externalId,null);assert.equal(f.subscription.optedIn,false);
  assert.equal(f.stored.get('notifications:a'),'enabled','disconnecting preserves A’s choice');
  f.ctx.currentUserAccess={userId:'b',roleName:'Receptionist',language:'ar'};
  f.ctx.storeAppointmentNotificationPreference(false);await f.ctx.sendOneSignalIdentity();
  assert.equal(f.OneSignal.User.externalId,'b');assert.equal(f.subscription.optedIn,false);
  assert.equal(f.stored.get('notifications:a'),'enabled');assert.equal(f.stored.get('notifications:b'),'disabled');
  await f.ctx.disconnectOneSignalIdentity('b');f.ctx.currentUserAccess={userId:'a',roleName:'Doctor',language:'en'};
  await f.ctx.sendOneSignalIdentity();assert.equal(f.subscription.optedIn,true);
  assert.equal(f.OneSignal.User.externalId,'a');
});

test('runtime subscription changes and browser permissions never overwrite account choices',async()=>{
  const f=fixture();f.ctx.storeAppointmentNotificationPreference(true);
  f.OneSignal.Notifications.permission=false;await f.ctx.sendOneSignalIdentity();
  assert.equal(f.stored.get('notifications:a'),'enabled');assert.equal(f.subscription.optedIn,false);
  f.OneSignal.Notifications.permission=true;await f.ctx.sendOneSignalIdentity();assert.equal(f.subscription.optedIn,true);
  f.ctx.currentUserAccess={userId:'new',roleName:'Doctor',language:'en'};
  await f.ctx.sendOneSignalIdentity();assert.equal(f.subscription.optedIn,false,'An account without a preference starts with notifications off');
  assert.equal(f.stored.has('notifications:new'),false);
});

test('an in-flight old login completes before logout; a late old logout cannot detach the new account',async()=>{
  const f=fixture();let release;
  f.OneSignal.User.externalId=null;
  f.OneSignal.login=async id=>{await new Promise(resolve=>{release=resolve});f.OneSignal.User.externalId=id;};
  const sending=f.ctx.sendOneSignalIdentity();
  while(!release)await Promise.resolve();
  f.state.frozen=true;const disconnecting=f.ctx.disconnectOneSignalIdentity('a');release();
  await Promise.all([sending,disconnecting]);assert.equal(f.OneSignal.User.externalId,null);
  assert.equal(f.calls.includes('opt-in'),false);
  f.OneSignal.User.externalId='b';f.subscription.optedIn=true;
  await f.ctx.disconnectOneSignalIdentity('a');assert.equal(f.OneSignal.User.externalId,'b');assert.equal(f.subscription.optedIn,true);
});

test('notification contents and clicks are accepted only for the active, matching account',()=>{
  const f=fixture(),matches=data=>f.ctx.notificationBelongsToCurrentAccount({additionalData:data});
  assert.equal(matches({recipient_user_id:'a'}),true);
  assert.equal(matches({assigned_user_id:'a'}),true);
  assert.equal(matches({recipient_user_ids:['b','a']}),true);
  assert.equal(matches({recipient_user_id:'b'}),false);
  assert.equal(matches({recipient_user_ids:['b']}),false);
  assert.equal(matches({view:'appointments'}),false,'Unidentified older notifications cannot open account views');
  f.state.frozen=true;assert.equal(matches({recipient_user_id:'a'}),false);
  f.state.frozen=false;f.OneSignal.User.externalId='b';assert.equal(matches({recipient_user_id:'a'}),false);
});
