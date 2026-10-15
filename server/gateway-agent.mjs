import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { open, stat as fsStat } from 'node:fs/promises';

// Oracle owns TCP reception and its retry buffer only. Vercel owns registrations,
// accounts, durable GPS history, and the checkpoint acknowledged by this worker.
export class GatewayAgent {
  constructor({cloudUrl,cloudSecret,traccarUrl,traccarToken,fetcher=fetch,now=()=>Date.now()}){
    this.cloudUrl=cloudUrl?.replace(/\/$/,'');this.cloudSecret=cloudSecret;
    this.traccarUrl=traccarUrl?.replace(/\/$/,'');this.traccarToken=traccarToken;
    this.fetcher=fetcher;this.now=now;
    // Trackers that lose network store fixes and upload them later with their original time.
    // Those land behind the time cursor, so every minute we also look back and forward any
    // receiver position newer (by Traccar id, which grows with arrival) than what we sent.
    this.sentId=new Map();this.lookedBack=new Map();
    if(!this.cloudUrl?.startsWith('https://')||!cloudSecret||!traccarUrl||!traccarToken)throw new Error('Configure HTTPS WAYPOINT_CLOUD_URL, GPS_GATEWAY_SECRET, TRACCAR_URL and TRACCAR_TOKEN.');
  }
  async request(base,path,secret,options={}){
    const response=await this.fetcher(`${base}${path}`,{...options,headers:{Authorization:`Bearer ${secret}`,Accept:'application/json','Content-Type':'application/json'},signal:AbortSignal.timeout(10000)});
    if(!response.ok){
      const detail=await response.json().catch(()=>null);
      throw new Error(`Gateway dependency HTTP ${response.status}.${typeof detail?.error==='string'?' '+detail.error:''}`);
    }
    return response.status===204?null:response.json();
  }
  cloud(path,options){return this.request(this.cloudUrl,`/api/gps/gateway${path}`,this.cloudSecret,options);}
  tracker(path,options){return this.request(this.traccarUrl,`/api${path}`,this.traccarToken,options);}
  // Registered devices change rarely; asking once a minute saves a cloud request on every sync.
  async registeredDevices(){
    if(!this.registered||this.now()-this.registeredAt>60000){this.registered=(await this.cloud('/devices')).devices;this.registeredAt=this.now();}
    return this.registered;
  }
  async sync(){
    const registered=await this.registeredDevices();
    try{
      const remote=await this.tracker('/devices');
      const latest=await this.tracker('/positions');
      const failures=[],batch=[],sentAfter=[];
      for(const device of registered)try{
        let match=remote.find(item=>item.uniqueId===device.uniqueId);
        // PT06 and similar announce +5:30 at login and Traccar then subtracts it from times that are
        // already UTC. Pin GT06-family trackers to UTC decoding so their fixes are not 5h30m old.
        const utc=['GT06','GT06N','PT06'].includes(device.model)?{'decoder.timezone':'UTC'}:{};
        if(!match){match=await this.tracker('/devices',{method:'POST',body:JSON.stringify({name:device.name,uniqueId:device.uniqueId,model:device.model,attributes:utc})});remote.push(match);}
        else if(utc['decoder.timezone']&&match.attributes?.['decoder.timezone']!=='UTC'){
          // Best effort: a failed settings update must never hold back the fixes.
          try{const updated=await this.tracker(`/devices/${match.id}`,{method:'PUT',body:JSON.stringify({...match,attributes:{...(match.attributes||{}),...utc}})});if(updated?.id===match.id)match=updated;}
          catch(error){console.error('Could not pin UTC decoding:',device.uniqueId,error.message);}
        }
        const from=Math.max(device.createdAt-60000,(device.cursor??device.createdAt)-60000);
        const to=Math.min(from+15*60000,this.now());
        const history=await this.tracker(`/positions?${new URLSearchParams({deviceId:String(match.id),from:new Date(from).toISOString(),to:new Date(to).toISOString()})}`);
        let late=[];
        if(this.now()-(this.lookedBack.get(device.id)||0)>=60000){
          const since=Math.max(device.createdAt-60000,this.now()-(this.lookedBack.has(device.id)?12:48)*3600000);
          const recent=await this.tracker(`/positions?${new URLSearchParams({deviceId:String(match.id),from:new Date(since).toISOString(),to:new Date(this.now()).toISOString()})}`);
          late=recent.filter(p=>p.id>(this.sentId.get(device.id)??0));
          this.lookedBack.set(device.id,this.now());
        }
        const positions=[...new Map([...history,...late,...latest.filter(p=>p.deviceId===match.id)].map(p=>[p.id,p])).values()];
        const report=chunk=>({id:device.id,uniqueId:device.uniqueId,traccarId:match.id,status:match.status,lastUpdate:match.lastUpdate,positions:chunk});
        if(positions.length<=100){batch.push({...report(positions),cursor:to});sentAfter.push([device,positions]);continue}
        // A large backlog goes on its own in chunks. Advance only after every chunk is acknowledged,
        // so an interrupted upload is retried idempotently.
        for(let offset=0;offset<positions.length;offset+=100){
          const chunk=positions.slice(offset,offset+100);
          await this.cloud('/sync',{method:'POST',body:JSON.stringify({connected:true,devices:[{...report(chunk),...(offset+100>=positions.length?{cursor:to}:{})}]})});
        }
        this.markSent(device,positions);
      }catch(error){
        // Keep the rest of the fleet flowing; this device retries from its own checkpoint.
        failures.push(`${device.name}: ${error.message}`);
        console.error('GPS device sync failed:',device.uniqueId,error.message);
      }
      const error=failures.length?`Some trackers failed to sync: ${failures.join('; ')}`.slice(0,300):undefined;
      // Everything else in one request; if one tracker makes it fail, send them one by one instead.
      try{await this.cloud('/sync',{method:'POST',body:JSON.stringify({connected:true,devices:batch,...(error?{error}:{})})});for(const [d,p] of sentAfter)this.markSent(d,p);}
      catch(batchError){
        if(batch.length<2)throw batchError;
        this.registered=null;
        for(const [n,item] of batch.entries())try{await this.cloud('/sync',{method:'POST',body:JSON.stringify({connected:true,devices:[item]})});this.markSent(...sentAfter[n]);}
        catch(e){failures.push(`${sentAfter[n][0].name}: ${e.message}`);console.error('GPS device sync failed:',item.uniqueId,e.message);}
        // Tell the cloud which trackers are stuck so the admin console shows it.
        await this.cloud('/sync',{method:'POST',body:JSON.stringify({connected:true,devices:[],error:`Some trackers failed to sync: ${failures.join('; ')}`.slice(0,300)})}).catch(()=>{});
      }
    }catch(error){
      await this.cloud('/sync',{method:'POST',body:JSON.stringify({connected:false,devices:[],error:`GPS receiver sync failed: ${String(error.message||error.name).slice(0,200)}`})}).catch(()=>{});
      throw error;
    }
  }
  markSent(device,positions){for(const p of positions)if(p.id>(this.sentId.get(device.id)??0))this.sentId.set(device.id,p.id);}
}

// Wakes the sync loop as soon as the receiver log shows a new fix (or anything POSTs to the loopback
// wake port), so fixes reach the cloud within about a second instead of waiting for the next round.
export function createWakeup(){
  let pending=null,resolve=null,timer=null;
  const wait=ms=>{pending??=new Promise(r=>{resolve=r});const t=new Promise(r=>{timer=setTimeout(r,ms)});return Promise.race([pending,t]).finally(()=>{clearTimeout(timer);pending=null;resolve=null})};
  // A tracker often sends several packets together; gather them for a moment before syncing.
  let debounce=null;
  const kick=(gather=400)=>{if(debounce)return;debounce=setTimeout(()=>{debounce=null;resolve?.()},gather)};
  return {wait,kick};
}
// Traccar logs every decoded position ("] id: ..."); reading the new lines is the fastest local signal
// that a fix arrived, and it needs no Traccar settings.
export function watchReceiverLog(file,kick,{interval=400,read=readTail,stat=fsStat}={}){
  let size=null,busy=false;
  const timer=setInterval(async()=>{
    if(busy)return;busy=true;
    try{
      const now=(await stat(file)).size;
      if(size!==null&&now>size&&/\] id: |type: (?:ignition|device|alarm)/.test(await read(file,size,now)))kick();
      size=now;   // also resets after the log is rotated and starts small again
    }catch{/* log missing for a moment */}finally{busy=false}
  },interval);
  return ()=>clearInterval(timer);
}
async function readTail(file,from,to){
  const handle=await open(file,'r');
  try{const length=Math.min(to-from,262144),buffer=Buffer.alloc(length);await handle.read(buffer,0,length,to-length);return buffer.toString('utf8')}
  finally{await handle.close()}
}
export function createWakeServer(kick){
  return createServer((req,res)=>{
    if(req.method!=='POST'){res.writeHead(404);res.end();return}
    req.resume();req.on('end',()=>{kick();res.writeHead(204);res.end()});
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const agent=new GatewayAgent({cloudUrl:process.env.WAYPOINT_CLOUD_URL,cloudSecret:process.env.GPS_GATEWAY_SECRET,traccarUrl:process.env.TRACCAR_URL,traccarToken:process.env.TRACCAR_TOKEN});
  let stopping=false;process.on('SIGTERM',()=>{stopping=true;wake.kick(0)});process.on('SIGINT',()=>{stopping=true;wake.kick(0)});
  const wake=createWakeup();
  // Loopback only: Traccar runs on the same VM.
  createWakeServer(()=>wake.kick()).listen(Number(process.env.WAYPOINT_WAKE_PORT||8183),'127.0.0.1',()=>console.info('Waiting for receiver push on loopback.'));
  watchReceiverLog(process.env.TRACCAR_LOG||'/opt/traccar/logs/tracker-server.log',()=>wake.kick());
  while(!stopping){
    try{await agent.sync();}
    catch(error){console.error('GPS cloud sync failed:',error.name,error.message);}
    // New fixes wake this at once; otherwise check every 30 s to keep the cloud link marked alive.
    if(!stopping)await wake.wait(30000);
  }
  process.exit(0);
}
