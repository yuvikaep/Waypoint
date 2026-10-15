import {api,type Identity} from './shared/core';
import {DEMO_MODE,setWorkspaceTenant,loadWorkspaceData} from './demo';
import {showLogin} from './auth';

// Routes a visitor to the driver sender, the login screen, the customer app or the admin console.
async function boot(){
  if(new URLSearchParams(location.search).has('sender')){const {mobileSender}=await import('./sender');await mobileSender();return}
  let identity:Identity|undefined;
  try{identity=DEMO_MODE?{role:'customer',tenantId:'owner',name:'Demo fleet',email:'demo@example.test'}:await api<Identity>('/session')}
  catch{/* not signed in */}
  const requested=new URLSearchParams(location.search).get('auth');
  if(!identity||requested==='signup'||(requested==='admin'&&identity.role!=='admin')||(requested==='customer'&&identity.role!=='customer')){showLogin();return}
  if(identity.role==='admin'){const {startAdmin}=await import('./admin/app');await startAdmin(identity);return}
  setWorkspaceTenant(identity.tenantId);
  await loadWorkspaceData().catch(()=>{});
  const {startCustomer}=await import('./customer/app');await startCustomer(identity);
}
void boot();
