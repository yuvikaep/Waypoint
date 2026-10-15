import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayAgent } from './gateway-agent.mjs';

test('gateway worker sends real timestamps and retries from cloud checkpoint',async()=>{
  const now=Date.now(),reports=[],device={id:'cloud-device',uniqueId:'123456789012345',model:'GT06',name:'Truck',createdAt:now-100000};
  const point={id:9,deviceId:3,fixTime:new Date(now-10000).toISOString(),valid:true};
  const fetcher=async(url,options)=>{
    let value;
    if(url.endsWith('/gateway/devices'))value={devices:[device]};
    else if(url.endsWith('/api/devices'))value=[{id:3,uniqueId:device.uniqueId,lastUpdate:new Date(now-20000).toISOString(),status:'online'}];
    else if(url.includes('/api/positions'))value=[point];
    else if(url.endsWith('/gateway/sync')){reports.push(JSON.parse(options.body));value={ok:true};}
    else throw Error(`Unexpected route ${url}`);
    return {ok:true,status:200,json:async()=>value};
  };
  const agent=new GatewayAgent({cloudUrl:'https://cloud.example',cloudSecret:'secret',traccarUrl:'http://localhost:8082',traccarToken:'token',fetcher,now:()=>now});
  await agent.sync();await agent.sync();
  assert.equal(reports.length,2);assert.equal(reports[0].devices[0].lastUpdate,new Date(now-20000).toISOString());
  assert.equal(reports[0].devices[0].positions.length,1);assert.equal(reports[0].devices[0].cursor,now);
});

test('one failing tracker does not stop the rest of the fleet from syncing',async()=>{
  const now=Date.now(),reports=[];
  const devices=[{id:'bad',uniqueId:'111111111111111',model:'GT06',name:'Bad',createdAt:now-100000},{id:'good',uniqueId:'222222222222222',model:'GT06',name:'Good',createdAt:now-100000}];
  const fetcher=async(url,options)=>{
    let value;
    if(url.endsWith('/gateway/devices'))value={devices};
    else if(url.endsWith('/api/devices'))value=[{id:1,uniqueId:devices[0].uniqueId,status:'online'},{id:2,uniqueId:devices[1].uniqueId,status:'online'}];
    else if(url.includes('/api/positions'))value=[];
    else if(url.endsWith('/gateway/sync')){
      const body=JSON.parse(options.body);reports.push(body);
      if(body.devices[0]?.id==='bad')return {ok:false,status:409,json:async()=>({error:'Tracker identity mismatch.'})};
      value={ok:true};
    }
    return {ok:true,status:200,json:async()=>value};
  };
  const agent=new GatewayAgent({cloudUrl:'https://cloud.example',cloudSecret:'secret',traccarUrl:'http://localhost:8082',traccarToken:'token',fetcher,now:()=>now});
  await agent.sync();
  assert.ok(reports.some(r=>r.devices[0]?.id==='good'&&r.devices[0].cursor===now));
  assert.match(reports.at(-1).error,/Bad: Gateway dependency HTTP 409\. Tracker identity mismatch\./);
});

test('fixes a tracker uploads late with their original time still reach the cloud',async()=>{
  let now=Date.now();const reports=[],device={id:'cloud-device',uniqueId:'123456789012345',model:'GT06',name:'Truck',createdAt:now-6*3600000,cursor:now};
  // Receiver state: an old fix (id 50) arrives only after the cursor has moved past its time.
  let stored=[{id:40,deviceId:3,fixTime:new Date(now-5000).toISOString(),valid:true}];
  const fetcher=async(url,options)=>{
    let value;const u=new URL(url);
    if(url.endsWith('/gateway/devices'))value={devices:[device]};
    else if(u.pathname==='/api/devices')value=[{id:3,uniqueId:device.uniqueId,status:'online'}];
    else if(u.pathname==='/api/positions'&&u.searchParams.has('from')){const from=Date.parse(u.searchParams.get('from')),to=Date.parse(u.searchParams.get('to'));value=stored.filter(p=>Date.parse(p.fixTime)>=from&&Date.parse(p.fixTime)<=to)}
    else if(u.pathname==='/api/positions')value=[stored.reduce((a,b)=>a.id>b.id?a:b)];
    else if(url.endsWith('/gateway/sync')){const body=JSON.parse(options.body);reports.push(body);if(body.devices[0]?.cursor)device.cursor=body.devices[0].cursor;value={ok:true}}
    return {ok:true,status:200,json:async()=>value};
  };
  const agent=new GatewayAgent({cloudUrl:'https://cloud.example',cloudSecret:'secret',traccarUrl:'http://localhost:8082',traccarToken:'token',fetcher,now:()=>now});
  await agent.sync();
  stored=[...stored,{id:50,deviceId:3,fixTime:new Date(now-2*3600000).toISOString(),valid:true},{id:51,deviceId:3,fixTime:new Date(now).toISOString(),valid:true}];
  now+=61000;await agent.sync();
  const sent=reports.flatMap(r=>r.devices.flatMap(d=>d.positions.map(p=>p.id)));
  assert.ok(sent.includes(50),'late upload forwarded');assert.ok(sent.includes(51));
  now+=61000;const before=reports.length;await agent.sync();
  assert.ok(!reports.slice(before).flatMap(r=>r.devices.flatMap(d=>d.positions.map(p=>p.id))).includes(50),'not resent once delivered');
});
