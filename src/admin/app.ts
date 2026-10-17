import {$,$$,api,post,brand,chip,closeModal,coords,esc,hm,i,icons,mapsLink,modal,on,showSecret,statusLine,time,ago,toast,whenUnauthorized,wireCopy,type Identity,type Vehicle} from '../shared/core';
import {createMap,point,truckIcon,L} from '../shared/map';
import {placeSpan} from '../shared/places';
import {googleLive} from '../shared/gview';
import {setLang} from '../shared/i18n';
import '../customer/customer.css';
import './admin.css';
import {showLogin} from '../auth';

type View='requests'|'overview'|'devices'|'device'|'customers'|'admins'|'settings'|'more';
type Gateway={configured:boolean;connected:boolean;lastSync:number|null;error:string|null;trackerHost?:string;gt06Port?:number;gt06AlternativePort?:number;teltonikaPort?:number};
type Step={id:string;seq:number;command:string;label:string;status:'pending'|'sent'|'ok'|'failed';attempts:number;reply:string|null;sentAt:number|null;doneAt:number|null};
type Provisioning={steps:Step[];sms:{label:string;text:string}[];operators?:Record<string,{label:string;apn:Record<string,string>}>};
const OPERATORS:Record<string,{label:string;apn:Record<string,string>}>={airtel:{label:'Airtel',apn:{personal:'airtelgprs.com'}},jio:{label:'Jio',apn:{personal:'jionet'}},bsnl:{label:'BSNL',apn:{personal:'bsnlnet'}},vi:{label:'Vi (Vodafone Idea)',apn:{}},other:{label:'Other',apn:{}}};
type AdminDevice=Vehicle&{simOperator?:string|null;simType?:string|null;simNumber?:string|null;apn?:string|null;apnUser?:string|null;uniqueId:string;model:string;bridgeStatus:string|null;traccarId:number|null;offlineSeconds:number;customerId:string|null;customerName:string|null;createdAt:number};
type Customer={id:string;name:string;email:string;enabled:number|boolean;createdAt:number;devices:number};
type Overview={customers:{total:number;enabled:number};devices:{total:number;moving:number;stopped:number;offline:number;waiting:number;noFix:number;unassigned:number};gateway:Gateway;admins:string[];serverTime:number};

const NAV:[View,string,string][]=[['overview','Overview','house'],['devices','GPS devices','radio-tower'],['customers','Customers','users'],['admins','Admins','shield-check'],['settings','Settings','settings']];
const TABS:[View,string,string][]=[['overview','Overview','house'],['devices','Devices','radio-tower'],['customers','Customers','users'],['more','More','ellipsis']];
const MODELS=['GT06','GT06N','PT06','FMB920','FMB125','FMC920','FMC130','Mobile'];
const protocolOf=(model:string)=>model==='Mobile'?'Phone (driver link)':['GT06','GT06N','PT06'].includes(model)?'GT06':'Teltonika';

let detailId=new URLSearchParams(location.search).get('id')||'',me:Identity,view:View='overview',deviceFilter={q:'',customer:'',status:''},poll:ReturnType<typeof setTimeout>|undefined;
let devices:AdminDevice[]=[],customers:Customer[]=[],gateway:Gateway={configured:false,connected:false,lastSync:null,error:null};

export async function startAdmin(identity:Identity){
  // The admin console stays in English; the customer's language choice is left untouched.
  setLang('en',false);
  me=identity;
  whenUnauthorized(()=>{clearTimeout(poll);showLogin('Your session ended. Please sign in again.')});
  const requested=new URLSearchParams(location.search).get('view') as View|null;
  view=requested&&(([...NAV,...TABS].some(([v])=>v===requested)||requested==='requests')||(requested==='device'&&detailId))?requested:'overview';
  window.addEventListener('popstate',()=>{const q=new URLSearchParams(location.search);view=(q.get('view') as View)||'overview';detailId=q.get('id')||'';shell()});
  shell();
}
function go(next:View,id=''){const url=new URL(location.href);url.searchParams.set('view',next);if(id)url.searchParams.set('id',id);else url.searchParams.delete('id');history.pushState(null,'',url);view=next;detailId=id;shell()}
const SIDE:[string,[View,string,string][]][]=[['Overview',[['overview','Overview','layout-dashboard']]],['Fleet',[['devices','GPS devices','radio-tower'],['customers','Customers','users'],['requests','Buy GPS requests','shopping-cart']]],['Team',[['admins','Admins','shield-check']]],['Account',[['settings','Settings','settings']]]];
const TITLE:Record<View,string>={requests:'Buy GPS requests',overview:'Overview',devices:'GPS devices',device:'Device details',customers:'Customers',admins:'Admins',settings:'Settings',more:'More'};
// Same design system as the customer app (navy actions, lavender surfaces), in English.
function shell(){
  clearTimeout(poll);detailMap?.map.remove();detailMap=undefined;clearInterval(terminalTimer);terminalOpen=false;
  const action=view==='devices'?`<button class="cx-btn dark" id="add-device">${i('plus')}<span>Add GPS device</span></button>`:view==='customers'?`<button class="cx-btn dark" id="add-customer">${i('plus')}<span>Add customer</span></button>`:'';
  const active=view==='device'?'devices':['admins','settings','more','requests'].includes(view)?'more':view;
  $('#app').innerHTML=`<div class="cx ax" data-view="${view}">
    <aside class="cx-side">
      <a class="cx-brand" href="/?live=1"><span class="cx-mark">${i('navigation')}</span><span><b>Waypoint</b><small>Admin console</small></span></a>
      <nav>${SIDE.map(([g,items])=>`<div class="cx-side-group"><span>${g}</span>${items.map(([v,l,ic])=>`<button data-go="${v}" class="${view===v||(v==='devices'&&view==='device')?'on':''}">${i(ic)}<em>${l}</em></button>`).join('')}</div>`).join('')}</nav>
      <button class="cx-me" data-go="settings"><span class="cx-avatar">${esc((me.email||'A').charAt(0).toUpperCase())}</span><span><b>Administrator</b><small>${esc(me.email||'Maintenance key session')}</small></span>${i('chevron-right')}</button>
    </aside>
    <main class="cx-main">
      <header class="ax-head">${view==='device'?`<button class="cx-back" data-go="devices" aria-label="Back to devices">${i('chevron-left')}</button>`:''}<div class="ax-title"><small>Waypoint admin</small><h1>${TITLE[view]}</h1></div>${action}</header>
      <div id="view"><div class="page"><p class="muted">Loading…</p></div></div>
    </main>
    <nav class="cx-tabs">${TABS.map(([v,l,ic])=>`<button data-go="${v}" class="${active===v?'on':''}"><span class="cx-tab-ico">${i(ic==='house'?'layout-dashboard':ic==='ellipsis'?'layout-grid':ic)}</span>${l}</button>`).join('')}</nav>
  </div>`;
  on('[data-go]',el=>go(el.dataset.go as View));on('[data-logout]',logout);
  on('#add-device',()=>deviceForm());on('#add-customer',customerForm);
  icons();
  void ({requests:renderRequests,overview:renderOverview,devices:renderDevices,device:renderDevice,customers:renderCustomers,admins:renderAdmins,settings:renderSettings,more:renderMore} as Record<View,()=>Promise<void>|void>)[view]();
}
async function logout(){await api('/session',{method:'DELETE'}).catch(()=>{});location.href='/?live=1&auth=admin'}
const fail=(e:unknown)=>{$('#view').innerHTML=`<div class="page"><div class="card empty">${i('triangle-alert')}<h3>Could not load</h3><p>${esc((e as Error).message)}</p></div></div>`;icons()};
const later=(fn:()=>void,ms:number)=>{clearTimeout(poll);poll=setTimeout(fn,ms)};

/* ---------- Overview ---------- */
async function renderOverview(){
  let o:Overview;try{o=await api<Overview>('/admin/overview');({devices,gateway}=await api<{devices:AdminDevice[];gateway:Gateway}>('/admin/devices'))}catch(e){fail(e);return}
  if(view!=='overview')return;
  const g=o.gateway,problems=devices.filter(d=>['Offline','Waiting','No GPS fix'].includes(d.status)||!d.customerId);
  const kpi=(label:string,value:number,note:string,icon:string,cls='')=>`<div class="cx-kpi ${cls}"><span class="cx-kpi-label">${label}${i(icon)}</span><b>${value}</b><span class="cx-kpi-note">${note}</span></div>`;
  $('#view').innerHTML=`<div class="page">
    <div class="ax-health ${g.connected?'ok':'bad'}"><span class="cx-tile ${g.connected?'':'danger'}">${i('server')}</span><div><b>${g.connected?'GPS receiver connected':g.configured?'GPS receiver not syncing':'GPS receiver not configured'}</b><small>Last sync ${ago(g.lastSync)}${g.error?` · ${esc(g.error)}`:''}</small></div><span class="cx-live ${g.connected?'':'off'}"><i></i>${g.connected?'Live':'Check'}</span></div>
    <div class="ax-kpis">${kpi('Customers',o.customers.total,`${o.customers.enabled} active`,'users')}${kpi('GPS devices',o.devices.total,`${o.devices.unassigned} unassigned`,'radio-tower',o.devices.unassigned?'warn':'')}${kpi('Running',o.devices.moving,'moving now','navigation','run')}${kpi('Stopped',o.devices.stopped,'standing','circle-parking')}${kpi('Offline',o.devices.offline,'no signal','wifi-off',o.devices.offline?'danger':'')}${kpi('Not installed',o.devices.waiting,`${o.devices.noFix} without GPS fix`,'plug')}</div>
    <div class="cx-quick ax-quick"><button id="q-device"><span class="cx-tile dark">${i('plus')}</span>Add device</button><button id="q-customer"><span class="cx-tile">${i('user-plus')}</span>Add customer</button><button data-go="requests"><span class="cx-tile">${i('shopping-cart')}</span>GPS requests</button><button data-go="settings"><span class="cx-tile">${i('key-round')}</span>Password</button></div>
    <div class="card card-pad"><div class="section-title"><h2>Server details</h2><span class="chip ${g.connected?'ok':'bad'}">${g.connected?'GPS receiver connected':g.configured?'GPS receiver not syncing':'Not configured'}</span></div>
      <dl class="facts"><dt>Last sync</dt><dd>${time(g.lastSync)} (${ago(g.lastSync)})</dd><dt>Tracker server</dt><dd class="mono">${esc(g.trackerHost||'—')}</dd><dt>GT06 / PT06 port</dt><dd class="mono">TCP ${g.gt06Port??5023}${g.gt06AlternativePort?` · alt ${g.gt06AlternativePort}`:''}</dd><dt>Teltonika port</dt><dd class="mono">TCP ${g.teltonikaPort??5027}</dd>${g.error?`<dt>Last error</dt><dd style="color:var(--stopped)">${esc(g.error)}</dd>`:''}<dt>Admins</dt><dd>${o.admins.map(esc).join(', ')||'—'}</dd></dl></div>
    <div class="card"><div class="card-pad section-title" style="margin:0"><h2>Needs attention</h2><button class="btn btn-ghost btn-sm" data-go="devices">All devices${i('chevron-right')}</button></div>
      ${problems.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Vehicle</th><th>Customer</th><th>Status</th><th>Last signal</th><th></th></tr></thead><tbody>${problems.slice(0,12).map(d=>`<tr><td><b>${esc(d.name)}</b><small class="mono">${esc(d.uniqueId)}</small></td><td>${d.customerName?esc(d.customerName):'<span class="chip idle plain">Unassigned</span>'}</td><td>${chip(d)}</td><td>${ago(d.lastSeen)}</td><td><div class="actions"><button class="btn btn-ghost btn-sm" data-detail="${d.id}">${i('eye')}Details</button><button class="btn btn-ghost btn-sm" data-edit="${d.id}">${i('pencil')}Edit</button></div></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty">${i('check')}<h3>Everything looks fine</h3></div>`}</div></div>`;
  on('#view [data-go]',el=>go(el.dataset.go as View));on('[data-edit]',el=>deviceForm(devices.find(d=>d.id===el.dataset.edit)));on('[data-detail]',el=>go('device',el.dataset.detail));
  on('#q-device',()=>deviceForm());on('#q-customer',customerForm);icons();
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
</div>
    <div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Vehicle</th><th>Customer</th><th>Tracker</th><th>Status</th><th>Last signal</th><th></th></tr></thead><tbody>
      ${list.map(d=>`<tr><td class="nowrap"><a href="?live=1&view=device&id=${d.id}" data-detail="${d.id}"><b>${esc(d.name)}</b></a><small>${esc(d.driver||'—')}</small></td><td>${d.customerName?esc(d.customerName):'<span class="chip idle plain">Unassigned</span>'}</td><td class="nowrap"><span class="mono">${esc(d.uniqueId)}</span><small>${esc(d.model)} · ${esc(d.model==='Mobile'?'driver link':d.bridgeStatus||'awaiting sync')}</small></td><td>${chip(d)}</td><td class="nowrap" title="Last packet ${esc(time(d.lastSeen))}">${ago(d.lastSeen)}<small>GPS fix ${d.position?ago(d.position.recordedAt):'never'}${d.position?.valid===0?' (no satellites)':''}</small></td>
        <td><div class="actions nowrap"><button class="btn btn-primary btn-sm" data-detail="${d.id}">${i('eye')}Details</button><button class="btn btn-blue btn-sm btn-icon" data-locate="${d.id}" ${d.position?'':'disabled'} title="Current location" aria-label="Location of ${esc(d.name)}">${i('map-pin')}</button><button class="btn btn-ghost btn-sm btn-icon" data-edit="${d.id}" title="Edit / assign customer" aria-label="Edit ${esc(d.name)}">${i('pencil')}</button><button class="btn btn-ghost btn-sm btn-icon" data-info="${d.id}" title="Tracker setup" aria-label="Setup ${esc(d.name)}">${i('info')}</button><button class="btn btn-danger btn-sm btn-icon" data-delete="${d.id}" title="Delete" aria-label="Delete ${esc(d.name)}">${i('trash-2')}</button></div></td></tr>`).join('')||`<tr><td colspan="6"><div class="empty">${i('radio-tower')}<h3>No devices</h3><p>Add a GPS device and assign it to a customer.</p></div></td></tr>`}
    </tbody></table></div></div></div>`;
  const q=$<HTMLInputElement>('#dq');q.oninput=()=>{deviceFilter.q=q.value;void renderDevices()};
  if(focused){q.focus();q.setSelectionRange(q.value.length,q.value.length)}
  $<HTMLSelectElement>('#dc').onchange=e=>{deviceFilter.customer=(e.target as HTMLSelectElement).value;void renderDevices()};
  $<HTMLSelectElement>('#ds').onchange=e=>{deviceFilter.status=(e.target as HTMLSelectElement).value;void renderDevices()};
  const find=(el:HTMLElement,key:string)=>devices.find(d=>d.id===el.dataset[key])!;
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
    <div id="sim-block"><h3 style="margin:4px 0 8px">SIM card in the tracker</h3>
      <div class="form-row"><label class="field">Operator<select class="input" name="simOperator" id="sim-op"><option value="">Select…</option>${Object.entries(OPERATORS).map(([k,o])=>`<option value="${k}" ${d?.simOperator===k?'selected':''}>${o.label}</option>`).join('')}</select></label>
        <label class="field">SIM type<select class="input" name="simType" id="sim-type"><option value="personal" ${d?.simType!=='iot'?'selected':''}>Personal / normal</option><option value="iot" ${d?.simType==='iot'?'selected':''}>IoT / M2M</option></select></label></div>
      <div class="form-row"><label class="field">APN<input class="input mono" name="apn" id="sim-apn" maxlength="40" placeholder="e.g. airtelgprs.com" value="${esc(d?.apn||'')}"></label><label class="field">SIM mobile number (optional)<input class="input" name="simNumber" maxlength="20" inputmode="tel" value="${esc(d?.simNumber||'')}"></label></div>
      <p class="hint" id="apn-hint" style="margin:0 0 8px"></p>
      <details><summary class="small muted">APN login (only if your SIM provider gave a username and password)</summary><div class="form-row" style="margin-top:8px"><label class="field">APN user<input class="input" name="apnUser" maxlength="40" value="${esc(d?.apnUser||'')}"></label><label class="field">APN password<input class="input" name="apnPass" maxlength="40" type="password" autocomplete="off" placeholder="${editing?'unchanged':''}"></label></div></details></div>
    ${editing?'':`<div id="auto-block" class="card card-pad" style="background:var(--soft)"><label class="check"><input type="checkbox" name="autoSetup" checked>Set the tracker up automatically after its first connection</label><p class="hint" style="margin:6px 0 10px">One command at a time, each waits for the tracker's reply: time zone, upload interval, ignition reports, data on, status, settings, restart.</p><div class="form-row"><label class="field">Upload when moving (sec)<input class="input" type="number" name="moving" min="5" max="18000" value="10"></label><label class="field">Upload when parked (sec)<input class="input" type="number" name="parked" min="5" max="18000" value="60"></label></div></div>`}
    <div class="form-row"><label class="field">Speed limit (km/h)<input class="input" type="number" name="speedLimit" min="1" max="250" value="${d?.speedLimit??80}" required></label><label class="field">Offline after (seconds)<input class="input" type="number" name="offlineSeconds" min="30" max="86400" value="${d?.offlineSeconds??600}" required></label></div>
    ${editing&&d!.customerId?'<p class="hint">Moving a vehicle to another customer disables its driver link and geofence state.</p>':''}
    <p class="error" id="device-error"></p><button class="btn btn-primary" type="submit">${editing?'Save changes':'Add device'}</button></form>`);
  const form=$<HTMLFormElement>('#device-form');
  const syncApn=()=>{
    const op=$<HTMLSelectElement>('#sim-op').value,type=$<HTMLSelectElement>('#sim-type').value,apn=$<HTMLInputElement>('#sim-apn'),want=OPERATORS[op]?.apn[type]||'';
    if(!apn.dataset.touched||!apn.value)apn.value=want;
    // IoT / M2M SIMs use a secure APN from the seller; never guessed.
    $('#apn-hint').textContent=type==='iot'?'IoT / M2M SIM: the APN (and login, if any) is assigned by your SIM provider. Enter exactly what they gave you.':op&&!want?'No standard APN is on file for this operator. Enter the APN printed with the SIM or given by the operator.':want?'Standard APN for this operator. Change it if your SIM came with a different one.':'';
  };
  $<HTMLSelectElement>('#sim-op').addEventListener('change',syncApn);$<HTMLSelectElement>('#sim-type').addEventListener('change',syncApn);$<HTMLInputElement>('#sim-apn').addEventListener('input',e=>{(e.target as HTMLInputElement).dataset.touched='1'});
  document.querySelector<HTMLSelectElement>('#model')?.addEventListener('change',e=>{const mobile=(e.target as HTMLSelectElement).value==='Mobile';$('#imei-field').hidden=mobile;$<HTMLInputElement>('#imei-field input').required=!mobile;$('#sim-block').hidden=mobile;const auto=document.querySelector<HTMLElement>('#auto-block');if(auto)auto.hidden=mobile});
  form.addEventListener('submit',async e=>{
    e.preventDefault();const v=Object.fromEntries(new FormData(form)) as Record<string,string>;const button=form.querySelector<HTMLButtonElement>('button[type=submit]')!;button.disabled=true;
    try{
      const sim={simOperator:v.simOperator||null,simType:v.simOperator?v.simType:null,apn:v.apn||null,simNumber:v.simNumber||null,apnUser:v.apnUser||null,...(v.apnPass?{apnPass:v.apnPass}:{})};
      const body={name:v.name,driver:v.driver,customerId:v.customerId||null,speedLimit:Number(v.speedLimit),offlineSeconds:Number(v.offlineSeconds),...(v.model==='Mobile'?{}:sim)};
      if(editing)await api(`/admin/devices/${d!.id}`,{method:'PATCH',body:JSON.stringify(body)});
      else{
        const auto=form.querySelector<HTMLInputElement>('[name=autoSetup]')?.checked!==false;
        const r=await post<{device:AdminDevice;provisioning:Provisioning}>('/admin/devices',{...body,model:v.model,uniqueId:v.model==='Mobile'?undefined:v.uniqueId,autoSetup:auto,moving:Number(v.moving||10),parked:Number(v.parked||60)});
        closeModal();toast('Device added.');if(view==='devices')await renderDevices();
        if(v.model==='Mobile')setupInfo({...r.device,customerId:body.customerId,customerName:customers.find(c=>c.id===body.customerId)?.name||null});else onboardingGuide(r.device.id,r.device.name);
        return}
      closeModal();toast('Saved.');if(view==='devices')void renderDevices();else if(view==='overview')void renderOverview();else if(view==='device')void renderDevice();
    }catch(err){$('#device-error').textContent=(err as Error).message;button.disabled=false}
  });
}
/* ---------- Onboarding guide and automatic set-up ---------- */
const STEP_CHIP:Record<Step['status'],[string,string]>={pending:['Waiting','neutral'],sent:['Sent · waiting for reply','neutral'],ok:['Done','ok'],failed:['Failed','bad']};
function stepsHtml(steps:Step[]){
  if(!steps.length)return '<p class="muted small">No automatic set-up is queued for this tracker.</p>';
  return steps.map(st=>{const [label,cls]=STEP_CHIP[st.status];return `<div class="alert-item"><div class="body"><b>${st.seq}. ${esc(st.label)}</b><p class="mono small">${esc(st.command)}${st.reply?` → ${esc(st.reply.slice(0,160))}`:''}</p>${st.attempts>1?`<span class="small muted">${st.attempts} tries</span>`:''}</div><span class="chip ${cls} plain">${label}</span></div>`}).join('');
}
function smsHtml(sms:Provisioning['sms']){
  if(!sms.length)return '<p class="muted small">No SMS needed for this tracker.</p>';
  return sms.map((m,n)=>`<div class="alert-item"><div class="body"><b>${n+1}. ${esc(m.label)}</b><p class="mono">${esc(m.text)}</p></div><button class="btn btn-ghost btn-sm" data-copy="${esc(m.text)}">${i('copy')}Copy</button></div>`).join('');
}
// Shown right after a tracker is added: the SMS to send by hand, then the automatic set-up as it runs.
function onboardingGuide(id:string,name:string){
  const dialog=modal(`${name} · Set up the tracker`,`<div id="guide"><p class="muted">Loading…</p></div>`,{wide:true});
  const load=async()=>{
    if(!dialog.open)return;
    try{
      const data=await api<Detail>(`/admin/devices/${id}?tz=-330`);
      const d=data.device,pr=data.provisioning,steps=pr.steps,connected=!!d.lastSeen&&Date.now()-d.lastSeen<=240000;
      const open=steps.filter(x=>x.status==='pending'||x.status==='sent').length,failed=steps.filter(x=>x.status==='failed').length;
      $('#guide').innerHTML=`<h3>Step 1 · Send these SMS to the tracker's SIM</h3><p class="hint" style="margin:4px 0 8px">A brand-new tracker cannot receive anything over data yet, so these go by SMS (from any phone). Send them in this order. Syntax can differ by maker; check the manual.</p>${d.apn?'':`<p class="gap-note" style="margin-bottom:8px">${i('triangle-alert')}No APN was entered, so there is no APN text below. Get it from the SIM provider (IoT / M2M SIMs use a private one), then add it from Edit.</p>`}<div class="card">${smsHtml(pr.sms)}</div>
        <h3 style="margin-top:18px">Step 2 · Automatic set-up</h3>
        <p class="${connected?'hint':'gap-note'}" style="margin:4px 0 8px">${connected?'The tracker is connected. The app sends each command, waits for the reply and moves on.':`${i('triangle-alert')}Waiting for the tracker's first connection. Once the SMS above are applied and it has mobile data, set-up starts by itself.`}</p>
        <div class="card" id="guide-steps">${stepsHtml(steps)}</div>
        <p class="small ${failed?'':'muted'}" style="margin-top:10px">${!steps.length?'':open?`${open} step${open===1?'':'s'} left. You can close this window; set-up continues and is also on the device page.`:failed?`Finished with ${failed} failed step${failed===1?'':'s'}. Open the device page to retry.`:'All steps finished. The tracker is ready.'}</p>`;
      wireCopy($('#guide'));icons();
      if(open||!steps.length)setTimeout(()=>void load(),5000);
    }catch(e){$('#guide').innerHTML=`<p class="error">${esc((e as Error).message)}</p>`}
  };
  void load();
}
function renderProvisioningCard(data:Detail){
  const d=data.device,pr=data.provisioning,host=document.querySelector('#dp-provision');if(!host)return;
  if(d.model==='Mobile'){host.innerHTML='';return}
  const steps=pr.steps,open=steps.filter(x=>x.status==='pending'||x.status==='sent').length;
  host.innerHTML=`<div class="section-title"><h2>Set-up</h2><div class="toolbar"><button class="btn btn-ghost btn-sm" id="pv-sms">${i('copy')}SMS texts</button><button class="btn btn-primary btn-sm" id="pv-run">${i('refresh-cw')}${steps.length?'Run set-up again':'Run automatic set-up'}</button>${open?`<button class="btn btn-ghost btn-sm" id="pv-cancel">Cancel</button>`:''}</div></div>
    <dl class="facts" style="margin-bottom:12px"><dt>SIM</dt><dd>${d.simOperator?`${esc(OPERATORS[d.simOperator]?.label||d.simOperator)} · ${d.simType==='iot'?'IoT / M2M':'Personal'}`:'<span class="muted">Not recorded</span>'}${d.simNumber?` · ${esc(d.simNumber)}`:''}</dd><dt>APN</dt><dd class="mono">${esc(d.apn||'—')}</dd></dl>
    ${stepsHtml(steps)}`;
  on('#pv-sms',()=>onboardingGuide(d.id,d.name),host);
  on('#pv-run',async()=>{if(steps.length&&!confirm('Send the whole set-up again, one command at a time?'))return;await post(`/admin/devices/${d.id}/provision`,{action:'start'});toast('Set-up queued. It starts when the tracker connects.');void renderDevice()},host);
  on('#pv-cancel',async()=>{await post(`/admin/devices/${d.id}/provision`,{action:'cancel'});toast('Set-up cancelled.');void renderDevice()},host);
}
function setupInfo(d:AdminDevice){
  const gt06=['GT06','GT06N','PT06'].includes(d.model);
  modal(`${d.name} · Setup`,d.model==='Mobile'
    ?`<p>This vehicle reports from the driver's phone. The customer shares the driver link from their app (vehicle card → Driver link).</p>`
    :`<dl class="facts"><dt>IMEI</dt><dd class="mono">${esc(d.uniqueId)}</dd><dt>Protocol</dt><dd>${protocolOf(d.model)}</dd><dt>Server IP</dt><dd class="mono">${esc(gateway.trackerHost||'—')}</dd><dt>Port</dt><dd class="mono">TCP ${gt06?(gateway.gt06Port??5023):(gateway.teltonikaPort??5027)}${gt06&&gateway.gt06AlternativePort?` (alternative ${gateway.gt06AlternativePort})`:''}</dd><dt>Receiver</dt><dd>${d.traccarId?'Linked':'Waiting for first sync'} · ${esc(d.bridgeStatus||'—')}</dd><dt>Last packet</dt><dd>${time(d.lastSeen)}</dd><dt>Last GPS fix</dt><dd>${d.position?time(d.position.recordedAt):'Never'}</dd></dl>
      ${gt06?`<div class="card card-pad" style="background:var(--soft)"><h3>SMS to the tracker SIM</h3><p class="small muted" style="margin:6px 0 10px">Syntax varies by maker; check the manual.</p><p class="mono">SERVER,1,${esc(gateway.trackerHost||'IP')},${gateway.gt06Port??5023},0#</p><p class="mono">APN,${esc(d.apn||'your-apn')}#${d.apn?'':'  (IoT SIMs: the APN comes from your SIM seller)'}</p><p class="mono">RESET#   then   STATUS#</p><p class="small muted" style="margin-top:8px">STATUS# should show GPRS: Link Up and GPS: FIXED.</p></div>`:''}
      <button class="btn btn-ghost" id="relay">${i('shield-check')}Engine relay</button>`);
  on('#relay',()=>relayDialog(d));
}
function locate(d:AdminDevice){
  const p=d.position!;
  modal(`${d.name} · Current location`,`<div style="height:320px;border-radius:14px;overflow:hidden;position:relative"><div class="map" id="locate-map"></div></div>
    <div><div style="display:flex;gap:8px;font-weight:600">${i('map-pin')}${placeSpan(p,'admin-'+d.id)}</div><p class="small muted" style="margin-top:4px">${esc(statusLine(d))} · ${esc(coords(p))} · ${ago(p.recordedAt)}</p></div>
    <div class="toolbar"><a class="btn btn-blue" href="${mapsLink(p)}" target="_blank" rel="noopener">${i('external-link')}Open in Google Maps</a><button class="btn btn-ghost" id="locate-google">${i('landmark')}Nearby places (Google)</button></div>
    <div class="gmodal" id="locate-gmap" hidden></div>`,{wide:true});
  on('#locate-google',el=>{const host=$('#locate-gmap');host.hidden=false;googleLive(host).update([d],d.id);el.remove()});
  requestAnimationFrame(()=>{const m=createMap($('#locate-map'),point(p),16);L.marker(point(p),{icon:truckIcon(d,true)}).addTo(m);const dialog=document.querySelector('dialog.modal')!;dialog.addEventListener('close',()=>m.remove(),{once:true});icons()});
}

/* ---------- Device details ---------- */
type Packet={id:number;recordedAt:number;receivedAt:number;latitude:number;longitude:number;speed:number;heading:number|null;ignition:number|null;battery:number|null;satellites:number|null;valid:number;extra?:string|null};
type CommandRow={id:string;status:string;detail:string;createdAt:number;updatedAt:number};
type RawPacket={at:string;session:string;direction:'in'|'out'|'event'|'decoded';remote:string;hex:string;tag:string};
type PowerEvent={at:number;connected:boolean;battery:number|null};
type Detail={device:AdminDevice;provisioning:Provisioning;commands:CommandRow[];power:{connected:boolean|null;events:PowerEvent[]};sim:{iccid:string|null};packets:Packet[];alerts:{id:string;type:string;message:string;createdAt:number;acknowledged:number}[];today:{distanceKm:number;runningMinutes:number;idleMinutes:number;maxSpeed:number;gaps:{from:number;to:number;minutes:number;movedKm:number|null}[]}|null;gateway:Gateway};
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
const hhmmss=(at:number)=>new Date(at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'Asia/Kolkata'});
async function renderDevice(){
  let data:Detail;
  try{data=await api<Detail>(`/admin/devices/${detailId}?tz=-330`)}catch(e){fail(e);return}
  if(view!=='device')return;
  const d=data.device,p=d.position,g=data.gateway;gateway=g;
  const first=!document.querySelector('#device-page');
  if(first){
    detailMap?.map.remove();detailMap=undefined;
    $('#view').innerHTML=`<div class="page" id="device-page"><div id="dp-head"></div><div class="grid-kpi" id="dp-kpi"></div>
      <div style="display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:14px" class="dp-cols"><div class="card"><div style="height:300px;border-radius:16px 16px 0 0;overflow:hidden;position:relative"><div class="map" id="dp-map"></div></div><div class="card-pad" id="dp-place"></div></div><div class="card card-pad" id="dp-today"></div></div>
      <div class="card card-pad" id="dp-health"></div><div class="card card-pad" id="dp-provision"></div><div class="card card-pad" id="dp-commands"></div><div class="card card-pad" id="dp-tracker"></div><div class="card" id="dp-terminal"></div><div class="card" id="dp-packets"></div><div class="card" id="dp-alerts"></div></div>`;
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
  $('#dp-tracker').innerHTML=`<h2>Tracker</h2><dl class="facts" style="margin-top:12px"><dt>Model / protocol</dt><dd>${esc(d.model)} · ${protocolOf(d.model)}</dd><dt>IMEI</dt><dd class="mono">${esc(d.uniqueId)}</dd><dt>SIM (ICCID)</dt><dd class="mono">${data.sim?.iccid?esc(data.sim.iccid):'<span class="muted">Not reported yet</span>'}</dd><dt>Receiver</dt><dd>${d.traccarId?`Linked (#${d.traccarId})`:'Not yet linked'} · ${esc(d.bridgeStatus||'—')}</dd>${d.model==='Mobile'?'':`<dt>Server</dt><dd class="mono">${esc(g.trackerHost||'—')} : ${gt06?(g.gt06Port??5023):(g.teltonikaPort??5027)}</dd>`}<dt>Speed limit</dt><dd>${d.speedLimit} km/h</dd><dt>Offline after</dt><dd>${Math.round(d.offlineSeconds/60)} min without a packet</dd><dt>Registered</dt><dd>${time(d.createdAt)}</dd></dl>`;
  renderHealth(data);
  on('[data-clockfix]',async el=>{const m=Number(el.dataset.clockfix);if(!confirm(`Move this tracker's stored positions that are ${hm(m)} behind forward by ${hm(m)}?`))return;const r=await post<{shifted:number}>(`/admin/devices/${d.id}/clock-fix`,{minutes:m});toast(`${r.shifted} positions corrected.`);void renderDevice()},$('#dp-health'));
  renderProvisioningCard(data);renderCommands(data);renderTerminal(d);
  $('#dp-packets').innerHTML=`<div class="card-pad section-title" style="margin:0"><h2>Last ${data.packets.length} packets</h2><span class="small muted">Newest first · refreshes every 10 s</span></div>${data.packets.length?`<div class="table-wrap" style="max-height:460px"><table class="table"><thead><tr><th>Received</th><th>GPS time</th><th>Type</th><th>Speed</th><th>Ignition</th><th>Sats</th><th>Battery</th><th>Position</th></tr></thead><tbody>${data.packets.map(x=>{const [label,cls]=kinds.get(x.id)!;return `<tr><td class="nowrap">${hhmmss(x.receivedAt)}<small>${new Date(x.receivedAt).toLocaleDateString('en-IN',{day:'2-digit',month:'short',timeZone:'Asia/Kolkata'})}</small></td><td class="nowrap">${hhmmss(x.recordedAt)}</td><td><span class="chip ${cls} plain">${label}</span></td><td>${Math.round(x.speed)} km/h</td><td>${x.ignition==null?'—':x.ignition?'On':'Off'}</td><td>${x.satellites??'—'}</td><td>${x.battery!=null?Math.round(x.battery)+'%':'—'}</td><td class="mono">${x.latitude.toFixed(5)}, ${x.longitude.toFixed(5)}</td></tr>`}).join('')}</tbody></table></div>`:'<div class="empty"><p>No packets stored yet.</p></div>'}`;
  $('#dp-alerts').innerHTML=`<div class="card-pad section-title" style="margin:0"><h2>Recent alerts</h2></div>${data.alerts.length?data.alerts.map(a=>`<div class="alert-item ${a.acknowledged?'done':''}"><div class="body"><b>${esc(a.type)}</b><p>${esc(a.message)}</p><span class="small muted">${time(a.createdAt)}</span></div></div>`).join(''):'<div class="empty"><p>No alerts.</p></div>'}`;
  if(p){
    if(!detailMap){const map=createMap($('#dp-map'),point(p),16);detailMap={map,marker:L.marker(point(p),{icon:truckIcon(d,true)}).addTo(map)}}
    else{detailMap.marker.setLatLng(point(p)).setIcon(truckIcon(d,true))}
  }
  on('#dp-edit',()=>{customers.length?deviceForm(d):void api<{customers:Customer[]}>('/customers').then(r=>{customers=r.customers;deviceForm(d)})});
  on('#dp-setup',()=>setupInfo(d));
  on('#dp-delete',async()=>{if(prompt(`Delete ${d.name}? This removes its whole location history and alerts.\nType the IMEI/identifier to confirm: ${d.uniqueId}`)!==d.uniqueId)return;await api(`/admin/devices/${d.id}`,{method:'DELETE'});toast('Device deleted.');go('devices')});
  icons();
  later(()=>{if(view==='device'&&!document.querySelector('dialog.modal[open]'))void renderDevice()},4000);
}
/* ---------- Device health, commands and live terminal ---------- */
const extraOf=(p:Packet)=>{try{return p.extra?JSON.parse(p.extra) as Record<string,any>:{}}catch{return {}}};
const ALARM_WORDS:Record<string,string>={powerCut:'Vehicle power cut',lowBattery:'Backup battery low',tampering:'Tamper alert',vibration:'Vibration',sos:'SOS',overspeed:'Overspeed',gpsAntennaCut:'GPS antenna cut',jamming:'Jamming'};
const alarmWords=(code:string)=>[...new Set(code.split(',').map(c=>c.trim()))].map(c=>ALARM_WORDS[c]||c).join(', ');
const SIGNAL=['No signal','Extremely weak','Very weak','Good','Strong'];
function renderHealth(data:Detail){
  const d=data.device,packets=data.packets;
  const latest=(pick:(p:Packet,x:Record<string,any>)=>any)=>{for(const p of packets){const v=pick(p,extraOf(p));if(v!=null)return {v,at:p.receivedAt}}return null};
  const rssi=latest((_,x)=>x.rssi),charge=latest((_,x)=>x.charge),battery=latest(p=>p.battery),sats=latest(p=>p.satellites);
  const hbHour=packets.filter(p=>p.receivedAt>Date.now()-3600000&&(extraOf(p).type===19||p.receivedAt-p.recordedAt>90000)).length;
  const gap=d.lastSeen?Math.round((Date.now()-d.lastSeen)/60000):null,limit=Math.round(d.offlineSeconds/60);
  const alarms=packets.filter(p=>extraOf(p).alarm).slice(0,3);
  const lastFix=packets.find(p=>p.valid!==0&&p.receivedAt-p.recordedAt<=90000);
  // Clock check: how far behind the server a fresh location's GPS time is. A multiple of 30 minutes
  // means the tracker's time zone is being applied twice; anything else means old stored data.
  const locKinds=packetKinds(packets),lag=packets.filter(x=>locKinds.get(x.id)?.[0]==='Location').slice(0,15).map(x=>(x.receivedAt-x.recordedAt)/60000).sort((a,b)=>a-b);
  const skew=lag.length?lag[lag.length>>1]:0,tzMismatch=skew>=25&&Math.abs(Math.round(skew/30)*30-skew)<=4;
  const clockNote=!lag.length?'':skew<20?`<span class="chip ok plain">Clock OK</span>`:tzMismatch?`<span class="chip bad plain">GPS time is ${hm(Math.round(skew/30)*30)} behind</span><small>The tracker's time zone was applied twice. New data is corrected from its next connection; stored rows can be corrected.</small><button class="btn btn-ghost btn-sm" style="margin-top:6px" data-clockfix="${Math.round(skew/30)*30}">${i('clock')}Correct stored times (+${hm(Math.round(skew/30)*30)})</button>`:`<span class="chip bad plain">${hm(Math.round(skew))} behind</span><small>The tracker is sending old stored positions, or its clock is wrong.</small>`;
  const events=data.power.events,lastEvent=events[0];
  const powerNow=data.power.connected==null?(charge?(charge.v?'Connected (charging)':'Cut — running on backup battery'):'<span class="muted">Not reported by this tracker</span>')
    :data.power.connected?`Connected${lastEvent&&lastEvent.connected?` since ${time(lastEvent.at)}`:''}`:`<b style="color:var(--stopped)">CUT since ${lastEvent?time(lastEvent.at):'—'}</b> · running on backup battery${lastEvent?` (${hm(Math.round((Date.now()-lastEvent.at)/60000))})`:''}`;
  const powerLog=events.map(e=>`<span class="chip ${e.connected?'ok':'bad'} plain">${e.connected?'Power restored':'Power cut'}</span> ${time(e.at)}${e.battery!=null?` · battery ${Math.round(e.battery)}%`:''}`).join('<br>');
  const na='<span class="muted">Not reported by this tracker</span>';
  $('#dp-health').innerHTML=`<div class="section-title"><h2>Device health</h2><span class="chip ${d.online?'ok':'bad'}">${d.online?'Online':'No signal from tracker'}</span></div>
    <div class="health-grid">
      <div><h3>Network</h3><dl class="facts">
        <dt>GSM signal</dt><dd>${rssi?`${SIGNAL[Math.min(4,Math.max(0,Number(rssi.v)))]||rssi.v} (${rssi.v}/4)`:na}</dd>
        <dt>Last packet</dt><dd>${ago(d.lastSeen)} · ${time(d.lastSeen)}<small class="muted">Heartbeat: the tracker is connected. It does not carry a location.</small></dd>
        <dt>Heartbeats (last hour)</dt><dd>${hbHour}</dd>
        ${clockNote?`<dt>GPS clock</dt><dd>${clockNote}</dd>`:''}
        <dt>Timeout setting</dt><dd>${limit} min${gap!=null&&gap>limit?` <span class="chip bad plain">missed ${Math.max(1,Math.floor(gap/Math.max(1,limit)))}×</span>`:''}</dd></dl></div>
      <div><h3>Power</h3><dl class="facts">
        <dt>Vehicle power</dt><dd>${powerNow}</dd>
        ${powerLog.length?`<dt>Power log</dt><dd>${powerLog}</dd>`:''}
        <dt>Backup battery</dt><dd>${battery?`${Math.round(Number(battery.v))}%`:na}</dd>
        <dt>Voltage (V)</dt><dd><span class="muted">Not reported by ${esc(d.model)} (only % is sent)</span></dd>
        <dt>Tamper / alarms</dt><dd>${alarms.length?alarms.map(a=>`<span class="chip bad plain">${esc(alarmWords(String(extraOf(a).alarm)))}</span> ${time(a.receivedAt)}`).join('<br>'):'None reported'}</dd></dl></div>
      <div><h3>GPS quality</h3><dl class="facts">
        <dt>Fix status</dt><dd>${lastFix?(Date.now()-lastFix.recordedAt>10*60000?`<span class="chip idle plain">Old fix</span> ${ago(lastFix.recordedAt)} · ${time(lastFix.recordedAt)}<small class="muted">No new satellite fix: the tracker has no sky view (indoors or covered). It keeps repeating its last location.</small>`:`Fixed · ${ago(lastFix.recordedAt)}`):'No recent fix'}</dd>
        <dt>Satellites (at that fix)</dt><dd>${sats?String(sats.v):na}</dd>
        <dt>HDOP / PDOP</dt><dd><span class="muted">Not reported by ${esc(d.model)}</span></dd>
        <dt>Last known place</dt><dd>${d.position?`${coords(d.position)}`:'—'}</dd></dl></div></div>`;
}
const SMS_TEXT:Record<string,(i:Record<string,string>)=>string>={
  reboot:()=>'RESET#',status:()=>'STATUS#',settings:()=>'PARAM#',version:()=>'VERSION#',where:()=>'WHERE#',network:()=>'GPRSSET#',gprsOn:()=>'GPRSON,1#',batchOff:()=>'BATCH,OFF#',
  accReport:i=>`ACCREP,${i.on==='false'?'OFF':'ON'}#`,timezone:i=>`GMT,${i.west==='true'?'W':'E'},${Number(i.hours)},${Number(i.minutes)||0}#`,interval:i=>`TIMER,${i.moving},${i.parked}#`,
  apn:i=>`APN,${i.apn}${i.user||i.password?`,${i.user||''},${i.password||''}`:''}#`,
  server:i=>`SERVER,${/^\d+(\.\d+){3}$/.test(i.host)?0:1},${i.host},${i.port},0#`};
function renderCommands(data:Detail){
  const d=data.device,gt06=['GT06','GT06N','PT06'].includes(d.model);
  const online=!!d.lastSeen&&Date.now()-d.lastSeen<=600000;
  if(d.model==='Mobile'){$('#dp-commands').innerHTML='<h2>Commands</h2><p class="muted" style="margin-top:8px">Phone-based vehicles have no tracker settings.</p>';return}
  const quick=[['status','Status','activity'],['settings','Read settings','info'],['version','Firmware version','server'],['where','Location now','map-pin'],['network','Network settings','radio-tower'],['gprsOn','GPRS on','power'],['batchOff','Send fixes at once','timer']] as const;
  $('#dp-commands').innerHTML=`<div class="section-title"><h2>Commands</h2><span class="chip ${online?'ok':'bad'}">${online?`Signal ${ago(d.lastSeen).toLowerCase()} · delivered at its next connection`:'No recent signal'}</span></div>
    <p class="${online?'hint':'gap-note'}" style="margin-bottom:12px">${online?'Commands wait in a queue and reach the tracker the next time it connects, usually within a minute or two. The reply appears in the log below.':`${i('triangle-alert')}No signal from the tracker for over 10 minutes, so commands are not queued. Copy the SMS text and send it from a phone to the tracker's SIM.`}</p>
    <div class="presets" id="quick">${quick.map(([a,l,ic])=>`<button class="btn btn-ghost btn-sm" data-cmd="${a}">${i(ic)}${l}</button>`).join('')}<button class="btn btn-danger btn-sm" data-cmd="reboot">${i('refresh-cw')}Reboot</button></div>
    ${gt06?`<div class="cmd-forms">
      <form class="form" data-form="interval"><h3>Upload interval</h3>${d.model==='PT06'?'<p class="gap-note">PT06 reads the parked value in minutes (TIMER:20,10 = every 10 minutes when parked). Enter parked minutes, then check with Read settings.</p>':''}<div class="form-row"><label class="field">Moving (sec)<input class="input" name="moving" type="number" min="5" max="18000" value="10" required></label><label class="field">Parked (${d.model==='PT06'?'min':'sec'})<input class="input" name="parked" type="number" min="1" max="18000" value="${d.model==='PT06'?1:60}" required></label></div><div class="toolbar"><button class="btn btn-primary btn-sm" type="submit">Send</button><button class="btn btn-ghost btn-sm" type="button" data-sms>Copy SMS</button></div></form>
      <form class="form" data-form="apn"><h3>APN</h3><label class="field">APN name<input class="input" name="apn" placeholder="airtelgprs.com" required></label><div class="form-row"><label class="field">User (optional)<input class="input" name="user"></label><label class="field">Password (optional)<input class="input" name="password"></label></div><div class="toolbar"><button class="btn btn-primary btn-sm" type="submit">Send</button><button class="btn btn-ghost btn-sm" type="button" data-sms>Copy SMS</button></div></form>
      <form class="form" data-form="server"><h3>Server IP / port</h3><div class="form-row"><label class="field">Host or IP<input class="input" name="host" value="${esc(gateway.trackerHost||'')}" required></label><label class="field">Port<input class="input" name="port" type="number" min="10" max="65535" value="${gateway.gt06Port??5023}" required></label></div><div class="toolbar"><button class="btn btn-primary btn-sm" type="submit">Send</button><button class="btn btn-ghost btn-sm" type="button" data-sms>Copy SMS</button></div></form>
      <form class="form" data-form="timezone"><h3>Time zone</h3><p class="hint">GPS times come out wrong by the offset if this does not match what the receiver expects. India: East, 5 hours 30 minutes (IST).</p><div class="form-row"><label class="field">Hours<input class="input" name="hours" type="number" min="0" max="12" value="5" required></label><label class="field">Minutes<select class="input" name="minutes"><option>0</option><option>15</option><option selected>30</option><option>45</option></select></label></div><label class="field">Direction<select class="input" name="west"><option value="false">East (India)</option><option value="true">West</option></select></label><div class="toolbar"><button class="btn btn-primary btn-sm" type="submit">Send</button><button class="btn btn-ghost btn-sm" type="button" data-sms>Copy SMS</button></div></form>
      <form class="form" data-form="accReport"><h3>Ignition change report</h3><label class="field">Report when ignition changes<select class="input" name="on"><option value="true">On</option><option value="false">Off</option></select></label><div class="toolbar"><button class="btn btn-primary btn-sm" type="submit">Send</button><button class="btn btn-ghost btn-sm" type="button" data-sms>Copy SMS</button></div></form></div>`:''}
    <h3 style="margin-top:16px">Command log</h3>
    <div id="cmd-log">${data.commands.length?data.commands.map(c=>`<div class="alert-item"><div class="body"><b class="mono">${esc(c.detail.replace(/^CMD /,'').split(' sent over')[0].split(' not sent')[0])}</b><p>${esc(c.detail.replace(/^CMD /,'').replace(/^.*?(sent over GPRS\.|not sent:)/,'$1'))}</p><span class="small muted">${time(c.createdAt)}</span></div><span class="chip ${c.status==='answered'?'ok':c.status==='failed'?'bad':'neutral'} plain">${esc(c.status==='sent'?'sent · waiting for reply':c.status==='queued'?'queued · waiting for the tracker to connect':c.status)}</span></div>`).join(''):'<p class="muted small">No commands sent yet.</p>'}</div>`;
  const run=async(action:string,input:Record<string,unknown>={},label='')=>{
    if(action==='reboot'&&!confirm(`Reboot ${d.name}? It disconnects for about a minute.`))return;
    try{await post(`/admin/devices/${d.id}/command`,{action,...input});toast(`${label||action} sent. The tracker's reply appears in the log.`)}catch(e){toast((e as Error).message,true)}
    void renderDevice();
  };
  on('[data-cmd]',el=>run(el.dataset.cmd!),$('#dp-commands'));
  $$<HTMLFormElement>('[data-form]',$('#dp-commands')).forEach(f=>{
    const values=()=>Object.fromEntries(new FormData(f)) as Record<string,string>;
    f.addEventListener('submit',e=>{e.preventDefault();const v=values();void run(f.dataset.form!,{...v,moving:Number(v.moving),parked:Number(v.parked),port:Number(v.port),on:v.on!=='false',hours:Number(v.hours),minutes:Number(v.minutes),west:v.west==='true'})});
    f.querySelector('[data-sms]')?.addEventListener('click',async()=>{if(!f.reportValidity())return;await navigator.clipboard.writeText(SMS_TEXT[f.dataset.form!](values()));toast('SMS text copied. Send it to the tracker SIM.')});
  });
}
let terminalTimer:ReturnType<typeof setInterval>|undefined,terminalOpen=false;
function renderTerminal(d:AdminDevice){
  const host=$('#dp-terminal');
  host.innerHTML=`<div class="card-pad section-title" style="margin:0"><h2>Live terminal</h2><div class="toolbar"><span class="small muted" id="term-status">${terminalOpen?'Streaming every 3 s':'Raw packets as the receiver saw them'}</span><button class="btn ${terminalOpen?'btn-danger':'btn-primary'} btn-sm" id="term-toggle">${terminalOpen?'Stop':'Open terminal'}</button></div></div><div id="term" class="terminal" ${terminalOpen?'':'hidden'}></div>`;
  clearInterval(terminalTimer);
  const load=async()=>{
    if(!terminalOpen||view!=='device'||!document.querySelector('#term')){clearInterval(terminalTimer);return}
    try{
      const {packets}=await api<{packets:RawPacket[]}>(`/admin/devices/${d.id}/packets?limit=300`);
      const box=$('#term'),atEnd=box.scrollTop+box.clientHeight>=box.scrollHeight-30;
      box.innerHTML=packets.map(p=>`<div class="tline ${p.direction}"><span class="tt">${new Date(p.at).toLocaleTimeString('en-IN',{hour12:false,timeZone:'Asia/Kolkata'})}</span><span class="td">${p.direction==='in'?'◀ IN':p.direction==='out'?'▶ OUT':p.direction==='decoded'?'✓':'•'}</span><span class="tg">${esc(p.tag)}</span>${p.hex?`<span class="th">${esc(p.hex.match(/.{1,2}/g)?.join(' '))}</span>`:''}${p.remote?`<span class="tr">${esc(p.remote)}</span>`:''}</div>`).join('')||'<div class="tline">No packets in the receiver log for this tracker yet.</div>';
      if(atEnd)box.scrollTop=box.scrollHeight;$('#term-status').textContent=`${packets.length} lines · updated ${new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata'})}`;
    }catch(e){$('#term').innerHTML=`<div class="tline">${esc((e as Error).message)}</div>`}
  };
  on('#term-toggle',()=>{terminalOpen=!terminalOpen;renderTerminal(d);if(terminalOpen){void load();terminalTimer=setInterval(()=>void load(),3000)}},host);
  if(terminalOpen){void load();terminalTimer=setInterval(()=>void load(),3000)}
}
const clockOf=(at:number)=>new Date(at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'});

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
    <div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Admin email</th><th>Status</th><th>Since</th><th></th></tr></thead><tbody>${admins.map(a=>`<tr><td><b>${esc(a.email)}</b>${a.email===me.email?' <span class="chip neutral plain">You</span>':''}</td><td><span class="chip ${a.enabled?'ok':'bad'}">${a.enabled?'Active':'Disabled'}</span></td><td>${time(a.createdAt)}</td><td>${a.email===me.email||admins.length<2?'':`<button class="btn btn-danger btn-sm" data-remove="${esc(a.email)}">Remove</button>`}</td></tr>`).join('')}</tbody></table></div></div></div>`;
  $$<HTMLButtonElement>('[data-remove]').forEach(b=>b.onclick=async()=>{const email=b.dataset.remove!;if(!confirm(`Remove admin ${email}? They will no longer be able to sign in.`))return;try{await api(`/admin/admins/${encodeURIComponent(email)}`,{method:'DELETE'});toast('Admin removed.');void renderAdmins()}catch(err){toast((err as Error).message,true)}});
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
/* ---------- Buy GPS requests ---------- */
type GpsRequest={id:string;tenantId:string;customerName:string;name:string;phone:string;vehicles:number;product:string;note:string;status:string;createdAt:number};
const PRODUCT_LABEL:Record<string,string>={wired:'Truck GPS (wired)',portable:'Portable GPS (magnetic)',phone:'Driver phone tracking'};
async function renderRequests(){
  let list:GpsRequest[];try{list=(await api<{requests:GpsRequest[]}>('/admin/requests')).requests}catch(e){fail(e);return}
  if(view!=='requests')return;
  const fresh=list.filter(r=>r.status==='new').length;
  $('#view').innerHTML=`<div class="page">
    <div class="ax-kpis"><div class="cx-kpi ${fresh?'warn':''}"><span class="cx-kpi-label">New requests${i('shopping-cart')}</span><b>${fresh}</b><span class="cx-kpi-note">waiting for a call</span></div><div class="cx-kpi"><span class="cx-kpi-label">All requests${i('list')}</span><b>${list.length}</b><span class="cx-kpi-note">${list.reduce((s,r)=>s+r.vehicles,0)} vehicles asked for</span></div></div>
    <div class="card">${list.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Received</th><th>Customer</th><th>Contact</th><th>GPS type</th><th>Vehicles</th><th>Note</th><th>Status</th></tr></thead><tbody>${list.map(r=>`<tr><td>${time(r.createdAt)}</td><td><b>${esc(r.customerName||'—')}</b></td><td><b>${esc(r.name)}</b><small><a href="tel:${esc(r.phone)}">${esc(r.phone)}</a> · <a href="https://wa.me/${esc(r.phone.replace(/^\+?(?=\d{10}$)/,'91').replace('+',''))}" target="_blank" rel="noopener">WhatsApp</a></small></td><td>${esc(PRODUCT_LABEL[r.product]||r.product)}</td><td>${r.vehicles}</td><td>${esc(r.note||'—')}</td><td><select class="input" data-status="${r.id}" style="min-height:36px">${['new','contacted','done'].map(s=>`<option value="${s}" ${r.status===s?'selected':''}>${s==='new'?'New':s==='contacted'?'Contacted':'Done'}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty">${i('shopping-cart')}<h3>No requests yet</h3><p>When a customer asks for GPS from the app it shows here.</p></div>`}</div></div>`;
  $$<HTMLSelectElement>('[data-status]').forEach(sel=>sel.onchange=async()=>{try{await api(`/admin/requests/${sel.dataset.status}`,{method:'PATCH',body:JSON.stringify({status:sel.value})});toast('Saved.')}catch(e){toast((e as Error).message,true)}});
  icons();
}
function renderMore(){
  $('#view').innerHTML=`<div class="page"><div class="cx-tiles">${[['requests','Buy GPS requests','shopping-cart','Customers asking for GPS'],['admins','Admins','shield-check','Create admin users'],['settings','Settings','settings','Password and sign out']].map(([v,l,ic,h])=>`<button data-go="${v}"><span class="cx-tile">${i(ic)}</span><b>${l}</b><small>${h}</small></button>`).join('')}</div>
    <button class="cx-btn sos-soft" data-logout>${i('log-out')}Sign out</button></div>`;
  on('#view [data-go]',el=>go(el.dataset.go as View));on('#view [data-logout]',logout);icons();
}

/* ---------- Engine relay: installation record (admin) and lock / unlock ---------- */
type RelayStatus={enabled:boolean;supported:boolean;error:string|null;installation:{installer:string;verifiedAt:number;wiring?:string}|null;history:{action:string;status:string;detail:string;createdAt:number}[]};
async function relayDialog(d:AdminDevice){
  const status=await api<RelayStatus>(`/devices/${d.id}/relay`);
  const ready=status.enabled&&status.supported&&!!status.installation;
  const keyLabel=me.email?'Your admin password':'Maintenance key';
  const wiring=status.installation?.wiring==='fuel'?'Fuel pump / ignition':'Starter';
  modal(`${d.name} · Engine relay`,`<p class="error">Lock is only sent when the vehicle is parked (online, engine off for a minute, no movement for 3 minutes). Unlock goes any time. The tracker does not confirm the physical relay.</p>
    ${!status.enabled?'<p class="muted">Relay commands are switched off on this server (GPS_RELAY_ENABLED).</p>':''}${status.error?`<p class="error">${esc(status.error)}</p>`:''}
    <dl class="facts"><dt>Gateway support</dt><dd>${status.supported?'Supported':'Not available'}</dd><dt>Installation</dt><dd>${status.installation?`${wiring} · ${esc(status.installation.installer)} · ${time(status.installation.verifiedAt)}`:'Not fitted / not tested'}</dd></dl>
    <form class="form" id="relay-command"><label class="field">Action<select class="input" name="action"><option value="inhibit">Lock engine</option><option value="restore">Unlock engine</option></select></label>
      <label class="field">Type the IMEI or vehicle number to confirm<input class="input mono" name="confirmation" required autocomplete="off" placeholder="${esc(d.uniqueId)}"></label><label class="field">Reason<input class="input" name="reason" required maxlength="300"></label>
      <label class="field">${keyLabel}<input class="input" name="adminKey" type="password" required autocomplete="off"></label><button class="btn btn-danger" type="submit" ${ready?'':'disabled'}>Send relay command</button><p id="relay-result" class="small"></p></form>
    <details ${status.installation?'':'open'}><summary>Relay fitting record</summary><form class="form" id="relay-install" style="margin-top:10px">
      <label class="field">Relay wired on<select class="input" name="wiring"><option value="fuel" ${status.installation?.wiring!=='starter'?'selected':''}>Fuel pump / ignition wire (cuts the engine)</option><option value="starter" ${status.installation?.wiring==='starter'?'selected':''}>Starter wire (blocks the next start)</option></select></label>
      <label class="field">Installer / reference<input class="input" name="installer" required maxlength="200" value="${esc(status.installation?.installer||'')}"></label>
      <label class="check"><input type="checkbox" name="polarityVerified" required>Tested once on the parked vehicle: lock stops the engine, unlock lets it start</label>
      <label class="check"><input type="checkbox" name="parkedOnly">I understand a fuel / ignition relay stops a running engine; lock is only for a parked vehicle</label>
      <label class="field">${keyLabel}<input class="input" name="adminKey" type="password" required autocomplete="off"></label><button class="btn btn-ghost" type="submit">Save fitting record</button>${status.installation?'<button class="btn btn-danger" type="button" id="relay-remove">Remove relay</button>':''}<p class="error" id="relay-install-error"></p></form></details>
    <h3>Recent commands</h3>${status.history.map(c=>`<p class="small"><b>${esc(c.action==='inhibit'?'Lock':'Unlock')} · ${esc(c.status)}</b> · ${time(c.createdAt)}<br>${esc(c.detail)}</p>`).join('')||'<p class="muted small">None.</p>'}`,{wide:true});
  const requestId=crypto.randomUUID();
  $('#relay-command').addEventListener('submit',async e=>{e.preventDefault();const form=e.target as HTMLFormElement;try{const r=await post<{status:string;detail:string}>(`/devices/${d.id}/relay`,{...Object.fromEntries(new FormData(form)),requestId});$('#relay-result').textContent=`${r.status}: ${r.detail}`}catch(err){$('#relay-result').textContent=(err as Error).message}finally{form.querySelector<HTMLInputElement>('[name=adminKey]')!.value=''}});
  document.querySelector('#relay-remove')?.addEventListener('click',async()=>{const form=$<HTMLFormElement>('#relay-install'),key=form.querySelector<HTMLInputElement>('[name=adminKey]')!.value;if(!key){$('#relay-install-error').textContent='Enter your password first.';return}try{await api(`/devices/${d.id}/relay`,{method:'PUT',body:JSON.stringify({enabled:false,adminKey:key})});await relayDialog(d)}catch(err){$('#relay-install-error').textContent=(err as Error).message}});
  $('#relay-install').addEventListener('submit',async e=>{e.preventDefault();const form=e.target as HTMLFormElement,f=new FormData(form);try{await api(`/devices/${d.id}/relay`,{method:'PUT',body:JSON.stringify({installer:f.get('installer'),adminKey:f.get('adminKey'),wiring:f.get('wiring'),parkedOnly:f.has('parkedOnly'),polarityVerified:f.has('polarityVerified')})});await relayDialog(d)}catch(err){$('#relay-install-error').textContent=(err as Error).message;form.querySelector<HTMLInputElement>('[name=adminKey]')!.value=''}});
}
