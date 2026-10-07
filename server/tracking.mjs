import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrackingStore, fail, hash, token } from './tracking-store.mjs';
import { TraccarBridge } from './traccar.mjs';
import { RelayService } from './relay.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail(415,'Send application/json.');
  let data='';
  for await (const chunk of req) { data+=chunk; if (Buffer.byteLength(data)>16384) fail(413,'Request is too large.'); }
  try { const parsed=JSON.parse(data); if (!parsed || Array.isArray(parsed) || typeof parsed!=='object') throw Error(); return parsed; }
  catch { fail(400,'Invalid JSON object.'); }
}
export function createTrackingServer({store,adminToken,bridge=new TraccarBridge(store),publicOrigin,relayEnabled=false,staticDir=resolve(root,'dist')}={}) {
  if (!adminToken || adminToken.length<24) throw new Error('Admin token must contain at least 24 characters.');
  const sessions=new Map(), limits=new Map();
  const relay=new RelayService(store,bridge,{enabled:relayEnabled});
  const limited=(key,max,ms=60000)=>{
    const now=Date.now(); let slot=limits.get(key);
    if (!slot || slot.reset<=now) { slot={count:0,reset:now+ms}; limits.set(key,slot); }
    if (++slot.count>max) fail(429,'Too many requests. Try again shortly.');
  };
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://localhost'), path=url.pathname, method=req.method;
      if (path==='/api/gps/health') return json(res,200,{ok:true});
      if (!path.startsWith('/api/gps/')) {
        if (method!=='GET' && method!=='HEAD') fail(405,'Method not allowed.');
        const relative=decodeURIComponent(path)==='/'?'/index.html':decodeURIComponent(path);
        const target=resolve(staticDir,'.'+relative);
        if (!target.startsWith(staticDir+sep) || !existsSync(target) || !statSync(target).isFile()) fail(404,'Not found. Build the frontend with npm run build.');
        res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'})[extname(target)] || 'application/octet-stream');
        res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
        return res.end(method==='HEAD'?undefined:readFileSync(target));
      }
      const origin=req.headers.origin;
      const allowed=publicOrigin || `http://${req.headers.host}`;
      if (origin && origin!==allowed) fail(403,'Origin is not allowed.');
      limited(req.socket.remoteAddress,600);
      if (path==='/api/gps/session' && method==='POST') {
        limited(`login:${req.socket.remoteAddress}`,10);
        const input=await body(req);
        if (typeof input.token!=='string' || hash(input.token)!==hash(adminToken)) fail(401,'Incorrect workspace access key.');
        const session=token(); sessions.set(hash(session),{role:'admin',tenantId:'owner',name:'Workspace admin',expiresAt:Date.now()+12*3600000});
        res.setHeader('Set-Cookie',`waypoint_session=${session}; HttpOnly; SameSite=Strict; Path=/api/gps; Max-Age=43200${publicOrigin?.startsWith('https:')?'; Secure':''}`);
        return json(res,200,{ok:true});
      }
      if(path==='/api/gps/customers/session'&&method==='POST'){
        limited(`customer-login:${req.socket.remoteAddress}`,10);
        const input=await body(req),customer=store.customerLogin(input.email,input.password);
        const session=token();sessions.set(hash(session),{role:'customer',tenantId:customer.id,name:customer.name,email:customer.email,expiresAt:Date.now()+12*3600000});
        res.setHeader('Set-Cookie',`waypoint_session=${session}; HttpOnly; SameSite=Strict; Path=/api/gps; Max-Age=43200${publicOrigin?.startsWith('https:')?'; Secure':''}`);
        return json(res,200,{ok:true});
      }
      if (path.startsWith('/api/gps/sender/')) {
        if(path==='/api/gps/sender/join' && method==='POST'){
          limited(`join:${req.socket.remoteAddress}`,20);
          const joined=store.joinDriver((await body(req)).code);
          res.setHeader('Set-Cookie',`waypoint_sender=${joined.secret}; HttpOnly; SameSite=Strict; Path=/api/gps/sender; Max-Age=${Math.floor((joined.expiresAt-store.now())/1000)}${publicOrigin?.startsWith('https:')?'; Secure':''}`);
          return json(res,200,{device:{id:joined.device.id,name:joined.device.name,driver:joined.device.driver},expiresAt:joined.expiresAt});
        }
        const secret=req.headers.authorization?.replace(/^Bearer /,'');
        const senderCookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('waypoint_sender='))?.slice(16);
        const session=secret?null:store.driverSession(senderCookie);
        const device=session?.device || store.authenticateDevice(secret);
        limited(`device:${device.id}`,120);
        if(path==='/api/gps/sender/me' && method==='GET')return json(res,200,{device:{id:device.id,name:device.name,driver:device.driver},expiresAt:session?.expiresAt});
        if ((path==='/api/gps/sender/position'||path==='/api/gps/sender/heartbeat') && method==='POST') {
          const payload=await body(req);
          if(session && payload.deviceId!==device.id)fail(409,'This browser is connected to a different vehicle. Reopen your driver link.');
          if(path.endsWith('/position'))return json(res,200,store.ingest(device.id,payload));
          store.seen(device.id);return json(res,200,{ok:true,commands:store.commands(device.id)});
        }
        if (path==='/api/gps/sender/commands' && method==='GET') return json(res,200,{commands:store.commands(device.id)});
        fail(404,'Sender endpoint not found.');
      }
      const cookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('waypoint_session='))?.slice(17);
      const session=cookie&&sessions.get(hash(cookie));
      if (!session||session.expiresAt<=Date.now()) fail(401,'Sign in to your workspace.');
      if(session.role==='customer'&&!store.customer(session.tenantId).enabled)fail(403,'Customer access is disabled.');
      const ownsDevice=id=>{const d=store.raw(id);if(d.tenantId!==session.tenantId)fail(404,'Device not found.');return d;};
      if(path==='/api/gps/session'&&method==='GET')return json(res,200,{role:session.role,tenantId:session.tenantId,name:session.name,email:session.email||null});
      if (path==='/api/gps/session' && method==='DELETE') {
        sessions.delete(hash(cookie));res.setHeader('Set-Cookie','waypoint_session=; HttpOnly; SameSite=Strict; Path=/api/gps; Max-Age=0');return json(res,200,{ok:true});
      }
      if(path==='/api/gps/customers'&&method==='GET'){if(session.role!=='admin')fail(403,'Admin access required.');return json(res,200,{customers:store.customers()});}
      if(path==='/api/gps/customers'&&method==='POST'){if(session.role!=='admin')fail(403,'Admin access required.');return json(res,201,store.createCustomer(await body(req)));}
      const customerMatch=path.match(/^\/api\/gps\/customers\/([\w-]+)\/(reset|access)$/);
      if(customerMatch){
        if(session.role!=='admin')fail(403,'Admin access required.');
        const [,id,action]=customerMatch,input=await body(req);
        if(action==='reset'&&method==='POST'){
          const result=store.resetCustomer(id);for(const [key,value] of sessions)if(value.tenantId===id)sessions.delete(key);
          return json(res,200,result);
        }
        if(action==='access'&&method==='PUT'&&typeof input.enabled==='boolean'){
          const result=store.setCustomerEnabled(id,input.enabled);if(!input.enabled)for(const [key,value] of sessions)if(value.tenantId===id)sessions.delete(key);
          return json(res,200,result);
        }
      }
      if (path==='/api/gps/state' && method==='GET') {store.tick();return json(res,200,{devices:store.devices(session.tenantId),fences:store.fences(session.tenantId),alerts:store.alerts(session.tenantId),gateway:bridge.state,serverTime:Date.now()});}
      if (path==='/api/gps/devices' && method==='POST') {const result=store.createDevice(await body(req),session.tenantId);void bridge.sync();return json(res,201,result);}
      const deviceMatch=path.match(/^\/api\/gps\/devices\/([\w-]+)\/(history|ping|token|driver-link|relay)$/);
      if (deviceMatch) {
        const [,id,action]=deviceMatch,device=ownsDevice(id);
        if(action==='relay'&&method==='GET')return json(res,200,await relay.status(id));
        if(action==='relay'&&(method==='POST'||method==='PUT')){
          limited(`relay:${id}`,6);
          const input=await body(req);
          if(typeof input.adminKey!=='string')fail(403,'Workspace re-authentication is required for relay changes.');
          if(session.role==='admin'){if(hash(input.adminKey)!==hash(adminToken))fail(403,'Incorrect workspace key.');}
          else store.customerLogin(session.email,input.adminKey);
          return json(res,200,method==='PUT'?relay.configure(id,input):await relay.execute(id,input));
        }
        if(action==='driver-link' && method==='GET')return json(res,200,store.getDriverLink(id));
        if(action==='driver-link' && method==='POST'){const input=await body(req);return json(res,201,store.createDriverLink(id,{regenerate:input.regenerate===true}));}
        if(action==='driver-link' && method==='DELETE'){store.revokeDriverLinks(id);return json(res,200,{ok:true});}
        if (action==='history' && method==='GET') {
          const from=Date.parse(url.searchParams.get('from')),to=Date.parse(url.searchParams.get('to')),after=Number(url.searchParams.get('after') || 0);
          store.history(id,from,to,after);let warning=null;
          if(device.model!=='Mobile' && after===0){
            try{await bridge.importHistory(device,from,to)}catch(e){warning=`Showing locally stored history only. ${e.message}`}
          }
          return json(res,200,{...store.history(id,from,to,after),warning});
        }
        if (action==='token' && method==='POST') {await body(req);return json(res,200,{token:store.rotateToken(id)});}
        if (action==='ping' && method==='POST') {
          await body(req);limited(`ping:${id}`,6);
          const command=store.queue(id);
          if (device.model!=='Mobile' && command.detail==='Waiting for the sender.') {
            store.updateCommand(command.id,'dispatching','Submitting request to gateway.');
            try { const sent=await bridge.ping(device);store.updateCommand(command.id,sent.status,sent.detail); }
            catch(e) {store.updateCommand(command.id,'failed',e.message);}
          }
          return json(res,202,store.device(id).command);
        }
      }
      if (path==='/api/gps/fences' && method==='POST') return json(res,201,store.addFence(await body(req),session.tenantId));
      const fenceMatch=path.match(/^\/api\/gps\/fences\/([\w-]+)$/);
      if (fenceMatch && method==='DELETE') {store.deleteFence(fenceMatch[1],session.tenantId);return json(res,200,{ok:true});}
      const alertMatch=path.match(/^\/api\/gps\/alerts\/([\w-]+)\/ack$/);
      if (alertMatch && method==='POST') {await body(req);store.acknowledge(alertMatch[1],session.tenantId);return json(res,200,{ok:true});}
      fail(404,'Endpoint not found.');
    } catch(e) {if (!res.headersSent) json(res,e.status || 500,{error:e.status?e.message:'The tracking service could not complete this request.'}); else res.end();}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  const timer=setInterval(()=>{
    store.tick();void bridge.sync();
    for(const [key,session] of sessions) if(session.expiresAt<=Date.now()) sessions.delete(key);
    for(const [key,slot] of limits) if(slot.reset<=Date.now()) limits.delete(key);
  },5000);
  timer.unref();server.on('close',()=>clearInterval(timer));
  return server;
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const privateDir=resolve(root,'server/private');mkdirSync(privateDir,{recursive:true,mode:0o700});
  const secretPath=resolve(privateDir,'admin-token');
  if (!process.env.GPS_ADMIN_TOKEN && !existsSync(secretPath)) writeFileSync(secretPath,token(),{mode:0o600,flag:'wx'});
  const adminToken=process.env.GPS_ADMIN_TOKEN || readFileSync(secretPath,'utf8').trim();
  const store=new TrackingStore(process.env.GPS_DB || resolve(privateDir,'tracking.sqlite'));
  const bridge=new TraccarBridge(store,{url:process.env.TRACCAR_URL,token:process.env.TRACCAR_TOKEN});
  const server=createTrackingServer({store,adminToken,bridge,publicOrigin:process.env.GPS_PUBLIC_ORIGIN,relayEnabled:process.env.GPS_RELAY_ENABLED==='true'});
  const port=Number(process.env.GPS_PORT || 5180),host=process.env.GPS_HOST || '127.0.0.1';
  server.listen(port,host,()=>{console.log(`Waypoint GPS: http://${host}:${port}`);console.log(`Workspace access key: ${secretPath}`);void bridge.sync();});
  const shutdown=()=>{server.close(()=>{store.close();process.exit(0)});server.closeAllConnections();};
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
