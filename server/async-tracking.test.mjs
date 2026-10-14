import test from 'node:test';
import assert from 'node:assert/strict';
import {TrackingStore} from './tracking-store.mjs';
import {createTrackingServer} from './tracking.mjs';
import {TraccarBridge} from './traccar.mjs';
import {RelayService} from './relay.mjs';

const adminToken='async-test-admin-key-at-least-24-characters';
const turn=()=>new Promise(resolve=>setImmediate(resolve));

// Keep SQLite's implementation intact while making its public I/O truly asynchronous.
function asyncStore(t,options={}){
  const sqlite=new TrackingStore(':memory:',options);
  t.after(()=>sqlite.close());
  const db={
    exec:async sql=>{await turn();return sqlite.db.exec(sql);},
    prepare:sql=>Object.fromEntries(['get','all','run'].map(method=>[method,async(...args)=>{
      await turn();return sqlite.db.prepare(sql)[method](...args);
    }]))
  };
  const store=new Proxy(sqlite,{get(target,key){
    if(key==='db')return db;
    const value=target[key];
    if(typeof value!=='function')return value;
    if(key==='now')return value.bind(target);
    return async(...args)=>{await turn();return value.apply(target,args);};
  }});
  return {sqlite,store,db};
}

function sessions(){
  const values=new Map();
  return {
    get:async key=>{await turn();return values.get(key);},
    set:async(key,value)=>{await turn();values.set(key,structuredClone(value));},
    delete:async key=>{await turn();values.delete(key);}
  };
}

async function http(t,store,options={}){
  const server=createTrackingServer({store,adminToken,backgroundTasks:false,...options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base=`http://127.0.0.1:${server.address().port}/api/gps`;
  return (path,method='GET',value,cookie)=>fetch(base+path,{
    method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},
    ...(value===undefined?{}:{body:JSON.stringify(value)})
  });
}
const cookie=response=>response.headers.get('set-cookie').split(';')[0];

test('async store, sessions and rate limiter persist before HTTP responses; serverless skips sync',async t=>{
  const {store}=asyncStore(t),sessionStore=sessions(),calls=[];
  let syncs=0;
  const bridge={state:{configured:false},sync:async()=>{syncs++;}};
  const call=await http(t,store,{sessionStore,bridge,rateLimit:async(key,max,ms)=>{
    await turn();calls.push({key,max,ms});
  }});
  const login=await call('/session','POST',{token:adminToken});
  assert.equal(login.status,200);
  const admin=cookie(login);
  const registered=await call('/customers/register','POST',{name:'Async customer',email:'async@example.com',password:'strong-password-1'});
  assert.equal(registered.status,201);
  const customer=cookie(registered);
  assert.equal((await call('/workspace/documents','PUT',{value:[{number:'ASYNC-1'}]},customer)).status,200);
  assert.deepEqual((await call('/workspace/documents','GET',undefined,customer).then(r=>r.json())).value,[{number:'ASYNC-1'}]);
  const created=await call('/devices','POST',{name:'Async phone',model:'Mobile'},admin);
  assert.equal(created.status,201);
  const {device,token}=await created.json();
  const link=await call(`/devices/${device.id}/driver-link`,'POST',{},admin);
  assert.equal(link.status,201);
  // Creating a driver link rotates the original sender token; use the driver cookie.
  const joined=await call('/sender/join','POST',{code:(await link.json()).code});
  assert.equal(joined.status,200);
  assert.equal((await call('/sender/heartbeat','POST',{deviceId:device.id},cookie(joined))).status,200);
  assert.equal((await call('/sender/heartbeat','POST',{},undefined)).status,401);
  assert.equal(typeof token,'string');
  const state=await call('/state','GET',undefined,admin).then(r=>r.json());
  assert.equal(state.devices[0].id,device.id);
  assert.equal(syncs,0);
  assert.ok(calls.some(c=>c.key.startsWith('login:')&&c.max===10&&c.ms===60000));
  assert.ok(calls.some(c=>c.key.startsWith('register:')&&c.max===5&&c.ms===3600000));
  assert.equal((await call('/session','DELETE',undefined,admin)).status,200);
  assert.equal((await call('/state','GET',undefined,admin)).status,401);
});

test('customer reset and disable revoke shared async sessions across server instances',async t=>{
  const {store}=asyncStore(t),sessionStore=sessions();
  const first=await http(t,store,{sessionStore}),second=await http(t,store,{sessionStore});
  const admin=cookie(await first('/session','POST',{token:adminToken}));
  const registered=await first('/customers/register','POST',{name:'Shared',email:'shared@example.com',password:'strong-password-1'});
  const old=cookie(registered),{tenantId}=await registered.json();
  assert.equal((await second('/session','GET',undefined,old)).status,200);
  const reset=await second(`/customers/${tenantId}/reset`,'POST',{},admin);
  assert.equal(reset.status,200);
  const {password}=await reset.json();
  assert.equal((await first('/session','GET',undefined,old)).status,401);
  const login=await first('/customers/session','POST',{email:'shared@example.com',password});
  assert.equal(login.status,200);
  const current=cookie(login);
  assert.equal((await second(`/customers/${tenantId}/access`,'PUT',{enabled:false},admin)).status,200);
  assert.equal((await second(`/customers/${tenantId}/access`,'PUT',{enabled:true},admin)).status,200);
  assert.equal((await first('/session','GET',undefined,current)).status,401);
});

test('HTTP awaits schema readiness and fails closed on async persistence or limiter errors',async t=>{
  const {store,db}=asyncStore(t);
  let release,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const exec=db.exec;
  db.exec=async sql=>{entered();await gate;return exec(sql);};
  const call=await http(t,store);
  await started;
  let completed=false;
  const health=call('/health').then(r=>{completed=true;return r;});
  await turn();assert.equal(completed,false);
  release();assert.equal((await health).status,200);
  const broken=await http(t,store,{sessionStore:{...sessions(),set:async()=>{await turn();throw Error('write failed');}}});
  const login=await broken('/session','POST',{token:adminToken});
  assert.equal(login.status,500);assert.equal(login.headers.get('set-cookie'),null);
  const limited=await http(t,store,{rateLimit:async()=>{await turn();throw Object.assign(Error('limit'),{status:429});}});
  assert.equal((await limited('/session','POST',{token:adminToken})).status,429);
  db.exec=async()=>{await turn();throw Error('schema unavailable');};
  const unavailable=await http(t,store);
  assert.equal((await unavailable('/health')).status,500);
});

test('Traccar awaits historical ingestion before advancing its cursor and current position',async t=>{
  const {store,sqlite}=asyncStore(t);
  const {device}=await store.createDevice({name:'Async gateway',model:'FMB920',uniqueId:'123456789012345'});
  const now=store.now(),events=[];
  const make=(id,offset)=>({id,deviceId:42,valid:true,fixTime:new Date(now+offset).toISOString(),serverTime:new Date(now).toISOString(),latitude:18.52,longitude:73.85,speed:0,course:0,accuracy:8,attributes:{ignition:false}});
  const original=sqlite.ingest.bind(sqlite);
  sqlite.ingest=(id,payload,options)=>{events.push(payload.eventId);return original(id,payload,options);};
  const bridge=new TraccarBridge(store,{url:'http://gateway.test',token:'test',fetcher:async url=>{
    const parsed=new URL(url);
    if(parsed.pathname==='/api/devices')return Response.json([{id:42,uniqueId:device.uniqueId,status:'online',lastUpdate:new Date(now).toISOString()}]);
    return Response.json(parsed.searchParams.has('from')?[make(1,-30000)]:[make(2,0)]);
  }});
  await bridge.sync();
  assert.equal(bridge.state.connected,true);
  assert.deepEqual(events,['traccar:1','traccar:2']);
  assert.equal((await store.raw(device.id)).traccarId,42);
  assert.equal((await store.history(device.id,now-60000,now)).positions.length,2);
});

test('async relay audit is durable before dispatch, rechecks safety, and never resends uncertain commands',async t=>{
  const now=Date.parse('2026-10-06T06:00:00Z');
  const {store,db}=asyncStore(t,{now:()=>now});
  const {device}=await store.createDevice({name:'Async relay',model:'FMB920',uniqueId:'123456789012345'});
  await db.prepare('UPDATE devices SET traccarId=42 WHERE id=?').run(device.id);
  const fix=async(offset,changes={})=>store.ingest(device.id,{eventId:`fix:${offset}:${JSON.stringify(changes)}`,recordedAt:new Date(now+offset).toISOString(),latitude:18.52,longitude:73.85,speed:0,ignition:false,accuracy:8,...changes});
  await fix(-30000);await fix(0);
  let sends=0;
  const bridge={relaySupported:async()=>true,sendRelay:async()=>{
    sends++;
    assert.equal((await db.prepare('SELECT * FROM relay_commands WHERE id=?').get('uncertain')).status,'checking');
    throw Error('timeout');
  }};
  const relay=new RelayService(store,bridge,{enabled:true});
  await relay.configure(device.id,{installer:'Async bench',starterOnly:true,polarityVerified:true});
  const input={action:'inhibit',confirmation:device.uniqueId,requestId:'uncertain',reason:'Bench test'};
  assert.equal((await relay.execute(device.id,input)).status,'unknown');
  assert.equal((await relay.execute(device.id,input)).status,'unknown');assert.equal(sends,1);
  assert.equal((await relay.status(device.id)).installation.installer,'Async bench');
  const another=new RelayService(store,bridge,{enabled:true});
  assert.equal((await another.execute(device.id,input)).status,'unknown');assert.equal(sends,1);
});

test('relay async audit failure prevents dispatch and safety is rechecked after gateway telemetry',async t=>{
  const now=Date.parse('2026-10-06T06:00:00Z');
  const {store,db}=asyncStore(t,{now:()=>now});
  const {device}=await store.createDevice({name:'Safety relay',model:'FMB920',uniqueId:'123456789012345'});
  const fix=async(offset,speed=0)=>store.ingest(device.id,{eventId:`${offset}:${speed}`,recordedAt:new Date(now+offset).toISOString(),latitude:18.52,longitude:73.85,speed,ignition:false,accuracy:8});
  await fix(-30000);await fix(0);
  let sends=0;
  const bridge={relaySupported:async()=>{await fix(0,20);return true;},sendRelay:async()=>{sends++;return {detail:'sent'};}};
  const relay=new RelayService(store,bridge,{enabled:true});
  await relay.configure(device.id,{installer:'Bench',starterOnly:true,polarityVerified:true});
  const input={action:'inhibit',confirmation:device.uniqueId,requestId:'moving',reason:'Bench test'};
  assert.equal((await relay.execute(device.id,input)).status,'blocked');assert.equal(sends,0);
  await db.prepare('DELETE FROM positions WHERE deviceId=?').run(device.id);
  await fix(-30000);await fix(0);
  await db.prepare('DELETE FROM relay_commands').run();
  const prepare=db.prepare;
  db.prepare=sql=>sql.startsWith('INSERT INTO relay_commands')?{run:async()=>{await turn();throw Error('audit unavailable');}}:prepare(sql);
  await assert.rejects(relay.execute(device.id,{...input,requestId:'no-audit'}),/audit unavailable/);
  assert.equal(sends,0);
});
