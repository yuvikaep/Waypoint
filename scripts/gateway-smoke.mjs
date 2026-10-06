import {connect} from 'node:net';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {TrackingStore} from '../server/tracking-store.mjs';
import {TraccarBridge} from '../server/traccar.mjs';

// Synthetic protocol fixtures for the local gateway, never registered as real vehicles.
if(process.env.TRACCAR_URL!=='http://127.0.0.1:8082')throw new Error('Smoke test only runs against the local gateway.');
const store=new TrackingStore(':memory:');
const bridge=new TraccarBridge(store,{url:process.env.TRACCAR_URL,token:process.env.TRACCAR_TOKEN});
const created=[],sockets=[];
const crc=(bytes,polynomial,initial,finish=0)=>{let value=initial;for(const byte of bytes){value^=byte;for(let n=0;n<8;n++)value=value&1?(value>>>1)^polynomial:value>>>1}return (value^finish)&65535};
function gt06(type,payload,serial=1){const data=Buffer.alloc(payload.length+4);data[0]=payload.length+5;data[1]=type;payload.copy(data,2);data.writeUInt16BE(serial,data.length-2);const checksum=Buffer.alloc(2);checksum.writeUInt16BE(crc(data,0x8408,0xffff,0xffff));return Buffer.concat([Buffer.from('7878','hex'),data,checksum,Buffer.from('0d0a','hex')])}
async function socket(port){const connection=connect(port,'127.0.0.1');sockets.push(connection);connection.setTimeout(10000,()=>connection.destroy(new Error('Gateway socket timed out.')));await once(connection,'connect');return connection}
async function sendAndRead(connection,data){const reply=once(connection,'data');connection.write(data);return (await reply)[0]}
try {
  const suffix=String(Date.now()).slice(-10);
  const gt=store.createDevice({name:'TEST ONLY GT06 packet',uniqueId:'99101'+suffix,model:'GT06'}).device;
  const tel=store.createDevice({name:'TEST ONLY FMB920 packet',uniqueId:'99102'+suffix,model:'FMB920'}).device;
  await bridge.sync();assert.equal(bridge.state.connected,true,bridge.state.error);
  created.push(store.raw(gt.id).traccarId,store.raw(tel.id).traccarId);
  const gps=await socket(5023);
  const login=await sendAndRead(gps,gt06(1,Buffer.concat([Buffer.from('0'+gt.uniqueId,'hex'),Buffer.from('0001','hex')])));
  assert.equal(login[3],1,'GT06 login acknowledgement');
  const d=new Date(),payload=Buffer.alloc(26);
  Buffer.from([d.getUTCFullYear()-2000,d.getUTCMonth()+1,d.getUTCDate(),d.getUTCHours(),d.getUTCMinutes(),d.getUTCSeconds(),0xc8]).copy(payload);
  payload.writeUInt32BE(Math.round(18.52*1800000),7);payload.writeUInt32BE(Math.round(73.85*1800000),11);payload[15]=35;payload.writeUInt16BE(0x1400|90,16);payload.writeUInt16BE(404,18);payload[20]=10;payload.writeUInt16BE(100,21);payload.writeUIntBE(1000,23,3);
  gps.write(gt06(0x12,payload,2));
  const telSocket=await socket(5027),imei=Buffer.from(tel.uniqueId),imeiLength=Buffer.alloc(2);imeiLength.writeUInt16BE(imei.length);
  assert.equal((await sendAndRead(telSocket,Buffer.concat([imeiLength,imei])))[0],1,'Teltonika IMEI acknowledgement');
  const avl=Buffer.alloc(35);let offset=0;
  avl[offset++]=8;avl[offset++]=1;avl.writeBigUInt64BE(BigInt(Date.now()),offset);offset+=8;avl[offset++]=0;
  avl.writeInt32BE(Math.round(73.86*1e7),offset);offset+=4;avl.writeInt32BE(Math.round(18.53*1e7),offset);offset+=4;
  avl.writeUInt16BE(550,offset);offset+=2;avl.writeUInt16BE(180,offset);offset+=2;avl[offset++]=9;avl.writeUInt16BE(42,offset);offset+=2;
  for(const byte of [239,1,1,239,1,0,0,0,1])avl[offset++]=byte;
  assert.equal(offset,avl.length);const prefix=Buffer.alloc(8);prefix.writeUInt32BE(avl.length,4);const checksum=Buffer.alloc(4);checksum.writeUInt32BE(crc(avl,0xa001,0));
  const avlAck=await sendAndRead(telSocket,Buffer.concat([prefix,avl,checksum]));assert.equal(avlAck.readUInt32BE(),1,'Teltonika AVL acknowledgement');
  for(let attempt=0;attempt<15;attempt++){await bridge.sync();if(store.device(gt.id).position&&store.device(tel.id).position)break;await new Promise(resolve=>setTimeout(resolve,500))}
  assert.equal(bridge.state.connected,true,bridge.state.error);
  const gtFix=store.device(gt.id).position,telFix=store.device(tel.id).position;
  assert.ok(gtFix,'GT06 position imported');assert.ok(telFix,'FMB920 position imported');
  assert.ok(Math.abs(gtFix.latitude-18.52)<0.00001);assert.ok(Math.abs(gtFix.speed-35)<0.01);
  assert.ok(Math.abs(telFix.longitude-73.86)<0.00001);assert.ok(Math.abs(telFix.speed-42)<0.01);assert.equal(telFix.ignition,1);
  console.log('PASS: GT06 login + GPS packet -> Traccar -> Waypoint');
  console.log('PASS: Teltonika IMEI + Codec 8 AVL packet -> Traccar -> Waypoint');
  console.log('PASS: coordinates, km/h conversion, ignition and database import');
} finally {
  for(const connection of sockets)connection.destroy();
  for(const id of created.filter(Boolean))await bridge.request(`/devices/${id}`,{method:'DELETE'});
  store.close();
}
