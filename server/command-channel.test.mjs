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

test('maintenance commands: only approved text reaches an online tracker; packets come from the log',async t=>{
  const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
  const dir=mkdtempSync(join(tmpdir(),'wp-log-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const log=join(dir,'tracker-server.log');
  writeFileSync(log,[
    '2026-10-15 10:54:30  INFO: [Tb39da939] connected',
    '2026-10-15 10:54:31  INFO: [Tb39da939: gt06 < 1.2.3.4] 78780d010867111062240426000183a80d0a',
    '2026-10-15 10:54:31  INFO: [Tb39da939: gt06 > 1.2.3.4] 787805010001d9dc0d0a',
    '2026-10-15 10:54:32  INFO: [Tb39da939: gt06 < 1.2.3.4] 78781f121a0a0f0a361ecf02bdb52508e14d7506555a019536100900e08802817d830d0a',
    '2026-10-15 10:54:33  INFO: [Tother000: gt06 < 5.6.7.8] 78780a1304f0047d02000350530d0a',
    '2026-10-15 10:54:35  INFO: [Tb39da939] id: 867111062240426, time: 2026-10-15 10:54:30, lat: 25.54839, lon: 82.76842',
  ].join('\n'));
  const secret='cloud-command-test-secret-32-characters',sent=[];
  const server=createCommandChannel({secret,traccarUrl:'http://127.0.0.1:8082',traccarToken:'receiver-only-token',logFile:log,fetcher:async(url,options)=>{
    if(url.includes('/devices?'))return Response.json([{id:3,status:'online',lastUpdate:new Date().toISOString()}]);
    if(url.endsWith('/commands/send')){sent.push(JSON.parse(options.body));return Response.json({id:11})}
    throw Error('Unexpected receiver route '+url);
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base=`http://127.0.0.1:${server.address().port}`,headers={Authorization:`Bearer ${secret}`,'Content-Type':'application/json'};
  const send=data=>fetch(base+'/api/commands/send',{method:'POST',headers,body:JSON.stringify({deviceId:3,type:'custom',textChannel:false,attributes:{data}})});
  assert.equal((await send('TIMER,10,60#')).status,200);
  assert.deepEqual(sent[0],{deviceId:3,type:'custom',textChannel:false,attributes:{data:'TIMER,10,60#',noQueue:true}});
  for(const bad of ['RELAY,1#','FACTORY#','TIMER,1,60#','SERVER,1,evil host,1,0#'])assert.equal((await send(bad)).status,403,bad);
  assert.equal(sent.length,1);
  const packets=await (await fetch(base+'/api/packets?uniqueId=867111062240426&limit=10',{headers})).json();
  assert.deepEqual(packets.packets.map(p=>p.tag),['connected','Login','Server ack · Login','Location','id: 867111062240426, time: 2026-10-15 10:54:30, lat: 25.54839, lon: 82.76842']);
  assert.equal(packets.packets[1].at,'2026-10-15T10:54:31Z');
  assert.equal((await fetch(base+'/api/packets?uniqueId=../etc',{headers})).status,400);
  const bridge=new TraccarBridge(null,{url:base,token:secret});
  assert.equal(await bridge.sendText({traccarId:3},'RESET#'),'sent');
  assert.equal((await bridge.packets({uniqueId:'867111062240426'})).length,5);
});
