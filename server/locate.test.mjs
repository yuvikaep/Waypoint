import test from 'node:test';
import assert from 'node:assert/strict';
import {TrackingStore} from './tracking-store.mjs';
import {TraccarBridge} from './traccar.mjs';
import {parseWhere,locationTick} from './locate.mjs';

const REPLY='Current position!\nLat:N25.270162,Lon:E82.837522,Course:25,Speed:0,DateTime:\n2026-10-17  14:50:50';

test('parses the tracker\'s WHERE# reply and refuses anything else',()=>{
  assert.deepEqual(parseWhere(REPLY),{latitude:25.270162,longitude:82.837522,heading:25,speed:0});
  assert.deepEqual(parseWhere('Current position! Lat:S33.5,Lon:W70.25,Course:359,Speed:12'),{latitude:-33.5,longitude:-70.25,heading:359,speed:12});
  for(const bad of ['','GPS not fixed','Last position! Lat:N25.2,Lon:E82.8','Current position! Lat:N0,Lon:E0','Current position! Lat:N95,Lon:E82'])assert.equal(parseWhere(bad),null,bad);
});

function setup(t){
  let now=Date.parse('2026-10-17T09:00:00Z');
  const store=new TrackingStore(':memory:',{now:()=>now});t.after(()=>store.close());
  const {device}=store.createDevice({name:'PT06 TEST',model:'PT06',uniqueId:'356218606437323',offlineSeconds:600});
  store.db.prepare('UPDATE devices SET traccarId=7 WHERE id=?').run(device.id);
  const sent=[];const bridge=new TraccarBridge(store,{url:'http://x',token:'x'});bridge.sendText=async(d,text)=>{sent.push(text);return 'queued'};
  return {store,device,bridge,sent,advance:ms=>now+=ms,now:()=>now};
}

test('a parked tracker with an old fix is asked WHERE# every few minutes, only while connected',async t=>{
  const s=setup(t);
  s.store.ingest(s.device.id,{eventId:'a',recordedAt:new Date(s.now()-30*60000).toISOString(),latitude:25.27,longitude:82.83,speed:0});
  s.store.seen(s.device.id);
  const dev=()=>s.store.raw(s.device.id);
  assert.deepEqual(await locationTick(s.store,s.bridge,dev(),s.now()),{sent:true});
  assert.deepEqual(s.sent,['WHERE#']);
  assert.match((await locationTick(s.store,s.bridge,dev(),s.now())).skipped,/asked recently/);
  s.advance(5*60000);s.store.seen(s.device.id);
  assert.deepEqual(await locationTick(s.store,s.bridge,dev(),s.now()),{sent:true});
  s.advance(6*60000);
  assert.match((await locationTick(s.store,s.bridge,dev(),s.now())).skipped,/not connected/);
  assert.equal(s.sent.length,2);
});

test('a fresh location is not asked for; the WHERE# reply becomes a new position and answers the command',async t=>{
  const s=setup(t);
  s.store.ingest(s.device.id,{eventId:'a',recordedAt:new Date(s.now()-60000).toISOString(),latitude:25.27,longitude:82.83,speed:0});s.store.seen(s.device.id);
  assert.match((await locationTick(s.store,s.bridge,s.store.raw(s.device.id),s.now())).skipped,/fresh/);
  s.advance(40*60000);s.store.seen(s.device.id);
  await locationTick(s.store,s.bridge,s.store.raw(s.device.id),s.now());
  s.advance(5000);
  const at=new Date(s.now()).toISOString();
  await s.bridge.ingest(s.device.id,{id:501,deviceId:7,protocol:'gt06',valid:true,fixTime:new Date(s.now()-40*60000).toISOString(),serverTime:at,latitude:25.27029,longitude:82.83749,speed:0,course:355,attributes:{result:REPLY}});
  const p=s.store.device(s.device.id).position;
  assert.equal(p.latitude,25.270162);assert.equal(p.longitude,82.837522);assert.equal(new Date(p.recordedAt).toISOString(),at);
  assert.match(s.store.deviceCommands(s.device.id,5)[0].status,/answered/);
  assert.match((await locationTick(s.store,s.bridge,s.store.raw(s.device.id),s.now())).skipped,/fresh/);
});
