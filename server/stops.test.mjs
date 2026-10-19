import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackingStore } from './tracking-store.mjs';
import { regularStops, stopsOf, suggestedStops } from './stops.mjs';
import { runningAt } from './extra.mjs';
import { segmentsOf, standingSince } from './segments.mjs';

const MIN = 60000, DAY = 86400000, base = Date.parse('2026-10-01T04:00:00Z');
const pump = { latitude: 25.487, longitude: 82.798 }, dhaba = { latitude: 25.52, longitude: 82.79 };
// One day: drive, 20 minutes at the pump (parked tracker sends no fixes), drive on, 4 minutes at the dhaba.
const day = (d, offset = 0) => {
  const t = base + d * DAY;
  return [
    { id: 1, recordedAt: t, latitude: 25.45, longitude: 82.80, speed: 40 },
    { id: 2, recordedAt: t + 10 * MIN, latitude: pump.latitude + offset, longitude: pump.longitude, speed: 0 },
    { id: 3, recordedAt: t + 30 * MIN, latitude: pump.latitude + 0.0004 + offset, longitude: pump.longitude, speed: 30 },
    { id: 4, recordedAt: t + 40 * MIN, ...dhaba, speed: 0 },
    { id: 5, recordedAt: t + 44 * MIN, latitude: 25.53, longitude: 82.79, speed: 35 },
  ];
};

test('a stop lasts until the vehicle moves again and short halts are ignored', () => {
  const stops = stopsOf(day(0));
  assert.equal(stops.length, 1);
  assert.equal(stops[0].to - stops[0].from, 20 * MIN);
});

test('places visited at least three times are suggested once with every vehicle that stopped there, saved places skipped', () => {
  const byVehicle = [{ id: 'a', name: 'Truck A', stops: [0, 1, 2].flatMap(d => stopsOf(day(d, d * 0.0002))) }, { id: 'b', name: 'Truck B', stops: stopsOf(day(3)) }];
  const [c, ...rest] = regularStops(byVehicle);
  assert.equal(rest.length, 0);
  assert.equal(c.visits, 4); assert.equal(c.totalMinutes, 80); assert.deepEqual(c.vehicles, ['Truck A', 'Truck B']);
  assert.ok(Math.abs(c.latitude - pump.latitude) < 0.001);
  assert.equal(regularStops(byVehicle, [{ ...pump, radius: 100 }]).length, 0, 'already saved as a place');
});

test('suggested stops read only the given vehicles from the store', async t => {
  const store = new TrackingStore(':memory:'); t.after(() => store.close());
  const a = store.createCustomer({ name: 'A', email: 'a@example.test' }), b = store.createCustomer({ name: 'B', email: 'b@example.test' });
  const mine = store.createDevice({ name: 'Mine', model: 'Mobile' }, a.customer.id).device;
  const theirs = store.createDevice({ name: 'Theirs', model: 'Mobile' }, b.customer.id).device;
  for (const device of [mine, theirs]) for (const d of [0, 1, 2]) for (const p of day(d))
    store.ingest(device.id, { eventId: `${device.id}-${d}-${p.id}`, recordedAt: new Date(p.recordedAt).toISOString(), latitude: p.latitude, longitude: p.longitude, speed: p.speed });
  const stops = await suggestedStops(store, store.devices(a.customer.id), store.fences(a.customer.id), base - DAY, base + 5 * DAY);
  assert.equal(stops.length, 1); assert.deepEqual(stops[0].vehicles, ['Mine']);
});

test('one running rule: the card, the timeline and the reports give the same answer', () => {
  const metres = (a, b) => {
    const r = Math.PI / 180, h = Math.sin((b.latitude - a.latitude) * r / 2) ** 2
      + Math.cos(a.latitude * r) * Math.cos(b.latitude * r) * Math.sin((b.longitude - a.longitude) * r / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(h));
  };
  const t = Date.parse('2026-10-19T04:00:00Z');
  const fix = (n, lat, lon, speed) => ({ id: n, recordedAt: t + n * 60000, latitude: lat, longitude: lon, speed, valid: 1 });
  // A tracker standing at one spot whose GPS wanders about 40 m, reporting up to 6 km/h.
  const jitter = [0, 0.00035, -0.0003, 0.0002, -0.00025, 0.0003, 0, -0.00035]
    .map((d, n) => fix(n, 25.27 + d, 82.83 + (n % 3) * 0.0002, [0, 5, 6, 4, 5, 6, 0, 4][n]));
  // From the third fix on there is enough history to know how far this GPS wanders; before that a
  // jump and a start look the same and distance alone has to decide.
  for (let i = 3; i < jitter.length; i++) assert.equal(runningAt(jitter, i, metres), false, `jitter fix ${i} is not running`);
  // The same vehicle pulling out. 25 m of real ground is enough on a steady GPS; on this one the
  // vehicle has to get clear of the jumping first, which is what the straight-line test waits for.
  const leaving = [...jitter, fix(8, 25.2703, 82.83, 4), fix(9, 25.2706, 82.83, 8), fix(10, 25.2712, 82.83, 10)];
  assert.equal(runningAt(leaving, 10, metres), true, 'driving away from a jumpy GPS is running');
  // A steady GPS: the same vehicle is running as soon as it has gone 25 m.
  const steady = [0, 0, 0, 0, 0, 0].map((d, n) => fix(n, 25.27, 82.83, 0))
    .concat([fix(6, 25.2701, 82.83, 3), fix(7, 25.27025, 82.83, 4)]);
  assert.equal(runningAt(steady, 7, metres), true, '28 m from a standstill on a steady GPS is running');
  // Standing time: the vehicle arrives from 2 km away and then its GPS jumps about. The last fixes
  // of the drive still read as running, so standing starts within a few minutes of arriving — and
  // from then on it only grows: the jumping never pushes the start forward again.
  const arrived = [{ ...fix(-1, 25.25, 82.81, 40), recordedAt: t - 60000 }, ...jitter];
  const since = standingSince([...arrived].reverse());
  assert.ok(since >= jitter[0].recordedAt && since <= jitter[5].recordedAt, 'standing starts just after arriving');
  const later = [...arrived, ...[0.0003, -0.00025, 0.0002, -0.0003, 0.00035, 0]
    .map((d, n) => fix(8 + n, 25.27 + d, 82.83 + (n % 3) * 0.0002, [5, 6, 4, 5, 6, 0][n]))];
  assert.equal(standingSince([...later].reverse()), since, 'more jumping does not restart the clock');
  assert.equal(standingSince([]), null);
});

test('a jumpy tracker standing still: the card and the timeline agree on one long stop', () => {
  const t = Date.parse('2026-10-19T09:00:00Z');
  const rows = [];
  let id = 1, at = t;
  const add = (lat, lon, speed, minutes = 1) => {
    rows.push({ id: id++, recordedAt: at, latitude: lat, longitude: lon, speed, valid: 1 });
    at += minutes * 60000;
  };
  // Drives in from 3 km away, then stands for three and a half hours.
  add(25.30, 82.86, 42); add(25.29, 82.85, 38); add(25.2805, 82.838, 24);
  const arrived = at;
  for (let n = 0; n < 210; n++) {
    // Most minutes it repeats its last fix; now and then the GPS throws it a few hundred metres and
    // brings it straight back, and the tracker reports 4-6 km/h while it does.
    if (n % 37 === 11) add(25.2735, 82.8301, 5);
    else if (n % 23 === 7) add(25.2772, 82.8355, 6);
    else add(25.27, 82.83, 0);
  }
  const stops = segmentsOf(rows).filter(s => s.kind === 'stop');
  assert.equal(stops.length, 1, 'the jumps are not trips, so there is one stop');
  assert.equal(stops[0].from, arrived, 'standing starts when it arrived');
  // The card reads the same stop: 3 h 29 min, not a fresh clock after the last jump.
  assert.equal(standingSince([...rows].reverse()), arrived);
  assert.equal(Math.round((at - 60000 - arrived) / 60000), 209);
});

test('the card and the timeline read the same runs and stops out of one store', t => {
  let now = Date.parse('2026-10-19T04:00:00Z'), n = 0;
  const store = new TrackingStore(':memory:', { now: () => now }); t.after(() => store.close());
  const send = (lat, lon, speed, minutes = 1) => {
    store.ingest(device.id, { eventId: `p${n++}`, recordedAt: new Date(now).toISOString(), latitude: lat, longitude: lon, speed, ignition: false });
    store.seen(device.id, now);
    now += minutes * 60000;
  };
  const device = store.createDevice({ name: 'PT06 TEST', model: 'PT06', uniqueId: '356218606437323', offlineSeconds: 600 }).device;
  send(25.30, 82.86, 42); send(25.29, 82.85, 38); send(25.2805, 82.838, 24);
  const arrived = now;
  for (let i = 0; i < 180; i++) {
    if (i % 41 === 13) send(25.2735, 82.8301, 5);       // the GPS throws it 400 m and brings it back
    else if (i % 29 === 9) send(25.2772, 82.8355, 6);
    else send(25.27, 82.83, 0);
  }
  const card = store.device(device.id);
  assert.equal(card.status, 'Stopped');
  assert.equal(card.stoppedSince, arrived, 'the card dates the stop from when the vehicle arrived');
  // The timeline reads the same rows the history page would load and must land on the same minute.
  const track = store.history(device.id, Date.parse('2026-10-19T00:00:00Z'), now).positions;
  const stops = segmentsOf(track).filter(s => s.kind === 'stop');
  assert.equal(stops.length, 1);
  assert.equal(stops.at(-1).from, card.stoppedSince, 'card and timeline agree');
  assert.equal(Math.round((now - 60000 - arrived) / 60000), 179);
});
