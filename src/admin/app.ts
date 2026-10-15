import {$,api,post,brand,chip,closeModal,coords,esc,hm,i,icons,mapsLink,modal,on,showSecret,statusLine,time,ago,toast,whenUnauthorized,wireCopy,type Identity,type Vehicle} from '../shared/core';
import {createMap,point,truckIcon,L} from '../shared/map';
import {placeSpan} from '../shared/places';
import {showLogin} from '../auth';

type View='overview'|'devices'|'device'|'customers'|'admins'|'settings'|'more';
type Gateway={configured:boolean;connected:boolean;lastSync:number|null;error:string|null;trackerHost?:string;gt06Port?:number;gt06AlternativePort?:number;teltonikaPort?:number};
type AdminDevice=Vehicle&{uniqueId:string;model:string;bridgeStatus:string|null;traccarId:number|null;offlineSeconds:number;customerId:string|null;customerName:string|null;createdAt:number};
type Customer={id:string;name:string;email:string;enabled:number|boolean;createdAt:number;devices:number};
type Overview={customers:{total:number;enabled:number};devices:{total:number;moving:number;stopped:number;offline:number;waiting:number;noFix:number;unassigned:number};gateway:Gateway;admins:string[];serverTime:number};

const NAV:[View,string,string][]=[['overview','Overview','house'],['devices','GPS devices','radio-tower'],['customers','Customers','users'],['admins','Admins','shield-check'],['settings','Settings','settings']];
const TABS:[View,string,string][]=[['overview','Overview','house'],['devices','Devices','radio-tower'],['customers','Customers','users'],['more','More','ellipsis']];
const MODELS=['GT06','GT06N','PT06','FMB920','FMB125','FMC920','FMC130','Mobile'];
const protocolOf=(model:string)=>model==='Mobile'?'Phone (driver link)':['GT06','GT06N','PT06'].includes(model)?'GT06':'Teltonika';

let detailId=new URLSearchParams(location.search).get('id')||'',me:Identity,view:View='overview',deviceFilter={q:'',customer:'',status:''},poll:ReturnType<typeof setTimeout>|undefined;
let devices:AdminDevice[]=[],customers:Customer[]=[],gateway:Gateway={configured:false,connected:false,lastSync:null,error:null};

export async function startAdmin(identity:Identity){
  me=identity;
  whenUnauthorized(()=>{clearTimeout(poll);showLogin('Your session ended. Please sign in again.')});
  const requested=new URLSearchParams(location.search).get('view') as View|null;
  view=requested&&([...NAV,...TABS].some(([v])=>v===requested)||(requested==='device'&&detailId))?requested:'overview';
  window.addEventListener('popstate',()=>{const q=new URLSearchParams(location.search);view=(q.get('view') as View)||'overview';detailId=q.get('id')||'';shell()});
  shell();
}
function go(next:View,id=''){const url=new URL(location.href);url.searchParams.set('view',next);if(id)url.searchParams.set('id',id);else url.searchParams.delete('id');history.pushState(null,'',url);view=next;detailId=id;shell()}
function shell(){
  clearTimeout(poll);detailMap?.map.remove();detailMap=undefined;
  $('#app').innerHTML=`<div class="app admin">
    <aside class="sidebar">${brand()}<div class="who"><strong>Admin console</strong><small>${esc(me.email||'Maintenance key session')}</small></div>
      <nav class="nav">${NAV.map(([v,l,ic])=>`<button data-go="${v}" class="${view===v||(v==='devices'&&view==='device')?'on':''}">${i(ic)}${l}</button>`).join('')}</nav>
      <div class="foot"><button class="btn btn-ghost btn-block" data-logout>${i('log-out')}Sign out</button></div></aside>
    <div class="main"><header class="mobile-head">${brand()}<span class="chip plain" style="background:#ffffff22;color:#fff">Admin</span></header>
      <header class="topbar"><div class="title"><h1>${view==='device'?'Device details':(NAV.find(([v])=>v===view)||['','More'])[1]}</h1><small>Waypoint administration</small></div><div class="toolbar">${view==='devices'?`<button class="btn btn-primary" id="add-device">${i('plus')}Add GPS device</button>`:view==='customers'?`<button class="btn btn-primary" id="add-customer">${i('plus')}Add customer</button>`:''}</div></header>
      <div id="view"><div class="page"><p class="muted">Loading…</p></div></div></div>
    <nav class="tabbar">${TABS.map(([v,l,ic])=>`<button data-go="${v}" class="${view===v||(v==='devices'&&view==='device')||(v==='more'&&['admins','settings','more'].includes(view))?'on':''}">${i(ic)}${l}</button>`).join('')}</nav></div>`;
  on('[data-go]',el=>go(el.dataset.go as View));on('[data-logout]',logout);
  on('#add-device',()=>deviceForm());on('#add-customer',customerForm);
  icons();
  void ({overview:renderOverview,devices:renderDevices,device:renderDevice,customers:renderCustomers,admins:renderAdmins,settings:renderSettings,more:renderMore} as Record<View,()=>Promise<void>|void>)[view]();
}
async function logout(){await api('/session',{method:'DELETE'}).catch(()=>{});location.href='/?live=1&auth=admin'}
const fail=(e:unknown)=>{$('#view').innerHTML=`<div class="page"><div class="card empty">${i('triangle-alert')}<h3>Could not load</h3><p>${esc((e as Error).message)}</p></div></div>`;icons()};
const later=(fn:()=>void,ms:number)=>{clearTimeout(poll);poll=setTimeout(fn,ms)};

/* ---------- Overview ---------- */
async function renderOverview(){
  let o:Overview;try{o=await api<Overview>('/admin/overview');({devices,gateway}=await api<{devices:AdminDevice[];gateway:Gateway}>('/admin/devices'))}catch(e){fail(e);return}
  if(view!=='overview')return;
  const g=o.gateway,problems=devices.filter(d=>['Offline','Waiting','No GPS fix'].includes(d.status)||!d.customerId);
  const kpi=(label:string,value:number,color='')=>`<div class="card kpi"><span>${label}</span><strong ${color?`style="color:var(--${color})"`:''}>${value}</strong></div>`;
  $('#view').innerHTML=`<div class="page">
    <div class="grid-kpi">${kpi('Customers',o.customers.total)}${kpi('GPS devices',o.devices.total)}${kpi('Running',o.devices.moving,'running')}${kpi('Stopped',o.devices.stopped,'stopped')}${kpi('Offline',o.devices.offline,'offline')}${kpi('Not installed',o.devices.waiting,'nofix')}${kpi('Unassigned',o.devices.unassigned,'idle')}</div>
    <div class="card card-pad"><div class="section-title"><h2>Server health</h2><span class="chip ${g.connected?'ok':'bad'}">${g.connected?'GPS receiver connected':g.configured?'GPS receiver not syncing':'Not configured'}</span></div>
      <dl class="facts"><dt>Last sync</dt><dd>${time(g.lastSync)} (${ago(g.lastSync)})</dd><dt>Tracker server</dt><dd class="mono">${esc(g.trackerHost||'—')}</dd><dt>GT06 / PT06 port</dt><dd class="mono">TCP ${g.gt06Port??5023}${g.gt06AlternativePort?` · alt ${g.gt06AlternativePort}`:''}</dd><dt>Teltonika port</dt><dd class="mono">TCP ${g.teltonikaPort??5027}</dd>${g.error?`<dt>Last error</dt><dd style="color:var(--stopped)">${esc(g.error)}</dd>`:''}<dt>Admins</dt><dd>${o.admins.map(esc).join(', ')||'—'}</dd></dl></div>
    <div class="card"><div class="card-pad section-title" style="margin:0"><h2>Needs attention</h2><button class="btn btn-ghost btn-sm" data-go="devices">All devices${i('chevron-right')}</button></div>
      ${problems.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Vehicle</th><th>Customer</th><th>Status</th><th>Last signal</th><th></th></tr></thead><tbody>${problems.slice(0,12).map(d=>`<tr><td><b>${esc(d.name)}</b><small class="mono">${esc(d.uniqueId)}</small></td><td>${d.customerName?esc(d.customerName):'<span class="chip idle plain">Unassigned</span>'}</td><td>${chip(d)}</td><td>${ago(d.lastSeen)}</td><td><div class="actions"><button class="btn btn-ghost btn-sm" data-detail="${d.id}">${i('eye')}Details</button><button class="btn btn-ghost btn-sm" data-edit="${d.id}">${i('pencil')}Edit</button></div></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty">${i('check')}<h3>Everything looks fine</h3></div>`}</div></div>`;
  on('#view [data-go]',el=>go(el.dataset.go as View));on('[data-edit]',el=>deviceForm(devices.find(d=>d.id===el.dataset.edit)));on('[data-detail]',el=>go('device',el.dataset.detail));icons();
  later(()=>{if(view==='overview')void renderOverview()},15000);
}

/* ---------- Devices ---------- */
async function renderDevices(){
  try{[{devices,gateway},{customers}]=await Promise.all([api<{devices:AdminDevice[];gateway:Gateway}>('/admin/devices'),api<{customers:Customer[]}>('/customers')])}catch(e){fail(e);return}
  if(view!=='devices')return;
  const host=$('#view'),focused=document.activeElement?.id==='dq';
  const list=devices.filter(d=>(!deviceFilter.customer||(deviceFilter.customer==='none'?!d.customerId:d.customerId===deviceFilter.customer))&&(!deviceFilter.status||d.status===deviceFilter.status)&&`${d.name} ${d.uniqueId} ${d.driver} ${d.customerName||''}`.toLowerCase().includes(deviceFilter.q.toLowerCase()));
  host.innerHTML=`<div class="page">
    <div class="toolbar"><label class="search">${i('search')}<input class="input" id="dq" placeholder="Search vehicle, IMEI, driver or customer" value="${esc(deviceFilter.q)}"></label>
      <select class="input" id="dc" style="max-width:220px"><option value="">All customers</option><option value="none" ${deviceFilter.customer==='none'?'selected':''}>Unassigned</option>${customers.map(c=>`<option value="${c.id}" ${deviceFilter.customer===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select>
      <select class="input" id="ds" style="max-width:180px"><option value="">Any status</option>${['Moving','Stopped','Offline','Waiting','No GPS fix'].map(s=>`<option ${deviceFilter.status===s?'selected':''}>${s}</option>`).join('')}</select>
      <button class="btn btn-primary show-sm" id="add-device-sm">${i('plus')}Add</button></div>
    <div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Vehicle</th><th>Customer</th><th>Tracker</th><th>Status</th><th>Last signal</th><th></th></tr></thead><tbody>
      ${list.map(d=>`<tr><td class="nowrap"><a href="?live=1&view=device&id=${d.id}" data-detail="${d.id}"><b>${esc(d.name)}</b></a><small>${esc(d.driver||'—')}</small></td><td>${d.customerName?esc(d.customerName):'<span class="chip idle plain">Unassigned</span>'}</td><td class="nowrap"><span class="mono">${esc(d.uniqueId)}</span><small>${esc(d.model)} · ${esc(d.model==='Mobile'?'driver link':d.bridgeStatus||'awaiting sync')}</small></td><td>${chip(d)}</td><td class="nowrap" title="Last packet ${esc(time(d.lastSeen))}">${ago(d.lastSeen)}<small>GPS fix ${d.position?ago(d.position.recordedAt):'never'}${d.position?.valid===0?' (no satellites)':''}</small></td>
        <td><div class="actions nowrap"><button class="btn btn-primary btn-sm" data-detail="${d.id}">${i('eye')}Details</button><button class="btn btn-blue btn-sm btn-icon" data-locate="${d.id}" ${d.position?'':'disabled'} title="Current location" aria-label="Location of ${esc(d.name)}">${i('map-pin')}</button><button class="btn btn-ghost btn-sm btn-icon" data-edit="${d.id}" title="Edit / assign customer" aria-label="Edit ${esc(d.name)}">${i('pencil')}</button><button class="btn btn-ghost btn-sm btn-icon" data-info="${d.id}" title="Tracker setup" aria-label="Setup ${esc(d.name)}">${i('info')}</button><button class="btn btn-danger btn-sm btn-icon" data-delete="${d.id}" title="Delete" aria-label="Delete ${esc(d.name)}">${i('trash-2')}</button></div></td></tr>`).join('')||`<tr><td colspan="6"><div class="empty">${i('radio-tower')}<h3>No devices</h3><p>Add a GPS device and assign it to a customer.</p></div></td></tr>`}
    </tbody></table></div></div></div>`;
  const q=$<HTMLInputElement>('#dq');q.oninput=()=>{deviceFilter.q=q.value;void renderDevices()};
  if(focused){q.focus();q.setSelectionRange(q.value.length,q.value.length)}
  $<HTMLSelectElement>('#dc').onchange=e=>{deviceFilter.customer=(e.target as HTMLSelectElement).value;void renderDevices()};
  $<HTMLSelectElement>('#ds').onchange=e=>{deviceFilter.status=(e.target as HTMLSelectElement).value;void renderDevices()};
  const find=(el:HTMLElement,key:string)=>devices.find(d=>d.id===el.dataset[key])!;
  on('#add-device-sm',()=>deviceForm());
  host.querySelectorAll<HTMLAnchorElement>('a[data-detail]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();go('device',a.dataset.detail)}));
  on('button[data-detail]',el=>go('device',el.dataset.detail),host);
  on('[data-locate]',el=>locate(find(el,'locate')),host);on('[data-edit]',el=>deviceForm(find(el,'edit')),host);on('[data-info]',el=>setupInfo(find(el,'info')),host);
  on('[data-delete]',async el=>{const d=find(el,'delete');if(prompt(`Delete ${d.name}? This removes its whole location history and alerts.\nType the IMEI/identifier to confirm: ${d.uniqueId}`)!==d.uniqueId)return;await api(`/admin/devices/${d.id}`,{method:'DELETE'});toast('Device deleted.');void renderDevices()},host);
  icons();
  later(()=>{if(view==='devices'&&!document.querySelector('dialog.modal[open]')&&document.activeElement?.id!=='dq')void renderDevices()},20000);
}
function deviceForm(d?:AdminDevice){
  const editing=!!d;
  modal(editing?`Edit ${d!.name}`:'Add GPS device',`<form class="form" id="device-form">
    <label class="field">Vehicle number / name<input class="input" name="name" required maxlength="100" placeholder="MH 12 AB 1234" value="${esc(d?.name||'')}"></label>
    <label class="field">Customer<select class="input" name="customerId"><option value="">Unassigned</option>${customers.map(c=>`<option value="${c.id}" ${d?.customerId===c.id?'selected':''}>${esc(c.name)} · ${esc(c.email)}</option>`).join('')}</select></label>
    ${editing?`<dl class="facts"><dt>Tracker</dt><dd>${esc(d!.model)} · <span class="mono">${esc(d!.uniqueId)}</span></dd></dl>`:`<div class="form-row"><label class="field">Tracker model<select class="input" name="model" id="model">${MODELS.map(m=>`<option>${m}</option>`).join('')}</select></label><label class="field" id="imei-field">IMEI (15 digits)<input class="input mono" name="uniqueId" inputmode="numeric" maxlength="15" pattern="\\d{15}" required autocomplete="off"></label></div>`}
    <label class="field">Driver (optional)<input class="input" name="driver" maxlength="100" value="${esc(d?.driver||'')}"></label>
    <div class="form-row"><label class="field">Speed limit (km/h)<input class="input" type="number" name="speedLimit" min="1" max="250" value="${d?.speedLimit??80}" required></label><label class="field">Offline after (seconds)<input class="input" type="number" name="offlineSeconds" min="30" max="86400" value="${d?.offlineSeconds??600}" required></label></div>
    ${editing&&d!.customerId?'<p class="hint">Moving a vehicle to another customer disables its driver link and geofence state.</p>':''}
    <p class="error" id="device-error"></p><button class="btn btn-primary" type="submit">${editing?'Save changes':'Add device'}</button></form>`);
  const form=$<HTMLFormElement>('#device-form');
  document.querySelector<HTMLSelectElement>('#model')?.addEventListener('change',e=>{const mobile=(e.target as HTMLSelectElement).value==='Mobile';$('#imei-field').hidden=mobile;$<HTMLInputElement>('#imei-field input').required=!mobile});
  form.addEventListener('submit',async e=>{
    e.preventDefault();const v=Object.fromEntries(new FormData(form)) as Record<string,string>;const button=form.querySelector<HTMLButtonElement>('button[type=submit]')!;button.disabled=true;
    try{
      const body={name:v.name,driver:v.driver,customerId:v.customerId||null,speedLimit:Number(v.speedLimit),offlineSeconds:Number(v.offlineSeconds)};
      if(editing)await api(`/admin/devices/${d!.id}`,{method:'PATCH',body:JSON.stringify(body)});
      else{const r=await post<{device:AdminDevice}>('/admin/devices',{...body,model:v.model,uniqueId:v.model==='Mobile'?undefined:v.uniqueId});closeModal();toast('Device added.');if(view==='devices')await renderDevices();setupInfo({...r.device,customerId:body.customerId,customerName:customers.find(c=>c.id===body.customerId)?.name||null});return}
      closeModal();toast('Saved.');if(view==='devices')void renderDevices();else if(view==='overview')void renderOverview();else if(view==='device')void renderDevice();
    }catch(err){$('#device-error').textContent=(err as Error).message;button.disabled=false}
  });
}
function setupInfo(d:AdminDevice){
  const gt06=['GT06','GT06N','PT06'].includes(d.model);
  modal(`${d.name} · Setup`,d.model==='Mobile'
    ?`<p>This vehicle reports from the driver's phone. The customer shares the driver link from their app (vehicle card → Driver link).</p>`
    :`<dl class="facts"><dt>IMEI</dt><dd class="mono">${esc(d.uniqueId)}</dd><dt>Protocol</dt><dd>${protocolOf(d.model)}</dd><dt>Server IP</dt><dd class="mono">${esc(gateway.trackerHost||'—')}</dd><dt>Port</dt><dd class="mono">TCP ${gt06?(gateway.gt06Port??5023):(gateway.teltonikaPort??5027)}${gt06&&gateway.gt06AlternativePort?` (alternative ${gateway.gt06AlternativePort})`:''}</dd><dt>Receiver</dt><dd>${d.traccarId?'Linked':'Waiting for first sync'} · ${esc(d.bridgeStatus||'—')}</dd><dt>Last packet</dt><dd>${time(d.lastSeen)}</dd><dt>Last GPS fix</dt><dd>${d.position?time(d.position.recordedAt):'Never'}</dd></dl>
      ${gt06?`<div class="card card-pad" style="background:var(--soft)"><h3>SMS to the tracker SIM</h3><p class="small muted" style="margin:6px 0 10px">Syntax varies by maker; check the manual.</p><p class="mono">SERVER,1,${esc(gateway.trackerHost||'IP')},${gateway.gt06Port??5023},0#</p><p class="mono">APN,airtelgprs.com#  (personal Airtel)</p><p class="mono">APN,airteliot.com#  (Airtel IoT)</p><p class="mono">RESET#   then   STATUS#</p><p class="small muted" style="margin-top:8px">STATUS# should show GPRS: Link Up and GPS: FIXED.</p></div>`:''}
      <button class="btn btn-ghost" id="relay">${i('shield-check')}Starter relay</button>`);
  on('#relay',()=>relayDialog(d));
}
function locate(d:AdminDevice){
  const p=d.position!;
  modal(`${d.name} · Current location`,`<div style="height:320px;border-radius:14px;overflow:hidden;position:relative"><div class="map" id="locate-map"></div></div>
    <div><div style="display:flex;gap:8px;font-weight:600">${i('map-pin')}${placeSpan(p,'admin-'+d.id)}</div><p class="small muted" style="margin-top:4px">${esc(statusLine(d))} · ${esc(coords(p))} · ${ago(p.recordedAt)}</p></div>
    <div class="toolbar"><a class="btn btn-blue" href="${mapsLink(p)}" target="_blank" rel="noopener">${i('external-link')}Open in Google Maps</a></div>`,{wide:true});
  requestAnimationFrame(()=>{const m=createMap($('#locate-map'),point(p),16);L.marker(point(p),{icon:truckIcon(d,true)}).addTo(m);const dialog=document.querySelector('dialog.modal')!;dialog.addEventListener('close',()=>m.remove(),{once:true});icons()});
}

/* ---------- Device details ---------- */
type Packet={id:number;recordedAt:number;receivedAt:number;latitude:number;longitude:number;speed:number;heading:number|null;ignition:number|null;battery:number|null;satellites:number|null;valid:number};
type Detail={device:AdminDevice;packets:Packet[];alerts:{id:string;type:string;message:string;createdAt:number;acknowledged:number}[];today:{distanceKm:number;runningMinutes:number;idleMinutes:number;maxSpeed:number;gaps:{from:number;to:number;minutes:number;movedKm:number|null}[]}|null;gateway:Gateway};
let detailMap:{map:ReturnType<typeof createMap>;marker:ReturnType<typeof L.marker>}|undefined;
// Heartbeats are stored as copies of the last fix: a row repeating an earlier row's GPS time and place,
// or arriving long after its GPS time, is a heartbeat rather than a new location.
function packetKinds(packets:Packet[]){
  const seen=new Set<string>(),kinds=new Map<number,[string,string]>();
  for(const p of [...packets].sort((a,b)=>a.receivedAt-b.receivedAt||a.id-b.id)){
    const key=`${p.recordedAt}|${p.latitude}|${p.longitude}`;
    kinds.set(p.id,p.valid===0?['No GPS fix','nofix']:seen.has(key)||p.receivedAt-p.recordedAt>90000?['Heartbeat','neutral']:['Location','ok']);
    seen.add(key);
  }
  return kinds;
}
const hhmmss=(at:number)=>new Date(at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
async function renderDevice(){
  let data:Detail;
  try{data=await api<Detail>(`/admin/devices/${detailId}?tz=${new Date().getTimezoneOffset()}`)}catch(e){fail(e);return}
  if(view!=='device')return;
  const d=data.device,p=d.position,g=data.gateway;gateway=g;
  const first=!document.querySelector('#device-page');
  if(first){
    detailMap?.map.remove();detailMap=undefined;
    $('#view').innerHTML=`<div class="page" id="device-page"><div class="toolbar"><button class="btn btn-ghost btn-sm" data-go="devices">${i('chevron-left')}All devices</button></div><div id="dp-head"></div><div class="grid-kpi" id="dp-kpi"></div>
      <div style="display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:14px" class="dp-cols"><div class="card"><div style="height:300px;border-radius:16px 16px 0 0;overflow:hidden;position:relative"><div class="map" id="dp-map"></div></div><div class="card-pad" id="dp-place"></div></div><div class="card card-pad" id="dp-today"></div></div>
      <div class="card card-pad" id="dp-tracker"></div><div class="card" id="dp-packets"></div><div class="card" id="dp-alerts"></div></div>`;
    on('#view [data-go]',el=>go(el.dataset.go as View));
  }
  const kinds=packetKinds(data.packets),kind=data.packets[0]?kinds.get(data.packets[0].id)!:['—',''];
  // Heartbeats carry no satellite count; show the latest packet that reported each value.
  const latest=<K extends keyof Packet>(key:K)=>data.packets.find(x=>x[key]!=null)?.[key]??null;
  const battery=latest('battery'),sats=latest('satellites');
  $('#dp-head').innerHTML=`<div class="card card-pad" style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center"><div><div style="display:flex;gap:10px;align-items:center"><h1>${esc(d.name)}</h1>${chip(d)}</div><p class="muted" style="margin-top:4px">${d.customerName?esc(d.customerName):'Unassigned'}${d.driver?` · Driver ${esc(d.driver)}`:''} · <span class="mono">${esc(d.uniqueId)}</span></p><p class="small" style="margin-top:4px">${esc(statusLine(d))}</p></div>
    <div class="actions"><button class="btn btn-ghost btn-sm" id="dp-edit">${i('pencil')}Edit / assign</button><button class="btn btn-ghost btn-sm" id="dp-setup">${i('info')}Setup</button><button class="btn btn-danger btn-sm" id="dp-delete">${i('trash-2')}Delete</button></div></div>`;
  const k=(label:string,value:string,sub='')=>`<div class="card kpi"><span>${label}</span><strong style="font-size:20px">${value}</strong>${sub?`<small class="muted small">${sub}</small>`:''}</div>`;
  $('#dp-kpi').innerHTML=k('Last heartbeat',ago(d.lastSeen),time(d.lastSeen))+k('Last GPS fix',p?ago(p.recordedAt):'Never',p?(p.valid===0?'no satellite fix':time(p.recordedAt)):'')+k('Speed',p?`${Math.round(p.speed)} km/h`:'—',p?.heading!=null?`heading ${Math.round(p.heading)}°`:'')+k('Ignition',d.ignition==null?'—':d.ignition?'On':'Off')+k('Battery',battery!=null?`${Math.round(Number(battery))}%`:'—')+k('Satellites',sats!=null?String(sats):'—',`last packet: ${kind[0]}`);
  $('#dp-place').innerHTML=p?`<div style="display:flex;gap:8px;font-weight:600">${i('map-pin')}${placeSpan(p,'detail-'+d.id)}</div><p class="small muted" style="margin-top:4px">${esc(coords(p))}</p><a class="btn btn-blue btn-sm" style="margin-top:10px" href="${mapsLink(p)}" target="_blank" rel="noopener">${i('external-link')}Open in Google Maps</a>`:'<p class="muted">No location received yet.</p>';
  const t=data.today;
  $('#dp-today').innerHTML=`<h2>Today</h2>${t?`<div class="summary" style="margin-top:12px"><div><span>Distance</span><b>${t.distanceKm} km</b></div><div><span>Running</span><b>${hm(t.runningMinutes)}</b></div><div><span>Idle</span><b>${hm(t.idleMinutes)}</b></div><div><span>Max speed</span><b>${t.maxSpeed} km/h</b></div></div>${t.gaps.map(x=>`<p class="gap-note" style="margin-top:10px">${i('triangle-alert')}No data ${esc(clockOf(x.from))} – ${esc(clockOf(x.to))} (${x.minutes} min)${x.movedKm?` · moved ${x.movedKm} km`:''}</p>`).join('')}`:'<p class="muted" style="margin-top:8px">Nothing recorded today.</p>'}`;
  const gt06=['GT06','GT06N','PT06'].includes(d.model);
  $('#dp-tracker').innerHTML=`<h2>Tracker</h2><dl class="facts" style="margin-top:12px"><dt>Model / protocol</dt><dd>${esc(d.model)} · ${protocolOf(d.model)}</dd><dt>IMEI</dt><dd class="mono">${esc(d.uniqueId)}</dd><dt>Receiver</dt><dd>${d.traccarId?`Linked (#${d.traccarId})`:'Not yet linked'} · ${esc(d.bridgeStatus||'—')}</dd>${d.model==='Mobile'?'':`<dt>Server</dt><dd class="mono">${esc(g.trackerHost||'—')} : ${gt06?(g.gt06Port??5023):(g.teltonikaPort??5027)}</dd>`}<dt>Speed limit</dt><dd>${d.speedLimit} km/h</dd><dt>Offline after</dt><dd>${Math.round(d.offlineSeconds/60)} min without a packet</dd><dt>Registered</dt><dd>${time(d.createdAt)}</dd></dl>`;
  $('#dp-packets').innerHTML=`<div class="card-pad section-title" style="margin:0"><h2>Last ${data.packets.length} packets</h2><span class="small muted">Newest first · refreshes every 10 s</span></div>${data.packets.length?`<div class="table-wrap" style="max-height:460px"><table class="table"><thead><tr><th>Received</th><th>GPS time</th><th>Type</th><th>Speed</th><th>Ignition</th><th>Sats</th><th>Battery</th><th>Position</th></tr></thead><tbody>${data.packets.map(x=>{const [label,cls]=kinds.get(x.id)!;return `<tr><td class="nowrap">${hhmmss(x.receivedAt)}<small>${new Date(x.receivedAt).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})}</small></td><td class="nowrap">${hhmmss(x.recordedAt)}</td><td><span class="chip ${cls} plain">${label}</span></td><td>${Math.round(x.speed)} km/h</td><td>${x.ignition==null?'—':x.ignition?'On':'Off'}</td><td>${x.satellites??'—'}</td><td>${x.battery!=null?Math.round(x.battery)+'%':'—'}</td><td class="mono">${x.latitude.toFixed(5)}, ${x.longitude.toFixed(5)}</td></tr>`}).join('')}</tbody></table></div>`:'<div class="empty"><p>No packets stored yet.</p></div>'}`;
  $('#dp-alerts').innerHTML=`<div class="card-pad section-title" style="margin:0"><h2>Recent alerts</h2></div>${data.alerts.length?data.alerts.map(a=>`<div class="alert-item ${a.acknowledged?'done':''}"><div class="body"><b>${esc(a.type)}</b><p>${esc(a.message)}</p><span class="small muted">${time(a.createdAt)}</span></div></div>`).join(''):'<div class="empty"><p>No alerts.</p></div>'}`;
  if(p){
    if(!detailMap){const map=createMap($('#dp-map'),point(p),16);detailMap={map,marker:L.marker(point(p),{icon:truckIcon(d,true)}).addTo(map)}}
    else{detailMap.marker.setLatLng(point(p)).setIcon(truckIcon(d,true))}
  }
  on('#dp-edit',()=>{customers.length?deviceForm(d):void api<{customers:Customer[]}>('/customers').then(r=>{customers=r.customers;deviceForm(d)})});
  on('#dp-setup',()=>setupInfo(d));
  on('#dp-delete',async()=>{if(prompt(`Delete ${d.name}? This removes its whole location history and alerts.\nType the IMEI/identifier to confirm: ${d.uniqueId}`)!==d.uniqueId)return;await api(`/admin/devices/${d.id}`,{method:'DELETE'});toast('Device deleted.');go('devices')});
  icons();
  later(()=>{if(view==='device'&&!document.querySelector('dialog.modal[open]'))void renderDevice()},10000);
}
const clockOf=(at:number)=>new Date(at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});

/* ---------- Customers ---------- */
async function renderCustomers(){
  try{({customers}=await api<{customers:Customer[]}>('/customers'))}catch(e){fail(e);return}
  if(view!=='customers')return;
  const host=$('#view');
  host.innerHTML=`<div class="page"><div class="toolbar show-sm"><button class="btn btn-primary" id="add-customer-sm">${i('plus')}Add customer</button></div><div id="cred"></div>
    <div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Customer</th><th>Vehicles</th><th>Access</th><th>Since</th><th></th></tr></thead><tbody>
    ${customers.map(c=>`<tr><td><b>${esc(c.name)}</b><small>${esc(c.email)}</small></td><td><button class="btn btn-ghost btn-sm" data-fleet="${c.id}">${i('truck')}${c.devices}</button></td><td><span class="chip ${c.enabled?'ok':'bad'}">${c.enabled?'Active':'Disabled'}</span></td><td>${time(c.createdAt)}</td>
      <td><div class="actions"><button class="btn btn-ghost btn-sm" data-reset="${c.id}">${i('key-round')}Reset password</button><button class="btn ${c.enabled?'btn-danger':'btn-ghost'} btn-sm" data-access="${c.id}">${i('power')}${c.enabled?'Disable':'Enable'}</button></div></td></tr>`).join('')||`<tr><td colspan="5"><div class="empty">${i('users')}<h3>No customers yet</h3></div></td></tr>`}
    </tbody></table></div></div></div>`;
  on('#add-customer-sm',customerForm);
  on('[data-fleet]',el=>{deviceFilter={q:'',customer:el.dataset.fleet!,status:''};go('devices')},host);
  on('[data-reset]',async el=>{const c=customers.find(x=>x.id===el.dataset.reset)!;if(!confirm(`Reset password for ${c.name}? They will be signed out.`))return;const r=await post<{password:string}>(`/customers/${c.id}/reset`);$('#cred').innerHTML=`<div class="card card-pad">${showSecret(c.email,r.password)}</div>`;wireCopy($('#cred'));icons()},host);
  on('[data-access]',async el=>{const c=customers.find(x=>x.id===el.dataset.access)!;if(!confirm(`${c.enabled?'Disable':'Enable'} ${c.name}?`))return;await api(`/customers/${c.id}/access`,{method:'PUT',body:JSON.stringify({enabled:!c.enabled})});void renderCustomers()},host);
  icons();
}
function customerForm(){
  modal('Add customer',`<form class="form" id="customer-form"><label class="field">Customer / business name<input class="input" name="name" required maxlength="100"></label><label class="field">Login email<input class="input" type="email" name="email" required maxlength="254"></label><p class="hint">A one-time password is generated. Share it with the customer privately.</p><p class="error" id="customer-error"></p><button class="btn btn-primary" type="submit">Create customer</button></form>`);
  $('#customer-form').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target as HTMLFormElement);try{const r=await post<{customer:Customer;password:string}>('/customers',{name:f.get('name'),email:f.get('email')});const dialog=modal('Customer created',`${showSecret(r.customer.email,r.password)}<p class="small">Customer login page: <b>${esc(location.origin)}/?live=1</b></p>`);wireCopy(dialog);if(view==='customers')void renderCustomers()}catch(err){$('#customer-error').textContent=(err as Error).message}});
}

/* ---------- Admins, settings, more ---------- */
async function renderAdmins(){
  let admins:{email:string;createdAt:number;enabled:number}[];try{({admins}=await api('/admin/admins'))}catch(e){fail(e);return}
  if(view!=='admins')return;
  $('#view').innerHTML=`<div class="page" style="max-width:820px"><form class="card card-pad form" id="admin-form"><h2>Add admin</h2><div class="toolbar"><input class="input" type="email" name="email" required placeholder="admin@company.com" style="flex:1;min-width:220px"><button class="btn btn-primary" type="submit">${i('plus')}Create admin</button></div><p class="error" id="admin-error"></p><div id="admin-cred"></div></form>
    <div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Admin email</th><th>Status</th><th>Since</th></tr></thead><tbody>${admins.map(a=>`<tr><td><b>${esc(a.email)}</b>${a.email===me.email?' <span class="chip neutral plain">You</span>':''}</td><td><span class="chip ${a.enabled?'ok':'bad'}">${a.enabled?'Active':'Disabled'}</span></td><td>${time(a.createdAt)}</td></tr>`).join('')}</tbody></table></div></div></div>`;
  $('#admin-form').addEventListener('submit',async e=>{e.preventDefault();const form=e.target as HTMLFormElement;try{const r=await post<{email:string;password:string}>('/admin/admins',{email:new FormData(form).get('email')});$('#admin-cred').innerHTML=showSecret(r.email,r.password,'Ask them to change it in Settings after the first sign in.');wireCopy($('#admin-cred'));form.reset();icons()}catch(err){$('#admin-error').textContent=(err as Error).message}});
  icons();
}
function renderSettings(){
  $('#view').innerHTML=`<div class="page" style="max-width:640px">${me.email?`<form class="card card-pad form" id="password"><h2>Change password</h2><p class="hint">Signed in as ${esc(me.email)}.</p>
      <label class="field">Current password<input class="input" type="password" name="currentPassword" required autocomplete="current-password"></label>
      <label class="field">New password<input class="input" type="password" name="newPassword" required minlength="12" maxlength="128" autocomplete="new-password"></label>
      <label class="field">Confirm new password<input class="input" type="password" name="confirmPassword" required minlength="12" maxlength="128" autocomplete="new-password"></label>
      <p class="error" id="password-error"></p><button class="btn btn-primary" type="submit" style="align-self:flex-start">${i('key-round')}Change password</button></form>`
    :`<div class="card card-pad"><h2>Change password</h2><p class="muted" style="margin-top:6px">You signed in with the maintenance key, which has no password. Sign in with an admin email to change its password.</p></div>`}
    <button class="btn btn-ghost" data-logout style="align-self:flex-start">${i('log-out')}Sign out</button></div>`;
  document.querySelector('#password')?.addEventListener('submit',async e=>{e.preventDefault();const form=e.target as HTMLFormElement,f=new FormData(form);$('#password-error').textContent='';try{if(f.get('newPassword')!==f.get('confirmPassword'))throw Error('New passwords do not match.');await post('/account/password',{currentPassword:f.get('currentPassword'),newPassword:f.get('newPassword')});form.reset();toast('Password changed.')}catch(err){$('#password-error').textContent=(err as Error).message}});
  on('#view [data-logout]',logout);icons();
}
function renderMore(){
  $('#view').innerHTML=`<div class="page"><div class="card more-list">${[['admins','Admins','shield-check'],['settings','Settings','settings']].map(([v,l,ic])=>`<button data-go="${v}"><span class="ico">${i(ic)}</span>${l}${i('chevron-right')}</button>`).join('')}<button data-logout><span class="ico" style="background:var(--stopped-50);color:var(--stopped)">${i('log-out')}</span>Sign out${i('chevron-right')}</button></div></div>`;
  on('#view [data-go]',el=>go(el.dataset.go as View));on('#view [data-logout]',logout);icons();
}

/* ---------- Starter relay (kept from the earlier console, admin only) ---------- */
type RelayStatus={enabled:boolean;supported:boolean;error:string|null;installation:{installer:string;verifiedAt:number}|null;history:{action:string;status:string;detail:string;createdAt:number}[]};
async function relayDialog(d:AdminDevice){
  const status=await api<RelayStatus>(`/devices/${d.id}/relay`);
  const ready=status.enabled&&status.supported&&!!status.installation;
  const keyLabel=me.email?'Your admin password':'Maintenance key';
  modal(`${d.name} · Starter relay`,`<p class="error">Starter-inhibit only. Fuel/ignition cut-off is not supported. Physical relay state is not verified.</p>
    ${!status.enabled?'<p class="muted">Relay commands are disabled on this server.</p>':''}${status.error?`<p class="error">${esc(status.error)}</p>`:''}
    <dl class="facts"><dt>Gateway support</dt><dd>${status.supported?'Supported':'Not available'}</dd><dt>Installation</dt><dd>${status.installation?`${esc(status.installation.installer)} · ${time(status.installation.verifiedAt)}`:'Not verified'}</dd></dl>
    <form class="form" id="relay-command"><label class="field">Action<select class="input" name="action"><option value="inhibit">Block next engine start</option><option value="restore">Allow engine start</option></select></label>
      <label class="field">Type the IMEI to confirm<input class="input mono" name="confirmation" required autocomplete="off" placeholder="${esc(d.uniqueId)}"></label><label class="field">Reason<input class="input" name="reason" required maxlength="300"></label>
      <label class="field">${keyLabel}<input class="input" name="adminKey" type="password" required autocomplete="off"></label><button class="btn btn-danger" type="submit" ${ready?'':'disabled'}>Send relay command</button><p id="relay-result" class="small"></p></form>
    <details><summary>Installer verification</summary><form class="form" id="relay-install" style="margin-top:10px"><label class="field">Installer / reference<input class="input" name="installer" required maxlength="200" value="${esc(status.installation?.installer||'')}"></label>
      <label class="check"><input type="checkbox" name="starterOnly" required>Starter circuit only</label><label class="check"><input type="checkbox" name="polarityVerified" required>Command polarity verified</label>
      <label class="field">${keyLabel}<input class="input" name="adminKey" type="password" required autocomplete="off"></label><button class="btn btn-ghost" type="submit">Save verification</button><p class="error" id="relay-install-error"></p></form></details>
    <h3>Recent commands</h3>${status.history.map(c=>`<p class="small"><b>${esc(c.action)} · ${esc(c.status)}</b> · ${time(c.createdAt)}<br>${esc(c.detail)}</p>`).join('')||'<p class="muted small">None.</p>'}`,{wide:true});
  const requestId=crypto.randomUUID();
  $('#relay-command').addEventListener('submit',async e=>{e.preventDefault();const form=e.target as HTMLFormElement;try{const r=await post<{status:string;detail:string}>(`/devices/${d.id}/relay`,{...Object.fromEntries(new FormData(form)),requestId});$('#relay-result').textContent=`${r.status}: ${r.detail}`}catch(err){$('#relay-result').textContent=(err as Error).message}finally{form.querySelector<HTMLInputElement>('[name=adminKey]')!.value=''}});
  $('#relay-install').addEventListener('submit',async e=>{e.preventDefault();const form=e.target as HTMLFormElement,f=new FormData(form);try{await api(`/devices/${d.id}/relay`,{method:'PUT',body:JSON.stringify({installer:f.get('installer'),adminKey:f.get('adminKey'),starterOnly:f.has('starterOnly'),polarityVerified:f.has('polarityVerified')})});await relayDialog(d)}catch(err){$('#relay-install-error').textContent=(err as Error).message;form.querySelector<HTMLInputElement>('[name=adminKey]')!.value=''}});
}
