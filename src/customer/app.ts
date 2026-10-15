import {$,$$,api,post,chip,clock,closeModal,coords,esc,hm,i,icons,localInput,mapsLink,modal,on,since,statusLabel,statusLine,statusOf,time,ago,toast,whenUnauthorized,type Alert,type Fence,type Fix,type Identity,type StatusKey,type Vehicle} from '../shared/core';
import {bearing,createMap,drawRoute,fleetIcon,playbackIcon,point,L} from '../shared/map';
import {placeSpan,places,placeKey} from '../shared/places';
import {nearest,nearText,nearSaved,placeIcon,PLACE_KIND} from '../shared/poi';
import {googleModal} from '../shared/google';
import {googleLive,type GoogleLive} from '../shared/gview';
import {t,getLang,setLang,locale,LANGS,type Lang} from '../shared/i18n';
import {DEMO_MODE,workspaceStorage} from '../demo';
import {showLogin} from '../auth';
import {CATEGORIES,alertText,announceNew,askBrowserPermission,browserState,browserSupported,categoryOf,mergeNotify,primeSeen,speakAlert,unlockVoice,voiceSupported,type Category,type NotifyPrefs} from './notify';

type View='map'|'vehicles'|'history'|'reports'|'alerts'|'geofences'|'documents'|'ebills'|'settings'|'more';
type Fleet={devices:Vehicle[];fences:Fence[];alerts:Alert[]};
type Gap={from:number;to:number;minutes:number;movedKm:number|null};
type DayReport={date:string;distanceKm:number;runningMinutes:number;idleMinutes:number;ignitionMinutes:number;maxSpeed:number;avgSpeed:number;firstMove:number|null;lastMove:number|null;gaps:Gap[]};
type VehicleReport={id:string;name:string;total:{distanceKm:number;runningMinutes:number;idleMinutes:number;maxSpeed:number;avgSpeed:number;gapMinutes:number};days:DayReport[]};
// Distance is only what the tracker reported. When it went silent, say so instead of guessing.
const gapNote=(g:Gap)=>`${t('Tracker sent no data {a} – {b} ({d})',{a:clock(g.from),b:clock(g.to),d:hm(g.minutes)})}${g.movedKm?` · ${t('moved {n} km in this time',{n:g.movedKm})}`:''} · ${t('km in this period is not recorded')}`;
type Prefs={name:string;workspace:string;follow:boolean;defaultView:View;notify?:Partial<NotifyPrefs>};
const notifyPrefs=():NotifyPrefs=>mergeNotify(prefs().notify);
async function saveNotify(next:NotifyPrefs){await workspaceStorage.setItem('workspace-preferences',JSON.stringify({...prefs(),notify:next}))}
const APP_VERSION='2.0';

// Menu in plain groups: what you watch, what tells you something, what you look after, your account.
const GROUPS:[string,[View,string,string][]][]=[
  ['Tracking',[['vehicles','My vehicles','truck'],['map','Live map','map'],['history','Route history','route']]],
  ['Alerts & reports',[['alerts','Alerts','bell'],['reports','Reports','chart-column']]],
  ['Manage',[['geofences','Places','map-pin'],['documents','Documents','files'],['ebills','E-way bills','file-text']]],
  ['Account',[['settings','Settings','settings']]],
];
const NAV=GROUPS.flatMap(([,items])=>items);
const HINTS:Partial<Record<View,string>>={alerts:'Engine, SOS, overspeed, signal',reports:'Distance, running and idle time',geofences:'Petrol pumps, dhabas, depots',documents:'RC, insurance, permits',ebills:'E-way bills for your trips',settings:'Notifications, overspeed, language, password'};
const TABS:[View,string,string][]=[['vehicles','Vehicles','truck'],['map','Map','map'],['history','History','route'],['alerts','Alerts','bell'],['more','Menu','menu']];
const ROOT:View[]=['map','vehicles','history','alerts','more'];
const TITLES:Record<View,string>={map:'Live map',vehicles:'My vehicles',history:'Route history',reports:'Reports',alerts:'Alerts',geofences:'Places',documents:'Documents',ebills:'E-way bills',settings:'Settings',more:'Menu'};

let me:Identity,fleet:Fleet={devices:[],fences:[],alerts:[]},view:View='vehicles',selected='',filter:StatusKey|'all'='all',search='',following=false,fitted=false;
let poll:ReturnType<typeof setTimeout>|undefined,teardown:(()=>void)|undefined;

function prefs():Prefs{
  const defaults:Prefs={name:me?.name||'',workspace:t('My fleet'),follow:false,defaultView:'vehicles'};
  try{const saved=JSON.parse(workspaceStorage.getItem('workspace-preferences')||'{}');return {...defaults,...saved,defaultView:NAV.some(([v])=>v===saved.defaultView)?saved.defaultView:'vehicles'}}catch{return defaults}
}
const openAlerts=()=>fleet.alerts.filter(a=>!a.acknowledged).length;
const vehicle=(id:string)=>fleet.devices.find(d=>d.id===id);
const counts=()=>{const c:Record<string,number>={all:fleet.devices.length};for(const d of fleet.devices){const s=statusOf(d);c[s]=(c[s]||0)+1}return c};
const visible=()=>fleet.devices.filter(d=>(filter==='all'||statusOf(d)===filter||(filter==='stopped'&&statusOf(d)==='idle'))&&`${d.name} ${d.driver}`.toLowerCase().includes(search.toLowerCase()));
const overspeeding=(d:Vehicle)=>statusOf(d)==='running'&&!!d.position&&d.position.speed>d.speedLimit;
const initial=(s:string)=>esc((s||'W').trim().charAt(0).toUpperCase());

export async function startCustomer(identity:Identity){
  me=identity;following=prefs().follow;
  whenUnauthorized(()=>{stop();showLogin(t('Your session ended. Please sign in again.'))});
  const requested=new URLSearchParams(location.search).get('view') as View|null;
  view=requested&&(NAV.some(([v])=>v===requested)||requested==='more')?requested:prefs().defaultView;
  try{fleet=await api<Fleet>('/state')}catch(e){$('#app').innerHTML=`<div class="empty">${i('wifi-off')}<h3>${t('Could not load your fleet')}</h3><p>${esc((e as Error).message)}</p><button class="btn btn-primary" id="retry">${t('Retry')}</button></div>`;on('#retry',()=>location.reload());icons();return}
  selected=new URLSearchParams(location.search).get('vehicle')||'';
  primeSeen(fleet.alerts);document.addEventListener('click',unlockVoice,{once:true});
  window.addEventListener('popstate',()=>{const v=new URLSearchParams(location.search).get('view') as View|null;go(v||prefs().defaultView,false)});
  shell();schedule();
}
function stop(){clearTimeout(poll);teardown?.();teardown=undefined}
// Short polls keep the map, alerts and voice close to real time (the gateway pushes within ~1 s).
function schedule(){clearTimeout(poll);poll=setTimeout(refresh,document.hidden?5000:2000)}
async function refresh(){
  try{fleet=await api<Fleet>('/state');remember(fleet.devices);announceNew(fleet.alerts,notifyPrefs());updateBadges();if(view==='map')updateLive();else if(view==='vehicles')renderVehicles();else if(view==='alerts')renderAlerts()}
  catch{/* keep showing the last data; the next poll retries */}
  finally{schedule()}
}
function go(next:View,push=true){
  if(push){const url=new URL(location.href);url.searchParams.set('view',next);url.searchParams.delete('vehicle');history.pushState(null,'',url)}
  view=next;shell();schedule();
}
function openOnMap(id:string){
  selected=id;const url=new URL(location.href);url.searchParams.set('view','map');url.searchParams.set('vehicle',id);history.pushState(null,'',url);view='map';shell();schedule();
}

const brandBlock=()=>`<a class="brand" href="/?live=1"><span class="mark">${i('truck')}</span><span class="brand-text"><b>Waypoint</b><small>${t('Live fleet')}</small></span></a>`;
function shell(){
  stop();
  const p=prefs(),badge=openAlerts(),live=fleet.devices.filter(d=>d.online).length;
  $('#app').innerHTML=`<div class="app customer">
    <aside class="sidebar">${brandBlock()}
      <nav class="nav">${GROUPS.map(([group,items])=>`<div class="nav-group"><span class="nav-title">${t(group)}</span>${items.map(([v,label,icon])=>`<button data-go="${v}" class="${view===v?'on':''}">${i(icon)}${t(label)}${v==='alerts'?`<span class="badge" data-alert-badge ${badge?'':'hidden'}>${badge}</span>`:''}</button>`).join('')}</div>`).join('')}</nav>
      <div class="foot who-foot"><span class="avatar">${initial(p.workspace)}</span><div class="who-text"><strong>${esc(p.workspace)}</strong><small>${esc(me.email||p.name)}</small></div><button class="icon-btn" data-logout title="${t('Sign out')}" aria-label="${t('Sign out')}">${i('log-out')}</button></div>
    </aside>
    <div class="main">
      <header class="mobile-head">${ROOT.includes(view)?`${brandBlock()}<span class="live-pill"><i class="dot"></i>${t('{n} vehicles',{n:fleet.devices.length})}</span>`:`<button class="mh-back" data-go="more" aria-label="${t('Back')}">${i('chevron-left')}<span>${t(TITLES[view])}</span></button>`}
        <span class="mh-actions"><button class="icon-btn ghost" data-go="alerts" aria-label="${t('Alerts')}">${i('bell')}<span class="badge" data-alert-badge ${badge?'':'hidden'}>${badge}</span></button><button class="avatar-btn" data-go="settings" aria-label="${t('Settings')}">${i('user-round')}</button></span></header>
      <header class="topbar"><div class="title"><h1>${t(TITLES[view])}</h1><small>${esc(p.workspace)} · ${t('{n} vehicles',{n:fleet.devices.length})} · ${t('{n} live',{n:live})}</small></div>
        <div class="toolbar">${view!=='map'?`<button class="btn btn-ghost" data-go="map">${i('map')}${t('Live map')}</button>`:''}</div></header>
      <div id="view"></div>
    </div>
    <nav class="tabbar">${TABS.map(([v,label,icon])=>`<button data-go="${v}" class="${view===v||(v==='more'&&!ROOT.includes(view))?'on':''}">${i(icon)}<span>${t(label)}</span>${v==='alerts'?`<span class="badge" data-alert-badge ${badge?'':'hidden'}>${badge}</span>`:''}</button>`).join('')}</nav>
  </div>`;
  on('[data-go]',el=>go(el.dataset.go as View));
  on('[data-logout]',logout);
  ({map:renderLive,vehicles:renderVehicles,history:renderHistory,reports:renderReports,alerts:renderAlerts,geofences:renderGeofences,documents:()=>renderDocuments('Documents'),ebills:()=>renderDocuments('E-way bills'),settings:renderSettings,more:renderMore} as Record<View,()=>void>)[view]();
  icons();
}
function updateBadges(){const n=openAlerts();$$('[data-alert-badge]').forEach(b=>{b.textContent=String(n);b.hidden=!n})}
async function logout(){if(!DEMO_MODE)await api('/session',{method:'DELETE'}).catch(()=>{});location.href='/?live=1&auth=customer'}

// Status filter pills shared by the vehicle list and the map.
function filterPills(c:Record<string,number>){
  const keys:(StatusKey|'all')[]=['all','running','stopped','offline','nofix'];
  return keys.filter(k=>k==='all'||k==='running'||(c[k]||0)>0||(k==='stopped'&&(c.idle||0)>0)).map(k=>{
    const n=k==='all'?c.all:k==='stopped'?(c.stopped||0)+(c.idle||0):c[k]||0;
    return `<button data-filter="${k}" class="pill ${filter===k?'on':''}">${k==='all'?t('All vehicles'):`<i class="dot" style="background:var(--${k})"></i>${k==='stopped'?t('Standing'):statusLabel(k)}`} <b>${n}</b></button>`;
  }).join('');
}

/* ---------- Vehicles (home) ---------- */
function renderVehicles(){
  const c=counts(),list=visible(),host=$('#view');
  const focused=document.activeElement?.id==='vq';
  const standing=(c.stopped||0)+(c.idle||0),alerts=openAlerts();
  host.innerHTML=`<div class="page home">
    <div class="page-head"><div><h1>${t('My vehicles')}</h1><p class="muted">${t('Real-time GPS updates · auto refresh on')}</p></div><button class="icon-btn" id="vrefresh" aria-label="${t('Refresh')}">${i('refresh-cw')}</button></div>
    <div class="stat-grid">
      <div class="stat"><span>${t('Total vehicles')}</span><b>${c.all}</b><em class="si">${i('truck')}</em></div>
      <div class="stat"><span>${t('Moving')}</span><b>${c.running||0}<i class="dot" style="background:var(--running)"></i></b><em class="si run">${i('navigation')}</em></div>
      <div class="stat"><span>${t('Standing')}</span><b>${standing}<i class="dot" style="background:var(--stopped)"></i></b><em class="si">${i('pause')}</em></div>
      <button class="stat" data-go="alerts"><span>${t('Alerts / attention')}</span><b>${alerts}<i class="dot" style="background:var(--sos)"></i></b><em class="si sos">${i('triangle-alert')}</em></button>
    </div>
    <div class="pills" id="vfilters">${filterPills(c)}</div>
    <label class="search">${i('search')}<input class="input" id="vq" placeholder="${t('Search vehicle number or driver name…')}" value="${esc(search)}"></label>
    <div class="vgrid">${list.map(vehicleCard).join('')||`<div class="card empty">${i('truck')}<h3>${t(fleet.devices.length?'No vehicles match':'No vehicles yet')}</h3><p>${t(fleet.devices.length?'Try another filter.':'Your fleet administrator will add your GPS devices here.')}</p></div>`}</div></div>`;
  const input=$<HTMLInputElement>('#vq');input.oninput=()=>{search=input.value;renderVehicles()};
  if(focused){input.focus();input.setSelectionRange(input.value.length,input.value.length)}
  on('[data-filter]',el=>{filter=el.dataset.filter as StatusKey|'all';renderVehicles()},host);
  on('[data-live]',el=>openOnMap(el.dataset.live!),host);
  on('[data-history]',el=>{historyVehicle=el.dataset.history!;go('history')},host);
  on('#vrefresh',()=>refresh());
  on('[data-go]',el=>go(el.dataset.go as View),host);
  icons();
}
function vehicleCard(d:Vehicle){
  const p=d.position,s=statusOf(d),over=overspeeding(d);
  const parked=(s==='stopped'||s==='idle')&&d.stoppedSince?`${t(s==='idle'?'Idle':'Standing')} · ${since(d.stoppedSince)}`:'';
  return `<article class="vcard2 s-${s} ${over?'over':''}">
    <div class="vc-top"><span class="vc-ico">${i(over?'gauge':'truck')}</span><div class="vc-id"><h3 class="plate">${esc(d.name)}</h3>${d.driver?`<span class="muted">${i('user-round')}${esc(d.driver)}</span>`:''}</div>${over?`<span class="chip sos">⚠ ${t('Overspeed')}</span>`:chip(d)}</div>
    ${over&&p?`<div class="vc-speed">${i('gauge')}<b>${Math.round(p.speed)} km/h</b><span>${t('Allowed limit: {n} km/h',{n:d.speedLimit})}</span></div>`:''}
    <div class="vc-place">${i('map-pin')}<div><b>${placeSpan(p,d.id)}</b><small>${t('Last update: {a}',{a:ago(p?.recordedAt??d.lastSeen)})}${parked?` · ${esc(parked)}`:''}</small></div></div>
    <div class="vc-meta"><span class="tag ${d.ignition?'on':''}">${i('key-round')}${d.ignition==null?t('Ignition —'):d.ignition?t('Ignition on'):t('Ignition off')}</span>${s==='running'&&p&&!over?`<span class="tag on">${i('gauge')}${Math.round(p.speed)} km/h</span>`:''}${d.isMobile?`<span class="tag">${i('smartphone')}${t('Driver phone')}</span>`:''}</div>
    <div class="vc-acts"><button class="btn ${over?'btn-sos':'btn-primary'}" data-live="${d.id}">${i('map')}${t('Live map')}</button><button class="btn btn-soft" data-history="${d.id}">${i('route')}${t('Route history')}</button></div>
  </article>`;
}

/* ---------- Live map ---------- */
let map:L.Map|undefined,markers:L.LayerGroup|undefined,fences:L.LayerGroup|undefined;
const todayKm=new globalThis.Map<string,{at:number;km:number|null}>();
// "Near Indian Oil petrol pump · 120 m" for each position shown in the vehicle sheet.
const nearCache=new globalThis.Map<string,string>();
// Google view: Google's own map (with all its places) around the selected vehicle, instead of ours.
let googleView=false,glive:GoogleLive|undefined;
// Recent path of each vehicle while the app is open, drawn behind the selected truck in Google view.
const trails=new globalThis.Map<string,{latitude:number;longitude:number;at:number}[]>();
function remember(devices:Vehicle[]){
  const cutoff=Date.now()-60*60000;
  for(const d of devices){const p=d.position;if(!p||p.valid===0)continue;const tr=trails.get(d.id)||[];if(!tr.length||tr.at(-1)!.at!==p.recordedAt)tr.push({latitude:p.latitude,longitude:p.longitude,at:p.recordedAt});while(tr.length&&(tr[0].at<cutoff||tr.length>400))tr.shift();trails.set(d.id,tr)}
}
try{googleView=localStorage.getItem('waypoint.googleView')==='1'}catch{/* private mode */}
function renderLive(){
  $('#view').innerHTML=`<div class="live" id="live">
    <section class="live-panel" id="panel">
      <div class="panel-head"><label class="search">${i('search')}<input class="input" id="q" placeholder="${t('Search vehicle number or driver…')}" value="${esc(search)}"><span class="live-count" id="livecount"></span></label><div class="pills" id="filters"></div></div>
      <div class="vlist" id="vlist"></div></section>
    <div class="map-wrap"><div class="map" id="map"></div>
      <div class="map-tools"><button class="fab ${googleView?'on':''}" id="gview" title="${t('Google view with nearby places')}" aria-label="${t('Google view with nearby places')}">${i('layers')}</button><button class="fab ${following?'on':''}" id="follow" title="${t('Follow selected vehicle')}" aria-label="${t('Follow selected vehicle')}">${i('locate-fixed')}</button><button class="fab" id="fit" title="${t('Show all vehicles')}" aria-label="${t('Show all vehicles')}">${i('scan')}</button></div>
      <div class="gwrap" id="gwrap" hidden></div>
      <div class="vsheet" id="vsheet" hidden></div>
      <div class="others" id="others"></div></div></div>`;
  map=createMap($('#map'));markers=L.layerGroup().addTo(map);fences=L.layerGroup().addTo(map);fitted=false;
  teardown=()=>{map?.remove();map=undefined;glive?.destroy();glive=undefined};
  glive=googleLive($('#gwrap'),{onSelect:id=>select(id),covered:()=>matchMedia('(max-width:900px)').matches?(document.querySelector<HTMLElement>('#vsheet:not([hidden])')?.offsetHeight||document.querySelector<HTMLElement>('#others')?.offsetHeight||0):0});
  on('#gview',()=>setGoogleView(!googleView));
  $<HTMLInputElement>('#q').oninput=e=>{search=(e.target as HTMLInputElement).value;updateLive()};
  on('#fit',fit);on('#follow',el=>{following=!following;el.classList.toggle('on',following);const v=vehicle(selected);if(following&&v?.position)map?.panTo(point(v.position))});
  updateLive();
  // The flexible phone layout settles after the first paint; measure the map again then.
  requestAnimationFrame(()=>{map?.invalidateSize();if(selected&&vehicle(selected)?.position)select(selected);else fit()});
}
function fit(){
  const pts=visible().flatMap(d=>d.position?[point(d.position)]:[]);if(!pts.length||!map)return;
  // On phones the vehicle strip covers the lower part of the map; keep trucks above it.
  const strip=matchMedia('(max-width:900px)').matches?document.querySelector<HTMLElement>('#others')?.offsetHeight||0:0;
  map.fitBounds(pts,{paddingTopLeft:[60,90],paddingBottomRight:[60,70+strip],maxZoom:16});
}
function select(id:string){
  selected=id;const v=vehicle(id);
  $('#live')?.classList.toggle('sheet-open',!!id);
  updateLive();
  // On phones the search bar hides while a vehicle is open, so the map grows; measure it again.
  map?.invalidateSize();
  if(v?.position&&map)centre(v.position,Math.max(16,map.getZoom()));
}
// Keep the vehicle in the open part of the map, above the detail card on phones.
function centre(p:{latitude:number;longitude:number},zoom=map?.getZoom()){
  if(!map)return;
  const card=matchMedia('(max-width:900px)').matches?document.querySelector<HTMLElement>('#vsheet')?.offsetHeight||0:0;
  map.setView(point(p),zoom,{animate:false});
  if(card)map.panBy([0,card/2],{animate:false});
}
function setGoogleView(on:boolean){
  googleView=on;document.querySelector('#gview')?.classList.toggle('on',on);
  try{localStorage.setItem('waypoint.googleView',on?'1':'0')}catch{/* private mode */}
  updateLive();if(!on)map?.invalidateSize();
}
function updateLive(){
  if(!map||!markers)return;
  const c=counts(),list=visible();
  $('#filters').innerHTML=filterPills(c);
  $('#livecount').innerHTML=`<i class="dot"></i>${t('{n} live',{n:fleet.devices.filter(d=>d.online).length})}`;
  on('[data-filter]',el=>{filter=el.dataset.filter as StatusKey|'all';updateLive()},$('#filters'));
  $('#vlist').innerHTML=list.length?list.map(miniCard).join(''):`<div class="empty">${i('truck')}<h3>${t(fleet.devices.length?'No vehicles match':'No vehicles yet')}</h3><p>${t(fleet.devices.length?'Try another filter.':'Your fleet administrator will add your GPS devices here.')}</p></div>`;
  on('[data-vehicle]',el=>select(el.dataset.vehicle!),$('#vlist'));
  // Phones: the other vehicles as a swipeable strip under the map while nothing is selected.
  const others=list.filter(d=>d.id!==selected);
  $('#others').innerHTML=others.length?`<div class="others-head"><b>${t(selected?'Other vehicles':'Vehicles')}</b><button class="linkish" data-go-list>${t('Open list')}</button></div><div class="others-row">${others.map(miniCard).join('')}</div>`:'';
  on('[data-vehicle]',el=>select(el.dataset.vehicle!),$('#others'));
  on('[data-go-list]',()=>go('vehicles'),$('#others'));
  markers.clearLayers();
  // Bubbles and plates only where they stay readable: the selected vehicle, or a very small fleet.
  const labels=(d:Vehicle)=>d.id===selected||(!selected&&list.length<=3);
  for(const d of list){
    if(!d.position)continue;
    L.marker(point(d.position),{icon:fleetIcon(d,d.id===selected,labels(d)),title:d.name,zIndexOffset:d.id===selected?1000:overspeeding(d)?500:0}).addTo(markers).on('click',()=>select(d.id));
  }
  fences!.clearLayers();
  // The customer's own places stay labelled, so depots and regular stops are always recognisable.
  for(const f of fleet.fences)L.circle(point(f),{radius:f.radius,color:'#0d5c52',weight:2,fillOpacity:.06}).bindTooltip(`${placeIcon(f.kind)} ${esc(f.name)}`,{permanent:true,direction:'center',className:'fence-label'}).addTo(fences!);
  if(!fitted&&list.some(d=>d.position)&&!selected){fit();fitted=true}
  const v=vehicle(selected);
  renderSheet();icons();
  if(following&&v?.position)centre(v.position);
  // Google view follows the selected vehicle, or the first one with a position.
  $('#gwrap').hidden=!googleView;$('#map').style.visibility=googleView?'hidden':'';
  if(googleView)glive?.update(list,selected,selected?trails.get(selected):[]);
}
function miniCard(d:Vehicle){
  const p=d.position,s=statusOf(d),over=overspeeding(d);
  const state=over&&p?`⚠ ${Math.round(p.speed)} km/h · ${t('Overspeed')}`:s==='running'&&p?`${Math.round(p.speed)} km/h`:(s==='stopped'||s==='idle')&&d.stoppedSince?`${t(s==='idle'?'Idle':'Standing')} · ${since(d.stoppedSince)}`:statusLabel(s);
  return `<button class="mini s-${s} ${over?'over':''} ${d.id===selected?'on':''}" data-vehicle="${d.id}">
    <span class="mini-top"><b class="plate">${esc(d.name)}</b><i class="dot" style="background:var(--${over?'sos':s})"></i></span>
    <span class="mini-state">${esc(state)}</span>
    <span class="mini-place">${placeSpan(p,d.id,{short:true})}</span></button>`;
}
function renderSheet(){
  const el=document.querySelector<HTMLElement>('#vsheet');if(!el)return;
  const d=vehicle(selected);if(!d){el.hidden=true;$('#others')?.classList.remove('behind');return}
  $('#others')?.classList.add('behind');
  const p=d.position,km=todayKm.get(d.id),s=statusOf(d),over=overspeeding(d);
  if(!km||Date.now()-km.at>60000)void loadTodayKm(d.id);
  const mine=p?nearSaved(p.latitude,p.longitude,fleet.fences):null;
  if(p&&!mine&&!nearCache.has(placeKey(p))){const key=placeKey(p);nearCache.set(key,'');void nearest(p.latitude,p.longitude).then(n=>{if(n){nearCache.set(key,nearText(n));if(selected===d.id)renderSheet()}})}
  const near=mine||(p?nearCache.get(placeKey(p)):'');
  el.hidden=false;
  el.innerHTML=`<div class="grab"></div>
    <div class="sh-head"><div><h2 class="plate">${esc(d.name)}</h2><div class="sh-sub">${over?`<span class="chip sos">⚠ ${t('Overspeed')}</span>`:chip(d)}${d.driver?`<span class="muted">${i('user-round')}${esc(d.driver)}</span>`:''}</div></div><button class="icon-btn round" id="sheet-share" aria-label="${t('Share')}">${i('share-2')}</button><button class="icon-btn round" id="close-sheet" aria-label="${t('Close')}">${i('x')}</button></div>
    <div class="vc-place">${i('map-pin')}<div><b>${placeSpan(p,d.id)}</b>${near?`<small class="near">${esc(near)}</small>`:''}<small>${esc(statusLine(d))} · ${t('Last GPS signal: {a}',{a:ago(p?.recordedAt??d.lastSeen)})}</small></div></div>
    <div class="sh-stats">
      <div><span>${t('Speed')}</span><b class="${over?'bad':''}">${p&&d.fresh?Math.round(p.speed):0} <small>km/h</small></b><small>${t('Limit {n}',{n:d.speedLimit})}</small></div>
      <div><span>${t('Today')}</span><b>${km?.km==null?'…':km.km} <small>km</small></b><small>${t('Distance')}</small></div>
      <div><span>${t('Ignition')}</span><b class="${d.ignition?'good':''}">${d.ignition==null?'—':d.ignition?t('On'):t('Off')}</b><small>${(s==='stopped'||s==='idle')&&d.stoppedSince?since(d.stoppedSince):statusLabel(s)}</small></div>
    </div>
    <div class="sh-acts"><button class="btn btn-primary" id="sheet-history">${i('history')}${t('Route history')}</button><button class="btn btn-soft ${googleView?'on':''}" id="sheet-google">${i('layers')}${t(googleView?'Our map':'Google view')}</button></div>
    <div class="qa">${p?`<button id="sheet-save">${i('map-pin')}<span>${t('Save place')}</span></button>`:''}<button id="sheet-speed">${i('gauge')}<span>${d.speedLimit} km/h${d.speedAlert===false?` ${t('off')}`:''}</span></button>${d.isMobile?`<button id="sheet-driver">${i('smartphone')}<span>${t('Driver link')}</span></button>`:''}${p?`<a href="${mapsLink(p)}" target="_blank" rel="noopener">${i('navigation')}<span>${t('Directions')}</span></a>`:''}</div>`;
  on('#close-sheet',()=>{selected='';$('#live').classList.remove('sheet-open');updateLive();map?.invalidateSize()},el);
  on('#sheet-history',()=>{historyVehicle=d.id;go('history')},el);
  on('#sheet-share',async()=>{if(!p)return;const text=`${d.name}: ${places.get(placeKey(p))?.label||coords(p)}\n${mapsLink(p)}`;if(navigator.share)await navigator.share({title:d.name,text}).catch(()=>{});else{await navigator.clipboard.writeText(text);toast(t('Location copied.'))}},el);
  on('#sheet-driver',()=>driverLink(d),el);
  on('#sheet-speed',()=>speedSettings(d),el);
  on('#sheet-google',()=>setGoogleView(!googleView),el);
  on('#sheet-save',()=>addFence({latitude:p!.latitude,longitude:p!.longitude,radius:150}),el);
  icons();
}
const dayStart=(offset=0)=>{const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()+offset);return d};
async function loadTodayKm(id:string){
  todayKm.set(id,{at:Date.now(),km:todayKm.get(id)?.km??null});
  try{const r=await reports(dayStart(),new Date(),id);todayKm.set(id,{at:Date.now(),km:r.vehicles[0]?.total.distanceKm??0});if(selected===id)renderSheet()}catch{/* shown as … */}
}
function reports(from:Date,to:Date,device?:string){
  return api<{vehicles:VehicleReport[]}>(`/reports?${new URLSearchParams({from:from.toISOString(),to:to.toISOString(),tz:String(new Date().getTimezoneOffset()),...(device?{device}:{})})}`);
}

/* ---------- History ---------- */
let historyVehicle='',track:Fix[]=[],playTimer:ReturnType<typeof setInterval>|undefined;
function rangeFor(preset:string):[Date,Date]{
  if(preset==='yesterday')return [dayStart(-1),dayStart()];
  if(preset==='week')return [dayStart(-6),new Date()];
  if(preset==='month'){const d=dayStart();d.setDate(1);return [d,new Date()]}
  return [dayStart(),new Date()];
}
function renderHistory(){
  historyVehicle=historyVehicle||selected||fleet.devices[0]?.id||'';
  const [from,to]=rangeFor('today');
  $('#view').innerHTML=`<div class="history"><aside class="side">
      <label class="field">${t('Vehicle')}<select class="input" id="hv">${fleet.devices.map(d=>`<option value="${d.id}" ${d.id===historyVehicle?'selected':''}>${esc(d.name)}</option>`).join('')}</select></label>
      <div class="pills" id="presets">${[['today','Today'],['yesterday','Yesterday'],['week','Last 7 days'],['custom','Custom']].map(([k,l],n)=>`<button data-preset="${k}" class="pill ${n?'':'on'}">${t(l)}</button>`).join('')}</div>
      <div class="form-row" id="custom" hidden><label class="field">${t('From')}<input class="input" type="datetime-local" id="hfrom" value="${localInput(from)}"></label><label class="field">${t('To')}<input class="input" type="datetime-local" id="hto" value="${localInput(to)}"></label></div>
      <button class="btn btn-primary" id="load">${i('route')}${t('Show route')}</button>
      <div class="summary" id="hsum" hidden></div>
      <div id="hplayer" hidden><div class="player"><button class="icon-btn" id="play" aria-label="${t('Play')}">${i('play')}</button><input type="range" id="slider" min="0" max="0" value="0" aria-label="${t('Route position')}"></div><p class="small" id="hpoint" style="margin-top:8px"></p><div class="toolbar" style="margin-top:8px"><button class="btn btn-ghost btn-sm" id="hgoogle">${i('layers')}${t('See this point on Google')}</button><button class="btn btn-ghost btn-sm" id="hsave">${i('map-pin')}${t('Save place')}</button></div></div>
      <p class="hint" id="hstatus">${t(fleet.devices.length?'Choose a day and press Show route.':'No vehicles yet.')}</p>
      <button class="btn btn-ghost btn-sm" id="csv" hidden>${i('download')}${t('Download CSV')}</button>
    </aside><div class="map-wrap"><div class="map" id="hmap"></div></div></div>`;
  const hmap=createMap($('#hmap')),layer=L.layerGroup().addTo(hmap);let truck:L.Marker|undefined;
  teardown=()=>{clearInterval(playTimer);hmap.remove()};
  let preset='today';
  on('[data-preset]',el=>{preset=el.dataset.preset!;$$('[data-preset]').forEach(b=>b.classList.toggle('on',b===el));$('#custom').hidden=preset!=='custom';if(preset!=='custom')void load()});
  $<HTMLSelectElement>('#hv').onchange=e=>{historyVehicle=(e.target as HTMLSelectElement).value;void load()};
  const showPoint=(n:number)=>{
    const p=track[n];if(!p)return;
    // Course from the tracker when it moves; otherwise face the next (or previous) point on the route.
    const next=track[n+1]||p,prev=track[n-1]||p,heading=p.speed>=3&&p.heading!=null?p.heading:next!==p?bearing(p,next):prev!==p?bearing(prev,p):0;
    // Reuse one marker element so it glides between points instead of jumping.
    if(!truck)truck=L.marker(point(p),{icon:playbackIcon(heading,p.speed>=3),zIndexOffset:1000}).addTo(hmap);
    else{truck.setLatLng(point(p));const pin=truck.getElement()?.querySelector<HTMLElement>('.gps-pin');if(pin){pin.className=`gps-pin on ${p.speed>=3?'running':'stopped'}`;pin.querySelector<HTMLElement>('span')!.style.transform=`rotate(${heading}deg)`}}
    $<HTMLInputElement>('#slider').value=String(n);
    // Look places up only while paused; during playback show what is already known.
    $('#hpoint').innerHTML=`<b>${clock(p.recordedAt)}</b> · ${Math.round(p.speed)} km/h<br><span class="muted">${placeSpan(p,'history',{lookup:!playTimer})}</span>`;
    // Keep the truck on screen while it plays, however far the user has zoomed in.
    if(following||!hmap.getBounds().pad(-0.15).contains(point(p)))hmap.panTo(point(p),{animate:true});
  };
  const stopPlay=()=>{clearInterval(playTimer);playTimer=undefined;$('#play').innerHTML=i('play');icons()};
  on('#play',()=>{if(playTimer){stopPlay();return}let n=Number($<HTMLInputElement>('#slider').value);if(n>=track.length-1)n=0;$('#play').innerHTML=i('pause');icons();playTimer=setInterval(()=>{showPoint(n++);if(n>=track.length){stopPlay();showPoint(track.length-1)}},400)});
  $<HTMLInputElement>('#slider').oninput=e=>{stopPlay();showPoint(Number((e.target as HTMLInputElement).value))};
  const here=()=>track[Number($<HTMLInputElement>('#slider').value)];
  on('#hgoogle',()=>{const p=here();if(p){stopPlay();googleModal(`${vehicle(historyVehicle)?.name||t('Route')} · ${clock(p.recordedAt)}`,p.latitude,p.longitude)}});
  on('#hsave',()=>{const p=here();if(p){stopPlay();addFence({latitude:p.latitude,longitude:p.longitude,radius:150})}});
  on('#csv',()=>{const v=vehicle(historyVehicle);const rows=[['Time','Latitude','Longitude','Speed km/h','Ignition'],...track.map(p=>[new Date(p.recordedAt).toISOString(),p.latitude,p.longitude,Math.round(p.speed),p.ignition==null?'':p.ignition?'On':'Off'])];download(`${v?.name||'route'}-history.csv`,rows)});
  const load=async()=>{
    if(!historyVehicle)return;
    const [from,to]=preset==='custom'?[new Date($<HTMLInputElement>('#hfrom').value),new Date($<HTMLInputElement>('#hto').value)]:rangeFor(preset);
    if(!(+from<+to)||+to-+from>31*86400000){toast(t('Choose a range of up to 31 days.'),true);return}
    stopPlay();layer.clearLayers();truck?.remove();truck=undefined;track=[];
    $('#hstatus').textContent=t('Loading route…');$('#hplayer').hidden=true;$('#hsum').hidden=true;$('#csv').hidden=true;
    try{
      const points:Fix[]=[];let after:number|null=0;
      do{const r:{positions:Fix[];next:number|null}=await api(`/devices/${historyVehicle}/history?${new URLSearchParams({from:from.toISOString(),to:to.toISOString(),after:String(after)})}`);points.push(...r.positions);after=r.next}while(after!==null&&points.length<100000);
      track=points.filter(p=>p.valid!==0).sort((a,b)=>a.recordedAt-b.recordedAt||a.id-b.id);
      if(!track.length){$('#hstatus').textContent=t('No movement recorded in this period.');return}
      drawRoute(layer,track);hmap.fitBounds(track.map(point),{padding:[50,50],maxZoom:16});
      const slider=$<HTMLInputElement>('#slider');slider.max=String(track.length-1);slider.value='0';
      $('#hplayer').hidden=false;$('#csv').hidden=false;showPoint(0);
      $('#hstatus').textContent=`${time(track[0].recordedAt)} – ${time(track.at(-1)!.recordedAt)}`;
      const r=(await reports(from,to,historyVehicle)).vehicles[0];
      if(r){const gaps=r.days.flatMap(d=>d.gaps);$('#hsum').innerHTML=`<div><span>${t('Distance')}</span><b>${r.total.distanceKm} km</b></div><div><span>${t('Running')}</span><b>${hm(r.total.runningMinutes)}</b></div><div><span>${t('Idle')}</span><b>${hm(r.total.idleMinutes)}</b></div><div><span>${t('Max speed')}</span><b>${r.total.maxSpeed} km/h</b></div>${gaps.map(g=>`<p class="gap-note" style="grid-column:1/-1">${i('triangle-alert')}${esc(gapNote(g))}</p>`).join('')}`;$('#hsum').hidden=false;icons()}
    }catch(e){$('#hstatus').textContent=(e as Error).message}
  };
  on('#load',load);
  if(historyVehicle)void load();
}
function download(name:string,rows:(string|number)[][]){
  const csv=rows.map(r=>r.map(c=>/[",\n]/.test(String(c))?`"${String(c).replace(/"/g,'""')}"`:c).join(',')).join('\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

/* ---------- Reports ---------- */
function renderReports(){
  const [from,to]=rangeFor('today');
  $('#view').innerHTML=`<div class="page">
    <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
      <div class="pills" id="rpresets">${[['today','Today'],['yesterday','Yesterday'],['week','Last 7 days'],['month','This month'],['custom','Custom']].map(([k,l],n)=>`<button data-preset="${k}" class="pill ${n?'':'on'}">${t(l)}</button>`).join('')}</div>
      <div class="form-row" id="rcustom" hidden><label class="field">${t('From')}<input class="input" type="date" id="rfrom" value="${localInput(from).slice(0,10)}"></label><label class="field">${t('To')}<input class="input" type="date" id="rto" value="${localInput(to).slice(0,10)}"></label></div>
      <div class="toolbar"><select class="input" id="rv" style="max-width:280px"><option value="">${t('All vehicles')}</option>${fleet.devices.map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select><button class="btn btn-primary" id="rload">${i('chart-column')}${t('Show report')}</button><button class="btn btn-ghost" id="rcsv" hidden>${i('download')}CSV</button></div>
    </div>
    <div class="stat-grid" id="rkpi"></div>
    <div class="card" id="rtable"><div class="empty">${i('chart-column')}<h3>${t('Daily vehicle report')}</h3><p>${t('Distance, running time, idle time (engine on but standing) and speeds.')}</p></div></div></div>`;
  let preset='today',last:VehicleReport[]=[];
  on('[data-preset]',el=>{preset=el.dataset.preset!;$$('#rpresets [data-preset]').forEach(b=>b.classList.toggle('on',b===el));$('#rcustom').hidden=preset!=='custom';if(preset!=='custom')void load()});
  const load=async()=>{
    const [from,to]=preset==='custom'?[new Date($<HTMLInputElement>('#rfrom').value+'T00:00'),new Date($<HTMLInputElement>('#rto').value+'T23:59:59')]:rangeFor(preset);
    if(!(+from<+to)||+to-+from>31*86400000){toast(t('Choose a range of up to 31 days.'),true);return}
    $('#rtable').innerHTML=`<div class="empty"><p>${t('Calculating…')}</p></div>`;
    try{
      last=(await reports(from,to,$<HTMLSelectElement>('#rv').value||undefined)).vehicles;
      const sum=last.reduce((s,v)=>({km:s.km+v.total.distanceKm,run:s.run+v.total.runningMinutes,idle:s.idle+v.total.idleMinutes,max:Math.max(s.max,v.total.maxSpeed)}),{km:0,run:0,idle:0,max:0});
      $('#rkpi').innerHTML=`<div class="stat"><span>${t('Total distance')}</span><b>${Math.round(sum.km*10)/10} <small>km</small></b><em class="si">${i('route')}</em></div><div class="stat"><span>${t('Running time')}</span><b>${hm(sum.run)}</b><em class="si run">${i('navigation')}</em></div><div class="stat"><span>${t('Idle time')}</span><b style="color:var(--idle)">${hm(sum.idle)}</b><em class="si">${i('pause')}</em></div><div class="stat"><span>${t('Top speed')}</span><b>${sum.max} <small>km/h</small></b><em class="si">${i('gauge')}</em></div>`;
      const day=(date:string)=>new Date(date+'T00:00').toLocaleDateString(locale(),{weekday:'short',day:'2-digit',month:'short'});
      $('#rtable').innerHTML=`<div class="table-wrap"><table class="table"><thead><tr><th>${t('Vehicle / day')}</th><th>${t('Distance')}</th><th>${t('Running')}</th><th>${t('Idle')}</th><th>${t('Max speed')}</th><th>${t('Avg speed')}</th><th class="hide-sm">${t('First / last move')}</th></tr></thead><tbody>${last.map(v=>`<tr><td><b class="plate">${esc(v.name)}</b></td><td><b>${v.total.distanceKm} km</b></td><td>${hm(v.total.runningMinutes)}</td><td>${hm(v.total.idleMinutes)}</td><td>${v.total.maxSpeed} km/h</td><td>${v.total.avgSpeed} km/h</td><td class="hide-sm"></td></tr>${v.days.map(d=>`<tr class="report-days"><td>&nbsp;&nbsp;${day(d.date)}</td><td>${d.distanceKm} km</td><td>${hm(d.runningMinutes)}</td><td>${hm(d.idleMinutes)}</td><td>${d.maxSpeed} km/h</td><td>${d.avgSpeed} km/h</td><td class="hide-sm">${d.firstMove?`${clock(d.firstMove)} – ${clock(d.lastMove)}`:'—'}</td></tr>${d.gaps.map(g=>`<tr class="report-days"><td colspan="7"><div class="gap-note">${i('triangle-alert')}${esc(gapNote(g))}</div></td></tr>`).join('')}`).join('')}`).join('')||`<tr><td colspan="7" class="muted">${t('No vehicles.')}</td></tr>`}</tbody></table></div>`;
      $('#rcsv').hidden=!last.length;icons();
    }catch(e){$('#rtable').innerHTML=`<div class="empty"><p class="error">${esc((e as Error).message)}</p></div>`}
  };
  on('#rload',load);
  on('#rcsv',()=>download('waypoint-report.csv',[['Vehicle','Date','Distance km','Running min','Idle min','Max speed','Avg speed'],...last.flatMap(v=>v.days.map(d=>[v.name,d.date,d.distanceKm,d.runningMinutes,d.idleMinutes,d.maxSpeed,d.avgSpeed]))]));
  if(fleet.devices.length)void load();
}

/* ---------- Alerts ---------- */
let alertsAll=false,alertsCat:Category|'all'='all';
function renderAlerts(){
  const open=(c:Category|'all')=>fleet.alerts.filter(a=>!a.acknowledged&&(c==='all'||categoryOf(a.type)===c)).length;
  const list=fleet.alerts.filter(a=>(alertsAll||!a.acknowledged)&&(alertsCat==='all'||categoryOf(a.type)===alertsCat));
  const style=(type:string)=>{const c=CATEGORIES.find(x=>x.key===categoryOf(type))!;const ic=type==='ignition_on'||type==='ignition_off'?'power':type==='online'?'activity':c.icon;const good=type==='ignition_on'||type==='online'||type==='share_resumed';return {ic,color:good?'var(--running)':type==='ignition_off'?'var(--stopped)':c.color}};
  $('#view').innerHTML=`<div class="page"><div class="pills" id="cats"><button data-cat="all" class="pill ${alertsCat==='all'?'on':''}">${t('All')} <b>${open('all')}</b></button>${CATEGORIES.map(c=>`<button data-cat="${c.key}" class="pill ${alertsCat===c.key?'on':''}">${esc(t(c.label))} <b>${open(c.key)}</b></button>`).join('')}</div>
    <div class="toolbar"><div class="seg"><button data-all="0" class="${alertsAll?'':'on'}">${t('Open')}</button><button data-all="1" class="${alertsAll?'on':''}">${t('All')}</button></div><span style="flex:1"></span>${open(alertsCat)?`<button class="btn btn-ghost btn-sm" id="ack-all">${i('check')}${t('Mark all seen')}</button>`:''}<button class="btn btn-ghost btn-sm" data-go="settings">${i('settings')}${t('Notification settings')}</button></div>
    <div class="card">${list.map(a=>{const st=style(a.type),sos=a.type==='sos';return `<div class="alert-item ${a.acknowledged?'done':''} ${sos?'sos':''}"><span class="ico" style="background:var(--soft);color:${st.color}">${i(st.ic)}</span><div class="body"><b class="plate">${esc(a.deviceName)}</b><p>${esc(alertText(a))}</p><span class="small muted">${esc(t(CATEGORIES.find(c=>c.key===categoryOf(a.type))!.label))} · ${time(a.createdAt)}</span>${a.type==='share_stopped'||a.type==='share_expired'?`<div class="toolbar" style="margin-top:6px"><button class="btn btn-primary btn-sm" data-driver="${a.deviceId}">${i('share-2')}${t('Ask driver to share / new link')}</button></div>`:''}</div>${a.acknowledged?`<span class="chip plain ok">${i('check')}${t('Seen')}</span>`:`<button class="btn btn-ghost btn-sm" data-ack="${a.id}">${t('Mark seen')}</button>`}</div>`}).join('')||`<div class="empty">${i('bell')}<h3>${t('All clear')}</h3><p>${t(alertsCat==='all'?'SOS, engine, geofence, overspeed, hard braking and signal alerts appear here.':'Nothing in this category.')}</p></div>`}</div></div>`;
  on('[data-cat]',el=>{alertsCat=el.dataset.cat as Category|'all';renderAlerts()});
  on('[data-driver]',el=>{const v=vehicle(el.dataset.driver!);if(v)driverLink(v)});
  on('[data-all]',el=>{alertsAll=el.dataset.all==='1';renderAlerts()});
  on('#view [data-go]',el=>go(el.dataset.go as View));
  on('[data-ack]',async el=>{await post(`/alerts/${el.dataset.ack}/ack`);fleet.alerts=fleet.alerts.map(a=>a.id===el.dataset.ack?{...a,acknowledged:1}:a);updateBadges();renderAlerts()});
  on('#ack-all',async()=>{const ids=fleet.alerts.filter(a=>!a.acknowledged&&(alertsCat==='all'||categoryOf(a.type)===alertsCat)).map(a=>a.id);for(const id of ids)await post(`/alerts/${id}/ack`);const set=new Set(ids);fleet.alerts=fleet.alerts.map(a=>set.has(a.id)?{...a,acknowledged:1}:a);updateBadges();renderAlerts();toast(t('All marked seen.'))});
  icons();
}

/* ---------- Places ---------- */
type Stop={latitude:number;longitude:number;visits:number;totalMinutes:number;lastVisit:number;vehicles:string[]};
let stopsCache:{at:number;stops:Stop[]}|null=null;
const kindLabel=(kind?:string)=>t((PLACE_KIND[kind||'other']||PLACE_KIND.other)[1]);
function renderGeofences(){
  $('#view').innerHTML=`<div class="page"><div class="toolbar"><p class="muted" style="flex:1">${t('Your own places: petrol pumps, dhabas, depots, loading points. They show on the map with their name, and you get an alert when a vehicle enters or leaves one.')}</p><button class="btn btn-primary" id="add-fence">${i('plus')}${t('Add place')}</button></div>
    <div class="place-list">${fleet.fences.length?fleet.fences.map(f=>`<div class="card place-row"><span class="place-ico">${placeIcon(f.kind)}</span><div class="body"><b>${esc(f.name)}</b><small>${esc(kindLabel(f.kind))} · ${f.radius} m</small><small class="muted">${placeSpan(f,'fence-'+f.id)}</small></div><div class="actions"><button class="icon-btn" data-gfence="${f.id}" aria-label="${t('Google view')}">${i('layers')}</button><button class="icon-btn danger" data-del="${f.id}" aria-label="${t('Delete')}">${i('trash-2')}</button></div></div>`).join(''):`<div class="card empty">${i('map-pin')}<h3>${t('No places yet')}</h3><p>${t("Save a vehicle's current place, or name one of the suggested stops below.")}</p></div>`}</div>
    <div class="card card-pad" id="suggested"><h2>${t('Suggested stops')}</h2><p class="hint">${t('Places where your vehicles stopped 10 minutes or more, at least 3 times in the last 14 days. Check what is there on Google and give it a name.')}</p><div id="stops"><p class="muted">${t('Looking at the last 14 days…')}</p></div></div></div>`;
  on('#add-fence',()=>addFence());
  on('[data-gfence]',el=>{const f=fleet.fences.find(x=>x.id===el.dataset.gfence)!;googleModal(f.name,f.latitude,f.longitude)});
  on('[data-del]',async el=>{const f=fleet.fences.find(x=>x.id===el.dataset.del)!;if(!confirm(t('Delete place {n}?',{n:f.name})))return;await api(`/fences/${f.id}`,{method:'DELETE'});fleet=await api<Fleet>('/state');stopsCache=null;renderGeofences()});
  icons();void showStops();
}
async function showStops(){
  try{
    if(!stopsCache||Date.now()-stopsCache.at>10*60000)stopsCache={at:Date.now(),stops:(await api<{stops:Stop[]}>('/stops?days=14')).stops};
    const host=document.querySelector('#stops');if(!host)return;
    const stops=stopsCache.stops;
    host.innerHTML=stops.length?stops.map((s,n)=>`<div class="alert-item"><span class="ico" style="background:var(--soft);color:var(--blue-600)">${i('circle-parking')}</span><div class="body"><b>${placeSpan(s,'stop-'+n)}</b><p>${t('{n} stops · {d} in all · last {t}',{n:s.visits,d:hm(s.totalMinutes),t:time(s.lastVisit)})}</p><span class="small muted">${esc(s.vehicles.join(', '))}</span>
      <div class="toolbar" style="margin-top:6px"><button class="btn btn-ghost btn-sm" data-sgoogle="${n}">${i('layers')}${t('Show on Google')}</button><button class="btn btn-primary btn-sm" data-sname="${n}">${i('plus')}${t('Name this place')}</button></div></div></div>`).join(''):`<p class="muted">${t('No regular stops yet. They appear once a vehicle has stopped at the same place 3 times.')}</p>`;
    on('[data-sgoogle]',el=>{const s=stops[Number(el.dataset.sgoogle)];googleModal(t('Stop · {n} visits',{n:s.visits}),s.latitude,s.longitude)},host as HTMLElement);
    on('[data-sname]',el=>{const s=stops[Number(el.dataset.sname)];addFence({latitude:s.latitude,longitude:s.longitude,radius:150})},host as HTMLElement);
    icons();
  }catch(e){const host=document.querySelector('#stops');if(host)host.innerHTML=`<p class="error">${esc((e as Error).message)}</p>`}
}
function addFence(at?:{latitude:number;longitude:number;radius:number}){
  const withPos=fleet.devices.filter(d=>d.position);
  modal(t('Add place'),`<form class="form" id="fence-form"><label class="field">${t('Name')}<input class="input" name="name" required maxlength="100" placeholder="${t('HP petrol pump, Tridev dhaba, Pune depot')}"></label>
    <label class="field">${t('Type')}<select class="input" name="kind">${Object.entries(PLACE_KIND).map(([k,[ic,l]])=>`<option value="${k}">${ic} ${esc(t(l))}</option>`).join('')}</select></label>
    ${at?'':`<label class="field">${t('Centre')}<select class="input" id="fence-from"><option value="">${t('Enter coordinates')}</option>${withPos.map(d=>`<option value="${d.id}">${t('Current place of {n}',{n:esc(d.name)})}</option>`).join('')}</select></label>`}
    <div class="form-row"><label class="field">${t('Latitude')}<input class="input" type="number" step="any" min="-90" max="90" name="latitude" required value="${at?at.latitude.toFixed(6):''}"></label><label class="field">${t('Longitude')}<input class="input" type="number" step="any" min="-180" max="180" name="longitude" required value="${at?at.longitude.toFixed(6):''}"></label></div>
    <label class="field">${t('Radius (metres)')}<input class="input" type="number" name="radius" min="50" max="100000" value="${at?.radius??500}" required></label>
    <p class="hint">${t('Not sure what is there?')} <button type="button" class="linkish" id="fence-google">${t('See it on Google')}</button></p>
    <p class="error" id="fence-error"></p><button class="btn btn-primary" type="submit">${t('Save place')}</button></form>`);
  const form=$<HTMLFormElement>('#fence-form');
  const from=document.querySelector<HTMLSelectElement>('#fence-from');
  if(from){from.onchange=()=>{const d=vehicle(from.value);if(d?.position){form.latitude.value=d.position.latitude.toFixed(6);form.longitude.value=d.position.longitude.toFixed(6)}};if(withPos[0]){from.value=withPos[0].id;from.dispatchEvent(new Event('change'))}}
  // Opens Google in its own tab so the form being filled in is not lost.
  on('#fence-google',()=>{const lat=Number(form.latitude.value),lon=Number(form.longitude.value);if(Number.isFinite(lat)&&Number.isFinite(lon))window.open(mapsLink({latitude:lat,longitude:lon}),'_blank','noopener')});
  form.addEventListener('submit',async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(form));try{await post('/fences',{name:v.name,kind:v.kind,latitude:Number(v.latitude),longitude:Number(v.longitude),radius:Number(v.radius)});closeModal();fleet=await api<Fleet>('/state');stopsCache=null;if(view==='geofences')renderGeofences();else if(view==='map')updateLive();toast(t('Place saved.'))}catch(err){$('#fence-error').textContent=(err as Error).message}});
}

/* ---------- Overspeed and driver link ---------- */
// The owner's own overspeed limit and on/off switch for one vehicle.
function speedForm(d:Vehicle,compact=false){
  return `<form class="form speed-form" data-speed="${d.id}">${compact?`<b class="plate">${esc(d.name)}</b>`:''}
    <div class="form-row"><label class="field">${t('Speed limit (km/h)')}<input class="input" type="number" name="speedLimit" min="1" max="250" step="1" required value="${d.speedLimit}"></label>
    <label class="switch-row" style="align-self:end"><span>${t('Alert me when crossed')}</span><input type="checkbox" class="switch" name="speedAlert" ${d.speedAlert===false?'':'checked'}></label></div>
    <p class="error"></p><button class="btn btn-primary btn-sm" type="submit" style="align-self:flex-start">${i('save')}${t('Save')}</button></form>`;
}
function bindSpeedForms(root:ParentNode,done?:()=>void){
  root.querySelectorAll<HTMLFormElement>('form[data-speed]').forEach(form=>form.addEventListener('submit',async e=>{
    e.preventDefault();const f=new FormData(form),err=form.querySelector('.error')!;err.textContent='';
    try{
      const r=await post<{speedLimit:number;speedAlert:boolean}>(`/devices/${form.dataset.speed}/speed`,{speedLimit:Number(f.get('speedLimit')),speedAlert:f.has('speedAlert')},'PUT');
      const v=vehicle(form.dataset.speed!);if(v){v.speedLimit=r.speedLimit;v.speedAlert=r.speedAlert}
      unlockVoice();toast(r.speedAlert?t('Overspeed alert on at {n} km/h.',{n:r.speedLimit}):t('Overspeed alert switched off.'));done?.();
    }catch(x){err.textContent=(x as Error).message}
  }));
}
function speedSettings(d?:Vehicle){
  const list=d?[d]:fleet.devices;
  modal(d?`${d.name} · ${t('Overspeed')}`:t('Overspeed limits'),`<p class="hint">${t('As soon as a vehicle goes faster than its limit you get an alert, a pop-up and a voice message.')}</p>${list.length?list.map(v=>speedForm(v,!d)).join('<hr class="sep">'):`<p class="muted">${t('No vehicles yet.')}</p>`}`);
  bindSpeedForms(document.querySelector('dialog.modal')!,()=>{if(d){closeModal();renderSheet()}});
}
const SHARE_FOR:[number,string][]=[[4,'4 hours'],[12,'12 hours'],[24,'1 day'],[168,'1 week'],[720,'1 month'],[8760,'1 year']];
function driverLink(d:Vehicle){
  modal(`${d.name} · ${t('Driver link')}`,`<p>${t('Send this link to the driver. When they open it and press "Location shuru karein", the vehicle shows on the map.')}</p>
    <label class="field">${t('Share location for')}<select class="input" id="share-for">${SHARE_FOR.map(([h,l])=>`<option value="${h}" ${h===168?'selected':''}>${t(l)}</option>`).join('')}</select></label>
    <div id="link-box"><p class="muted">${t('Loading…')}</p></div><p class="error" id="link-error"></p>
    <div class="toolbar"><button class="btn btn-primary" id="make-link">${i('plus')}${t('Create link')}</button><button class="btn btn-ghost" id="stop-link">${t('Disable link')}</button></div>`);
  const hours=()=>Number($<HTMLSelectElement>('#share-for').value);
  const setFor=()=>`${i('clock')}${t('Set to {d} from now',{d:esc($<HTMLSelectElement>('#share-for').selectedOptions[0].text)})}`;
  const show=async(mode:'get'|'create'|'renew'|'extend')=>{
    $('#link-error').textContent='';
    try{
      const r=await api<{code:string|null;expiresAt:number|null}|null>(`/devices/${d.id}/driver-link`,mode==='get'?{}:{method:'POST',body:JSON.stringify({regenerate:mode==='renew',hours:hours()})});
      if(!r?.code){$('#link-box').innerHTML=`<p class="muted">${t('No active link. Choose how long and press Create link.')}</p>`;$('#make-link').innerHTML=`${i('plus')}${t('Create link')}`;delete $('#make-link').dataset.active;icons();return}
      const url=new URL('/?sender=1',location.origin);url.hash=new URLSearchParams({join:r.code}).toString();
      const until=r.expiresAt?t('Valid till {t}',{t:time(r.expiresAt)}):t('No end date (old link)');
      const msg=`${d.name}: location share karne ke liye yeh link kholein aur "Location shuru karein" dabayein. ${until}.\n${url}`;
      $('#link-box').innerHTML=`<label class="field">${t('Driver link')}<input class="input" readonly value="${esc(url)}"></label><p class="hint">${esc(until)}</p>
        <div class="toolbar"><button class="btn btn-ghost btn-sm" data-copy="${esc(url)}">${i('copy')}${t('Copy')}</button><a class="btn btn-primary btn-sm" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">${i('share-2')}WhatsApp</a><a class="btn btn-ghost btn-sm" href="sms:?&body=${encodeURIComponent(msg)}">SMS</a>${typeof navigator.share==='function'?`<button class="btn btn-ghost btn-sm" id="share-link">${i('share-2')}${t('Share')}</button>`:''}<button class="btn btn-ghost btn-sm" id="extend-link">${setFor()}</button></div>`;
      on('[data-copy]',async el=>{await navigator.clipboard.writeText(el.dataset.copy!);toast(t('Link copied.'))});
      on('#share-link',()=>navigator.share({title:d.name,text:msg}).catch(()=>{}));
      on('#extend-link',async()=>{await show('extend');toast(t('Link time updated. The driver keeps the same link.'))});
      $('#make-link').innerHTML=`${i('refresh-cw')}${t('New link')}`;$('#make-link').dataset.active='1';icons();
    }catch(e){$('#link-error').textContent=(e as Error).message}
  };
  $<HTMLSelectElement>('#share-for').onchange=()=>{const b=document.querySelector('#extend-link');if(b){b.innerHTML=setFor();icons()}};
  on('#make-link',async el=>{const regen=el.dataset.active==='1';if(regen&&!confirm(t('Create a new link? The old link will stop working.')))return;await show(regen?'renew':'create')});
  on('#stop-link',async()=>{await api(`/devices/${d.id}/driver-link`,{method:'DELETE'});$('#link-box').innerHTML=`<p class="muted">${t('Driver link disabled.')}</p>`;$('#make-link').innerHTML=`${i('plus')}${t('Create link')}`;delete $('#make-link').dataset.active;icons()});
  void show('get');
}

/* ---------- Documents / E-way (existing module) ---------- */
async function renderDocuments(section:'Documents'|'E-way bills'){
  const host=$('#view');host.innerHTML=`<div class="page"><p class="muted">${t('Loading…')}</p></div>`;
  try{const {mountDocuments}=await import('../main');const page=document.createElement('div');page.className='page';host.replaceChildren(page);mountDocuments(page,section,fleet.devices.map(d=>({name:d.name,model:'',driver:d.driver})))}
  catch{host.innerHTML=`<div class="page"><p class="error">${t('Unable to load this section. Refresh to retry.')}</p></div>`}
}

/* ---------- Settings ---------- */
const row=(icon:string,title:string,sub:string,control:string,id='')=>`<div class="set-row"${id?` id="${id}"`:''}><span class="set-ico">${i(icon)}</span><div class="set-text"><b>${title}</b><small>${sub}</small></div>${control}</div>`;
const toggle=(attr:string)=>`<input type="checkbox" class="switch" ${attr}>`;
function renderSettings(){
  const p=prefs(),np=notifyPrefs(),lang=getLang();
  const limits=[...new Set(fleet.devices.map(d=>d.speedLimit))];
  $('#view').innerHTML=`<div class="page settings">
    <section class="card profile"><div class="profile-top"><span class="avatar xl">${initial(p.workspace)}</span><div class="profile-text"><h2>${esc(p.name||p.workspace)}</h2><span class="muted">${esc(p.workspace)}</span><span class="muted">${i('mail')}${esc(me.email||'')}</span></div><button class="icon-btn" id="edit-profile" aria-label="${t('Edit profile')}">${i('pencil')}</button></div>
      <div class="profile-band">${i('truck')}<span><b>${t('{n} GPS vehicles active',{n:fleet.devices.length})}</b><small>${t('Live GPS tracking')}</small></span></div></section>

    <section class="card set-card"><div class="set-head"><span class="set-badge">${i('bell')}</span><div><h2>${t('GPS & alert settings')}</h2><small>${t('Telemetry and security alerts')}</small></div></div>
      ${row('gauge',t('Overspeed alert limit'),limits.length===1?t('Speed limit: {n} km/h',{n:limits[0]}):t('Set for each vehicle'),`<button class="btn btn-soft btn-sm" id="edit-speed">${t('Change')}</button>`)}
      ${row('message-square',t('Show a pop-up message'),t('A short message on screen for every alert'),toggle('data-n="popup"'))}
      ${row('volume-2',t('Speak alerts aloud'),voiceSupported()?t('Vehicle started, engine off, SOS, overspeed…'):t('Not supported in this browser'),toggle('data-n="voice"'))}
      ${row('bell-ring',t('Browser notifications'),`<span id="browser-note"></span>`,toggle('data-n="browser"'))}
      <h3 class="set-sub">${t('Which alerts?')}</h3>
      ${CATEGORIES.map(c=>row(c.icon,esc(t(c.label)),esc(t(c.hint)),toggle(`data-cat-n="${c.key}"`))).join('')}
      <p class="hint">${t('Voice and notifications work while Waypoint is open in a browser tab, including a background tab. They stop when the tab or browser is closed or the phone suspends it.')}</p></section>

    <section class="card set-card"><div class="set-head"><span class="set-badge">${i('languages')}</span><div><h2>${t('App language & voice guide')}</h2><small>${t('Language and voice assistance')}</small></div></div>
      <p class="set-sub">${t('Choose app language')}</p>
      <div class="lang-seg">${LANGS.map(([k,l,s])=>`<button data-lang="${k}" class="${lang===k?'on':''}"><b>${l}</b><small>${k==='hi'?`${s} · ${t('Default')}`:s}</small></button>`).join('')}</div>
      ${row('volume-2',t('Speak alerts aloud'),t('Spoken emergency alerts'),toggle('data-n="voice"'))}
      <div class="toolbar"><button class="btn btn-ghost btn-sm" type="button" id="test-voice">${i('play')}${t('Test voice')}</button></div></section>

    <section class="card set-card"><div class="set-head"><span class="set-badge">${i('sliders-horizontal')}</span><div><h2>${t('App preferences')}</h2><small>${t('How the app opens and follows vehicles')}</small></div></div>
      ${row('house',t('Open the app on'),'',`<select class="input compact" id="default-view">${NAV.map(([v,l])=>`<option value="${v}" ${p.defaultView===v?'selected':''}>${t(l)}</option>`).join('')}</select>`)}
      ${row('locate-fixed',t('Keep the map centred on the selected vehicle'),'',toggle(`id="follow-pref" ${p.follow?'checked':''}`))}
      ${DEMO_MODE?'':row('key-round',t('Change password'),t('Your other devices will be signed out.'),`<button class="btn btn-soft btn-sm" id="change-password">${t('Change')}</button>`)}</section>

    <div class="app-foot"><span class="muted">${t('App version: {v}',{v:APP_VERSION})}</span><span class="ok-line"><i class="dot" style="background:var(--running)"></i>${t('Server online')}</span></div>
    <button class="btn btn-sos-soft btn-block" data-logout>${i('log-out')}${t('Sign out securely')}</button></div>`;
  const note=()=>{const st=browserState();$('#browser-note').textContent=!browserSupported()?t('This browser cannot show notifications.'):st==='denied'?t('Blocked. Allow them from the lock icon in the address bar.'):st==='granted'?t('Allowed. Shown when this tab is in the background.'):t('Shown when this tab is in the background.')};
  $$<HTMLInputElement>('[data-n]').forEach(box=>{const k=box.dataset.n as 'popup'|'voice'|'browser';box.checked=np[k];box.addEventListener('change',async()=>{
    if(k==='browser'&&box.checked){const r=await askBrowserPermission();if(r!=='granted'){box.checked=false;note();toast(t('Browser notifications were not allowed.'),true);return}}
    if(k==='voice')unlockVoice();
    np[k]=box.checked;$$<HTMLInputElement>(`[data-n="${k}"]`).forEach(b=>b.checked=box.checked);await saveNotify(np);note();toast(t('Saved.'))})});
  $$<HTMLInputElement>('[data-cat-n]').forEach(box=>{const k=box.dataset.catN as Category;box.checked=np.categories[k];box.addEventListener('change',async()=>{np.categories[k]=box.checked;await saveNotify(np);toast(t('Saved.'))})});
  on('[data-lang]',el=>{setLang(el.dataset.lang as Lang);shell();toast(t('Language changed.'))});
  on('#test-voice',()=>{unlockVoice();speakAlert('Vehicle {n} started',{n:'MH 12 AB 1234'})});note();
  on('#edit-speed',()=>speedSettings());
  on('#edit-profile',editProfile);
  on('#change-password',changePassword);
  $<HTMLSelectElement>('#default-view').onchange=async e=>{await savePrefs({defaultView:(e.target as HTMLSelectElement).value as View});toast(t('Saved.'))};
  $<HTMLInputElement>('#follow-pref').onchange=async e=>{const on=(e.target as HTMLInputElement).checked;await savePrefs({follow:on});following=on;toast(t('Saved.'))};
  on('[data-logout]',logout);icons();
}
async function savePrefs(change:Partial<Prefs>){await workspaceStorage.setItem('workspace-preferences',JSON.stringify({...prefs(),...change}))}
function editProfile(){
  const p=prefs();
  modal(t('Edit profile'),`<form class="form" id="prefs"><label class="field">${t('Your name')}<input class="input" name="name" maxlength="100" value="${esc(p.name)}"></label><label class="field">${t('Fleet name')}<input class="input" name="workspace" maxlength="100" required value="${esc(p.workspace)}"></label>
    <p class="error" id="prefs-error"></p><button class="btn btn-primary" type="submit">${i('save')}${t('Save')}</button></form>`);
  $('#prefs').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target as HTMLFormElement);try{await savePrefs({name:String(f.get('name')).trim(),workspace:String(f.get('workspace')).trim()||t('My fleet')});closeModal();toast(t('Saved.'));shell()}catch(err){$('#prefs-error').textContent=(err as Error).message}});
}
function changePassword(){
  modal(t('Change password'),`<form class="form" id="password"><p class="hint">${t('Signed in as {e}. Your other devices will be signed out.',{e:esc(me.email)})}</p>
    <label class="field">${t('Current password')}<input class="input" type="password" name="currentPassword" required autocomplete="current-password"></label>
    <label class="field">${t('New password')}<input class="input" type="password" name="newPassword" required minlength="12" maxlength="128" autocomplete="new-password"></label><label class="field">${t('Confirm new password')}<input class="input" type="password" name="confirmPassword" required minlength="12" maxlength="128" autocomplete="new-password"></label>
    <p class="hint">${t('At least 12 characters.')}</p><p class="error" id="password-error"></p><button class="btn btn-primary" type="submit">${i('key-round')}${t('Change password')}</button></form>`);
  $('#password').addEventListener('submit',async e=>{e.preventDefault();const form=e.target as HTMLFormElement,f=new FormData(form);$('#password-error').textContent='';try{if(f.get('newPassword')!==f.get('confirmPassword'))throw Error(t('New passwords do not match.'));await post('/account/password',{currentPassword:f.get('currentPassword'),newPassword:f.get('newPassword')});closeModal();toast(t('Password changed.'))}catch(err){$('#password-error').textContent=(err as Error).message}});
}

/* ---------- Menu ---------- */
function renderMore(){
  const p=prefs(),n=openAlerts();
  $('#view').innerHTML=`<div class="page menu-page">
    <button class="card profile-card" data-go="settings"><span class="avatar lg">${initial(p.workspace)}</span><div><strong>${esc(p.workspace)}</strong><small>${esc(me.email||p.name)}</small></div><span class="chip ok">${t('{n} vehicles',{n:fleet.devices.length})}</span></button>
    ${GROUPS.filter(([g])=>g!=='Tracking').map(([group,items])=>`<section><h3 class="menu-title">${t(group)}</h3><div class="tiles">${items.map(([v,label,icon])=>`<button class="tile" data-go="${v}"><span class="tile-ico">${i(icon)}</span><b>${t(label)}${v==='alerts'&&n?` <span class="chip sos plain">${n}</span>`:''}</b><small>${t(HINTS[v]||'')}</small></button>`).join('')}</div></section>`).join('')}
    <button class="btn btn-sos-soft btn-block" data-logout>${i('log-out')}${t('Sign out securely')}</button></div>`;
  on('#view [data-go]',el=>go(el.dataset.go as View));on('#view [data-logout]',logout);icons();
}
