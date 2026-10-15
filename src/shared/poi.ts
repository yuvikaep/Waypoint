import L from 'leaflet';
import {api} from './core';

// Landmarks around the vehicles (petrol pumps, dhabas, temples, hospitals, tolls...). The server
// fetches them per ~2.8 km tile (TomTom when configured, otherwise OpenStreetMap) and caches them;
// this browser keeps tiles for a week too, and a failing lookup is left alone for a while.
export type Poi={id:string;name:string;kind:Kind;lat:number;lon:number};
type Kind='fuel'|'food'|'worship'|'health'|'police'|'money'|'toll'|'stay'|'school'|'parking'|'bus';
const ICON:Record<Kind,[string,string]>={fuel:['⛽','#e5484d'],food:['🍽','#f76808'],worship:['🛕','#8e4ec6'],health:['✚','#e5484d'],police:['🚓','#0b68cb'],money:['₹','#12a150'],toll:['🛂','#192a51'],stay:['🛏','#0b68cb'],school:['🎓','#6b7590'],parking:['P','#0b68cb'],bus:['🚌','#12a150']};
const LABEL:Record<Kind,string>={fuel:'Petrol pump',food:'Restaurant / dhaba',worship:'Temple / place of worship',health:'Hospital / clinic',police:'Police',money:'Bank / ATM',toll:'Toll',stay:'Hotel',school:'School',parking:'Parking',bus:'Bus stand'};
const ENDPOINT='/landmarks';
const STEP=0.025,WEEK=7*86400000,STORE='waypoint.poi.v2';
const tiles=new Map<string,{at:number;pois:Poi[]}>(),loading=new Map<string,Promise<Poi[]>>();
let pausedUntil=0,chain=Promise.resolve();
try{for(const [k,v] of Object.entries(JSON.parse(localStorage.getItem(STORE)||'{}') as Record<string,{at:number;pois:Poi[]}>))if(Date.now()-v.at<WEEK)tiles.set(k,v)}catch{}
function remember(){try{const keep=[...tiles.entries()].slice(-150);localStorage.setItem(STORE,JSON.stringify(Object.fromEntries(keep)))}catch{}}
const tileKey=(lat:number,lon:number)=>`${Math.floor(lat/STEP)}:${Math.floor(lon/STEP)}`;

async function fetchTile(key:string):Promise<Poi[]>{
  try{
    const r=await api<{pois:Poi[]}>(`${ENDPOINT}?tile=${encodeURIComponent(key)}`);
    const pois=r.pois.map(p=>({...p,name:p.name||LABEL[p.kind]}));
    tiles.set(key,{at:Date.now(),pois});remember();return pois;
  }catch(e){pausedUntil=Date.now()+2*60000;throw e}
}
// One tile at a time, so a map pan does not fire a burst of requests at a shared free service.
function tile(key:string):Promise<Poi[]>{
  const hit=tiles.get(key);if(hit)return Promise.resolve(hit.pois);
  if(Date.now()<pausedUntil)return Promise.resolve([]);
  if(!loading.has(key)){const run=chain.then(()=>fetchTile(key));chain=run.then(()=>{},()=>{});loading.set(key,run.catch(()=>[]).finally(()=>loading.delete(key)))}
  return loading.get(key)!;
}

const metres=(a:{lat:number;lon:number},b:{lat:number;lon:number})=>{const r=Math.PI/180,x=(b.lon-a.lon)*r*Math.cos((a.lat+b.lat)/2*r),y=(b.lat-a.lat)*r;return Math.hypot(x,y)*6371000};
// Nearest landmark within `within` metres, for "Near Indian Oil petrol pump (120 m)".
export async function nearest(lat:number,lon:number,within=1500){
  const keys=new Set<string>();for(const dy of [-1,0,1])for(const dx of [-1,0,1])keys.add(tileKey(lat+dy*STEP*.5,lon+dx*STEP*.5));
  const all=(await Promise.all([...keys].map(tile))).flat();
  let best:{poi:Poi;m:number}|null=null;
  for(const poi of all){const m=metres({lat,lon},poi);if(m<=within&&(!best||m<best.m))best={poi,m}}
  return best&&{...best.poi,metres:Math.round(best.m),label:LABEL[best.poi.kind]};
}
export const nearText=(n:{name:string;label:string;metres:number})=>`${n.metres<60?'At':'Near'} ${n.name===n.label?n.label:`${n.name} (${n.label.toLowerCase()})`}${n.metres<60?'':` · ${n.metres<1000?`${n.metres} m`:`${(n.metres/1000).toFixed(1)} km`}`}`;

const esc=(s:string)=>s.replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);
// Shows landmarks with their names on the map once it is zoomed in far enough to read them.
export function landmarkLayer(map:L.Map,minZoom=14){
  const layer=L.layerGroup().addTo(map),shown=new Set<string>();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const draw=async()=>{
    if(map.getZoom()<minZoom){layer.clearLayers();shown.clear();return}
    const b=map.getBounds(),keys:string[]=[];
    for(let y=Math.floor(b.getSouth()/STEP);y<=Math.floor(b.getNorth()/STEP);y++)for(let x=Math.floor(b.getWest()/STEP);x<=Math.floor(b.getEast()/STEP);x++)keys.push(`${y}:${x}`);
    if(keys.length>16)return;   // too far out to fetch sensibly
    for(const key of keys)void tile(key).then(pois=>{
      const view=map.getBounds().pad(.3);
      for(const p of pois){
        if(shown.has(p.id)||!view.contains([p.lat,p.lon]))continue;
        shown.add(p.id);const [icon,color]=ICON[p.kind];
        L.marker([p.lat,p.lon],{icon:L.divIcon({className:'poi',html:`<span class="poi-dot" style="background:${color}">${icon}</span><span class="poi-name">${esc(p.name)}</span>`,iconSize:[22,22],iconAnchor:[11,11]}),keyboard:false,zIndexOffset:-500})
          .bindTooltip(`${esc(p.name)}<br><small>${LABEL[p.kind]}</small>`).addTo(layer);
      }
    });
  };
  const later=()=>{clearTimeout(timer);timer=setTimeout(draw,600)};
  map.on('moveend zoomend',later);later();
  return layer;
}
