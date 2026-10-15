import {createIcons,Navigation,Map,Truck,Route,Bell,FileText,Files,Settings,LogOut,Search,X,ChevronRight,ChevronLeft,MapPin,Clock,Gauge,KeyRound,Power,Plus,Trash2,Pencil,Users,RadioTower,Server,ShieldCheck,Copy,Share2,Play,Pause,Download,Calendar,ChartColumn,Ellipsis,LocateFixed,Scan,UserRound,ExternalLink,Smartphone,TriangleAlert,Activity,WifiOff,Check,CircleParking,Menu,Save,Timer,Milestone,Battery,Satellite,Eye,RefreshCw,Info,House} from 'lucide';
import {DEMO_MODE,demoRequest} from '../demo';
import './theme.css';

export type Fix={id:number;recordedAt:number;latitude:number;longitude:number;speed:number;heading:number|null;ignition:number|null;battery:number|null;satellites:number|null;valid?:number;accuracy?:number|null;receivedAt?:number};
export type Vehicle={id:string;name:string;driver:string;status:string;online:boolean;fresh:boolean;lastSeen:number|null;speedLimit:number;ignition:number|null;stoppedSince:number|null;position:Fix|null;isMobile?:boolean;model?:string};
export type Fence={id:string;name:string;latitude:number;longitude:number;radius:number};
export type Alert={id:string;deviceId:string;deviceName:string;type:string;message:string;createdAt:number;acknowledged:number};
export type Identity={role:'admin'|'customer';tenantId:string;name:string;email:string|null};

const iconSet={Navigation,Map,Truck,Route,Bell,FileText,Files,Settings,LogOut,Search,X,ChevronRight,ChevronLeft,MapPin,Clock,Gauge,KeyRound,Power,Plus,Trash2,Pencil,Users,RadioTower,Server,ShieldCheck,Copy,Share2,Play,Pause,Download,Calendar,ChartColumn,Ellipsis,LocateFixed,Scan,UserRound,ExternalLink,Smartphone,TriangleAlert,Activity,WifiOff,Check,CircleParking,Menu,Save,Timer,Milestone,Battery,Satellite,Eye,RefreshCw,Info,House};
export const i=(name:string)=>`<i data-lucide="${name}"></i>`;
export const icons=()=>createIcons({icons:iconSet});
export const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export const $=<T extends Element=HTMLElement>(selector:string,root:ParentNode=document)=>root.querySelector<T>(selector)!;
export const $$=<T extends Element=HTMLElement>(selector:string,root:ParentNode=document)=>[...root.querySelectorAll<T>(selector)];
export const brand=(href='/?live=1')=>`<a class="brand" href="${href}"><span class="mark">${i('navigation')}</span>waypoint</a>`;

// Session expiry is handled by whichever screen is showing (login is re-rendered).
let onUnauthorized=()=>{};
export function whenUnauthorized(callback:()=>void){onUnauthorized=callback}
const noRedirect=['/session','/customers/session','/customers/register','/admin/session','/account/password'];
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

// Formatting
export const time=(at:number|null)=>at?new Date(at).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'Never';
export const clock=(at:number|null)=>at?new Date(at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}):'—';
export function ago(at:number|null){if(!at)return 'Never';const s=Math.max(0,Math.floor((Date.now()-at)/1000));return s<60?'Just now':s<3600?`${Math.floor(s/60)} min ago`:s<86400?`${Math.floor(s/3600)} h ago`:`${Math.floor(s/86400)} d ago`}
export function since(from:number){const m=Math.max(0,Math.floor((Date.now()-from)/60000));return m<60?`${m} min`:m<1440?`${Math.floor(m/60)} h ${m%60} min`:`${Math.floor(m/1440)} d ${Math.floor(m%1440/60)} h`}
export const hm=(minutes:number)=>minutes<60?`${minutes} min`:`${Math.floor(minutes/60)} h ${String(minutes%60).padStart(2,'0')} m`;
export const coords=(p:{latitude:number;longitude:number})=>`${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`;
export const mapsLink=(p:{latitude:number;longitude:number})=>`https://www.google.com/maps?q=${p.latitude},${p.longitude}`;
export const localInput=(date:Date)=>new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);

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
export const chip=(v:Vehicle)=>{const s=statusOf(v);return `<span class="chip ${s}">${STATUS_LABEL[s]}</span>`};
export function statusLine(v:Vehicle){
  const s=statusOf(v),p=v.position;
  if(s==='running'&&p)return `Running at ${Math.round(p.speed)} km/h`;
  if((s==='stopped'||s==='idle')&&v.stoppedSince)return `${s==='idle'?'Engine on, standing':'Parked'} for ${since(v.stoppedSince)} · since ${clock(v.stoppedSince)}`;
  if(s==='offline')return `No signal since ${time(v.lastSeen)}`;
  if(s==='waiting')return 'Waiting for the first signal from this vehicle';
  if(s==='nofix')return p?'GPS signal weak · showing last known place':'Waiting for GPS location';
  return '';
}
