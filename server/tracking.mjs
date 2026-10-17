import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrackingStore, fail, hash, token } from './tracking-store.mjs';
import { TraccarBridge } from './traccar.mjs';
import { RelayService } from './relay.mjs';
import { vehicleReport } from './reports.mjs';
import { landmarks } from './landmarks.mjs';
import { suggestedStops } from './stops.mjs';
import { dieselPrices } from './fuel.mjs';
import { commandAllowed } from './command-channel.mjs';
import { signalBars } from './extra.mjs';
import { cleanSubscription, deliverPushes, vapidKeys } from './push.mjs';
import { powerTimeline } from './extra.mjs';
import { apnFor, bootstrapSms, buildPlan, cleanIntervals, OPERATORS } from './provision.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
// Admin maintenance macros, translated to the tracker family's own command text.
const GT06_MODELS=['GT06','GT06N','PT06'];
export function commandText(model,action,input={}){
  const gt06=GT06_MODELS.includes(model),seconds=(v,min)=>{const n=Number(v);if(!Number.isInteger(n)||n<min||n>18000)fail(400,`Interval must be ${min}-18000 seconds.`);return n};
  const text=gt06?({
    reboot:()=>'RESET#',status:()=>'STATUS#',settings:()=>'PARAM#',version:()=>'VERSION#',where:()=>'WHERE#',network:()=>'GPRSSET#',gprsOn:()=>'GPRSON,1#',
    accReport:()=>`ACCREP,${input.on===false?'OFF':'ON'}#`,
    batchOff:()=>'BATCH,OFF#',
    // Minutes the GPS keeps running after the tracker is woken; 0 means it never sleeps.
    gpsAlwaysOn:()=>'SENDS,0#',
    gpsSleepRead:()=>'SENDS#',
    timezone:()=>`GMT,${input.west?'W':'E'},${Number(input.hours)},${Number(input.minutes)||0}#`,
    interval:()=>`TIMER,${seconds(input.moving,5)},${seconds(input.parked,5)}#`,
    apn:()=>`APN,${[input.apn,...(input.user||input.password?[input.user||'',input.password||'']:[])].join(',')}#`,
    server:()=>`SERVER,${/^\d{1,3}(\.\d{1,3}){3}$/.test(String(input.host))?0:1},${input.host},${input.port},0#`,
  }[action]):model==='Mobile'?undefined:({reboot:()=>'cpureset',status:()=>'getstatus',version:()=>'getver',where:()=>'getgps',settings:()=>'getinfo'}[action]);
  if(!text)fail(400,model==='Mobile'?'Phone-based vehicles do not take tracker commands.':'This command is not available for this tracker model.');
  const value=text();
  if(!commandAllowed(value))fail(400,'Command values are not valid.');
  return value;
}
// Customers see their vehicles, never tracker identifiers, receiver state or command plumbing.
const customerPosition=p=>p&&{id:p.id,recordedAt:p.recordedAt,latitude:p.latitude,longitude:p.longitude,speed:p.speed,heading:p.heading,ignition:p.ignition,battery:p.battery,satellites:p.satellites,valid:p.valid};
export const customerDevice=d=>({id:d.id,name:d.name,driver:d.driver,vehicleType:d.vehicleType||null,makeModel:d.makeModel||null,modelYear:d.modelYear??null,fuelType:d.fuelType||null,capacityKg:d.capacityKg??null,registration:d.registration||null,ownerName:d.ownerName||null,vehicleNotes:d.vehicleNotes||null,status:d.status,online:d.online,fresh:d.fresh,lastSeen:d.lastSeen,speedLimit:d.speedLimit,speedAlert:Number(d.speedAlert??1)!==0,driverPhone:d.driverPhone||'',parkLock:Number(d.parkLock||0)!==0,parkAlerted:Number(d.parkAlerted||0)!==0,signal:d.online?signalBars(d.rssi):0,ignition:d.ignition,stoppedSince:d.stoppedSince,isMobile:d.model==='Mobile',position:customerPosition(d.position)});
async function body(req,maxBytes=16384) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail(415,'Send application/json.');
  if(req.body!==undefined){
    try{const value=typeof req.body==='string'||Buffer.isBuffer(req.body)?JSON.parse(String(req.body)):req.body;
      if(Buffer.byteLength(JSON.stringify(value))>maxBytes)fail(413,'Request is too large.');
      if(!value||Array.isArray(value)||typeof value!=='object')fail(400,'Invalid JSON object.');return value;
    }catch(error){if(error.status)throw error;fail(400,'Invalid JSON object.');}
  }
  const chunks=[];let bytes=0;
  for await (const chunk of req) { bytes+=chunk.length; if (bytes>maxBytes) fail(413,'Request is too large.'); chunks.push(chunk); }
  try { const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!parsed || Array.isArray(parsed) || typeof parsed!=='object') throw Error(); return parsed; }
  catch { fail(400,'Invalid JSON object.'); }
}
export function createTrackingServer({store,adminToken,bridge=new TraccarBridge(store),publicOrigin,frontendOrigin=process.env.GPS_FRONTEND_ORIGIN,relayEnabled=false,backgroundTasks=true,sessionStore=new Map(),rateLimit,clientAddressResolver,staticDir=resolve(root,'dist')}={}) {
  if (!adminToken || adminToken.length<24) throw new Error('Admin token must contain at least 24 characters.');
  const sessions=sessionStore, limits=new Map();
  const generationKey=id=>`tenant-generation:${id}`;
  const saveSession=async(key,value)=>{
    if(value.role==='customer')value.generation=(await sessions.get(generationKey(value.tenantId)))??null;
    await sessions.set(key,value);
  };
  const relay=new RelayService(store,bridge,{enabled:relayEnabled});
  // Phone push never delays or breaks the request that created the alert.
  const push=async()=>{try{await deliverPushes(store,{origin:publicOrigin})}catch(e){console.warn('Push delivery failed:',e.message)}};
  const limited=async(key,max,ms=60000)=>{
    if(rateLimit)return await rateLimit(key,max,ms);
    const now=Date.now(); let slot=limits.get(key);
    if (!slot || slot.reset<=now) { slot={count:0,reset:now+ms}; limits.set(key,slot); }
    if (++slot.count>max) fail(429,'Too many requests. Try again shortly.');
  };
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  const server=createServer(async(req,res)=>{
    try {
      await relay.ready;
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
      const allowed=[publicOrigin || `http://${req.headers.host}`,frontendOrigin].filter(Boolean);
      if (origin && !allowed.includes(origin)) fail(403,'Origin is not allowed.');
      const remoteAddress=req.socket.remoteAddress;
      const forwarded=String(req.headers['x-forwarded-for']||'').split(',').at(-1).trim();
      // Only the local production reverse proxy can supply client addresses.
      const clientAddress=clientAddressResolver?clientAddressResolver(req):publicOrigin&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remoteAddress)&&isIP(forwarded)?forwarded:remoteAddress;
      await limited(clientAddress,600);
      if (path==='/api/gps/session' && method==='POST') {
        await limited(`login:${clientAddress}`,10);
        const input=await body(req);
        if (typeof input.token!=='string' || hash(input.token)!==hash(adminToken)) fail(401,'Incorrect workspace access key.');
        const session=token(); await saveSession(hash(session),{role:'admin',tenantId:'owner',name:'Workspace admin',expiresAt:Date.now()+12*3600000});
        res.setHeader('Set-Cookie',`waypoint_session=${session}; HttpOnly; SameSite=Strict; Path=/api/gps; Max-Age=43200${publicOrigin?.startsWith('https:')?'; Secure':''}`);
        return json(res,200,{ok:true});
      }
      if(path==='/api/gps/admin/create'&&method==='POST'){
        // Recovery/bootstrap only: needs the server maintenance key. The password is random and shown once.
        await limited(`login:${clientAddress}`,10);
        const input=await body(req);
        if(typeof input.token!=='string'||hash(input.token)!==hash(adminToken))fail(401,'Incorrect workspace access key.');
        return json(res,201,await store.createAdmin(input.email));
      }
      if(path==='/api/gps/admin/reset-password'&&method==='POST'){
        // Recovery only: the server maintenance key already grants full admin access.
        await limited(`login:${clientAddress}`,10);
        const input=await body(req);
        if(typeof input.token!=='string'||hash(input.token)!==hash(adminToken))fail(401,'Incorrect workspace access key.');
        return json(res,200,await store.resetAdminPassword(input.email,input.newPassword));
      }
      if(path==='/api/gps/admin/session'&&method==='POST'){
        await limited(`admin-login:${clientAddress}`,10);
        const input=await body(req),admin=await store.adminLogin(input.email,input.password);
        const session=token();await saveSession(hash(session),{role:'admin',tenantId:'owner',name:'Workspace admin',email:admin.email,expiresAt:Date.now()+12*3600000});
        res.setHeader('Set-Cookie',`waypoint_session=${session}; HttpOnly; SameSite=Strict; Path=/api/gps; Max-Age=43200${publicOrigin?.startsWith('https:')?'; Secure':''}`);
        return json(res,200,{ok:true});
      }
      if(path==='/api/gps/customers/register'&&method==='POST'){
        await limited(`register:${clientAddress}`,5,3600000);
        const customer=await store.registerCustomer(await body(req));
        const session=token();await saveSession(hash(session),{role:'customer',tenantId:customer.id,name:customer.name,email:customer.email,expiresAt:Date.now()+12*3600000});
        res.setHeader('Set-Cookie',`waypoint_session=${session}; HttpOnly; SameSite=Strict; Path=/api/gps; Max-Age=43200${publicOrigin?.startsWith('https:')?'; Secure':''}`);
        return json(res,201,{role:'customer',tenantId:customer.id,name:customer.name,email:customer.email});
      }
      if(path==='/api/gps/customers/session'&&method==='POST'){
        await limited(`customer-login:${clientAddress}`,10);
        const input=await body(req),customer=await store.customerLogin(input.email,input.password);
        const session=token();await saveSession(hash(session),{role:'customer',tenantId:customer.id,name:customer.name,email:customer.email,expiresAt:Date.now()+12*3600000});
        res.setHeader('Set-Cookie',`waypoint_session=${session}; HttpOnly; SameSite=Strict; Path=/api/gps; Max-Age=43200${publicOrigin?.startsWith('https:')?'; Secure':''}`);
        return json(res,200,{ok:true});
      }
      if (path.startsWith('/api/gps/sender/')) {
        if(path==='/api/gps/sender/join' && method==='POST'){
          await limited(`join:${clientAddress}`,20);
          const joined=await store.joinDriver((await body(req)).code);
          res.setHeader('Set-Cookie',`waypoint_sender=${joined.secret}; HttpOnly; SameSite=Strict; Path=/api/gps/sender; Max-Age=${Math.floor((joined.expiresAt-store.now())/1000)}${publicOrigin?.startsWith('https:')?'; Secure':''}`);
          return json(res,200,{device:{id:joined.device.id,name:joined.device.name,driver:joined.device.driver},expiresAt:joined.expiresAt});
        }
        const secret=req.headers.authorization?.replace(/^Bearer /,'');
        const senderCookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('waypoint_sender='))?.slice(16);
        const session=secret?null:await store.driverSession(senderCookie);
        const device=session?.device || await store.authenticateDevice(secret);
        await limited(`device:${device.id}`,120);
        if(path==='/api/gps/sender/me' && method==='GET')return json(res,200,{device:{id:device.id,name:device.name,driver:device.driver},expiresAt:session?.expiresAt});
        if ((path==='/api/gps/sender/position'||path==='/api/gps/sender/heartbeat') && method==='POST') {
          const payload=await body(req);
          if(session && payload.deviceId!==device.id)fail(409,'This browser is connected to a different vehicle. Reopen your driver link.');
          if(path.endsWith('/position')){const result=await store.ingest(device.id,payload);await push();return json(res,200,result);}
          await store.seen(device.id);const commands=await store.commands(device.id);await push();return json(res,200,{ok:true,commands});
        }
        if (path==='/api/gps/sender/stopped' && method==='POST') {
          const payload=await body(req);
          if(session && payload.deviceId!==device.id)fail(409,'This browser is connected to a different vehicle. Reopen your driver link.');
          await store.sharingStopped(device.id,typeof payload.reason==='string'?payload.reason:'stopped');await push();return json(res,200,{ok:true});
        }
        if (path==='/api/gps/sender/commands' && method==='GET') return json(res,200,{commands:await store.commands(device.id)});
        fail(404,'Sender endpoint not found.');
      }
      const cookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('waypoint_session='))?.slice(17);
      const session=cookie&&await sessions.get(hash(cookie));
      if (!session||session.expiresAt<=Date.now()) {
        if(cookie)await sessions.delete(hash(cookie));
        fail(401,'Sign in to your workspace.');
      }
      if(session.role==='customer'&&session.generation!==((await sessions.get(generationKey(session.tenantId)))??null))fail(401,'Sign in to your workspace.');
      if(session.role==='customer'&&!(await store.customer(session.tenantId)).enabled)fail(403,'Customer access is disabled.');
      // Admins manage every customer's devices; customers only their own.
      const ownsDevice=async id=>{const d=await store.raw(id);if(session.role!=='admin'&&d.tenantId!==session.tenantId)fail(404,'Device not found.');return d;};
      if(path==='/api/gps/session'&&method==='GET')return json(res,200,{role:session.role,tenantId:session.tenantId,name:session.name,email:session.email||null});
      const dataMatch=path.match(/^\/api\/gps\/workspace\/(documents|bills|preferences|ack)$/);
      if(dataMatch){
        const key=dataMatch[1];
        if(method==='GET')return json(res,200,{value:await store.workspaceData(session.tenantId,key)});
        if(method==='PUT')return json(res,200,await store.saveWorkspaceData(session.tenantId,key,(await body(req,26*1024*1024)).value));
        fail(405,'Method not allowed.');
      }
      if(path==='/api/gps/account/password'&&method==='POST'){
        await limited(`password:${clientAddress}`,10);
        if(!session.email)fail(400,'Sign in with your admin email and password to change it.');
        const input=await body(req);
        await store.changePassword(session.role==='admin'?'admin':'customer',session.email,input.currentPassword,input.newPassword);
        if(session.role==='customer'){
          // Sign out every other device of this customer, then keep this browser signed in.
          await sessions.set(generationKey(session.tenantId),token());
          await sessions.delete(hash(cookie));
          const fresh=token();await saveSession(hash(fresh),{role:'customer',tenantId:session.tenantId,name:session.name,email:session.email,expiresAt:Date.now()+12*3600000});
          res.setHeader('Set-Cookie',`waypoint_session=${fresh}; HttpOnly; SameSite=Strict; Path=/api/gps; Max-Age=43200${publicOrigin?.startsWith('https:')?'; Secure':''}`);
        }
        return json(res,200,{ok:true});
      }
      if (path==='/api/gps/session' && method==='DELETE') {
        await sessions.delete(hash(cookie));res.setHeader('Set-Cookie','waypoint_session=; HttpOnly; SameSite=Strict; Path=/api/gps; Max-Age=0');return json(res,200,{ok:true});
      }
      if(path==='/api/gps/customers'&&method==='GET'){if(session.role!=='admin')fail(403,'Admin access required.');return json(res,200,{customers:await store.customers()});}
      if(path==='/api/gps/customers'&&method==='POST'){if(session.role!=='admin')fail(403,'Admin access required.');return json(res,201,await store.createCustomer(await body(req)));}
      const customerMatch=path.match(/^\/api\/gps\/customers\/([\w-]+)\/(reset|access)$/);
      if(customerMatch){
        if(session.role!=='admin')fail(403,'Admin access required.');
        const [,id,action]=customerMatch,input=await body(req);
        if(action==='reset'&&method==='POST'){
          const result=await store.resetCustomer(id);await sessions.set(generationKey(id),token());
          return json(res,200,result);
        }
        if(action==='access'&&method==='PUT'&&typeof input.enabled==='boolean'){
          const result=await store.setCustomerEnabled(id,input.enabled);if(!input.enabled)await sessions.set(generationKey(id),token());
          return json(res,200,result);
        }
      }
      // Phones subscribe for push alerts of their own fleet.
      if(path==='/api/gps/push'&&method==='GET')return json(res,200,{key:(await vapidKeys(store)).publicKey});
      if(path==='/api/gps/push'&&method==='POST'){await limited(`push:${session.tenantId}`,30);return json(res,200,await store.savePushSub(session.tenantId,cleanSubscription(await body(req))));}
      if(path==='/api/gps/push'&&method==='DELETE'){const input=await body(req);await store.deletePushSub(String(input.endpoint||''),session.tenantId);return json(res,200,{ok:true});}
      if (path==='/api/gps/state' && method==='GET') {
        await store.tick();await push();const devices=await store.devices(session.tenantId);
        if(session.role==='customer')return json(res,200,{devices:devices.map(customerDevice),fences:await store.fences(session.tenantId),alerts:await store.alerts(session.tenantId),serverTime:Date.now()});
        return json(res,200,{devices,fences:await store.fences(session.tenantId),alerts:await store.alerts(session.tenantId),gateway:bridge.state,serverTime:Date.now()});
      }
      if(path==='/api/gps/landmarks'&&method==='GET'){
        await limited(`landmarks:${session.tenantId}`,120);
        try{return json(res,200,await landmarks(store,url.searchParams.get('tile')))}
        catch(e){if(e.status)throw e;fail(503,'Nearby places are unavailable right now.')}
      }
      if(path==='/api/gps/buy'&&method==='GET')return json(res,200,{requests:(await store.gpsRequests(session.tenantId)).map(({tenantId,customerName,...r})=>r)});
      if(path==='/api/gps/buy'&&method==='POST'){await limited(`buy:${session.tenantId}`,5);return json(res,201,await store.addGpsRequest(session.tenantId,await body(req)))}
      if(path==='/api/gps/fuel'&&method==='GET'){await limited(`fuel:${session.tenantId}`,60);return json(res,200,await dieselPrices(store))}
      if(path==='/api/gps/stops'&&method==='GET'){
        const days=Number(url.searchParams.get('days')??14);
        if(!Number.isInteger(days)||days<1||days>31)fail(400,'Choose 1-31 days.');
        await limited(`stops:${session.tenantId}`,10);
        const to=Date.now(),devices=await store.devices(session.tenantId);
        return json(res,200,{stops:await suggestedStops(store,devices,await store.fences(session.tenantId),to-days*86400000,to)});
      }
      if(path==='/api/gps/reports'&&method==='GET'){
        const from=Date.parse(url.searchParams.get('from')),to=Date.parse(url.searchParams.get('to')),tz=Number(url.searchParams.get('tz')??-330);
        if(!Number.isFinite(from)||!Number.isFinite(to)||from>to||to-from>31*86400000)fail(400,'Choose a valid date range of up to 31 days.');
        if(!Number.isInteger(tz)||Math.abs(tz)>840)fail(400,'Invalid time zone.');
        await limited(`report:${session.tenantId}`,20);
        const only=url.searchParams.get('device');
        const devices=(await store.devices(session.tenantId)).filter(d=>!only||d.id===only);
        return json(res,200,await vehicleReport(store,devices,from,to,tz));
      }
      if(path.startsWith('/api/gps/admin/')){
        if(session.role!=='admin')fail(403,'Admin access required.');
        if(path==='/api/gps/admin/overview'&&method==='GET'){
          const [devices,customers,admins]=[await store.devices(),await store.customers(),await store.admins()];
          const count=status=>devices.filter(d=>d.status===status).length;
          return json(res,200,{customers:{total:customers.length,enabled:customers.filter(c=>c.enabled).length},
            devices:{total:devices.length,moving:count('Moving'),stopped:count('Stopped'),offline:count('Offline'),waiting:count('Waiting'),noFix:count('No GPS fix'),unassigned:devices.filter(d=>d.tenantId==='owner').length},
            gateway:bridge.state,admins:admins.map(a=>a.email),serverTime:Date.now()});
        }
        if(path==='/api/gps/admin/devices'&&method==='GET'){
          const names=new Map((await store.customers()).map(c=>[c.id,c.name]));
          return json(res,200,{devices:(await store.devices()).map(d=>({...d,customerId:d.tenantId==='owner'?null:d.tenantId,customerName:names.get(d.tenantId)||null})),gateway:bridge.state});
        }
        if(path==='/api/gps/admin/devices'&&method==='POST'){
          const input=await body(req);const tenant=input.customerId?String(input.customerId):'owner';
          if(tenant!=='owner')await store.customer(tenant);
          const result=await store.createDevice(input,tenant);
          // SIM details, then the automatic set-up that runs after the tracker's first connection.
          const setup={...input};if(setup.apn===undefined&&setup.simOperator)setup.apn=apnFor(setup.simOperator,setup.simType);
          let raw=await store.setDeviceSetup(result.device.id,setup);
          const plan=input.autoSetup===false?[]:buildPlan(raw,cleanIntervals(input));
          if(plan.length)await store.provisionReplace(result.device.id,plan);
          if(backgroundTasks)void bridge.sync();
          return json(res,201,{...result,provisioning:{steps:await store.provisionSteps(result.device.id),sms:bootstrapSms(raw,bridge.state)}});
        }
        const adminDevice=path.match(/^\/api\/gps\/admin\/devices\/([\w-]+)$/);
        if(adminDevice&&method==='GET'){
          const id=adminDevice[1],device=await store.device(id),tz=Number(url.searchParams.get('tz')??-330);
          let customer=null;if(device.tenantId!=='owner')try{customer=await store.customer(device.tenantId)}catch{/* customer removed */}
          // Today in the admin's own time zone.
          const start=new Date(Date.now()-tz*60000);start.setUTCHours(0,0,0,0);const from=start.getTime()+tz*60000;
          const today=(await vehicleReport(store,[device],from,Date.now(),Number.isInteger(tz)?tz:-330)).vehicles[0]?.days.at(-1)||null;
          return json(res,200,{device:{...device,customerId:customer?.id||null,customerName:customer?.name||null},packets:await store.recentPackets(id,100),alerts:await store.deviceAlerts(id,20),commands:await store.deviceCommands(id,20),provisioning:{steps:await store.provisionSteps(id),sms:bootstrapSms(await store.raw(id),bridge.state),operators:Object.fromEntries(Object.entries(OPERATORS).map(([k,v])=>[k,{label:v.label,apn:v.apn}]))},power:powerTimeline(await store.powerRows(id,Date.now()-3*86400000)),sim:{iccid:await store.latestIccid(id)},today,gateway:bridge.state});
        }
        const clockMatch=path.match(/^\/api\/gps\/admin\/devices\/([\w-]+)\/clock-fix$/);
        if(clockMatch&&method==='POST'){
          const minutes=Number((await body(req)).minutes);
          if(!Number.isInteger(minutes)||minutes<30||minutes>840||minutes%15)fail(400,'Shift must be a time-zone offset of 30 to 840 minutes.');
          return json(res,200,{shifted:await store.shiftClock(clockMatch[1],minutes)});
        }
        const provisionMatch=path.match(/^\/api\/gps\/admin\/devices\/([\w-]+)\/provision$/);
        if(provisionMatch&&method==='POST'){
          const id=provisionMatch[1],input=await body(req);let raw=await store.raw(id);
          if(input.action==='cancel'){await store.provisionReplace(id,[]);return json(res,200,{steps:[]})}
          if(input.action!=='start')fail(400,'Unknown set-up action.');
          if(input.simOperator!==undefined||input.simType!==undefined||input.apn!==undefined||input.apnUser!==undefined||input.apnPass!==undefined||input.simNumber!==undefined){
            const setup={...input};if(setup.apn===undefined&&setup.simOperator)setup.apn=apnFor(setup.simOperator,setup.simType);raw=await store.setDeviceSetup(id,setup);
          }
          const plan=buildPlan(raw,cleanIntervals(input));if(!plan.length)fail(400,'This vehicle needs no tracker set-up.');
          await store.provisionReplace(id,plan);
          return json(res,200,{steps:await store.provisionSteps(id),sms:bootstrapSms(raw,bridge.state)});
        }
        const adminDeviceAction=path.match(/^\/api\/gps\/admin\/devices\/([\w-]+)\/(packets|command)$/);
        if(adminDeviceAction){
          const [,id,action]=adminDeviceAction,device=await store.raw(id);
          if(action==='packets'&&method==='GET'){
            try{return json(res,200,{packets:await bridge.packets(device,Number(url.searchParams.get('limit'))||200)})}
            catch(e){fail(502,`Raw packets are unavailable: ${e.message}`)}
          }
          if(action==='command'&&method==='POST'){
            await limited(`command:${id}`,10);
            const input=await body(req),text=commandText(device.model,String(input.action||''),input);
            try{const sent=await bridge.sendText(device,text);return json(res,200,await store.recordCommand(id,sent,`CMD ${text} sent over GPRS.`))}
            catch(e){await store.recordCommand(id,'failed',`CMD ${text} not sent: ${e.message}`);fail(409,e.message)}
          }
        }
        if(adminDevice&&method==='PATCH'){
          const input=await body(req),updated=await store.updateDevice(adminDevice[1],input);
          if(['simOperator','simType','simNumber','apn','apnUser','apnPass'].some(k=>input[k]!==undefined)){const setup={...input};if(setup.apn===undefined&&setup.simOperator)setup.apn=apnFor(setup.simOperator,setup.simType);await store.setDeviceSetup(adminDevice[1],setup)}
          return json(res,200,{...updated,...(await store.device(adminDevice[1]))});
        }
        if(adminDevice&&method==='DELETE'){await store.deleteDevice(adminDevice[1]);return json(res,200,{ok:true});}
        if(path==='/api/gps/admin/requests'&&method==='GET')return json(res,200,{requests:await store.gpsRequests()});
        const requestMatch=path.match(/^\/api\/gps\/admin\/requests\/([\w-]+)$/);
        if(requestMatch&&method==='PATCH'){await store.setGpsRequestStatus(requestMatch[1],(await body(req)).status);return json(res,200,{ok:true})}
        if(path==='/api/gps/admin/admins'&&method==='GET')return json(res,200,{admins:await store.admins()});
        if(path==='/api/gps/admin/admins'&&method==='POST')return json(res,201,await store.createAdmin((await body(req)).email));
        const adminMatch=path.match(/^\/api\/gps\/admin\/admins\/([^/]+)$/);
        if(adminMatch&&method==='DELETE'){
          const target=decodeURIComponent(adminMatch[1]).toLowerCase();
          if(session.email&&target===session.email.toLowerCase())fail(409,'You cannot remove the account you are signed in with.');
          return json(res,200,await store.removeAdmin(target));
        }
        fail(404,'Endpoint not found.');
      }
      if (path==='/api/gps/devices' && method==='POST') {if(session.role!=='admin')fail(403,'Only your fleet administrator can add devices.');const result=await store.createDevice(await body(req),session.tenantId);if(backgroundTasks)void bridge.sync();return json(res,201,result);}
      // Owners set their own overspeed limit and switch the alert on or off per vehicle.
      const speedMatch=path.match(/^\/api\/gps\/devices\/([\w-]+)\/speed$/);
      if(speedMatch&&method==='PUT'){
        await ownsDevice(speedMatch[1]);const input=await body(req),change={};
        if(input.speedLimit!==undefined)change.speedLimit=input.speedLimit;
        if(input.speedAlert!==undefined){if(typeof input.speedAlert!=='boolean')fail(400,'Overspeed alert must be on or off.');change.speedAlert=input.speedAlert;}
        const d=await store.updateDevice(speedMatch[1],change);
        return json(res,200,{speedLimit:d.speedLimit,speedAlert:Number(d.speedAlert??1)!==0});
      }
      // Owners lock a parked vehicle (alert if it starts or moves) and keep the driver's number for calls.
      const ownerMatch=path.match(/^\/api\/gps\/devices\/([\w-]+)\/(park|driver-phone)$/);
      if(ownerMatch&&method==='PUT'){
        const [,id,what]=ownerMatch;await ownsDevice(id);const input=await body(req);
        const d=what==='park'?await store.setParkLock(id,input.on):await store.setDriverPhone(id,input.phone);
        return json(res,200,customerDevice(d));
      }
      const deviceMatch=path.match(/^\/api\/gps\/devices\/([\w-]+)\/(history|ping|token|driver-link|relay)$/);
      if (deviceMatch) {
        const [,id,action]=deviceMatch,device=await ownsDevice(id);
        if(session.role==='customer'&&!(action==='history'||(action==='driver-link'&&device.model==='Mobile')||(action==='relay'&&method!=='PUT')))fail(403,'Not available for customer accounts.');
        if(action==='relay'&&method==='GET')return json(res,200,session.role==='customer'?await relay.customerStatus(id):await relay.status(id));
        if(action==='relay'&&(method==='POST'||method==='PUT')){
          await limited(`relay:${id}`,6);
          const input=await body(req);
          if(typeof input.adminKey!=='string')fail(403,'Workspace re-authentication is required for relay changes.');
          // A wrong password must not end the session (a 401 signs the app out), so it is a 403 here.
          try{
            if(session.role==='admin'){if(session.email)await store.adminLogin(session.email,input.adminKey);else if(hash(input.adminKey)!==hash(adminToken))fail(403,'Incorrect workspace key.');}
            else await store.customerLogin(session.email,input.adminKey);
          }catch(e){if(e.status===401)fail(403,'Incorrect password.');throw e;}
          if(method==='PUT')return json(res,200,await relay.configure(id,input));
          const done=await relay.execute(id,input,session.role==='customer'?`customer:${session.email}`:session.email?`admin:${session.email}`:'workspace-admin');
          return json(res,200,session.role==='customer'?{action:done.action,status:done.status,detail:done.status==='sent-unverified'?'':done.detail,createdAt:Number(done.createdAt)}:done);
        }
        if(action==='driver-link' && method==='GET')return json(res,200,await store.getDriverLink(id));
        if(action==='driver-link' && method==='POST'){const input=await body(req);return json(res,201,await store.createDriverLink(id,{regenerate:input.regenerate===true,...(input.hours!==undefined?{hours:input.hours}:{})}));}
        if(action==='driver-link' && method==='DELETE'){await store.revokeDriverLinks(id);return json(res,200,{ok:true});}
        if (action==='history' && method==='GET') {
          const from=Date.parse(url.searchParams.get('from')),to=Date.parse(url.searchParams.get('to')),after=Number(url.searchParams.get('after') || 0);
          await store.history(id,from,to,after);let warning=null;
          if(device.model!=='Mobile' && after===0){
            try{await bridge.importHistory(device,from,to)}catch(e){warning=`Showing locally stored history only. ${e.message}`}
          }
          return json(res,200,{...await store.history(id,from,to,after),warning:session.role==='customer'?null:warning});
        }
        if (action==='token' && method==='POST') {await body(req);return json(res,200,{token:await store.rotateToken(id)});}
        if (action==='ping' && method==='POST') {
          await body(req);await limited(`ping:${id}`,6);
          const command=await store.queue(id);
          if (device.model!=='Mobile' && command.detail==='Waiting for the sender.') {
            await store.updateCommand(command.id,'dispatching','Submitting request to gateway.');
            try { const sent=await bridge.ping(device);await store.updateCommand(command.id,sent.status,sent.detail); }
            catch(e) {await store.updateCommand(command.id,'failed',e.message);}
          }
          return json(res,202,(await store.device(id)).command);
        }
      }
      if (path==='/api/gps/fences' && method==='POST') return json(res,201,await store.addFence(await body(req),session.tenantId));
      const fenceMatch=path.match(/^\/api\/gps\/fences\/([\w-]+)$/);
      if (fenceMatch && method==='PUT') return json(res,200,await store.updateFence(fenceMatch[1],session.tenantId,await body(req)));
      if (fenceMatch && method==='DELETE') {await store.deleteFence(fenceMatch[1],session.tenantId);return json(res,200,{ok:true});}
      const alertMatch=path.match(/^\/api\/gps\/alerts\/([\w-]+)\/ack$/);
      if (alertMatch && method==='POST') {await body(req);await store.acknowledge(alertMatch[1],session.tenantId);return json(res,200,{ok:true});}
      fail(404,'Endpoint not found.');
    } catch(e) {if (!res.headersSent) json(res,e.status || 500,{error:e.status?e.message:'The tracking service could not complete this request.'}); else res.end();}
  });
  server.requestTimeout=60000;server.headersTimeout=10000;
  if(backgroundTasks){
    let working=false;
    const timer=setInterval(async()=>{
      if(working)return;
      working=true;
      try{
        await store.tick();await bridge.sync();await push();
        if(sessions instanceof Map)for(const [key,session] of sessions)if(session?.expiresAt<=Date.now())await sessions.delete(key);
        for(const [key,slot] of limits)if(slot.reset<=Date.now())limits.delete(key);
      }catch(e){console.error('Tracking background task failed:',e.message);}
      finally{working=false;}
    },5000);
    timer.unref();server.on('close',()=>clearInterval(timer));
  }
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
  const shutdown=()=>{server.close(async()=>{await store.close();process.exit(0)});server.closeAllConnections();};
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
