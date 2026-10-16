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
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',maxZoom:19}).addTo(map);
  L.control.zoom({position:'bottomright'}).addTo(map);
  // Petrol pumps, dhabas, temples and other landmarks with their names, once zoomed in.
  landmarkLayer(map);
  // Labels thin out as the map zooms out, so the overview never becomes a pile of text.
  const depth=()=>{const z=map.getZoom(),c=map.getContainer().classList;c.toggle('z-wide',z<10);c.toggle('z-far',z<12);c.toggle('z-mid',z<16)};
  map.on('zoomend',depth);depth();
  return map;
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
  const arrow=s==='running'&&p?.heading!=null?`<span class="mk-arrow" style="transform:rotate(${p.heading}deg)"></span>`:'';
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
