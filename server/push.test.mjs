import test from 'node:test';
import assert from 'node:assert/strict';
import {TrackingStore} from './tracking-store.mjs';
import {cleanSubscription,deliverPushes,pushText,vapidKeys} from './push.mjs';

const sub=(endpoint='https://fcm.googleapis.com/fcm/send/abc123',extra={})=>({subscription:{endpoint,keys:{p256dh:'B'.repeat(87),auth:'A'.repeat(22)}},lang:'hg',...extra});

test('push subscriptions only accept browser push services',()=>{
  assert.equal(cleanSubscription(sub()).lang,'hg');
  assert.equal(cleanSubscription(sub('https://web.push.apple.com/QOabc')).endpoint,'https://web.push.apple.com/QOabc');
  for(const bad of ['http://fcm.googleapis.com/x','https://evil.example/x','https://fcm.googleapis.com.evil.example/x','https://169.254.169.254/'])
    assert.throws(()=>cleanSubscription(sub(bad)),/push service|Invalid/,bad);
  assert.throws(()=>cleanSubscription({subscription:{endpoint:'https://fcm.googleapis.com/x',keys:{p256dh:'x',auth:'y'}}}),/keys/);
});

test('alerts reach the phones of their own fleet once, by category, and dead phones are dropped',async t=>{
  let now=Date.parse('2026-10-16T15:00:00Z');
  const store=new TrackingStore(':memory:',{now:()=>now});t.after(()=>store.close());
  const a=store.createDevice({name:'PT06 TEST',model:'Mobile'},'tenant-a').device,b=store.createDevice({name:'B truck',model:'Mobile'},'tenant-b').device;
  store.alert(a.id,'speed','old alert',now-3600000);
  store.savePushSub('tenant-a',cleanSubscription(sub('https://fcm.googleapis.com/fcm/send/phone-1')));
  store.savePushSub('tenant-a',cleanSubscription(sub('https://fcm.googleapis.com/fcm/send/phone-2',{categories:['sos'],lang:'hi'})));
  store.savePushSub('tenant-b',cleanSubscription(sub('https://fcm.googleapis.com/fcm/send/phone-b')));
  const sent=[];let gone='';
  const send=async(s,payload,opts)=>{if(s.endpoint===gone)throw Object.assign(new Error('gone'),{statusCode:410});sent.push({to:s.endpoint.split('/').pop(),...JSON.parse(payload),urgency:opts.urgency,subject:opts.vapidDetails.subject})};
  store.alert(a.id,'parking_lock','Parking lock: vehicle moved 302 m from where it was parked.');
  store.alert(a.id,'ignition_on','Engine started.');
  assert.equal(await deliverPushes(store,{origin:'https://fleet.example',send}),3);
  assert.deepEqual(sent.map(x=>x.to).sort(),['phone-1','phone-1','phone-2'],'phone-2 only wants SOS-level alerts; tenant B gets nothing; the hour-old alert is skipped');
  const lock=sent.find(x=>x.to==='phone-2');
  assert.match(lock.title,/पार्किंग लॉक अलर्ट · PT06 TEST/);assert.equal(lock.urgent,true);assert.equal(lock.urgency,'high');assert.equal(lock.subject,'https://fleet.example');
  assert.equal(await deliverPushes(store,{send}),0,'each alert is pushed once');
  gone='https://fcm.googleapis.com/fcm/send/phone-1';store.alert(a.id,'sos','SOS button pressed');
  await deliverPushes(store,{send});
  assert.deepEqual(store.pushSubs('tenant-a').map(s=>s.endpoint.split('/').pop()),['phone-2']);
  const k1=await vapidKeys(store),k2=await vapidKeys(store);assert.equal(k1.publicKey,k2.publicKey,'keys are generated once and kept');
  assert.match(pushText({type:'parking_lock',message:'Parking lock: engine started.',deviceName:'X'},'hg').body,/engine chalu hua/);
});
