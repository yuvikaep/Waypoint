import {$,$$,api,post,brand,chip,clock,closeModal,coords,esc,hm,i,icons,localInput,mapsLink,modal,on,since,STATUS_LABEL,statusLine,statusOf,time,ago,toast,whenUnauthorized,type Alert,type Fence,type Fix,type Identity,type StatusKey,type Vehicle} from '../shared/core';
import {bearing,createMap,drawRoute,playbackIcon,point,truckIcon,truckTag,L} from '../shared/map';
import {placeSpan,places,placeKey} from '../shared/places';
import {DEMO_MODE,workspaceStorage} from '../demo';
import {showLogin} from '../auth';
import {CATEGORIES,alertWords,announceNew,askBrowserPermission,browserState,browserSupported,categoryOf,mergeNotify,primeSeen,speak,unlockVoice,voiceSupported,type Category,type NotifyPrefs} from './notify';

type View='map'|'vehicles'|'history'|'reports'|'alerts'|'geofences'|'documents'|'ebills'|'settings'|'more';
type Fleet={devices:Vehicle[];fences:Fence[];alerts:Alert[]};
type Gap={from:number;to:number;minutes:number;movedKm:number|null};
type DayReport={date:string;distanceKm:number;runningMinutes:number;idleMinutes:number;ignitionMinutes:number;maxSpeed:number;avgSpeed:number;firstMove:number|null;lastMove:number|null;gaps:Gap[]};
type VehicleReport={id:string;name:string;total:{distanceKm:number;runningMinutes:number;idleMinutes:number;maxSpeed:number;avgSpeed:number;gapMinutes:number};days:DayReport[]};
// Distance is only what the tracker reported. When it went silent, say so instead of guessing.
const gapNote=(g:Gap)=>`Tracker sent no data ${clock(g.from)} – ${clock(g.to)} (${hm(g.minutes)})${g.movedKm?` · moved ${g.movedKm} km in this time`:''} · km in this period is not recorded`;
type Prefs={name:string;workspace:string;follow:boolean;defaultView:View;notify?:Partial<NotifyPrefs>};
const notifyPrefs=():NotifyPrefs=>mergeNotify(prefs().notify);
async function saveNotify(next:NotifyPrefs){await workspaceStorage.setItem('workspace-preferences',JSON.stringify({...prefs(),notify:next}))}

const NAV:[View,string,string][]=[['map','Live map','map'],['vehicles','Vehicles','truck'],['history','History','route'],['reports','Reports','chart-column'],['alerts','Alerts','bell'],['geofences','Geofences','map-pin'],['documents','Documents','files'],['ebills','E-way bills','file-text'],['settings','Settings','settings']];
const TABS:[View,string,string][]=[['map','Map','map'],['vehicles','Vehicles','truck'],['history','History','route'],['reports','Reports','chart-column'],['more','More','ellipsis']];
const TITLES:Record<View,string>={map:'Live map',vehicles:'Vehicles',history:'Route history',reports:'Reports',alerts:'Alerts',geofences:'Geofences',documents:'Documents',ebills:'E-way bills',settings:'Settings',more:'More'};

let me:Identity,fleet:Fleet={devices:[],fences:[],alerts:[]},view:View='map',selected='',filter:StatusKey|'all'='all',search='',following=false,fitted=false;
let poll:ReturnType<typeof setTimeout>|undefined,teardown:(()=>void)|undefined;

function prefs():Prefs{
  const defaults:Prefs={name:me?.name||'',workspace:'My fleet',follow:false,defaultView:'map'};
  try{const saved=JSON.parse(workspaceStorage.getItem('workspace-preferences')||'{}');return {...defaults,...saved,defaultView:NAV.some(([v])=>v===saved.defaultView)?saved.defaultView:'map'}}catch{return defaults}
}
const openAlerts=()=>fleet.alerts.filter(a=>!a.acknowledged).length;
const vehicle=(id:string)=>fleet.devices.find(d=>d.id===id);
const counts=()=>{const c:Record<string,number>={all:fleet.devices.length};for(const d of fleet.devices){const s=statusOf(d);c[s]=(c[s]||0)+1}return c};
const visible=()=>fleet.devices.filter(d=>(filter==='all'||statusOf(d)===filter)&&`${d.name} ${d.driver}`.toLowerCase().includes(search.toLowerCase()));

export async function startCustomer(identity:Identity){
  me=identity;following=prefs().follow;
  whenUnauthorized(()=>{stop();showLogin('Your session ended. Please sign in again.')});
  const requested=new URLSearchParams(location.search).get('view') as View|null;
  view=requested&&(NAV.some(([v])=>v===requested)||requested==='more')?requested:prefs().defaultView;
  try{fleet=await api<Fleet>('/state')}catch(e){$('#app').innerHTML=`<div class="empty">${i('wifi-off')}<h3>Could not load your fleet</h3><p>${esc((e as Error).message)}</p><button class="btn btn-primary" id="retry">Retry</button></div>`;on('#retry',()=>location.reload());icons();return}
  selected=new URLSearchParams(location.search).get('vehicle')||'';
  primeSeen(fleet.alerts);document.addEventListener('click',unlockVoice,{once:true});
  window.addEventListener('popstate',()=>{const v=new URLSearchParams(location.search).get('view') as View|null;go(v||'map',false)});
  shell();schedule();
}
function stop(){clearTimeout(poll);teardown?.();teardown=undefined}
// Short polls keep the map, alerts and voice close to real time (the gateway pushes within ~1 s).
function schedule(){clearTimeout(poll);poll=setTimeout(refresh,document.hidden?5000:2000)}
async function refresh(){
  try{fleet=await api<Fleet>('/state');announceNew(fleet.alerts,notifyPrefs());updateBadges();if(view==='map')updateLive();else if(view==='vehicles')renderVehicles();else if(view==='alerts')renderAlerts()}
  catch{/* keep showing the last data; the next poll retries */}
  finally{schedule()}
}
function go(next:View,push=true){
  if(push){const url=new URL(location.href);url.searchParams.set('view',next);url.searchParams.delete('vehicle');history.pushState(null,'',url)}
  view=next;shell();schedule();
}

function shell(){
  stop();
  const p=prefs(),badge=openAlerts();
  $('#app').innerHTML=`<div class="app customer">
    <aside class="sidebar">${brand()}
      <div class="who"><strong>${esc(p.workspace)}</strong><small>${esc(me.email||p.name)}</small></div>
      <nav class="nav">${NAV.map(([v,label,icon])=>`<button data-go="${v}" class="${view===v?'on':''}">${i(icon)}${label}${v==='alerts'&&badge?`<span class="badge" data-alert-badge>${badge}</span>`:''}</button>`).join('')}</nav>
      <div class="foot"><button class="btn btn-ghost btn-block" data-logout>${i('log-out')}Sign out</button></div>
    </aside>
    <div class="main">
      <header class="mobile-head">${brand()}<button class="icon-btn" data-go="alerts" aria-label="Alerts">${i('bell')}${badge?`<span class="badge" data-alert-badge>${badge}</span>`:''}</button></header>
      <header class="topbar"><div class="title"><h1>${TITLES[view]}</h1><small>${esc(p.workspace)} · ${fleet.devices.length} vehicle${fleet.devices.length===1?'':'s'}</small></div>
        <div class="toolbar">${view!=='map'?`<button class="btn btn-ghost" data-go="map">${i('map')}Live map</button>`:''}</div></header>
      <div id="view"></div>
    </div>
    <nav class="tabbar">${TABS.map(([v,label,icon])=>`<button data-go="${v}" class="${view===v||(v==='more'&&['alerts','geofences','documents','ebills','settings','more'].includes(view))?'on':''}">${i(icon)}${label}</button>`).join('')}</nav>
  </div>`;
  on('[data-go]',el=>go(el.dataset.go as View));
  on('[data-logout]',logout);
  ({map:renderLive,vehicles:renderVehicles,history:renderHistory,reports:renderReports,alerts:renderAlerts,geofences:renderGeofences,documents:()=>renderDocuments('Documents'),ebills:()=>renderDocuments('E-way bills'),settings:renderSettings,more:renderMore} as Record<View,()=>void>)[view]();
  icons();
}
function updateBadges(){const n=openAlerts();$$('[data-alert-badge]').forEach(b=>{b.textContent=String(n);b.hidden=!n})}
async function logout(){if(!DEMO_MODE)await api('/session',{method:'DELETE'}).catch(()=>{});location.href='/?live=1&auth=customer'}

/* ---------- Live map ---------- */
let map:L.Map|undefined,markers:L.LayerGroup|undefined,fences:L.LayerGroup|undefined;
const todayKm=new globalThis.Map<string,{at:number;km:number|null}>();
function renderLive(){
  $('#view').innerHTML=`<div class="live" id="live">
    <section class="live-panel" id="panel"><div class="grabber" id="grabber"></div>
      <div class="panel-head"><label class="search">${i('search')}<input class="input" id="q" placeholder="Search vehicle or driver" value="${esc(search)}"></label><div class="filters" id="filters"></div></div>
      <div class="vlist" id="vlist"></div></section>
    <div class="map-wrap"><div class="map" id="map"></div>
      <div class="map-tools"><button class="icon-btn" id="fit" title="Show all vehicles" aria-label="Show all vehicles">${i('scan')}</button><button class="icon-btn ${following?'on':''}" id="follow" title="Follow selected vehicle" aria-label="Follow selected vehicle">${i('locate-fixed')}</button></div>
      <div class="vsheet card" id="vsheet" hidden></div></div></div>`;
  map=createMap($('#map'));markers=L.layerGroup().addTo(map);fences=L.layerGroup().addTo(map);fitted=false;
  teardown=()=>{map?.remove();map=undefined};
  $<HTMLInputElement>('#q').oninput=e=>{search=(e.target as HTMLInputElement).value;updateLive()};
  on('#fit',fit);on('#follow',el=>{following=!following;el.classList.toggle('on',following);const v=vehicle(selected);if(following&&v?.position)map?.panTo(point(v.position))});
  on('#grabber',()=>{$('#panel').classList.toggle('collapsed')});
  updateLive();
  if(selected&&vehicle(selected)?.position)select(selected);
}
function fit(){
  const pts=visible().flatMap(d=>d.position?[point(d.position)]:[]);if(!pts.length||!map)return;
  // On phones the vehicle sheet covers the lower part of the map; keep trucks above it.
  const panel=document.querySelector<HTMLElement>('#panel'),covered=matchMedia('(max-width:900px)').matches&&panel?panel.offsetHeight:0;
  map.fitBounds(pts,{paddingTopLeft:[60,70],paddingBottomRight:[60,70+covered],maxZoom:16});
}
function select(id:string){
  selected=id;const v=vehicle(id);
  $('#live')?.classList.toggle('sheet-open',!!id);
  updateLive();
  if(v?.position&&map)centre(v.position,Math.max(16,map.getZoom()));
}
// Keep the vehicle in the open part of the map, above the detail card on phones.
function centre(p:{latitude:number;longitude:number},zoom=map?.getZoom()){
  if(!map)return;
  const card=matchMedia('(max-width:900px)').matches?document.querySelector<HTMLElement>('#vsheet')?.offsetHeight||0:0;
  map.setView(point(p),zoom,{animate:false});
  if(card)map.panBy([0,card/2],{animate:false});
}
function updateLive(){
  if(!map||!markers)return;
  const c=counts(),list=visible();
  $('#filters').innerHTML=(['all','running','idle','stopped','offline','nofix'] as const).map(k=>`<button data-filter="${k}" class="${filter===k?'on':''}">${k==='all'?'All':`<i class="dot" style="background:var(--${k==='nofix'?'nofix':k})"></i>${STATUS_LABEL[k]}`} <b>${c[k]||0}</b></button>`).join('');
  on('[data-filter]',el=>{filter=el.dataset.filter as StatusKey;updateLive()},$('#filters'));
  $('#vlist').innerHTML=list.length?list.map(d=>vehicleCard(d)).join(''):`<div class="empty">${i('truck')}<h3>${fleet.devices.length?'No vehicles match':'No vehicles yet'}</h3><p>${fleet.devices.length?'Try another filter.':'Your fleet administrator will add your GPS devices here.'}</p></div>`;
  on('[data-vehicle]',el=>select(el.dataset.vehicle!),$('#vlist'));
  markers.clearLayers();
  for(const d of list){
    if(!d.position)continue;
    L.marker(point(d.position),{icon:truckIcon(d,d.id===selected),title:d.name}).addTo(markers)
      .bindTooltip(truckTag(d),{permanent:d.id===selected||list.length<=15,direction:'top',offset:[0,-20],className:'truck-tooltip'})
      .on('click',()=>select(d.id));
  }
  fences!.clearLayers();
  for(const f of fleet.fences)L.circle(point(f),{radius:f.radius,color:'#7c5cc4',weight:2,fillOpacity:.07}).bindTooltip(f.name).addTo(fences!);
  if(!fitted&&list.some(d=>d.position)&&!selected){fit();fitted=true}
  const v=vehicle(selected);
  renderSheet();icons();
  if(following&&v?.position)centre(v.position);
}
function vehicleCard(d:Vehicle){
  const p=d.position,s=statusOf(d);
  return `<button class="vcard ${d.id===selected?'on':''}" data-vehicle="${d.id}">
    <div class="row"><span class="plate">${esc(d.name)}</span>${chip(d)}</div>
    <div class="where">${i('map-pin')}${placeSpan(p,d.id)}</div>
    <div class="meta"><span>${s==='running'&&p?`<b>${Math.round(p.speed)} km/h</b>`:(s==='stopped'||s==='idle')&&d.stoppedSince?`${s==='idle'?'Idle':'Parked'} <b>${since(d.stoppedSince)}</b>`:esc(STATUS_LABEL[s])}</span><span>Ignition <b>${d.ignition==null?'—':d.ignition?'On':'Off'}</b></span><span>${ago(p?.recordedAt??d.lastSeen)}</span></div>
  </button>`;
}
function renderSheet(){
  const el=document.querySelector<HTMLElement>('#vsheet');if(!el)return;
  const d=vehicle(selected);if(!d){el.hidden=true;return}
  const p=d.position,km=todayKm.get(d.id);
  if(!km||Date.now()-km.at>60000)void loadTodayKm(d.id);
  el.hidden=false;
  el.innerHTML=`<div class="head"><div><h2>${esc(d.name)}</h2>${d.driver?`<span class="small muted">${i('user-round')} ${esc(d.driver)}</span>`:''}</div><div style="display:flex;gap:8px;align-items:center">${chip(d)}<button class="icon-btn" id="close-sheet" aria-label="Close">${i('x')}</button></div></div>
    <div><div class="place">${i('map-pin')}${placeSpan(p,d.id)}</div><div class="since">${esc(statusLine(d))}</div></div>
    <div class="stats"><div><span>Speed</span><b>${p&&d.fresh?Math.round(p.speed):0} km/h</b></div><div><span>Ignition</span><b>${d.ignition==null?'—':d.ignition?'On':'Off'}</b></div><div><span>Today</span><b>${km?.km==null?'…':`${km.km} km`}</b></div><div><span>Updated</span><b>${ago(p?.recordedAt??d.lastSeen)}</b></div></div>
    <div class="acts"><button class="btn btn-primary btn-sm" id="sheet-history">${i('route')}History</button>${p?`<a class="btn btn-ghost btn-sm" href="${mapsLink(p)}" target="_blank" rel="noopener">${i('external-link')}Google Maps</a><button class="btn btn-ghost btn-sm" id="sheet-share">${i('share-2')}Share</button>`:''}${d.isMobile?`<button class="btn btn-ghost btn-sm" id="sheet-driver">${i('smartphone')}Driver link</button>`:''}</div>`;
  on('#close-sheet',()=>{selected='';$('#live').classList.remove('sheet-open');updateLive()},el);
  on('#sheet-history',()=>{historyVehicle=d.id;go('history')},el);
  on('#sheet-share',async()=>{const text=`${d.name}: ${places.get(placeKey(p!))?.label||coords(p!)}\n${mapsLink(p!)}`;if(navigator.share)await navigator.share({title:d.name,text}).catch(()=>{});else{await navigator.clipboard.writeText(text);toast('Location copied.')}},el);
  on('#sheet-driver',()=>driverLink(d),el);
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

/* ---------- Vehicles ---------- */
function renderVehicles(){
  const c=counts(),list=visible();
  const host=$('#view');
  const focused=document.activeElement?.id==='vq';
  host.innerHTML=`<div class="page">
    <div class="grid-kpi">${(['running','idle','stopped','offline'] as const).map(k=>`<button class="card kpi" data-filter="${k}" style="text-align:left;${filter===k?'border-color:var(--blue)':''}"><span>${STATUS_LABEL[k]}</span><strong style="color:var(--${k})">${c[k]||0}</strong></button>`).join('')}</div>
    <div class="toolbar"><label class="search">${i('search')}<input class="input" id="vq" placeholder="Search vehicle or driver" value="${esc(search)}"></label>${filter!=='all'?`<button class="btn btn-ghost" data-filter="all">${i('x')}${STATUS_LABEL[filter]}</button>`:''}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px">${list.map(d=>vehicleCard(d)).join('')||`<div class="card empty">${i('truck')}<h3>No vehicles</h3><p>Your fleet administrator adds GPS devices to your account.</p></div>`}</div></div>`;
  const input=$<HTMLInputElement>('#vq');input.oninput=()=>{search=input.value;renderVehicles()};
  if(focused){input.focus();input.setSelectionRange(input.value.length,input.value.length)}
  on('[data-filter]',el=>{const f=el.dataset.filter as StatusKey|'all';filter=filter===f?'all':f;renderVehicles()},host);
  on('[data-vehicle]',el=>{selected=el.dataset.vehicle!;const url=new URL(location.href);url.searchParams.set('view','map');url.searchParams.set('vehicle',selected);history.pushState(null,'',url);view='map';shell();schedule()},host);
  icons();
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
      <label class="field">Vehicle<select class="input" id="hv">${fleet.devices.map(d=>`<option value="${d.id}" ${d.id===historyVehicle?'selected':''}>${esc(d.name)}</option>`).join('')}</select></label>
      <div class="presets" id="presets">${[['today','Today'],['yesterday','Yesterday'],['week','Last 7 days'],['custom','Custom']].map(([k,l],n)=>`<button data-preset="${k}" class="${n?'':'on'}">${l}</button>`).join('')}</div>
      <div class="form-row" id="custom" hidden><label class="field">From<input class="input" type="datetime-local" id="hfrom" value="${localInput(from)}"></label><label class="field">To<input class="input" type="datetime-local" id="hto" value="${localInput(to)}"></label></div>
      <button class="btn btn-primary" id="load">${i('route')}Show route</button>
      <div class="summary" id="hsum" hidden></div>
      <div id="hplayer" hidden><div class="player"><button class="icon-btn" id="play" aria-label="Play">${i('play')}</button><input type="range" id="slider" min="0" max="0" value="0" aria-label="Route position"></div><p class="small" id="hpoint" style="margin-top:8px"></p></div>
      <p class="hint" id="hstatus">${fleet.devices.length?'Choose a day and press Show route.':'No vehicles yet.'}</p>
      <button class="btn btn-ghost btn-sm" id="csv" hidden>${i('download')}Download CSV</button>
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
  on('#csv',()=>{const v=vehicle(historyVehicle);const rows=[['Time','Latitude','Longitude','Speed km/h','Ignition'],...track.map(p=>[new Date(p.recordedAt).toISOString(),p.latitude,p.longitude,Math.round(p.speed),p.ignition==null?'':p.ignition?'On':'Off'])];download(`${v?.name||'route'}-history.csv`,rows)});
  const load=async()=>{
    if(!historyVehicle)return;
    const [from,to]=preset==='custom'?[new Date($<HTMLInputElement>('#hfrom').value),new Date($<HTMLInputElement>('#hto').value)]:rangeFor(preset);
    if(!(+from<+to)||+to-+from>31*86400000){toast('Choose a range of up to 31 days.',true);return}
    stopPlay();layer.clearLayers();truck?.remove();truck=undefined;track=[];
    $('#hstatus').textContent='Loading route…';$('#hplayer').hidden=true;$('#hsum').hidden=true;$('#csv').hidden=true;
    try{
      const points:Fix[]=[];let after:number|null=0;
      do{const r:{positions:Fix[];next:number|null}=await api(`/devices/${historyVehicle}/history?${new URLSearchParams({from:from.toISOString(),to:to.toISOString(),after:String(after)})}`);points.push(...r.positions);after=r.next}while(after!==null&&points.length<100000);
      track=points.filter(p=>p.valid!==0).sort((a,b)=>a.recordedAt-b.recordedAt||a.id-b.id);
      if(!track.length){$('#hstatus').textContent='No movement recorded in this period.';return}
      drawRoute(layer,track);hmap.fitBounds(track.map(point),{padding:[50,50],maxZoom:16});
      const slider=$<HTMLInputElement>('#slider');slider.max=String(track.length-1);slider.value='0';
      $('#hplayer').hidden=false;$('#csv').hidden=false;showPoint(0);
      $('#hstatus').textContent=`${time(track[0].recordedAt)} – ${time(track.at(-1)!.recordedAt)}`;
      const r=(await reports(from,to,historyVehicle)).vehicles[0];
      if(r){const gaps=r.days.flatMap(d=>d.gaps);$('#hsum').innerHTML=`<div><span>Distance</span><b>${r.total.distanceKm} km</b></div><div><span>Running</span><b>${hm(r.total.runningMinutes)}</b></div><div><span>Idle</span><b>${hm(r.total.idleMinutes)}</b></div><div><span>Max speed</span><b>${r.total.maxSpeed} km/h</b></div>${gaps.map(g=>`<p class="gap-note" style="grid-column:1/-1">${i('triangle-alert')}${esc(gapNote(g))}</p>`).join('')}`;$('#hsum').hidden=false;icons()}
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
      <div class="presets" id="rpresets">${[['today','Today'],['yesterday','Yesterday'],['week','Last 7 days'],['month','This month'],['custom','Custom']].map(([k,l],n)=>`<button data-preset="${k}" class="${n?'':'on'}">${l}</button>`).join('')}</div>
      <div class="form-row" id="rcustom" hidden><label class="field">From<input class="input" type="date" id="rfrom" value="${localInput(from).slice(0,10)}"></label><label class="field">To<input class="input" type="date" id="rto" value="${localInput(to).slice(0,10)}"></label></div>
      <div class="toolbar"><select class="input" id="rv" style="max-width:280px"><option value="">All vehicles</option>${fleet.devices.map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select><button class="btn btn-primary" id="rload">${i('chart-column')}Show report</button><button class="btn btn-ghost" id="rcsv" hidden>${i('download')}CSV</button></div>
    </div>
    <div class="grid-kpi" id="rkpi"></div>
    <div class="card" id="rtable"><div class="empty">${i('chart-column')}<h3>Daily vehicle report</h3><p>Distance, running time, idle time (engine on but standing) and speeds.</p></div></div></div>`;
  let preset='today',last:VehicleReport[]=[];
  on('[data-preset]',el=>{preset=el.dataset.preset!;$$('#rpresets [data-preset]').forEach(b=>b.classList.toggle('on',b===el));$('#rcustom').hidden=preset!=='custom';if(preset!=='custom')void load()});
  const load=async()=>{
    const [from,to]=preset==='custom'?[new Date($<HTMLInputElement>('#rfrom').value+'T00:00'),new Date($<HTMLInputElement>('#rto').value+'T23:59:59')]:rangeFor(preset);
    if(!(+from<+to)||+to-+from>31*86400000){toast('Choose a range of up to 31 days.',true);return}
    $('#rtable').innerHTML=`<div class="empty"><p>Calculating…</p></div>`;
    try{
      last=(await reports(from,to,$<HTMLSelectElement>('#rv').value||undefined)).vehicles;
      const sum=last.reduce((t,v)=>({km:t.km+v.total.distanceKm,run:t.run+v.total.runningMinutes,idle:t.idle+v.total.idleMinutes,max:Math.max(t.max,v.total.maxSpeed)}),{km:0,run:0,idle:0,max:0});
      $('#rkpi').innerHTML=`<div class="card kpi"><span>Total distance</span><strong>${Math.round(sum.km*10)/10} km</strong></div><div class="card kpi"><span>Running time</span><strong>${hm(sum.run)}</strong></div><div class="card kpi"><span>Idle time</span><strong style="color:var(--idle)">${hm(sum.idle)}</strong></div><div class="card kpi"><span>Top speed</span><strong>${sum.max} km/h</strong></div>`;
      $('#rtable').innerHTML=`<div class="table-wrap"><table class="table"><thead><tr><th>Vehicle / day</th><th>Distance</th><th>Running</th><th>Idle</th><th>Max speed</th><th>Avg speed</th><th class="hide-sm">First / last move</th></tr></thead><tbody>${last.map(v=>`<tr><td><b>${esc(v.name)}</b></td><td><b>${v.total.distanceKm} km</b></td><td>${hm(v.total.runningMinutes)}</td><td>${hm(v.total.idleMinutes)}</td><td>${v.total.maxSpeed} km/h</td><td>${v.total.avgSpeed} km/h</td><td class="hide-sm"></td></tr>${v.days.map(d=>`<tr class="report-days"><td>&nbsp;&nbsp;${new Date(d.date+'T00:00').toLocaleDateString('en-IN',{weekday:'short',day:'2-digit',month:'short'})}</td><td>${d.distanceKm} km</td><td>${hm(d.runningMinutes)}</td><td>${hm(d.idleMinutes)}</td><td>${d.maxSpeed} km/h</td><td>${d.avgSpeed} km/h</td><td class="hide-sm">${d.firstMove?`${clock(d.firstMove)} – ${clock(d.lastMove)}`:'—'}</td></tr>${d.gaps.map(g=>`<tr class="report-days"><td colspan="7"><div class="gap-note">${i('triangle-alert')}${esc(gapNote(g))}</div></td></tr>`).join('')}`).join('')}`).join('')||'<tr><td colspan="7" class="muted">No vehicles.</td></tr>'}</tbody></table></div>`;
      $('#rcsv').hidden=!last.length;icons();
    }catch(e){$('#rtable').innerHTML=`<div class="empty"><p class="error">${esc((e as Error).message)}</p></div>`}
  };
  on('#rload',load);
  on('#rcsv',()=>download('waypoint-report.csv',[['Vehicle','Date','Distance km','Running min','Idle min','Max speed','Avg speed'],...last.flatMap(v=>v.days.map(d=>[v.name,d.date,d.distanceKm,d.runningMinutes,d.idleMinutes,d.maxSpeed,d.avgSpeed]))]));
  if(fleet.devices.length)void load();
}

/* ---------- Alerts and geofences ---------- */
let alertsAll=false,alertsCat:Category|'all'='all';
// Server alert texts are written for operators; say the same thing in plain words.
function alertText(a:Alert){
  if(a.type==='offline'){const s=Number(a.message.match(/(\d+) seconds/)?.[1]);return `Signal lost${s?` · no update for ${s>=120?`${Math.round(s/60)} min`:`${s} sec`}`:''}`}
  if(a.type==='ignition_on')return 'Vehicle started · engine on';
  if(a.type==='ignition_off')return 'Engine off';
  if(a.type==='online')return 'Signal restored';
  return a.message;
}
function renderAlerts(){
  const open=(c:Category|'all')=>fleet.alerts.filter(a=>!a.acknowledged&&(c==='all'||categoryOf(a.type)===c)).length;
  const list=fleet.alerts.filter(a=>(alertsAll||!a.acknowledged)&&(alertsCat==='all'||categoryOf(a.type)===alertsCat));
  const style=(t:string)=>{const c=CATEGORIES.find(x=>x.key===categoryOf(t))!;const ic=t==='ignition_on'?'power':t==='ignition_off'?'power':t==='online'?'activity':c.icon;const on=t==='ignition_on'||t==='online';return {ic,color:on?'var(--running)':t==='ignition_off'?'var(--stopped)':c.color}};
  $('#view').innerHTML=`<div class="page"><div class="filters" id="cats"><button data-cat="all" class="${alertsCat==='all'?'on':''}">All <b>${open('all')}</b></button>${CATEGORIES.map(c=>`<button data-cat="${c.key}" class="${alertsCat===c.key?'on':''}">${esc(c.label)} <b>${open(c.key)}</b></button>`).join('')}</div>
    <div class="toolbar"><div class="seg"><button data-all="0" class="${alertsAll?'':'on'}">Open</button><button data-all="1" class="${alertsAll?'on':''}">All</button></div><span style="flex:1"></span>${open(alertsCat)?`<button class="btn btn-ghost btn-sm" id="ack-all">${i('check')}Mark all seen</button>`:''}<button class="btn btn-ghost btn-sm" data-go="settings">${i('settings')}Notification settings</button></div>
    <div class="card">${list.map(a=>{const st=style(a.type);return `<div class="alert-item ${a.acknowledged?'done':''}"><span class="ico" style="background:var(--soft);color:${st.color}">${i(st.ic)}</span><div class="body"><b>${esc(a.deviceName)}</b><p>${esc(alertText(a))}</p><span class="small muted">${esc(CATEGORIES.find(c=>c.key===categoryOf(a.type))!.label)} · ${time(a.createdAt)}</span></div>${a.acknowledged?`<span class="chip plain ok">${i('check')}Seen</span>`:`<button class="btn btn-ghost btn-sm" data-ack="${a.id}">Mark seen</button>`}</div>`}).join('')||`<div class="empty">${i('bell')}<h3>All clear</h3><p>${alertsCat==='all'?'Engine, geofence, overspeed and signal alerts appear here.':'Nothing in this category.'}</p></div>`}</div></div>`;
  on('[data-cat]',el=>{alertsCat=el.dataset.cat as Category|'all';renderAlerts()});
  on('[data-all]',el=>{alertsAll=el.dataset.all==='1';renderAlerts()});
  on('#view [data-go]',el=>go(el.dataset.go as View));
  on('[data-ack]',async el=>{await post(`/alerts/${el.dataset.ack}/ack`);fleet.alerts=fleet.alerts.map(a=>a.id===el.dataset.ack?{...a,acknowledged:1}:a);updateBadges();renderAlerts()});
  on('#ack-all',async()=>{const ids=fleet.alerts.filter(a=>!a.acknowledged&&(alertsCat==='all'||categoryOf(a.type)===alertsCat)).map(a=>a.id);for(const id of ids)await post(`/alerts/${id}/ack`);const set=new Set(ids);fleet.alerts=fleet.alerts.map(a=>set.has(a.id)?{...a,acknowledged:1}:a);updateBadges();renderAlerts();toast('All marked seen.')});
  icons();
}
function renderGeofences(){
  $('#view').innerHTML=`<div class="page"><div class="toolbar"><p class="muted" style="flex:1">Get an alert when a vehicle enters or leaves a place, like your depot or a customer site.</p><button class="btn btn-primary" id="add-fence">${i('plus')}Add geofence</button></div>
    <div class="card">${fleet.fences.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Place</th><th>Radius</th><th></th></tr></thead><tbody>${fleet.fences.map(f=>`<tr><td><b>${esc(f.name)}</b></td><td>${placeSpan(f,'fence-'+f.id)}</td><td>${f.radius} m</td><td><div class="actions"><button class="btn btn-danger btn-sm" data-del="${f.id}">${i('trash-2')}Delete</button></div></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty">${i('map-pin')}<h3>No geofences yet</h3><p>Create one from a vehicle's current place.</p></div>`}</div></div>`;
  on('#add-fence',addFence);
  on('[data-del]',async el=>{const f=fleet.fences.find(x=>x.id===el.dataset.del)!;if(!confirm(`Delete geofence ${f.name}?`))return;await api(`/fences/${f.id}`,{method:'DELETE'});fleet=await api<Fleet>('/state');renderGeofences()});
  icons();
}
function addFence(){
  const withPos=fleet.devices.filter(d=>d.position);
  modal('Add geofence',`<form class="form" id="fence-form"><label class="field">Name<input class="input" name="name" required maxlength="100" placeholder="Pune depot"></label>
    <label class="field">Centre<select class="input" id="fence-from"><option value="">Enter coordinates</option>${withPos.map(d=>`<option value="${d.id}">Current place of ${esc(d.name)}</option>`).join('')}</select></label>
    <div class="form-row"><label class="field">Latitude<input class="input" type="number" step="any" min="-90" max="90" name="latitude" required></label><label class="field">Longitude<input class="input" type="number" step="any" min="-180" max="180" name="longitude" required></label></div>
    <label class="field">Radius (metres)<input class="input" type="number" name="radius" min="50" max="100000" value="500" required></label>
    <p class="error" id="fence-error"></p><button class="btn btn-primary" type="submit">Save geofence</button></form>`);
  const form=$<HTMLFormElement>('#fence-form');
  $<HTMLSelectElement>('#fence-from').onchange=e=>{const d=vehicle((e.target as HTMLSelectElement).value);if(d?.position){form.latitude.value=d.position.latitude.toFixed(6);form.longitude.value=d.position.longitude.toFixed(6)}};
  if(withPos[0]){$<HTMLSelectElement>('#fence-from').value=withPos[0].id;$<HTMLSelectElement>('#fence-from').dispatchEvent(new Event('change'))}
  form.addEventListener('submit',async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(form));try{await post('/fences',{name:v.name,latitude:Number(v.latitude),longitude:Number(v.longitude),radius:Number(v.radius)});closeModal();fleet=await api<Fleet>('/state');renderGeofences();toast('Geofence saved.')}catch(err){$('#fence-error').textContent=(err as Error).message}});
}

/* ---------- Driver link (phone senders only) ---------- */
function driverLink(d:Vehicle){
  modal(`${d.name} · Driver link`,`<p>Driver ko yeh link bhejein. Link kholkar "Location shuru karein" dabane par gaadi map par dikhegi.</p><div id="link-box"><p class="muted">Loading…</p></div><p class="error" id="link-error"></p>
    <div class="toolbar"><button class="btn btn-primary" id="make-link">${i('plus')}Create link</button><button class="btn btn-ghost" id="stop-link">Disable link</button></div>`);
  const show=async(create:boolean,regenerate=false)=>{
    try{
      const r=await api<{code:string|null}|null>(`/devices/${d.id}/driver-link`,create?{method:'POST',body:JSON.stringify({regenerate})}:{});
      if(!r?.code){$('#link-box').innerHTML='<p class="muted">No active link yet.</p>';return}
      const url=new URL('/?sender=1',location.origin);url.hash=new URLSearchParams({join:r.code}).toString();
      $('#link-box').innerHTML=`<label class="field">Driver link<input class="input" readonly value="${esc(url)}"></label><div class="toolbar"><button class="btn btn-ghost btn-sm" data-copy="${esc(url)}">${i('copy')}Copy</button>${typeof navigator.share==='function'?`<button class="btn btn-blue btn-sm" id="share-link">${i('share-2')}Share</button>`:''}</div>`;
      on('[data-copy]',async el=>{await navigator.clipboard.writeText(el.dataset.copy!);toast('Link copied.')});
      on('#share-link',()=>navigator.share({title:d.name,text:'Location share karne ke liye yeh link kholein.',url:String(url)}).catch(()=>{}));
      $('#make-link').innerHTML=`${i('refresh-cw')}New link`;$('#make-link').dataset.active='1';icons();
    }catch(e){$('#link-error').textContent=(e as Error).message}
  };
  on('#make-link',async el=>{const regen=el.dataset.active==='1';if(regen&&!confirm('Create a new link? The old link will stop working.'))return;await show(true,regen)});
  on('#stop-link',async()=>{await api(`/devices/${d.id}/driver-link`,{method:'DELETE'});$('#link-box').innerHTML='<p class="muted">Driver link disabled.</p>'});
  void show(false);
}

/* ---------- Documents / E-way (existing module) ---------- */
async function renderDocuments(section:'Documents'|'E-way bills'){
  const host=$('#view');host.innerHTML='<div class="page"><p class="muted">Loading…</p></div>';
  try{const {mountDocuments}=await import('../main');const page=document.createElement('div');page.className='page';host.replaceChildren(page);mountDocuments(page,section,fleet.devices.map(d=>({name:d.name,model:'',driver:d.driver})))}
  catch{host.innerHTML='<div class="page"><p class="error">Unable to load this section. Refresh to retry.</p></div>'}
}

/* ---------- Settings and More ---------- */
function renderSettings(){
  const p=prefs();
  $('#view').innerHTML=`<div class="page" style="max-width:720px">
    <form class="card card-pad form" id="prefs"><h2>Profile</h2>
      <div class="form-row"><label class="field">Your name<input class="input" name="name" maxlength="100" value="${esc(p.name)}"></label><label class="field">Fleet name<input class="input" name="workspace" maxlength="100" required value="${esc(p.workspace)}"></label></div>
      <label class="field">Open the app on<select class="input" name="defaultView">${NAV.map(([v,l])=>`<option value="${v}" ${p.defaultView===v?'selected':''}>${l}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="follow" ${p.follow?'checked':''}>Keep the map centred on the selected vehicle</label>
      <p class="error" id="prefs-error"></p><button class="btn btn-primary" type="submit" style="align-self:flex-start">${i('save')}Save</button></form>
    <div class="card card-pad form" id="notify"><h2>Alert notifications</h2><p class="hint">Alerts are always saved in the Alerts page. These switches decide what pops up and speaks while the app is open.</p>
      <label class="check"><input type="checkbox" data-n="popup">Show a pop-up message</label>
      <label class="check"><input type="checkbox" data-n="voice">Speak alerts aloud${voiceSupported()?'':' (not supported in this browser)'}</label>
      <div class="toolbar"><button class="btn btn-ghost btn-sm" type="button" id="test-voice">${i('play')}Test voice</button></div>
      <label class="check"><input type="checkbox" data-n="browser">Browser notifications when this tab is in the background</label>
      <p class="hint" id="browser-note"></p>
      <h3 style="margin-top:6px">Which alerts?</h3>
      ${CATEGORIES.map(c=>`<label class="check" style="align-items:flex-start"><input type="checkbox" data-cat-n="${c.key}" style="margin-top:3px"><span><b>${esc(c.label)}</b><br><span class="hint">${esc(c.hint)}</span></span></label>`).join('')}
      <p class="hint">Voice and notifications work while Waypoint is open in a browser tab, including a background tab. They stop when the tab or browser is closed or the phone suspends it.</p></div>
    ${DEMO_MODE?'':`<form class="card card-pad form" id="password"><h2>Change password</h2><p class="hint">Signed in as ${esc(me.email)}. Your other devices will be signed out.</p>
      <label class="field">Current password<input class="input" type="password" name="currentPassword" required autocomplete="current-password"></label>
      <div class="form-row"><label class="field">New password<input class="input" type="password" name="newPassword" required minlength="12" maxlength="128" autocomplete="new-password"></label><label class="field">Confirm new password<input class="input" type="password" name="confirmPassword" required minlength="12" maxlength="128" autocomplete="new-password"></label></div>
      <p class="hint">At least 12 characters.</p><p class="error" id="password-error"></p><button class="btn btn-primary" type="submit" style="align-self:flex-start">${i('key-round')}Change password</button></form>`}
    <button class="btn btn-ghost" data-logout style="align-self:flex-start">${i('log-out')}Sign out</button></div>`;
  $('#prefs').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target as HTMLFormElement);try{const next={...prefs(),name:String(f.get('name')).trim(),workspace:String(f.get('workspace')).trim()||'My fleet',defaultView:f.get('defaultView') as View,follow:f.has('follow')};await workspaceStorage.setItem('workspace-preferences',JSON.stringify(next));following=next.follow;toast('Saved.');shell()}catch(err){$('#prefs-error').textContent=(err as Error).message}});
  const np=notifyPrefs(),note=()=>{const st=browserState();$('#browser-note').textContent=!browserSupported()?'This browser cannot show notifications.':st==='denied'?'Notifications are blocked. Allow them from the lock icon in the address bar, then switch this on again.':st==='granted'?'Allowed.':'You will be asked to allow notifications.'};
  $$<HTMLInputElement>('[data-n]').forEach(box=>{const k=box.dataset.n as 'popup'|'voice'|'browser';box.checked=np[k];box.addEventListener('change',async()=>{
    if(k==='browser'&&box.checked){const r=await askBrowserPermission();if(r!=='granted'){box.checked=false;note();toast('Browser notifications were not allowed.',true);return}}
    if(k==='voice')unlockVoice();
    np[k]=box.checked;await saveNotify(np);note();toast('Saved.')})});
  $$<HTMLInputElement>('[data-cat-n]').forEach(box=>{const k=box.dataset.catN as Category;box.checked=np.categories[k];box.addEventListener('change',async()=>{np.categories[k]=box.checked;await saveNotify(np);toast('Saved.')})});
  on('#test-voice',()=>{unlockVoice();speak('Vehicle started')});note();
  document.querySelector('#password')?.addEventListener('submit',async e=>{e.preventDefault();const form=e.target as HTMLFormElement,f=new FormData(form);$('#password-error').textContent='';try{if(f.get('newPassword')!==f.get('confirmPassword'))throw Error('New passwords do not match.');await post('/account/password',{currentPassword:f.get('currentPassword'),newPassword:f.get('newPassword')});form.reset();toast('Password changed.')}catch(err){$('#password-error').textContent=(err as Error).message}});
  on('[data-logout]',logout);icons();
}
function renderMore(){
  const items:[View,string,string,string][]=[['alerts','Alerts','bell',openAlerts()?`${openAlerts()} open`:''],['geofences','Geofences','map-pin',''],['documents','Documents','files',''],['ebills','E-way bills','file-text',''],['settings','Settings','settings','']];
  $('#view').innerHTML=`<div class="page"><div class="card who" style="display:flex;gap:12px;align-items:center"><span class="ico" style="width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:var(--blue);color:#fff">${i('user-round')}</span><div><strong>${esc(prefs().workspace)}</strong><small>${esc(me.email||'')}</small></div></div>
    <div class="card more-list">${items.map(([v,l,ic,note])=>`<button data-go="${v}"><span class="ico">${i(ic)}</span>${l}${note?`<span class="chip bad plain" style="margin-left:auto">${note}</span>`:''}${i('chevron-right')}</button>`).join('')}<button data-logout><span class="ico" style="background:var(--stopped-50);color:var(--stopped)">${i('log-out')}</span>Sign out${i('chevron-right')}</button></div></div>`;
  on('#view [data-go]',el=>go(el.dataset.go as View));on('#view [data-logout]',logout);icons();
}
