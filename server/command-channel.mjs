import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const digest=value=>createHash('sha256').update(value).digest();
export function createCommandChannel({secret,traccarUrl,traccarToken,fetcher=fetch,now=()=>Date.now()}){
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
      if(url.pathname==='/api/commands/send'&&req.method==='POST'){
        if(!req.headers['content-type']?.startsWith('application/json'))fail(415,'Send application/json.');
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>4096)fail(413,'Command request is too large.');chunks.push(chunk);}
        let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'Invalid command JSON.');}
        if(!input||input.type!=='positionSingle'||input.textChannel!==false)fail(403,'Only location queries are allowed on this channel.');
        const id=deviceId(input.deviceId);
        const devices=(await request(`/devices?id=${id}`)).data;
        const device=devices.find(item=>item.id===id),lastUpdate=Date.parse(device?.lastUpdate);
        if(!device||device.status!=='online'||!Number.isFinite(lastUpdate)||now()-lastUpdate>180000||lastUpdate>now()+60000)fail(409,'Tracker is offline or has no recent connection. No command was queued.');
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
