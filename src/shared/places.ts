import {coords} from './core';
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
const PLACE_STORE='waypoint.places.v1';
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
async function fromNominatim(lat:number,lon:number):Promise<Place|null>{
  const near=await nominatim(lat,lon,18),a=near.address||{};
  const road=a.road||(near.category==='highway'?(near.name||'Unnamed road'):null);
  let locality=a.neighbourhood||a.suburb||a.quarter||a.village||a.hamlet||a.town||a.city_district||a.city||null;
  // Rural roads often carry no village; ask once more at locality scale.
  if(!locality){const wide=(await nominatim(lat,lon,14)).address||{};locality=wide.village||wide.suburb||wide.town||wide.hamlet||wide.city||null}
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
  if(Date.now()-(placeFailedAt.get(key)||0)<10*60000)return Promise.resolve(null);
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
// Fill every on-screen label waiting for this place; keep the previous text if the lookup failed.
function fillPlaceLabels(key:string){const found=places.get(key);if(found)document.querySelectorAll<HTMLElement>(`[data-place="${key}"]`).forEach(el=>el.textContent=el.dataset.short?shortPlace(found.label):found.label)}

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
  const shown=text?(short?shortPlace(text):text):coords(p);
  return `<span data-place="${key}"${short?' data-short="1"':''}>${shown.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]!))}</span>`;
}
