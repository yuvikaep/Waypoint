import { pathToFileURL } from 'node:url';

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
  async sync(){
    const registered=(await this.cloud('/devices')).devices;
    try{
      const remote=await this.tracker('/devices');
      const latest=await this.tracker('/positions');
      const failures=[];
      for(const device of registered)try{
        let match=remote.find(item=>item.uniqueId===device.uniqueId);
        if(!match){match=await this.tracker('/devices',{method:'POST',body:JSON.stringify({name:device.name,uniqueId:device.uniqueId,model:device.model})});remote.push(match);}
        const from=Math.max(device.createdAt-60000,(device.cursor??device.createdAt)-60000);
        const to=Math.min(from+15*60000,this.now());
        const history=await this.tracker(`/positions?${new URLSearchParams({deviceId:String(match.id),from:new Date(from).toISOString(),to:new Date(to).toISOString()})}`);
        let late=[];
        if(this.now()-(this.lookedBack.get(device.id)||0)>=60000){
          const since=Math.max(device.createdAt-60000,this.now()-12*3600000);
          const recent=await this.tracker(`/positions?${new URLSearchParams({deviceId:String(match.id),from:new Date(since).toISOString(),to:new Date(this.now()).toISOString()})}`);
          late=recent.filter(p=>p.id>(this.sentId.get(device.id)??0));
          this.lookedBack.set(device.id,this.now());
        }
        const positions=[...new Map([...history,...late,...latest.filter(p=>p.deviceId===match.id)].map(p=>[p.id,p])).values()];
        // Chunked reports keep requests bounded. Advance only after every chunk
        // is acknowledged, so an interrupted upload is retried idempotently.
        for(let offset=0;offset<Math.max(positions.length,1);offset+=100){
          const chunk=positions.slice(offset,offset+100);
          await this.cloud('/sync',{method:'POST',body:JSON.stringify({connected:true,devices:[{id:device.id,uniqueId:device.uniqueId,traccarId:match.id,status:match.status,lastUpdate:match.lastUpdate,positions:chunk,...(offset+100>=positions.length?{cursor:to}:{})}]})});
        }
        for(const p of positions)if(p.id>(this.sentId.get(device.id)??0))this.sentId.set(device.id,p.id);
      }catch(error){
        // Keep the rest of the fleet flowing; this device retries from its own checkpoint.
        failures.push(`${device.name}: ${error.message}`);
        console.error('GPS device sync failed:',device.uniqueId,error.message);
      }
      if(failures.length)await this.cloud('/sync',{method:'POST',body:JSON.stringify({connected:true,devices:[],error:`Some trackers failed to sync: ${failures.join('; ')}`.slice(0,300)})});
      if(!registered.length)await this.cloud('/sync',{method:'POST',body:JSON.stringify({connected:true,devices:[]})});
    }catch(error){
      await this.cloud('/sync',{method:'POST',body:JSON.stringify({connected:false,devices:[],error:`GPS receiver sync failed: ${String(error.message||error.name).slice(0,200)}`})}).catch(()=>{});
      throw error;
    }
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const agent=new GatewayAgent({cloudUrl:process.env.WAYPOINT_CLOUD_URL,cloudSecret:process.env.GPS_GATEWAY_SECRET,traccarUrl:process.env.TRACCAR_URL,traccarToken:process.env.TRACCAR_TOKEN});
  let stopping=false;process.on('SIGTERM',()=>{stopping=true});process.on('SIGINT',()=>{stopping=true});
  while(!stopping){
    try{await agent.sync();console.info('GPS cloud sync completed.');}
    catch(error){console.error('GPS cloud sync failed:',error.name,error.message);}
    if(!stopping)await new Promise(resolve=>setTimeout(resolve,10000));
  }
}
