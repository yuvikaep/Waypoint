import { createServer } from 'node:http';
import { open } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const fail=(status,message)=>{throw Object.assign(Error(message),{status});};

// Admin maintenance commands that may be sent over GPRS. Anything else is refused, so a leaked
// cloud secret cannot be used to push arbitrary text (or relay cuts) to vehicles.
const GT06_SECONDS='(?:[5-9]|[1-9]\\d{1,3}|1[0-7]\\d{3}|18000)';
export const ALLOWED_COMMANDS=[
  /^(?:RESET|STATUS|PARAM|GPRSSET|VERSION|WHERE|TIMER|APN|SERVER|GPRSON|ACCREP)#$/,
  new RegExp(`^TIMER,(?:0|${GT06_SECONDS}),${GT06_SECONDS}#$`),
  /^ACCREP,(?:ON|OFF)#$/,/^GPRSON,[01]#$/,
  /^APN,[A-Za-z0-9._-]{1,40}(?:,[A-Za-z0-9._@-]{0,40},[A-Za-z0-9._@-]{0,40})?#$/,
  /^SERVER,[01],[A-Za-z0-9.-]{3,100},\d{2,5},[01]#$/,
  /^(?:getinfo|getver|getstatus|getgps|cpureset)$/,
];
export const commandAllowed=data=>typeof data==='string'&&ALLOWED_COMMANDS.some(rule=>rule.test(data));

// GT06 message names for the live packet viewer.
const GT06_TYPES={'01':'Login','12':'Location','13':'Heartbeat / status','15':'Command reply','16':'Alarm','17':'Cell location','1a':'GPS query','21':'Command reply','22':'Location','26':'Alarm','80':'Command','8a':'Time request','94':'Information'};
export function packetTag(protocol,direction,hex){
  if(protocol!=='gt06')return protocol==='teltonika'?(direction==='in'?'Teltonika data':'Teltonika ack'):protocol;
  const h=hex.toLowerCase(),type=h.startsWith('7979')?h.slice(8,10):h.slice(6,8),name=GT06_TYPES[type]||`Type 0x${type}`;
  return direction==='in'?name:`Server ack · ${name}`;
}
// Reads the tail of Traccar's log and keeps only the connections that belong to one tracker.
export async function trackerPackets(file,uniqueId,limit=200,maxBytes=3_000_000){
  const handle=await open(file,'r');
  let text;
  try{const {size}=await handle.stat(),start=Math.max(0,size-maxBytes),buffer=Buffer.alloc(size-start);await handle.read(buffer,0,buffer.length,start);text=buffer.toString('utf8')}
  finally{await handle.close()}
  const lines=text.split('\n'),sessions=new Set(),imeiHex=`0${uniqueId}`;
  const parsed=[];
  for(const line of lines){
    const m=line.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+\w+:\s+\[(T[0-9a-f]+)(?::\s+(\w+)\s+([<>])\s+([^\]]+))?\]\s+(.*)$/);
    if(!m)continue;
    const [,at,session,protocol,arrow,remote,rest]=m;
    if(rest.startsWith(`id: ${uniqueId},`)||(protocol&&rest.toLowerCase().includes(imeiHex)))sessions.add(session);
    // The receiver VM logs in UTC.
    parsed.push({at:`${at.replace(' ','T')}Z`,session,protocol,arrow,remote,rest});
  }
  const out=[];
  for(const p of parsed){
    if(!sessions.has(p.session))continue;
    if(p.protocol){const direction=p.arrow==='<'?'in':'out';out.push({at:p.at,session:p.session,direction,remote:p.remote,hex:p.rest.trim(),tag:packetTag(p.protocol,direction,p.rest.trim())})}
    else if(/^(connected|disconnected|timed out)$/.test(p.rest))out.push({at:p.at,session:p.session,direction:'event',remote:'',hex:'',tag:p.rest});
    else if(p.rest.startsWith('id: '))out.push({at:p.at,session:p.session,direction:'decoded',remote:'',hex:'',tag:p.rest.slice(0,200)});
  }
  return out.slice(-limit);
}
const digest=value=>createHash('sha256').update(value).digest();
export function createCommandChannel({secret,traccarUrl,traccarToken,fetcher=fetch,now=()=>Date.now(),logFile='/opt/traccar/logs/tracker-server.log'}){
  if(!secret||secret.length<24||!traccarToken)throw Error('Command channel credentials are required.');
  if(traccarUrl!=='http://127.0.0.1:8082')throw Error('Command channel must use the private local receiver.');
  const reply=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  const request=async(path,options={})=>{
    const response=await fetcher(`${traccarUrl}/api${path}`,{...options,headers:{Authorization:`Bearer ${traccarToken}`,Accept:'application/json','Content-Type':'application/json'},signal:AbortSignal.timeout(5000)});
    if(!response.ok)fail(502,`Receiver returned HTTP ${response.status}.`);
    return {status:response.status,data:response.status===204?null:await response.json()};
  };
  const deviceId=value=>{
    if(!/^[1-9][0-9]*$/.test(String(value))||!Number.isSafeInteger(Number(value)))fail(400,'Invalid tracker identifier.');
    return Number(value);
  };
  return createServer(async(req,res)=>{
    try{
      const supplied=req.headers.authorization?.replace(/^Bearer /,'');
      if(!supplied||!timingSafeEqual(digest(supplied),digest(secret)))fail(401,'Command channel authentication required.');
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/api/commands/types'&&req.method==='GET'){
        const id=deviceId(url.searchParams.get('deviceId'));
        if(url.searchParams.get('textChannel')!=='false')fail(400,'Only TCP commands are supported.');
        const result=await request(`/commands/types?deviceId=${id}&textChannel=false`);
        // A capability query is not a physical command or a fresh heartbeat.
        return reply(res,200,result.data.map(item=>({type:item.type})));
      }
      if(url.pathname==='/api/packets'&&req.method==='GET'){
        const uniqueId=url.searchParams.get('uniqueId')||'';
        if(!/^[0-9A-Za-z_-]{3,32}$/.test(uniqueId))fail(400,'Invalid tracker identifier.');
        const limit=Math.min(500,Math.max(1,Number(url.searchParams.get('limit'))||200));
        return reply(res,200,{packets:await trackerPackets(logFile,uniqueId,limit)});
      }
      if(url.pathname==='/api/commands/send'&&req.method==='POST'){
        if(!req.headers['content-type']?.startsWith('application/json'))fail(415,'Send application/json.');
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>4096)fail(413,'Command request is too large.');chunks.push(chunk);}
        let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'Invalid command JSON.');}
        const custom=input?.type==='custom'&&input.textChannel===false&&commandAllowed(input.attributes?.data);
        if(!input||(input.type!=='positionSingle'&&!custom)||input.textChannel!==false)fail(403,'Only location queries and approved maintenance commands are allowed on this channel.');
        const id=deviceId(input.deviceId);
        const devices=(await request(`/devices?id=${id}`)).data;
        const device=devices.find(item=>item.id===id),lastUpdate=Date.parse(device?.lastUpdate);
        if(custom){
          // Some trackers (PT06) connect for a few seconds every minute and hang up, so there is rarely an
          // open socket. Approved maintenance text is harmless, so it may wait in the receiver's queue and
          // goes out at the next connection, as long as the tracker has been heard from in the last 10 minutes.
          if(!device||!Number.isFinite(lastUpdate)||now()-lastUpdate>600000||lastUpdate>now()+60000)fail(409,'No signal from this tracker in the last 10 minutes, so the command was not queued. Send it by SMS instead.');
          const result=await request('/commands/send',{method:'POST',body:JSON.stringify({deviceId:id,type:'custom',textChannel:false,attributes:{data:input.attributes.data}})});
          return reply(res,result.status,result.data);
        }
        // Location queries are only useful right now: never queue them for a tracker that is not connected.
        if(!device||device.status!=='online'||!Number.isFinite(lastUpdate)||now()-lastUpdate>300000||lastUpdate>now()+60000)fail(409,'Tracker is offline or has no recent connection. No command was queued.');
        const types=(await request(`/commands/types?deviceId=${id}&textChannel=false`)).data;
        if(!types.some(item=>item.type==='positionSingle'))fail(409,'Tracker does not support an on-demand location query.');
        // Never forward caller-supplied custom/relay payloads or queue a command
        // for delivery after the connection has gone stale.
        const result=await request('/commands/send',{method:'POST',body:JSON.stringify({deviceId:id,type:'positionSingle',textChannel:false,attributes:{noQueue:true}})});
        return reply(res,result.status,result.data);
      }
      fail(404,'Command channel route not found.');
    }catch(error){
      reply(res,error.status||502,{error:error.status?error.message:'Tracker receiver is unavailable.'});
    }
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const server=createCommandChannel({secret:process.env.GPS_GATEWAY_SECRET,traccarUrl:process.env.TRACCAR_URL,traccarToken:process.env.TRACCAR_TOKEN});
  server.listen(8181,'127.0.0.1',()=>console.log('GPS location command channel listening on loopback.'));
  process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
}
