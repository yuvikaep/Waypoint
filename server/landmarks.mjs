// Landmarks (petrol pumps, dhabas, temples, hospitals...) for one map tile of 0.025° (~2.8 km), from
// OpenStreetMap through the free Overpass service. Each tile is fetched once and kept for 30 days.
export const STEP = 0.025;
export const KEEP = 30 * 86400000;
const KINDS = ['fuel', 'food', 'worship', 'health', 'police', 'money', 'toll', 'stay', 'school', 'parking', 'bus'];

export function tileBox(key) {
  const m = /^(-?\d{1,4}):(-?\d{1,5})$/.exec(String(key || ''));
  if (!m) throw Object.assign(new Error('Invalid map tile.'), { status: 400 });
  const south = Number(m[1]) * STEP, west = Number(m[2]) * STEP;
  if (south < -90 || south >= 90 || west < -180 || west >= 180) throw Object.assign(new Error('Invalid map tile.'), { status: 400 });
  return { south, west, north: south + STEP, east: west + STEP };
}
const clean = p => ({ id: String(p.id).slice(0, 60), name: String(p.name || '').slice(0, 80), kind: p.kind, lat: Math.round(p.lat * 1e6) / 1e6, lon: Math.round(p.lon * 1e6) / 1e6 });

function osmKind(t) {
  const a = t.amenity;
  if (a === 'fuel') return 'fuel';
  if (['restaurant', 'fast_food', 'cafe', 'food_court'].includes(a)) return 'food';
  if (a === 'place_of_worship') return 'worship';
  if (['hospital', 'clinic', 'doctors', 'pharmacy'].includes(a)) return 'health';
  if (a === 'police') return 'police';
  if (a === 'bank' || a === 'atm') return 'money';
  if (['school', 'college', 'university'].includes(a)) return 'school';
  if (a === 'parking' || a === 'truck_parking') return 'parking';
  if (a === 'bus_station') return 'bus';
  if (t.barrier === 'toll_booth') return 'toll';
  if (['hotel', 'motel', 'guest_house'].includes(t.tourism)) return 'stay';
  return null;
}
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
async function fromOsm(b, fetcher) {
  const bbox = `${b.south.toFixed(4)},${b.west.toFixed(4)},${b.north.toFixed(4)},${b.east.toFixed(4)}`;
  const q = `[out:json][timeout:8];(nwr["amenity"~"^(fuel|restaurant|fast_food|cafe|food_court|place_of_worship|hospital|clinic|doctors|pharmacy|police|bank|atm|school|college|university|parking|truck_parking|bus_station)$"](${bbox});node["barrier"="toll_booth"](${bbox});nwr["tourism"~"^(hotel|motel|guest_house)$"](${bbox}););out center 400;`;
  let last;
  for (const url of OVERPASS) {
    try {
      const r = await fetcher(url, { method: 'POST', headers: { 'User-Agent': 'Waypoint-fleet-tracker/1.0', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ data: q }), signal: AbortSignal.timeout(9000) });
      if (!r.ok) { last = new Error(`OpenStreetMap places HTTP ${r.status}`); continue; }
      const pois = [];
      for (const e of (await r.json()).elements || []) {
        const t = e.tags || {}, kind = osmKind(t), lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
        if (kind && Number.isFinite(lat) && Number.isFinite(lon)) pois.push(clean({ id: `osm${e.type}${e.id}`, name: t['name:en'] || t.name || t.brand || '', kind, lat, lon }));
      }
      return pois;
    } catch (e) { last = e; }
  }
  throw last || new Error('OpenStreetMap places unavailable');
}

export async function fetchLandmarks(key, { fetcher = fetch } = {}) {
  const pois = await fromOsm(tileBox(key), fetcher);
  return { source: 'osm', pois: pois.filter(p => KINDS.includes(p.kind)).slice(0, 300) };
}

// Cached lookup: fresh tiles from the store, otherwise one provider call that is then saved.
export async function landmarks(store, key, options) {
  tileBox(key);
  const cached = await store.landmarkTile(key);
  if (cached && Date.now() - cached.fetchedAt < KEEP) return cached;
  const fresh = await fetchLandmarks(key, options);
  const row = { ...fresh, fetchedAt: Date.now() };
  await store.saveLandmarkTile(key, row);
  return row;
}
