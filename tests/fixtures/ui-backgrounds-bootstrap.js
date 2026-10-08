let currentUiTheme='flat',currentUiTint='blue',currentUiBackground='default',currentUiScale=100,currentUiLanguage='en';
const UI_SCALE_MIN=80,UI_SCALE_MAX=125,UI_SCALE_STEP=5,UI_SCALE_DEFAULT=100;
let themeSaveRequest=null,uiThemeRevision=0,dashboardResizeFrame=null,currentUserAccess={};
let currentSession={user:{id:'user-1',user_metadata:{lumin_ui_theme:'raised',lumin_ui_tint:'blue',lumin_ui_scale:100}}};
window.remoteUser=structuredClone(currentSession.user);window.writes=[];window.failSave=false;window.deferSave=false;
const db={auth:{
  async updateUser({data}){
    writes.push(structuredClone(data));
    const user=structuredClone(currentSession.user);
    if(deferSave)await new Promise(resolve=>{window.resolveSave=resolve;});
    if(failSave)return {error:new Error('Offline')};
    user.user_metadata={...user.user_metadata,...data};remoteUser=user;
    return {data:{user:structuredClone(user)},error:null};
  },
  async getUser(){return {data:{user:structuredClone(remoteUser)},error:null};}
}};
function hasPageAccess(){return true;}
function syncDashboardMobileTabs(){}
function schedulePatientQueryViewportUpdate(){}
function scheduleAppointmentCalendarViewportUpdate(){}
function scheduleWhatsAppMobileViewportUpdate(){}
function setAdminMessage(id,message){const el=document.getElementById(id);el.textContent=message;el.classList.remove('hidden');}
window.showFixtureView=function(name){
  document.querySelectorAll('#app-main > section').forEach(section=>section.classList.add('hidden'));
  document.getElementById('view-'+name).classList.remove('hidden');
  for(const node of [document.documentElement,document.body])node.classList.toggle('dashboard-active',name==='dashboard');
  updateDashboardViewportHeight();
};
