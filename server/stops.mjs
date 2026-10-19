// Places where a customer's vehicles stop again and again (petrol pump, dhaba, loading point...),
// worked out from stored fixes so the customer can name them. Works with both stores.
const STOP_MIN = 10 * 60000;    // a stop counts from 10 minutes standing still
import { runningAt } from './extra.mjs';
const RADIUS_M = 150;           // stops this close are the same place
const GAP = 12 * 3600000;       // after a longer silence we cannot say the vehicle stayed put

function metres(a, b) {
  const r = Math.PI / 180, h = Math.sin((b.latitude - a.latitude) * r / 2) ** 2
    + Math.cos(a.latitude * r) * Math.cos(b.latitude * r) * Math.sin((b.longitude - a.longitude) * r / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
}

// Standing-still periods of one vehicle: consecutive slow fixes within RADIUS_M of where it stopped.
export function stopsOf(points) {
  const fixes = points.filter(p => p.valid !== 0).sort((a, b) => a.recordedAt - b.recordedAt);
  const stops = [];
  let start = null, last = null;
  const close = end => { if (start && end - start.recordedAt >= STOP_MIN) stops.push({ latitude: start.latitude, longitude: start.longitude, from: start.recordedAt, to: end }); start = null; };
  for (let i = 0; i < fixes.length; i++) {
    const p = fixes[i];
    // The same running rule as the card: a GPS wandering on the spot is still standing still.
    const still = !runningAt(fixes, i, metres);
    // Parked GT06 trackers send no fixes until they move again, so the stop lasts until the next fix.
    if (start && (!still || metres(start, p) > RADIUS_M || p.recordedAt - last.recordedAt > GAP)) close(p.recordedAt - last.recordedAt > GAP ? last.recordedAt : p.recordedAt);
    if (still && !start) start = p;
    last = p;
  }
  if (start) close(last.recordedAt);
  return stops;
}

// Groups stops of all vehicles into places, leaving out places the customer already saved.
export function regularStops(byVehicle, saved = [], { minVisits = 3, limit = 20 } = {}) {
  const clusters = [];
  for (const { id, name, stops } of byVehicle) for (const s of stops) {
    if (saved.some(f => metres(s, f) <= Math.max(f.radius, RADIUS_M))) continue;
    let c = clusters.find(c => metres(c, s) <= RADIUS_M);
    if (!c) { c = { latitude: s.latitude, longitude: s.longitude, visits: 0, totalMinutes: 0, lastVisit: 0, vehicles: [], _ids: new Set(), _n: 0 }; clusters.push(c); }
    // The centre follows the average of its stops.
    c._n++; c.latitude += (s.latitude - c.latitude) / c._n; c.longitude += (s.longitude - c.longitude) / c._n;
    c.visits++; c.totalMinutes += Math.round((s.to - s.from) / 60000); c.lastVisit = Math.max(c.lastVisit, s.to);
    if (!c._ids.has(id)) { c._ids.add(id); c.vehicles.push(name); }
  }
  return clusters.filter(c => c.visits >= minVisits)
    .sort((a, b) => b.visits - a.visits || b.totalMinutes - a.totalMinutes).slice(0, limit)
    .map(({ _ids, _n, latitude, longitude, ...c }) => ({ latitude: Math.round(latitude * 1e6) / 1e6, longitude: Math.round(longitude * 1e6) / 1e6, ...c }));
}

export async function suggestedStops(store, devices, fences, from, to) {
  const byVehicle = [];
  for (const device of devices) {
    const points = [];
    let after = 0;
    do {
      const page = await store.history(device.id, from, to, after);
      points.push(...page.positions);
      after = page.next;
    } while (after !== null && points.length < 200000);
    byVehicle.push({ id: device.id, name: device.name, stops: stopsOf(points) });
  }
  return regularStops(byVehicle, fences);
}
