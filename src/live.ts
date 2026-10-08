import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {createIcons,Navigation,Map,Route,RadioTower,Bell,Files,Plus,Search,Scan,LocateFixed,Radio,Download,Play,Pause,X,LogOut,Trash2,Smartphone,Copy,RefreshCw,ShieldCheck,MapPin,ChevronRight,UserRound,Settings,FileText,Save} from 'lucide';
import './live.css';
import {DEMO_MODE,demoRequest,workspaceStorage,setWorkspaceTenant} from './demo';

type Fix={id:number;deviceId:string;recordedAt:number;receivedAt:number;latitude:number;longitude:number;speed:number;heading:number|null;accuracy:number|null;ignition:number|null;battery:number|null;satellites:number|null};
type Device={id:string;name:string;uniqueId:string;model:'GT06'|'GT06N'|'FMB920'|'FMB125'|'FMC920'|'FMC130'|'Mobile';driver:string;lastSeen:number|null;offlineSeconds:number;speedLimit:number;bridgeStatus:string|null;traccarId:number|null;status:string;online:boolean;fresh:boolean;position:Fix|null;command:{status:string;detail:string;createdAt:number}|null};
type Fence={id:string;name:string;latitude:number;longitude:number;radius:number};
type Alert={id:string;deviceId:string;deviceName:string;type:string;message:string;createdAt:number;acknowledged:number};
type FleetState={devices:Device[];fences:Fence[];alerts:Alert[];gateway:{configured:boolean;connected:boolean;lastSync:number|null;error:string|null};serverTime:number};
type View='Live tracking'|'Route history'|'Devices'|'Geofences'|'Alerts'|'Documents'|'E-way bills'|'Profile'|'Settings'|'Customers';
const views: [View,string][]=[['Live tracking','map'],['Route history','route'],['Devices','radio-tower'],['Geofences','map-pin'],['Alerts','bell'],['Documents','files'],['E-way bills','file-text'],['Profile','user-round'],['Settings','settings']];
type Identity={role:'admin'|'customer';tenantId:string;name:string;email:string|null};
type Customer={id:string;name:string;email:string;enabled:boolean;createdAt:number};
type Preferences={name:string;workspace:string;email:string;follow:boolean;defaultView:View};
function preferences():Preferences{
  const defaults:Preferences={name:identity?.name||'Workspace admin',workspace:'Fleet workspace',email:identity?.email||'',follow:false,defaultView:'Live tracking'};
  try{const saved=JSON.parse(workspaceStorage.getItem('workspace-preferences')||'{}');return {...defaults,...saved,defaultView:views.some(([name])=>name===saved.defaultView)?saved.defaultView:defaults.defaultView}}catch{return defaults}
}
const iconSet={Navigation,Map,Route,RadioTower,Bell,Files,Plus,Search,Scan,LocateFixed,Radio,Download,Play,Pause,X,LogOut,Trash2,Smartphone,Copy,RefreshCw,ShieldCheck,MapPin,ChevronRight,UserRound,Settings,FileText,Save};
const i=(name:string)=>`<i data-lucide="${name}"></i>`;
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const $=<T extends Element=HTMLElement>(selector:string)=>document.querySelector<T>(selector)!;
const icons=()=>createIcons({icons:iconSet});
const time=(at:number|null)=>at?new Date(at).toLocaleString(): 'Never';
function ago(at:number|null){if(!at)return 'Never';const s=Math.max(0,Math.floor((Date.now()-at)/1000));return s<60?`${s}s ago`:s<3600?`${Math.floor(s/60)}m ago`:`${Math.floor(s/3600)}h ago`}
const coords=(p:Fix|Fence)=>`${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`;
const statusClass=(d:Device)=>d.status==='Moving'?'green':d.status==='Stopped'?'blue':d.status==='Offline'?'red':'amber';
let state:FleetState|undefined, identity:Identity|undefined, view:View='Live tracking', selected='', search='', filter='All', following=false;
let map:L.Map|undefined, markerLayer:L.LayerGroup|undefined, fenceLayer:L.LayerGroup|undefined, routeLayer:L.LayerGroup|undefined;
let poll:ReturnType<typeof setTimeout>|undefined, busy=false, connected=false, fitted=false;
let history:Fix[]=[],historyDevice='',historyVersion=0,playTimer:ReturnType<typeof setInterval>|undefined,playMarker:L.CircleMarker|undefined;
let active=true;
view=preferences().defaultView;following=preferences().follow;
const requestedView=new URLSearchParams(location.search).get('view');
if(views.some(([name])=>name===requestedView))view=requestedView as View;

async function api<T=any>(path:string, options:RequestInit={}):Promise<T>{
  if(DEMO_MODE)return demoRequest(path,options);
  const response=await fetch('/api/gps'+path,{...options,headers:{'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(15000)});
  const body=await response.json().catch(()=>({error:'Tracking service unavailable. Start npm run dev.'}));
  if(!response.ok){if(response.status===401 && !path.startsWith('/sender/') && path!=='/session' && path!=='/customers/session')showLogin();throw new Error(body.error || 'Request failed.');}
  return body;
}
function action(selector:string,callback:()=>void|Promise<void>){$(selector)?.addEventListener('click',()=>{Promise.resolve().then(callback).catch(e=>notify(e.message))})}
function notify(message:string){const el=$('#notice');if(el){el.textContent=message;el.hidden=false;setTimeout(()=>el.hidden=true,6000)}}
function stopPlay(){if(playTimer)clearInterval(playTimer);playTimer=undefined;playMarker?.remove();playMarker=undefined}
function disposeMap(){stopPlay();map?.remove();map=undefined;markerLayer=undefined;routeLayer=undefined;fenceLayer=undefined;fitted=false;historyVersion++}
function brand(){return `<a class="live-brand" href="/${DEMO_MODE?'?demo=1':'?live=1'}">${i('navigation')}<span>waypoint<span class="brand-dot">.</span></span></a>`}
function showLogin(error=''){
  active=false;clearTimeout(poll);disposeMap();
  $('#app').innerHTML=`<div class="login-shell">${brand()}<form class="login-form" id="login"><span class="eyebrow">FLEET WORKSPACE</span><h1>Welcome back</h1><div class="login-modes" role="group" aria-label="Account access"><button type="button" data-mode="customer" aria-pressed="true">Customer login</button><button type="button" data-mode="signup" aria-pressed="false">Sign up</button><button type="button" data-mode="admin" aria-pressed="false">Admin</button></div><div id="login-fields"></div><p class="error" role="alert">${esc(error)}</p><button class="primary" type="submit" id="login-submit">Open workspace ${i('chevron-right')}</button></form></div>`;
  let mode:'customer'|'signup'|'admin'='customer';
  const fields=()=>{$('#login-fields').innerHTML=mode==='admin'?'<label>Workspace access key<input name="token" type="password" required autocomplete="current-password"></label><details><summary>Local access key</summary><p>Your server stores the key in <code>server/private/admin-token</code>.</p></details>':`${mode==='signup'?'<label>Your name or business<input name="name" maxlength="100" required autocomplete="organization"></label>':''}<label>Email<input name="email" type="email" required autocomplete="username"></label><label>Password<input name="password" type="password" ${mode==='signup'?'minlength="12" maxlength="128" autocomplete="new-password"':'autocomplete="current-password"'} required></label>${mode==='signup'?'<label>Confirm password<input name="confirm" type="password" required autocomplete="new-password"></label>':''}`;$('#login-submit').innerHTML=(mode==='signup'?'Create workspace':'Open workspace')+' '+i('chevron-right');document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));icons()};
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b=>b.onclick=()=>{mode=b.dataset.mode as typeof mode;fields()});fields();
  $('#login').addEventListener('submit',async event=>{event.preventDefault();const button=$<HTMLButtonElement>('#login-submit');button.disabled=true;try{const data=new FormData(event.target as HTMLFormElement);if(mode==='signup'&&data.get('password')!==data.get('confirm'))throw Error('Passwords do not match.');await api(mode==='signup'?'/customers/register':mode==='customer'?'/customers/session':'/session',{method:'POST',body:JSON.stringify(mode==='admin'?{token:data.get('token')}:{name:data.get('name'),email:data.get('email'),password:data.get('password')})});location.href='/?live=1'}catch(e){$('.error').textContent=(e as Error).message;button.disabled=false}});icons();
}
async function boot(){
  try{identity=DEMO_MODE?{role:'admin',tenantId:'owner',name:'Demo workspace',email:null}:await api<Identity>('/session')}
  catch{/* Show customer login, signup and admin access. */}
  if(!identity){showLogin();return}
  setWorkspaceTenant(identity.tenantId);
  if(view==='Customers'&&identity.role!=='admin')view='Live tracking';
  try {state=await api<FleetState>('/state');active=true;connected=true;selected=state.devices[0]?.id || '';shell();schedule();}
  catch(e){if(!$('#login'))showLogin((e as Error).message)}
}
function shell(){
  const navScroll=$<HTMLElement>('.live-sidebar nav')?.scrollTop||0;
  disposeMap();
  $('#app').innerHTML=`<div class="live-shell"><aside class="live-sidebar">${brand()}<div class="workspace-label">${esc(preferences().workspace)}<small>${esc(identity?.name||preferences().name)}</small></div><nav aria-label="Workspace">${[...views,...(identity?.role==='admin'&&!DEMO_MODE?[['Customers','user-round'] as [View,string]]:[])].map(([name,icon])=>`<button data-view="${name}" class="${view===name?'selected':''}">${i(icon)}${name}</button>`).join('')}</nav><div class="sidebar-foot"><button id="logout">${i('log-out')}Sign out</button></div></aside><main class="live-main"><header class="live-header"><span>Workspace ${i('chevron-right')} <strong>${view}</strong></span><span id="connection" role="status"></span></header><div class="live-heading"><div><span class="eyebrow">WAYPOINT / OPERATIONS</span><h1>${view==='Live tracking'?'Fleet overview':view}</h1></div><button class="primary" id="add-device">${i('plus')}Add device</button></div><div id="gateway-notice"></div><div id="view-body"></div></main></div><div id="notice" role="status" hidden></div><dialog id="modal"></dialog>`;
  $('#connection').insertAdjacentHTML('afterend',`<button class="tool compact-signout" id="compact-logout" title="Sign out" aria-label="Sign out">${i('log-out')}</button>`);
  const logout=async()=>{await api('/session',{method:'DELETE'});location.href='/?live=1&signin=1'};
  action('#compact-logout',logout);
  document.querySelectorAll<HTMLElement>('[data-view]').forEach(b=>b.onclick=()=>{view=b.dataset.view as View;search='';filter='All';const url=new URL(location.href);url.searchParams.set('view',view);window.history.pushState(null,'',url);shell()});
  action('#logout',logout);action('#add-device',addDevice);
  document.querySelectorAll<HTMLAnchorElement>('a[href="/?workspace=documents"]').forEach(a=>a.href=DEMO_MODE?'/?demo=1&workspace=documents':'/?live=1&workspace=documents');
  if(DEMO_MODE){
    $('#logout').replaceWith(Object.assign(document.createElement('a'),{href:'/?live=1',textContent:'Open live workspace'}));
    $('#compact-logout').remove();
  }
  $('#add-device').hidden=['Documents','E-way bills','Profile','Settings','Customers'].includes(view);
  if(view==='Live tracking'||view==='Route history')tracking();
  else if(view==='Documents'||view==='E-way bills')void savedView(view);
  else if(view==='Profile'||view==='Settings')renderPreferences();
  else if(view==='Customers')void renderCustomers();
  else renderTable();
  renderConnection();icons();
  $<HTMLElement>('.live-sidebar nav').scrollTop=navScroll;
  const selectedNav=$<HTMLButtonElement>('nav [data-view].selected');
  selectedNav?.setAttribute('aria-current','page');
  if(window.matchMedia('(max-width:800px)').matches)selectedNav?.scrollIntoView({block:'nearest',inline:'nearest'});
}

window.addEventListener('popstate',()=>{
  const name=new URLSearchParams(location.search).get('view');
  view=name==='Customers'&&identity?.role==='admin'?'Customers':views.find(([v])=>v===name)?.[0]||'Live tracking';
  if(active&&state)shell();
});
async function savedView(section:'Documents'|'E-way bills'){
  const host=$<HTMLElement>('#view-body');
  host.textContent='Loading...';
  try{
    const {mountDocuments}=await import('./main');
    if(!host.isConnected||view!==section)return;
    mountDocuments(host,section,state?.devices||[]);
  }catch{if(host.isConnected)host.textContent='Unable to load this section. Refresh to retry.'}
}
function renderPreferences(){
  const p=preferences(),profile=view==='Profile';
  $('#view-body').innerHTML=`<form class="workspace-form" id="workspace-preferences">
    <h2>${profile?'Workspace profile':'Workspace preferences'}</h2>
    ${profile?`<label>Display name<input name="name" maxlength="100" required value="${esc(p.name)}"></label><label>Workspace name<input name="workspace" maxlength="100" required value="${esc(p.workspace)}"></label><label>Email<input name="email" type="email" maxlength="254" value="${esc(p.email)}"></label>`:
    `<label>Default page<select name="defaultView">${views.map(([name])=>`<option ${p.defaultView===name?'selected':''}>${name}</option>`).join('')}</select></label><label class="check-setting"><input type="checkbox" name="follow" ${p.follow?'checked':''}>Follow selected vehicle on map</label><dl class="setup-facts"><dt>Mobile heartbeat</dt><dd>30 seconds</dd><dt>Map refresh</dt><dd>3 seconds</dd><dt>Preference storage</dt><dd>This browser</dd></dl>`}
    <p class="error" id="preferences-error" role="alert"></p>
    <button class="primary" type="submit">${i('save')}Save changes</button></form>`;
  $('#workspace-preferences').addEventListener('submit',event=>{
    event.preventDefault();const form=new FormData(event.target as HTMLFormElement);
    try{
      const next=profile?{...p,name:String(form.get('name')).trim(),workspace:String(form.get('workspace')).trim(),email:String(form.get('email')).trim()}:{...p,defaultView:String(form.get('defaultView')) as View,follow:form.has('follow')};
      if(!next.name||!next.workspace)throw Error('Display name and workspace name are required.');
      workspaceStorage.setItem('workspace-preferences',JSON.stringify(next));following=next.follow;shell();notify('Preferences saved in this browser.');
    }catch(error){$('#preferences-error').textContent=(error as Error).message}
  });
}
async function renderCustomers(){
  if(identity?.role!=='admin')return;
  const host=$('#view-body');host.textContent='Loading customers...';
  try{
    const result=await api<{customers:Customer[]}>('/customers');
    if(!host.isConnected||view!=='Customers')return;
    host.innerHTML=`<form class="workspace-form" id="create-customer"><h2>Add customer</h2><label>Customer name<input name="name" maxlength="100" required></label><label>Email<input name="email" type="email" maxlength="254" required></label><button class="primary" type="submit">${i('plus')}Create customer</button><p class="error" id="customer-error" role="alert"></p></form><div id="customer-credentials" role="status"></div><div class="section-heading"><h2>Customers <span>${result.customers.length}</span></h2></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Access</th><th>Actions</th></tr></thead><tbody>${result.customers.map(c=>`<tr><td><strong>${esc(c.name)}</strong></td><td>${esc(c.email)}</td><td>${c.enabled?'Enabled':'Disabled'}</td><td><button class="secondary" data-reset="${esc(c.id)}">Reset password</button> <button class="secondary" data-access="${esc(c.id)}" data-enabled="${c.enabled}">${c.enabled?'Disable':'Enable'}</button></td></tr>`).join('')||'<tr><td colspan="4">No customers yet.</td></tr>'}</tbody></table></div>`;
    const credentials=(email:string,password:string)=>{const box=$('#customer-credentials');box.innerHTML=`<div class="credential-result"><strong>One-time password for ${esc(email)}</strong><code>${esc(password)}</code><button class="secondary" id="copy-customer-password" type="button">${i('copy')}Copy password</button><p>Share privately. This password is shown only now.</p></div>`;action('#copy-customer-password',async()=>{await navigator.clipboard.writeText(password);notify('Password copied.')});icons()};
    $('#create-customer').addEventListener('submit',async event=>{event.preventDefault();const form=event.target as HTMLFormElement;const data=new FormData(form);const button=form.querySelector<HTMLButtonElement>('button[type=submit]')!;button.disabled=true;try{const result=await api<{customer:Customer;password:string}>('/customers',{method:'POST',body:JSON.stringify({name:data.get('name'),email:data.get('email')})});await renderCustomers();credentials(result.customer.email,result.password)}catch(e){$('#customer-error').textContent=(e as Error).message;button.disabled=false}});
    document.querySelectorAll<HTMLButtonElement>('[data-reset]').forEach(button=>button.onclick=async()=>{if(!confirm('Reset this customer password and sign out active sessions?'))return;try{const customer=result.customers.find(c=>c.id===button.dataset.reset)!;const reset=await api<{password:string}>(`/customers/${customer.id}/reset`,{method:'POST',body:'{}'});credentials(customer.email,reset.password)}catch(e){notify((e as Error).message)}});
    document.querySelectorAll<HTMLButtonElement>('[data-access]').forEach(button=>button.onclick=async()=>{const enabled=button.dataset.enabled!=='true';if(!confirm(`${enabled?'Enable':'Disable'} this customer account?`))return;try{await api(`/customers/${button.dataset.access}/access`,{method:'PUT',body:JSON.stringify({enabled})});await renderCustomers()}catch(e){notify((e as Error).message)}});
    icons();
  }catch(e){if(host.isConnected)host.textContent=(e as Error).message}
}

function renderConnection(){
  if(!state||!$('#connection'))return;
  if(DEMO_MODE){$('#connection').innerHTML='<span class="dot amber"></span>Demo · sample data';$('#gateway-notice').innerHTML='';return}
  $('#connection').innerHTML=`<span class="dot ${connected?'green':'red'}"></span>${connected?'Service connected':'Connection lost'}`;
  const g=state.gateway;
  $('#gateway-notice').innerHTML=!g.configured?`<div class="service-notice">${i('radio-tower')}<span>Hardware gateway not configured. Mobile tracking is available.</span><button id="gateway-setup">Connection details</button></div>`:!g.connected?`<div class="service-notice error">${i('radio-tower')}<span>${esc(g.error || 'Connecting to tracker gateway...')}</span><button id="gateway-setup">Connection details</button></div>`:'';
  action('#gateway-setup',gatewayInfo);icons();
}
function schedule(){clearTimeout(poll);if(active)poll=setTimeout(refresh,3000)}
async function refresh(){
  if(!active||busy)return;busy=true;
  try{state=await api<FleetState>('/state');connected=true;if(!active)return;if(view==='Live tracking'||view==='Route history')updateTracking();else if(['Devices','Geofences','Alerts'].includes(view))renderTable();}
  catch{connected=false;}
  finally{busy=false;if(active){renderConnection();schedule()}}
}
function devices(){return (state?.devices||[]).filter(d=>(filter==='All'||d.status===filter)&&`${d.name} ${d.uniqueId} ${d.driver}`.toLowerCase().includes(search.toLowerCase()))}
function current(){return state?.devices.find(d=>d.id===selected)}
function tracking(){
  $('#view-body').innerHTML=`<div class="fleet-stats" id="fleet-stats"></div><div class="fleet-tools"><label class="search-input">${i('search')}<input id="vehicle-search" placeholder="Search vehicle, driver or IMEI" value="${esc(search)}"></label><label class="status-filter">Status<select id="status-filter">${['All','Moving','Stopped','Offline','Waiting','No GPS fix'].map(s=>`<option>${s}</option>`).join('')}</select></label><button class="tool" id="fit-map" title="Fit vehicles" aria-label="Fit vehicles">${i('scan')}</button><button class="tool ${following?'on':''}" id="follow" title="Follow selected vehicle" aria-label="Follow selected vehicle" aria-pressed="${following}">${i('locate-fixed')}</button></div><div class="live-tracking"><div class="fleet-list" id="fleet-list"></div><section class="fleet-map" aria-label="Fleet map"><div id="live-map"></div><div id="map-empty" class="map-empty" hidden>No GPS positions received</div><div id="device-detail"></div></section></div>${view==='Route history'?`<section class="history-toolbar"><label>From<input id="history-from" type="datetime-local"></label><label>To<input id="history-to" type="datetime-local"></label><button class="primary" id="load-history">${i('route')}Load route</button><button class="tool" id="play-route" disabled title="Play recorded route" aria-label="Play recorded route">${i('play')}</button><button class="tool" id="export-route" disabled title="Download route CSV" aria-label="Download route CSV">${i('download')}</button><input id="route-slider" aria-label="Route position" type="range" min="0" max="0" value="0" disabled><span id="history-status" role="status">Select a vehicle and date range.</span></section>`:''}`;
  map=L.map('live-map',{zoomControl:false}).setView([18.6,73.7],9);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',maxZoom:19}).addTo(map);
  L.control.zoom({position:'topright'}).addTo(map);
  markerLayer=L.layerGroup().addTo(map);fenceLayer=L.layerGroup().addTo(map);routeLayer=L.layerGroup().addTo(map);
  $<HTMLInputElement>('#vehicle-search').oninput=e=>{search=(e.target as HTMLInputElement).value;updateTracking()};
  $<HTMLSelectElement>('#status-filter').value=filter;
  $<HTMLSelectElement>('#status-filter').onchange=e=>{filter=(e.target as HTMLSelectElement).value;updateTracking()};
  action('#fit-map',fit);action('#follow',()=>{following=!following;$('#follow').classList.toggle('on',following);$('#follow').setAttribute('aria-pressed',String(following));if(current()?.position)map?.panTo(point(current()!.position!))});
  if(view==='Route history'){
    const local=(date:Date)=>new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,19);
    $<HTMLInputElement>('#history-from').step='1';$<HTMLInputElement>('#history-to').step='1';
    $<HTMLInputElement>('#history-from').value=local(new Date(new Date().setHours(0,0,0,0)));$<HTMLInputElement>('#history-to').value=local(new Date());
    action('#load-history',loadHistory);action('#play-route',playHistory);action('#export-route',exportHistory);
    $<HTMLInputElement>('#route-slider').oninput=()=>{stopPlay();showHistoryPoint(Number($<HTMLInputElement>('#route-slider').value));$('#play-route').innerHTML=i('play');icons()};
  }
  updateTracking();
}
function point(p:Fix|Fence):L.LatLngTuple{return [p.latitude,p.longitude]}
function updateTracking(){
  if(!state||!map)return;
  const visible=devices();if(!visible.some(d=>d.id===selected)){selected=visible[0]?.id||'';clearHistory()}
  $('#fleet-stats').innerHTML=[['Vehicles',state.devices.length,''],['Moving',state.devices.filter(d=>d.status==='Moving').length,'green'],['Stopped',state.devices.filter(d=>d.status==='Stopped').length,'blue'],['Needs attention',state.devices.filter(d=>!d.fresh||!d.online).length,'amber']].map(([name,value,color])=>`<div><span>${name}</span><strong class="${color}">${value}</strong></div>`).join('');
  $('#fleet-list').innerHTML=visible.length?visible.map(d=>`<button class="live-vehicle ${selected===d.id?'chosen':''}" data-device="${d.id}"><span class="vehicle-title"><strong>${esc(d.name)}</strong><span class="status ${statusClass(d)}">${d.status}</span></span><span class="vehicle-sub">${esc(d.model)} &middot; ${esc(d.driver||d.uniqueId)}</span><span class="vehicle-position">${i('map-pin')}${d.position?coords(d.position):'Awaiting first GPS fix'}</span><span class="vehicle-bottom"><b>${d.position&&d.fresh?`${Math.round(d.position.speed)} km/h`:'No current speed'}</b><span title="${time(d.lastSeen)}">${ago(d.lastSeen)}</span></span></button>`).join(''):`<div class="empty-state">${i('radio-tower')}<h2>${state.devices.length?'No matching vehicles':'No devices yet'}</h2>${!state.devices.length?'<button class="primary" id="first-device">Add device</button>':''}</div>`;
  action('#first-device',addDevice);
  document.querySelectorAll<HTMLElement>('[data-device]').forEach(b=>b.onclick=()=>select(b.dataset.device!));
  markerLayer!.clearLayers();
  for(const d of visible){if(!d.position)continue;const marker=L.marker(point(d.position),{title:d.name,icon:L.divIcon({className:'gps-marker',html:`<div class="gps-pin ${statusClass(d)} ${selected===d.id?'selected':''}"><span style="transform:rotate(${d.position.heading||0}deg)">&#9650;</span></div>`,iconSize:[32,32],iconAnchor:[16,16]})}).addTo(markerLayer!);const label=document.createElement('span');label.textContent=d.name;marker.bindTooltip(label,{permanent:d.id===selected,direction:'top',offset:[0,-16]}).on('click',()=>select(d.id));}
  fenceLayer!.clearLayers();for(const fence of state.fences){const label=document.createElement('span');label.textContent=fence.name;L.circle(point(fence),{radius:fence.radius,color:'#8665a9',fillOpacity:.08,weight:2}).bindTooltip(label).addTo(fenceLayer!)}
  $('#map-empty').hidden=visible.some(d=>d.position!==null);
  detail();
  if(!fitted&&visible.some(d=>d.position)){fit();fitted=true}
  if(following&&view==='Live tracking'&&current()?.position)map.panTo(point(current()!.position!));icons();
}
function fit(){const points=devices().flatMap(d=>d.position?[point(d.position)]:[]);if(points.length)map?.fitBounds(points,{padding:[45,45],maxZoom:15})}
function select(id:string){if(id!==selected){selected=id;clearHistory()}updateTracking();if(current()?.position)map?.setView(point(current()!.position!),Math.max(12,map.getZoom()))}
function detail(){
  const d=current();if(!d){$('#device-detail').innerHTML='';return}
  const p=d.position;
  $('#device-detail').innerHTML=`<div class="detail-head"><div><strong>${esc(d.name)}</strong><small>${esc(d.model)} &middot; ${esc(d.uniqueId)}</small></div><button class="primary" id="ping-device" ${!connected?'disabled':''}>${i('radio')}Ping</button></div><dl class="detail-grid"><div><dt>Last heartbeat</dt><dd title="${time(d.lastSeen)}">${ago(d.lastSeen)}</dd></div><div><dt>GPS fix</dt><dd title="${time(p?.recordedAt||null)}">${p?ago(p.recordedAt):'Waiting'}</dd></div><div><dt>Ignition</dt><dd>${p?.ignition==null?'Unknown':p.ignition?'On':'Off'}</dd></div><div><dt>Accuracy</dt><dd>${p?.accuracy==null?'Unknown':`${Math.round(p.accuracy)} m`}</dd></div><div><dt>Battery</dt><dd>${p?.battery==null?'Unknown':`${Math.round(p.battery)}%`}</dd></div><div><dt>Satellites</dt><dd>${p?.satellites??'Unknown'}</dd></div></dl>${d.command?`<div class="command-status"><strong>Ping: ${esc(d.command.status)}</strong><span>${esc(d.command.detail)}</span></div>`:''}<div class="detail-actions"><span>${p?coords(p):'No position'}</span>${d.model!=='Mobile'?`<button id="device-relay">${i('shield-check')}Relay</button>`:''}<button id="device-history">${i('route')}History</button></div>`;
  action('#ping-device',async()=>{const button=$<HTMLButtonElement>('#ping-device');button.disabled=true;try{await api(`/devices/${d.id}/ping`,{method:'POST',body:'{}'});await refresh()}finally{if(button.isConnected)button.disabled=false}});
  action('#device-relay',()=>relayDialog(d));
  action('#device-history',()=>{view='Route history';shell();void loadHistory().catch(e=>notify(e.message))});
}
function clearHistory(){stopPlay();history=[];historyDevice='';historyVersion++;routeLayer?.clearLayers();if($('#history-status')){$('#history-status').textContent='Select a vehicle and date range.';$<HTMLButtonElement>('#play-route').disabled=true;$<HTMLButtonElement>('#export-route').disabled=true;$<HTMLInputElement>('#route-slider').disabled=true}}
async function loadHistory(){
  if(!selected){notify('Select a device first.');return}
  const from=new Date($<HTMLInputElement>('#history-from').value),to=new Date($<HTMLInputElement>('#history-to').value);
  if(!Number.isFinite(+from)||!Number.isFinite(+to)||from>to||+to-+from>31*86400000){notify('Choose a valid date range of up to 31 days.');return}
  clearHistory();const version=historyVersion,id=selected;historyDevice=id;
  $('#history-status').textContent='Loading recorded positions...';$<HTMLButtonElement>('#load-history').disabled=true;
  try{
    let after:number|null=0;const positions:Fix[]=[];let warning='';
    do{const result: {positions:Fix[];next:number|null;warning?:string}=await api(`/devices/${id}/history?${new URLSearchParams({from:from.toISOString(),to:to.toISOString(),after:String(after)})}`);if(version!==historyVersion)return;positions.push(...result.positions);warning=result.warning||warning;after=result.next;if(positions.length>=100000&&after)throw new Error('Too many positions. Choose a shorter date range.');}while(after!==null);
    history=positions.sort((a,b)=>a.recordedAt-b.recordedAt||a.id-b.id);
    if(history.length){
      // Break tracks across gaps rather than drawing a claimed continuous journey.
      const segments:Fix[][]=[[]];for(const p of history){const segment=segments.at(-1)!;if(segment.length&&p.recordedAt-segment.at(-1)!.recordedAt>15*60000)segments.push([]);segments.at(-1)!.push(p)}
      for(const segment of segments){if(segment.length>1)L.polyline(segment.map(point),{color:'#176fba',weight:4}).addTo(routeLayer!);else L.circleMarker(point(segment[0]),{radius:4,color:'#176fba'}).addTo(routeLayer!)}
      map?.fitBounds(history.map(point),{padding:[45,45],maxZoom:16});
    }
    $('#history-status').textContent=`${history.length} recorded positions${history.length?' · '+time(history[0].recordedAt)+' to '+time(history.at(-1)!.recordedAt):' in this period'}${warning?' · '+warning:''}`;
    $<HTMLButtonElement>('#play-route').disabled=history.length<2;$<HTMLButtonElement>('#export-route').disabled=!history.length;
    const slider=$<HTMLInputElement>('#route-slider');slider.max=String(Math.max(0,history.length-1));slider.value='0';slider.disabled=!history.length;
  }catch(e){if(version===historyVersion)$('#history-status').textContent=(e as Error).message}
  finally{if($('#load-history'))$<HTMLButtonElement>('#load-history').disabled=false}
}
function showHistoryPoint(index:number){const p=history[index];if(!p)return;playMarker?.remove();playMarker=L.circleMarker(point(p),{radius:8,color:'#fff',fillColor:'#176fba',fillOpacity:1,weight:3}).addTo(map!);$<HTMLInputElement>('#route-slider').value=String(index);$('#history-status').textContent=`${index+1} / ${history.length} · ${time(p.recordedAt)} · ${Math.round(p.speed)} km/h`;if(following)map?.panTo(point(p))}
function playHistory(){if(playTimer){stopPlay();$('#play-route').innerHTML=i('play');icons();return}let index=Number($<HTMLInputElement>('#route-slider').value);if(index>=history.length-1)index=0;$('#play-route').innerHTML=i('pause');icons();playTimer=setInterval(()=>{showHistoryPoint(index++);if(index===history.length){clearInterval(playTimer);playTimer=undefined;$('#play-route').innerHTML=i('play');icons()}},500)}
function exportHistory(){if(historyDevice!==selected||!history.length)return;const rows=[['Time','Latitude','Longitude','Speed km/h','Accuracy m','Ignition'],...history.map(p=>[new Date(p.recordedAt).toISOString(),p.latitude,p.longitude,p.speed,p.accuracy??'',p.ignition??''])];const url=URL.createObjectURL(new Blob([rows.map(r=>r.join(',')).join('\n')],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download=`waypoint-route-${selected}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}

function renderTable(){
  if(!state)return;
  if(view==='Devices')$('#view-body').innerHTML=`<div class="section-heading"><h2>Registered devices <span>${state.devices.length}</span></h2><span>${state.gateway.connected?'Hardware gateway connected':'Hardware gateway unavailable'}</span></div><div class="table-wrap"><table><thead><tr><th>Vehicle / identifier</th><th>Tracker</th><th>State</th><th>Last heartbeat</th><th>Gateway</th><th></th></tr></thead><tbody>${state.devices.map(d=>`<tr><td><strong>${esc(d.name)}</strong><small>${esc(d.uniqueId)}</small></td><td>${d.model}</td><td><span class="status ${statusClass(d)}">${d.status}</span></td><td>${ago(d.lastSeen)}</td><td>${esc(d.model==='Mobile'?'Direct sender':d.bridgeStatus||'Awaiting gateway')}</td><td><button class="secondary" data-setup="${d.id}">Connection</button>${d.model!=='Mobile'?` <button class="secondary" data-relay="${d.id}">${i('shield-check')}Relay</button>`:''}</td></tr>`).join('')||'<tr><td colspan="6">No registered devices.</td></tr>'}</tbody></table></div>`;
  else if(view==='Geofences')$('#view-body').innerHTML=`<div class="section-heading"><h2>Geofences <span>${state.fences.length}</span></h2><button class="secondary" id="add-fence">${i('plus')}Add geofence</button></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Centre</th><th>Radius</th><th></th></tr></thead><tbody>${state.fences.map(f=>`<tr><td>${esc(f.name)}</td><td>${coords(f)}</td><td>${f.radius} m</td><td><button class="tool" data-delete-fence="${f.id}" aria-label="Delete ${esc(f.name)}" title="Delete geofence">${i('trash-2')}</button></td></tr>`).join('')||'<tr><td colspan="4">No geofences configured.</td></tr>'}</tbody></table></div>`;
  else if(view==='Alerts')$('#view-body').innerHTML=`<div class="section-heading"><h2>Recent alerts <span>${state.alerts.filter(a=>!a.acknowledged).length} open</span></h2><span>Latest 200 events</span></div><div class="alert-list">${state.alerts.map(a=>`<div class="live-alert"><span class="event-icon ${a.type==='offline'?'red':a.type==='online'?'green':'amber'}">${i(a.type==='enter'||a.type==='exit'?'map-pin':'bell')}</span><div><strong>${esc(a.deviceName)}</strong><p>${esc(a.message)}</p><small>${time(a.createdAt)}</small></div><button class="secondary" data-ack="${a.id}" ${a.acknowledged?'disabled':''}>${a.acknowledged?'Acknowledged':'Acknowledge'}</button></div>`).join('')||'<div class="empty-state">No alerts recorded.</div>'}</div>`;
  document.querySelectorAll<HTMLElement>('[data-setup]').forEach(b=>b.onclick=()=>deviceInfo(state!.devices.find(d=>d.id===b.dataset.setup)!));
  document.querySelectorAll<HTMLElement>('[data-ack]').forEach(b=>b.onclick=()=>{void api(`/alerts/${b.dataset.ack}/ack`,{method:'POST',body:'{}'}).then(refresh).catch(e=>notify(e.message))});
  document.querySelectorAll<HTMLElement>('[data-delete-fence]').forEach(b=>b.onclick=()=>{const f=state!.fences.find(f=>f.id===b.dataset.deleteFence)!;modal('Delete geofence',`<p>Delete ${esc(f.name)}? Existing alerts will be retained.</p><button class="danger" id="confirm-delete">Delete geofence</button>`);action('#confirm-delete',async()=>{await api(`/fences/${f.id}`,{method:'DELETE'});closeModal();await refresh()})});
  document.querySelectorAll<HTMLElement>('[data-relay]').forEach(b=>b.onclick=()=>{void relayDialog(state!.devices.find(d=>d.id===b.dataset.relay)!).catch(e=>notify(e.message))});
  action('#add-fence',addFence);icons();
}

type RelayStatus={enabled:boolean;modelSupported:boolean;supported:boolean;error:string|null;installation:{installer:string;verifiedAt:number}|null;history:{action:string;status:string;detail:string;createdAt:number}[]};
async function relayDialog(d:Device){
  if(DEMO_MODE){modal('Relay / '+d.name,'<p>Relay control is unavailable in sample-data mode. No command will be sent.</p>');return}
  const status=await api<RelayStatus>(`/devices/${d.id}/relay`);
  const available=status.enabled&&status.supported&&!!status.installation;
  modal('Starter relay / '+d.name,`
    <p class="error">Starter-inhibit only. Fuel/ignition cut-off wiring is not supported. Physical relay state: unverified.</p>
    ${!status.enabled?'<p>Live relay commands are disabled on this server.</p>':''}
    ${status.error?`<p class="error">${esc(status.error)}</p>`:''}
    <dl class="setup-facts"><dt>Model</dt><dd>${esc(d.model)}</dd><dt>Gateway commands</dt><dd>${status.supported?'Supported':'Not verified / unavailable'}</dd><dt>Installation</dt><dd>${status.installation?esc(status.installation.installer)+' · '+time(status.installation.verifiedAt):'Not verified'}</dd></dl>
    <form id="relay-command">
      <label>Action<select name="action"><option value="inhibit">Inhibit next engine start</option><option value="restore">Restore starter access</option></select></label>
      <label>Confirm device IMEI<input name="confirmation" required autocomplete="off" placeholder="${esc(d.uniqueId)}"></label>
      <label>Reason<input name="reason" required maxlength="300"></label>
      <label>${identity?.role==='customer'?'Customer password':'Admin access key'}<input name="adminKey" type="password" required autocomplete="off"></label>
      <p>Inhibit requires ignition OFF, parked telemetry for 30 seconds and a fresh GPS fix. Commands are never queued for an offline tracker.</p>
      <button class="danger" type="submit" ${available?'':'disabled'}>Send relay command</button>
      <p id="relay-result" role="status"></p>
    </form>
    <details><summary>Installer verification</summary><form id="relay-installation">
      <label>Installer / verification reference<input name="installer" maxlength="200" required value="${esc(status.installation?.installer||'')}"></label>
      <label class="check-setting"><input type="checkbox" name="starterOnly" required>Starter circuit only; no fuel or ignition cut-off</label>
      <label class="check-setting"><input type="checkbox" name="polarityVerified" required>Gateway command polarity verified on this installation</label>
      <label>${identity?.role==='customer'?'Customer password':'Admin access key'}<input name="adminKey" type="password" required autocomplete="off"></label>
      <button class="secondary" type="submit">Save verification</button>
      <button class="secondary" id="relay-disable" type="button">Disable relay access</button>
      <p id="relay-installation-error" role="alert"></p>
    </form></details>
    <h2>Recent commands</h2>
    ${status.history.map(c=>`<p><strong>${esc(c.action)} · ${esc(c.status)}</strong><br>${time(c.createdAt)}<br>${esc(c.detail)}</p>`).join('')||'<p>No relay commands recorded.</p>'}
  `);
  const requestId=crypto.randomUUID();
  $('#relay-command').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.target as HTMLFormElement,button=form.querySelector<HTMLButtonElement>('button')!;button.disabled=true;
    try{
      const input=Object.fromEntries(new FormData(form));
      const result=await api<{status:string;detail:string}>(`/devices/${d.id}/relay`,{method:'POST',body:JSON.stringify({...input,requestId})});
      $('#relay-result').textContent=result.status+': '+result.detail;
    }catch(error){$('#relay-result').textContent=(error as Error).message}
    finally{form.querySelector<HTMLInputElement>('[name=adminKey]')!.value=''}
  });
  $('#relay-installation').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.target as HTMLFormElement,data=new FormData(form);
    try{await api(`/devices/${d.id}/relay`,{method:'PUT',body:JSON.stringify({installer:data.get('installer'),adminKey:data.get('adminKey'),starterOnly:data.has('starterOnly'),polarityVerified:data.has('polarityVerified')})});await relayDialog(d)}
    catch(error){$('#relay-installation-error').textContent=(error as Error).message;form.querySelector<HTMLInputElement>('[name=adminKey]')!.value=''}
  });
  action('#relay-disable',async()=>{
    const key=$<HTMLInputElement>('#relay-installation [name=adminKey]');
    try{await api(`/devices/${d.id}/relay`,{method:'PUT',body:JSON.stringify({enabled:false,adminKey:key.value})});await relayDialog(d)}
    finally{key.value=''}
  });
}

function modal(title:string,body:string){const dialog=$<HTMLDialogElement>('#modal');if(dialog.open)dialog.close();dialog.innerHTML=`<div class="modal-heading"><h2>${esc(title)}</h2><button class="tool" id="close-modal" aria-label="Close" title="Close">${i('x')}</button></div>${body}`;dialog.showModal();action('#close-modal',closeModal);icons()}
function closeModal(){$<HTMLDialogElement>('#modal').close()}
function addDevice(){
  modal('Add a GPS device',`<form id="device-form"><label>Vehicle name / registration<input name="name" required maxlength="100" placeholder="MH 12 AB 1234"></label><label>Tracker model<select name="model" id="device-model"><option>GT06</option><option>GT06N</option><option>FMB920</option><option>FMB125</option><option>FMC920</option><option>FMC130</option><option>Mobile</option></select></label><label><span id="identifier-label">15-digit IMEI</span><input name="uniqueId" required maxlength="32" autocomplete="off"></label><label>Driver (optional)<input name="driver" maxlength="100"></label><div class="form-grid"><label>Offline after (seconds)<input type="number" name="offlineSeconds" min="30" max="86400" value="180" required></label><label>Speed limit (km/h)<input type="number" name="speedLimit" min="1" max="250" value="80" required></label></div><p class="error" id="form-error" role="alert"></p><button class="primary" type="submit">Register device</button></form>`);
  $<HTMLSelectElement>('#device-model').onchange=()=>{const mobile=$<HTMLSelectElement>('#device-model').value==='Mobile';const field=$<HTMLInputElement>('#device-form input[name=uniqueId]');field.required=!mobile;field.disabled=mobile;field.closest('label')!.hidden=mobile};
  $('#device-form').addEventListener('submit',async e=>{e.preventDefault();const form=e.target as HTMLFormElement,values=Object.fromEntries(new FormData(form));const button=form.querySelector<HTMLButtonElement>('button[type=submit]')!;button.disabled=true;try{const result=await api<{device:Device;token:string|null}>('/devices',{method:'POST',body:JSON.stringify({...values,offlineSeconds:Number(values.offlineSeconds),speedLimit:Number(values.speedLimit)})});selected=result.device.id;await refresh();deviceInfo(result.device,result.token)}catch(error){$('#form-error').textContent=(error as Error).message;button.disabled=false}});
}
function deviceInfo(d:Device,secret:string|null=null){
  const mobile=d.model==='Mobile';
  if(mobile){driverLinkDialog(d,!!secret);return}
  modal(`${d.name} / Connection`,`<dl class="setup-facts"><dt>Model</dt><dd>${d.model}</dd><dt>IMEI</dt><dd>${esc(d.uniqueId)}</dd><dt>Protocol</dt><dd>${d.model.startsWith('GT06')?'GT06':'Teltonika'}</dd><dt>TCP port</dt><dd>${d.model.startsWith('GT06')?'5023':'5027'}</dd><dt>Registration</dt><dd>${d.traccarId?'Linked to gateway':'Awaiting gateway synchronization'}</dd></dl><p>Set the tracker server address to your reachable Traccar host and configure the SIM APN in the device configurator.</p><p class="muted">${d.model.startsWith('FM')?'Use Teltonika Configurator with TCP data transport.':'GT06 command syntax varies by manufacturer; use the manual supplied with this device.'}</p><button class="secondary" id="hardware-help">Gateway details</button>`);
  action('#hardware-help',gatewayInfo);
}
function driverLinkDialog(d:Device,createNow=false){
  modal(`${d.name} / Driver access`,`<p>Driver link kholein, location allow karein aur sharing shuru karein.</p><button class="primary" id="create-driver-link">${i('plus')}Create driver link</button><p class="muted">Naya link banane par purana link aur uski sharing access band ho jayegi.</p><div id="driver-link-result"></div><p id="link-error" class="error" role="alert"></p><button class="secondary" id="revoke-driver-link">Disable driver access</button>`);
  const showLink=async(regenerate=false,readOnly=false)=>{
    const button=$<HTMLButtonElement>('#create-driver-link');button.disabled=true;
    try{
      const result=await api<{code:string|null;expiresAt:number|null}|null>(`/devices/${d.id}/driver-link`,readOnly?{}:{method:'POST',body:JSON.stringify({regenerate})});
      if(!result)return;
      if(!result.code){button.textContent='Regenerate link';button.dataset.active='true';$('#link-error').textContent='Existing link is still valid. Reopen it once to make it available here, or explicitly regenerate it.';return;}
      const url=new URL('/?sender=1',location.origin);url.hash=new URLSearchParams({join:result.code}).toString();
      if(DEMO_MODE)url.searchParams.set('demo','1');
      const link=url.toString();
      $('#driver-link-result').innerHTML=`<label>Driver link<input id="driver-share-url" readonly value="${esc(link)}"></label><div class="driver-link-actions"><button class="secondary" id="copy-driver-link">${i('copy')}Copy link</button>${typeof navigator.share==='function'?'<button class="primary" id="share-driver-link">Share link</button>':''}<a class="secondary" id="open-driver-link" href="${esc(link)}" target="_blank" rel="noopener">Open</a></div><p class="muted">Valid until ${time(result.expiresAt)}</p>${['localhost','127.0.0.1'].includes(location.hostname)?'<p class="error">Yeh local preview link hai. Driver ke phone par bhejne ke liye public HTTPS address chahiye.</p>':''}`;
      action('#copy-driver-link',async()=>{try{await navigator.clipboard.writeText(link);notify('Driver link copied.')}catch{$<HTMLInputElement>('#driver-share-url').select();$('#link-error').textContent='Link select ho gaya hai. Copy karein.'}});
      action('#share-driver-link',async()=>{try{await navigator.share({title:`Waypoint / ${d.name}`,text:'Location share karne ke liye yeh link kholein.',url:link})}catch(e){if((e as Error).name!=='AbortError')throw e}});
      $('#driver-link-result .muted')!.textContent='Fixed link · no automatic expiry';
      button.textContent='Regenerate link';button.dataset.active='true';icons();
    }catch(e){$('#link-error').textContent=(e as Error).message}finally{button.disabled=false}
  };
  action('#create-driver-link',async()=>{const regenerate=$('#create-driver-link').dataset.active==='true';if(regenerate&&!confirm('Regenerate driver link? The old link and active sharing sessions will stop working.'))return;await showLink(regenerate)});
  action('#revoke-driver-link',async()=>{await api(`/devices/${d.id}/driver-link`,{method:'DELETE'});$('#driver-link-result').innerHTML='';$('#create-driver-link').dataset.active='false';$('#create-driver-link').textContent='Create driver link';$('#link-error').textContent='Driver access disabled. Naya link banakar dobara share kar sakte hain.'});
  void showLink(false,!createNow);
}
function gatewayInfo(){modal('Hardware gateway',`<dl class="setup-facts"><dt>GT06</dt><dd>TCP 5023</dd><dt>FMB920 / Teltonika</dt><dd>TCP 5027</dd><dt>Gateway</dt><dd>${state?.gateway.connected?'Connected':state?.gateway.configured?'Connection unavailable':'Not configured'}</dd><dt>Last sync</dt><dd>${time(state?.gateway.lastSync||null)}</dd></dl><p>Waypoint connects to your Traccar server. Set <code>TRACCAR_URL</code> and <code>TRACCAR_TOKEN</code> in the server environment, then restart the GPS service.</p><p>Use a publicly reachable host for trackers sending through a SIM. Mobile browser tracking requires HTTPS outside localhost.</p><p class="muted">Hardware setup and API examples: GPS-SETUP.md in the project.</p>`)}
function addFence(){const p=current()?.position;modal('Add geofence',`<form id="fence-form"><label>Name<input name="name" required maxlength="100" placeholder="Pune depot"></label><div class="form-grid"><label>Latitude<input type="number" name="latitude" step="any" min="-90" max="90" value="${p?.latitude??18.52}" required></label><label>Longitude<input type="number" name="longitude" step="any" min="-180" max="180" value="${p?.longitude??73.85}" required></label></div><label>Radius (metres)<input name="radius" type="number" min="50" max="100000" value="500" required></label><p class="error" id="form-error" role="alert"></p><button type="submit" class="primary">Save geofence</button></form>`);$('#fence-form').addEventListener('submit',async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.target as HTMLFormElement));try{await api('/fences',{method:'POST',body:JSON.stringify({...v,latitude:Number(v.latitude),longitude:Number(v.longitude),radius:Number(v.radius)})});closeModal();await refresh()}catch(error){$('#form-error').textContent=(error as Error).message}})}

async function mobileSender(){
  active=false;
  const joinCode=new URLSearchParams(location.hash.slice(1)).get('join');
  if(joinCode)window.history.replaceState(null,'',location.pathname+location.search);
  $('#app').innerHTML=`<div class="sender-shell">${brand()}<div class="sender-heading">${i('smartphone')}<h1>Driver location</h1></div><h2 id="sender-vehicle">Link connect ho raha hai...</h2><p id="sender-help">Aapki location fleet admin ko sirf sharing shuru karne ke baad bheji jayegi.</p><p class="error" id="sender-error" role="alert"></p><button class="primary" id="start-sender" disabled>${i('locate-fixed')}Location shuru karein</button><button class="secondary" id="retry-sender" hidden>Dobara connect karein</button><div class="sender-status" id="sender-status" role="status">Location sharing band hai</div><button class="danger" id="stop-sender" hidden>Sharing band karein</button><p>Sharing ke dauran page khula rakhein. Phone lock hone ya browser band hone par updates ruk sakte hain.</p></div>`;icons();
  let watch:number|undefined,timer:ReturnType<typeof setInterval>|undefined,generation=0,sending=false,requesting=false,sharing=false,deviceId='';
  const error=(message:string)=>{$('#sender-error').textContent=message};
  const stop=()=>{generation++;sharing=false;if(watch!==undefined)navigator.geolocation.clearWatch(watch);watch=undefined;if(timer)clearInterval(timer);timer=undefined;$('#sender-status').textContent='Location sharing band hai';$('#stop-sender').hidden=true;$<HTMLButtonElement>('#start-sender').disabled=!deviceId};
  action('#stop-sender',stop);window.addEventListener('pagehide',stop);
  const senderRequest=async<T=any>(path:string,payload:object={})=>{
    try{return await api<T>(path,{method:'POST',body:JSON.stringify({deviceId,...payload})})}
    catch(e){if(/driver link|different vehicle|fleet admin/i.test((e as Error).message)){deviceId='';stop()}throw e}
  };
  const send=async(position:GeolocationPosition,commandId?:string)=>{
    if(!sharing||sending)return;sending=true;const run=generation;
    try{await senderRequest('/sender/position',{eventId:crypto.randomUUID(),recordedAt:new Date(position.timestamp).toISOString(),latitude:position.coords.latitude,longitude:position.coords.longitude,speed:Math.max(0,(position.coords.speed||0)*3.6),heading:position.coords.heading,accuracy:position.coords.accuracy,commandId});if(run===generation){error('');$('#sender-status').textContent=`Location share ho rahi hai · ${new Date().toLocaleTimeString()} · accuracy ${Math.round(position.coords.accuracy)} m`;}}
    catch(e){error((e as Error).message)}finally{sending=false}
  };
  const locationError=(e:GeolocationPositionError)=>{error(e.code===1?'Location permission band hai. Browser settings mein Location Allow karein, phir dobara shuru karein.':e.code===2?'Location nahi mil rahi. Phone ka GPS on karke khuli jagah par try karein.':'GPS ka wait ho raha hai. Dobara koshish karein.');if(e.code===1)stop()};
  const fresh=(commandId?:string)=>{if(requesting||!sharing)return;requesting=true;const run=generation;navigator.geolocation.getCurrentPosition(p=>{requesting=false;if(run===generation)void send(p,commandId)},e=>{requesting=false;if(run===generation)locationError(e)},{enableHighAccuracy:true,timeout:15000,maximumAge:0})};
  action('#start-sender',()=>{
    if(DEMO_MODE){sharing=true;$('#sender-status').textContent='Demo sharing chal rahi hai. Real location use nahi ho rahi.';$<HTMLButtonElement>('#start-sender').disabled=true;$('#stop-sender').hidden=false;return}
    if(!deviceId)return;if(!navigator.geolocation||!isSecureContext){error('Phone par location sharing ke liye HTTPS link chahiye. Admin se naya link lein.');return}
    error('');sharing=true;$<HTMLButtonElement>('#start-sender').disabled=true;const run=++generation;
    $('#stop-sender').hidden=false;$('#sender-status').textContent='Browser mein location Allow karein. GPS ka wait ho raha hai...';
    watch=navigator.geolocation.watchPosition(p=>{if(run===generation)void send(p)},e=>{if(run===generation)locationError(e)},{enableHighAccuracy:true,timeout:15000,maximumAge:5000});
    timer=setInterval(async()=>{if(run!==generation)return;try{const result=await senderRequest<{commands:{id:string}[]}>('/sender/heartbeat');if(run===generation)fresh(result.commands[0]?.id)}catch(e){error((e as Error).message)}},30000);
  });
  const connect=async()=>{
    $('#retry-sender').hidden=true;
    try{const result=joinCode?await api<{device:{id:string;name:string;driver:string}}>('/sender/join',{method:'POST',body:JSON.stringify({code:joinCode})}):await api<{device:{id:string;name:string;driver:string}}>('/sender/me');deviceId=result.device.id;$('#sender-vehicle').textContent=result.device.name+(result.device.driver?' · '+result.device.driver:'');$<HTMLButtonElement>('#start-sender').disabled=false;error('')}
    catch(e){$('#sender-vehicle').textContent='Driver link chahiye';error((e as Error).message);$('#retry-sender').hidden=false}
  };
  action('#retry-sender',connect);await connect();
}
if(new URLSearchParams(location.search).has('sender'))void mobileSender();else void boot();
