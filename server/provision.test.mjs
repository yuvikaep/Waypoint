import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackingStore } from './tracking-store.mjs';
import { apnFor, bootstrapSms, buildPlan, classifyReply, cleanSetup, provisionTick } from './provision.mjs';
import { commandAllowed } from './command-channel.mjs';

test('SIM operator and type pick the APN; bootstrap texts and plan match the tracker family', () => {
  assert.equal(apnFor('airtel', 'personal'), 'airtelgprs.com');
  assert.equal(apnFor('airtel', 'iot'), '', 'IoT SIMs use a private APN from the seller; nothing is guessed');
  assert.equal(apnFor('jio', 'personal'), 'jionet');
  assert.equal(apnFor('vi', 'personal'), '');
  assert.equal(apnFor('other', 'personal'), '');
  const device = { model: 'PT06', apn: 'seller.apn.example', apnUser: 'u', apnPass: 'p' };
  assert.deepEqual(bootstrapSms(device, { trackerHost: '92.4.84.227', gt06Port: 5023 }).map(s => s.text),
    ['APN,seller.apn.example,u,p#', 'SERVER,0,92.4.84.227,5023,0#', 'STATUS#']);
  assert.deepEqual(bootstrapSms({ model: 'FMB920' }, {}), []);
  const plan = buildPlan({ model: 'PT06' }, { moving: 10, parked: 60 });
  assert.deepEqual(plan.map(s => s.command), ['VERSION#', 'GMT,E,0,0#', 'TIMER#', 'ACCREP,ON#', 'BATCH,OFF#', 'GPRSON,1#', 'STATUS#', 'PARAM#', 'RESET#']);
  assert.equal(buildPlan({ model: 'GT06' }, { moving: 10, parked: 60 })[2].command, 'TIMER,10,60#');
  for (const step of plan) assert.ok(commandAllowed(step.command), `${step.command} must be on the command channel allowlist`);
  assert.deepEqual(buildPlan({ model: 'Mobile' }), []);
  assert.throws(() => cleanSetup({ apn: 'bad apn;' }), /APN may contain/);
  assert.throws(() => cleanSetup({ simOperator: 'nowhere' }), /operator/);
  assert.equal(classifyReply('TIMER:10,60;OK'), 'ok');
  assert.equal(classifyReply('Error: invalid parameter'), 'failed');
});

test('automatic set-up sends one command at a time, waits for each reply, retries silence and restarts last', async t => {
  let now = Date.parse('2026-10-15T10:00:00Z');
  const store = new TrackingStore(':memory:', { now: () => now }); t.after(() => store.close());
  const device = store.createDevice({ name: 'NEW GT06', model: 'GT06', uniqueId: '356218606437999', offlineSeconds: 600 }).device;
  store.provisionReplace(device.id, buildPlan({ model: 'GT06' }, { moving: 10, parked: 60 }));
  const sent = []; let silent = 'PARAM#';
  const bridge = { async sendText(d, text) { sent.push(text); return 'queued'; } };
  const reply = text => { // the tracker answers the newest waiting command
    store.ingest(device.id, { eventId: `r${sent.length}${now}`, recordedAt: new Date(now).toISOString(), latitude: 25, longitude: 82, extra: { result: text } }, { heartbeat: false });
  };
  const tick = async (advance = 20000, connected = true) => { now += advance; if (connected) store.seen(device.id, now); return provisionTick(store, bridge, store.raw(device.id), now); };

  // Not connected yet: nothing is sent.
  assert.equal((await tick(20000, false)).reason, 'tracker not connected yet');
  assert.deepEqual(sent, []);
  // Connected: one command, then it waits for the reply before sending the next.
  assert.deepEqual(await tick(), { sent: 'VERSION#' });
  assert.equal((await tick()).waiting, true); assert.deepEqual(sent, ['VERSION#']);
  reply('GT06B_10_8MM V11');
  assert.equal((await tick()).advanced, true);
  for (const next of ['GMT,E,0,0#', 'TIMER,10,60#', 'ACCREP,ON#', 'BATCH,OFF#', 'GPRSON,1#', 'STATUS#']) {
    assert.deepEqual(await tick(), { sent: next });
    reply(next === 'TIMER,10,60#' ? 'TIMER:10,60;OK' : 'OK');
    assert.equal((await tick()).advanced, true);
  }
  // PARAM# gets no reply: it is retried twice more, then marked failed, and the plan still finishes.
  assert.deepEqual(await tick(), { sent: silent });                       // try 1
  assert.deepEqual(await tick(5 * 60000), { sent: silent });              // no reply in 4 min -> try 2
  assert.deepEqual(await tick(5 * 60000), { sent: silent });              // -> try 3
  assert.equal((await tick(5 * 60000)).advanced, true);                   // -> given up
  const steps = store.provisionSteps(device.id);
  assert.equal(steps.find(s => s.command === 'PARAM#').status, 'failed');
  assert.equal(sent.filter(c => c === 'PARAM#').length, 3);
  // The restart is last, and a reconnect afterwards proves it.
  assert.deepEqual(await tick(), { sent: 'RESET#' });
  assert.equal((await tick(30000)).advanced, true);
  const done = store.provisionSteps(device.id);
  assert.deepEqual(done.map(s => s.status), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'failed', 'ok']);
  assert.equal(sent.at(-1), 'RESET#');
  assert.equal((await tick()).done, true);
  assert.equal(store.pendingProvisioning().length, 0);
  // A reply is stored with its command.
  assert.match(store.deviceCommands(device.id).find(c => /TIMER/.test(c.detail)).detail, /Reply: TIMER:10,60;OK/);
});
