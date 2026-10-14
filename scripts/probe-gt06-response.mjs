import { createConnection } from 'node:net';
import assert from 'node:assert/strict';

// Use only the explicitly created disposable receiver registration. No GPS
// position is sent, and no real device heartbeat is impersonated.
const identifier='999999999999999';
let crc=0xffff;
const data=Buffer.concat([Buffer.from([0x0d,1]),Buffer.from('0'+identifier,'hex'),Buffer.from([0,1])]);
for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?(crc>>>1)^0x8408:crc>>>1;}
const checksum=Buffer.alloc(2);checksum.writeUInt16BE((crc^0xffff)&0xffff);
const packet=Buffer.concat([Buffer.from('7878','hex'),data,checksum,Buffer.from('0d0a','hex')]);
const socket=createConnection({host:'92.4.84.227',port:5023});
try{
  const reply=await new Promise((resolve,reject)=>{
    const chunks=[];let length=0;
    socket.setTimeout(15000,()=>reject(Error('No receiver acknowledgement within 15 seconds.')));
    socket.on('error',reject);
    socket.on('connect',()=>socket.write(packet));
    socket.on('data',chunk=>{chunks.push(chunk);length+=chunk.length;if(length>=10)resolve(Buffer.concat(chunks));});
  });
  assert.equal(reply.subarray(0,4).toString('hex'),'78780501');
  assert.equal(reply.subarray(8,10).toString('hex'),'0d0a');
  console.log('PASS: external GT06 login received a server acknowledgement. No coordinates were submitted.');
}finally{socket.destroy();}
