import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from './reports.mjs';

const at = (hh, mm, ss = 0) => Date.parse(`2026-10-14T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}Z`);
let id = 0;
const fix = (t, lat, lon, speed, extra = {}) => ({ id: ++id, recordedAt: t, receivedAt: t, latitude: lat, longitude: lon, speed, valid: 1, ignition: null, ...extra });

test('daily report: distance, running, idle, speeds; gaps and GPS jumps are not counted', () => {
  // 0.01 deg latitude is about 1.11 km. Drive 10 legs of 1 minute = ~11.1 km in 10 minutes.
  const points = [];
  for (let n = 0; n <= 10; n++) points.push(fix(at(6, n), 25 + n * 0.01, 82.8, n === 10 ? 0 : 66));
  // Idle with engine on for 10 minutes (heartbeats report ignition), then a 2 hour silence.
  // Heartbeats every 3 minutes carry ACC on from 06:00 to 06:18; off at 06:21 -> 21 minutes on.
  // Like real GT06 status packets, each heartbeat repeats the last fix's time and place.
  for (const m of [0, 3, 6, 9, 12, 15, 18]) { const f = Math.min(m, 10); points.push(fix(at(6, f), 25 + f * 0.01, 82.8, 0, { ignition: 1, receivedAt: at(6, m) })); }
  points.push(fix(at(6, 10), 25.1, 82.8, 0, { ignition: 0, receivedAt: at(6, 21) }));
  points.push(fix(at(8, 30), 25.1, 82.8, 0));
  // A jump of ~111 km in one minute is noise, not distance; an invalid fix is ignored.
  points.push(fix(at(8, 31), 26.1, 82.8, 0));
  points.push(fix(at(8, 32), 30, 82.8, 0, { valid: 0 }));
  const [day] = summarize(points, 0);
  assert.equal(day.date, '2026-10-14');
  assert.ok(Math.abs(day.distanceKm - 11.1) < 0.2, `distance ${day.distanceKm}`);
  assert.equal(day.runningMinutes, 10);
  assert.equal(day.ignitionMinutes, 21);
  assert.equal(day.idleMinutes, 11);
  assert.equal(day.maxSpeed, 66);
  assert.ok(day.avgSpeed >= 65 && day.avgSpeed <= 68, `avg ${day.avgSpeed}`);
  assert.equal(day.firstMove, at(6, 0));
  assert.equal(day.lastMove, at(6, 10));
});

test('report days follow the viewer time zone', () => {
  // 20:00 UTC on the 14th is 01:30 on the 15th in India (offset -330).
  const days = summarize([fix(at(20, 0), 25, 82.8, 10), fix(at(20, 1), 25.001, 82.8, 10)], -330);
  assert.deepEqual(days.map(d => d.date), ['2026-10-15']);
});

test('GPS drift of a parked vehicle is not counted as distance', () => {
  const t = at(10, 0), pts = [];
  for (let n = 0; n < 30; n++) pts.push(fix(t + n * 60000, 25 + (n % 2) * 0.0003, 82.8 + (n % 3) * 0.0002, 0));
  const [day] = summarize(pts, 0);
  assert.equal(day.distanceKm, 0);
  assert.equal(day.runningMinutes, 0);
});
