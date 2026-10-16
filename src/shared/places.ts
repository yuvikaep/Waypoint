
import {t} from './i18n';

// Place names come from OpenStreetMap: Nominatim gives the road; Photon (komoot) is the fallback
// and gives the nearest named place. Both are free shared services, so every lookup is cached per
// ~11 m cell (also in this browser), serialised at one per second, and failures are never retried
// in a loop: a failed cell waits 10 minutes and a refused Nominatim (403/429) is skipped for 30.
type Place={label:string;road:string|null};
type Point={latitude:number;longitude:number};
export const places=new globalThis.Map<string,Place>();
const placeWaiters=new globalThis.Map<string,Promise<Place|null>>(),placeFailedAt=new globalThis.Map<string,number>();
let placeChain=Promise.resolve(),nominatimPausedUntil=0;
export const placeKey=(p:Point)=>`${p.latitude.toFixed(4)},${p.longitude.toFixed(4)}`;
// v2: unnamed roads are described from the nearest named place, so v1 labels are looked up again.
const PLACE_STORE='waypoint.places.v2';
try{localStorage.removeItem('waypoint.places.v1')}catch{}
try{for(const [k,v] of Object.entries(JSON.parse(localStorage.getItem(PLACE_STORE)||'{}') as Record<string,Place>))places.set(k,v)}catch{}
function rememberPlace(key:string,value:Place){try{const saved=JSON.parse(localStorage.getItem(PLACE_STORE)||'{}') as Record<string,Place>;saved[key]=value;const keys=Object.keys(saved);for(const old of keys.slice(0,Math.max(0,keys.length-500)))delete saved[old];localStorage.setItem(PLACE_STORE,JSON.stringify(saved))}catch{}}
function paced<T>(task:()=>Promise<T>):Promise<T>{const run=placeChain.then(task);placeChain=run.then(()=>new Promise(r=>setTimeout(r,1100)),()=>new Promise(r=>setTimeout(r,1100)));return run}
const query=(lat:number,lon:number,extra:Record<string,string>)=>new URLSearchParams({lat:String(lat),lon:String(lon),...extra});
async function nominatim(lat:number,lon:number,zoom:number){
  return paced(async()=>{
    // Re-check inside the queue: lookups queued before a refusal must not keep hitting Nominatim.
    if(Date.now()<nominatimPausedUntil)throw new Error('Place lookup paused');
    // A refused request arrives without CORS headers, so it surfaces as a network error, not a status.
    const response=await fetch(`https://nominatim.openstreetmap.org/reverse?${query(lat,lon,{format:'jsonv2',zoom:String(zoom),addressdetails:'1','accept-language':'en'})}`).catch(()=>null);
    if(!response?.ok){if(!response||response.status===403||response.status===429)nominatimPausedUntil=Date.now()+30*60000;throw new Error('Place lookup unavailable')}
    return response.json() as Promise<{name?:string;category?:string;address?:Record<string,string>}>;
  });
}
// Many village roads in India have no name in OpenStreetMap. Instead of "Unnamed road", say where
// the vehicle is from the nearest named place: a landmark close by, otherwise the village centre.
const DIRS=['north','north-east','east','south-east','south','south-west','west','north-west'];
function fromHere(lat:number,lon:number,pLat:number,pLon:number){
  const R=6371000,toR=Math.PI/180,dLat=(pLat-lat)*toR,dLon=(pLon-lon)*toR;
  const h=Math.sin(dLat/2)**2+Math.cos(lat*toR)*Math.cos(pLat*toR)*Math.sin(dLon/2)**2,m=2*R*Math.asin(Math.sqrt(h));
  const y=Math.sin(-dLon)*Math.cos(lat*toR),x=Math.cos(pLat*toR)*Math.sin(lat*toR)-Math.sin(pLat*toR)*Math.cos(lat*toR)*Math.cos(-dLon);
  const bearing=(Math.atan2(y,x)/toR+360)%360;
  return {m,dir:DIRS[Math.round(bearing/45)%8]};
}
const AREA=new Set(['village','hamlet','suburb','town','city','neighbourhood','locality','quarter','isolated_dwelling']);
async function nearbyName(lat:number,lon:number):Promise<string|null>{
  const response=await paced(()=>fetch(`https://photon.komoot.io/reverse?${query(lat,lon,{lang:'en',limit:'10',radius:'3'})}`));
  if(!response.ok)return null;
  const features=((await response.json()) as {features?:{properties:Record<string,string>;geometry:{coordinates:[number,number]}}[]}).features||[];
  const named=features.filter(f=>f.properties.name&&f.properties.osm_value!=='postcode'&&!/^\d{6}$/.test(f.properties.name)&&f.properties.osm_key!=='highway')
    .map(f=>({name:f.properties.name,area:f.properties.osm_key==='place'&&AREA.has(f.properties.osm_value),...fromHere(lat,lon,f.geometry.coordinates[1],f.geometry.coordinates[0])}))
    .filter(f=>f.m<=3000).sort((a,b)=>a.m-b.m);
  const pick=named.find(f=>!f.area&&f.m<=300)||named.find(f=>f.area)||named[0];
  if(!pick)return null;
  if(pick.m<60)return t('At {p}',{p:pick.name});
  const d=pick.m<1000?`${Math.round(pick.m/10)*10} m`:`${(pick.m/1000).toFixed(1)} km`;
  return t('{d} {dir} of {p}',{d,dir:t(pick.dir),p:pick.name});
}
async function fromNominatim(lat:number,lon:number):Promise<Place|null>{
  const near=await nominatim(lat,lon,18),a=near.address||{};
  const unnamed=!a.road&&near.category==='highway'&&!near.name;
  const road=a.road||(near.category==='highway'&&near.name?near.name:null)||(unnamed?await nearbyName(lat,lon).catch(()=>null)||t('Unnamed road'):null);
  let locality=a.neighbourhood||a.suburb||a.quarter||a.village||a.hamlet||a.town||a.city_district||a.city||null;
  // Rural roads often carry no village; ask once more at locality scale.
  if(!locality){const wide=(await nominatim(lat,lon,14)).address||{};locality=wide.village||wide.suburb||wide.town||wide.hamlet||wide.city||null}
  // "780 m west of Rajatalab" already names the village, so it is not repeated after it.
  if(unnamed&&locality&&road?.includes(locality))locality=null;
  const parts=[road,near.category!=='highway'&&near.name?near.name:null,locality,a.town||a.city||a.state_district||a.county,a.state,a.postcode].filter((v,i,all):v is string=>!!v&&all.indexOf(v)===i);
  return parts.length?{label:parts.join(', '),road}:null;
}
async function fromPhoton(lat:number,lon:number):Promise<Place|null>{
  const response=await paced(()=>fetch(`https://photon.komoot.io/reverse?${query(lat,lon,{lang:'en',limit:'1'})}`));
  if(!response.ok)throw new Error('Place lookup unavailable');
  const f=((await response.json()) as {features?:{properties:Record<string,string>}[]}).features?.[0]?.properties;
  if(!f)return null;
  const road=f.street||(f.osm_key==='highway'?f.name:null)||null;
  // Photon may name a postcode area after its PIN; that is not a place to be 'near'.
  const isPin=f.osm_value==='postcode'||f.type==='postcode'||/^\d{6}$/.test(f.name||'');
  const named=f.name&&!isPin?f.name:null;
  const parts=[road,!road&&named?`near ${named}`:null,f.district||f.locality,f.city,f.county,f.state,f.postcode||(isPin?f.name:null)].filter((v,i,all):v is string=>!!v&&all.indexOf(v)===i);
  return parts.length?{label:parts.join(', '),road}:null;
}
export function place(p:Point):Promise<Place|null>{
  const key=placeKey(p);
  if(places.has(key))return Promise.resolve(places.get(key)!);
  if(Date.now()-(placeFailedAt.get(key)||0)<3*60000)return Promise.resolve(null);
  if(!placeWaiters.has(key))placeWaiters.set(key,(async()=>{
    try{
      let value:Place|null=null;
      if(Date.now()>=nominatimPausedUntil)value=await fromNominatim(p.latitude,p.longitude).catch(()=>null);
      value??=await fromPhoton(p.latitude,p.longitude);
      if(value){places.set(key,value);rememberPlace(key,value)}else placeFailedAt.set(key,Date.now());
      return value;
    }catch{placeFailedAt.set(key,Date.now());return null}finally{placeWaiters.delete(key);fillPlaceLabels(key)}
  })());
  return placeWaiters.get(key)!;
}
export const shortPlace=(label:string)=>label.split(', ').slice(0,2).join(', ');
// Never show raw coordinates as a place: while the name loads (or if the lookup failed) use the
// nearest place already known within 500 m, else a short note. The name replaces it when it arrives.
export function placeFallback(p:Point){
  let best:{label:string;m:number}|null=null;
  for(const [k,v] of places){const [la,lo]=k.split(',').map(Number),dLat=(la-p.latitude)*111320,dLon=(lo-p.longitude)*111320*Math.cos(p.latitude*Math.PI/180),m=Math.hypot(dLat,dLon);if(m<=500&&(!best||m<best.m))best={label:v.label,m}}
  return best?(best.m<30?best.label:t('Near {p}',{p:shortPlace(best.label)})):t('Finding place name…');
}
// Fill every on-screen label waiting for this place; keep the previous text if the lookup failed.
function fillPlaceLabels(key:string){const found=places.get(key);document.querySelectorAll<HTMLElement>(`[data-place="${key}"]`).forEach(el=>{if(found)el.textContent=el.dataset.short?shortPlace(found.label):found.label;else if(el.textContent===t('Finding place name…'))el.textContent=t('Place name not available yet')})}

// Text for a place label right now, starting a lookup when needed. Each vehicle is looked up at most
// every 30 s so moving trucks don't flood the shared geocoder; the last known name is shown meanwhile.
const askedAt=new globalThis.Map<string,number>(),lastLabel=new globalThis.Map<string,string>();
export function placeText(p:Point,owner:string,lookup=true){
  const key=placeKey(p),known=places.get(key);
  if(known){lastLabel.set(owner,known.label);return {key,text:known.label}}
  if(lookup&&Date.now()-(askedAt.get(owner)||0)>30000){askedAt.set(owner,Date.now());void place(p).then(found=>{if(found)lastLabel.set(owner,found.label)})}
  return {key,text:lastLabel.get(owner)||''};
}
// Markup for a label that fills itself when the name arrives.
export function placeSpan(p:Point|null,owner:string,{short=false,lookup=true}={}){
  if(!p)return `<span>${t('No location yet')}</span>`;
  const {key,text}=placeText(p,owner,lookup);
  const shown=text?(short?shortPlace(text):text):placeFallback(p);
  return `<span data-place="${key}"${short?' data-short="1"':''}>${shown.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]!))}</span>`;
}
