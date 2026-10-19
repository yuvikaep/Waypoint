import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TrackingStore} from './tracking-store.mjs';
import {createTrackingServer} from './tracking.mjs';
import {TraccarBridge} from './traccar.mjs';

function fixture(t,path=':memory:'){
  let now=Date.parse('2026-10-05T08:00:00Z');
  const store=new TrackingStore(path,{now:()=>now});t.after(()=>store.close());
  const {device,token}=store.createDevice({name:'TEST vehicle',uniqueId:'test-mobile',model:'Mobile',offlineSeconds:30});
  const position=(overrides={})=>({eventId:'one',recordedAt:new Date(now).toISOString(),latitude:18.52,longitude:73.85,speed:25,...overrides});
  return {store,device,token,position,advance:ms=>now+=ms};
}
test('ingestion validates, deduplicates, and does not rewind the latest GPS fix',t=>{
  const {store,device,position,advance}=fixture(t);
  assert.equal(store.device(device.id).status,'Waiting');
  assert.throws(()=>store.ingest(device.id,position({latitude:100})),/Latitude/);
  assert.throws(()=>store.ingest(device.id,position({speed:'10'})),/Speed/);
  assert.throws(()=>store.ingest(device.id,position({recordedAt:'2030-01-01T00:00:00Z'})),/recordedAt/);
  assert.throws(()=>store.ingest(device.id,position({ignition:'true'})),/Ignition/);
  const first=position();store.ingest(device.id,first);
  assert.equal(store.ingest(device.id,first).duplicate,true);
  advance(10000);store.ingest(device.id,position({eventId:'two',latitude:18.6}));
  store.ingest(device.id,{...first,eventId:'delayed'});
  assert.equal(store.device(device.id).position.latitude,18.6);
  assert.equal(store.device(device.id).status,'Moving');
  assert.equal(store.history(device.id,Date.parse(first.recordedAt),store.now()).positions.length,3);
});
test('heartbeats cannot make an old GPS fix fresh; offline alerts fire once and recover',t=>{
  const {store,device,position,advance}=fixture(t);store.ingest(device.id,position());
  advance(31000);store.tick();store.tick();assert.equal(store.device(device.id).status,'Offline');
  assert.equal(store.alerts().length,1);store.seen(device.id);
  assert.equal(store.device(device.id).status,'No GPS fix');assert.equal(store.alerts().length,2);
  store.ingest(device.id,position({eventId:'new',speed:0}));assert.equal(store.device(device.id).status,'Stopped');
});
test('geofences emit transitions and speeding alerts do not repeat for every fix',t=>{
  const {store,device,position,advance}=fixture(t);
  store.addFence({name:'Depot',latitude:18.52,longitude:73.85,radius:200});
  store.ingest(device.id,position());advance(1000);
  store.ingest(device.id,position({eventId:'outside',latitude:18.55,speed:90}));advance(1000);
  store.ingest(device.id,position({eventId:'outside-again',latitude:18.56,speed:95}));advance(30000);
  store.ingest(device.id,position({eventId:'inside',speed:0}));
  assert.deepEqual(store.alerts().map(a=>a.type).sort(),['enter','exit','speed']);
  store.acknowledge(store.alerts()[0].id);assert.equal(store.alerts()[0].acknowledged,1);
});
test('ping needs a fresh fix; cross-device acknowledgement is rejected and unanswered requests expire',t=>{
  const {store,device,position,advance}=fixture(t);
  const old=position();store.ingest(device.id,old);advance(1000);
  const command=store.queue(device.id);assert.equal(store.queue(device.id).id,command.id);
  store.seen(device.id);assert.equal(store.device(device.id).command.status,'queued');
  store.ingest(device.id,{...old,eventId:'old-duplicate'});assert.equal(store.device(device.id).command.status,'queued');
  const other=store.createDevice({name:'Other',uniqueId:'other',model:'Mobile'}).device;
  assert.throws(()=>store.ingest(other.id,position({commandId:command.id})),/belong/);
  store.ingest(device.id,position({eventId:'answer',commandId:command.id}));assert.equal(store.device(device.id).command.status,'answered');
  advance(1000);store.queue(device.id);advance(301000);store.tick();assert.equal(store.device(device.id).command.status,'timed out');
});
test('history pages without dropping equal-time or late packets and survives reopening',t=>{
  const dir=mkdtempSync(join(tmpdir(),'waypoint-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=join(dir,'tracking.sqlite');let store=new TrackingStore(db);
  const {device}=store.createDevice({name:'Persistent',model:'Mobile',uniqueId:'persist'});
  const at=new Date().toISOString();
  for(let n=0;n<5;n++)store.ingest(device.id,{eventId:String(n),recordedAt:at,latitude:0,longitude:0});
  store.close();store=new TrackingStore(db);t.after(()=>store.close());
  let after=0,ids=[];do{const page=store.history(device.id,Date.parse(at),Date.parse(at),after,2);ids.push(...page.positions.map(p=>p.id));after=page.next;}while(after!==null);
  assert.equal(new Set(ids).size,5);assert.equal(store.device(device.id).position.latitude,0);
});
test('sender tokens are device-scoped, hashed at rest, and revocable',t=>{
  const {store,device,token}=fixture(t);assert.equal(store.authenticateDevice(token).id,device.id);
  assert.notEqual(store.raw(device.id).tokenHash,token);assert.equal('tokenHash' in store.device(device.id),false);
  const next=store.rotateToken(device.id);assert.throws(()=>store.authenticateDevice(token),/Invalid/);assert.equal(store.authenticateDevice(next).id,device.id);
});
test('HTTP access control, login, origin checks, sender isolation, and bounded requests',async t=>{
  const {store,device,token,position}=fixture(t);
  const adminToken='test-admin-token-at-least-24-characters';
  const server=createTrackingServer({store,adminToken});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()}));
  const base=`http://127.0.0.1:${server.address().port}/api/gps`;
  const request=(path,options={})=>fetch(base+path,{...options,headers:{'Content-Type':'application/json',...options.headers}});
  assert.equal((await request('/state')).status,401);
  assert.equal((await request('/session',{method:'POST',body:JSON.stringify({token:'wrong'})})).status,401);
  const login=await request('/session',{method:'POST',body:JSON.stringify({token:adminToken})});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/state',{headers:{Cookie:cookie}})).status,200);
  assert.equal((await request('/state',{headers:{Cookie:cookie,Origin:'https://other.example'}})).status,403);
  assert.equal((await request('/state',{headers:{Authorization:`Bearer ${token}`}})).status,401);
  assert.equal((await request('/sender/position',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify(position())})).status,200);
  assert.equal((await request('/devices',{method:'POST',headers:{Cookie:cookie},body:JSON.stringify({name:'Bad IMEI',model:'GT06',uniqueId:'123'})})).status,400);
  const pt06=await request('/devices',{method:'POST',headers:{Cookie:cookie},body:JSON.stringify({name:'PT06 tracker',model:'PT06',uniqueId:'356218606437323'})});
  assert.equal(pt06.status,201);
  assert.equal((await pt06.json()).device.model,'PT06');
  assert.equal((await request('/devices',{method:'POST',headers:{Cookie:cookie},body:'x'.repeat(17000)})).status,413);
  const ping=await request(`/devices/${device.id}/ping`,{method:'POST',headers:{Cookie:cookie},body:'{}'});assert.equal(ping.status,202);
  const commands=await request('/sender/heartbeat',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:'{}'}).then(r=>r.json());assert.equal(commands.commands.length,1);
  assert.equal((await request('/session',{method:'DELETE',headers:{Cookie:cookie}})).status,200);
  assert.equal((await request('/state',{headers:{Cookie:cookie}})).status,401);
});
test('separate admin login and tenant-scoped cloud records',async t=>{
  const store=new TrackingStore(':memory:');t.after(()=>store.close());
  const admin=store.createAdmin('admin@example.com');
  const server=createTrackingServer({store,adminToken:'test-admin-token-at-least-24-characters'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()}));
  const base=`http://127.0.0.1:${server.address().port}/api/gps`;
  const call=(path,method='GET',value,cookie)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(value===undefined?{}:{body:JSON.stringify(value)})});
  assert.equal((await call('/admin/session','POST',{email:admin.email,password:'wrong'})).status,401);
  const adminLogin=await call('/admin/session','POST',admin);
  assert.equal(adminLogin.status,200);
  const adminCookie=adminLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/session','GET',undefined,adminCookie).then(r=>r.json())).role,'admin');
  const first=await call('/customers/register','POST',{name:'First',email:'first@example.com',password:'strong-password-1'});
  const second=await call('/customers/register','POST',{name:'Second',email:'second@example.com',password:'strong-password-2'});
  assert.equal(first.status,201);assert.equal(second.status,201);
  const firstCookie=first.headers.get('set-cookie').split(';')[0];
  const secondCookie=second.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/workspace/documents','PUT',{value:[{number:'DOC-1'}]},firstCookie)).status,200);
  assert.deepEqual((await call('/workspace/documents','GET',undefined,firstCookie).then(r=>r.json())).value,[{number:'DOC-1'}]);
  assert.equal((await call('/workspace/documents','GET',undefined,secondCookie).then(r=>r.json())).value,null);
  assert.equal((await call('/workspace/documents','GET',undefined,adminCookie).then(r=>r.json())).value,null);
  assert.equal((await call('/workspace/documents','PUT',{value:{}},firstCookie)).status,400);
  assert.equal((await call('/workspace/documents','GET')).status,401);
});
test('Traccar bridge provisions IMEI, converts knots, deduplicates history and checks supported commands',async t=>{
  const {store}=fixture(t);
  const device=store.createDevice({name:'TEST FMB920',model:'FMB920',uniqueId:'123456789012345'}).device;
  const at=new Date(store.now()).toISOString();let remote=[],supported=false,calls=[];
  const p={id:90,deviceId:7,valid:true,fixTime:at,serverTime:at,latitude:18.52,longitude:73.85,speed:10,course:180,accuracy:5,attributes:{ignition:true,batteryLevel:90,sat:8}};
  const fetcher=async(url,options)=>{
    const path=new URL(url).pathname;calls.push({url,path,...options});
    assert.equal(options.headers.Authorization,'Bearer test-token');
    let data;
    if(path==='/api/devices'&&options.method==='POST'){remote=[{id:7,uniqueId:device.uniqueId,lastUpdate:at,status:'online'}];data=remote[0];}
    else if(path==='/api/devices')data=remote;
    else if(path==='/api/positions')data=[p];
    else if(path==='/api/commands/types')data=supported?[{type:'positionSingle'}]:[{type:'custom'}];
    else if(path==='/api/commands/send')return new Response('{}',{status:202});
    else throw Error(path);
    return Response.json(data);
  };
  const bridge=new TraccarBridge(store,{url:'http://gateway',token:'test-token',fetcher});
  await bridge.sync();await bridge.sync();
  assert.equal(bridge.state.connected,true);assert.equal(store.device(device.id).position.speed,18.52);
  assert.equal(store.device(device.id).position.ignition,1);
  assert.equal(store.history(device.id,store.now()-1000,store.now()).positions.length,1);
  assert.equal(calls.filter(c=>c.path==='/api/devices'&&c.method==='POST').length,1);
  assert.equal((await bridge.ping(store.raw(device.id))).status,'unsupported');
  assert.equal(calls.some(c=>c.path==='/api/commands/send'),false);
  supported=true;assert.equal((await bridge.ping(store.raw(device.id))).status,'queued');
});
test('gateway errors are visible without inventing heartbeat or position data',async t=>{
  const {store}=fixture(t);const device=store.createDevice({name:'GT06',model:'GT06',uniqueId:'123456789012345'}).device;
  const bridge=new TraccarBridge(store,{url:'http://gateway',token:'token',fetcher:async()=>new Response('{}',{status:401})});
  await bridge.sync();assert.equal(bridge.state.connected,false);assert.match(bridge.state.error,/401/);assert.equal(store.device(device.id).lastSeen,null);
});
test('a late gateway send response cannot overwrite a location already received',t=>{
  const {store,device,position,advance}=fixture(t);
  const command=store.queue(device.id);store.updateCommand(command.id,'dispatching','Submitting request.');
  assert.equal(store.queue(device.id).id,command.id);
  advance(1000);store.ingest(device.id,position());
  assert.equal(store.device(device.id).command.status,'location received');
  store.updateCommand(command.id,'sent','Gateway accepted request.');
  assert.equal(store.device(device.id).command.status,'location received');
});
test('hardware history import recovers delayed points without rewinding current position',async t=>{
  const {store,position}=fixture(t);
  const device=store.createDevice({name:'History GT06',model:'GT06',uniqueId:'123456789012345'}).device;
  store.db.prepare('UPDATE devices SET traccarId=42 WHERE id=?').run(device.id);
  store.ingest(device.id,position({eventId:'latest',latitude:19}));
  const earlier=store.now()-86400000;
  const bridge=new TraccarBridge(store,{url:'http://gateway',token:'token',fetcher:async(url)=>{
    assert.equal(new URL(url).searchParams.get('deviceId'),'42');
    return Response.json([{id:101,valid:true,latitude:18,longitude:73,speed:0,fixTime:new Date(earlier).toISOString(),serverTime:new Date().toISOString(),attributes:{}}]);
  }});
  await bridge.importHistory(store.raw(device.id),earlier,store.now());
  assert.equal(store.history(device.id,earlier,store.now()).positions.length,2);
  assert.equal(store.device(device.id).position.latitude,19);
});
test('driver links stay fixed until explicit regeneration or disable; sessions expire',t=>{
  const {store,device,token,advance}=fixture(t);
  const link=store.createDriverLink(device.id);
  assert.throws(()=>store.authenticateDevice(token),/Invalid/);
  assert.notEqual(store.db.prepare('SELECT hash FROM driver_links').get().hash,link.code);
  const joined=store.joinDriver(link.code);assert.equal(store.driverSession(joined.secret).device.id,device.id);
  assert.equal(store.device(device.id).lastSeen,null,'Opening a link must not start tracking.');
  assert.equal(store.createDriverLink(device.id).code,link.code);
  assert.equal(store.getDriverLink(device.id).code,link.code);
  const replacement=store.createDriverLink(device.id,{regenerate:true});
  assert.throws(()=>store.joinDriver(link.code),/expired|replaced/);
  assert.throws(()=>store.driverSession(joined.secret),/driver link/);
  // A link lasts one week unless another duration is chosen; the phone stays signed in that long.
  const newSession=store.joinDriver(replacement.code);advance(6*86400000);
  assert.equal(store.driverSession(newSession.secret).device.id,device.id);
  advance(86400000+1);assert.throws(()=>store.driverSession(newSession.secret),/driver link/);
  assert.equal(store.getDriverLink(device.id),null);
  store.tick();assert.equal(store.alerts().filter(a=>a.type==='share_expired').length,1);
  store.tick();assert.equal(store.alerts().filter(a=>a.type==='share_expired').length,1,'expiry is reported once');
  const yearly=store.createDriverLink(device.id,{regenerate:true,hours:8760});
  assert.throws(()=>store.createDriverLink(device.id,{hours:2}),/4 hours/);
  const shorter=store.createDriverLink(device.id,{hours:4});assert.equal(shorter.code,yearly.code,'changing the duration keeps the link');
  assert.equal(shorter.expiresAt,store.now()+4*3600000);
  advance(364*86400000);assert.throws(()=>store.joinDriver(replacement.code),/expired|replaced/);
  store.revokeDriverLinks(device.id);
  assert.equal(store.getDriverLink(device.id),null);
  assert.throws(()=>store.joinDriver(replacement.code),/expired|replaced/);
});
test('driver cookie authenticates only assigned sender; revocation blocks active sessions',async t=>{
  const {store,device,position}=fixture(t);
  const server=createTrackingServer({store,adminToken:'driver-test-admin-key-24-characters'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()}));
  const base=`http://127.0.0.1:${server.address().port}/api/gps`;
  const post=(path,payload,headers={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(payload)});
  const link=store.createDriverLink(device.id);
  assert.equal((await post('/sender/join',{code:'bad'})).status,401);
  assert.equal((await post('/sender/join',{code:link.code},{Origin:'https://wrong.example'})).status,403);
  const joined=await post('/sender/join',{code:link.code});assert.equal(joined.status,200);
  const setCookie=joined.headers.get('set-cookie');assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Strict/);
  const cookie=setCookie.split(';')[0];const data=await joined.json();assert.equal(data.device.name,device.name);assert.equal('token' in data,false);
  assert.equal((await fetch(base+'/state',{headers:{Cookie:cookie}})).status,401);
  assert.equal((await post('/sender/position',{...position(),deviceId:'different'},{Cookie:cookie})).status,409);
  assert.equal((await post('/sender/position',{...position(),deviceId:device.id},{Cookie:cookie})).status,200);
  assert.equal((await fetch(base+'/sender/me',{headers:{Cookie:cookie}})).status,200);
  assert.equal((await post('/sender/stopped',{deviceId:device.id,reason:'permission'},{Cookie:cookie})).status,200);
  assert.match(store.alerts().find(a=>a.type==='share_stopped').message,/blocked/);
  store.revokeDriverLinks(device.id);
  assert.equal((await post('/sender/heartbeat',{deviceId:device.id},{Cookie:cookie})).status,401);
});

test('Traccar position without a satellite fix is kept as last known but never reported as a live fix',async t=>{
  const {store}=fixture(t);
  const device=store.createDevice({name:'TEST GT06',model:'GT06',uniqueId:'123456789012346',offlineSeconds:180}).device;
  const bridge=new TraccarBridge(store,{url:'http://gateway',token:'x',fetcher:async()=>{throw Error('unused')}});
  const at=new Date(store.now()).toISOString();
  await bridge.ingest(device.id,{id:1,deviceId:7,valid:false,fixTime:at,serverTime:at,latitude:18.52,longitude:73.85,speed:0,course:0,attributes:{}});
  await bridge.ingest(device.id,{id:2,deviceId:7,valid:false,fixTime:at,serverTime:at,latitude:0,longitude:0,speed:0,course:0,attributes:{}});
  store.seen(device.id,store.now());
  const d=store.device(device.id);
  assert.equal(d.position.latitude,18.52);assert.equal(d.position.valid,0);
  assert.equal(d.fresh,false);assert.equal(d.status,'No GPS fix');
  assert.equal(store.history(device.id,store.now()-1000,store.now()+1000).positions.length,1);
});

test('receiver points with a skewed tracker clock or odd attributes are stored, never stall the sync',async t=>{
  const {store}=fixture(t);
  const device=store.createDevice({name:'TEST GT06 clock',model:'GT06',uniqueId:'123456789012347'}).device;
  const bridge=new TraccarBridge(store,{url:'http://gateway',token:'x',fetcher:async()=>{throw Error('unused')}});
  const server=new Date(store.now()).toISOString();
  // IST reported as UTC: five and a half hours in the future.
  const ahead=new Date(store.now()+5.5*3600000).toISOString();
  await bridge.ingest(device.id,{id:11,deviceId:7,valid:true,fixTime:ahead,serverTime:server,latitude:18.52,longitude:73.85,speed:5,course:400,attributes:{batteryLevel:150,sat:9}});
  const p=store.device(device.id).position;
  assert.equal(p.recordedAt,store.now());assert.equal(p.battery,null);assert.equal(p.heading,null);assert.equal(p.satellites,9);
  assert.equal(store.device(device.id).fresh,true);
});

test('GT06 ignition follows the heartbeat ACC bit and parked time starts after the last movement',async t=>{
  const {store,advance}=fixture(t);
  const device=store.createDevice({name:'TEST G17',model:'GT06',uniqueId:'867111062240499',offlineSeconds:600}).device;
  const bridge=new TraccarBridge(store,{url:'http://gateway',token:'x',fetcher:async()=>{throw Error('unused')}});
  let id=100;
  // A vehicle that has driven stays where it stopped; it does not snap back to where it set off.
  let lat=25.27;
  const send=async(type,attrs,speed)=>{const at=new Date(store.now()).toISOString();if(speed>0)lat+=0.0015;await bridge.ingest(device.id,{id:id++,deviceId:4,protocol:'gt06',valid:true,fixTime:at,serverTime:at,latitude:lat,longitude:82.83,speed,course:0,attributes:{type,...attrs}});store.seen(device.id,store.now());};
  // Driving: heartbeat says ACC on, location packets from this clone claim ignition false.
  await send(0x13,{ignition:true,status:198},0);advance(20000);
  await send(0x12,{ignition:false,sat:15},10);advance(20000);
  assert.equal(store.device(device.id).ignition,1);
  assert.equal(store.device(device.id).status,'Moving');
  // Parked from here on.
  const parkedAt=store.now()+20000;advance(20000);
  await send(0x12,{ignition:false,sat:15},0);advance(60000);
  await send(0x13,{ignition:false,status:196},0);advance(60000);
  await send(0x12,{sat:15},0);
  const d=store.device(device.id);
  assert.equal(d.status,'Stopped');assert.equal(d.ignition,0);assert.equal(d.stoppedSince,parkedAt);
});

test('a parked hardware tracker that only sends heartbeats stays Stopped; a stale mobile sender does not',t=>{
  const {store,device:mobile,position,advance}=fixture(t);
  const hw=store.createDevice({name:'TEST parked GT06',model:'GT06',uniqueId:'867111062240498',offlineSeconds:180}).device;
  store.ingest(hw.id,{eventId:'park',recordedAt:new Date(store.now()).toISOString(),latitude:25.28,longitude:82.79,speed:0});
  store.ingest(mobile.id,position({speed:0}));
  advance(20*60000);store.seen(hw.id,store.now());store.seen(mobile.id,store.now());
  assert.equal(store.device(hw.id).status,'Stopped');assert.equal(store.device(hw.id).fresh,false);
  assert.equal(store.device(hw.id).stoppedSince,store.now()-20*60000);
  assert.equal(store.device(mobile.id).status,'No GPS fix');
});

test('vehicle power cuts, alarms and the SIM number come from tracker attributes, and old rows are back-filled',async t=>{
  const {store}=fixture(t);
  const {powerTimeline,alarmText}=await import('./extra.mjs');
  const device=store.createDevice({name:'TEST G17 health',model:'GT06',uniqueId:'867111062240495',offlineSeconds:600}).device;
  const bridge=new TraccarBridge(store,{url:'http://gateway',token:'x',fetcher:async()=>{throw Error('unused')}});
  const send=async(id,ms,attrs,serverOffset=0)=>{const at=new Date(store.now()+ms).toISOString();await bridge.ingest(device.id,{id,deviceId:4,protocol:'gt06',valid:true,fixTime:at,serverTime:at,latitude:25.28,longitude:82.79,speed:0,course:0,attributes:attrs})};
  await send(1,0,{type:19,charge:true,batteryLevel:100,rssi:4,iccid:'89911025034004265502'});
  await send(2,60000,{type:19,charge:false,batteryLevel:83,rssi:3});
  await send(3,61000,{type:22,charge:false,batteryLevel:83,alarm:'powerCut,powerCut'});
  await send(4,3600000,{type:19,charge:true,batteryLevel:60,rssi:4});
  assert.equal(store.deviceAlerts(device.id)[0].message,'Main power cut');
  assert.equal(alarmText('powerCut,powerCut'),'Main power cut');
  assert.equal(store.latestIccid(device.id),'89911025034004265502');
  const power=powerTimeline(store.powerRows(device.id,0));
  assert.equal(power.connected,true);
  assert.deepEqual(power.events.map(e=>[e.connected,e.battery]),[[true,60],[false,83]]);
  // A row stored before extra existed is filled in when the receiver sends it again.
  store.db.prepare('UPDATE positions SET extra=NULL').run();
  await send(1,0,{type:19,charge:true,batteryLevel:100,rssi:4});
  assert.ok(store.db.prepare("SELECT extra FROM positions WHERE eventId='traccar:1'").get().extra.includes('"rssi":4'));
});

test('ignition changes and geofence crossings create alerts; repeated tracker alarms do not',async t=>{
  const {store,advance}=fixture(t);
  const device=store.createDevice({name:'TEST ign',model:'GT06',uniqueId:'867111062240497',offlineSeconds:600}).device;
  const fence=store.addFence({name:'Depot',latitude:25.28,longitude:82.79,radius:200});
  const bridge=new TraccarBridge(store,{url:'http://gateway',token:'x',fetcher:async()=>{throw Error('unused')}});
  let n=0;
  const send=async(attrs,lat=25.28)=>{n++;advance(60000);const at=new Date(store.now()).toISOString();await bridge.ingest(device.id,{id:n,deviceId:4,protocol:'gt06',valid:true,fixTime:at,serverTime:at,latitude:lat,longitude:82.79,speed:0,course:0,attributes:attrs})};
  await send({type:19,ignition:false});            // first report: nothing to compare with
  await send({type:19,ignition:false});            // unchanged
  await send({type:19,ignition:true});             // started
  await send({type:19,ignition:true});
  await send({type:19,ignition:false});            // stopped
  const ign=store.deviceAlerts(device.id).filter(a=>a.type.startsWith('ignition')).map(a=>a.type+':'+a.message).sort();
  assert.deepEqual(ign,['ignition_off:Engine stopped.','ignition_on:Engine started.']);
  // Location packets (ignition unknown) never invent a change.
  await send({type:18});await send({type:18},25.29);
  assert.equal(store.deviceAlerts(device.id).filter(a=>a.type.startsWith('ignition')).length,2);
  const crossing=store.deviceAlerts(device.id).map(a=>a.type);
  assert.ok(crossing.includes('exit'),'left the geofence: '+crossing);
  // The same alarm twice within 30 minutes alerts once.
  await send({type:19,ignition:false,alarm:'powerCut'});await send({type:19,ignition:false,alarm:'powerCut'});
  assert.equal(store.deviceAlerts(device.id).filter(a=>a.type==='alarm').length,1);
  void fence;
});

test('stored rows that are a time-zone offset behind can be moved forward, others are left',t=>{
  const {store}=fixture(t);
  const d=store.createDevice({name:'TEST shift',model:'PT06',uniqueId:'356218606437323'}).device;
  const now=store.now(),iso=ms=>new Date(ms).toISOString();
  store.ingest(d.id,{eventId:'late',recordedAt:iso(now-330*60000),latitude:25,longitude:82},{receivedAt:now});
  store.ingest(d.id,{eventId:'fresh',recordedAt:iso(now-5000),latitude:25,longitude:82},{receivedAt:now});
  store.ingest(d.id,{eventId:'buffered',recordedAt:iso(now-90*60000),latitude:25,longitude:82},{receivedAt:now});
  assert.equal(store.shiftClock(d.id,330),1);
  const rows=Object.fromEntries(store.db.prepare('SELECT eventId,recordedAt FROM positions').all().map(r=>[r.eventId,r.recordedAt]));
  assert.equal(rows.late,now);assert.equal(rows.fresh,now-5000);assert.equal(rows.buffered,now-90*60000);
});

test('overspeed alerts follow the owner limit, repeat only after a pause and can be switched off',t=>{
  const {store,device,position,advance}=fixture(t);
  store.updateDevice(device.id,{speedLimit:40});
  let n=0;const drive=speed=>{advance(20000);store.ingest(device.id,position({eventId:`s${n++}`,recordedAt:new Date(store.now()).toISOString(),speed}))};
  const count=()=>store.alerts().filter(a=>a.type==='speed').length;
  drive(30);drive(45);assert.equal(count(),1);
  assert.match(store.alerts().find(a=>a.type==='speed').message,/45 km\/h exceeds 40 km\/h/);
  drive(38);drive(46);assert.equal(count(),1,'hovering at the limit does not repeat within minutes');
  advance(4*60000);drive(30);drive(50);assert.equal(count(),2);
  store.updateDevice(device.id,{speedAlert:false});
  advance(4*60000);drive(30);drive(60);assert.equal(count(),2,'switched off by the owner');
});

test('hard braking from GPS speed and tracker SOS / harsh alarms get their own alerts',t=>{
  const {store,device,position,advance}=fixture(t);
  let n=0;const fix=(speed,gap,extra)=>{advance(gap);store.ingest(device.id,position({eventId:`b${n++}`,recordedAt:new Date(store.now()).toISOString(),speed,...(extra?{extra}:{})}))};
  const of=type=>store.alerts().filter(a=>a.type===type);
  fix(50,10000);fix(30,10000);assert.equal(of('harsh_brake').length,0,'20 km/h less over 10 s is normal braking');
  fix(60,10000);fix(20,3000);assert.equal(of('harsh_brake').length,1);
  assert.match(of('harsh_brake')[0].message,/60 → 20 km\/h in 3 s/);
  fix(15,40000);fix(0,60000);assert.equal(of('harsh_brake').length,1,'slow speeds or long gaps never count');
  fix(0,5000,{alarm:'sos'});fix(0,5000,{alarm:'sos'});
  assert.equal(of('sos').length,1,'a held SOS button is reported once');
  fix(0,5000,{alarm:'hardBraking,powerCut'});
  assert.equal(of('harsh_brake').length,2);assert.equal(of('alarm')[0].message,'Main power cut');
});

test('customer hears when the driver phone stops sharing and when it comes back',t=>{
  const {store,device,position,advance}=fixture(t);
  store.ingest(device.id,position());
  store.sharingStopped(device.id,'permission');store.sharingStopped(device.id,'stopped');
  const stopped=store.alerts().filter(a=>a.type==='share_stopped');
  assert.equal(stopped.length,1);assert.match(stopped[0].message,/switched off or blocked/);
  advance(1000);store.ingest(device.id,position({eventId:'again'}));
  assert.equal(store.alerts().filter(a=>a.type==='share_resumed').length,1);
  advance(60000);store.tick();
  assert.match(store.alerts().find(a=>a.type==='share_stopped'&&a.id!==stopped[0].id).message,/stopped sending location/);
});

test('saved places carry a type from the list',t=>{
  const {store}=fixture(t);
  assert.equal(store.addFence({name:'HP pump',latitude:25.48,longitude:82.79,radius:150,kind:'fuel'}).kind,'fuel');
  assert.equal(store.addFence({name:'Somewhere',latitude:25.4,longitude:82.7,radius:150}).kind,'other');
  assert.throws(()=>store.addFence({name:'Bad',latitude:25.4,longitude:82.7,radius:150,kind:'casino'}),/place type/);
  assert.equal(store.fences().find(f=>f.name==='HP pump').kind,'fuel');
});

test('buy GPS enquiries are checked, saved for the admin and can be marked contacted',t=>{
  const {store}=fixture(t);
  const c=store.createCustomer({name:'Sharma Roadways',email:'sharma@example.test'});
  assert.throws(()=>store.addGpsRequest(c.customer.id,{name:'Ravi',phone:'123'}),/mobile number/);
  assert.throws(()=>store.addGpsRequest(c.customer.id,{name:'Ravi',phone:'9876543210',product:'drone'}),/GPS type/);
  const r=store.addGpsRequest(c.customer.id,{name:'Ravi',phone:'98765 43210',vehicles:3,product:'portable',note:'Lucknow'});
  assert.equal(r.phone,'9876543210');
  const [row]=store.gpsRequests();
  assert.equal(row.customerName,'Sharma Roadways');assert.equal(row.vehicles,3);assert.equal(row.status,'new');
  store.setGpsRequestStatus(r.id,'contacted');assert.equal(store.gpsRequests()[0].status,'contacted');
  assert.throws(()=>store.setGpsRequestStatus(r.id,'paid'),/Unknown status/);
});

test('parking lock alerts once when a locked vehicle starts or moves; network and driver number are kept',async t=>{
  const {store,device,position,advance}=fixture(t);
  let n=0;const fix=(o={})=>{advance(5000);store.ingest(device.id,position({eventId:`p${n++}`,recordedAt:new Date(store.now()).toISOString(),speed:0,...o}))};
  const locks=()=>store.alerts().filter(a=>a.type==='parking_lock').sort((a,b)=>a.createdAt-b.createdAt);
  assert.throws(()=>store.setParkLock(device.id,true),/not sent a location/);
  fix({ignition:false,extra:{rssi:3}});
  assert.equal(store.device(device.id).rssi,3);
  store.setParkLock(device.id,true);
  fix({latitude:18.5203,ignition:false});assert.equal(locks().length,0,'GPS drift of ~30 m is not movement');
  fix({ignition:true});assert.equal(locks().length,1);assert.match(locks()[0].message,/engine started/);
  fix({latitude:18.53,speed:30});assert.equal(locks().length,1,'one alert until the owner locks again');
  store.setParkLock(device.id,false);fix({latitude:18.53});assert.equal(locks().length,1);
  fix({latitude:18.53,speed:0,ignition:false});store.setParkLock(device.id,true);
  fix({latitude:18.532,ignition:false});assert.equal(locks().length,2);assert.match(locks()[1].message,/moved 222 m/);
  assert.equal(store.setDriverPhone(device.id,'98765 43210').driverPhone,'9876543210');
  assert.throws(()=>store.setDriverPhone(device.id,'12345'),/10 digit/);
  const {signalBars}=await import('./extra.mjs');
  assert.deepEqual([signalBars(0),signalBars(3),signalBars(5),signalBars(20),signalBars(99),signalBars(null)],[0,3,4,3,null,null]);
});

test('owners rename a place and fix its type, only in their own fleet',t=>{
  const {store}=fixture(t);
  const f=store.addFence({name:'Mayank Room',latitude:25.3,longitude:82.9,radius:150,kind:'fuel'},'tenant-a');
  assert.throws(()=>store.updateFence(f.id,'tenant-b',{kind:'other'}),/not found/);
  assert.throws(()=>store.updateFence(f.id,'tenant-a',{kind:'castle'}),/place type/);
  const r=store.updateFence(f.id,'tenant-a',{kind:'other',name:'Mayank home'});
  assert.equal(r.kind,'other');assert.equal(store.fences('tenant-a')[0].name,'Mayank home');assert.equal(store.fences('tenant-a')[0].radius,150);
});

test('admin can reset to a chosen password with the maintenance key; the last admin cannot be removed',async t=>{
  const {store}=fixture(t);
  const first=store.createAdmin('Owner@Example.test');
  assert.throws(()=>store.resetAdminPassword('owner@example.test','short'),/12 to 128/);
  const r=store.resetAdminPassword(null,'my-own-new-password-1');
  assert.deepEqual(r,{email:'owner@example.test'},'a chosen password is never echoed back');
  assert.throws(()=>store.adminLogin('owner@example.test',first.password),/Incorrect/);
  assert.equal(store.adminLogin('owner@example.test','my-own-new-password-1').email,'owner@example.test');
  assert.match(store.resetAdminPassword('owner@example.test').password,/^[\w-]{16}$/,'without a chosen password a random one is returned');
  assert.throws(()=>store.removeAdmin('owner@example.test'),/only admin/);
  store.createAdmin('second@example.test');
  assert.throws(()=>store.resetAdminPassword(null,'my-own-new-password-1'),/Specify which admin/);
  assert.deepEqual(store.removeAdmin('OWNER@example.test'),{ok:true});
  assert.deepEqual(store.admins().map(a=>a.email),['second@example.test']);
  assert.throws(()=>store.removeAdmin('owner@example.test'),/not found/);
});

test('admin routes: reset needs the key, remove needs an admin session and never removes yourself',async t=>{
  const store=new TrackingStore(':memory:');t.after(()=>store.close());
  const key='maintenance-key-at-least-24-characters';
  store.createAdmin('a@example.test');store.createAdmin('b@example.test');
  const server=createTrackingServer({store,adminToken:key,bridge:{state:{},sync:async()=>{}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections()}));
  const base=`http://127.0.0.1:${server.address().port}/api/gps`,json={'Content-Type':'application/json'};
  const post=(p,b,h={})=>fetch(base+p,{method:'POST',headers:{...json,...h},body:JSON.stringify(b)});
  assert.equal((await post('/admin/reset-password',{token:'wrong',email:'a@example.test',newPassword:'my-own-new-password-1'})).status,401);
  const ok=await post('/admin/reset-password',{token:key,email:'a@example.test',newPassword:'my-own-new-password-1'});
  assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{email:'a@example.test'});
  const login=await post('/admin/session',{email:'a@example.test',password:'my-own-new-password-1'});assert.equal(login.status,200);
  const cookie={cookie:login.headers.get('set-cookie').split(';')[0]};
  assert.equal((await fetch(base+'/admin/admins/b%40example.test',{method:'DELETE'})).status,401);
  assert.equal((await fetch(base+'/admin/admins/a%40example.test',{method:'DELETE',headers:cookie})).status,409,'cannot remove yourself');
  assert.equal((await fetch(base+'/admin/admins/b%40example.test',{method:'DELETE',headers:cookie})).status,200);
});

test('parking lock: an engine-on heartbeat that repeats an old fix time still alerts; old movement from before the lock does not',t=>{
  const {store,device,position,advance}=fixture(t);
  let n=0;
  const fixAt=new Date(store.now()).toISOString();
  store.ingest(device.id,position({eventId:`h${n++}`,recordedAt:fixAt,speed:0,ignition:false}));
  advance(600000);store.setParkLock(device.id,true);advance(60000);
  const locks=()=>store.alerts().filter(a=>a.type==='parking_lock');
  // Old fix replayed after the lock, 500 m away: not movement.
  store.ingest(device.id,position({eventId:`h${n++}`,recordedAt:fixAt,latitude:18.53,speed:0}),{receivedAt:store.now()});
  assert.equal(locks().length,0);
  // Heartbeat: same old fix time, ignition now on.
  advance(30000);store.ingest(device.id,position({eventId:`h${n++}`,recordedAt:fixAt,speed:0,ignition:true}),{receivedAt:store.now()});
  assert.equal(locks().length,1);assert.match(locks()[0].message,/engine started/);
});

test('running means really going somewhere, not a GPS wandering on the spot; drift does not restart "stopped since"',t=>{
  const {store,device,position,advance}=fixture(t);
  let n=0,lat=18.52;
  const fix=(speed,gap,{move=0,ignition}={})=>{advance(gap);lat+=move;store.ingest(device.id,position({eventId:`d${n++}`,recordedAt:new Date(store.now()).toISOString(),latitude:lat,speed,...(ignition===undefined?{}:{ignition})}))};
  const dev=()=>store.device(device.id);
  fix(0,60000);const stopAt=store.now();
  fix(0,300000);fix(5,60000,{move:0.0003});fix(6,60000,{move:-0.0003});fix(4,60000);fix(0,60000);
  assert.equal(dev().stoppedSince,stopAt,'a GPS wandering ~30 m back and forth at 4-6 km/h is not running');assert.equal(dev().status,'Stopped');
  fix(8,60000,{move:0.0012});fix(8,60000,{move:0.0012});
  assert.equal(dev().status,'Moving','130 m per fix at 8 km/h is running');
  // Pulling out: the vehicle has to get clear of how far this tracker's GPS wanders, then it is running.
  fix(0,60000);fix(0,60000);const parked=store.now();fix(0,60000);
  assert.equal(dev().status,'Stopped');assert.equal(dev().stoppedSince<=parked,true);
  fix(4,30000,{move:0.0004});assert.equal(dev().status,'Moving','44 m clear of where it stood at 4 km/h is running');
  fix(0,60000);fix(0,60000);fix(0,60000);const second=store.now();fix(0,60000);
  assert.equal(dev().stoppedSince<=second,true);assert.equal(dev().status,'Stopped');
  // Below walking pace is not driving, however far the coordinates jump.
  fix(1,60000,{move:0.002});assert.equal(dev().status,'Stopped');
});

test('a vehicle with an ignition wire is running only while the ignition is on',t=>{
  const {store,device,position,advance}=fixture(t);
  let n=0,lat=18.52;
  const fix=(speed,ignition)=>{advance(60000);lat+=0.0015;store.ingest(device.id,position({eventId:`w${n++}`,recordedAt:new Date(store.now()).toISOString(),latitude:lat,speed,ignition}))};
  fix(0,false);fix(0,true);fix(20,true);fix(20,true);
  assert.equal(store.device(device.id).status,'Moving');
  fix(20,false);fix(20,false);
  assert.equal(store.device(device.id).status,'Stopped','ignition off with a wire means not running (towed or noise)');
});
