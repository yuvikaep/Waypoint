import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackingStore } from './tracking-store.mjs';
import { dieselPrices, parseDiesel } from './fuel.mjs';

const row = (state, price, kind, change) => `<tr><td><a href="/diesel-price-in-${state.toLowerCase().replace(/\W+/g, '-')}-s1.html" title="${state}">${state}</a></td>
  <td>
    &#x20b9;${price}
  </td>
  <td><span class="fp-${kind}">
    ${change}
  </span></td></tr>`;
const page = `<h2>Diesel Price in India Today (16th Oct, 2026)</h2><table>${[['Maharashtra', '97.83', 'down', '0.20'], ['Delhi', '87.67', 'flat', '0.00'], ['Bihar', '99.36', 'up', '0.31'], ...Array.from({ length: 10 }, (_, n) => [`State ${n}`, '90.00', 'flat', '0.00'])].map(r => row(...r)).join('')}</table>`;

test('state diesel prices, their change and the date are read from the page', () => {
  const p = parseDiesel(page);
  assert.equal(p.states.length, 13);
  assert.deepEqual(p.states.slice(0, 3), [{ state: 'Maharashtra', price: 97.83, change: 0.2, dir: -1 }, { state: 'Delhi', price: 87.67, change: 0, dir: 0 }, { state: 'Bihar', price: 99.36, change: 0.31, dir: 1 }]);
  assert.equal(new Date(p.date).toISOString().slice(0, 10), '2026-10-16');
});

test('prices are fetched once an hour and the last figures are kept when the site fails', async t => {
  const store = new TrackingStore(':memory:'); t.after(() => store.close());
  let calls = 0, now = Date.now();
  const ok = async () => { calls++; return { ok: true, status: 200, text: async () => page }; };
  assert.equal((await dieselPrices(store, { fetcher: ok, now })).states.length, 13);
  await dieselPrices(store, { fetcher: ok, now: now + 30 * 60000 }); assert.equal(calls, 1);
  const broken = async () => ({ ok: false, status: 500, text: async () => '' });
  const stale = await dieselPrices(store, { fetcher: broken, now: now + 2 * 3600000 });
  assert.equal(stale.stale, true); assert.equal(stale.states[0].price, 97.83);
});
