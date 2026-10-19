import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandChannel } from './command-channel.mjs';
import { TraccarBridge } from './traccar.mjs';
import { TrackingStore } from './tracking-store.mjs';

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
  assert.deepEqual(sent[0],{deviceId:3,type:'custom',textChannel:false,attributes:{data:'TIMER,10,60#'}},'maintenance text may queue');
  assert.equal((await send('SENDS,0#')).status,200,'GPS always on');sent.pop();
  // Under 5 seconds the firmware stops uploading while the ignition is off, so it is refused here.
  for(const bad of ['RELAY,1#','FACTORY#','TIMER,1,60#','TIMER,20,1#','SERVER,1,evil host,1,0#'])assert.equal((await send(bad)).status,403,bad);
  assert.equal(sent.length,1);
  const packets=await (await fetch(base+'/api/packets?uniqueId=867111062240426&limit=10',{headers})).json();
  assert.deepEqual(packets.packets.map(p=>p.tag),['connected','Login','Server ack · Login','Location','id: 867111062240426, time: 2026-10-15 10:54:30, lat: 25.54839, lon: 82.76842']);
  assert.equal(packets.packets[1].at,'2026-10-15T10:54:31Z');
  assert.equal((await fetch(base+'/api/packets?uniqueId=../etc',{headers})).status,400);
  const bridge=new TraccarBridge(null,{url:base,token:secret});
  assert.equal(await bridge.sendText({traccarId:3},'RESET#'),'sent');
  assert.equal((await bridge.packets({uniqueId:'867111062240426'})).length,5);
});

test('a command keeps its own text when it goes unanswered, and a late reply still lands on it', t => {
  let now = Date.parse('2026-10-19T13:18:00Z');
  const store = new TrackingStore(':memory:', { now: () => now }); t.after(() => store.close());
  const device = store.createDevice({ name: 'PT06 TEST', model: 'PT06', uniqueId: '356218606437323' }).device;
  store.recordCommand(device.id, 'sent', 'CMD STATUS# sent over GPRS.');
  now += 6 * 60000; store.tick();
  let row = store.deviceCommands(device.id)[0];
  assert.equal(row.status, 'timed out');
  assert.match(row.detail, /^CMD STATUS# sent over GPRS\. · No reply within five minutes\.$/, 'it still says which command it was');
  // The tracker answers on its next connection, after the command was given up on.
  now += 60000;
  store.ingest(device.id, { eventId: 'reply-1', recordedAt: new Date(now).toISOString(), latitude: 25.27, longitude: 82.83, extra: { result: 'Battery:83%,GPRS:Link Up,GSM Signal:4' } }, { heartbeat: false });
  row = store.deviceCommands(device.id)[0];
  assert.equal(row.status, 'answered');
  assert.equal(row.detail, 'CMD STATUS# sent over GPRS. → Reply: Battery:83%,GPRS:Link Up,GSM Signal:4');
});

test('a tracker that hangs up every minute gets its command right after its next Login', async t => {
  const { mkdtempSync, writeFileSync, appendFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'wp-held-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'tracker-server.log');
  const stamp = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const login = '78781101035621860643732300002122082302f00d0a';
  let clock = Date.parse('2026-10-19T13:18:51Z');
  // The PT06 pattern from the receiver log: connect, Login, heartbeat, and about a minute later it hangs up.
  writeFileSync(log, [
    `${stamp(clock - 62000)}  INFO: [Tabc00001] connected`,
    `${stamp(clock - 60000)}  INFO: [Tabc00001: gt06 < 106.222.244.83] ${login}`,
    `${stamp(clock - 60000)}  INFO: [Tabc00001: gt06 > 106.222.244.83] 7878050108233e0d0d0a`,
    `${stamp(clock - 120000)}  INFO: [Tabc00000] disconnected`,
    `${stamp(clock - 120000)}  INFO: [Tabc00000: gt06 < 106.222.240.1] ${login}`,
  ].join('\n') + '\n');
  const sent = [];
  const secret = 'cloud-command-test-secret-32-characters';
  let ticks = 0;
  const server = createCommandChannel({
    secret, traccarUrl: 'http://127.0.0.1:8082', traccarToken: 'receiver-only-token', logFile: log, now: () => clock,
    pollMs: 0,
    // Each poll the clock moves on a second; after a few the tracker reconnects and logs in again.
    wait: async () => {
      clock += 1000; ticks++;
      if (ticks === 3) appendFileSync(log, `${stamp(clock)}  INFO: [Tabc00002] connected\n${stamp(clock)}  INFO: [Tabc00002: gt06 < 106.222.241.79] ${login}\n`);
    },
    fetcher: async (url, options) => {
      if (url.includes('/devices?')) return Response.json([{ id: 3, uniqueId: '356218606437323', status: 'online', lastUpdate: new Date(clock).toISOString() }]);
      if (url.endsWith('/commands/send')) { sent.push({ at: clock, body: JSON.parse(options.body) }); return Response.json({ id: 12 }); }
      throw Error('Unexpected receiver route ' + url);
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const asked = clock;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/commands/send`, {
    method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 3, type: 'custom', textChannel: false, attributes: { data: 'STATUS#' } }),
  });
  assert.equal(response.status, 202, 'held, not sent into a connection about to close');
  assert.deepEqual(sent, []);
  for (let i = 0; i < 20 && !sent.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(sent.length, 1, 'sent once the tracker logged in again');
  assert.equal(sent[0].body.attributes.data, 'STATUS#');
  assert.ok(sent[0].at >= asked + 3000, 'only after the next Login');
});
