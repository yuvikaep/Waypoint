import {$,api,brand,i,icons,on} from './shared/core';
import {DEMO_MODE} from './demo';

const action=(selector:string,handler:()=>void|Promise<void>)=>on(selector,handler);

export async function mobileSender(){
  const joinCode=new URLSearchParams(location.hash.slice(1)).get('join');
  if(joinCode)window.history.replaceState(null,'',location.pathname+location.search);
  $('#app').innerHTML=`<div class="sender">${brand()}<div class="card">
    <div style="display:flex;gap:12px;align-items:center"><span style="width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:var(--blue-50);color:var(--blue-600)">${i('smartphone')}</span><div><span class="small muted">Driver location</span><h2 id="sender-vehicle">Link connect ho raha hai...</h2></div></div>
    <p class="small muted" id="sender-until"></p>
    <p class="muted" id="sender-help">Aapki location fleet ko sirf sharing shuru karne ke baad bheji jayegi.</p>
    <p class="error" id="sender-error" role="alert"></p>
    <button class="btn btn-blue btn-block" id="start-sender" disabled>${i('locate-fixed')}Location shuru karein</button>
    <button class="btn btn-ghost btn-block" id="retry-sender" hidden>Dobara connect karein</button>
    <div class="state" id="sender-status" role="status">Location sharing band hai</div>
    <button class="btn btn-danger btn-block" id="stop-sender" hidden>Sharing band karein</button>
    <p class="small muted">Sharing ke dauran page khula rakhein. Phone lock hone ya browser band hone par updates ruk sakte hain.</p></div></div>`;icons();
  let watch:number|undefined,timer:ReturnType<typeof setInterval>|undefined,generation=0,sending=false,requesting=false,sharing=false,deviceId='';
  const error=(message:string)=>{$('#sender-error').textContent=message};
  // Tells the fleet owner at once why sharing ended, so they can ask the driver to start again.
  const report=(reason:'stopped'|'permission'|'closed',beacon=false)=>{
    if(!deviceId||DEMO_MODE)return;
    const body=JSON.stringify({deviceId,reason});
    // A beacon cannot carry the app's native session cookie, so the Android app always uses api().
    if(beacon&&navigator.sendBeacon&&!import.meta.env.VITE_API_ORIGIN){navigator.sendBeacon('/api/gps/sender/stopped',new Blob([body],{type:'application/json'}));return}
    void api('/sender/stopped',{method:'POST',body}).catch(()=>{});
  };
  const stop=()=>{generation++;sharing=false;if(watch!==undefined)navigator.geolocation.clearWatch(watch);watch=undefined;if(timer)clearInterval(timer);timer=undefined;$('#sender-status').textContent='Location sharing band hai';$('#stop-sender').hidden=true;$<HTMLButtonElement>('#start-sender').disabled=!deviceId};
  action('#stop-sender',()=>{if(sharing)report('stopped');stop()});
  window.addEventListener('pagehide',()=>{if(sharing)report('closed',true);stop()});
  const senderRequest=async<T=any>(path:string,payload:object={})=>{
    try{return await api<T>(path,{method:'POST',body:JSON.stringify({deviceId,...payload})})}
    catch(e){if(/driver link|different vehicle|fleet admin/i.test((e as Error).message)){deviceId='';stop()}throw e}
  };
  const send=async(position:GeolocationPosition,commandId?:string)=>{
    if(!sharing||sending)return;sending=true;const run=generation;
    try{await senderRequest('/sender/position',{eventId:crypto.randomUUID(),recordedAt:new Date(position.timestamp).toISOString(),latitude:position.coords.latitude,longitude:position.coords.longitude,speed:Math.max(0,(position.coords.speed||0)*3.6),heading:position.coords.heading,accuracy:position.coords.accuracy,commandId});if(run===generation){error('');$('#sender-status').textContent=`Location share ho rahi hai · ${new Date().toLocaleTimeString()} · accuracy ${Math.round(position.coords.accuracy)} m`;}}
    catch(e){error((e as Error).message)}finally{sending=false}
  };
  const locationError=(e:GeolocationPositionError)=>{error(e.code===1?'Location permission band hai. Browser settings mein Location Allow karein, phir dobara shuru karein.':e.code===2?'Location nahi mil rahi. Phone ka GPS on karke khuli jagah par try karein.':'GPS ka wait ho raha hai. Dobara koshish karein.');if(e.code===1){if(sharing)report('permission');stop()}};
  const fresh=(commandId?:string)=>{if(requesting||!sharing)return;requesting=true;const run=generation;navigator.geolocation.getCurrentPosition(p=>{requesting=false;if(run===generation)void send(p,commandId)},e=>{requesting=false;if(run===generation)locationError(e)},{enableHighAccuracy:true,timeout:15000,maximumAge:0})};
  action('#start-sender',()=>{
    if(DEMO_MODE){sharing=true;$('#sender-status').textContent='Demo sharing chal rahi hai. Real location use nahi ho rahi.';$<HTMLButtonElement>('#start-sender').disabled=true;$('#stop-sender').hidden=false;return}
    if(!deviceId)return;if(!navigator.geolocation||!isSecureContext){error('Phone par location sharing ke liye HTTPS link chahiye. Admin se naya link lein.');return}
    error('');sharing=true;$<HTMLButtonElement>('#start-sender').disabled=true;const run=++generation;
    $('#stop-sender').hidden=false;$('#sender-status').textContent='Browser mein location Allow karein. GPS ka wait ho raha hai...';
    watch=navigator.geolocation.watchPosition(p=>{if(run===generation)void send(p)},e=>{if(run===generation)locationError(e)},{enableHighAccuracy:true,timeout:15000,maximumAge:5000});
    timer=setInterval(async()=>{if(run!==generation)return;try{const result=await senderRequest<{commands:{id:string}[]}>('/sender/heartbeat');if(run===generation)fresh(result.commands[0]?.id)}catch(e){error((e as Error).message)}},30000);
  });
  const connect=async()=>{
    $('#retry-sender').hidden=true;
    try{type Joined={device:{id:string;name:string;driver:string};expiresAt?:number|null};const result=joinCode?await api<Joined>('/sender/join',{method:'POST',body:JSON.stringify({code:joinCode})}):await api<Joined>('/sender/me');$('#sender-until').textContent=result.expiresAt?`Yeh link ${new Date(result.expiresAt).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})} tak chalega.`:'';deviceId=result.device.id;$('#sender-vehicle').textContent=result.device.name+(result.device.driver?' · '+result.device.driver:'');$<HTMLButtonElement>('#start-sender').disabled=false;error('')}
    catch(e){$('#sender-vehicle').textContent='Driver link chahiye';error((e as Error).message);$('#retry-sender').hidden=false}
  };
  action('#retry-sender',connect);await connect();
}
