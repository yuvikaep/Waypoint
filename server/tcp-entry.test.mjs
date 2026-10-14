import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createConnection } from 'node:net';
import { createTcpEntry } from './tcp-entry.mjs';

test('alternate TCP entry preserves fragmented GT06 frames and HTTP requests',async t=>{
  const received=[];
  const targets=await Promise.all(['gps','http'].map(async kind=>{
    const sockets=new Set(),server=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('data',chunk=>{received.push({kind,chunk});socket.write(chunk);});});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>{for(const socket of sockets)socket.destroy();server.close(resolve);}));
    return server.address().port;
  }));
  const entry=createTcpEntry({gpsPort:targets[0],httpPort:targets[1]});
  await new Promise(resolve=>entry.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>entry.close(resolve)));
  for(const [kind,bytes] of [['gps',Buffer.from('78780d0109999999999999990001a3dc0d0a','hex')],['http',Buffer.from('GET / HTTP/1.1\r\nHost: example.test\r\n\r\n')]]){
    const socket=createConnection({host:'127.0.0.1',port:entry.address().port});
    try{
      const echoed=await new Promise((resolve,reject)=>{
        let response=Buffer.alloc(0);socket.setTimeout(3000,()=>reject(Error('Proxy response timeout')));socket.on('error',reject);
        socket.on('connect',()=>{socket.write(bytes.subarray(0,1));setTimeout(()=>socket.write(bytes.subarray(1)),10);});
        socket.on('data',chunk=>{response=Buffer.concat([response,chunk]);if(response.length>=bytes.length)resolve(response);});
      });
      assert.deepEqual(echoed,bytes);assert.ok(received.some(item=>item.kind===kind));
    }finally{socket.destroy();}
  }
});
