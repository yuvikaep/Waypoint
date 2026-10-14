import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandChannel } from './command-channel.mjs';
import { TraccarBridge } from './traccar.mjs';

test('location command channel authenticates, restricts routes, checks capability and fails closed',async t=>{
  const secret='cloud-command-test-secret-32-characters',calls=[];let online=true,types=[{type:'positionSingle'}];
  const server=createCommandChannel({secret,traccarUrl:'http://127.0.0.1:8082',traccarToken:'receiver-only-token',fetcher:async(url,options)=>{
    calls.push({url,options});
    assert.equal(options.headers.Authorization,'Bearer receiver-only-token');
    if(url.includes('/commands/types'))return Response.json(types);
    if(url.includes('/devices?'))return Response.json([{id:3,status:online?'online':'offline',lastUpdate:new Date().toISOString()}]);
    if(url.endsWith('/commands/send'))return Response.json({id:10});
    throw Error('Unexpected receiver route');
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base=`http://127.0.0.1:${server.address().port}`,path='/api/commands/types?deviceId=3&textChannel=false';
  assert.equal((await fetch(base+path)).status,401);assert.equal(calls.length,0);
  const headers={Authorization:`Bearer ${secret}`,'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/devices',{headers})).status,404);
  assert.equal((await fetch(base+'/api/commands/types?deviceId=abc&textChannel=false',{headers})).status,400);
  assert.equal((await fetch(base+path,{headers})).status,200);
  const bridge=new TraccarBridge(null,{url:base,token:secret});
  assert.equal((await bridge.ping({traccarId:3})).status,'sent');
  const payload=JSON.parse(calls.find(call=>call.url.endsWith('/commands/send')).options.body);
  assert.deepEqual(payload.attributes,{noQueue:true});
  const sendCount=()=>calls.filter(call=>call.url.endsWith('/commands/send')).length;
  online=false;await assert.rejects(bridge.ping({traccarId:3}),/offline/);assert.equal(sendCount(),1);
  const forbidden=await fetch(base+'/api/commands/send',{method:'POST',headers,body:JSON.stringify({deviceId:3,type:'engineStop',textChannel:false})});
  assert.equal(forbidden.status,403);assert.equal(sendCount(),1);
  types=[{type:'custom'}];assert.equal((await bridge.ping({traccarId:3})).status,'unsupported');assert.equal(sendCount(),1);
});
