import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {coords,esc,since,statusOf,type Fix,type Vehicle} from './core';
import {t} from './i18n';
import {placeText,shortPlace,placeFallback} from './places';
import {landmarkLayer} from './poi';

export type Point={latitude:number;longitude:number};
export const point=(p:Point):L.LatLngTuple=>[p.latitude,p.longitude];

export function createMap(el:HTMLElement,center:L.LatLngTuple=[22.5,79],zoom=5){
  const map=L.map(el,{zoomControl:false,attributionControl:true}).setView(center,zoom);
  const raster=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',maxZoom:19}).addTo(map);
  void cleanStyle(map,raster);
  L.control.zoom({position:'bottomright'}).addTo(map);
  // Petrol pumps, dhabas, temples and other landmarks with their names, once zoomed in.
  landmarkLayer(map);
  // Labels thin out as the map zooms out, so the overview never becomes a pile of text.
  const depth=()=>{const z=map.getZoom(),c=map.getContainer().classList;c.toggle('z-wide',z<10);c.toggle('z-far',z<12);c.toggle('z-mid',z<16)};
  map.on('zoomend',depth);depth();
  return map;
}

// The clean, Google-like OpenFreeMap style (free, no key, no limits). The plain OSM tiles show
// first; the vector style replaces them once MapLibre has loaded, and stays off without WebGL.
const STYLE='https://tiles.openfreemap.org/styles/liberty';
let styleBroken=false;
function webgl(){try{const c=document.createElement('canvas');return !!(c.getContext('webgl2')||c.getContext('webgl'))}catch{return false}}
async function cleanStyle(map:L.Map,raster:L.TileLayer){
  if(styleBroken||!webgl())return;
  try{
    const [{default:maplibregl}]=await Promise.all([import('maplibre-gl'),import('maplibre-gl/dist/maplibre-gl.css')]);
    (globalThis as unknown as {maplibregl:unknown}).maplibregl=maplibregl;
    await import('@maplibre/maplibre-gl-leaflet');
    if(!(map as unknown as {_loaded?:boolean})._loaded&&!map.getContainer().isConnected)return;
    const gl=(L as unknown as {maplibreGL:(o:object)=>L.Layer&{getMaplibreMap():import('maplibre-gl').Map}}).maplibreGL({style:STYLE,attribution:'<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'});
    gl.addTo(map);
    const m=gl.getMaplibreMap();
    const fail=()=>{styleBroken=true;if(map.hasLayer(gl))map.removeLayer(gl);if(!map.hasLayer(raster))raster.addTo(map)};
    const timer=setTimeout(fail,12000);
    m.once('error',()=>{if(!m.isStyleLoaded()){clearTimeout(timer);fail()}});
    m.once('load',()=>{
      clearTimeout(timer);
      // Indian place names are often only in Devanagari; prefer the English / Latin name.
      for(const layer of m.getStyle().layers||[])if(layer.type==='symbol'&&m.getLayoutProperty(layer.id,'text-field')!=null)
        try{m.setLayoutProperty(layer.id,'text-field',['coalesce',['get','name:en'],['get','name:latin'],['get','name']])}catch{/* keep the style's own label */}
      map.removeLayer(raster);
    });
  }catch{styleBroken=true}
}

// Smooth truck movement: slide a marker to its new point over about two seconds instead of jumping.
// Big steps (late or backlog fixes), old fixes and a hidden page snap straight to the point.
type Glide={frame:number;at:number};
const glides=new WeakMap<L.Marker,Glide>();
export function glide(marker:L.Marker,to:L.LatLngTuple,recordedAt:number,{ms=1800,onStep}:{ms?:number;onStep?:(p:L.LatLng)=>void}={}){
  const last=glides.get(marker),from=marker.getLatLng(),target=L.latLng(to);
  if(last&&recordedAt<last.at)return;
  if(last)cancelAnimationFrame(last.frame);
  const far=from.distanceTo(target)>2000||(last&&recordedAt-last.at>120000)||document.hidden||!last;
  if(far||from.equals(target)){marker.setLatLng(target);onStep?.(target);glides.set(marker,{frame:0,at:recordedAt});return}
  const start=performance.now();
  const step=(now:number)=>{
    const k=Math.min(1,(now-start)/ms),e=1-(1-k)**3;
    const p=L.latLng(from.lat+(target.lat-from.lat)*e,from.lng+(target.lng-from.lng)*e);
    marker.setLatLng(p);onStep?.(p);
    if(k<1)glides.set(marker,{frame:requestAnimationFrame(step),at:recordedAt});
  };
  glides.set(marker,{frame:requestAnimationFrame(step),at:recordedAt});
}
// Heading that turns the short way round (350° → 10° turns 20°, not 340°), for CSS transitions.
const headings=new Map<string,number>();
export function smoothHeading(id:string,deg:number){
  const prev=headings.get(id);let next=deg;
  if(prev!=null){next=prev+((((deg-prev)%360)+540)%360-180)}
  headings.set(id,next);return next;
}

// Top-down truck, cab at the top so rotating by GPS course points it the way it is driving.
export const TRUCK='<svg class="truck-icon" viewBox="0 0 24 40" aria-hidden="true"><rect x="2.5" y="6" width="2.5" height="4" rx="1"/><rect x="19" y="6" width="2.5" height="4" rx="1"/><rect x="5" y="2" width="14" height="10" rx="3.5"/><rect class="glass" x="7" y="4.2" width="10" height="3.6" rx="1.2"/><rect x="4" y="13.5" width="16" height="24.5" rx="2"/><path class="ribs" d="M7 18h10M7 23h10M7 28h10M7 33h10"/></svg>';
export function truckIcon(v:Vehicle,selected=false){
  return L.divIcon({className:'gps-marker',html:`<div class="gps-pin ${statusOf(v)} ${selected?'on':''}"><span style="transform:rotate(${v.position?.heading||0}deg)">${TRUCK}</span></div>`,iconSize:[40,40],iconAnchor:[20,20]});
}
// Fleet marker: a round status badge with a truck, an arrow for the direction it is heading, a
// bubble with speed or how long it has stood, and the number plate underneath.
const TRUCK_GLYPH='<svg class="mk-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>';
export function markerHtml(v:Vehicle,selected:boolean,labels:boolean){
  const s=statusOf(v),p=v.position,over=s==='running'&&!!p&&p.speed>v.speedLimit;
  const bubble=!labels?'':s==='running'&&p?`<span class="mk-bubble ${over?'over':'running'}">${over?'⚠ ':'● '}${Math.round(p.speed)} km/h</span>`:(s==='stopped'||s==='idle')&&v.stoppedSince?`<span class="mk-bubble ${s}">${esc(t(s==='idle'?'Idle':'Engine off'))} · ${esc(since(v.stoppedSince))}</span>`:'';
  const arrow=s==='running'&&p?.heading!=null?`<span class="mk-arrow" style="transform:rotate(${smoothHeading(v.id,p.heading)}deg)"></span>`:'';
  return `<div class="mk ${s} ${selected?'on':''} ${over?'over':''}">${bubble}<span class="mk-dot">${arrow}${TRUCK_GLYPH}</span>${labels?`<span class="mk-plate">${esc(v.name)}</span>`:''}</div>`;
}
export const fleetIcon=(v:Vehicle,selected:boolean,labels:boolean)=>L.divIcon({className:'gps-marker',html:markerHtml(v,selected,labels),iconSize:[40,40],iconAnchor:[20,20]});
// Route playback truck: green while moving, red when standing, pointing the way it travels.
export function playbackIcon(heading:number,moving:boolean){
  return L.divIcon({className:'gps-marker playback',html:`<div class="gps-pin on ${moving?'running':'stopped'}"><span style="transform:rotate(${heading}deg)">${TRUCK}</span></div>`,iconSize:[40,40],iconAnchor:[20,20]});
}
// Compass bearing from a to b, for fixes that carry no course.
export function bearing(a:Point,b:Point){
  const r=Math.PI/180,y=Math.sin((b.longitude-a.longitude)*r)*Math.cos(b.latitude*r);
  const x=Math.cos(a.latitude*r)*Math.sin(b.latitude*r)-Math.sin(a.latitude*r)*Math.cos(b.latitude*r)*Math.cos((b.longitude-a.longitude)*r);
  return (Math.atan2(y,x)/r+360)%360;
}
// Vehicle name and road/area tag that stays readable without zooming in.
// With place: the selected vehicle. Without: just the number plate, so a full map stays readable.
export function truckTag(v:Vehicle,withPlace=true){
  const tag=document.createElement('span');tag.className='truck-tag';
  const name=document.createElement('strong');name.textContent=v.name;
  if(!withPlace){tag.append(name);return tag}
  const where=document.createElement('small');
  const {key,text}=placeText(v.position!,v.id);
  where.dataset.place=key;where.dataset.short='1';where.textContent=text?shortPlace(text):placeFallback(v.position!);
  tag.append(name,where);return tag;
}

// Break tracks across gaps rather than drawing a claimed continuous journey.
export function drawRoute(layer:L.LayerGroup,history:Fix[]){
  const segments:Fix[][]=[[]];
  for(const p of history){const s=segments.at(-1)!;if(s.length&&p.recordedAt-s.at(-1)!.recordedAt>15*60000)segments.push([]);segments.at(-1)!.push(p)}
  for(const s of segments){
    if(s.length>1){L.polyline(s.map(point),{color:'#ffffff',weight:8,opacity:.9}).addTo(layer);L.polyline(s.map(point),{color:'#1990ff',weight:5}).addTo(layer)}
    else if(s.length)L.circleMarker(point(s[0]),{radius:4,color:'#1990ff'}).addTo(layer);
  }
  if(history.length){
    L.circleMarker(point(history[0]),{radius:7,color:'#fff',weight:3,fillColor:'#12a150',fillOpacity:1}).bindTooltip('Start').addTo(layer);
    L.circleMarker(point(history.at(-1)!),{radius:7,color:'#fff',weight:3,fillColor:'#e5484d',fillOpacity:1}).bindTooltip('End').addTo(layer);
  }
}
export {L};
