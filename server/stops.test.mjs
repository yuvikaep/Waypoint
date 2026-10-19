import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackingStore } from './tracking-store.mjs';
import { regularStops, standingSince, stopsOf, suggestedStops } from './stops.mjs';

const MIN = 60000, DAY = 86400000, base = Date.parse('2026-10-01T04:00:00Z');
const pump = { latitude: 25.487, longitude: 82.798 }, dhaba = { latitude: 25.52, longitude: 82.79 };
// One day: drive, 20 minutes at the pump (parked tracker sends no fixes), drive on, 4 minutes at the dhaba.
const day = (d, offset = 0) => {
  const t = base + d * DAY;
  return [
    { id: 1, recordedAt: t, latitude: 25.45, longitude: 82.80, speed: 40 },
    { id: 2, recordedAt: t + 10 * MIN, latitude: pump.latitude + offset, longitude: pump.longitude, speed: 0 },
    { id: 3, recordedAt: t + 30 * MIN, latitude: pump.latitude + 0.0004, longitude: pump.longitude, speed: 30 },
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

test('standing time ignores GPS drift at rest but ends at real movement or a long silence', () => {
  const base = Date.parse('2026-10-19T04:00:00Z');
  // Newest first, as the store reads them: nine minutes parked in one spot.
  const parked = (minutesAgo, speed = 0, lat = 25.27, lon = 82.83) =>
    ({ recordedAt: base - minutesAgo * 60000, latitude: lat, longitude: lon, speed, valid: 1 });
  const run = [parked(0), parked(60), parked(100, 4), parked(140), parked(180)];
  // The 4 km/h reading at the same spot is drift, so the clock still starts at the oldest fix.
  assert.equal(standingSince(run), base - 180 * 60000);
  // Arriving: the fix before it was 2 km away, so standing starts after that one.
  assert.equal(standingSince([...run, parked(200, 30, 25.29, 82.85)]), base - 180 * 60000);
  // A reading well above drift speed ends the run even where the coordinates barely moved.
  assert.equal(standingSince([parked(0), parked(30), parked(60, 25)]), base - 30 * 60000);
  // After a silence longer than GAP we cannot claim it stood there, so the run starts after it.
  assert.equal(standingSince([parked(0), parked(60), parked(60 + 13 * 60)]), base - 60 * 60000);
  assert.equal(standingSince([]), null);
  assert.equal(standingSince([{ ...parked(0), valid: 0 }]), null);
});
