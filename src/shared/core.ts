import {createIcons,Navigation,Map,Truck,Bus,Car,Bike,Tractor,Construction,Ambulance,Route,Bell,FileText,Files,Settings,LogOut,Search,X,ChevronRight,ChevronLeft,MapPin,Clock,Gauge,KeyRound,Power,Plus,Trash2,Pencil,Users,RadioTower,Server,ShieldCheck,Copy,Share2,Play,Pause,Download,Calendar,ChartColumn,Ellipsis,LocateFixed,Scan,UserRound,ExternalLink,Smartphone,TriangleAlert,Activity,WifiOff,Check,CircleParking,Menu,Save,Timer,Milestone,Battery,Satellite,Eye,RefreshCw,Info,House,Landmark,Siren,OctagonAlert,Layers,History,Mail,MessageSquare,Volume2,BellRing,Languages,SlidersHorizontal,ArrowLeft,LayoutGrid,CheckCheck,LayoutDashboard,Mic,ArrowRight,MoonStar,CircleAlert,UserPlus,Plug,CirclePlay,EllipsisVertical,Zap,ShoppingCart,List,Phone,Lock,LockOpen} from 'lucide';
import {DEMO_MODE,demoRequest} from '../demo';
import {t,locale} from './i18n';
import './theme.css';

export type Fix={id:number;recordedAt:number;latitude:number;longitude:number;speed:number;heading:number|null;ignition:number|null;battery:number|null;satellites:number|null;valid?:number;accuracy?:number|null;receivedAt?:number};
export type Vehicle={id:string;name:string;driver:string;vehicleType?:string|null;makeModel?:string|null;modelYear?:number|null;fuelType?:string|null;capacityKg?:number|null;registration?:string|null;ownerName?:string|null;vehicleNotes?:string|null;status:string;online:boolean;fresh:boolean;lastSeen:number|null;speedLimit:number;speedAlert?:boolean;driverPhone?:string;parkLock?:boolean;parkAlerted?:boolean;signal?:number|null;ignition:number|null;stoppedSince:number|null;position:Fix|null;isMobile?:boolean;model?:string};
export type Fence={id:string;name:string;latitude:number;longitude:number;radius:number;kind?:string};
export type Alert={id:string;deviceId:string;deviceName:string;type:string;message:string;createdAt:number;acknowledged:number};
export type Identity={role:'admin'|'customer';tenantId:string;name:string;email:string|null};

const iconSet={Navigation,Map,Truck,Bus,Car,Bike,Tractor,Construction,Ambulance,Route,Bell,FileText,Files,Settings,LogOut,Search,X,ChevronRight,ChevronLeft,MapPin,Clock,Gauge,KeyRound,Power,Plus,Trash2,Pencil,Users,RadioTower,Server,ShieldCheck,Copy,Share2,Play,Pause,Download,Calendar,ChartColumn,Ellipsis,LocateFixed,Scan,UserRound,ExternalLink,Smartphone,TriangleAlert,Activity,WifiOff,Check,CircleParking,Menu,Save,Timer,Milestone,Battery,Satellite,Eye,RefreshCw,Info,House,Landmark,Siren,OctagonAlert,Layers,History,Mail,MessageSquare,Volume2,BellRing,Languages,SlidersHorizontal,ArrowLeft,LayoutGrid,CheckCheck,LayoutDashboard,Mic,ArrowRight,MoonStar,CircleAlert,UserPlus,Plug,CirclePlay,EllipsisVertical,Zap,ShoppingCart,List,Phone,Lock,LockOpen};
export const i=(name:string)=>`<i data-lucide="${name}"></i>`;
export const icons=()=>createIcons({icons:iconSet});
export const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export const $=<T extends Element=HTMLElement>(selector:string,root:ParentNode=document)=>root.querySelector<T>(selector)!;
export const $$=<T extends Element=HTMLElement>(selector:string,root:ParentNode=document)=>[...root.querySelectorAll<T>(selector)];
export const brand=(href='/?live=1')=>`<a class="brand" href="${href}"><span class="mark">${i('navigation')}</span>waypoint</a>`;

// Session expiry is handled by whichever screen is showing (login is re-rendered).
let onUnauthorized=()=>{};
export function whenUnauthorized(callback:()=>void){onUnauthorized=callback}
const noRedirect=['/session','/customers/session','/customers/register','/admin/session','/admin/reset-password','/account/password'];
export async function api<T=any>(path:string,options:RequestInit={}):Promise<T>{
  if(DEMO_MODE)return demoRequest(path,options);
  const response=await fetch('/api/gps'+path,{...options,headers:{'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(20000)});
  const body=await response.json().catch(()=>({error:'Tracking service is temporarily unavailable. Please try again shortly.'}));
  if(!response.ok){if(response.status===401&&!path.startsWith('/sender/')&&!noRedirect.includes(path))onUnauthorized();throw new Error(body.error||'Request failed.');}
  return body;
}
export const post=<T=any>(path:string,body:unknown={},method='POST')=>api<T>(path,{method,body:JSON.stringify(body)});

let toastTimer:ReturnType<typeof setTimeout>|undefined;
export function toast(message:string,error=false){
  let el=document.querySelector<HTMLElement>('.toast');
  if(!el){el=document.createElement('div');el.className='toast';el.setAttribute('role','status');document.body.append(el)}
  el.textContent=message;el.classList.toggle('error',error);el.hidden=false;
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>{if(el)el.hidden=true},4500);
}
// Runs a click handler and reports failures instead of leaving the UI silent.
export function on(selector:string,handler:(el:HTMLElement)=>void|Promise<void>,root:ParentNode=document){
  $$(selector,root).forEach(el=>el.addEventListener('click',()=>{Promise.resolve().then(()=>handler(el)).catch(e=>toast((e as Error).message,true))}));
}

export function modal(title:string,body:string,{wide=false}={}){
  let dialog=document.querySelector<HTMLDialogElement>('dialog.modal');
  if(!dialog){dialog=document.createElement('dialog');dialog.className='modal';document.body.append(dialog)}
  if(dialog.open)dialog.close();
  dialog.classList.toggle('wide',wide);
  dialog.innerHTML=`<div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">${i('x')}</button></div><div class="modal-body">${body}</div>`;
  dialog.showModal();on('[data-close]',closeModal,dialog);icons();
  return dialog;
}
export function closeModal(){document.querySelector<HTMLDialogElement>('dialog.modal')?.close()}
export function showSecret(email:string,password:string,note='Share it privately. It is shown only now.'){
  return `<div class="secret"><span class="small muted">Login: <b>${esc(email)}</b></span><code>${esc(password)}</code><button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(password)}">${i('copy')}Copy password</button><span class="hint">${esc(note)}</span></div>`;
}
export function wireCopy(root:ParentNode=document){on('[data-copy]',async el=>{await navigator.clipboard.writeText(el.dataset.copy!);toast('Copied.')},root)}

// Formatting. The app is used in India, so every time is shown in IST whatever the phone's own zone.
export const IST='Asia/Kolkata',IST_OFFSET=-330;
const IST_MS=19800000;
export const time=(at:number|null)=>at?new Date(at).toLocaleString(locale(),{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',timeZone:IST}):t('Never');
export const clock=(at:number|null)=>at?new Date(at).toLocaleTimeString(locale(),{hour:'2-digit',minute:'2-digit',timeZone:IST}):'—';
// Midnight IST, offset by whole days.
export const istDayStart=(offset=0,at=Date.now())=>new Date(Math.floor((at+IST_MS)/86400000+offset)*86400000-IST_MS);
export function ago(at:number|null){if(!at)return t('Never');const s=Math.max(0,Math.floor((Date.now()-at)/1000));return s<60?t('Just now'):s<3600?t('{n} min ago',{n:Math.floor(s/60)}):s<86400?t('{n} h ago',{n:Math.floor(s/3600)}):t('{n} d ago',{n:Math.floor(s/86400)})}
export function since(from:number){const m=Math.max(0,Math.floor((Date.now()-from)/60000));return m<60?t('{m} min',{m}):m<1440?t('{h} h {m} min',{h:Math.floor(m/60),m:m%60}):t('{d} d {h} h',{d:Math.floor(m/1440),h:Math.floor(m%1440/60)})}
export const hm=(minutes:number)=>minutes<60?t('{m} min',{m:minutes}):t('{h} h {m} min',{h:Math.floor(minutes/60),m:String(minutes%60).padStart(2,'0')});
export const coords=(p:{latitude:number;longitude:number})=>`${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`;
export const mapsLink=(p:{latitude:number;longitude:number})=>`https://www.google.com/maps?q=${p.latitude},${p.longitude}`;
// datetime-local fields hold IST wall time.
export const localInput=(date:Date)=>new Date(date.getTime()+IST_MS).toISOString().slice(0,16);
export const fromLocalInput=(value:string)=>new Date(`${value}:00+05:30`);
// A parked hardware tracker sends a heartbeat every minute from where it stands, so while it is
// online and parked its location counts as updated at the latest heartbeat.
export const updatedAt=(v:Vehicle)=>{const p=v.position;if(!p)return v.lastSeen;return !v.isMobile&&v.model!=='Mobile'&&v.online&&v.status==='Stopped'&&v.lastSeen?Math.max(p.recordedAt,v.lastSeen):p.recordedAt};

// One status vocabulary for chips, markers and filters, in the way Indian fleet apps show it.
export type StatusKey='running'|'idle'|'stopped'|'offline'|'nofix'|'waiting';
export const STATUS_LABEL:Record<StatusKey,string>={running:'Running',idle:'Idle',stopped:'Stopped',offline:'Offline',nofix:'No GPS',waiting:'Not installed'};
export function statusOf(v:Vehicle):StatusKey{
  if(v.status==='Moving')return 'running';
  if(v.status==='Stopped')return v.ignition===1?'idle':'stopped';
  if(v.status==='Offline')return 'offline';
  if(v.status==='Waiting')return 'waiting';
  return 'nofix';
}
export const statusLabel=(s:StatusKey)=>t(STATUS_LABEL[s]);
export const chip=(v:Vehicle)=>{const s=statusOf(v),p=v.position;return `<span class="chip ${s}">${statusLabel(s)}${s==='running'&&p?` · ${Math.round(p.speed)} km/h`:''}</span>`};
export function statusLine(v:Vehicle){
  const s=statusOf(v),p=v.position;
  if(s==='running'&&p)return t('Running at {n} km/h',{n:Math.round(p.speed)});
  if((s==='stopped'||s==='idle')&&v.stoppedSince)return t(s==='idle'?'Engine on, standing for {d} · since {c}':'Parked for {d} · since {c}',{d:since(v.stoppedSince),c:clock(v.stoppedSince)});
  if(s==='offline')return t('No signal since {t}',{t:time(v.lastSeen)});
  if(s==='waiting')return t('Waiting for the first signal from this vehicle');
  if(s==='nofix')return p?t('GPS signal weak · showing last known place'):t('Waiting for GPS location');
  return '';
}

// What the vehicle is, as chosen when it was onboarded. The icon is what people recognise on a card.
export const VEHICLE_TYPES:Record<string,[string,string]>={truck:['Truck','truck'],trailer:['Trailer','truck'],tipper:['Tipper','truck'],tanker:['Tanker','truck'],bus:['Bus','bus'],van:['Tempo / Van','truck'],pickup:['Pickup','truck'],car:['Car','car'],auto:['Auto','car'],bike:['Bike','bike'],tractor:['Tractor','tractor'],jcb:['JCB','construction'],ambulance:['Ambulance','ambulance'],other:['Vehicle','truck']};
export const FUEL_TYPES:Record<string,string>={diesel:'Diesel',petrol:'Petrol',cng:'CNG',lpg:'LPG',electric:'Electric',hybrid:'Hybrid'};
export const vehicleKind=(v:Vehicle)=>VEHICLE_TYPES[v.vehicleType||'']||null;
// "Truck · Tata 1109g" — what the plate alone does not say.
export const vehicleLine=(v:Vehicle)=>[vehicleKind(v)?.[0],v.makeModel,v.capacityKg?`${v.capacityKg>=1000&&v.capacityKg%100===0?`${v.capacityKg/1000} T`:`${v.capacityKg} kg`}`:''].filter(Boolean).join(' · ');
