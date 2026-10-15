// Landmarks (petrol pumps, dhabas, temples, hospitals...) for one map tile of 0.025° (~2.8 km).
// With TOMTOM_API_KEY set they come from TomTom, whose Indian places are far more complete; otherwise
// from OpenStreetMap through Overpass. The key never reaches the browser, and each tile is fetched
// once and kept for 30 days, so a small fleet stays well inside TomTom's free monthly requests.
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
const inside = (b, lat, lon) => lat >= b.south && lat < b.north && lon >= b.west && lon < b.east;
const clean = p => ({ id: String(p.id).slice(0, 60), name: String(p.name || '').slice(0, 80), kind: p.kind, lat: Math.round(p.lat * 1e6) / 1e6, lon: Math.round(p.lon * 1e6) / 1e6 });

// TomTom category codes for the kinds shown on the map.
const TOMTOM = { PETROL_STATION: 'fuel', RESTAURANT: 'food', CAFE_PUB: 'food', PLACE_OF_WORSHIP: 'worship', HOSPITAL_POLYCLINIC: 'health', HEALTH_CARE_SERVICE: 'health', PHARMACY: 'health',
  POLICE_STATION: 'police', BANK: 'money', CASH_DISPENSER: 'money', TOLL_GATE: 'toll', HOTEL_MOTEL: 'stay', SCHOOL: 'school', COLLEGE_UNIVERSITY: 'school',
  OPEN_PARKING_AREA: 'parking', PARKING_GARAGE: 'parking', PUBLIC_TRANSPORT_STOP: 'bus', BUS_STOP: 'bus' };
const TOMTOM_CATEGORIES = '7311,7315,7339,7321,7322,7328,7397,7314,7372,7369';
async function fromTomTom(b, key, fetcher) {
  const lat = (b.south + b.north) / 2, lon = (b.west + b.east) / 2;
  const q = new URLSearchParams({ key, lat: String(lat), lon: String(lon), radius: '2000', limit: '100', categorySet: TOMTOM_CATEGORIES, language: 'en-GB' });
  const r = await fetcher(`https://api.tomtom.com/search/2/nearbySearch/.json?${q}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`TomTom places HTTP ${r.status}`);
  const pois = [];
  for (const x of (await r.json()).results || []) {
    const codes = (x.poi?.classifications || []).map(c => c.code);
    const kind = codes.map(c => TOMTOM[c]).find(Boolean);
    const { lat: plat, lon: plon } = x.position || {};
    if (kind && Number.isFinite(plat) && Number.isFinite(plon) && inside(b, plat, plon)) pois.push(clean({ id: `tt${x.id}`, name: x.poi?.name, kind, lat: plat, lon: plon }));
  }
  return pois;
}

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

export async function fetchLandmarks(key, { fetcher = fetch, env = process.env } = {}) {
  const b = tileBox(key);
  const pois = env.TOMTOM_API_KEY ? await fromTomTom(b, env.TOMTOM_API_KEY, fetcher) : await fromOsm(b, fetcher);
  return { source: env.TOMTOM_API_KEY ? 'tomtom' : 'osm', pois: pois.filter(p => KINDS.includes(p.kind)).slice(0, 300) };
}

// Cached lookup: fresh tiles from the store, otherwise one provider call that is then saved.
export async function landmarks(store, key, options) {
  tileBox(key);
  const cached = await store.landmarkTile(key);
  const source = (options?.env ?? process.env).TOMTOM_API_KEY ? 'tomtom' : 'osm';
  if (cached && cached.source === source && Date.now() - cached.fetchedAt < KEEP) return cached;
  const fresh = await fetchLandmarks(key, options);
  const row = { ...fresh, fetchedAt: Date.now() };
  await store.saveLandmarkTile(key, row);
  return row;
}
