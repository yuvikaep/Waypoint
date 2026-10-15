import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PostgresTrackingStore } from './postgres-store.mjs';
import { CloudSessions, cloudRateLimit, gatewayRequest } from './cloud-runtime.mjs';
import { TraccarBridge } from './traccar.mjs';

test('PostgreSQL durable fleet, links, sessions, and real heartbeat contracts', {skip:!process.env.TEST_DATABASE_URL}, async()=>{
  const client=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});await client.connect();
  let now=Date.now();let store;
  try{
    store=await PostgresTrackingStore.create({client,now:()=>now});
    const email=`cloud-${crypto.randomUUID()}@example.test`;
    const customer=await store.registerCustomer({name:'Cloud customer',email,password:'cloud-test-password'});
    assert.equal((await store.customerLogin(email,'cloud-test-password')).id,customer.id);
    await assert.rejects(store.registerCustomer({name:'Duplicate',email,password:'cloud-test-password'}),e=>e.status===409);
    const mobile=(await store.createDevice({name:'Driver',model:'Mobile'},customer.id)).device;
    assert.equal(mobile.createdAt,now);assert.equal(mobile.tenantId,customer.id);
    const link=await store.createDriverLink(mobile.id);
    assert.equal((await store.createDriverLink(mobile.id)).code,link.code);
    const joined=await store.joinDriver(link.code);
    assert.equal((await store.driverSession(joined.secret)).device.id,mobile.id);
    const point={eventId:'fix-1',recordedAt:new Date(now).toISOString(),latitude:28.4,longitude:77.04,speed:0};
    assert.equal((await store.ingest(mobile.id,point)).duplicate,false);
    assert.equal((await store.ingest(mobile.id,point)).duplicate,true);
    now+=200000;await store.seen(mobile.id,now);
    const device=await store.device(mobile.id);
    assert.equal(device.status,'No GPS fix');assert.equal(device.position.recordedAt,now-200000);
    assert.equal(device.lastSeen,now);assert.equal(device.position.deviceId,mobile.id);
    assert.equal((await store.history(mobile.id,now-300000,now)).positions.length,1);
    // Owner's overspeed limit and switch.
    await store.updateDevice(mobile.id,{speedLimit:40,speedAlert:true});
    await store.ingest(mobile.id,{...point,eventId:'fast-1',recordedAt:new Date(now).toISOString(),speed:50});
    assert.equal((await store.alerts(customer.id)).filter(a=>a.type==='speed').length,1);
    await store.updateDevice(mobile.id,{speedAlert:false});assert.equal((await store.raw(mobile.id)).speedAlert,0);
    await store.saveWorkspaceData(customer.id,'documents',[{number:'cloud-document'}]);
    assert.equal((await store.workspaceData(customer.id,'documents'))[0].number,'cloud-document');
    assert.equal(await store.workspaceData('other-tenant','documents'),null);
    const sessions=new CloudSessions(client);await sessions.set('test-session',{role:'customer',tenantId:customer.id,expiresAt:Date.now()+60000});
    assert.equal((await new CloudSessions(client).get('test-session')).tenantId,customer.id);
    await sessions.set('test-generation','generation');assert.equal(await sessions.get('test-generation'),'generation');
    await sessions.delete('test-session');assert.equal(await sessions.get('test-session'),undefined);
    const limit=cloudRateLimit(client),key=crypto.randomUUID();await limit(key,1);await assert.rejects(limit(key,1),e=>e.status===429);
    await store.createDriverLink(mobile.id,{regenerate:true});
    await assert.rejects(store.driverSession(joined.secret),e=>e.status===401);
    now=Date.now();
    const hardware=(await store.createDevice({name:'GT06',model:'GT06',uniqueId:'123456789012345'},customer.id)).device;
    process.env.GPS_GATEWAY_SECRET='test-gateway-secret';
    const req={url:'/api/gps/gateway/sync',method:'POST',headers:{authorization:'Bearer test-gateway-secret'},body:{connected:true,devices:[{id:hardware.id,uniqueId:hardware.uniqueId,traccarId:7,status:'online',lastUpdate:new Date(now).toISOString(),positions:[{deviceId:7,id:1,valid:true,fixTime:new Date(now).toISOString(),serverTime:new Date(now).toISOString(),latitude:28.4,longitude:77.04,speed:0,course:0,accuracy:5,attributes:{sat:8}}]}]}};
    // Cloud runtime checks actual clock; reset the controlled store clock first.
    now=Date.now();req.body.devices[0].lastUpdate=new Date(now).toISOString();req.body.devices[0].positions[0].fixTime=new Date(now).toISOString();
    let result;const res={writeHead(){},end(value){result=JSON.parse(value)}};
    assert.equal(await gatewayRequest(req,res,store,client,new TraccarBridge(store)),true);
    assert.equal(result.ok,true);assert.equal((await store.device(hardware.id)).lastSeen,now);
    const tracked=(await store.devices(customer.id)).find(d=>d.id===hardware.id);
    assert.equal(tracked.position.latitude,28.4);assert.equal(tracked.position.longitude,77.04);
    assert.equal(tracked.position.recordedAt,now);assert.equal(tracked.status,'Stopped');
    assert.equal((await store.history(hardware.id,now-60000,now+60000)).positions.length,1);
  }finally{await store?.close();await client.end();}
});

test('PostgreSQL password change and admin recovery reset', {skip:!process.env.TEST_DATABASE_URL}, async()=>{
  const client=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});await client.connect();
  let store;
  try{
    store=await PostgresTrackingStore.create({client});
    await client.query('DELETE FROM admins');
    const admin=await store.createAdmin(`boss-${crypto.randomUUID()}@example.test`);
    const customer=await store.registerCustomer({name:'Pw customer',email:`pw-${crypto.randomUUID()}@example.test`,password:'first-password-1234'});
    await assert.rejects(store.changePassword('customer',customer.email,'wrong-password-1234','second-password-1234'),e=>e.status===400&&/incorrect/.test(e.message));
    await assert.rejects(store.changePassword('customer',customer.email,'first-password-1234','short'),e=>e.status===400);
    await store.changePassword('customer',customer.email,'first-password-1234','second-password-1234');
    await assert.rejects(store.customerLogin(customer.email,'first-password-1234'),e=>e.status===401);
    assert.equal((await store.customerLogin(customer.email,'second-password-1234')).id,customer.id);
    const reset=await store.resetAdminPassword();
    assert.equal(reset.email,admin.email);
    await assert.rejects(store.adminLogin(admin.email,admin.password),e=>e.status===401);
    await store.changePassword('admin',admin.email,reset.password,'admin-chosen-password-9');
    assert.equal((await store.adminLogin(admin.email,'admin-chosen-password-9')).email,admin.email);
    await store.createAdmin(`second-${crypto.randomUUID()}@example.test`);
    await assert.rejects(store.resetAdminPassword(),e=>e.status===409);
  }finally{await store?.close();await client.end();}
});
