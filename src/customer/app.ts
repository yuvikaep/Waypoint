import {$,$$,api,post,clock,closeModal,coords,esc,hm,i,icons,localInput,mapsLink,modal,on,since,statusLabel,statusOf,time,ago,toast,whenUnauthorized,type Alert,type Fence,type Fix,type Identity,type StatusKey,type Vehicle} from '../shared/core';
import {bearing,createMap,drawRoute,fleetIcon,glide,markerHtml,playbackIcon,point,L} from '../shared/map';
import {place,placeSpan,placeText,places,placeKey,placeFallback} from '../shared/places';
import {nearest,nearText,nearSaved,placeIcon,PLACE_KIND} from '../shared/poi';
import {googleModal} from '../shared/google';
import {googleLive} from '../shared/gview';
import {t,getLang,setLang,locale,LANGS,type Lang} from '../shared/i18n';
import {DEMO_MODE,workspaceStorage} from '../demo';
import {showLogin} from '../auth';
import {CATEGORIES,alertText,alertWords,announceNew,browserState,categoryOf,enablePush,disablePush,pushActive,syncPush,pushSupported,isIOS,isInstalled,mergeNotify,primeSeen,speakAlert,unlockVoice,voiceSupported,type Category,type NotifyPrefs} from './notify';
import './customer.css';

// Layout follows the familiar Indian fleet-app pattern: a vehicle list home with a diesel strip,
// a bottom bar (Map, Reports, Home, Notifications, Menu), a side drawer, a full-map vehicle page
// with a features sheet, report cards and a route-history timeline.
type View='buy'|'home'|'map'|'vehicle'|'history'|'reports'|'report'|'alerts'|'geofences'|'documents'|'ebills'|'settings'|'more';
type Fleet={devices:Vehicle[];fences:Fence[];alerts:Alert[]};
type Gap={from:number;to:number;minutes:number;movedKm:number|null};
type DayReport={date:string;distanceKm:number;runningMinutes:number;idleMinutes:number;ignitionMinutes:number;maxSpeed:number;avgSpeed:number;firstMove:number|null;lastMove:number|null;gaps:Gap[]};
type VehicleReport={id:string;name:string;total:{distanceKm:number;runningMinutes:number;idleMinutes:number;maxSpeed:number;avgSpeed:number;gapMinutes:number};days:DayReport[]};
type Prefs={name:string;workspace:string;follow:boolean;defaultView:View;notify?:Partial<NotifyPrefs>};
const APP_VERSION='4.0';

// Distance is only what the tracker reported. When it went silent, say so instead of guessing.
const gapNote=(g:Gap)=>`${t('Tracker sent no data {a} – {b} ({d})',{a:clock(g.from),b:clock(g.to),d:hm(g.minutes)})}${g.movedKm?` · ${t('moved {n} km in this time',{n:g.movedKm})}`:''} · ${t('km in this period is not recorded')}`;
const TITLES:Record<View,string>={buy:'Buy GPS',home:'Vehicles',map:'Live map',vehicle:'Vehicle',history:'Route history',reports:'Reports',report:'Report',alerts:'Notifications',geofences:'Saved locations',documents:'Vehicle documents',ebills:'E-way bills',settings:'Settings',more:'Menu'};
const TABS:[View|'menu',string,string][]=[['map','Map','map'],['reports','Reports','chart-column'],['home','Home','navigation'],['alerts','Notification','bell'],['menu','Menu','menu']];
const SIDE:[string,[View,string,string][]][]=[
  ['Fleet',[['home','Vehicles','truck'],['map','Live map','map'],['history','Route history','route']]],
  ['Alerts & reports',[['alerts','Notifications','bell'],['reports','Reports','chart-column']]],
  ['Manage',[['geofences','Saved locations','map-pin'],['documents','Vehicle documents','files'],['ebills','E-way bills','file-text']]],
  ['Services',[['buy','Buy GPS','shopping-cart']]],
  ['Account',[['settings','Settings','settings']]],
];
const DRAWER:[View,string,string][]=[['buy','Buy GPS','shopping-cart'],['history','Route history','route'],['geofences','Saved locations','map-pin'],['documents','Vehicle documents','files'],['ebills','E-way bills','file-text'],['settings','Settings','settings']];
const ROOT:View[]=['home','map','reports','alerts'];
const PAGES:View[]=['buy','home','map','vehicle','history','reports','report','alerts','geofences','documents','ebills','settings','more'];
type ReportKind='distance'|'stoppage'|'overspeed'|'itinerary'|'geofence';
const REPORTS:[ReportKind,string,string,string][]=[
  ['distance','Distance','gauge','Kilometres driven, running and idle time for each day'],
  ['stoppage','Stoppage','truck','Summary of all the stoppages made by your vehicles in a given time duration'],
  ['overspeed','Overspeeding','zap','Every time a vehicle went above its speed limit, with the top speed'],
  ['itinerary','Complete itinerary','route','Every run and stop of a vehicle, one after another'],
  ['geofence','Geofence (Entry/Exit)','map-pin','When vehicles entered or left your saved locations'],
];

let me:Identity,fleet:Fleet={devices:[],fences:[],alerts:[]},view:View='home',vehicleId='',filter:'all'|'running'|'stopped'|'offline'='all',search='',following=true,reportKind:ReportKind='distance',playOnOpen=false;
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
const dayStart=(offset=0)=>{const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()+offset);return d};
// "Today, 03:45 PM" / "Yesterday, 11:02 AM" / "14 Oct, 09:30 AM"
function when(at:number|null){
  if(!at)return t('Never');
  const d=new Date(at),day=new Date(at);day.setHours(0,0,0,0);
  const diff=Math.round((+dayStart()-+day)/86400000);
  return `${diff===0?t('Today'):diff===1?t('Yesterday'):d.toLocaleDateString(locale(),{day:'numeric',month:'short'})}, ${clock(at)}`;
}

/* ---------- Start, routing, refresh ---------- */
export async function startCustomer(identity:Identity){
  me=identity;following=prefs().follow;
  whenUnauthorized(()=>{stop();showLogin(t('Your session ended. Please sign in again.'))});
  try{fleet=await api<Fleet>('/state')}catch(e){$('#app').innerHTML=`<div class="cx-empty">${i('wifi-off')}<h3>${t('Could not load your fleet')}</h3><p>${esc((e as Error).message)}</p><button class="cx-btn primary" id="retry">${t('Retry')}</button></div>`;on('#retry',()=>location.reload());icons();return}
  readUrl();void loadFuel();setInterval(()=>void loadFuel(),10*60000);void loadFleetKm();
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
  if(view==='report'){const k=q.get('id') as ReportKind;if(REPORTS.some(([r])=>r===k))reportKind=k;else view='reports'}
  if(view==='history'&&vehicleId)historyVehicle=vehicleId;
}
function go(next:View,id=''){
  const url=new URL(location.href);url.search='';
  if(DEMO_MODE)url.searchParams.set('demo','');
  url.searchParams.set('view',next);if(id)url.searchParams.set('id',id);
  history.pushState({cx:true},'',url);view=next;vehicleId=next==='vehicle'?id:vehicleId;if(next==='report')reportKind=id as ReportKind;render();window.scrollTo({top:0});
}
const openVehicle=(id:string)=>go('vehicle',id);
function back(){if(history.state?.cx)history.back();else go('home')}
function stop(){clearTimeout(poll);teardown?.();teardown=undefined;onRefresh=undefined}
// Short polls keep the map, alerts and voice close to real time (the gateway pushes within ~1 s).
function schedule(){clearTimeout(poll);poll=setTimeout(refresh,document.hidden?5000:2000)}
async function refresh(){
  try{fleet=await api<Fleet>('/state');remember(fleet.devices);announceNew(fleet.alerts,notifyPrefs());updateBadges();void loadFleetKm();onRefresh?.()}
  catch{/* keep showing the last data; the next poll retries */}
  finally{schedule()}
}
function updateBadges(){const n=openAlerts();$$('[data-alert-badge]').forEach(b=>{b.textContent=n>99?'99+':String(n);b.hidden=!n})}
async function logout(){if(!DEMO_MODE)await api('/session',{method:'DELETE'}).catch(()=>{});location.href='/?live=1&auth=customer'}

function render(){
  stop();
  const p=prefs(),badge=openAlerts(),active=view==='vehicle'?'home':view==='report'?'reports':view;
  const badgeHtml=`<span class="cx-badge" data-alert-badge ${badge?'':'hidden'}>${badge}</span>`;
  $('#app').innerHTML=`<div class="cx we" data-view="${view}">
    <aside class="cx-side">
      <a class="cx-brand" href="/?live=1"><span class="cx-mark">${i('navigation')}</span><span><b>Waypoint</b><small>${t('Live fleet')}</small></span></a>
      <nav>${SIDE.map(([g,items])=>`<div class="cx-side-group"><span>${t(g)}</span>${items.map(([v,l,ic])=>`<button data-go="${v}" class="${active===v?'on':''}">${i(ic)}<em>${t(l)}</em>${v==='alerts'?badgeHtml:''}</button>`).join('')}</div>`).join('')}</nav>
      <button class="cx-me" data-go="settings"><span class="cx-avatar">${initial(p.workspace)}</span><span><b>${esc(p.workspace)}</b><small>${esc(me.email||p.name)}</small></span>${i('chevron-right')}</button>
    </aside>
    <main class="cx-main">${['buy','geofences','documents','ebills','settings'].includes(view)?topBar(t(TITLES[view])):''}<div id="view"></div></main>
    <nav class="we-tabs">${TABS.map(([v,l,ic])=>`<button ${v==='menu'?'data-drawer':`data-go="${v}"`} class="${active===v?'on':''} ${v==='home'?'home':''}"><span class="we-tab-ico">${i(ic)}${v==='alerts'?badgeHtml:''}</span>${t(l)}</button>`).join('')}</nav>
    <div class="we-drawer" id="drawer" hidden><div class="we-drawer-panel">
      <div class="we-drawer-head"><span class="cx-avatar lg">${initial(p.workspace)}</span><div><b>${esc(p.name||p.workspace)}</b><small>${esc(me.email||'')}</small><small>${t('App version: {v}',{v:APP_VERSION})}</small></div></div>
      ${DRAWER.map(([v,l,ic])=>`<button class="we-drawer-item" data-go="${v}">${i(ic)}<span>${t(l)}</span>${v==='buy'?`<em class="we-new">${t('New')}</em>`:''}</button>`).join('')}
      <button class="we-drawer-item" data-lang-menu>${i('languages')}<span>${t('Language')}</span><em>${LANGS.find(([k])=>k===getLang())![1]}</em></button>
      <button class="we-drawer-item danger" data-logout>${i('log-out')}<span>${t('Sign out')}</span></button>
    </div></div>
  </div>`;
  on('[data-go]',el=>{closeDrawer();go(el.dataset.go as View)});
  on('[data-back]',back);
  on('[data-drawer]',()=>{$('#drawer').hidden=false});
  $('#drawer').addEventListener('click',e=>{if(e.target===$('#drawer'))closeDrawer()});
  on('[data-lang-menu]',()=>{closeDrawer();languageMenu()});
  on('[data-logout]',logout);
  ({buy:renderBuy,home:renderHome,map:renderMap,vehicle:renderVehicle,history:renderHistory,reports:renderReports,report:renderReport,alerts:renderAlerts,geofences:renderGeofences,documents:()=>renderDocuments('Documents'),ebills:()=>renderDocuments('E-way bills'),settings:renderSettings,more:renderHome} as Record<View,()=>void>)[view]();
  icons();
}
const closeDrawer=()=>{const d=document.querySelector<HTMLElement>('#drawer');if(d)d.hidden=true};
function languageMenu(){
  modal(t('Language'),`<div class="we-lang">${LANGS.map(([k,l,s])=>`<button data-pick-lang="${k}" class="${getLang()===k?'on':''}"><b>${l}</b><small>${s}</small></button>`).join('')}</div>`);
  on('[data-pick-lang]',el=>{setLang(el.dataset.pickLang as Lang);closeModal();render();toast(t('Language changed.'))},document.querySelector('dialog.modal')!);
}
// Sub-page header: back arrow, title and an optional action on the right.
const topBar=(title:string,right='')=>`<header class="we-top"><button class="we-back" data-back aria-label="${t('Back')}">${i('arrow-left')}</button><h1>${title}</h1>${right}</header>`;

// Recent path of each vehicle while the app is open, drawn behind the truck on its page.
const trails=new globalThis.Map<string,{latitude:number;longitude:number;at:number}[]>();
function remember(devices:Vehicle[]){
  const cutoff=Date.now()-60*60000;
  for(const d of devices){const p=d.position;if(!p||p.valid===0)continue;const tr=trails.get(d.id)||[];if(!tr.length||tr.at(-1)!.at!==p.recordedAt)tr.push({latitude:p.latitude,longitude:p.longitude,at:p.recordedAt});while(tr.length&&(tr[0].at<cutoff||tr.length>400))tr.shift();trails.set(d.id,tr)}
}
let googleView=false;
try{googleView=localStorage.getItem('waypoint.googleView')==='1'}catch{/* private mode */}
function setGoogle(on:boolean){googleView=on;try{localStorage.setItem('waypoint.googleView',on?'1':'0')}catch{/* private mode */}}
// A single vehicle opens in Google view unless the owner switched it off; the fleet map keeps its own choice.
let vehicleGoogle=true;
try{vehicleGoogle=localStorage.getItem('waypoint.vehicleGoogle')!=='0'}catch{/* private mode */}
function setVehicleGoogle(on:boolean){vehicleGoogle=on;try{localStorage.setItem('waypoint.vehicleGoogle',on?'1':'0')}catch{/* private mode */}}

// Today's km for every vehicle in one request, refreshed at most once a minute.
const kmToday=new globalThis.Map<string,number>();let kmAt=0;
async function loadFleetKm(){
  if(Date.now()-kmAt<60000)return;kmAt=Date.now();
  try{const r=await reports(dayStart(),new Date());for(const v of r.vehicles)kmToday.set(v.id,v.total.distanceKm);if(view==='home'||view==='vehicle')onRefresh?.()}catch{/* shown as — */}
}
function reports(from:Date,to:Date,device?:string){
  return api<{vehicles:VehicleReport[]}>(`/reports?${new URLSearchParams({from:from.toISOString(),to:to.toISOString(),tz:String(new Date().getTimezoneOffset()),...(device?{device}:{})})}`);
}

/* ---------- Diesel prices ---------- */
type Fuel={date:number|null;states:{state:string;price:number;change:number;dir:number}[];source:string;fetchedAt:number;stale?:boolean};
let fuel:Fuel|null=null;
async function loadFuel(){try{fuel=await api<Fuel>('/fuel');const el=document.querySelector('#diesel');if(el){el.outerHTML=dieselStrip();bindDiesel();icons()}}catch{/* the strip stays hidden */}}
function fleetStates(){
  const names=new Set<string>();
  for(const d of fleet.devices){const label=d.position?places.get(placeKey(d.position))?.label:'';if(!label||!fuel)continue;for(const s of fuel.states)if(label.includes(s.state))names.add(s.state)}
  return names;
}
const sortedFuel=()=>{const mine=fleetStates();return [...(fuel?.states||[])].sort((a,b)=>Number(mine.has(b.state))-Number(mine.has(a.state))||a.state.localeCompare(b.state))};
const fuelDay=(f:Fuel)=>f.date?new Date(f.date).toLocaleDateString(locale(),{day:'numeric',month:'short',timeZone:'UTC'}):'';
// The strip under the home header: today's diesel price, the fleet's states first.
function dieselStrip(){
  if(!fuel?.states.length)return '<div id="diesel" hidden></div>';
  return `<div class="we-diesel" id="diesel"><span class="we-diesel-ico">⛽</span><div class="we-diesel-row"><div class="we-diesel-run" style="animation-duration:${Math.max(20,fuel.states.length*3)}s">${(()=>{const chips=sortedFuel().map(s=>`<span class="we-dchip"><em>${esc(s.state)}</em><b>₹${s.price.toFixed(2)}</b>${s.dir?`<i class="${s.dir>0?'up':'down'}">${s.dir>0?'▲':'▼'}</i>`:''}</span>`).join('');return chips+`<span class="we-diesel-copy" aria-hidden="true">${chips}</span>`})()}</div></div><button class="we-diesel-all" data-diesel>${t('View all')}${i('chevron-right')}</button></div>`;
}
function bindDiesel(){on('[data-diesel]',showFuel)}
function showFuel(){
  if(!fuel)return;
  const mine=fleetStates();
  modal(`⛽ ${t('Diesel price today')}${fuel.date?` · ${fuelDay(fuel)}`:''}`,`<p class="hint">${t('Per litre, by state. Prices change at 6 am every day.')} ${t('Source: {s}',{s:fuel.source})}${fuel.stale?` · ${t('could not refresh, showing the last figures')}`:''}</p>
    <div class="cx-fuel-list">${sortedFuel().map(s=>`<div class="${mine.has(s.state)?'mine':''}"><span>${esc(s.state)}${mine.has(s.state)?` <small>${t('your vehicles')}</small>`:''}</span><b>₹${s.price.toFixed(2)}</b><i class="${s.dir>0?'up':s.dir<0?'down':''}">${s.dir?`${s.dir>0?'▲':'▼'} ${s.change.toFixed(2)}`:'—'}</i></div>`).join('')}</div>`);
}

/* ---------- Home: vehicle list ---------- */
const squash=(s:string)=>s.toLowerCase().replace(/[^a-z0-9ऀ-ॿ]/g,'');
const Speech=(window as unknown as {SpeechRecognition?:new()=>any;webkitSpeechRecognition?:new()=>any}).SpeechRecognition||(window as unknown as {webkitSpeechRecognition?:new()=>any}).webkitSpeechRecognition;
let searchOpen=false;
function renderHome(){
  const host=$('#view'),p=prefs();
  host.innerHTML=`<div class="we-home">
    <header class="we-header"><button class="we-icon" data-drawer aria-label="${t('Menu')}">${i('menu')}</button><a class="we-logo" href="/?live=1"><span class="cx-mark">${i('navigation')}</span><b>Waypoint</b></a>
      <span class="we-grow"></span><button class="we-round" id="search-toggle" aria-label="${t('Search')}">${i('search')}</button><button class="we-round" id="lang" aria-label="${t('Language')}">A/अ</button></header>
    <div class="we-search" id="searchbox" ${searchOpen||search?'':'hidden'}>${i('search')}<input id="q" placeholder="${t('Search vehicle number')}" value="${esc(search)}" autocomplete="off">${Speech?`<button type="button" id="mic" aria-label="${t('Search by voice')}">${i('mic')}</button>`:''}</div>
    ${dieselStrip()}
    <div class="we-filters" id="filters"></div>
    <div class="we-list" id="list"></div>
    <button class="we-mapfab" data-go="map" aria-label="${t('Live map')}">${i('map')}</button>
  </div>`;
  void p;
  on('[data-drawer]',()=>{$('#drawer').hidden=false},host);
  on('[data-go]',el=>go(el.dataset.go as View),host);
  on('#lang',languageMenu);bindDiesel();
  on('#search-toggle',()=>{searchOpen=!searchOpen;$('#searchbox').hidden=!searchOpen&&!search;if(searchOpen)$<HTMLInputElement>('#q').focus()});
  const input=$<HTMLInputElement>('#q');input.oninput=()=>{search=input.value;draw()};
  on('#mic',btn=>{
    const r=new Speech!();r.lang='en-IN';r.interimResults=false;btn.classList.add('on');
    r.onresult=(e:any)=>{search=String(e.results[0][0].transcript||'');input.value=search;draw()};
    r.onerror=()=>toast(t('Could not hear that. Try again.'),true);r.onend=()=>btn.classList.remove('on');r.start();
  });
  const order=['running','stopped','offline'];
  const draw=()=>{
    const n={all:fleet.devices.length,running:0,stopped:0,offline:0};for(const d of fleet.devices)n[group(statusOf(d))]++;
    $('#filters').innerHTML=(['all','running','stopped','offline'] as const).filter(k=>k==='all'||n[k]).map(k=>`<button data-filter="${k}" class="${filter===k?'on':''}">${t(k==='all'?'All':k==='running'?'Running':k==='stopped'?'Stopped':'Offline')} (${n[k]})</button>`).join('');
    on('[data-filter]',el=>{filter=el.dataset.filter as typeof filter;draw()},$('#filters'));
    const q=squash(search);
    const list=fleet.devices.filter(d=>(filter==='all'||group(statusOf(d))===filter)&&squash(`${d.name} ${d.driver}`).includes(q))
      .sort((a,b)=>Number(overspeeding(b))-Number(overspeeding(a))||order.indexOf(group(statusOf(a)))-order.indexOf(group(statusOf(b)))||a.name.localeCompare(b.name));
    $('#list').innerHTML=list.length?list.map(vehicleCard).join(''):`<div class="cx-empty">${i('truck')}<h3>${t(fleet.devices.length?'No vehicles match':'No vehicles yet')}</h3><p>${t(fleet.devices.length?'Try another filter.':'Your fleet administrator will add your GPS devices here.')}</p></div>`;
    bindCards($('#list'));icons();
  };
  draw();onRefresh=draw;
}
// The vehicle card: speed box, plate and time, ignition, address with save, today's km, actions.
function vehicleCard(d:Vehicle){
  const p=d.position,s=statusOf(d),over=overspeeding(d),speed=p&&d.fresh&&s==='running'?Math.round(p.speed):0;
  const km=kmToday.get(d.id),standing=(s==='stopped'||s==='idle')&&d.stoppedSince;
  const mine=p?nearSaved(p.latitude,p.longitude,fleet.fences):null;
  const line=[km==null?'':t('{n} km today',{n:km}),standing?t('Stopped since {d}',{d:since(d.stoppedSince!)}):s==='offline'?t('No signal since {t}',{t:when(d.lastSeen)}):''].filter(Boolean).join(' | ');
  return `<article class="we-card ${over?'over':''}">
    <button class="we-card-top" data-open="${d.id}">
      <span class="we-speed ${over?'sos':speed?'run':'zero'}"><b>${speed}</b><small>kmph</small></span>
      <span class="we-id"><b class="cx-plate">${esc(d.name)}</b><small class="we-upd"><em>${t(p?'Location updated':'Last signal')}</em>${when(p?.recordedAt??d.lastSeen)}</small></span>
      <span class="we-ign ${d.ignition?'on':''}"><b>${d.ignition==null?'—':d.ignition?'ON':'OFF'}</b><small>${t('Ignition')}</small></span>
    </button>
    <button class="we-kebab" data-menu="${d.id}" aria-label="${t('More options')}">${i('ellipsis-vertical')}</button>
    <div class="we-addr"><p>${mine?`<button class="we-mine" data-efence="${mineFence(p!)?.id}">${esc(mine)} ${i('pencil')}</button><br>`:''}${placeSpan(p,d.id)}</p>${p?`<button class="we-link" data-save="${d.id}">${t('Save location')}</button>`:''}</div>
    ${line?`<p class="we-line">${esc(line)}</p>`:''}
    ${!d.isMobile&&p&&d.online&&Date.now()-p.recordedAt>10*60000?`<p class="we-stale">${i('satellite')} ${t('Last GPS fix {t}. The tracker has no satellite signal, so this place may be a little off.',{t:ago(p.recordedAt)})}</p>`:''}
    <div class="we-acts">
      ${d.driverPhone?`<a href="tel:${esc(d.driverPhone)}"><span class="we-act-ico">${i('phone')}</span>${t('Call driver')}</a>`:`<button data-phone="${d.id}"><span class="we-act-ico">${i('phone')}</span>${t('Call driver')}</button>`}
      <button data-signal="${d.id}"><span class="we-act-ico">${bars(d.signal)}</span>${signalLabel(d)}</button>
      <button data-share="${d.id}"><span class="we-act-ico wa">${i('share-2')}</span>${t('Share')}</button>
      <button data-park="${d.id}" class="${d.parkLock?d.parkAlerted?'park alarm':'park on':''}"><span class="we-act-ico">${i(d.parkLock?'lock':'lock-open')}</span>${t(d.parkLock?'Locked':'Parking lock')}</button>
    </div>
  </article>`;
}
function bindCards(root:HTMLElement){
  on('[data-open]',el=>openVehicle(el.dataset.open!),root);
  on('[data-phone]',el=>driverPhone(vehicle(el.dataset.phone!)!),root);
  on('[data-signal]',el=>signalInfo(vehicle(el.dataset.signal!)!),root);
  on('[data-share]',el=>shareVehicle(vehicle(el.dataset.share!)!),root);
  on('[data-park]',el=>parkLock(vehicle(el.dataset.park!)!),root);
  on('[data-efence]',el=>editFence(el.dataset.efence!),root);
  on('[data-save]',el=>{const p=vehicle(el.dataset.save!)?.position;if(p)addFence({latitude:p.latitude,longitude:p.longitude,radius:150})},root);
  on('[data-menu]',el=>vehicleMenu(vehicle(el.dataset.menu!)!),root);
}
// Mobile network of the tracker's SIM as 4 bars; an offline tracker has none.
function bars(n?:number|null){return `<span class="we-bars ${n==null?'none':n<=1?'weak':''}">${[1,2,3,4].map(b=>`<i class="${n!=null&&b<=n?'on':''}"></i>`).join('')}</span>`}
function signalLabel(d:Vehicle){return d.signal==null?t('Network'):d.signal===0?t('No network'):`${t('Network')} ${d.signal}/4`}
function signalInfo(d:Vehicle){
  const n=d.signal,word=n==null?t('This tracker does not report its network.'):n===0?t('No network right now. The tracker sends the saved data once it is back in range.'):n<=1?t('Weak network. Updates may come late.'):n===2?t('Average network.'):t('Good network.');
  modal(`${d.name} · ${t('Network')}`,`<div class="we-signal">${bars(n)}<b>${n==null?'—':`${n}/4`}</b></div><p class="hint">${word}</p><p class="hint">${t('Last signal: {t}',{t:when(d.lastSeen)})}</p>`);
}
// The driver's number lives with the vehicle so "Call driver" is one tap.
function driverPhone(d:Vehicle,done?:()=>void){
  modal(`${d.name} · ${t('Driver number')}`,`<form class="form" id="dphone"><label class="field">${t('Driver mobile number')}<input class="input" name="phone" type="tel" inputmode="tel" maxlength="16" placeholder="98765 43210" value="${esc(d.driverPhone||'')}"></label><p class="error"></p><button class="btn btn-primary" type="submit">${t('Save')}</button></form>`);
  const form=$<HTMLFormElement>('#dphone');
  form.onsubmit=async e=>{e.preventDefault();const err=form.querySelector('.error')!;err.textContent='';
    try{const r=await post<Vehicle>(`/devices/${d.id}/driver-phone`,{phone:String(new FormData(form).get('phone')||'').trim()},'PUT');d.driverPhone=r.driverPhone;closeModal();toast(r.driverPhone?t('Driver number saved.'):t('Driver number removed.'));done?.();onRefresh?.()}
    catch(x){err.textContent=t((x as Error).message)}};
}
// Switches phone push on after a tap and explains what to do when the phone cannot.
async function turnOnPush(){
  try{
    const r=await enablePush(notifyPrefs());
    if(r==='ok'){toast(t('Phone notifications on.'));return true}
    toast(r==='install'?t('iPhone: tap Share, then "Add to Home Screen", open Waypoint from there and switch this on.'):r==='denied'?t('Notifications are blocked. Allow them for this site in the phone settings.'):t('This browser cannot show notifications.'),true);
  }catch(x){toast(t((x as Error).message),true)}
  return false;
}
// After a lock, make sure the alert can reach the phone with the app closed.
async function offerPush(){
  if(await pushActive())return;
  modal(t('Get the alert with the app closed'),`<p class="hint">${t('Right now alerts only show while Waypoint is open on screen. Switch on phone notifications so a lock alert reaches you even when the phone is locked.')}</p>${isIOS()&&!isInstalled()?`<p class="cx-note">${t('iPhone: tap Share, then "Add to Home Screen", open Waypoint from there and switch this on.')}</p>`:''}<button class="btn btn-primary" id="push-on">${i('bell-ring')} ${t('Switch on phone notifications')}</button>`);
  on('#push-on',async()=>{if(await turnOnPush())closeModal()});icons();
}
// Parking lock: alert (pop-up, voice twice, notification) if a parked vehicle starts or moves.
function parkLock(d:Vehicle,done?:()=>void){
  const set=async(on:boolean)=>{
    try{const r=await post<Vehicle>(`/devices/${d.id}/park`,{on},'PUT');Object.assign(d,{parkLock:r.parkLock,parkAlerted:r.parkAlerted});unlockVoice();closeModal();toast(on?t('Parking lock on for {n}.',{n:d.name}):t('Parking lock off for {n}.',{n:d.name}));done?.();onRefresh?.();if(on)void offerPush()}
    catch(x){toast(t((x as Error).message),true)}};
  if(d.parkLock){modal(`${d.name} · ${t('Parking lock')}`,`${d.parkAlerted?`<p class="cx-note sos">${t('This vehicle started or moved while it was locked. Check the alerts.')}</p>`:''}<p class="hint">${t('The vehicle is locked. Unlock it before the driver starts the trip.')}</p><button class="btn btn-primary" id="punlock">${i('lock-open')} ${t('Unlock')}</button>`);on('#punlock',()=>void set(false));icons();return}
  modal(`${d.name} · ${t('Parking lock')}`,`<p class="hint">${t('Lock a parked vehicle. If the engine starts or the vehicle moves more than 100 m, you get a loud alert at once.')}</p><p class="hint">${t('This only alerts you. It does not switch the engine off.')}</p><button class="btn btn-primary" id="plock">${i('lock')} ${t('Lock vehicle')}</button>`);on('#plock',()=>void set(true));icons();
}
// Engine lock through the relay fitted in the vehicle. The server only sends a lock to a parked
// vehicle with the engine off; unlock goes any time. Each command needs the plate and the password.
type RelayView={available:boolean;wiring:'starter'|'fuel'|null;locked:boolean|null;last:{action:string;createdAt:number}|null;history:{action:string;status:string;createdAt:number;detail:string}[]};
async function engineLock(d:Vehicle){
  let r:RelayView;try{r=await api<RelayView>(`/devices/${d.id}/relay`)}catch(x){toast(t((x as Error).message),true);return}
  const title=`${d.name} · ${t('Engine lock')}`;
  if(!r.available){
    modal(title,`<div class="cx-empty">${i('power')}<h3>${t('No relay in this vehicle yet')}</h3><p>${t('A relay has to be fitted in the vehicle and tested by our team first. Ask us to fit one.')}</p></div><button class="btn btn-primary" id="rbuy">${t('Ask for a relay')}</button>`);
    on('#rbuy',()=>{closeModal();go('buy')});icons();return;
  }
  const state=r.locked==null?t('Not used yet'):r.locked?t('Locked'):t('Unlocked');
  const words=(a:string)=>t(a==='inhibit'?'Lock':'Unlock'),stat=(s:string)=>t(s==='sent-unverified'?'Sent':s==='blocked'?'Not sent':s==='unknown'?'Not sure if delivered':s);
  modal(title,`<div class="we-relay ${r.locked?'on':''}">${i(r.locked?'lock':'lock-open')}<div><b>${state}</b>${r.last?`<small>${t('Last command: {a}, {t}',{a:words(r.last.action),t:when(r.last.createdAt)})}</small>`:''}</div></div>
    <p class="hint">${t(r.wiring==='fuel'?'Lock cuts the fuel / ignition, so the engine cannot run. It is sent only when the vehicle is parked with the engine off.':'Lock stops the engine from starting. It is sent only when the vehicle is parked with the engine off.')}</p>
    <p class="hint">${t('The tracker does not confirm the relay. Ask the driver to check once after a lock or unlock.')}</p>
    <form class="form" id="rform"><label class="field">${t('Type the vehicle number to confirm')}<input class="input" name="confirmation" required autocomplete="off" placeholder="${esc(d.name)}"></label>
      <label class="field">${t('Your password')}<input class="input" name="adminKey" type="password" required autocomplete="current-password"></label>
      <p class="error"></p>
      <div class="we-relay-btns"><button class="btn btn-danger" type="submit" value="inhibit">${i('lock')} ${t('Lock engine')}</button><button class="btn btn-primary" type="submit" value="restore">${i('lock-open')} ${t('Unlock engine')}</button></div></form>
    ${r.history.length?`<h3 class="we-h">${t('Recent commands')}</h3><div class="cx-group">${r.history.map(c=>`<div class="cx-item static"><span class="cx-item-text"><b>${words(c.action)} · ${stat(c.status)}</b><small>${when(c.createdAt)}${c.detail?` · ${esc(t(c.detail))}`:''}</small></span></div>`).join('')}</div>`:''}`);
  icons();
  const form=$<HTMLFormElement>('#rform'),requestId=crypto.randomUUID();
  form.onsubmit=async e=>{
    e.preventDefault();const action=((e as SubmitEvent).submitter as HTMLButtonElement)?.value||'inhibit',f=new FormData(form),err=form.querySelector('.error')!;err.textContent='';
    form.querySelectorAll('button').forEach(b=>b.disabled=true);
    try{
      const res=await post<{status:string;detail:string}>(`/devices/${d.id}/relay`,{action,confirmation:f.get('confirmation'),adminKey:f.get('adminKey'),reason:action==='inhibit'?'Locked by owner from the app':'Unlocked by owner from the app',requestId:`${requestId}:${action}`});
      if(res.status==='sent-unverified'){closeModal();toast(action==='inhibit'?t('Lock command sent to {n}.',{n:d.name}):t('Unlock command sent to {n}.',{n:d.name}))}
      else err.textContent=res.status==='unknown'?t('Not sure if the command reached the tracker. Check the vehicle before trying again.'):t(res.detail);
    }catch(x){err.textContent=t((x as Error).message)}
    finally{form.querySelector<HTMLInputElement>('[name=adminKey]')!.value='';form.querySelectorAll('button').forEach(b=>b.disabled=false)}
  };
}
// WhatsApp first (most drivers and owners use it), the phone's share sheet otherwise.
function shareVehicle(d:Vehicle){
  const p=d.position;if(!p){toast(t('No location yet'),true);return}
  const text=`${d.name}: ${places.get(placeKey(p))?.label||coords(p)}\n${mapsLink(p)}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`,'_blank','noopener');
}
function vehicleMenu(d:Vehicle){
  modal(d.name,`<div class="cx-group">
    <button class="cx-item" data-m="open"><span class="cx-ico">${i('map')}</span><span class="cx-item-text"><b>${t('Open on map')}</b></span>${i('chevron-right')}</button>
    <button class="cx-item" data-m="speed"><span class="cx-ico">${i('gauge')}</span><span class="cx-item-text"><b>${t('Overspeed alert')}</b><small>${d.speedAlert===false?t('Off'):t('Speed limit: {n} km/h',{n:d.speedLimit})}</small></span>${i('chevron-right')}</button>
    ${d.isMobile?'':`<button class="cx-item" data-m="engine"><span class="cx-ico">${i('power')}</span><span class="cx-item-text"><b>${t('Engine lock')}</b><small>${t('Relay in the vehicle')}</small></span>${i('chevron-right')}</button>`}
    <button class="cx-item" data-m="phone"><span class="cx-ico">${i('phone')}</span><span class="cx-item-text"><b>${t('Driver number')}</b><small>${esc(d.driverPhone||t('Not added'))}</small></span>${i('chevron-right')}</button>
    ${d.isMobile?`<button class="cx-item" data-m="driver"><span class="cx-ico">${i('smartphone')}</span><span class="cx-item-text"><b>${t('Driver link')}</b></span>${i('chevron-right')}</button>`:''}
    ${d.position?`<a class="cx-item" href="${mapsLink(d.position)}" target="_blank" rel="noopener"><span class="cx-ico">${i('navigation')}</span><span class="cx-item-text"><b>${t('Navigate')}</b><small>${t('Open in Google Maps')}</small></span>${i('external-link')}</a>`:''}
  </div>`);
  const dlg=document.querySelector('dialog.modal')!;
  on('[data-m="open"]',()=>{closeModal();openVehicle(d.id)},dlg);
  on('[data-m="speed"]',()=>speedSettings(d,()=>onRefresh?.()),dlg);
  on('[data-m="driver"]',()=>driverLink(d),dlg);
  on('[data-m="phone"]',()=>driverPhone(d),dlg);
  on('[data-m="engine"]',()=>void engineLock(d),dlg);
}

/* ---------- Map ---------- */
function fleetMap(host:HTMLElement){
  host.innerHTML=`<div class="cx-map" data-fm-map></div><div class="gwrap" data-fm-google hidden></div>
    <span class="cx-float-pill" data-fm-count></span>
    <div class="cx-fabs"><button class="cx-fab ${googleView?'on':''}" data-fm="google" title="${t('Google view with nearby places')}" aria-label="${t('Google view with nearby places')}">${i('layers')}</button><button class="cx-fab" data-fm="fit" title="${t('Show all vehicles')}" aria-label="${t('Show all vehicles')}">${i('locate-fixed')}</button></div>
    <div class="cx-peek" data-fm-peek hidden></div>`;
  const el=host.querySelector<HTMLElement>('[data-fm-map]')!,gHost=host.querySelector<HTMLElement>('[data-fm-google]')!;
  const map=createMap(el),layer=L.layerGroup().addTo(map),saved=L.layerGroup().addTo(map);
  let picked='',fitted=false;
  const markers=new globalThis.Map<string,L.Marker>(),iconKeys=new globalThis.Map<string,string>();
  const fleetIconKey=(d:Vehicle,sel:boolean,labels:boolean)=>markerHtml(d,sel,labels);
  const gl=googleLive(gHost,{onSelect:id=>pick(id),covered:()=>host.querySelector<HTMLElement>('[data-fm-peek]:not([hidden])')?.offsetHeight||0});
  const resize=new ResizeObserver(()=>map.invalidateSize());resize.observe(el);
  const fit=()=>{const pts=fleet.devices.flatMap(d=>d.position?[point(d.position)]:[]);if(pts.length)map.fitBounds(pts,{padding:[70,70],maxZoom:15})};
  function pick(id:string){picked=id;update();const d=vehicle(id);if(d?.position&&!googleView)map.panTo(point(d.position))}
  function update(){
    const list=fleet.devices;
    host.querySelector('[data-fm-count]')!.innerHTML=`<i></i>${t('{n} live',{n:list.filter(d=>d.online).length})} · ${t('{n} vehicles',{n:list.length})}`;
    // Markers stay in place between refreshes and slide to the new point, so the fleet does not flicker.
    const live=new Set<string>();
    for(const d of list){
      if(!d.position)continue;live.add(d.id);
      const html=fleetIconKey(d,d.id===picked,d.id===picked||list.length<=3),z=d.id===picked?1000:overspeeding(d)?500:0;
      let m=markers.get(d.id);
      if(!m){m=L.marker(point(d.position),{icon:fleetIcon(d,d.id===picked,d.id===picked||list.length<=3),title:d.name,zIndexOffset:z}).addTo(layer).on('click',e=>{L.DomEvent.stopPropagation(e);pick(d.id)});markers.set(d.id,m);iconKeys.set(d.id,html);glide(m,point(d.position),d.position.recordedAt)}
      else{glide(m,point(d.position),d.position.recordedAt);m.setZIndexOffset(z);if(iconKeys.get(d.id)!==html){m.setIcon(fleetIcon(d,d.id===picked,d.id===picked||list.length<=3));iconKeys.set(d.id,html)}}
    }
    for(const [id,m] of markers)if(!live.has(id)){layer.removeLayer(m);markers.delete(id);iconKeys.delete(id)}
    saved.clearLayers();
    for(const f of fleet.fences)L.circle(point(f),{radius:f.radius,color:'#1463ff',weight:2,fillOpacity:.06}).bindTooltip(`${placeIcon(f.kind)} ${esc(f.name)}`,{permanent:true,direction:'center',className:'fence-label'}).addTo(saved);
    if(!fitted&&list.some(d=>d.position)){fitted=true;requestAnimationFrame(fit)}
    gHost.hidden=!googleView;el.style.visibility=googleView?'hidden':'';
    if(googleView)gl.update(list,picked,picked?trails.get(picked):[]);
    const pk=host.querySelector<HTMLElement>('[data-fm-peek]')!;const d=vehicle(picked);pk.hidden=!d;
    if(d){pk.innerHTML=vehicleCard(d);bindCards(pk);icons()}
  }
  map.on('click',()=>{if(picked){picked='';update()}});
  host.querySelectorAll<HTMLElement>('[data-fm]').forEach(b=>b.addEventListener('click',()=>{
    if(b.dataset.fm==='fit'){picked='';if(googleView){setGoogle(false);host.querySelector('[data-fm="google"]')!.classList.remove('on')}update();map.invalidateSize();fit();return}
    setGoogle(!googleView);b.classList.toggle('on',googleView);update();if(!googleView)map.invalidateSize();
  }));
  update();icons();
  return {update,destroy(){resize.disconnect();gl.destroy();map.remove()}};
}
function renderMap(){
  $('#view').innerHTML='<div class="cx-fullmap" id="fullmap"></div>';
  const fm=fleetMap($('#fullmap'));
  onRefresh=()=>fm.update();teardown=()=>fm.destroy();
}

/* ---------- Vehicle page ---------- */
const nearCache=new globalThis.Map<string,string>();
function renderVehicle(){
  const d0=vehicle(vehicleId);if(!d0){go('home');return}
  $('#view').innerHTML=`<div class="we-vpage">
    <section class="we-vmap"><div class="cx-map" id="vmap"></div><div class="gwrap" id="vgoogle" hidden></div>
      <div class="we-vcard" id="vcard"></div>
      <div class="cx-fabs we-vfabs"><button class="cx-fab ${vehicleGoogle?'on':''}" id="vgtoggle" title="${t('Google view with nearby places')}" aria-label="${t('Google view with nearby places')}">${i('layers')}</button><button class="cx-fab ${following?'on':''}" id="vfollow" title="${t('Follow selected vehicle')}" aria-label="${t('Follow selected vehicle')}">${i('locate-fixed')}</button></div>
      <div class="we-pills"><button id="vplay">${i('play')}${t('Play route')}</button><button id="vshare">${i('share-2')}${t('Share')}</button>${d0.position?`<a href="${mapsLink(d0.position)}" target="_blank" rel="noopener">${i('navigation')}${t('Navigate')}</a>`:''}</div>
    </section>
    <section class="we-sheet" id="vsheet"></section></div>`;
  const el=$('#vmap'),p0=d0.position;
  const map=createMap(el,p0?point(p0):[22.5,79],p0?15:5);
  const trailLine=L.polyline([],{color:'#1f2937',weight:5,opacity:.8}).addTo(map);
  let marker:L.Marker|undefined;
  const gl=googleLive($('#vgoogle'));
  const resize=new ResizeObserver(()=>map.invalidateSize());resize.observe(el);
  teardown=()=>{resize.disconnect();gl.destroy();map.remove()};
  on('#vplay',()=>{historyVehicle=vehicleId;playOnOpen=true;go('history',vehicleId)});
  on('#vshare',()=>shareVehicle(vehicle(vehicleId)!));
  on('#vgtoggle',b=>{setVehicleGoogle(!vehicleGoogle);b.classList.toggle('on',vehicleGoogle);drawMap();if(!vehicleGoogle)map.invalidateSize()});
  on('#vfollow',b=>{following=!following;b.classList.toggle('on',following);const p=vehicle(vehicleId)?.position;if(following&&p)map.panTo(point(p))});
  const drawMap=()=>{
    const d=vehicle(vehicleId);if(!d)return;
    const p=d.position,tr=trails.get(d.id)||[];
    trailLine.setLatLngs(tr.map(point));
    if(p){
      const {text}=placeText(p,d.id),speed=d.fresh&&statusOf(d)==='running'?Math.round(p.speed):0;
      const tip=`<span class="we-tip-speed ${speed?'run':''}">${speed}</span><span>${esc(text||placeFallback(p))}</span>`;
      if(!marker){marker=L.marker(point(p),{icon:fleetIcon(d,true,false),zIndexOffset:1000}).addTo(map);marker.bindTooltip(tip,{permanent:true,direction:'top',offset:[0,-24],className:'we-tip'})}
      else{glide(marker,point(p),p.recordedAt);marker.setIcon(fleetIcon(d,true,false));marker.setTooltipContent(tip)}
      if(following&&!map.getBounds().pad(-0.25).contains(point(p)))map.panTo(point(p));
    }
    $('#vgoogle').hidden=!vehicleGoogle;el.style.visibility=vehicleGoogle?'hidden':'';
    if(vehicleGoogle)gl.update([d],d.id,tr);
  };
  const drawCard=()=>{
    const d=vehicle(vehicleId);if(!d)return;
    const p=d.position,km=kmToday.get(d.id),s=statusOf(d);
    $('#vcard').innerHTML=`<button class="we-back" data-back aria-label="${t('Back')}">${i('arrow-left')}</button>
      <div class="we-vcard-main"><b class="cx-plate">${esc(d.name)}<i class="we-dot ${overspeeding(d)?'sos':group(s)}"></i></b><small>${t('Last updated on {t}',{t:when(p?.recordedAt??d.lastSeen)})}</small>
      <div class="we-vcard-line"><span>${km==null?'—':t('{n} km today',{n:km})}</span><span>${t('Ignition')}: <b class="${d.ignition?'on':'off'}">${d.ignition==null?'—':d.ignition?t('On'):t('Off')}</b></span></div></div>`;
    on('[data-back]',back,$('#vcard'));icons();
  };
  const drawSheet=()=>{
    const d=vehicle(vehicleId);if(!d)return;
    const p=d.position;
    const mine=p?nearSaved(p.latitude,p.longitude,fleet.fences):null;
    if(p&&!mine&&!nearCache.has(placeKey(p))){const key=placeKey(p);nearCache.set(key,'');void nearest(p.latitude,p.longitude).then(n=>{if(n){nearCache.set(key,nearText(n));if(vehicleId===d.id)drawSheet()}})}
    const near=mine||(p?nearCache.get(placeKey(p)):'');
    $('#vsheet').innerHTML=`<div class="cx-grab"></div>
      <div class="we-addr big"><p>${near?mine?`<button class="we-mine" data-efence="${mineFence(p!)?.id}">${esc(near)} ${i('pencil')}</button><br>`:`<b>${esc(near)}</b><br>`:''}${placeSpan(p,d.id)}</p>${p?`<button class="we-link" id="vsave">${t('Save location')}</button>`:''}</div>
      <h3 class="we-h">${t('Features')}</h3>
      <div class="we-feat2"><button id="vhistory"><span class="we-feat-ico">${i('route')}</span>${t('Route history')}</button><button id="vnearby"><span class="we-feat-ico">${i('search')}</span>${t('Find nearby')}</button></div>
      <div class="we-grid">
        <button id="vplaces"><span class="we-grid-ico g">${i('map-pin')}</span>${t('Saved locations')}</button>
        <button id="vreports"><span class="we-grid-ico y">${i('chart-column')}</span>${t('Reports')}</button>
        <button id="vshare2"><span class="we-grid-ico r">${i('share-2')}</span>${t('Share')}</button>
        <button id="vspeed"><span class="we-grid-ico b">${i('gauge')}</span>${t('Speed limit')}</button>
      </div>
      <div class="we-grid">
        <button id="vinfo"><span class="we-grid-ico r">${i('truck')}</span>${t('Information')}</button>
        <button data-go="documents"><span class="we-grid-ico y">${i('files')}</span>${t('Documents')}</button>
        ${d.isMobile?`<button id="vdriver"><span class="we-grid-ico b">${i('smartphone')}</span>${t('Driver link')}</button>`:`<button data-go="alerts"><span class="we-grid-ico b">${i('bell')}</span>${t('Alerts')}</button>`}
        <button id="vpark"><span class="we-grid-ico ${d.parkLock?'r':'g'}">${i(d.parkLock?'lock':'lock-open')}</span>${t(d.parkLock?'Locked':'Parking lock')}</button>
      </div>
      <div class="we-grid">
        ${d.isMobile?'':`<button id="vengine"><span class="we-grid-ico r">${i('power')}</span>${t('Engine lock')}</button>`}
      </div>`;
    const sh=$('#vsheet');
    on('[data-efence]',el=>editFence(el.dataset.efence!),sh);
    on('#vsave',()=>addFence({latitude:p!.latitude,longitude:p!.longitude,radius:150}),sh);
    on('#vhistory',()=>{historyVehicle=d.id;go('history',d.id)},sh);
    on('#vnearby',()=>{setVehicleGoogle(!vehicleGoogle);$('#vgtoggle').classList.toggle('on',vehicleGoogle);drawMap();window.scrollTo({top:0,behavior:'smooth'})},sh);
    on('#vplaces',()=>go('geofences'),sh);
    on('#vreports',()=>go('reports'),sh);
    on('#vshare2',()=>shareVehicle(d),sh);
    on('#vspeed',()=>speedSettings(d,drawSheet),sh);
    on('#vinfo',()=>vehicleInfo(d),sh);
    on('#vdriver',()=>driverLink(d),sh);
    on('#vpark',()=>parkLock(d,drawSheet),sh);
    on('#vengine',()=>void engineLock(d),sh);
    on('[data-go]',b=>go(b.dataset.go as View),sh);
    icons();
  };
  drawMap();drawCard();drawSheet();
  let lastPlace='';
  onRefresh=()=>{if(!vehicle(vehicleId)){go('home');return}drawMap();drawCard();const p=vehicle(vehicleId)!.position,k=p?placeKey(p):'';if(k!==lastPlace){lastPlace=k;drawSheet()}};
}
function vehicleInfo(d:Vehicle){
  const s=statusOf(d);
  modal(`${d.name} · ${t('Information')}`,`<dl class="facts"><dt>${t('Status')}</dt><dd>${statusLabel(s)}</dd><dt>${t('Driver')}</dt><dd>${esc(d.driver||'—')}</dd><dt>${t('Speed limit')}</dt><dd>${d.speedLimit} km/h${d.speedAlert===false?` (${t('alert off')})`:''}</dd><dt>${t('Last updated')}</dt><dd>${when(d.position?.recordedAt??d.lastSeen)}</dd>${d.stoppedSince?`<dt>${t('Standing since')}</dt><dd>${when(d.stoppedSince)}</dd>`:''}<dt>${t('Tracker')}</dt><dd>${d.isMobile?t('Driver phone'):'GPS'}</dd></dl>`);
}

/* ---------- Notifications ---------- */
let alertsCat:Category|'all'='all';
function renderAlerts(){
  const draw=()=>{
    const unseen=fleet.alerts.filter(a=>!a.acknowledged).length;
    const cats=CATEGORIES.filter(c=>fleet.alerts.some(a=>categoryOf(a.type)===c.key));
    const list=fleet.alerts.filter(a=>alertsCat==='all'||categoryOf(a.type)===alertsCat).sort((a,b)=>b.createdAt-a.createdAt);
    const days=new globalThis.Map<string,Alert[]>();for(const a of list){const k=new Date(a.createdAt).toLocaleDateString(locale(),{day:'numeric',month:'short',year:'numeric'});if(!days.has(k))days.set(k,[]);days.get(k)!.push(a)}
    const tone=(type:string)=>type==='sos'||type==='speed'||type==='offline'||type==='harsh_brake'||type==='parking_lock'?'sos':type==='ignition_on'||type==='online'||type==='share_resumed'?'good':'neutral';
    $('#view').innerHTML=`<div class="we-page">${topBar(t('Notifications'),`<button class="we-toplink" data-go="settings">${i('settings')}${t('Settings')}</button>`)}
      <div id="push-banner"></div>
      <div class="we-chips">${['all',...cats.map(c=>c.key)].map(k=>`<button data-cat="${k}" class="${alertsCat===k?'on':''}">${k==='all'?t('All'):esc(t(CATEGORIES.find(c=>c.key===k)!.label))}</button>`).join('')}${unseen?`<button class="we-chip-action" id="ack-all">${i('check-check')}${t('Mark all seen')}</button>`:''}</div>
      ${list.length?[...days].map(([day,items])=>`<h3 class="we-date">${esc(day)}</h3>${items.map(a=>{const c=CATEGORIES.find(x=>x.key===categoryOf(a.type))!,w=alertWords(a);return `<button class="we-note ${a.acknowledged?'':'new'}" data-alert="${a.id}"><span class="we-note-ico ${tone(a.type)}">${i(a.type==='ignition_on'||a.type==='ignition_off'?'power':c.icon)}</span><span class="we-note-body"><span class="we-note-head"><em>${esc(t(c.label))}</em><time>${clock(a.createdAt)}</time></span><b>${esc(w.title)}</b><span>${esc(a.deviceName)} · ${esc(alertText(a))}</span></span></button>`}).join('')}`).join(''):`<div class="cx-empty">${i('bell')}<h3>${t('All clear')}</h3><p>${t('SOS, engine, geofence, overspeed, hard braking and signal alerts appear here.')}</p></div>`}
    </div>`;
    on('[data-back]',back);on('[data-go]',el=>go(el.dataset.go as View),$('#view'));
    on('[data-cat]',el=>{alertsCat=el.dataset.cat as Category|'all';draw()});
    void pushActive().then(active=>{const b=document.querySelector<HTMLElement>('#push-banner');if(active||!b||DEMO_MODE)return;
      b.innerHTML=`<button class="we-push-banner" id="push-ask">${i('bell-ring')}<span><b>${t('Alerts reach you only while the app is open.')}</b><small>${t('Switch on phone notifications')}</small></span>${i('chevron-right')}</button>`;icons();
      on('#push-ask',async()=>{if(await turnOnPush())b.innerHTML=''})});
    // Opening a notification marks it seen and goes where it points: the driver link or the vehicle.
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

/* ---------- Trip maths shared by history and reports ---------- */
type Segment={kind:'run'|'stop';from:number;to:number;km:number;at:Fix;end:Fix;maxSpeed:number};
const STOP_MIN=5*60000;
function km(a:{latitude:number;longitude:number},b:{latitude:number;longitude:number}){
  const r=Math.PI/180,h=Math.sin((b.latitude-a.latitude)*r/2)**2+Math.cos(a.latitude*r)*Math.cos(b.latitude*r)*Math.sin((b.longitude-a.longitude)*r/2)**2;
  return 12742*Math.asin(Math.sqrt(h));
}
// Runs and stops (5 minutes or more) from the stored fixes; implied jumps over 150 km/h are GPS noise.
function segments(track:Fix[]):Segment[]{
  const out:Segment[]=[];
  let cur:Segment|null=null;
  for(let n=0;n<track.length;n++){
    const p=track[n],prev=track[n-1],kind:Segment['kind']=p.speed>=3?'run':'stop';
    let step=0;if(prev){const dt=(p.recordedAt-prev.recordedAt)/3600000,d=km(prev,p);if(dt>0&&d/dt<=150&&(kind==='run'||prev.speed>=3||d>=0.1))step=d}
    if(!cur||cur.kind!==kind){if(cur){cur.to=p.recordedAt;cur.end=p;cur.km+=step;step=0}cur={kind,from:p.recordedAt,to:p.recordedAt,km:0,at:p,end:p,maxSpeed:p.speed};out.push(cur)}
    cur.to=p.recordedAt;cur.end=p;cur.km+=step;cur.maxSpeed=Math.max(cur.maxSpeed,p.speed);
  }
  // Short halts inside a run are part of the run.
  const merged:Segment[]=[];
  for(const s of out){const last=merged.at(-1);if(s.kind==='stop'&&s.to-s.from<STOP_MIN&&last){last.to=s.to;last.end=s.end;last.km+=s.km;continue}if(last&&last.kind===s.kind){last.to=s.to;last.end=s.end;last.km+=s.km;last.maxSpeed=Math.max(last.maxSpeed,s.maxSpeed);continue}merged.push({...s})}
  return merged;
}
async function loadTrack(id:string,from:Date,to:Date){
  const points:Fix[]=[];let after:number|null=0;
  do{const r:{positions:Fix[];next:number|null}=await api(`/devices/${id}/history?${new URLSearchParams({from:from.toISOString(),to:to.toISOString(),after:String(after)})}`);points.push(...r.positions);after=r.next}while(after!==null&&points.length<100000);
  return points.filter(p=>p.valid!==0).sort((a,b)=>a.recordedAt-b.recordedAt||a.id-b.id);
}
const dur=(ms:number)=>hm(Math.max(0,Math.round(ms/60000)));
function rangeFor(preset:string):[Date,Date]{
  if(preset==='yesterday')return [dayStart(-1),dayStart()];
  if(preset==='week')return [dayStart(-6),new Date()];
  return [dayStart(),new Date()];
}
const PRESETS:[string,string][]=[['today','Today'],['yesterday','Yesterday'],['week','Last 7 days'],['custom','Date range']];
// Asks for a custom range and returns it, or null if cancelled.
function askRange(from:Date,to:Date):Promise<[Date,Date]|null>{
  return new Promise(resolve=>{
    modal(t('Date range'),`<form class="form" id="range"><div class="form-row"><label class="field">${t('From')}<input class="input" type="datetime-local" name="from" value="${localInput(from)}" required></label><label class="field">${t('To')}<input class="input" type="datetime-local" name="to" value="${localInput(to)}" required></label></div><p class="hint">${t('Up to 31 days.')}</p><button class="btn btn-primary" type="submit">${t('Show')}</button></form>`);
    const dlg=document.querySelector<HTMLDialogElement>('dialog.modal')!;let done=false;
    dlg.addEventListener('close',()=>{if(!done)resolve(null)},{once:true});
    $('#range').addEventListener('submit',e=>{e.preventDefault();const f=new FormData(e.target as HTMLFormElement),a=new Date(String(f.get('from'))),b=new Date(String(f.get('to')));if(!(+a<+b)||+b-+a>31*86400000){toast(t('Choose a range of up to 31 days.'),true);return}done=true;closeModal();resolve([a,b])});
  });
}

/* ---------- Route history ---------- */
let historyVehicle='',playTimer:ReturnType<typeof setInterval>|undefined;
function renderHistory(){
  historyVehicle=historyVehicle||fleet.devices[0]?.id||'';
  const autoplay=playOnOpen;playOnOpen=false;
  $('#view').innerHTML=`<div class="we-hist">
    ${topBar(`<select class="we-title-select" id="hv">${fleet.devices.map(d=>`<option value="${d.id}" ${d.id===historyVehicle?'selected':''}>${esc(d.name)}</option>`).join('')}</select>`)}
    <section class="we-hmap"><div class="cx-map" id="hmap"></div>
      <div class="we-chips over" id="presets">${PRESETS.map(([k,l],n)=>`<button data-preset="${k}" class="${n?'':'on'}">${t(l)}${k==='custom'?i('calendar'):''}</button>`).join('')}</div>
      <button class="we-play" id="play" aria-label="${t('Play')}">${i('play')}</button>
      <div class="we-scrub" id="scrub" hidden><input type="range" id="slider" min="0" max="0" value="0" aria-label="${t('Route position')}"><span id="hpoint"></span></div>
    </section>
    <section class="we-sheet" id="hsheet"><div class="cx-grab"></div><p class="cx-hint">${t('Loading route…')}</p></section></div>`;
  on('[data-back]',back);
  const hmap=createMap($('#hmap')),layer=L.layerGroup().addTo(hmap);let truck:L.Marker|undefined;
  const resize=new ResizeObserver(()=>hmap.invalidateSize());resize.observe($('#hmap'));
  teardown=()=>{clearInterval(playTimer);resize.disconnect();hmap.remove()};
  let track:Fix[]=[],range=rangeFor('today'),tab:'all'|'stops'='all';
  const showPoint=(n:number)=>{
    const p=track[n];if(!p)return;
    const next=track[n+1]||p,prev=track[n-1]||p,heading=p.speed>=3&&p.heading!=null?p.heading:next!==p?bearing(p,next):prev!==p?bearing(prev,p):0;
    if(!truck)truck=L.marker(point(p),{icon:playbackIcon(heading,p.speed>=3),zIndexOffset:1000}).addTo(hmap);
    else{truck.setLatLng(point(p));const pin=truck.getElement()?.querySelector<HTMLElement>('.gps-pin');if(pin){pin.className=`gps-pin on ${p.speed>=3?'running':'stopped'}`;pin.querySelector<HTMLElement>('span')!.style.transform=`rotate(${heading}deg)`}}
    $<HTMLInputElement>('#slider').value=String(n);
    $('#hpoint').innerHTML=`<b>${clock(p.recordedAt)}</b> · ${Math.round(p.speed)} km/h`;
    if(!hmap.getBounds().pad(-0.15).contains(point(p)))hmap.panTo(point(p),{animate:true});
  };
  const stopPlay=()=>{clearInterval(playTimer);playTimer=undefined;$('#play').innerHTML=i('play');icons()};
  const play=()=>{if(!track.length)return;if(playTimer){stopPlay();return}$('#scrub').hidden=false;let n=Number($<HTMLInputElement>('#slider').value);if(n>=track.length-1)n=0;$('#play').innerHTML=i('pause');icons();playTimer=setInterval(()=>{showPoint(n++);if(n>=track.length){stopPlay();showPoint(track.length-1)}},350)};
  on('#play',play);
  $<HTMLInputElement>('#slider').oninput=e=>{stopPlay();showPoint(Number((e.target as HTMLInputElement).value))};
  on('[data-preset]',async el=>{
    const k=el.dataset.preset!;let r:[Date,Date]|null=k==='custom'?await askRange(range[0],range[1]):rangeFor(k);if(!r)return;
    range=r;$$('[data-preset]').forEach(b=>b.classList.toggle('on',b===el));void load();
  });
  $<HTMLSelectElement>('#hv').onchange=e=>{historyVehicle=(e.target as HTMLSelectElement).value;void load()};
  const drawSheet=(segs:Segment[])=>{
    const runs=segs.filter(s=>s.kind==='run'),stops=segs.filter(s=>s.kind==='stop');
    const total=Math.round(runs.reduce((s,r)=>s+r.km,0)*10)/10,runMs=runs.reduce((s,r)=>s+r.to-r.from,0),stopMs=stops.reduce((s,r)=>s+r.to-r.from,0);
    const last=track.at(-1)!,shown=(tab==='stops'?stops:segs).slice().reverse();
    $('#hsheet').innerHTML=`<div class="cx-grab"></div>
      <div class="we-hhead"><b>${placeSpan(last,'history-last',{short:true})}</b><button class="we-round" id="csv" aria-label="${t('Download CSV')}">${i('download')}</button><button class="we-soft-btn" data-go="reports">${t('More reports')}</button></div>
      <div class="we-sum"><div class="run"><span>${t('Run-time')}</span><b>${total} ${t('km')}</b><small>(${dur(runMs)})</small></div><div class="stop"><span>${t('Stop-time')}</span><b>${t('{n} stops',{n:stops.length})}</b><small>(${dur(stopMs)})</small></div></div>
      <div class="we-tabs2"><button data-tab="all" class="${tab==='all'?'on':''}">${t('All')} (${total} ${t('km')})</button><button data-tab="stops" class="${tab==='stops'?'on':''}">${t('Stops')} (${stops.length})</button></div>
      <div class="we-timeline">${shown.map((s,n)=>`<button class="we-seg ${s.kind}" data-seg="${segs.indexOf(s)}"><span class="we-seg-dot">${i(s.kind==='run'?'navigation':'circle-parking')}</span><span class="we-seg-body"><span class="we-seg-head"><b>${t(s.kind==='run'?'Running':'Stopped')}</b><em>${dur(s.to-s.from)}</em></span><small>${when(s.from)} – ${clock(s.to)}</small>${s.kind==='run'?`<small class="we-route"><b>${t('From')}</b> ${placeSpan(s.at,'segfrom-'+n,{short:true,lookup:n<12})}<br><b>${t('To')}</b> ${placeSpan(s.end,'segto-'+n,{short:true,lookup:n<12})}</small><small>${t('Covered {n} km',{n:Math.round(s.km*10)/10})} · ${t('Max speed')} ${Math.round(s.maxSpeed)} km/h</small>`:`<small>${placeSpan(s.at,'seg-'+n,{short:true,lookup:n<15})}</small>`}</span></button>`).join('')||`<p class="cx-hint">${t('No movement recorded in this period.')}</p>`}</div>`;
    const sh=$('#hsheet');
    on('[data-tab]',b=>{tab=b.dataset.tab as typeof tab;drawSheet(segs)},sh);
    on('[data-go]',b=>go(b.dataset.go as View),sh);
    on('[data-seg]',b=>{const s=segs[Number(b.dataset.seg)];const n=track.findIndex(p=>p.recordedAt>=s.from);stopPlay();$('#scrub').hidden=false;showPoint(Math.max(0,n));hmap.setView(point(s.at),Math.max(hmap.getZoom(),14));window.scrollTo({top:0,behavior:'smooth'})},sh);
    on('#csv',async()=>{
      const v=vehicle(historyVehicle),btn=$<HTMLButtonElement>('#csv');btn.disabled=true;toast(t('Preparing the file…'));
      // Place names come from the free map service, one per second; the file waits for up to 25 of them and
      // keeps the coordinates in their own columns for anything it could not name.
      let budget=25;
      const name=async(p:Fix)=>{const key=placeKey(p),known=places.get(key);if(known)return known.label;if(budget<=0)return '';budget--;return (await place(p).catch(()=>null))?.label||''};
      const stamp=(at:number)=>new Date(at).toLocaleString(locale(),{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true});
      const rows:(string|number)[][]=[];
      for(const s of segs)rows.push([s.kind==='run'?'Running':'Stopped',stamp(s.from),stamp(s.to),Math.round((s.to-s.from)/60000),s.kind==='run'?Math.round(s.km*10)/10:0,s.kind==='run'?Math.round(s.maxSpeed):0,await name(s.at),s.kind==='run'?await name(s.end):await name(s.at),+s.at.latitude.toFixed(6),+s.at.longitude.toFixed(6),+s.end.latitude.toFixed(6),+s.end.longitude.toFixed(6)]);
      download(`${v?.name||'route'}-history.csv`,[['Type','Start time','End time','Minutes','Km','Max speed (km/h)','Start place','End place','Start latitude','Start longitude','End latitude','End longitude'],...rows]);
      btn.disabled=false;
    },sh);
    icons();
  };
  const load=async()=>{
    if(!historyVehicle)return;
    stopPlay();layer.clearLayers();truck?.remove();truck=undefined;track=[];$('#scrub').hidden=true;
    $('#hsheet').innerHTML=`<div class="cx-grab"></div><p class="cx-hint">${t('Loading route…')}</p>`;
    try{
      track=await loadTrack(historyVehicle,range[0],range[1]);
      if(!track.length){$('#hsheet').innerHTML=`<div class="cx-grab"></div><div class="cx-empty">${i('route')}<h3>${t('No data available')}</h3><p>${t('No movement recorded in this period.')}</p></div>`;icons();return}
      drawRoute(layer,track);hmap.fitBounds(track.map(point),{padding:[50,50],maxZoom:16});
      const slider=$<HTMLInputElement>('#slider');slider.max=String(track.length-1);slider.value='0';showPoint(track.length-1);slider.value=String(track.length-1);
      const segs=segments(track);
      segs.filter(s=>s.kind==='stop').forEach((s,n)=>L.marker(point(s.at),{icon:L.divIcon({className:'we-stop-pin',html:`<span>${n+1}</span>`,iconSize:[30,36],iconAnchor:[15,34]})}).addTo(layer));
      drawSheet(segs);
      if(autoplay){$<HTMLInputElement>('#slider').value='0';play()}
    }catch(e){$('#hsheet').innerHTML=`<div class="cx-grab"></div><p class="cx-error">${esc((e as Error).message)}</p>`}
  };
  void load();
}
function download(name:string,rows:(string|number)[][]){
  const csv=rows.map(r=>r.map(c=>/[",\n]/.test(String(c))?`"${String(c).replace(/"/g,'""')}"`:c).join(',')).join('\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

/* ---------- Reports ---------- */
function renderReports(){
  $('#view').innerHTML=`<div class="we-page">${topBar(t('Reports'))}
    <div class="we-reports">${REPORTS.map(([k,l,ic,h],n)=>`<button class="we-report" data-report="${k}"><span class="we-report-head">${i(ic)}<b>${t(l)}</b><em>${t('Get report')}${i('chevron-right')}</em></span>${n===1?`<span class="we-report-note">${t(h)}</span>`:''}</button>`).join('')}</div>
    <p class="we-foot">${t('Reports use the GPS data stored for your vehicles.')}</p></div>`;
  on('[data-back]',back);on('[data-report]',el=>go('report',el.dataset.report));icons();
}
type Row=(string|number)[];
function renderReport(){
  const [,label]=REPORTS.find(([k])=>k===reportKind)!;
  let range=rangeFor('week'),device='',rows:Row[]=[],head:string[]=[],summary='';
  $('#view').innerHTML=`<div class="we-page we-rpage">${topBar(t('{r} report',{r:t(label)}))}
    <div class="we-chips"><button id="rfilter">${i('sliders-horizontal')}${t('Filters')}</button>${PRESETS.map(([k,l])=>`<button data-preset="${k}" class="${k==='week'?'on':''}">${t(l==='Date range'?'Date range':l)}${k==='custom'?i('calendar'):''}</button>`).join('')}</div>
    <p class="we-filter-note" id="rnote"></p>
    <div id="rbody"><p class="cx-hint pad">${t('Calculating…')}</p></div>
    <nav class="we-rbar"><button data-go="reports"><span>${i('pencil')}</span>${t('Change report')}</button><button id="rcsv"><span>${i('download')}</span>${t('Download')}</button><button id="rshare"><span class="wa">${i('share-2')}</span>${t('Share report')}</button></nav></div>`;
  on('[data-back]',back);on('[data-go]',el=>go(el.dataset.go as View),$('#view'));
  const note=()=>{$('#rnote').textContent=`${device?vehicle(device)?.name:t('All vehicles')} · ${when(+range[0])} – ${when(+range[1])}`};
  on('[data-preset]',async el=>{const k=el.dataset.preset!;const r=k==='custom'?await askRange(range[0],range[1]):rangeFor(k);if(!r)return;range=r;$$('[data-preset]').forEach(b=>b.classList.toggle('on',b===el));void load()});
  on('#rfilter',()=>{
    modal(t('Filters'),`<label class="field">${t('Vehicle')}<select class="input" id="rv"><option value="">${t('All vehicles')}</option>${fleet.devices.map(d=>`<option value="${d.id}" ${d.id===device?'selected':''}>${esc(d.name)}</option>`).join('')}</select></label><button class="btn btn-primary" id="rapply">${t('Apply')}</button>`);
    on('#rapply',()=>{device=$<HTMLSelectElement>('#rv').value;closeModal();void load()});
  });
  on('#rcsv',()=>{if(rows.length)download(`waypoint-${reportKind}-report.csv`,[head,...rows]);else toast(t('No data available'),true)});
  on('#rshare',()=>{if(!rows.length){toast(t('No data available'),true);return}const text=`${t('{r} report',{r:t(label)})} · ${$('#rnote').textContent}\n${summary}\n${rows.slice(0,25).map(r=>r.join(' | ')).join('\n')}`;window.open(`https://wa.me/?text=${encodeURIComponent(text)}`,'_blank','noopener')});
  const table=(cols:string[],data:Row[])=>`<div class="we-table"><table><thead><tr>${cols.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${data.map(r=>`<tr>${r.map(c=>`<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const empty=()=>`<div class="cx-empty">${i('chart-column')}<h3>${t('No data available')}</h3><p>${t('Not enough data for the selected vehicles to generate a report. Try again with a different selection.')}</p></div>`;
  const load=async()=>{
    note();$('#rbody').innerHTML=`<p class="cx-hint pad">${t('Calculating…')}</p>`;
    const list=fleet.devices.filter(d=>!device||d.id===device);
    try{
      rows=[];summary='';
      if(reportKind==='distance'){
        const r=(await reports(range[0],range[1],device||undefined)).vehicles;
        head=[t('Vehicle No.'),t('Date'),t('Distance'),t('Running'),t('Idle'),t('Max speed')];
        rows=r.flatMap(v=>v.days.map(d=>[v.name,new Date(d.date+'T00:00').toLocaleDateString(locale(),{day:'numeric',month:'short'}),`${d.distanceKm} km`,hm(d.runningMinutes),hm(d.idleMinutes),`${d.maxSpeed} km/h`]));
        summary=`${t('Total distance')}: ${Math.round(r.reduce((s,v)=>s+v.total.distanceKm,0)*10)/10} km`;
      }else if(reportKind==='geofence'){
        const from=+range[0],to=+range[1];
        head=[t('Vehicle No.'),t('Place'),t('Event'),t('Time')];
        rows=fleet.alerts.filter(a=>(a.type==='enter'||a.type==='exit')&&a.createdAt>=from&&a.createdAt<=to&&(!device||a.deviceId===device)).sort((a,b)=>b.createdAt-a.createdAt).map(a=>[a.deviceName,a.message.replace(/^(Entered|Left) /,'').replace(/\.$/,''),t(a.type==='enter'?'Entry':'Exit'),when(a.createdAt)]);
      }else{
        for(const d of list){
          const segs=segments(await loadTrack(d.id,range[0],range[1]));
          if(reportKind==='stoppage'){head=[t('Vehicle No.'),t('Place'),t('From'),t('To'),t('Duration')];for(const s of segs.filter(x=>x.kind==='stop'))rows.push([d.name,places.get(placeKey(s.at))?.label||coords(s.at),when(s.from),when(s.to),dur(s.to-s.from)])}
          if(reportKind==='overspeed'){head=[t('Vehicle No.'),t('Time'),t('Top speed'),t('Limit'),t('Place')];for(const s of segs.filter(x=>x.kind==='run'&&x.maxSpeed>d.speedLimit))rows.push([d.name,when(s.from),`${Math.round(s.maxSpeed)} km/h`,`${d.speedLimit} km/h`,places.get(placeKey(s.at))?.label||coords(s.at)])}
          if(reportKind==='itinerary'){head=[t('Vehicle No.'),t('Status'),t('From'),t('To'),t('Duration'),t('Distance'),t('Start place'),t('End place')];for(const s of segs)rows.push([d.name,t(s.kind==='run'?'Running':'Stopped'),when(s.from),when(s.to),dur(s.to-s.from),s.kind==='run'?`${Math.round(s.km*10)/10} km`:'—',places.get(placeKey(s.at))?.label||'',places.get(placeKey(s.kind==='run'?s.end:s.at))?.label||''])}
        }
        summary=reportKind==='stoppage'?`${t('{n} stops',{n:rows.length})}`:reportKind==='overspeed'?`${t('{n} overspeeding runs',{n:rows.length})}`:'';
      }
      $('#rbody').innerHTML=rows.length?`${summary?`<p class="we-summary">${esc(summary)}</p>`:''}${table(head,rows)}${reportKind==='geofence'?`<p class="cx-hint pad">${t('From the latest 200 alerts.')}</p>`:''}`:empty();
      icons();
    }catch(e){$('#rbody').innerHTML=`<p class="cx-error pad">${esc((e as Error).message)}</p>`}
  };
  void load();
}

/* ---------- Buy GPS ---------- */
type GpsRequest={id:string;name:string;phone:string;vehicles:number;product:string;note:string;status:string;createdAt:number};
const PRODUCTS:[string,string,string,string[]][]=[
  ['wired','Truck GPS (wired)','truck',['Fitted to the vehicle battery, always on','Ignition on/off, power-cut and SOS alerts','Best for trucks, buses and tractors']],
  ['portable','Portable GPS (magnetic)','battery',['No wiring, sticks anywhere on the vehicle','Rechargeable battery','Good for trailers, containers and hired vehicles']],
  ['phone','Driver phone tracking','smartphone',['No device needed — the driver shares location from the phone','Free with your account','Good for short trips and hired drivers']],
];
function renderBuy(){
  const draw=async()=>{
    let mine:GpsRequest[]=[];try{mine=(await api<{requests:GpsRequest[]}>('/buy')).requests}catch{/* shown empty */}
    $('#view').innerHTML=`<div class="we-page we-buy">
      <div class="we-buy-hero"><div><b>${t('Get GPS for your vehicles')}</b><p>${t('Live location, route history, alerts and reports — all in this app.')}</p></div><span class="we-buy-ico">${i('navigation')}</span></div>
      ${PRODUCTS.map(([k,l,ic,points])=>`<article class="we-buy-card"><div class="we-buy-head"><span class="we-feat-ico">${i(ic)}</span><b>${t(l)}</b>${k==='phone'?`<span class="we-free">${t('Free')}</span>`:''}</div><ul>${points.map(x=>`<li>${i('check')}${t(x)}</li>`).join('')}</ul><button class="cx-btn primary" data-buy="${k}">${t(k==='phone'?'Ask for driver tracking':'Request a call back')}</button></article>`).join('')}
      <p class="cx-hint we-buy-note">${t('Our team calls you back to share price, installation and delivery. Nothing is charged in the app.')}</p>
      ${mine.length?`<h3 class="we-h">${t('My requests')}</h3><div class="cx-group">${mine.map(r=>`<div class="cx-item static"><span class="cx-ico">${i(PRODUCTS.find(p=>p[0]===r.product)?.[2]||'navigation')}</span><span class="cx-item-text"><b>${t(PRODUCTS.find(p=>p[0]===r.product)?.[1]||'GPS')} · ${r.vehicles}</b><small>${when(r.createdAt)} · ${esc(r.phone)}</small></span><span class="we-status ${r.status}">${t(r.status==='new'?'Received':r.status==='contacted'?'Contacted':'Completed')}</span></div>`).join('')}</div>`:''}
    </div>`;
    on('[data-buy]',el=>buyForm(el.dataset.buy!,draw));icons();
  };
  void draw();
}
function buyForm(product:string,done:()=>void){
  const p=prefs();
  modal(t('Request a call back'),`<form class="form" id="buy-form">
    <label class="field">${t('GPS type')}<select class="input" name="product">${PRODUCTS.map(([k,l])=>`<option value="${k}" ${k===product?'selected':''}>${t(l)}</option>`).join('')}</select></label>
    <label class="field">${t('Your name')}<input class="input" name="name" required maxlength="100" value="${esc(p.name)}"></label>
    <label class="field">${t('Mobile number')}<input class="input" name="phone" required inputmode="tel" maxlength="14" placeholder="98765 43210"></label>
    <label class="field">${t('Number of vehicles')}<input class="input" name="vehicles" type="number" min="1" max="1000" value="1" required></label>
    <label class="field">${t('City or note (optional)')}<input class="input" name="note" maxlength="500"></label>
    <p class="error" id="buy-error"></p><button class="btn btn-primary" type="submit">${t('Send request')}</button></form>`);
  $('#buy-form').addEventListener('submit',async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.target as HTMLFormElement));try{await post('/buy',{...v,vehicles:Number(v.vehicles)});closeModal();toast(t('Request sent. Our team will call you soon.'));done()}catch(err){$('#buy-error').textContent=(err as Error).message}});
}

/* ---------- Places ---------- */
type Stop={latitude:number;longitude:number;visits:number;totalMinutes:number;lastVisit:number;vehicles:string[]};
let stopsCache:{at:number;stops:Stop[]}|null=null;
const kindLabel=(kind?:string)=>t((PLACE_KIND[kind||'other']||PLACE_KIND.other)[1]);
function renderGeofences(){
  $('#view').innerHTML=`<div class="cx-page">
    <p class="cx-hint">${t('Your own places: petrol pumps, dhabas, depots, loading points. They show on the map with their name, and you get an alert when a vehicle enters or leaves one.')}</p>
    <button class="cx-btn primary" id="add-fence">${i('plus')}${t('Add place')}</button>
    ${fleet.fences.length?`<div class="cx-group">${fleet.fences.map(f=>`<div class="cx-item static"><span class="cx-ico emoji">${placeIcon(f.kind)}</span><span class="cx-item-text"><b>${esc(f.name)}</b><small>${esc(kindLabel(f.kind))} · ${f.radius} m · ${placeSpan(f,'fence-'+f.id,{short:true})}</small></span><button class="cx-icon" data-efence="${f.id}" aria-label="${t('Edit')}">${i('pencil')}</button><button class="cx-icon" data-gfence="${f.id}" aria-label="${t('Google view')}">${i('layers')}</button><button class="cx-icon danger" data-del="${f.id}" aria-label="${t('Delete')}">${i('trash-2')}</button></div>`).join('')}</div>`:`<div class="cx-empty">${i('map-pin')}<h3>${t('No places yet')}</h3><p>${t("Save a vehicle's current place, or name one of the suggested stops below.")}</p></div>`}
    <h3 class="cx-section">${t('Suggested stops')}</h3>
    <p class="cx-hint">${t('Places where your vehicles stopped 10 minutes or more, at least 3 times in the last 14 days. Check what is there on Google and give it a name.')}</p>
    <div id="stops"><p class="cx-hint">${t('Looking at the last 14 days…')}</p></div></div>`;
  on('#add-fence',()=>addFence());
  on('[data-gfence]',el=>{const f=fleet.fences.find(x=>x.id===el.dataset.gfence)!;googleModal(f.name,f.latitude,f.longitude)});
  on('[data-efence]',el=>editFence(el.dataset.efence!));
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
// The saved place the vehicle is at or nearest to (same rule as nearSaved).
function mineFence(p:{latitude:number;longitude:number}){
  let best:{f:Fence;m:number;inside:boolean}|null=null;
  for(const f of fleet.fences){const m=L.latLng(p.latitude,p.longitude).distanceTo([f.latitude,f.longitude]),inside=m<=f.radius;if((inside||m<=1500)&&(!best||(inside&&!best.inside)||(inside===best.inside&&m<best.m)))best={f,m,inside}}
  return best?.f;
}
function editFence(id:string){
  const f=fleet.fences.find(x=>x.id===id);if(!f)return;
  modal(t('Edit place'),`<form class="form" id="efence"><label class="field">${t('Name')}<input class="input" name="name" required maxlength="100" value="${esc(f.name)}"></label>
    <label class="field">${t('Type')}<select class="input" name="kind">${Object.entries(PLACE_KIND).map(([k,[ic,l]])=>`<option value="${k}" ${k===(f.kind||'other')?'selected':''}>${ic} ${esc(t(l))}</option>`).join('')}</select></label>
    <label class="field">${t('Radius (metres)')}<input class="input" type="number" name="radius" min="50" max="100000" value="${f.radius}" required></label>
    <p class="error"></p><button class="btn btn-primary" type="submit">${t('Save')}</button></form>`);
  const form=$<HTMLFormElement>('#efence');
  form.onsubmit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(form));
    try{const r=await post<Fence>(`/fences/${id}`,{name:v.name,kind:v.kind,radius:Number(v.radius)},'PUT');Object.assign(f,{name:r.name,kind:r.kind,radius:Number(r.radius)});closeModal();toast(t('Place saved.'));if(view==='geofences')renderGeofences();else onRefresh?.()}
    catch(x){form.querySelector('.error')!.textContent=t((x as Error).message)}};
}
function addFence(at?:{latitude:number;longitude:number;radius:number}){
  const withPos=fleet.devices.filter(d=>d.position);
  modal(t('Add place'),`<form class="form" id="fence-form"><label class="field">${t('Name')}<input class="input" name="name" required maxlength="100" placeholder="${t('HP petrol pump, Tridev dhaba, Pune depot')}"></label>
    <label class="field">${t('Type')}<select class="input" name="kind">${Object.entries(PLACE_KIND).map(([k,[ic,l]])=>`<option value="${k}" ${k==='other'?'selected':''}>${ic} ${esc(t(l))}</option>`).join('')}</select></label>
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
      ${item('bell-ring',t('Phone notifications'),'<span id="browser-note"></span>',sw('id="push-sw"'))}
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
  const pushBox=$<HTMLInputElement>('#push-sw');
  const note=async()=>{const on=await pushActive();pushBox.checked=on;$('#browser-note').textContent=on?t('On. Alerts come to this phone even when the app is closed.'):isIOS()&&!isInstalled()?t('iPhone: tap Share, then "Add to Home Screen", open Waypoint from there and switch this on.'):!pushSupported()?t('This browser cannot show notifications.'):browserState()==='denied'?t('Blocked. Allow notifications for this site in the phone settings.'):t('Off. Switch on to get alerts with the app closed.')};
  pushBox.addEventListener('change',async()=>{if(pushBox.checked)await turnOnPush();else{await disablePush();toast(t('Phone notifications off.'))}void note()});
  $$<HTMLInputElement>('[data-n]').forEach(box=>{const k=box.dataset.n as 'popup'|'voice';box.checked=np[k];box.addEventListener('change',async()=>{
    if(k==='voice')unlockVoice();
    np[k]=box.checked;await saveNotify(np);toast(t('Saved.'))})});
  $$<HTMLInputElement>('[data-cat-n]').forEach(box=>{const k=box.dataset.catN as Category;box.checked=np.categories[k];box.addEventListener('change',async()=>{np.categories[k]=box.checked;await saveNotify(np);void syncPush(np);toast(t('Saved.'))})});
  on('[data-lang]',el=>{setLang(el.dataset.lang as Lang);void syncPush(notifyPrefs());render();toast(t('Language changed.'))});
  on('#test-voice',()=>{unlockVoice();speakAlert('Vehicle {n} started',{n:fleet.devices[0]?.name||'MH 12 AB 1234'})});void note();
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
