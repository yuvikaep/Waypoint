import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackingStore } from './tracking-store.mjs';
import { landmarks, tileBox } from './landmarks.mjs';

const ok = value => ({ ok: true, status: 200, json: async () => value });
// Tile 1019:3311 covers 25.475-25.5 N, 82.775-82.8 E (the NH31 stretch near Varanasi).
const KEY = '1019:3311';

test('OpenStreetMap mirrors are tried in turn and tiles are cached', async t => {
  const store = new TrackingStore(':memory:'); t.after(() => store.close());
  let calls = 0;
  const fetcher = async url => { calls++; if (url.includes('overpass-api.de')) return { ok: false, status: 502 };
    return ok({ elements: [{ type: 'node', id: 1, lat: 25.48, lon: 82.78, tags: { amenity: 'fuel', name: 'HP Petrol Pump' } }, { type: 'way', id: 2, center: { lat: 25.49, lon: 82.79 }, tags: { amenity: 'place_of_worship' } }] }); };
  const first = await landmarks(store, KEY, { fetcher });
  assert.equal(first.source, 'osm'); assert.equal(first.pois.length, 2); assert.equal(calls, 2);
  await landmarks(store, KEY, { fetcher }); assert.equal(calls, 2, 'second look comes from the cache');
  assert.throws(() => tileBox('../x'), /Invalid map tile/);
});
