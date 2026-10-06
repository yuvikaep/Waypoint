import test from 'node:test';
import assert from 'node:assert/strict';
import {TrackingStore} from './tracking-store.mjs';
import {RelayService} from './relay.mjs';
import {TraccarBridge} from './traccar.mjs';
import {createTrackingServer} from './tracking.mjs';

function fixture(t){
  let now=Date.parse('2026-10-06T06:00:00Z');
  const store=new TrackingStore(':memory:',{now:()=>now});t.after(()=>store.close());
  const {device}=store.createDevice({name:'Relay test',model:'FMB920',uniqueId:'123456789012345'});
  store.db.prepare('UPDATE devices SET traccarId=42 WHERE id=?').run(device.id);
  let sends=0;
  const bridge={state:{},sync:async()=>{},relaySupported:async()=>true,sendRelay:async()=>{sends++;return {detail:'Sent; physical state unverified.'}}};
  const relay=new RelayService(store,bridge,{enabled:true});
  relay.configure(device.id,{installer:'Bench verification',starterOnly:true,polarityVerified:true});
  const fix=(offset,changes={})=>store.ingest(device.id,{eventId:String(Math.random()),recordedAt:new Date(now+offset).toISOString(),latitude:18.52,longitude:73.85,speed:0,ignition:false,accuracy:8,...changes});
  fix(-30000);fix(0);
  const input={action:'inhibit',confirmation:device.uniqueId,requestId:'test-command',reason:'Bench test'};
  return {store,device,bridge,relay,input,fix,advance:ms=>now+=ms,sends:()=>sends};
}
test('relay is default-disabled and mobile devices cannot be commissioned',async t=>{
  const f=fixture(t),disabled=new RelayService(f.store,f.bridge);
  await assert.rejects(disabled.execute(f.device.id,f.input),/disabled/);
  const mobile=f.store.createDevice({name:'Phone',model:'Mobile'}).device;
  assert.throws(()=>f.relay.configure(mobile.id,{starterOnly:true,polarityVerified:true,installer:'x'}),/no relay profile/);
  assert.throws(()=>f.relay.configure(f.device.id,{starterOnly:false,polarityVerified:true,installer:'x'}),/Fuel\/ignition/);
  assert.equal(f.sends(),0);
});
for(const [name,change] of [['moving',{speed:12}],['ignition on',{ignition:true}],['unknown ignition',{ignition:null}],['poor accuracy',{accuracy:100}],['unknown accuracy',{accuracy:0}],['position drift',{latitude:18.6}]]){
  test(`inhibit rejects ${name}`,async t=>{
    const f=fixture(t);f.fix(0,change);
    await assert.rejects(f.relay.execute(f.device.id,f.input),/stationary/);
    assert.equal(f.sends(),0);
  });
}
test('stale fixes cannot be made safe by fresh heartbeats',async t=>{
  const f=fixture(t);f.advance(31000);f.store.seen(f.device.id);
  await assert.rejects(f.relay.execute(f.device.id,f.input),/GPS fix/);assert.equal(f.sends(),0);
});
test('successful requests are idempotent, rate limited, audited and not marked physically confirmed',async t=>{
  const f=fixture(t),result=await f.relay.execute(f.device.id,f.input);
  assert.equal(result.status,'sent-unverified');assert.equal(result.actor,'workspace-admin');
  assert.equal((await f.relay.execute(f.device.id,f.input)).id,result.id);assert.equal(f.sends(),1);
  await assert.rejects(f.relay.execute(f.device.id,{...f.input,action:'restore'}),/another operation/);
  await assert.rejects(f.relay.execute(f.device.id,{...f.input,requestId:'another'}),/Wait 60/);
});
test('safety is rechecked after gateway I/O and unsupported commands never dispatch',async t=>{
  const f=fixture(t);f.bridge.relaySupported=async()=>{f.fix(0,{speed:20});return true};
  assert.equal((await f.relay.execute(f.device.id,f.input)).status,'blocked');assert.equal(f.sends(),0);
});
test('gateway refusal and timeouts fail closed without automatic resend',async t=>{
  const f=fixture(t);f.bridge.sendRelay=async()=>{throw Error('timeout')};
  assert.equal((await f.relay.execute(f.device.id,f.input)).status,'unknown');
  assert.equal((await f.relay.execute(f.device.id,f.input)).status,'unknown');
});
test('unsupported capability and revoked installation block dispatch after lookup',async t=>{
  const f=fixture(t);f.bridge.relaySupported=async()=>false;
  assert.equal((await f.relay.execute(f.device.id,f.input)).status,'blocked');assert.equal(f.sends(),0);
  f.advance(60001);f.fix(-30000);f.fix(0);
  f.bridge.relaySupported=async()=>{f.relay.configure(f.device.id,{enabled:false});return true};
  assert.equal((await f.relay.execute(f.device.id,{...f.input,requestId:'revoked'})).status,'blocked');assert.equal(f.sends(),0);
});
test('relay capability requires matching IMEI, online status, protocol and both command types',async t=>{
  const f=fixture(t);const d=f.store.raw(f.device.id);
  let remote={id:42,uniqueId:d.uniqueId,status:'online',positionId:9,lastUpdate:new Date(f.store.now()).toISOString()};
  let p={id:9,deviceId:42,protocol:'teltonika',valid:true,fixTime:new Date(f.store.now()).toISOString(),serverTime:new Date(f.store.now()).toISOString(),latitude:18.52,longitude:73.85,speed:0,course:0,accuracy:8,attributes:{ignition:false}};
  let types=[{type:'engineStop'},{type:'engineResume'}];
  const bridge=new TraccarBridge(f.store,{url:'http://gateway.test',token:'test',fetcher:async url=>Response.json(url.includes('/devices?')?[remote]:url.includes('/positions?')?[p]:types)});
  assert.equal(await bridge.relaySupported(d,'teltonika'),true);
  remote.status='offline';assert.equal(await bridge.relaySupported(d,'teltonika'),false);remote.status='online';
  remote.uniqueId='another';assert.equal(await bridge.relaySupported(d,'teltonika'),false);remote.uniqueId=d.uniqueId;
  p.protocol='gt06';assert.equal(await bridge.relaySupported(d,'teltonika'),false);p.protocol='teltonika';
  types=[{type:'engineStop'}];assert.equal(await bridge.relaySupported(d,'teltonika'),false);
});
test('relay gateway payload disables offline queuing and unexpected queue responses are rejected',async t=>{
  const f=fixture(t);let payload;
  const bridge=new TraccarBridge(f.store,{url:'http://gateway.test',token:'test',fetcher:async(url,options)=>{payload=JSON.parse(options.body);return Response.json({}, {status:200})}});
  await bridge.sendRelay(f.store.raw(f.device.id),'inhibit');
  assert.equal(payload.type,'engineStop');assert.deepEqual(payload.attributes,{noQueue:true});assert.equal(payload.textChannel,false);
  await bridge.sendRelay(f.store.raw(f.device.id),'restore');assert.equal(payload.type,'engineResume');
  bridge.fetcher=async()=>Response.json({}, {status:202});
  await assert.rejects(bridge.sendRelay(f.device,'inhibit'),/Unexpected/);
});
test('relay endpoints require workspace session and explicit admin re-authentication',async t=>{
  const f=fixture(t),key='test-admin-key-at-least-24-characters';
  const server=createTrackingServer({store:f.store,adminToken:key,bridge:f.bridge});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()}));
  const base=`http://127.0.0.1:${server.address().port}/api/gps`,path=`/devices/${f.device.id}/relay`;
  assert.equal((await fetch(base+path)).status,401);
  const login=await fetch(base+'/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:key})});
  const headers={cookie:login.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json'};
  const get=await fetch(base+path,{headers});assert.equal((await get.json()).enabled,false);
  assert.equal((await fetch(base+path,{method:'POST',headers,body:JSON.stringify(f.input)})).status,403);
  assert.equal((await fetch(base+path,{method:'POST',headers,body:JSON.stringify({...f.input,adminKey:key})})).status,403);
  assert.equal(f.sends(),0);
});
