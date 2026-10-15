import {HI} from './hi';
import {HG} from './hg';

// Customer screens in Hindi (default), English or Hinglish (Hindi in Roman letters), chosen in
// Settings. Text is written in English in the code and looked up here; anything without a line in
// the chosen language falls back to the English text.
export type Lang='hi'|'en'|'hg';
export const LANGS:[Lang,string,string][]=[['hi','हिंदी','Hindi'],['hg','Hinglish','Roman Hindi'],['en','English','English']];
const KEY='waypoint.lang';
let lang:Lang='hi';
try{const saved=localStorage.getItem(KEY);if(saved==='en'||saved==='hi'||saved==='hg')lang=saved}catch{/* private mode */}
document.documentElement.lang=lang==='hi'?'hi':'en';

export const getLang=()=>lang;
// remember=false: the admin console uses English without changing the customer's choice.
export function setLang(next:Lang,remember=true){
  lang=next;document.documentElement.lang=next==='hi'?'hi':'en';
  if(remember)try{localStorage.setItem(KEY,next)}catch{/* private mode */}
}
export function tIn(l:Lang,en:string,vars?:Record<string,string|number>){
  const text=l==='hi'?(HI[en]??en):l==='hg'?(HG[en]??en):en;
  return vars?text.replace(/\{(\w+)\}/g,(_:string,k:string)=>String(vars[k]??'')):text;
}
export const t=(en:string,vars?:Record<string,string|number>)=>tIn(lang,en,vars);
// Dates and times: Hindi month names for Hindi, Indian English otherwise.
export const locale=()=>lang==='hi'?'hi-IN-u-nu-latn':'en-IN';
