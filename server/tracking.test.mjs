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
  store.ingest(device.id,position({eventId:'outside-again',latitude:18.56,speed:95}));advance(1000);
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
  advance(1000);store.queue(device.id);advance(121000);store.tick();assert.equal(store.device(device.id).command.status,'timed out');
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
  assert.equal((await request('/devices',{method:'POST',headers:{Cookie:cookie},body:'x'.repeat(17000)})).status,413);
  const ping=await request(`/devices/${device.id}/ping`,{method:'POST',headers:{Cookie:cookie},body:'{}'});assert.equal(ping.status,202);
  const commands=await request('/sender/heartbeat',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:'{}'}).then(r=>r.json());assert.equal(commands.commands.length,1);
  assert.equal((await request('/session',{method:'DELETE',headers:{Cookie:cookie}})).status,200);
  assert.equal((await request('/state',{headers:{Cookie:cookie}})).status,401);
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
  const newSession=store.joinDriver(replacement.code);advance(12*3600000+1);
  assert.throws(()=>store.driverSession(newSession.secret),/driver link/);
  advance(365*86400000);assert.equal(store.joinDriver(replacement.code).device.id,device.id);
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
  store.revokeDriverLinks(device.id);
  assert.equal((await post('/sender/heartbeat',{deviceId:device.id},{Cookie:cookie})).status,401);
});
