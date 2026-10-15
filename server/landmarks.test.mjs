import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackingStore } from './tracking-store.mjs';
import { fetchLandmarks, landmarks, tileBox } from './landmarks.mjs';

const ok = value => ({ ok: true, status: 200, json: async () => value });
// Tile 1019:3311 covers 25.475-25.5 N, 82.775-82.8 E (the NH31 stretch near Varanasi).
const KEY = '1019:3311';

test('TomTom places are mapped to landmark kinds and kept inside the tile; the key stays on the server', async () => {
  let asked;
  const fetcher = async url => { asked = new URL(url); return ok({ results: [
    { id: 'a', poi: { name: 'Indian Oil', classifications: [{ code: 'PETROL_STATION' }] }, position: { lat: 25.487, lon: 82.79 } },
    { id: 'b', poi: { name: 'Tridev Dhaba', classifications: [{ code: 'RESTAURANT' }] }, position: { lat: 25.486, lon: 82.791 } },
    { id: 'c', poi: { name: 'Far away', classifications: [{ code: 'PETROL_STATION' }] }, position: { lat: 25.6, lon: 82.79 } },
    { id: 'd', poi: { name: 'Unknown kind', classifications: [{ code: 'SHOP' }] }, position: { lat: 25.487, lon: 82.79 } },
  ] }); };
  const r = await fetchLandmarks(KEY, { fetcher, env: { TOMTOM_API_KEY: 'k' } });
  assert.equal(asked.hostname, 'api.tomtom.com'); assert.equal(asked.searchParams.get('key'), 'k');
  assert.equal(r.source, 'tomtom');
  assert.deepEqual(r.pois.map(p => [p.name, p.kind]), [['Indian Oil', 'fuel'], ['Tridev Dhaba', 'food']]);
});

test('without a TomTom key OpenStreetMap is used, mirrors are tried in turn and tiles are cached', async t => {
  const store = new TrackingStore(':memory:'); t.after(() => store.close());
  let calls = 0;
  const fetcher = async url => { calls++; if (url.includes('overpass-api.de')) return { ok: false, status: 502 };
    return ok({ elements: [{ type: 'node', id: 1, lat: 25.48, lon: 82.78, tags: { amenity: 'fuel', name: 'HP Petrol Pump' } }, { type: 'way', id: 2, center: { lat: 25.49, lon: 82.79 }, tags: { amenity: 'place_of_worship' } }] }); };
  const first = await landmarks(store, KEY, { fetcher, env: {} });
  assert.equal(first.source, 'osm'); assert.equal(first.pois.length, 2); assert.equal(calls, 2);
  await landmarks(store, KEY, { fetcher, env: {} }); assert.equal(calls, 2, 'second look comes from the cache');
  await landmarks(store, KEY, { fetcher: async () => ok({ results: [] }), env: { TOMTOM_API_KEY: 'k' } });
  assert.equal(store.landmarkTile(KEY).source, 'tomtom', 'adding a TomTom key refreshes cached OpenStreetMap tiles');
  assert.throws(() => tileBox('../x'), /Invalid map tile/);
});
