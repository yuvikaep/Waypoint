import L from 'leaflet';

// Landmarks around the vehicles (petrol pumps, dhabas, temples, hospitals, tolls...) from
// OpenStreetMap through the free Overpass service. Coverage is only as good as OpenStreetMap's in
// that area. Lookups are made per ~2.5 km tile, cached for a week in this browser, and a refused
// or failing service is left alone for a while instead of being retried in a loop.
export type Poi={id:string;name:string;kind:Kind;lat:number;lon:number};
type Kind='fuel'|'food'|'worship'|'health'|'police'|'money'|'toll'|'stay'|'school'|'parking'|'bus';
const ICON:Record<Kind,[string,string]>={fuel:['⛽','#e5484d'],food:['🍽','#f76808'],worship:['🛕','#8e4ec6'],health:['✚','#e5484d'],police:['🚓','#0b68cb'],money:['₹','#12a150'],toll:['🛂','#192a51'],stay:['🛏','#0b68cb'],school:['🎓','#6b7590'],parking:['P','#0b68cb'],bus:['🚌','#12a150']};
const LABEL:Record<Kind,string>={fuel:'Petrol pump',food:'Restaurant / dhaba',worship:'Temple / place of worship',health:'Hospital / clinic',police:'Police',money:'Bank / ATM',toll:'Toll',stay:'Hotel',school:'School',parking:'Parking',bus:'Bus stand'};
function kindOf(t:Record<string,string>):Kind|null{
  const a=t.amenity;
  if(a==='fuel')return 'fuel';
  if(a==='restaurant'||a==='fast_food'||a==='cafe'||a==='food_court')return 'food';
  if(a==='place_of_worship')return 'worship';
  if(a==='hospital'||a==='clinic'||a==='doctors'||a==='pharmacy')return 'health';
  if(a==='police')return 'police';
  if(a==='bank'||a==='atm')return 'money';
  if(a==='school'||a==='college'||a==='university')return 'school';
  if(a==='parking'||a==='truck_parking')return 'parking';
  if(a==='bus_station'||t.highway==='bus_stop')return 'bus';
  if(t.barrier==='toll_booth')return 'toll';
  if(t.tourism==='hotel'||t.tourism==='motel'||t.tourism==='guest_house')return 'stay';
  return null;
}
const ENDPOINTS=['https://overpass-api.de/api/interpreter','https://maps.mail.ru/osm/tools/overpass/api/interpreter','https://overpass.private.coffee/api/interpreter'];
const STEP=0.025,WEEK=7*86400000,STORE='waypoint.poi.v1';
const tiles=new Map<string,{at:number;pois:Poi[]}>(),loading=new Map<string,Promise<Poi[]>>();
let pausedUntil=0,chain=Promise.resolve();
try{for(const [k,v] of Object.entries(JSON.parse(localStorage.getItem(STORE)||'{}') as Record<string,{at:number;pois:Poi[]}>))if(Date.now()-v.at<WEEK)tiles.set(k,v)}catch{}
function remember(){try{const keep=[...tiles.entries()].slice(-150);localStorage.setItem(STORE,JSON.stringify(Object.fromEntries(keep)))}catch{}}
const tileKey=(lat:number,lon:number)=>`${Math.floor(lat/STEP)}:${Math.floor(lon/STEP)}`;

async function fetchTile(key:string):Promise<Poi[]>{
  const [y,x]=key.split(':').map(Number),s=y*STEP,w=x*STEP,bbox=`${s.toFixed(4)},${w.toFixed(4)},${(s+STEP).toFixed(4)},${(w+STEP).toFixed(4)}`;
  const q=`[out:json][timeout:20];(nwr["amenity"~"^(fuel|restaurant|fast_food|cafe|food_court|place_of_worship|hospital|clinic|doctors|pharmacy|police|bank|atm|school|college|university|parking|truck_parking|bus_station)$"](${bbox});node["barrier"="toll_booth"](${bbox});nwr["tourism"~"^(hotel|motel|guest_house)$"](${bbox}););out center 400;`;
  for(const url of ENDPOINTS){
    try{
      const r=await fetch(url,{method:'POST',body:new URLSearchParams({data:q}),signal:AbortSignal.timeout(25000)});
      if(!r.ok)continue;
      const data=await r.json() as {elements:{type:string;id:number;lat?:number;lon?:number;center?:{lat:number;lon:number};tags?:Record<string,string>}[]};
      const pois:Poi[]=[];
      for(const e of data.elements){
        const t=e.tags||{},kind=kindOf(t),lat=e.lat??e.center?.lat,lon=e.lon??e.center?.lon;
        if(!kind||lat==null||lon==null)continue;
        pois.push({id:`${e.type}${e.id}`,kind,lat,lon,name:t['name:en']||t.name||t.brand||t.operator||LABEL[kind]});
      }
      tiles.set(key,{at:Date.now(),pois});remember();return pois;
    }catch{/* try the next mirror */}
  }
  pausedUntil=Date.now()+5*60000;
  throw new Error('Landmarks unavailable');
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
