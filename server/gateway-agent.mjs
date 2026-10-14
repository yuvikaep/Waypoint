import { pathToFileURL } from 'node:url';

// Oracle owns TCP reception and its retry buffer only. Vercel owns registrations,
// accounts, durable GPS history, and the checkpoint acknowledged by this worker.
export class GatewayAgent {
  constructor({cloudUrl,cloudSecret,traccarUrl,traccarToken,fetcher=fetch,now=()=>Date.now()}){
    this.cloudUrl=cloudUrl?.replace(/\/$/,'');this.cloudSecret=cloudSecret;
    this.traccarUrl=traccarUrl?.replace(/\/$/,'');this.traccarToken=traccarToken;
    this.fetcher=fetcher;this.now=now;
    if(!this.cloudUrl?.startsWith('https://')||!cloudSecret||!traccarUrl||!traccarToken)throw new Error('Configure HTTPS WAYPOINT_CLOUD_URL, GPS_GATEWAY_SECRET, TRACCAR_URL and TRACCAR_TOKEN.');
  }
  async request(base,path,secret,options={}){
    const response=await this.fetcher(`${base}${path}`,{...options,headers:{Authorization:`Bearer ${secret}`,Accept:'application/json','Content-Type':'application/json'},signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error(`Gateway dependency HTTP ${response.status}.`);
    return response.status===204?null:response.json();
  }
  cloud(path,options){return this.request(this.cloudUrl,`/api/gps/gateway${path}`,this.cloudSecret,options);}
  tracker(path,options){return this.request(this.traccarUrl,`/api${path}`,this.traccarToken,options);}
  async sync(){
    const registered=(await this.cloud('/devices')).devices;
    try{
      const remote=await this.tracker('/devices');
      const latest=await this.tracker('/positions');
      for(const device of registered){
        let match=remote.find(item=>item.uniqueId===device.uniqueId);
        if(!match){match=await this.tracker('/devices',{method:'POST',body:JSON.stringify({name:device.name,uniqueId:device.uniqueId,model:device.model})});remote.push(match);}
        const from=Math.max(device.createdAt-60000,(device.cursor??device.createdAt)-60000);
        const to=Math.min(from+15*60000,this.now());
        const history=await this.tracker(`/positions?${new URLSearchParams({deviceId:String(match.id),from:new Date(from).toISOString(),to:new Date(to).toISOString()})}`);
        const positions=[...new Map([...history,...latest.filter(p=>p.deviceId===match.id)].map(p=>[p.id,p])).values()];
        // Chunked reports keep requests bounded. Advance only after every chunk
        // is acknowledged, so an interrupted upload is retried idempotently.
        for(let offset=0;offset<Math.max(positions.length,1);offset+=100){
          const chunk=positions.slice(offset,offset+100);
          await this.cloud('/sync',{method:'POST',body:JSON.stringify({connected:true,devices:[{id:device.id,uniqueId:device.uniqueId,traccarId:match.id,status:match.status,lastUpdate:match.lastUpdate,positions:chunk,...(offset+100>=positions.length?{cursor:to}:{})}]})});
        }
      }
      if(!registered.length)await this.cloud('/sync',{method:'POST',body:JSON.stringify({connected:true,devices:[]})});
    }catch(error){
      await this.cloud('/sync',{method:'POST',body:JSON.stringify({connected:false,devices:[],error:'GPS receiver connection interrupted.'})}).catch(()=>{});
      throw error;
    }
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const agent=new GatewayAgent({cloudUrl:process.env.WAYPOINT_CLOUD_URL,cloudSecret:process.env.GPS_GATEWAY_SECRET,traccarUrl:process.env.TRACCAR_URL,traccarToken:process.env.TRACCAR_TOKEN});
  let stopping=false;process.on('SIGTERM',()=>{stopping=true});process.on('SIGINT',()=>{stopping=true});
  while(!stopping){
    try{await agent.sync();console.info('GPS cloud sync completed.');}
    catch(error){console.error('GPS cloud sync failed:',error.name);}
    if(!stopping)await new Promise(resolve=>setTimeout(resolve,10000));
  }
}
