import {$,$$,api,post,clock,closeModal,coords,esc,hm,i,icons,localInput,mapsLink,modal,on,since,statusLabel,statusOf,time,ago,toast,whenUnauthorized,type Alert,type Fence,type Fix,type Identity,type StatusKey,type Vehicle} from '../shared/core';
import {bearing,createMap,drawRoute,fleetIcon,playbackIcon,point,L} from '../shared/map';
import {placeSpan,places,placeKey} from '../shared/places';
import {nearest,nearText,nearSaved,placeIcon,PLACE_KIND} from '../shared/poi';
import {googleModal} from '../shared/google';
import {googleLive} from '../shared/gview';
import {t,getLang,setLang,locale,LANGS,type Lang} from '../shared/i18n';
import {DEMO_MODE,workspaceStorage} from '../demo';
import {showLogin} from '../auth';
import {CATEGORIES,alertText,announceNew,askBrowserPermission,browserState,browserSupported,categoryOf,mergeNotify,primeSeen,speakAlert,unlockVoice,voiceSupported,type Category,type NotifyPrefs} from './notify';
import './customer.css';

// One clean structure: Home (fleet), Map, Alerts and More on phones; a grouped sidebar on desktop.
// A vehicle is its own page (map on top, details below) reached from anywhere and left with Back.
type View='home'|'map'|'vehicle'|'history'|'reports'|'alerts'|'geofences'|'documents'|'ebills'|'settings'|'more';
type Fleet={devices:Vehicle[];fences:Fence[];alerts:Alert[]};
type Gap={from:number;to:number;minutes:number;movedKm:number|null};
type DayReport={date:string;distanceKm:number;runningMinutes:number;idleMinutes:number;ignitionMinutes:number;maxSpeed:number;avgSpeed:number;firstMove:number|null;lastMove:number|null;gaps:Gap[]};
type VehicleReport={id:string;name:string;total:{distanceKm:number;runningMinutes:number;idleMinutes:number;maxSpeed:number;avgSpeed:number;gapMinutes:number};days:DayReport[]};
type Prefs={name:string;workspace:string;follow:boolean;defaultView:View;notify?:Partial<NotifyPrefs>};
const APP_VERSION='3.0';

// Distance is only what the tracker reported. When it went silent, say so instead of guessing.
const gapNote=(g:Gap)=>`${t('Tracker sent no data {a} – {b} ({d})',{a:clock(g.from),b:clock(g.to),d:hm(g.minutes)})}${g.movedKm?` · ${t('moved {n} km in this time',{n:g.movedKm})}`:''} · ${t('km in this period is not recorded')}`;
const TITLES:Record<View,string>={home:'Dashboard',map:'Live map',vehicle:'Vehicle',history:'Route history',reports:'Reports',alerts:'Alerts',geofences:'Places',documents:'Documents',ebills:'E-way bills',settings:'Settings',more:'More'};
const TABS:[View,string,string][]=[['home','Dashboard','layout-dashboard'],['map','Map','map'],['history','History','route'],['more','More','layout-grid']];
const SIDE:[string,[View,string,string][]][]=[
  ['Fleet',[['home','Dashboard','layout-dashboard'],['history','Route history','route']]],
  ['Alerts & reports',[['alerts','Alerts','bell'],['reports','Reports','chart-column']]],
  ['Manage',[['geofences','Places','map-pin'],['documents','Documents','files'],['ebills','E-way bills','file-text']]],
  ['Account',[['settings','Settings','settings']]],
];
const MORE:[string,[View,string,string,string][]][]=[
  ['Trips & reports',[['alerts','Alerts','bell','Engine, SOS, overspeed, signal'],['reports','Reports','chart-column','Distance, running and idle time']]],
  ['Places & papers',[['geofences','Places','map-pin','Petrol pumps, dhabas, depots'],['documents','Documents','files','RC, insurance, permits'],['ebills','E-way bills','file-text','E-way bills for your trips']]],
  ['Account',[['settings','Settings','settings','Notifications, overspeed, language, password']]],
];
const ROOT:View[]=['home','map','history','more'];
const PAGES:View[]=['home','map','vehicle','history','reports','alerts','geofences','documents','ebills','settings','more'];

let me:Identity,fleet:Fleet={devices:[],fences:[],alerts:[]},view:View='home',vehicleId='',filter:'all'|'running'|'stopped'|'offline'='all',search='',following=true;
let poll:ReturnType<typeof setTimeout>|undefined,teardown:(()=>void)|undefined,onRefresh:(()=>void)|undefined;

function prefs():Prefs{
  const defaults:Prefs={name:me?.name||'',workspace:t('My fleet'),follow:true,defaultView:'home'};
  try{const saved=JSON.parse(workspaceStorage.getItem('workspace-preferences')||'{}');const dv=saved.defaultView==='vehicles'?'home':saved.defaultView;return {...defaults,...saved,defaultView:['home','map','alerts'].includes(dv)?dv:'home'}}catch{return defaults}
}
async function savePrefs(change:Partial<Prefs>){await workspaceStorage.setItem('workspace-preferences',JSON.stringify({...prefs(),...change}))}
const notifyPrefs=():NotifyPrefs=>mergeNotify(prefs().notify);
async function saveNotify(next:NotifyPrefs){await savePrefs({notify:next})}
const openAlerts=()=>fleet.alerts.filter(a=>!a.acknowledged).length;
const vehicle=(id:string)=>fleet.devices.find(d=>d.id===id);
const group=(s:StatusKey)=>s==='running'?'running':s==='stopped'||s==='idle'?'stopped':'offline';
const overspeeding=(d:Vehicle)=>statusOf(d)==='running'&&!!d.position&&d.position.speed>d.speedLimit;
const initial=(s:string)=>esc((s||'W').trim().charAt(0).toUpperCase());

/* ---------- Start, routing, refresh ---------- */
export async function startCustomer(identity:Identity){
  me=identity;following=prefs().follow;
  whenUnauthorized(()=>{stop();showLogin(t('Your session ended. Please sign in again.'))});
  try{fleet=await api<Fleet>('/state')}catch(e){$('#app').innerHTML=`<div class="cx-empty">${i('wifi-off')}<h3>${t('Could not load your fleet')}</h3><p>${esc((e as Error).message)}</p><button class="cx-btn primary" id="retry">${t('Retry')}</button></div>`;on('#retry',()=>location.reload());icons();return}
  readUrl();
  primeSeen(fleet.alerts);remember(fleet.devices);document.addEventListener('click',unlockVoice,{once:true});
  // Back (phone button or browser) simply steps back through the pages that were opened.
  window.addEventListener('popstate',()=>{readUrl();render()});
  render();schedule();
}
function readUrl(){
  const q=new URLSearchParams(location.search),v=q.get('view');
  view=v==='vehicles'?'home':PAGES.includes(v as View)?v as View:prefs().defaultView;
  vehicleId=q.get('id')||q.get('vehicle')||'';
  if(view==='map'&&vehicleId)view='vehicle';
  if(view==='vehicle'&&!vehicle(vehicleId))view='home';
}
function go(next:View,id=''){
  const url=new URL(location.href);url.search='';
  if(DEMO_MODE)url.searchParams.set('demo','');
  url.searchParams.set('view',next);if(id)url.searchParams.set('id',id);
  history.pushState({cx:true},'',url);view=next;vehicleId=id;render();window.scrollTo({top:0});
}
const openVehicle=(id:string)=>go('vehicle',id);
function back(){if(history.state?.cx)history.back();else go(view==='vehicle'?'home':'more')}
function stop(){clearTimeout(poll);teardown?.();teardown=undefined;onRefresh=undefined}
// Short polls keep the map, alerts and voice close to real time (the gateway pushes within ~1 s).
function schedule(){clearTimeout(poll);poll=setTimeout(refresh,document.hidden?5000:2000)}
async function refresh(){
  try{fleet=await api<Fleet>('/state');remember(fleet.devices);announceNew(fleet.alerts,notifyPrefs());updateBadges();onRefresh?.()}
  catch{/* keep showing the last data; the next poll retries */}
  finally{schedule()}
}
function updateBadges(){const n=openAlerts();$$('[data-alert-badge]').forEach(b=>{b.textContent=n>99?'99+':String(n);b.hidden=!n});$$('[data-alert-dot]').forEach(b=>{b.hidden=!n})}
async function logout(){if(!DEMO_MODE)await api('/session',{method:'DELETE'}).catch(()=>{});location.href='/?live=1&auth=customer'}

function render(){
  stop();
  const p=prefs(),badge=openAlerts(),active=view==='vehicle'?'home':ROOT.includes(view)?view:'more';
  const badgeHtml=`<span class="cx-badge" data-alert-badge ${badge?'':'hidden'}>${badge}</span>`;
  $('#app').innerHTML=`<div class="cx" data-view="${view}">
    <aside class="cx-side">
      <a class="cx-brand" href="/?live=1"><span class="cx-mark">${i('navigation')}</span><span><b>Waypoint</b><small>${t('Live fleet')}</small></span></a>
      <nav>${SIDE.map(([g,items])=>`<div class="cx-side-group"><span>${t(g)}</span>${items.map(([v,l,ic])=>`<button data-go="${v}" class="${(view===v||(v==='home'&&view==='vehicle'))?'on':''}">${i(ic)}<em>${t(l)}</em>${v==='alerts'?badgeHtml:''}</button>`).join('')}</div>`).join('')}</nav>
      <button class="cx-me" data-go="settings"><span class="cx-avatar">${initial(p.workspace)}</span><span><b>${esc(p.workspace)}</b><small>${esc(me.email||p.name)}</small></span>${i('chevron-right')}</button>
    </aside>
    <main class="cx-main">${['home','map','more','vehicle'].includes(view)?'':`<header class="cx-top">${ROOT.includes(view)?'':`<button class="cx-back" data-back aria-label="${t('Back')}">${i('chevron-left')}</button>`}<h1>${t(TITLES[view])}</h1></header>`}<div id="view"></div></main>
    <nav class="cx-tabs">${TABS.map(([v,l,ic])=>`<button data-go="${v}" class="${active===v?'on':''}"><span class="cx-tab-ico">${i(ic)}${v==='alerts'?badgeHtml:''}</span>${t(l)}</button>`).join('')}</nav>
  </div>`;
  on('[data-go]',el=>go(el.dataset.go as View));
  on('[data-back]',back);
  ({home:renderHome,map:renderMap,vehicle:renderVehicle,history:renderHistory,reports:renderReports,alerts:renderAlerts,geofences:renderGeofences,documents:()=>renderDocuments('Documents'),ebills:()=>renderDocuments('E-way bills'),settings:renderSettings,more:renderMore} as Record<View,()=>void>)[view]();
  icons();
}

// Recent path of each vehicle while the app is open, drawn behind the truck on its page.
const trails=new globalThis.Map<string,{latitude:number;longitude:number;at:number}[]>();
function remember(devices:Vehicle[]){
  const cutoff=Date.now()-60*60000;
  for(const d of devices){const p=d.position;if(!p||p.valid===0)continue;const tr=trails.get(d.id)||[];if(!tr.length||tr.at(-1)!.at!==p.recordedAt)tr.push({latitude:p.latitude,longitude:p.longitude,at:p.recordedAt});while(tr.length&&(tr[0].at<cutoff||tr.length>400))tr.shift();trails.set(d.id,tr)}
}
let googleView=false;
try{googleView=localStorage.getItem('waypoint.googleView')==='1'}catch{/* private mode */}
function setGoogle(on:boolean){googleView=on;try{localStorage.setItem('waypoint.googleView',on?'1':'0')}catch{/* private mode */}}

/* ---------- Shared pieces ---------- */
// What a vehicle is doing, in one short phrase for its row.
function doing(d:Vehicle){
  const s=statusOf(d),p=d.position;
  if(overspeeding(d))return {main:`${Math.round(p!.speed)}`,unit:'km/h',cls:'sos'};
  if(s==='running'&&p)return {main:`${Math.round(p.speed)}`,unit:'km/h',cls:'run'};
  if((s==='stopped'||s==='idle')&&d.stoppedSince)return {main:since(d.stoppedSince),unit:t(s==='idle'?'Idle':'Standing'),cls:'stand'};
  return {main:statusLabel(s),unit:'',cls:'off'};
}
function vehicleRow(d:Vehicle){
  const p=d.position,s=statusOf(d),w=doing(d);
  return `<button class="cx-row" data-open="${d.id}">
    <span class="cx-av ${overspeeding(d)?'sos':group(s)}">${i('truck')}</span>
    <span class="cx-row-main"><b class="cx-plate">${esc(d.name)}</b><small>${placeSpan(p,d.id,{short:true})}</small></span>
    <span class="cx-row-end ${w.cls}"><b>${esc(w.main)}</b><small>${esc(w.unit||ago(p?.recordedAt??d.lastSeen))}</small></span>
  </button>`;
}
const statusPill=(d:Vehicle)=>{const s=statusOf(d),over=overspeeding(d);return `<span class="cx-pill ${over?'sos':group(s)}"><i></i>${over?t('Overspeed'):statusLabel(s)}</span>`};

// The fleet on a map: status markers, a live count, Google view and fit; tapping a truck either
// shows a small card (Map tab) or opens the vehicle (desktop Home).
function fleetMap(host:HTMLElement,{peek}:{peek:boolean}){
  host.innerHTML=`<div class="cx-map" data-fm-map></div><div class="gwrap" data-fm-google hidden></div>
    <span class="cx-float-pill" data-fm-count></span>
    <div class="cx-fabs"><button class="cx-fab ${googleView?'on':''}" data-fm="google" title="${t('Google view with nearby places')}" aria-label="${t('Google view with nearby places')}">${i('layers')}</button><button class="cx-fab" data-fm="fit" title="${t('Show all vehicles')}" aria-label="${t('Show all vehicles')}">${i('scan')}</button></div>
    ${peek?'<div class="cx-peek" data-fm-peek hidden></div>':''}`;
  const el=host.querySelector<HTMLElement>('[data-fm-map]')!,gHost=host.querySelector<HTMLElement>('[data-fm-google]')!;
  const map=createMap(el),layer=L.layerGroup().addTo(map),saved=L.layerGroup().addTo(map);
  let picked='',fitted=false;
  const gl=googleLive(gHost,{onSelect:id=>pick(id),covered:()=>host.querySelector<HTMLElement>('[data-fm-peek]:not([hidden])')?.offsetHeight||0});
  const resize=new ResizeObserver(()=>map.invalidateSize());resize.observe(el);
  const fit=()=>{const pts=fleet.devices.flatMap(d=>d.position?[point(d.position)]:[]);if(pts.length)map.fitBounds(pts,{padding:[70,70],maxZoom:15})};
  function pick(id:string){if(!peek){openVehicle(id);return}picked=id;update();const d=vehicle(id);if(d?.position&&!googleView)map.panTo(point(d.position))}
  function update(){
    const list=fleet.devices;
    host.querySelector('[data-fm-count]')!.innerHTML=`<i></i>${t('{n} live',{n:list.filter(d=>d.online).length})} · ${t('{n} vehicles',{n:list.length})}`;
    layer.clearLayers();
    for(const d of list)if(d.position)L.marker(point(d.position),{icon:fleetIcon(d,d.id===picked,d.id===picked||list.length<=3),title:d.name,zIndexOffset:d.id===picked?1000:overspeeding(d)?500:0}).addTo(layer).on('click',e=>{L.DomEvent.stopPropagation(e);pick(d.id)});
    saved.clearLayers();
    for(const f of fleet.fences)L.circle(point(f),{radius:f.radius,color:'#0d5c52',weight:2,fillOpacity:.06}).bindTooltip(`${placeIcon(f.kind)} ${esc(f.name)}`,{permanent:true,direction:'center',className:'fence-label'}).addTo(saved);
    if(!fitted&&list.some(d=>d.position)){fitted=true;requestAnimationFrame(fit)}
    gHost.hidden=!googleView;el.style.visibility=googleView?'hidden':'';
    if(googleView)gl.update(list,picked,picked?trails.get(picked):[]);
    const pk=host.querySelector<HTMLElement>('[data-fm-peek]');
    if(pk){const d=vehicle(picked);pk.hidden=!d;if(d){pk.innerHTML=vehicleRow(d);on('[data-open]',b=>openVehicle(b.dataset.open!),pk);icons()}}
  }
  map.on('click',()=>{if(picked){picked='';update()}});
  host.querySelectorAll<HTMLElement>('[data-fm]').forEach(b=>b.addEventListener('click',()=>{
    if(b.dataset.fm==='fit'){picked='';if(googleView){setGoogle(false);host.querySelector('[data-fm="google"]')!.classList.remove('on')}update();map.invalidateSize();fit();return}
    setGoogle(!googleView);b.classList.toggle('on',googleView);update();if(!googleView)map.invalidateSize();
  }));
  update();icons();
  return {update,destroy(){resize.disconnect();gl.destroy();map.remove()}};
}

/* ---------- Dashboard ---------- */
// Plate numbers are matched without spaces or dashes, so "MH12AB" and a spoken "MH 12 AB" both find it.
const squash=(s:string)=>s.toLowerCase().replace(/[^a-z0-9ऀ-ॿ]/g,'');
let todayFleetKm:{at:number;km:number|null}={at:0,km:null};
async function loadFleetKm(done:()=>void){
  if(Date.now()-todayFleetKm.at<60000)return;
  todayFleetKm={at:Date.now(),km:todayFleetKm.km};
  try{const r=await reports(dayStart(),new Date());todayFleetKm={at:Date.now(),km:Math.round(r.vehicles.reduce((s,v)=>s+v.total.distanceKm,0)*10)/10};done()}catch{/* shown as … */}
}
// Free voice search through the browser's own speech recognition (Chrome on Android, Edge, Safari).
const Speech=(window as unknown as {SpeechRecognition?:new()=>any;webkitSpeechRecognition?:new()=>any}).SpeechRecognition||(window as unknown as {webkitSpeechRecognition?:new()=>any}).webkitSpeechRecognition;
function renderHome(){
  const host=$('#view'),desktop=matchMedia('(min-width:901px)').matches,p=prefs();
  host.innerHTML=`<div class="cx-home">
    <section class="cx-home-list">
      ${appBar('Dashboard')}
      <div class="cx-welcome">
        <div class="cx-welcome-top"><span class="cx-tile dark">${i('truck')}</span><div><b>${t('Namaste, {n} ji',{n:esc((p.name||p.workspace).split(' ')[0])})}</b><small>${esc(p.workspace)}</small></div><span class="cx-live"><i></i>${t('Live sync')}</span></div>
        <div class="cx-today" id="today"></div>
        <label class="cx-search">${i('search')}<input id="q" placeholder="${t('Search or speak a vehicle number or driver (e.g. HR 55)')}" value="${esc(search)}" autocomplete="off">${Speech?`<button type="button" class="cx-mic" id="mic" aria-label="${t('Search by voice')}">${i('mic')}</button>`:''}</label>
      </div>
      <div class="cx-kpis" id="kpis"></div>
      <div id="urgent"></div>
      <h3 class="cx-section">${t('Quick actions')}</h3>
      <div class="cx-quick">${([['history','Route history','route'],['reports','Reports','chart-column'],['ebills','E-way bills','file-text'],['geofences','Places','map-pin']] as [View,string,string][]).map(([v,l,ic])=>`<button data-go="${v}"><span class="cx-tile">${i(ic)}</span>${t(l)}</button>`).join('')}</div>
      <div class="cx-fleet-head"><h2>${t('Live status of vehicles')} <small>(Live Fleet)</small></h2><span id="fleetcount"></span></div>
      <div class="cx-cards" id="list"></div>
    </section>
    ${desktop?'<section class="cx-home-map" id="homemap"></section>':''}
  </div>`;
  const input=$<HTMLInputElement>('#q');input.oninput=()=>{search=input.value;drawList()};
  on('#mic',btn=>{
    const r=new Speech!();r.lang='en-IN';r.interimResults=false;r.maxAlternatives=1;
    btn.classList.add('on');
    r.onresult=(e:any)=>{search=String(e.results[0][0].transcript||'');input.value=search;drawList()};
    r.onerror=()=>toast(t('Could not hear that. Try again.'),true);
    r.onend=()=>btn.classList.remove('on');
    r.start();
  });
  on('[data-go]',el=>go(el.dataset.go as View),host);
  const fm=desktop?fleetMap($('#homemap'),{peek:false}):undefined;
  const drawTop=()=>{
    const list=fleet.devices,n={running:0,stopped:0,offline:0};for(const d of list)n[group(statusOf(d))]++;
    const idle=list.filter(d=>statusOf(d)==='idle').length,moving=list.filter(d=>statusOf(d)==='running'&&d.position);
    const avg=moving.length?Math.round(moving.reduce((s,d)=>s+d.position!.speed,0)/moving.length):0;
    const unseen=fleet.alerts.filter(a=>!a.acknowledged),overNow=list.filter(overspeeding).length;
    const top=unseen[0]?CATEGORIES.find(c=>c.key===categoryOf(unseen[0].type)):undefined;
    $('#today').innerHTML=`${i('clock')}<span>${t('Today: {a} vehicles on duty',{a:list.filter(d=>d.online).length})} · <b class="run">${t('{n} moving',{n:n.running})}</b></span><em>${clock(Date.now())}</em>`;
    const kpi=(f:typeof filter|'',cls:string,label:string,value:string,unit:string,note:string,ic:string)=>`<button class="cx-kpi ${cls} ${f&&filter===f?'on':''}" ${f?`data-filter="${f}"`:'data-go="alerts"'}><span class="cx-kpi-label">${label}${ic}</span><b>${value}<small>${unit}</small></b><span class="cx-kpi-note">${note}</span></button>`;
    $('#kpis').innerHTML=
      kpi('running','',t('Moving vehicles'),String(n.running),t('/ {n} total',{n:list.length}),`${i('gauge')}${t('Average speed {n} km/h',{n:avg})}`,`<span class="cx-live sm"><i></i>${t('Live')}</span>`)+
      kpi('stopped','',t('Standing vehicles'),String(n.stopped),t('vehicles'),`${i('circle-parking')}${idle?t('{n} with engine on',{n:idle}):t('{n} offline',{n:n.offline})}`,i('moon-star'))+
      kpi('',unseen.length||overNow?'danger':'',t('Danger & warnings'),String(unseen.length),t('need attention'),`${i('triangle-alert')}${overNow?t('{n} overspeeding now',{n:overNow}):top?esc(t(top.label)):t('All clear')}`,i('circle-alert'))+
      `<div class="cx-kpi"><span class="cx-kpi-label">${t('Distance today')}${i('route')}</span><b>${todayFleetKm.km==null?'…':todayFleetKm.km}<small>km</small></b><span class="cx-kpi-note">${i('truck')}${t('All vehicles together')}</span></div>`;
    on('[data-filter]',el=>{const f=el.dataset.filter as typeof filter;filter=filter===f?'all':f;drawTop();drawList()},$('#kpis'));
    on('[data-go]',el=>go(el.dataset.go as View),$('#kpis'));
    // The one thing that needs attention first: an open SOS, a vehicle speeding now, or the newest alert.
    const sos=unseen.find(a=>a.type==='sos'),speeder=list.find(overspeeding),latest=unseen[0];
    const focus=sos?{d:vehicle(sos.deviceId),tag:t('SOS'),line:alertText(sos)}:speeder?{d:speeder,tag:t('Overspeed'),line:`${Math.round(speeder.position!.speed)} km/h · ${placeSpan(speeder.position,speeder.id,{short:true})}`,raw:true}:latest?{d:vehicle(latest.deviceId),tag:t(CATEGORIES.find(c=>c.key===categoryOf(latest.type))!.label),line:alertText(latest)}:null;
    $('#urgent').innerHTML=focus?.d?`<div class="cx-urgent">
        <div class="cx-urgent-top"><span class="cx-tile danger">${i('triangle-alert')}</span><div><b class="cx-plate">${esc(focus.d.name)}</b><span class="cx-tag danger">${esc(focus.tag)}</span><p>${focus.raw?focus.line:esc(focus.line)}</p>${focus.d.driver?`<small>${t('Driver: {n}',{n:esc(focus.d.driver)})}${speeder&&focus.d===speeder?` (${t('speed limit {n} km/h',{n:speeder.speedLimit})})`:''}</small>`:''}</div></div>
        <div class="cx-urgent-acts"><button class="cx-btn dark" data-open="${focus.d.id}">${i('map')}${t('View vehicle')}</button><button class="cx-btn soft" data-go="alerts">${i('bell-ring')}${t('All alerts')}</button></div></div>`:'';
    on('[data-open]',el=>openVehicle(el.dataset.open!),$('#urgent'));
    on('[data-go]',el=>go(el.dataset.go as View),$('#urgent'));
    icons();
  };
  const order=['running','stopped','offline'];
  const drawList=()=>{
    const q=squash(search);
    const list=fleet.devices.filter(d=>(filter==='all'||group(statusOf(d))===filter)&&squash(`${d.name} ${d.driver}`).includes(q))
      .sort((a,b)=>Number(overspeeding(b))-Number(overspeeding(a))||order.indexOf(group(statusOf(a)))-order.indexOf(group(statusOf(b)))||a.name.localeCompare(b.name));
    $('#fleetcount').textContent=filter==='all'&&!q?t('{n} vehicles',{n:fleet.devices.length}):t('{n} of {m}',{n:list.length,m:fleet.devices.length});
    $('#list').innerHTML=list.length?`${filter!=='all'?`<button class="cx-clear" data-clear>${i('x')}${t('Showing: {f}',{f:t(filter==='running'?'Moving':filter==='stopped'?'Standing':'Offline')})}</button>`:''}${list.map(fleetCard).join('')}`:`<div class="cx-empty">${i('truck')}<h3>${t(fleet.devices.length?'No vehicles match':'No vehicles yet')}</h3><p>${t(fleet.devices.length?'Try another filter.':'Your fleet administrator will add your GPS devices here.')}</p></div>`;
    on('[data-open]',el=>openVehicle(el.dataset.open!),$('#list'));
    on('[data-clear]',()=>{filter='all';drawTop();drawList()},$('#list'));
    icons();
  };
  drawTop();drawList();void loadFleetKm(drawTop);
  onRefresh=()=>{drawTop();drawList();fm?.update();void loadFleetKm(drawTop)};
  teardown=()=>fm?.destroy();
}
// A vehicle on the dashboard: plate, speed or state, where it is and how fresh that is, driver.
function fleetCard(d:Vehicle){
  const p=d.position,s=statusOf(d),over=overspeeding(d),g=over?'sos':group(s);
  const right=s==='running'&&p?`<span class="cx-speed ${over?'sos':'run'}"><i></i>${Math.round(p.speed)} ${t('km/h')}</span><small>${t(over?'Overspeed':'Running')}</small>`
    :(s==='stopped'||s==='idle')?`<span class="cx-speed stand"><i></i>${t(s==='idle'?'Idle':'Engine off')}</span><small>${d.stoppedSince?t('since {d}',{d:since(d.stoppedSince)}):''}</small>`
    :`<span class="cx-speed off"><i></i>${statusLabel(s)}</span><small>${ago(d.lastSeen)}</small>`;
  const mine=p?nearSaved(p.latitude,p.longitude,fleet.fences):null;
  return `<article class="cx-card ${over?'over':''}" data-open="${d.id}" role="button" tabindex="0">
    <div class="cx-card-top"><div><b class="cx-plate">${esc(d.name)}</b>${d.isMobile?`<span class="cx-chip">${t('Driver phone')}</span>`:''}</div><div class="cx-card-state">${right}</div></div>
    <div class="cx-card-place"><span class="cx-mini-ico ${g}">${i(s==='running'?'navigation':s==='stopped'||s==='idle'?'circle-parking':'wifi-off')}</span><div><b>${mine?esc(mine):placeSpan(p,d.id,{short:true})}</b><small>${ago(p?.recordedAt??d.lastSeen)}${mine?` · ${placeSpan(p,d.id,{short:true})}`:''}</small></div></div>
    <div class="cx-card-foot"><div class="cx-cell"><span>${i('key-round')}${t('Ignition')}</span><b class="${d.ignition?'run':''}">${d.ignition==null?'—':d.ignition?t('On'):t('Off')}</b></div><div class="cx-cell"><span>${t('Driver')}</span><b>${esc(d.driver||'—')}</b></div><span class="cx-go ${over?'sos':''}">${i('arrow-right')}</span></div>
  </article>`;
}
// The header of the main pages: fleet name, page title, alerts bell and profile.
function appBar(title:string){
  const p=prefs(),n=openAlerts();
  return `<header class="cx-appbar"><div><small>${esc(p.workspace)}</small><h1>${t(title)}</h1></div><button class="cx-bell" data-go="alerts" aria-label="${t('Alerts')}">${i('bell')}<span class="cx-dot" data-alert-dot ${n?'':'hidden'}></span></button><button class="cx-avatar-btn" data-go="settings" aria-label="${t('Settings')}">${i('user-round')}</button></header>`;
}

/* ---------- Map ---------- */
function renderMap(){
  $('#view').innerHTML='<div class="cx-fullmap" id="fullmap"></div>';
  const fm=fleetMap($('#fullmap'),{peek:true});
  onRefresh=()=>fm.update();teardown=()=>fm.destroy();
}

/* ---------- Vehicle page ---------- */
const todayKm=new globalThis.Map<string,{at:number;km:number|null}>();
const nearCache=new globalThis.Map<string,string>();
const dayStart=(offset=0)=>{const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()+offset);return d};
function reports(from:Date,to:Date,device?:string){
  return api<{vehicles:VehicleReport[]}>(`/reports?${new URLSearchParams({from:from.toISOString(),to:to.toISOString(),tz:String(new Date().getTimezoneOffset()),...(device?{device}:{})})}`);
}
function renderVehicle(){
  const d0=vehicle(vehicleId);if(!d0){go('home');return}
  $('#view').innerHTML=`<div class="cx-vpage">
    <section class="cx-vmap"><div class="cx-map" id="vmap"></div><div class="gwrap" id="vgoogle" hidden></div>
      <button class="cx-fab cx-vback" data-back aria-label="${t('Back')}">${i('arrow-left')}</button>
      <div class="cx-fabs"><button class="cx-fab ${googleView?'on':''}" id="vgtoggle" title="${t('Google view with nearby places')}" aria-label="${t('Google view with nearby places')}">${i('layers')}</button><button class="cx-fab ${following?'on':''}" id="vfollow" title="${t('Follow selected vehicle')}" aria-label="${t('Follow selected vehicle')}">${i('locate-fixed')}</button></div></section>
    <section class="cx-vbody" id="vbody"></section></div>`;
  on('[data-back]',back);
  const el=$('#vmap'),p0=d0.position;
  const map=createMap(el,p0?point(p0):[22.5,79],p0?16:5);
  const trailLine=L.polyline([],{color:'#0d5c52',weight:5,opacity:.75}).addTo(map);
  let marker:L.Marker|undefined;
  const gl=googleLive($('#vgoogle'));
  const resize=new ResizeObserver(()=>map.invalidateSize());resize.observe(el);
  teardown=()=>{resize.disconnect();gl.destroy();map.remove()};
  const drawMap=()=>{
    const d=vehicle(vehicleId);if(!d)return;
    const p=d.position,tr=trails.get(d.id)||[];
    trailLine.setLatLngs(tr.map(point));
    if(p){
      if(!marker)marker=L.marker(point(p),{icon:fleetIcon(d,true,true),zIndexOffset:1000}).addTo(map);
      else{marker.setLatLng(point(p));marker.setIcon(fleetIcon(d,true,true))}
      if(following&&!map.getBounds().pad(-0.25).contains(point(p)))map.panTo(point(p));
    }
    $('#vgoogle').hidden=!googleView;el.style.visibility=googleView?'hidden':'';
    if(googleView)gl.update([d],d.id,tr);
  };
  on('#vgtoggle',b=>{setGoogle(!googleView);b.classList.toggle('on',googleView);drawMap();if(!googleView)map.invalidateSize();drawBody()});
  on('#vfollow',b=>{following=!following;b.classList.toggle('on',following);const p=vehicle(vehicleId)?.position;if(following&&p)map.panTo(point(p))});
  const drawBody=()=>{
    const d=vehicle(vehicleId);if(!d)return;
    const p=d.position,km=todayKm.get(d.id),s=statusOf(d),over=overspeeding(d);
    if(!km||Date.now()-km.at>60000)void loadTodayKm(d.id,drawBody);
    const mine=p?nearSaved(p.latitude,p.longitude,fleet.fences):null;
    if(p&&!mine&&!nearCache.has(placeKey(p))){const key=placeKey(p);nearCache.set(key,'');void nearest(p.latitude,p.longitude).then(n=>{if(n){nearCache.set(key,nearText(n));if(vehicleId===d.id)drawBody()}})}
    const near=mine||(p?nearCache.get(placeKey(p)):'');
    const standing=(s==='stopped'||s==='idle')&&d.stoppedSince;
    $('#vbody').innerHTML=`<div class="cx-grab"></div>
      <div class="cx-vhead"><div><h1 class="cx-plate">${esc(d.name)}</h1><div class="cx-vsub">${statusPill(d)}${d.driver?`<span>${i('user-round')}${esc(d.driver)}</span>`:''}</div></div><button class="cx-icon" id="vshare" aria-label="${t('Share')}">${i('share-2')}</button></div>
      <div class="cx-place">${i('map-pin')}<div><b>${placeSpan(p,d.id)}</b>${near?`<small class="near">${esc(near)}</small>`:''}<small>${t('Last GPS signal: {a}',{a:ago(p?.recordedAt??d.lastSeen)})}</small></div></div>
      <div class="cx-stats">
        <div class="${over?'sos':''}"><span>${t('Speed')}</span><b>${p&&d.fresh?Math.round(p.speed):0}<small>km/h</small></b><em>${t('Limit {n}',{n:d.speedLimit})}</em></div>
        <div><span>${t('Today')}</span><b>${km?.km==null?'…':km.km}<small>km</small></b><em>${t('Distance')}</em></div>
        <div class="${d.ignition?'good':''}"><span>${t('Ignition')}</span><b>${d.ignition==null?'—':d.ignition?t('On'):t('Off')}</b><em>${standing?t('standing for {d}',{d:since(d.stoppedSince!)}):statusLabel(s)}</em></div>
      </div>
      <div class="cx-group">
        <button class="cx-item" id="vhistory"><span class="cx-ico">${i('history')}</span><span class="cx-item-text"><b>${t('Route history')}</b><small>${t('Replay any day on the map')}</small></span>${i('chevron-right')}</button>
        <label class="cx-item"><span class="cx-ico">${i('layers')}</span><span class="cx-item-text"><b>${t('Google view')}</b><small>${t('Google map with all nearby places')}</small></span><input type="checkbox" class="cx-switch" id="vgswitch" ${googleView?'checked':''}></label>
        <button class="cx-item" id="vspeed"><span class="cx-ico">${i('gauge')}</span><span class="cx-item-text"><b>${t('Overspeed alert')}</b><small>${d.speedAlert===false?t('Off'):t('Speed limit: {n} km/h',{n:d.speedLimit})}</small></span>${i('chevron-right')}</button>
        ${p?`<button class="cx-item" id="vsave"><span class="cx-ico">${i('map-pin')}</span><span class="cx-item-text"><b>${t('Save place')}</b><small>${t('Name this spot, e.g. petrol pump or depot')}</small></span>${i('chevron-right')}</button>`:''}
        ${d.isMobile?`<button class="cx-item" id="vdriver"><span class="cx-ico">${i('smartphone')}</span><span class="cx-item-text"><b>${t('Driver link')}</b><small>${t("Share location from the driver's phone")}</small></span>${i('chevron-right')}</button>`:''}
        ${p?`<a class="cx-item" href="${mapsLink(p)}" target="_blank" rel="noopener"><span class="cx-ico">${i('navigation')}</span><span class="cx-item-text"><b>${t('Directions')}</b><small>${t('Open in Google Maps')}</small></span>${i('external-link')}</a>`:''}
      </div>`;
    on('#vshare',async()=>{if(!p)return;const text=`${d.name}: ${places.get(placeKey(p))?.label||coords(p)}\n${mapsLink(p)}`;if(navigator.share)await navigator.share({title:d.name,text}).catch(()=>{});else{await navigator.clipboard.writeText(text);toast(t('Location copied.'))}});
    on('#vhistory',()=>{historyVehicle=d.id;go('history')});
    on('#vspeed',()=>speedSettings(d,drawBody));
    on('#vsave',()=>addFence({latitude:p!.latitude,longitude:p!.longitude,radius:150}));
    on('#vdriver',()=>driverLink(d));
    $<HTMLInputElement>('#vgswitch').onchange=e=>{setGoogle((e.target as HTMLInputElement).checked);$('#vgtoggle').classList.toggle('on',googleView);drawMap();if(!googleView)map.invalidateSize()};
    icons();
  };
  drawMap();drawBody();
  onRefresh=()=>{if(!vehicle(vehicleId)){go('home');return}drawMap();drawBody()};
}
async function loadTodayKm(id:string,done:()=>void){
  todayKm.set(id,{at:Date.now(),km:todayKm.get(id)?.km??null});
  try{const r=await reports(dayStart(),new Date(),id);todayKm.set(id,{at:Date.now(),km:r.vehicles[0]?.total.distanceKm??0});if(vehicleId===id)done()}catch{/* shown as … */}
}

/* ---------- Alerts ---------- */
let alertsCat:Category|'all'='all';
function renderAlerts(){
  const draw=()=>{
    const unseen=(c:Category|'all')=>fleet.alerts.filter(a=>!a.acknowledged&&(c==='all'||categoryOf(a.type)===c)).length;
    const cats=CATEGORIES.filter(c=>fleet.alerts.some(a=>categoryOf(a.type)===c.key));
    const list=fleet.alerts.filter(a=>alertsCat==='all'||categoryOf(a.type)===alertsCat).sort((a,b)=>b.createdAt-a.createdAt);
    const dayOf=(at:number)=>{const d=new Date(at);d.setHours(0,0,0,0);const diff=Math.round((+dayStart()-+d)/86400000);return diff===0?t('Today'):diff===1?t('Yesterday'):d.toLocaleDateString(locale(),{weekday:'long',day:'numeric',month:'short'})};
    const days=new globalThis.Map<string,Alert[]>();for(const a of list){const k=dayOf(a.createdAt);if(!days.has(k))days.set(k,[]);days.get(k)!.push(a)}
    const style=(type:string)=>{const c=CATEGORIES.find(x=>x.key===categoryOf(type))!;const ic=type==='ignition_on'||type==='ignition_off'?'power':type==='online'?'activity':c.icon;const tone=type==='sos'||type==='speed'||type==='offline'?'sos':type==='ignition_on'||type==='online'||type==='share_resumed'?'good':type==='ignition_off'?'neutral':'warn';return {ic,tone}};
    $('#view').innerHTML=`<div class="cx-page">
      ${unseen('all')?`<div class="cx-head end"><button class="cx-btn soft sm" id="ack-all">${i('check-check')}${t('Mark all seen')}</button></div>`:''}
      ${cats.length>1?`<div class="cx-chips"><button data-cat="all" class="${alertsCat==='all'?'on':''}">${t('All')}</button>${cats.map(c=>`<button data-cat="${c.key}" class="${alertsCat===c.key?'on':''}">${esc(t(c.label))}${unseen(c.key)?`<b>${unseen(c.key)}</b>`:''}</button>`).join('')}</div>`:''}
      ${list.length?[...days].map(([day,items])=>`<h3 class="cx-section">${esc(day)}</h3><div class="cx-group">${items.map(a=>{const st=style(a.type);return `<button class="cx-item cx-alert ${a.acknowledged?'':'new'}" data-alert="${a.id}"><span class="cx-ico ${st.tone}">${i(st.ic)}</span><span class="cx-item-text"><b>${esc(a.deviceName)}</b><small>${esc(alertText(a))}</small></span><span class="cx-time">${clock(a.createdAt)}</span></button>`}).join('')}</div>`).join(''):`<div class="cx-empty">${i('bell')}<h3>${t('All clear')}</h3><p>${t('SOS, engine, geofence, overspeed, hard braking and signal alerts appear here.')}</p></div>`}
    </div>`;
    on('[data-cat]',el=>{alertsCat=el.dataset.cat as Category|'all';draw()});
    // Opening an alert marks it seen and goes where it points: the driver link or the vehicle.
    on('[data-alert]',async el=>{
      const a=fleet.alerts.find(x=>x.id===el.dataset.alert)!;
      if(!a.acknowledged){await post(`/alerts/${a.id}/ack`);a.acknowledged=1;updateBadges()}
      const v=vehicle(a.deviceId);if(!v){draw();return}
      if(a.type==='share_stopped'||a.type==='share_expired'){draw();driverLink(v)}else openVehicle(v.id);
    });
    on('#ack-all',async()=>{const ids=fleet.alerts.filter(a=>!a.acknowledged).map(a=>a.id);for(const id of ids)await post(`/alerts/${id}/ack`);fleet.alerts.forEach(a=>{a.acknowledged=1});updateBadges();draw();toast(t('All marked seen.'))});
    icons();
  };
  draw();onRefresh=draw;
}

/* ---------- More ---------- */
function renderMore(){
  $('#view').innerHTML=`<div class="cx-page">
    ${appBar('More')}
    ${MORE.map(([g,items])=>`<h3 class="cx-section">${t(g)}</h3><div class="cx-group">${items.map(([v,l,ic,h])=>`<button class="cx-item" data-go="${v}"><span class="cx-ico">${i(ic)}</span><span class="cx-item-text"><b>${t(l)}</b><small>${t(h)}</small></span>${i('chevron-right')}</button>`).join('')}</div>`).join('')}
  </div>`;
  on('#view [data-go]',el=>go(el.dataset.go as View));icons();
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
  historyVehicle=historyVehicle||fleet.devices[0]?.id||'';
  const [from,to]=rangeFor('today');
  $('#view').innerHTML=`<div class="cx-history"><section class="cx-hmap"><div class="cx-map" id="hmap"></div></section>
    <section class="cx-hpanel">
      <label class="cx-field">${t('Vehicle')}<select id="hv">${fleet.devices.map(d=>`<option value="${d.id}" ${d.id===historyVehicle?'selected':''}>${esc(d.name)}</option>`).join('')}</select></label>
      <div class="cx-chips" id="presets">${[['today','Today'],['yesterday','Yesterday'],['week','Last 7 days'],['custom','Custom']].map(([k,l],n)=>`<button data-preset="${k}" class="${n?'':'on'}">${t(l)}</button>`).join('')}</div>
      <div class="cx-row2" id="custom" hidden><label class="cx-field">${t('From')}<input type="datetime-local" id="hfrom" value="${localInput(from)}"></label><label class="cx-field">${t('To')}<input type="datetime-local" id="hto" value="${localInput(to)}"></label><button class="cx-btn primary" id="load">${t('Show route')}</button></div>
      <div class="cx-player" id="hplayer" hidden><button class="cx-play" id="play" aria-label="${t('Play')}">${i('play')}</button><div><input type="range" id="slider" min="0" max="0" value="0" aria-label="${t('Route position')}"><p id="hpoint"></p></div></div>
      <div class="cx-stats four" id="hsum" hidden></div>
      <p class="cx-hint" id="hstatus">${t(fleet.devices.length?'Choose a day and press Show route.':'No vehicles yet.')}</p>
      <div class="cx-group" id="hactions" hidden>
        <button class="cx-item" id="hgoogle"><span class="cx-ico">${i('layers')}</span><span class="cx-item-text"><b>${t('See this point on Google')}</b></span>${i('chevron-right')}</button>
        <button class="cx-item" id="hsave"><span class="cx-ico">${i('map-pin')}</span><span class="cx-item-text"><b>${t('Save place')}</b></span>${i('chevron-right')}</button>
        <button class="cx-item" id="csv"><span class="cx-ico">${i('download')}</span><span class="cx-item-text"><b>${t('Download CSV')}</b></span>${i('chevron-right')}</button>
      </div>
    </section></div>`;
  const hmap=createMap($('#hmap')),layer=L.layerGroup().addTo(hmap);let truck:L.Marker|undefined;
  const resize=new ResizeObserver(()=>hmap.invalidateSize());resize.observe($('#hmap'));
  teardown=()=>{clearInterval(playTimer);resize.disconnect();hmap.remove()};
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
    $('#hpoint').innerHTML=`<b>${clock(p.recordedAt)}</b> · ${Math.round(p.speed)} km/h · <span>${placeSpan(p,'history',{lookup:!playTimer,short:true})}</span>`;
    if(!hmap.getBounds().pad(-0.15).contains(point(p)))hmap.panTo(point(p),{animate:true});
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
    $('#hstatus').textContent=t('Loading route…');$('#hplayer').hidden=true;$('#hsum').hidden=true;$('#hactions').hidden=true;
    try{
      const points:Fix[]=[];let after:number|null=0;
      do{const r:{positions:Fix[];next:number|null}=await api(`/devices/${historyVehicle}/history?${new URLSearchParams({from:from.toISOString(),to:to.toISOString(),after:String(after)})}`);points.push(...r.positions);after=r.next}while(after!==null&&points.length<100000);
      track=points.filter(p=>p.valid!==0).sort((a,b)=>a.recordedAt-b.recordedAt||a.id-b.id);
      if(!track.length){$('#hstatus').textContent=t('No movement recorded in this period.');return}
      drawRoute(layer,track);hmap.fitBounds(track.map(point),{padding:[40,40],maxZoom:16});
      const slider=$<HTMLInputElement>('#slider');slider.max=String(track.length-1);slider.value='0';
      $('#hplayer').hidden=false;$('#hactions').hidden=false;showPoint(0);
      $('#hstatus').textContent=`${time(track[0].recordedAt)} – ${time(track.at(-1)!.recordedAt)}`;
      const r=(await reports(from,to,historyVehicle)).vehicles[0];
      if(r){const gaps=r.days.flatMap(d=>d.gaps);$('#hsum').innerHTML=`<div><span>${t('Distance')}</span><b>${r.total.distanceKm}<small>km</small></b></div><div><span>${t('Running')}</span><b>${hm(r.total.runningMinutes)}</b></div><div><span>${t('Idle')}</span><b>${hm(r.total.idleMinutes)}</b></div><div><span>${t('Max speed')}</span><b>${r.total.maxSpeed}<small>km/h</small></b></div>${gaps.map(g=>`<p class="cx-note">${i('triangle-alert')}${esc(gapNote(g))}</p>`).join('')}`;$('#hsum').hidden=false;icons()}
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
  $('#view').innerHTML=`<div class="cx-page">
    <div class="cx-chips" id="rpresets">${[['today','Today'],['yesterday','Yesterday'],['week','Last 7 days'],['month','This month'],['custom','Custom']].map(([k,l],n)=>`<button data-preset="${k}" class="${n?'':'on'}">${t(l)}</button>`).join('')}</div>
    <div class="cx-row2" id="rcustom" hidden><label class="cx-field">${t('From')}<input type="date" id="rfrom" value="${localInput(from).slice(0,10)}"></label><label class="cx-field">${t('To')}<input type="date" id="rto" value="${localInput(to).slice(0,10)}"></label><button class="cx-btn primary" id="rload">${t('Show report')}</button></div>
    <label class="cx-field">${t('Vehicle')}<select id="rv"><option value="">${t('All vehicles')}</option>${fleet.devices.map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></label>
    <div class="cx-stats four" id="rkpi"></div>
    <div id="rtable"></div>
    <button class="cx-btn soft" id="rcsv" hidden>${i('download')}${t('Download CSV')}</button></div>`;
  let preset='today',last:VehicleReport[]=[];
  on('[data-preset]',el=>{preset=el.dataset.preset!;$$('#rpresets [data-preset]').forEach(b=>b.classList.toggle('on',b===el));$('#rcustom').hidden=preset!=='custom';if(preset!=='custom')void load()});
  $<HTMLSelectElement>('#rv').onchange=()=>void load();
  const load=async()=>{
    const [from,to]=preset==='custom'?[new Date($<HTMLInputElement>('#rfrom').value+'T00:00'),new Date($<HTMLInputElement>('#rto').value+'T23:59:59')]:rangeFor(preset);
    if(!(+from<+to)||+to-+from>31*86400000){toast(t('Choose a range of up to 31 days.'),true);return}
    $('#rtable').innerHTML=`<p class="cx-hint">${t('Calculating…')}</p>`;
    try{
      last=(await reports(from,to,$<HTMLSelectElement>('#rv').value||undefined)).vehicles;
      const sum=last.reduce((s,v)=>({km:s.km+v.total.distanceKm,run:s.run+v.total.runningMinutes,idle:s.idle+v.total.idleMinutes,max:Math.max(s.max,v.total.maxSpeed)}),{km:0,run:0,idle:0,max:0});
      $('#rkpi').innerHTML=`<div><span>${t('Total distance')}</span><b>${Math.round(sum.km*10)/10}<small>km</small></b></div><div><span>${t('Running time')}</span><b>${hm(sum.run)}</b></div><div><span>${t('Idle time')}</span><b>${hm(sum.idle)}</b></div><div><span>${t('Top speed')}</span><b>${sum.max}<small>km/h</small></b></div>`;
      const day=(date:string)=>new Date(date+'T00:00').toLocaleDateString(locale(),{weekday:'short',day:'2-digit',month:'short'});
      $('#rtable').innerHTML=last.length?last.map(v=>`<h3 class="cx-section split"><span class="cx-plate">${esc(v.name)}</span><span>${v.total.distanceKm} km</span></h3><div class="cx-group">${v.days.map(d=>`<div class="cx-item static"><span class="cx-item-text"><b>${day(d.date)}</b><small>${t('Running')} ${hm(d.runningMinutes)} · ${t('Idle')} ${hm(d.idleMinutes)} · ${t('Max speed')} ${d.maxSpeed} km/h${d.firstMove?` · ${clock(d.firstMove)}–${clock(d.lastMove)}`:''}</small>${d.gaps.map(g=>`<p class="cx-note">${i('triangle-alert')}${esc(gapNote(g))}</p>`).join('')}</span><span class="cx-km">${d.distanceKm}<small>km</small></span></div>`).join('')||`<p class="cx-hint pad">${t('No movement recorded in this period.')}</p>`}</div>`).join(''):`<p class="cx-hint">${t('No vehicles.')}</p>`;
      $('#rcsv').hidden=!last.length;icons();
    }catch(e){$('#rtable').innerHTML=`<p class="cx-error">${esc((e as Error).message)}</p>`}
  };
  on('#rload',load);
  on('#rcsv',()=>download('waypoint-report.csv',[['Vehicle','Date','Distance km','Running min','Idle min','Max speed','Avg speed'],...last.flatMap(v=>v.days.map(d=>[v.name,d.date,d.distanceKm,d.runningMinutes,d.idleMinutes,d.maxSpeed,d.avgSpeed]))]));
  if(fleet.devices.length)void load();
}

/* ---------- Places ---------- */
type Stop={latitude:number;longitude:number;visits:number;totalMinutes:number;lastVisit:number;vehicles:string[]};
let stopsCache:{at:number;stops:Stop[]}|null=null;
const kindLabel=(kind?:string)=>t((PLACE_KIND[kind||'other']||PLACE_KIND.other)[1]);
function renderGeofences(){
  $('#view').innerHTML=`<div class="cx-page">
    <p class="cx-hint">${t('Your own places: petrol pumps, dhabas, depots, loading points. They show on the map with their name, and you get an alert when a vehicle enters or leaves one.')}</p>
    <button class="cx-btn primary" id="add-fence">${i('plus')}${t('Add place')}</button>
    ${fleet.fences.length?`<div class="cx-group">${fleet.fences.map(f=>`<div class="cx-item static"><span class="cx-ico emoji">${placeIcon(f.kind)}</span><span class="cx-item-text"><b>${esc(f.name)}</b><small>${esc(kindLabel(f.kind))} · ${f.radius} m · ${placeSpan(f,'fence-'+f.id,{short:true})}</small></span><button class="cx-icon" data-gfence="${f.id}" aria-label="${t('Google view')}">${i('layers')}</button><button class="cx-icon danger" data-del="${f.id}" aria-label="${t('Delete')}">${i('trash-2')}</button></div>`).join('')}</div>`:`<div class="cx-empty">${i('map-pin')}<h3>${t('No places yet')}</h3><p>${t("Save a vehicle's current place, or name one of the suggested stops below.")}</p></div>`}
    <h3 class="cx-section">${t('Suggested stops')}</h3>
    <p class="cx-hint">${t('Places where your vehicles stopped 10 minutes or more, at least 3 times in the last 14 days. Check what is there on Google and give it a name.')}</p>
    <div id="stops"><p class="cx-hint">${t('Looking at the last 14 days…')}</p></div></div>`;
  on('#add-fence',()=>addFence());
  on('[data-gfence]',el=>{const f=fleet.fences.find(x=>x.id===el.dataset.gfence)!;googleModal(f.name,f.latitude,f.longitude)});
  on('[data-del]',async el=>{const f=fleet.fences.find(x=>x.id===el.dataset.del)!;if(!confirm(t('Delete place {n}?',{n:f.name})))return;await api(`/fences/${f.id}`,{method:'DELETE'});fleet=await api<Fleet>('/state');stopsCache=null;renderGeofences()});
  icons();void showStops();
}
async function showStops(){
  try{
    if(!stopsCache||Date.now()-stopsCache.at>10*60000)stopsCache={at:Date.now(),stops:(await api<{stops:Stop[]}>('/stops?days=14')).stops};
    const host=document.querySelector<HTMLElement>('#stops');if(!host)return;
    const stops=stopsCache.stops;
    host.innerHTML=stops.length?`<div class="cx-group">${stops.map((s,n)=>`<div class="cx-item static"><span class="cx-ico">${i('circle-parking')}</span><span class="cx-item-text"><b>${placeSpan(s,'stop-'+n,{short:true})}</b><small>${t('{n} stops · {d} in all · last {t}',{n:s.visits,d:hm(s.totalMinutes),t:time(s.lastVisit)})} · ${esc(s.vehicles.join(', '))}</small></span><button class="cx-icon" data-sgoogle="${n}" aria-label="${t('Show on Google')}">${i('layers')}</button><button class="cx-btn soft sm" data-sname="${n}">${t('Name')}</button></div>`).join('')}</div>`:`<p class="cx-hint">${t('No regular stops yet. They appear once a vehicle has stopped at the same place 3 times.')}</p>`;
    on('[data-sgoogle]',el=>{const s=stops[Number(el.dataset.sgoogle)];googleModal(t('Stop · {n} visits',{n:s.visits}),s.latitude,s.longitude)},host);
    on('[data-sname]',el=>{const s=stops[Number(el.dataset.sname)];addFence({latitude:s.latitude,longitude:s.longitude,radius:150})},host);
    icons();
  }catch(e){const host=document.querySelector('#stops');if(host)host.innerHTML=`<p class="cx-error">${esc((e as Error).message)}</p>`}
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
  form.addEventListener('submit',async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(form));try{await post('/fences',{name:v.name,kind:v.kind,latitude:Number(v.latitude),longitude:Number(v.longitude),radius:Number(v.radius)});closeModal();fleet=await api<Fleet>('/state');stopsCache=null;if(view==='geofences')renderGeofences();toast(t('Place saved.'))}catch(err){$('#fence-error').textContent=(err as Error).message}});
}

/* ---------- Overspeed and driver link ---------- */
// The owner's own overspeed limit and on/off switch for one vehicle.
function speedForm(d:Vehicle,compact=false){
  return `<form class="form speed-form" data-speed="${d.id}">${compact?`<b class="cx-plate">${esc(d.name)}</b>`:''}
    <label class="field">${t('Speed limit (km/h)')}<input class="input" type="number" name="speedLimit" min="1" max="250" step="1" required value="${d.speedLimit}"></label>
    <label class="cx-item flat"><span class="cx-item-text"><b>${t('Alert me when crossed')}</b></span><input type="checkbox" class="cx-switch" name="speedAlert" ${d.speedAlert===false?'':'checked'}></label>
    <p class="error"></p><button class="btn btn-primary" type="submit">${t('Save')}</button></form>`;
}
function speedSettings(d?:Vehicle,done?:()=>void){
  const list=d?[d]:fleet.devices;
  modal(d?`${d.name} · ${t('Overspeed')}`:t('Overspeed limits'),`<p class="hint">${t('As soon as a vehicle goes faster than its limit you get an alert, a pop-up and a voice message.')}</p>${list.length?list.map(v=>speedForm(v,!d)).join('<hr class="sep">'):`<p class="muted">${t('No vehicles yet.')}</p>`}`);
  document.querySelectorAll<HTMLFormElement>('dialog.modal form[data-speed]').forEach(form=>form.addEventListener('submit',async e=>{
    e.preventDefault();const f=new FormData(form),err=form.querySelector('.error')!;err.textContent='';
    try{
      const r=await post<{speedLimit:number;speedAlert:boolean}>(`/devices/${form.dataset.speed}/speed`,{speedLimit:Number(f.get('speedLimit')),speedAlert:f.has('speedAlert')},'PUT');
      const v=vehicle(form.dataset.speed!);if(v){v.speedLimit=r.speedLimit;v.speedAlert=r.speedAlert}
      unlockVoice();toast(r.speedAlert?t('Overspeed alert on at {n} km/h.',{n:r.speedLimit}):t('Overspeed alert switched off.'));
      if(d)closeModal();done?.();
    }catch(x){err.textContent=(x as Error).message}
  }));
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
  const host=$('#view');host.innerHTML=`<div class="cx-page"><p class="cx-hint">${t('Loading…')}</p></div>`;
  try{const {mountDocuments}=await import('../main');const page=document.createElement('div');page.className='cx-page cx-docs';host.replaceChildren(page);mountDocuments(page,section,fleet.devices.map(d=>({name:d.name,model:'',driver:d.driver})))}
  catch{host.innerHTML=`<div class="cx-page"><p class="cx-error">${t('Unable to load this section. Refresh to retry.')}</p></div>`}
}

/* ---------- Settings ---------- */
const item=(icon:string,title:string,sub:string,end:string)=>`<label class="cx-item"><span class="cx-ico">${i(icon)}</span><span class="cx-item-text"><b>${title}</b>${sub?`<small>${sub}</small>`:''}</span>${end}</label>`;
const sw=(attr:string)=>`<input type="checkbox" class="cx-switch" ${attr}>`;
function renderSettings(){
  const p=prefs(),np=notifyPrefs(),lang=getLang();
  const limits=[...new Set(fleet.devices.map(d=>d.speedLimit))];
  $('#view').innerHTML=`<div class="cx-page">
    <button class="cx-profile" id="edit-profile"><span class="cx-avatar lg">${initial(p.workspace)}</span><span><b>${esc(p.name||p.workspace)}</b><small>${esc(p.workspace)} · ${esc(me.email||'')}</small></span>${i('pencil')}</button>

    <h3 class="cx-section">${t('Language')}</h3>
    <div class="cx-seg">${LANGS.map(([k,l])=>`<button data-lang="${k}" class="${lang===k?'on':''}">${l}</button>`).join('')}</div>

    <h3 class="cx-section">${t('Alert notifications')}</h3>
    <div class="cx-group">
      ${item('message-square',t('Show a pop-up message'),'',sw('data-n="popup"'))}
      ${item('volume-2',t('Speak alerts aloud'),voiceSupported()?t('Vehicle started, engine off, SOS, overspeed…'):t('Not supported in this browser'),sw('data-n="voice"'))}
      ${item('bell-ring',t('Browser notifications'),'<span id="browser-note"></span>',sw('data-n="browser"'))}
      <button class="cx-item" id="test-voice"><span class="cx-ico">${i('play')}</span><span class="cx-item-text"><b>${t('Test voice')}</b></span>${i('chevron-right')}</button>
    </div>

    <h3 class="cx-section">${t('Which alerts?')}</h3>
    <div class="cx-group">${CATEGORIES.map(c=>item(c.icon,esc(t(c.label)),esc(t(c.hint)),sw(`data-cat-n="${c.key}"`))).join('')}</div>

    <h3 class="cx-section">${t('Vehicles')}</h3>
    <div class="cx-group">
      <button class="cx-item" id="edit-speed"><span class="cx-ico">${i('gauge')}</span><span class="cx-item-text"><b>${t('Overspeed alert limit')}</b><small>${limits.length===1?t('Speed limit: {n} km/h',{n:limits[0]}):t('Set for each vehicle')}</small></span>${i('chevron-right')}</button>
      ${item('locate-fixed',t('Keep the map centred on the selected vehicle'),'',sw(`id="follow-pref" ${p.follow?'checked':''}`))}
      ${item('house',t('Open the app on'),'',`<select class="cx-select" id="default-view">${(['home','map','alerts'] as View[]).map(v=>`<option value="${v}" ${p.defaultView===v?'selected':''}>${t(TITLES[v])}</option>`).join('')}</select>`)}
    </div>

    ${DEMO_MODE?'':`<h3 class="cx-section">${t('Security')}</h3><div class="cx-group"><button class="cx-item" id="change-password"><span class="cx-ico">${i('key-round')}</span><span class="cx-item-text"><b>${t('Change password')}</b><small>${t('Your other devices will be signed out.')}</small></span>${i('chevron-right')}</button></div>`}

    <div class="cx-group spaced"><button class="cx-item danger" data-logout><span class="cx-ico">${i('log-out')}</span><span class="cx-item-text"><b>${t('Sign out securely')}</b></span></button></div>
    <p class="cx-foot">${t('App version: {v}',{v:APP_VERSION})} · <span class="ok">● ${t('Server online')}</span></p>
  </div>`;
  const note=()=>{const st=browserState();$('#browser-note').textContent=!browserSupported()?t('This browser cannot show notifications.'):st==='denied'?t('Blocked. Allow them from the lock icon in the address bar.'):st==='granted'?t('Allowed. Shown when this tab is in the background.'):t('Shown when this tab is in the background.')};
  $$<HTMLInputElement>('[data-n]').forEach(box=>{const k=box.dataset.n as 'popup'|'voice'|'browser';box.checked=np[k];box.addEventListener('change',async()=>{
    if(k==='browser'&&box.checked){const r=await askBrowserPermission();if(r!=='granted'){box.checked=false;note();toast(t('Browser notifications were not allowed.'),true);return}}
    if(k==='voice')unlockVoice();
    np[k]=box.checked;await saveNotify(np);note();toast(t('Saved.'))})});
  $$<HTMLInputElement>('[data-cat-n]').forEach(box=>{const k=box.dataset.catN as Category;box.checked=np.categories[k];box.addEventListener('change',async()=>{np.categories[k]=box.checked;await saveNotify(np);toast(t('Saved.'))})});
  on('[data-lang]',el=>{setLang(el.dataset.lang as Lang);render();toast(t('Language changed.'))});
  on('#test-voice',()=>{unlockVoice();speakAlert('Vehicle {n} started',{n:fleet.devices[0]?.name||'MH 12 AB 1234'})});note();
  on('#edit-speed',()=>speedSettings(undefined,renderSettings));
  on('#edit-profile',editProfile);
  on('#change-password',changePassword);
  $<HTMLSelectElement>('#default-view').onchange=async e=>{await savePrefs({defaultView:(e.target as HTMLSelectElement).value as View});toast(t('Saved.'))};
  $<HTMLInputElement>('#follow-pref').onchange=async e=>{const v=(e.target as HTMLInputElement).checked;await savePrefs({follow:v});following=v;toast(t('Saved.'))};
  on('[data-logout]',logout);icons();
}
function editProfile(){
  const p=prefs();
  modal(t('Edit profile'),`<form class="form" id="prefs"><label class="field">${t('Your name')}<input class="input" name="name" maxlength="100" value="${esc(p.name)}"></label><label class="field">${t('Fleet name')}<input class="input" name="workspace" maxlength="100" required value="${esc(p.workspace)}"></label>
    <p class="error" id="prefs-error"></p><button class="btn btn-primary" type="submit">${t('Save')}</button></form>`);
  $('#prefs').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target as HTMLFormElement);try{await savePrefs({name:String(f.get('name')).trim(),workspace:String(f.get('workspace')).trim()||t('My fleet')});closeModal();toast(t('Saved.'));render()}catch(err){$('#prefs-error').textContent=(err as Error).message}});
}
function changePassword(){
  modal(t('Change password'),`<form class="form" id="password"><p class="hint">${t('Signed in as {e}. Your other devices will be signed out.',{e:esc(me.email)})}</p>
    <label class="field">${t('Current password')}<input class="input" type="password" name="currentPassword" required autocomplete="current-password"></label>
    <label class="field">${t('New password')}<input class="input" type="password" name="newPassword" required minlength="12" maxlength="128" autocomplete="new-password"></label><label class="field">${t('Confirm new password')}<input class="input" type="password" name="confirmPassword" required minlength="12" maxlength="128" autocomplete="new-password"></label>
    <p class="hint">${t('At least 12 characters.')}</p><p class="error" id="password-error"></p><button class="btn btn-primary" type="submit">${t('Change password')}</button></form>`);
  $('#password').addEventListener('submit',async e=>{e.preventDefault();const form=e.target as HTMLFormElement,f=new FormData(form);$('#password-error').textContent='';try{if(f.get('newPassword')!==f.get('confirmPassword'))throw Error(t('New passwords do not match.'));await post('/account/password',{currentPassword:f.get('currentPassword'),newPassword:f.get('newPassword')});closeModal();toast(t('Password changed.'))}catch(err){$('#password-error').textContent=(err as Error).message}});
}
