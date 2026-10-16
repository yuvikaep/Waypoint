// Today's diesel price in every state, read from goodreturns.in (its robots.txt allows this page).
// Oil companies revise prices at 6 am; the page is read at most once an hour and kept in the
// store, so every customer sees the same figures without each browser hitting the site.
const SOURCE = 'https://www.goodreturns.in/diesel-price.html';
export const FUEL_KEEP = 60 * 60000;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export function parseDiesel(html) {
  const states = [];
  const row = /<a href="\/diesel-price-in-[a-z0-9-]+-s\d+\.html" title="([^"]+)">[^<]+<\/a><\/td>\s*<td>\s*&#x20b9;\s*([\d.]+)\s*<\/td>\s*<td>\s*<span class="fp-(\w+)">\s*(-?[\d.]+)/g;
  for (const m of html.matchAll(row)) {
    const price = Number(m[2]), change = Math.abs(Number(m[4]));
    if (!Number.isFinite(price) || price < 30 || price > 300) continue;
    const dir = m[3] === 'up' ? 1 : m[3] === 'down' ? -1 : 0;
    states.push({ state: m[1].replace(/&amp;/g, '&'), price, change: dir ? Math.round(change * 100) / 100 : 0, dir });
  }
  const d = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3})[a-z]*,?\s+(20\d\d)/.exec(html);
  const date = d && MONTHS[d[2].toLowerCase()] !== undefined ? Date.UTC(Number(d[3]), MONTHS[d[2].toLowerCase()], Number(d[1])) : null;
  return { date, states: [...new Map(states.map(s => [s.state, s])).values()] };
}

export async function dieselPrices(store, { fetcher = fetch, now = Date.now() } = {}) {
  const cached = await store.landmarkTile('fuel:diesel');
  if (cached && now - cached.fetchedAt < FUEL_KEEP) return cached;
  try {
    const r = await fetcher(SOURCE, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Waypoint fleet app)' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`Fuel prices HTTP ${r.status}`);
    const parsed = parseDiesel(await r.text());
    if (parsed.states.length < 10) throw new Error('Fuel price page changed');
    const row = { ...parsed, source: 'goodreturns.in', fetchedAt: now };
    await store.saveLandmarkTile('fuel:diesel', row);
    return row;
  } catch (e) {
    // Yesterday's figures are better than none; say how old they are.
    if (cached) return { ...cached, stale: true };
    throw Object.assign(new Error('Diesel prices are unavailable right now.'), { status: 503 });
  }
}
