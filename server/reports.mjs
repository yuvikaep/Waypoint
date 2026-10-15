// Daily vehicle summaries built from stored fixes. Works with both stores (sync SQLite or async Postgres).
const GAP = 15 * 60000;          // longer silences are not counted as driving or idling
const MAX_KMH = 150;             // faster implied jumps are GPS noise, not distance
const MOVING_KMH = 3;
const DRIFT_KM = 0.1;

function km(a, b) {
  const rad = Math.PI / 180, h = Math.sin((b.latitude - a.latitude) * rad / 2) ** 2
    + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin((b.longitude - a.longitude) * rad / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// Local calendar day for a timestamp, given the viewer's Date#getTimezoneOffset (minutes).
const dayOf = (at, tzOffset) => new Date(at - tzOffset * 60000).toISOString().slice(0, 10);

export function summarize(points, tzOffset = -330) {
  const days = new Map();
  const day = at => {
    const key = dayOf(at, tzOffset);
    if (!days.has(key)) days.set(key, { date: key, distanceKm: 0, runningMinutes: 0, idleMinutes: 0, ignitionMinutes: 0, maxSpeed: 0, firstMove: null, lastMove: null, points: 0, gaps: [] });
    return days.get(key);
  };
  // GT06 heartbeats are stored as copies of the last fix (same time and place); count each fix once.
  const fixes = points.filter(p => p.valid !== 0).sort((a, b) => a.recordedAt - b.recordedAt || a.id - b.id)
    .filter((p, i, all) => !i || p.recordedAt !== all[i - 1].recordedAt || p.latitude !== all[i - 1].latitude || p.longitude !== all[i - 1].longitude);
  for (let i = 0; i < fixes.length; i++) {
    const b = fixes[i], d = day(b.recordedAt);
    d.points++;
    if (b.speed > d.maxSpeed) d.maxSpeed = b.speed;
    if (!i) continue;
    const a = fixes[i - 1], dt = b.recordedAt - a.recordedAt;
    if (dt <= 0 || dt > GAP) continue;
    const dist = km(a, b), from = day(a.recordedAt);
    const moving = a.speed >= MOVING_KMH || b.speed >= MOVING_KMH;
    // A parked tracker's position wanders a few metres; that is drift, not distance.
    if (dist / (dt / 3600000) <= MAX_KMH && (moving || dist >= DRIFT_KM)) from.distanceKm += dist;
    if (moving) {
      from.runningMinutes += dt / 60000;
      from.firstMove ??= a.recordedAt;
      from.lastMove = b.recordedAt;
    }
  }
  // Ignition is reported by heartbeats as well as fixes, so follow reception order for it.
  const ignitions = points.filter(p => p.ignition != null).sort((a, b) => a.receivedAt - b.receivedAt || a.id - b.id);
  for (let i = 1; i < ignitions.length; i++) {
    const a = ignitions[i - 1], dt = ignitions[i].receivedAt - a.receivedAt;
    if (a.ignition === 1 && dt > 0 && dt <= GAP) day(a.receivedAt).ignitionMinutes += dt / 60000;
  }
  // Times the tracker sent nothing at all (no fix, no heartbeat). Distance in these windows is
  // unknown, so it is reported as a gap rather than estimated.
  const received = points.filter(p => Number.isFinite(p.receivedAt)).sort((a, b) => a.receivedAt - b.receivedAt || a.id - b.id);
  for (let i = 1; i < received.length; i++) {
    const a = received[i - 1], b = received[i], dt = b.receivedAt - a.receivedAt;
    if (dt <= GAP) continue;
    const before = fixes.filter(f => f.recordedAt <= a.receivedAt).at(-1), after = fixes.find(f => f.recordedAt >= b.receivedAt);
    day(a.receivedAt).gaps.push({ from: a.receivedAt, to: b.receivedAt, minutes: Math.round(dt / 60000),
      movedKm: before && after ? Math.round(km(before, after) * 10) / 10 : null });
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map(d => ({
    ...d,
    distanceKm: Math.round(d.distanceKm * 10) / 10,
    runningMinutes: Math.round(d.runningMinutes),
    ignitionMinutes: Math.round(d.ignitionMinutes),
    // Engine on but not moving.
    idleMinutes: Math.max(0, Math.round(d.ignitionMinutes - d.runningMinutes)),
    maxSpeed: Math.round(d.maxSpeed),
    avgSpeed: d.runningMinutes ? Math.round(d.distanceKm / (d.runningMinutes / 60)) : 0,
  }));
}

export async function vehicleReport(store, devices, from, to, tzOffset) {
  const vehicles = [];
  for (const device of devices) {
    const points = [];
    let after = 0;
    do {
      const page = await store.history(device.id, from, to, after);
      points.push(...page.positions);
      after = page.next;
    } while (after !== null && points.length < 200000);
    const days = summarize(points, tzOffset);
    const total = days.reduce((t, d) => ({
      distanceKm: t.distanceKm + d.distanceKm, runningMinutes: t.runningMinutes + d.runningMinutes,
      idleMinutes: t.idleMinutes + d.idleMinutes, maxSpeed: Math.max(t.maxSpeed, d.maxSpeed), gapMinutes: t.gapMinutes + d.gaps.reduce((m, g) => m + g.minutes, 0),
    }), { distanceKm: 0, runningMinutes: 0, idleMinutes: 0, maxSpeed: 0, gapMinutes: 0 });
    total.distanceKm = Math.round(total.distanceKm * 10) / 10;
    total.avgSpeed = total.runningMinutes ? Math.round(total.distanceKm / (total.runningMinutes / 60)) : 0;
    vehicles.push({ id: device.id, name: device.name, total, days });
  }
  return { from, to, vehicles };
}
