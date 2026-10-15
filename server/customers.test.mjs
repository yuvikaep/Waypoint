import test from 'node:test';
import assert from 'node:assert/strict';
import {TrackingStore} from './tracking-store.mjs';
import {createTrackingServer} from './tracking.mjs';

test('loopback production proxy keeps login rate limits separate by client IP',async t=>{
  const store=new TrackingStore(':memory:');t.after(()=>store.close());
  const server=createTrackingServer({store,adminToken:'customer-test-admin-secret-12345',publicOrigin:'https://fleet.example.test',bridge:{state:{configured:false,connected:false},sync:async()=>{}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()}));
  const login=address=>fetch(`http://127.0.0.1:${server.address().port}/api/gps/customers/session`,{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':address},body:JSON.stringify({email:'absent@example.test',password:'incorrect-password'})});
  for(let attempt=0;attempt<10;attempt++)assert.equal((await login('192.0.2.1')).status,401);
  assert.equal((await login('192.0.2.1')).status,429);
  assert.equal((await login('192.0.2.2')).status,401);
  assert.equal((await login('invalid-address')).status,401);
});

test('customer sessions scope fleet, commands, fences, alerts, links and relay access',async t=>{
  const store=new TrackingStore(':memory:');t.after(()=>store.close());
  const a=store.createCustomer({name:'Alpha Fleet',email:'alpha@example.test'});
  const b=store.createCustomer({name:'Beta Fleet',email:'beta@example.test'});
  const aDevice=store.createDevice({name:'A vehicle',model:'Mobile'},a.customer.id).device;
  const bDevice=store.createDevice({name:'B vehicle',model:'Mobile'},b.customer.id).device;
  const adminDevice=store.createDevice({name:'Admin vehicle',model:'Mobile'}).device;
  store.alert(aDevice.id,'offline','A only');store.alert(bDevice.id,'offline','B only');
  const server=createTrackingServer({store,adminToken:'customer-test-admin-secret-12345',bridge:{state:{configured:false,connected:false},sync:async()=>{} }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()}));
  const base=`http://127.0.0.1:${server.address().port}/api/gps`;
  const request=(path,options={})=>fetch(base+path,{...options,headers:{'Content-Type':'application/json',...options.headers}});
  const login=async user=>{
    const r=await request('/customers/session',{method:'POST',body:JSON.stringify({email:user.customer.email,password:user.password})});
    assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];
  };
  const aCookie=await login(a),bCookie=await login(b);
  const as=(cookie,path,method='GET',body)=>request(path,{method,headers:{cookie},...(body?{body:JSON.stringify(body)}:{})});
  // Only the admin registers devices; customers get a clear refusal.
  assert.equal((await as(aCookie,'/devices','POST',{name:'A phone',model:'Mobile'})).status,403);
  store.createDevice({name:'A phone',model:'Mobile'},a.customer.id);
  const aState=await (await as(aCookie,'/state')).json();
  // Customer state carries no tracker identifiers, receiver status or gateway details.
  assert.equal(aState.gateway,undefined);
  for(const d of aState.devices){for(const key of ['uniqueId','model','traccarId','bridgeStatus','cursor','command','tenantId','tokenHash'])assert.equal(key in d,false,key);}
  assert.equal(aState.devices.find(d=>d.name==='A phone').isMobile,true);
  assert.equal((await as(aCookie,`/devices/${aDevice.id}/ping`,'POST',{})).status,403);
  assert.equal((await as(aCookie,`/devices/${aDevice.id}/relay`)).status,403);
  assert.equal((await as(aCookie,`/devices/${aDevice.id}/token`,'POST',{})).status,403);
  assert.equal((await as(aCookie,'/admin/overview')).status,403);
  assert.equal((await as(aCookie,'/admin/devices')).status,403);
  assert.deepEqual(aState.devices.map(d=>d.name).sort(),['A phone','A vehicle']);assert.deepEqual(aState.alerts.map(x=>x.deviceName),['A vehicle']);
  const bState=await (await as(bCookie,'/state')).json();assert.deepEqual(bState.devices.map(d=>d.name),['B vehicle']);
  assert.equal((await as(aCookie,`/devices/${bDevice.id}/driver-link`)).status,404);
  assert.equal((await as(aCookie,`/devices/${adminDevice.id}/ping`,'POST',{})).status,404);
  assert.equal((await as(aCookie,`/devices/${bDevice.id}/relay`)).status,404);
  assert.equal((await as(aCookie,'/customers')).status,403);
  const fence=await (await as(aCookie,'/fences','POST',{name:'A yard',latitude:18.5,longitude:73.8,radius:500})).json();
  assert.equal((await (await as(bCookie,'/state')).json()).fences.length,0);
  assert.equal((await as(bCookie,`/fences/${fence.id}`,'DELETE')).status,404);
  const alertId=aState.alerts[0].id;
  assert.equal((await as(bCookie,`/alerts/${alertId}/ack`,'POST',{})).status,404);
  assert.equal((await as(aCookie,`/alerts/${alertId}/ack`,'POST',{})).status,200);
  const link=await (await as(aCookie,`/devices/${aDevice.id}/driver-link`,'POST',{})).json();
  const join=await request('/sender/join',{method:'POST',body:JSON.stringify({code:link.code})});
  assert.equal(join.status,200,'Driver link remains scoped to its device without customer login.');
  const adminLogin=await request('/session',{method:'POST',body:JSON.stringify({token:'customer-test-admin-secret-12345'})});
  const adminCookie=adminLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await as(adminCookie,'/customers')).json()).customers.length,2);
  assert.deepEqual((await (await as(adminCookie,'/state')).json()).devices.map(d=>d.name),['Admin vehicle']);
  const reset=await (await as(adminCookie,`/customers/${a.customer.id}/reset`,'POST',{})).json();
  assert.equal((await as(aCookie,'/state')).status,401);
  assert.equal((await request('/customers/session',{method:'POST',body:JSON.stringify({email:a.customer.email,password:a.password})})).status,401);
  assert.equal((await request('/customers/session',{method:'POST',body:JSON.stringify({email:a.customer.email,password:reset.password})})).status,200);
  assert.equal((await as(adminCookie,`/customers/${b.customer.id}/access`,'PUT',{enabled:false})).status,200);
  assert.equal((await as(bCookie,'/state')).status,401);
  assert.equal((await request('/customers/session',{method:'POST',body:JSON.stringify({email:b.customer.email,password:b.password})})).status,401);
});

test('customer can sign up but receives no admin access',async t=>{
  const store=new TrackingStore(':memory:');t.after(()=>store.close());
  const server=createTrackingServer({store,adminToken:'customer-test-admin-secret-12345',bridge:{state:{configured:false,connected:false},sync:async()=>{}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()}));
  const base=`http://127.0.0.1:${server.address().port}/api/gps`;
  const signup=await fetch(base+'/customers/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'New Fleet',email:'new@example.test',password:'strong-passphrase-123'})});
  assert.equal(signup.status,201);
  const account=await signup.json();assert.equal(account.role,'customer');assert.equal(account.email,'new@example.test');
  const cookie=signup.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base+'/customers',{headers:{cookie}})).status,403);
  assert.deepEqual((await (await fetch(base+'/state',{headers:{cookie}})).json()).devices,[]);
  assert.equal((await fetch(base+'/customers/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Duplicate',email:'new@example.test',password:'strong-passphrase-123'})})).status,409);
  assert.equal((await fetch(base+'/customers/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Weak',email:'weak@example.test',password:'short'})})).status,400);
});

test('users change their own password; a maintenance-key reset gives the admin a temporary one',async t=>{
  const store=new TrackingStore(':memory:');t.after(()=>store.close());
  const adminKey='customer-test-admin-secret-12345';
  const admin=store.createAdmin('boss@example.test');
  const customer=store.createCustomer({name:'Gamma Fleet',email:'gamma@example.test'});
  const server=createTrackingServer({store,adminToken:adminKey,bridge:{state:{configured:false,connected:false},sync:async()=>{}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()}));
  const base=`http://127.0.0.1:${server.address().port}/api/gps`;
  const post=(path,body,cookie)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body)});
  const cookieOf=r=>r.headers.get('set-cookie').split(';')[0];

  // Customer: wrong current password, too short, then success; old password stops working.
  const c1=cookieOf(await post('/customers/session',{email:customer.customer.email,password:customer.password}));
  const c2=cookieOf(await post('/customers/session',{email:customer.customer.email,password:customer.password}));
  {const wrong=await post('/account/password',{currentPassword:'wrong-password-12345',newPassword:'a-brand-new-password-1'},c1);assert.equal(wrong.status,400);assert.match((await wrong.json()).error,/Current password is incorrect/);}
  assert.equal((await post('/account/password',{currentPassword:customer.password,newPassword:'short'},c1)).status,400);
  const changed=await post('/account/password',{currentPassword:customer.password,newPassword:'a-brand-new-password-1'},c1);
  assert.equal(changed.status,200);const c1b=cookieOf(changed);
  assert.equal((await post('/customers/session',{email:customer.customer.email,password:customer.password})).status,401);
  assert.equal((await post('/customers/session',{email:customer.customer.email,password:'a-brand-new-password-1'})).status,200);
  assert.equal((await fetch(base+'/state',{headers:{cookie:c2}})).status,401,'other devices are signed out');
  assert.equal((await fetch(base+'/state',{headers:{cookie:c1b}})).status,200,'this browser stays signed in');

  // Admin: reset needs the maintenance key; the temporary password logs in and can then be changed.
  assert.equal((await post('/admin/reset-password',{token:'not-the-maintenance-key-at-all-1'})).status,401);
  const reset=await (await post('/admin/reset-password',{token:adminKey})).json();
  assert.equal(reset.email,'boss@example.test');assert.notEqual(reset.password,admin.password);
  assert.equal((await post('/admin/session',{email:'boss@example.test',password:admin.password})).status,401);
  const login=await post('/admin/session',{email:'boss@example.test',password:reset.password});assert.equal(login.status,200);
  const a1=cookieOf(login);
  assert.equal((await post('/account/password',{currentPassword:reset.password,newPassword:'admin-chosen-password-9'},a1)).status,200);
  assert.equal((await post('/admin/session',{email:'boss@example.test',password:'admin-chosen-password-9'})).status,200);
  // A session opened with the maintenance key has no email, so it cannot use the password form.
  const keyCookie=cookieOf(await post('/session',{token:adminKey}));
  assert.equal((await post('/account/password',{currentPassword:'x',newPassword:'another-long-password-1'},keyCookie)).status,400);
  // Create another admin with the maintenance key; the random password works and a duplicate is refused.
  assert.equal((await post('/admin/create',{token:'not-the-maintenance-key-at-all-1',email:'new@example.test'})).status,401);
  const created=await post('/admin/create',{token:adminKey,email:'New@Example.test'});assert.equal(created.status,201);
  const made=await created.json();assert.equal(made.email,'new@example.test');
  assert.equal((await post('/admin/session',{email:'new@example.test',password:made.password})).status,200);
  assert.equal((await post('/admin/create',{token:adminKey,email:'new@example.test'})).status,409);
  assert.equal((await post('/admin/create',{token:adminKey,email:'not-an-email'})).status,400);
  // Several admins: the email is required.
  store.createAdmin('second@example.test');
  assert.equal((await post('/admin/reset-password',{token:adminKey})).status,409);
  assert.equal((await post('/admin/reset-password',{token:adminKey,email:'second@example.test'})).status,200);
});

test('admin console manages every customer vehicle; customers only see their own',async t=>{
  let now=Date.parse('2026-10-15T06:00:00Z');
  const store=new TrackingStore(':memory:',{now:()=>now});t.after(()=>store.close());
  const adminKey='customer-test-admin-secret-12345';
  const a=store.createCustomer({name:'Alpha Fleet',email:'alpha@example.test'});
  const b=store.createCustomer({name:'Beta Fleet',email:'beta@example.test'});
  const server=createTrackingServer({store,adminToken:adminKey,bridge:{state:{configured:true,connected:true},sync:async()=>{}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()}));
  const base=`http://127.0.0.1:${server.address().port}/api/gps`;
  const call=(path,method='GET',body,cookie)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const cookieOf=r=>r.headers.get('set-cookie').split(';')[0];
  const admin=cookieOf(await call('/session','POST',{token:adminKey}));
  const alpha=cookieOf(await call('/customers/session','POST',{email:a.customer.email,password:a.password}));
  const beta=cookieOf(await call('/customers/session','POST',{email:b.customer.email,password:b.password}));

  const created=await call('/admin/devices','POST',{name:'MH 12 AB 1234',model:'GT06',uniqueId:'867111062240426',customerId:a.customer.id},admin);
  assert.equal(created.status,201);const truck=(await created.json()).device;
  assert.equal((await call('/admin/devices','POST',{name:'Ghost',model:'GT06',uniqueId:'867111062240427',customerId:'missing'},admin)).status,404);
  store.ingest(truck.id,{eventId:'p1',recordedAt:new Date(now).toISOString(),latitude:25.28,longitude:82.79,speed:20});
  store.alert(truck.id,'speed','Over limit');
  assert.deepEqual((await (await call('/state','GET',null,alpha)).json()).devices.map(d=>d.name),['MH 12 AB 1234']);
  assert.deepEqual((await (await call('/state','GET',null,beta)).json()).devices,[]);

  const list=await (await call('/admin/devices','GET',null,admin)).json();
  assert.equal(list.devices[0].customerName,'Alpha Fleet');assert.equal(list.devices[0].uniqueId,'867111062240426');
  const overview=await (await call('/admin/overview','GET',null,admin)).json();
  assert.equal(overview.devices.total,1);assert.equal(overview.customers.total,2);assert.equal(overview.devices.unassigned,0);
  assert.equal((await (await call('/customers','GET',null,admin)).json()).customers.find(c=>c.id===a.customer.id).devices,1);

  const detail=await (await call(`/admin/devices/${truck.id}?tz=-330`,'GET',null,admin)).json();
  assert.equal(detail.device.customerName,'Alpha Fleet');assert.equal(detail.device.uniqueId,'867111062240426');
  assert.equal(detail.packets.length,1);assert.equal(detail.alerts[0].message,'Over limit');
  assert.equal((await call(`/admin/devices/${truck.id}`,'GET',null,alpha)).status,403);
  // Reassign to Beta: it leaves Alpha's fleet and joins Beta's.
  const moved=await call(`/admin/devices/${truck.id}`,'PATCH',{customerId:b.customer.id,name:'MH 12 AB 9999',speedLimit:60},admin);
  assert.equal(moved.status,200);assert.equal((await moved.json()).name,'MH 12 AB 9999');
  assert.deepEqual((await (await call('/state','GET',null,alpha)).json()).devices,[]);
  assert.deepEqual((await (await call('/state','GET',null,beta)).json()).devices.map(d=>d.name),['MH 12 AB 9999']);
  assert.equal((await call(`/admin/devices/${truck.id}`,'PATCH',{customerId:null},admin)).status,200);
  assert.equal((await (await call('/admin/overview','GET',null,admin)).json()).devices.unassigned,1);

  // Delete removes the vehicle with its history and alerts.
  assert.equal((await call(`/admin/devices/${truck.id}`,'DELETE',null,admin)).status,200);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM positions').get().n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM alerts').get().n,0);
  assert.equal((await call(`/admin/devices/${truck.id}`,'DELETE',null,admin)).status,404);

  // Admin accounts.
  const made=await (await call('/admin/admins','POST',{email:'ops@example.test'},admin)).json();
  assert.equal(made.email,'ops@example.test');assert.ok(made.password.length>=16);
  assert.deepEqual((await (await call('/admin/admins','GET',null,admin)).json()).admins.map(x=>x.email),['ops@example.test']);
  assert.equal((await call('/admin/admins','POST',{email:'x@example.test'},alpha)).status,403);
});

test('admin maintenance commands are translated per model, logged, and refused when offline',async t=>{
  const {commandText}=await import('./tracking.mjs');
  assert.equal(commandText('GT06','interval',{moving:10,parked:60}),'TIMER,10,60#');
  assert.equal(commandText('PT06','server',{host:'92.4.84.227',port:5023}),'SERVER,0,92.4.84.227,5023,0#');
  assert.equal(commandText('GT06','apn',{apn:'airteliot.com'}),'APN,airteliot.com#');
  assert.equal(commandText('FMB920','reboot'),'cpureset');
  assert.equal(commandText('PT06','timezone',{hours:0,minutes:0}),'GMT,E,0,0#');
  assert.equal(commandText('PT06','timezone',{hours:5,minutes:30}),'GMT,E,5,30#');
  assert.throws(()=>commandText('PT06','timezone',{hours:99,minutes:0}),/not valid/);
  assert.throws(()=>commandText('GT06','interval',{moving:2,parked:60}),/5-18000/);
  assert.throws(()=>commandText('Mobile','reboot'),/Phone-based/);
  assert.throws(()=>commandText('GT06','apn',{apn:'a;b'}),/not valid/);
  const store=new TrackingStore(':memory:');t.after(()=>store.close());
  const adminKey='customer-test-admin-secret-12345';let online=true;const texts=[];
  const bridge={state:{},sync:async()=>{},sendText:async(d,text)=>{if(!online)throw Object.assign(new Error('Tracker is offline or has no recent connection. No command was queued.'));texts.push(text);return 'sent'},packets:async()=>[{at:'2026-10-15T10:54:31Z',direction:'in',tag:'Login',hex:'7878'}]};
  const server=createTrackingServer({store,adminToken:adminKey,bridge});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()}));
  const base=`http://127.0.0.1:${server.address().port}/api/gps`;
  const admin=(await fetch(base+'/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:adminKey})})).headers.get('set-cookie').split(';')[0];
  const call=(path,method='GET',body)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',cookie:admin},...(body?{body:JSON.stringify(body)}:{})});
  const d=store.createDevice({name:'G17',model:'GT06',uniqueId:'867111062240426'}).device;
  const ok=await call(`/admin/devices/${d.id}/command`,'POST',{action:'interval',moving:10,parked:60});
  assert.equal(ok.status,200);assert.deepEqual(texts,['TIMER,10,60#']);
  online=false;const off=await call(`/admin/devices/${d.id}/command`,'POST',{action:'reboot'});
  assert.equal(off.status,409);assert.match((await off.json()).error,/offline/);
  const log=store.deviceCommands(d.id).map(c=>c.status);assert.deepEqual(log.sort(),['failed','sent']);
  // A text reply from the tracker is attached to the command that was waiting.
  store.ingest(d.id,{eventId:'r1',recordedAt:new Date().toISOString(),latitude:25,longitude:82,extra:{result:'TIMER:10,60;OK'}},{heartbeat:false});
  assert.match(store.deviceCommands(d.id).find(c=>c.status==='answered').detail,/CMD TIMER,10,60# sent over GPRS\. → Reply: TIMER:10,60;OK/);
  // Tracker alarms become alerts in plain words.
  store.ingest(d.id,{eventId:'a1',recordedAt:new Date().toISOString(),latitude:25,longitude:82,extra:{alarm:'powerCut'}},{heartbeat:false});
  assert.equal(store.deviceAlerts(d.id)[0].message,'Main power cut');
  assert.equal((await (await call(`/admin/devices/${d.id}/packets`)).json()).packets[0].tag,'Login');
  const detail=await (await call(`/admin/devices/${d.id}`)).json();assert.equal(detail.commands.length,2);
  assert.ok(JSON.parse(detail.packets.find(p=>p.extra).extra).alarm);
});
