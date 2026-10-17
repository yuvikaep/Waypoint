// Keeps a parked GT06-family tracker's location fresh.
// A parked tracker (PT06 and similar) stops uploading location packets and only sends heartbeats, but it answers
// the "WHERE#" text with its current GPS position. So while a tracker is connected and its last fix has gone
// stale, the server asks with WHERE# every few minutes and turns the reply into a normal position.

const GT06_FAMILY = ['GT06', 'GT06N', 'PT06'];
export const STALE_MS = 8 * 60000;      // ask once the last fix is older than this
export const ASK_EVERY_MS = 4 * 60000;  // never more often than this per tracker
const ONLINE_MS = 5 * 60000;            // only a tracker that was heard from recently
export const MARK = 'CMD WHERE# sent over GPRS (automatic location refresh).';

// "Current position! Lat:N25.270162,Lon:E82.837522,Course:25,Speed:0,DateTime:2026-10-17  14:50:50"
const REPLY = /Current position!?\s*Lat:\s*([NS])\s*(\d{1,2}(?:\.\d+)?)\s*,\s*Lon:\s*([EW])\s*(\d{1,3}(?:\.\d+)?)\s*(?:,\s*Course:\s*(\d{1,3}))?\s*(?:,\s*Speed:\s*(\d{1,3}(?:\.\d+)?))?/i;
export function parseWhere(text) {
  const m = REPLY.exec(String(text || ''));
  if (!m) return null;
  const latitude = (m[1].toUpperCase() === 'S' ? -1 : 1) * Number(m[2]), longitude = (m[3].toUpperCase() === 'W' ? -1 : 1) * Number(m[4]);
  if (!(Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) || (latitude === 0 && longitude === 0)) return null;
  const heading = m[5] == null ? null : Math.min(360, Number(m[5])), speed = m[6] == null ? 0 : Math.min(400, Number(m[6]));
  return { latitude, longitude, heading, speed };
}

// One call per tracker per gateway sync: send WHERE# if it is due.
export async function locationTick(store, bridge, device, now = Date.now()) {
  if (!GT06_FAMILY.includes(device.model) || !device.traccarId) return { skipped: 'not a GT06-family tracker' };
  if (!device.lastSeen || now - device.lastSeen > ONLINE_MS) return { skipped: 'tracker not connected' };
  const full = await store.device(device.id), p = full.position;
  if (p && now - p.recordedAt < STALE_MS) return { skipped: 'location is fresh' };
  // Let automatic set-up finish first; its commands must not be mixed with location asks.
  if ((await store.provisionSteps(device.id)).some(s => s.status === 'pending' || s.status === 'sent')) return { skipped: 'set-up in progress' };
  const recent = (await store.deviceCommands(device.id, 10)).find(c => String(c.detail).startsWith('CMD WHERE#') && now - Number(c.createdAt) < ASK_EVERY_MS);
  if (recent) return { skipped: 'asked recently' };
  try {
    const result = await bridge.sendText(device, 'WHERE#');
    await store.recordCommand(device.id, result, MARK);
    return { sent: true };
  } catch (e) { return { error: e.message }; }
}
