import {toast,type Alert} from '../shared/core';

// Alert categories shown separately in the Alerts page and switchable in Settings.
export type Category='ignition'|'geofence'|'speed'|'connection'|'tracker';
export const CATEGORIES:{key:Category;label:string;hint:string;icon:string;color:string}[]=[
  {key:'ignition',label:'Ignition',hint:'Engine started / engine off',icon:'power',color:'var(--running)'},
  {key:'geofence',label:'Geofence',hint:'Vehicle entered or left a place',icon:'map-pin',color:'var(--blue-600)'},
  {key:'speed',label:'Overspeed',hint:'Vehicle crossed its speed limit',icon:'gauge',color:'var(--stopped)'},
  {key:'connection',label:'Signal',hint:'Tracker signal lost or restored',icon:'wifi-off',color:'var(--offline)'},
  {key:'tracker',label:'Vehicle alarms',hint:'Power cut, tampering, SOS',icon:'triangle-alert',color:'var(--idle)'},
];
export const categoryOf=(type:string):Category=>type==='ignition_on'||type==='ignition_off'?'ignition':type==='enter'||type==='exit'?'geofence':type==='speed'?'speed':type==='offline'||type==='online'?'connection':'tracker';

export type NotifyPrefs={popup:boolean;voice:boolean;browser:boolean;categories:Record<Category,boolean>};
export const defaultNotify=():NotifyPrefs=>({popup:true,voice:true,browser:false,categories:{ignition:true,geofence:true,speed:true,connection:true,tracker:true}});
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
    case 'speed':return {title:'Overspeed',text:`${name} is overspeeding`};
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
    const {title,text}=alertWords(a);
    if(prefs.popup)toast(`${title}: ${text}`);
    if(prefs.voice)speak(text);
    if(prefs.browser&&browserState()==='granted'&&document.hidden){
      try{new Notification(title,{body:text,tag:a.id,icon:'/favicon.ico'})}catch{/* some mobile browsers need a service worker */}
    }
  }
}
