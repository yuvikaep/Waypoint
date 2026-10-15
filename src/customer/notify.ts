import {toast,type Alert} from '../shared/core';

// Alert categories shown separately in the Alerts page and switchable in Settings.
export type Category='driver'|'sos'|'ignition'|'geofence'|'speed'|'driving'|'connection'|'tracker';
export const CATEGORIES:{key:Category;label:string;hint:string;icon:string;color:string}[]=[
  {key:'sos',label:'SOS',hint:'Emergency button pressed in the vehicle',icon:'siren',color:'var(--stopped)'},
  {key:'ignition',label:'Ignition',hint:'Engine started / engine off',icon:'power',color:'var(--running)'},
  {key:'geofence',label:'Geofence',hint:'Vehicle entered or left a place',icon:'map-pin',color:'var(--blue-600)'},
  {key:'speed',label:'Overspeed',hint:'Vehicle crossed its speed limit',icon:'gauge',color:'var(--stopped)'},
  {key:'driving',label:'Hard braking',hint:'Sudden braking, hard acceleration, sharp turns',icon:'octagon-alert',color:'var(--idle)'},
  {key:'driver',label:'Driver phone',hint:'Driver\'s phone stopped or restarted sharing location, link expired',icon:'smartphone',color:'var(--idle)'},
  {key:'connection',label:'Signal',hint:'Tracker signal lost or restored',icon:'wifi-off',color:'var(--offline)'},
  {key:'tracker',label:'Vehicle alarms',hint:'Power cut, tampering, vibration',icon:'triangle-alert',color:'var(--idle)'},
];
export const categoryOf=(type:string):Category=>type.startsWith('share_')?'driver':type==='sos'?'sos':type==='harsh_brake'||type==='harsh'?'driving':type==='ignition_on'||type==='ignition_off'?'ignition':type==='enter'||type==='exit'?'geofence':type==='speed'?'speed':type==='offline'||type==='online'?'connection':'tracker';

export type NotifyPrefs={popup:boolean;voice:boolean;browser:boolean;categories:Record<Category,boolean>};
export const defaultNotify=():NotifyPrefs=>({popup:true,voice:true,browser:false,categories:{driver:true,sos:true,ignition:true,geofence:true,speed:true,driving:true,connection:true,tracker:true}});
export function mergeNotify(saved:Partial<NotifyPrefs>|undefined):NotifyPrefs{
  const d=defaultNotify();
  return {popup:saved?.popup??d.popup,voice:saved?.voice??d.voice,browser:saved?.browser??d.browser,categories:{...d.categories,...(saved?.categories||{})}};
}

// What is shown and spoken: the vehicle name first, then plain words.
export function alertWords(a:Alert){
  const name=a.deviceName;
  switch(a.type){
    case 'ignition_on':return {title:'Vehicle started',text:`Vehicle ${name} started`};
    case 'ignition_off':return {title:'Engine off',text:`Vehicle ${name} engine off`};
    case 'enter':return {title:'Entered geofence',text:`${name} ${a.message.replace(/\.$/,'').replace(/^Entered/,'entered')}`};
    case 'exit':return {title:'Left geofence',text:`${name} ${a.message.replace(/\.$/,'').replace(/^Left/,'left')}`};
    case 'speed':{const [now,limit]=[...a.message.matchAll(/(\d+) km\/h/g)].map(m=>m[1]);return {title:'Overspeed',text:now?`Vehicle ${name} overspeeding, ${now} kilometre per hour. Limit ${limit}`:`Vehicle ${name} is overspeeding`}}
    case 'share_stopped':return {title:'Driver location off',text:`Driver location for vehicle ${name} has stopped`};
    case 'share_expired':return {title:'Driver link expired',text:`Driver link for vehicle ${name} has expired`};
    case 'share_resumed':return {title:'Driver sharing again',text:`Driver location for vehicle ${name} is back`};
    case 'sos':return {title:'SOS emergency',text:`Emergency! SOS from vehicle ${name}`};
    case 'harsh_brake':return {title:'Hard braking',text:`Vehicle ${name} hard braking`};
    case 'harsh':return {title:'Harsh driving',text:`Vehicle ${name}. ${a.message.replace(/\.$/,'')}`};
    case 'offline':return {title:'Signal lost',text:`${name} signal lost`};
    case 'online':return {title:'Signal restored',text:`${name} signal restored`};
    default:return {title:'Vehicle alarm',text:`${name}. ${a.message.replace(/\.$/,'')}`};
  }
}

let voiceReady=false;
// Browsers allow speech only after the page has been touched once.
export function unlockVoice(){
  if(voiceReady||!('speechSynthesis' in window))return;
  voiceReady=true;
  try{window.speechSynthesis.speak(new SpeechSynthesisUtterance(''))}catch{/* no voice support */}
}
export const voiceSupported=()=>'speechSynthesis' in window;
export function speak(text:string){
  if(!voiceSupported())return;
  try{
    const synth=window.speechSynthesis;
    // Never let announcements pile up behind each other.
    if(synth.pending&&synth.speaking)synth.cancel();
    const u=new SpeechSynthesisUtterance(text);u.lang='en-IN';u.rate=0.95;
    const voice=synth.getVoices().find(v=>/en[-_]IN/i.test(v.lang))||synth.getVoices().find(v=>/^en/i.test(v.lang));
    if(voice)u.voice=voice;
    synth.speak(u);
  }catch{/* ignore */}
}

export const browserSupported=()=>'Notification' in window;
export const browserState=():'unsupported'|'granted'|'denied'|'default'=>browserSupported()?Notification.permission:'unsupported';
export async function askBrowserPermission(){return browserSupported()?Notification.requestPermission():'denied'}

// Announces alerts that arrived after the app opened and are switched on in Settings.
const seen=new Set<string>();let primed=false;
export function primeSeen(alerts:Alert[]){for(const a of alerts)seen.add(a.id);primed=true}
export function announceNew(alerts:Alert[],prefs:NotifyPrefs){
  if(!primed){primeSeen(alerts);return}
  const fresh=alerts.filter(a=>!seen.has(a.id)).sort((a,b)=>a.createdAt-b.createdAt);
  for(const a of alerts)seen.add(a.id);
  for(const a of fresh){
    if(!prefs.categories[categoryOf(a.type)])continue;
    const {title,text}=alertWords(a),sos=a.type==='sos';
    if(prefs.popup)toast(`${title}: ${text}`,sos);
    // An SOS is said twice so it is not missed.
    if(prefs.voice)speak(sos?`${text}. ${text}`:text);
    // SOS also notifies while the app is in front, and stays until it is dismissed.
    if(prefs.browser&&browserState()==='granted'&&(document.hidden||sos)){
      try{new Notification(title,{body:text,tag:a.id,icon:'/favicon.ico',requireInteraction:sos})}catch{/* some mobile browsers need a service worker */}
    }
  }
}
