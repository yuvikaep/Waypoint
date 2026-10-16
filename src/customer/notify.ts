import {toast,type Alert} from '../shared/core';
import {t,tIn,getLang,type Lang} from '../shared/i18n';

// Alert categories shown separately in the Alerts page and switchable in Settings.
export type Category='driver'|'sos'|'ignition'|'geofence'|'speed'|'driving'|'connection'|'tracker';
export const CATEGORIES:{key:Category;label:string;hint:string;icon:string;color:string}[]=[
  {key:'sos',label:'SOS',hint:'Emergency button pressed, or a locked vehicle started or moved',icon:'siren',color:'var(--stopped)'},
  {key:'ignition',label:'Ignition',hint:'Engine started / engine off',icon:'power',color:'var(--running)'},
  {key:'geofence',label:'Geofence',hint:'Vehicle entered or left a place',icon:'map-pin',color:'var(--blue-600)'},
  {key:'speed',label:'Overspeed',hint:'Vehicle crossed its speed limit',icon:'gauge',color:'var(--stopped)'},
  {key:'driving',label:'Hard braking',hint:'Sudden braking, hard acceleration, sharp turns',icon:'octagon-alert',color:'var(--idle)'},
  {key:'driver',label:'Driver phone',hint:'Driver\'s phone stopped or restarted sharing location, link expired',icon:'smartphone',color:'var(--idle)'},
  {key:'connection',label:'Signal',hint:'Tracker signal lost or restored',icon:'wifi-off',color:'var(--offline)'},
  {key:'tracker',label:'Vehicle alarms',hint:'Power cut, tampering, vibration',icon:'triangle-alert',color:'var(--idle)'},
];
export const categoryOf=(type:string):Category=>type.startsWith('share_')?'driver':type==='sos'||type==='parking_lock'?'sos':type==='harsh_brake'||type==='harsh'?'driving':type==='ignition_on'||type==='ignition_off'?'ignition':type==='enter'||type==='exit'?'geofence':type==='speed'?'speed':type==='offline'||type==='online'?'connection':'tracker';

export type NotifyPrefs={popup:boolean;voice:boolean;browser:boolean;categories:Record<Category,boolean>};
export const defaultNotify=():NotifyPrefs=>({popup:true,voice:true,browser:false,categories:{driver:true,sos:true,ignition:true,geofence:true,speed:true,driving:true,connection:true,tracker:true}});
export function mergeNotify(saved:Partial<NotifyPrefs>|undefined):NotifyPrefs{
  const d=defaultNotify();
  return {popup:saved?.popup??d.popup,voice:saved?.voice??d.voice,browser:saved?.browser??d.browser,categories:{...d.categories,...(saved?.categories||{})}};
}

// Alert wording in the customer's language. Server messages are English; known shapes are put into
// plain words here, and names (vehicles, places) stay as they are.
type Words={title:string;text:string};
function words(a:Alert,l:Lang):Words{
  const T=(key:string,vars?:Record<string,string|number>)=>tIn(l,key,vars),n=a.deviceName,m=a.message.replace(/\.$/,'');
  const nums=[...a.message.matchAll(/(\d+(?:\.\d+)?)/g)].map(x=>x[1]);
  switch(a.type){
    case 'ignition_on':return {title:T('Vehicle started'),text:T('Vehicle {n} started',{n})};
    case 'ignition_off':return {title:T('Engine off'),text:T('Vehicle {n} engine off',{n})};
    case 'enter':return {title:T('Entered place'),text:T('{n} entered {p}',{n,p:m.replace(/^Entered /,'')})};
    case 'exit':return {title:T('Left place'),text:T('{n} left {p}',{n,p:m.replace(/^Left /,'')})};
    case 'speed':return {title:T('Overspeed'),text:nums.length>=2?T('Vehicle {n} overspeeding, {s} km per hour. Limit {l}',{n,s:nums[0],l:nums[1]}):T('Vehicle {n} is overspeeding',{n})};
    case 'share_stopped':return {title:T('Driver location off'),text:T('Driver location for vehicle {n} has stopped',{n})};
    case 'share_expired':return {title:T('Driver link expired'),text:T('Driver link for vehicle {n} has expired',{n})};
    case 'share_resumed':return {title:T('Driver sharing again'),text:T('Driver location for vehicle {n} is back',{n})};
    case 'parking_lock':return {title:T('Parking lock alert'),text:/engine/.test(m)?T('Locked vehicle {n} engine started',{n}):T('Locked vehicle {n} is moving',{n})};
    case 'relay':return {title:T('Engine lock'),text:/unlock/i.test(m)?T('Unlock command sent to {n}.',{n}):T('Lock command sent to {n}.',{n})};
    case 'sos':return {title:T('SOS emergency'),text:T('Emergency! SOS from vehicle {n}',{n})};
    case 'harsh_brake':return {title:T('Hard braking'),text:T('Vehicle {n} hard braking',{n})};
    case 'harsh':return {title:T('Harsh driving'),text:`${n}. ${T(m)}`};
    case 'offline':return {title:T('Signal lost'),text:T('{n} signal lost',{n})};
    case 'online':return {title:T('Signal restored'),text:T('{n} signal restored',{n})};
    default:return {title:T('Vehicle alarm'),text:`${n}. ${m.split(', ').map(x=>T(x)).join(', ')}`};
  }
}
export const alertWords=(a:Alert)=>words(a,getLang());
// The line shown in the Alerts list, with the details the server recorded.
export function alertText(a:Alert){
  const m=a.message.replace(/\.$/,''),nums=[...a.message.matchAll(/(\d+(?:\.\d+)?)/g)].map(x=>x[1]);
  switch(a.type){
    case 'offline':{const s=Number(nums[0]);return `${t('Signal lost')}${s?` · ${t('no update for {d}',{d:s>=120?t('{m} min',{m:Math.round(s/60)}):t('{s} sec',{s})})}`:''}`}
    case 'ignition_on':return t('Vehicle started · engine on');
    case 'ignition_off':return t('Engine off');
    case 'online':return t('Signal restored');
    case 'speed':return nums.length>=2?t('Speed {s} km/h, limit {l} km/h',{s:nums[0],l:nums[1]}):t(m);
    case 'harsh_brake':return nums.length>=3?t('Hard braking: {a} → {b} km/h in {s} s',{a:nums[0],b:nums[1],s:nums[2]}):t(m);
    case 'parking_lock':return /engine/.test(m)?t('Parking lock: engine started'):nums.length?t('Parking lock: vehicle moved {m} m from where it was parked',{m:nums[0]}):t(m);
    case 'relay':return /unlock/i.test(m)?t('Engine unlock command sent to the tracker.'):t('Engine lock command sent to the tracker.');
    case 'enter':return t('Entered {p}',{p:m.replace(/^Entered /,'')});
    case 'exit':return t('Left {p}',{p:m.replace(/^Left /,'')});
    case 'share_stopped':return `${/no update for/.test(m)?t("Driver's phone stopped sending location"):t(m)}. ${t('Send the link again or create a new one.')}`;
    case 'share_expired':return t('Driver location link expired. Send a new link to keep tracking.');
    case 'share_resumed':return t('Driver started sharing location again.');
    default:return m.split(', ').map(x=>t(x)).join(', ');
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
// Hindi and Hinglish users hear Hindi when the phone has a Hindi voice; otherwise an Indian English
// voice reads the Hinglish (or English) line. English users hear English.
type Lines=Record<Lang,string>;
function say(line:Lines,twice=false){
  if(!voiceSupported())return;
  try{
    const synth=window.speechSynthesis,voices=synth.getVoices();
    // Never let announcements pile up behind each other.
    if(synth.pending&&synth.speaking)synth.cancel();
    const lang=getLang(),hindi=lang!=='en'?voices.find(v=>/^hi/i.test(v.lang)):undefined;
    const text=hindi?line.hi:lang==='hg'?line.hg:line.en;
    const u=new SpeechSynthesisUtterance(twice?`${text}. ${text}`:text);u.rate=0.95;
    if(hindi){u.voice=hindi;u.lang=hindi.lang}
    else{u.lang='en-IN';const v=voices.find(v=>/en[-_]IN/i.test(v.lang))||voices.find(v=>/^en/i.test(v.lang));if(v)u.voice=v}
    synth.speak(u);
  }catch{/* ignore */}
}
export const speakAlert=(key:string,vars?:Record<string,string|number>)=>say({hi:tIn('hi',key,vars),hg:tIn('hg',key,vars),en:tIn('en',key,vars)});

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
    const {title,text}=alertWords(a),sos=a.type==='sos'||a.type==='parking_lock';
    if(prefs.popup)toast(`${title}: ${text}`,sos);
    // An SOS is said twice so it is not missed.
    if(prefs.voice)say({hi:words(a,'hi').text,hg:words(a,'hg').text,en:words(a,'en').text},sos);
    // SOS also notifies while the app is in front, and stays until it is dismissed.
    if(prefs.browser&&browserState()==='granted'&&(document.hidden||sos)){
      try{new Notification(title,{body:text,tag:a.id,icon:'/favicon.ico',requireInteraction:sos})}catch{/* some mobile browsers need a service worker */}
    }
  }
}
