import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {coords,statusOf,type Fix,type Vehicle} from './core';
import {placeText,shortPlace} from './places';

export type Point={latitude:number;longitude:number};
export const point=(p:Point):L.LatLngTuple=>[p.latitude,p.longitude];

export function createMap(el:HTMLElement,center:L.LatLngTuple=[22.5,79],zoom=5){
  const map=L.map(el,{zoomControl:false,attributionControl:true}).setView(center,zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',maxZoom:19}).addTo(map);
  L.control.zoom({position:'bottomright'}).addTo(map);
  return map;
}

// Top-down truck, cab at the top so rotating by GPS course points it the way it is driving.
const TRUCK='<svg class="truck-icon" viewBox="0 0 24 40" aria-hidden="true"><rect x="2.5" y="6" width="2.5" height="4" rx="1"/><rect x="19" y="6" width="2.5" height="4" rx="1"/><rect x="5" y="2" width="14" height="10" rx="3.5"/><rect class="glass" x="7" y="4.2" width="10" height="3.6" rx="1.2"/><rect x="4" y="13.5" width="16" height="24.5" rx="2"/><path class="ribs" d="M7 18h10M7 23h10M7 28h10M7 33h10"/></svg>';
export function truckIcon(v:Vehicle,selected=false){
  return L.divIcon({className:'gps-marker',html:`<div class="gps-pin ${statusOf(v)} ${selected?'on':''}"><span style="transform:rotate(${v.position?.heading||0}deg)">${TRUCK}</span></div>`,iconSize:[40,40],iconAnchor:[20,20]});
}
// Vehicle name and road/area tag that stays readable without zooming in.
export function truckTag(v:Vehicle){
  const tag=document.createElement('span');tag.className='truck-tag';
  const name=document.createElement('strong');name.textContent=v.name;
  const where=document.createElement('small');
  const {key,text}=placeText(v.position!,v.id);
  where.dataset.place=key;where.dataset.short='1';where.textContent=text?shortPlace(text):coords(v.position!);
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
