// Receiver attributes kept with each stored packet for device health. Only small, known values are
// kept so a chatty tracker cannot bloat the database.
const KEYS = ['rssi', 'charge', 'power', 'battery', 'alarm', 'type', 'status', 'blocked', 'hdop', 'pdop', 'result', 'motion', 'armed', 'operator', 'event', 'iccid'];
export function cleanExtra(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of KEYS) {
    const v = value[key];
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[key] = v;
    else if (typeof v === 'string' && v.length <= 200) out[key] = v;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}
// Plain words for receiver alarm codes (Traccar names).
const ALARMS = { powerCut: 'Main power cut', powerOff: 'Tracker powered off', lowBattery: 'Tracker backup battery low', lowPower: 'Low vehicle power',
  sos: 'SOS button pressed', vibration: 'Vibration / possible tampering', tampering: 'Tracker tampering', jamming: 'GSM/GPS jamming detected',
  gpsAntennaCut: 'GPS antenna cut', removing: 'Tracker removed', overspeed: 'Overspeed (tracker)', door: 'Door opened', movement: 'Moved while parked',
  accident: 'Possible accident', fallDown: 'Fall detected', geofenceEnter: 'Geofence entered (tracker)', geofenceExit: 'Geofence left (tracker)' };
export const alarmText = code => [...new Set(String(code).split(',').map(c => c.trim()))].map(c => ALARMS[c] || `Tracker alarm: ${c}`).join(', ');

// Turns rows carrying the vehicle-power flag into connect/cut events, newest first.
export function powerTimeline(rows, limit = 10) {
  const events = [];
  let last = null;
  for (const row of rows) {
    let info; try { info = JSON.parse(row.extra); } catch { continue; }
    if (typeof info.charge !== 'boolean') continue;
    // The first row only sets the starting state; later changes are the events worth showing.
    if (last !== null && info.charge !== last) events.push({ at: Number(row.receivedAt), connected: info.charge, battery: row.battery == null ? null : Number(row.battery) });
    last = info.charge;
  }
  return { connected: last, events: events.reverse().slice(0, limit) };
}

// Overspeed: alert when a vehicle whose owner kept the alert on crosses its limit. Speed hovering
// around the limit would otherwise alert on every fix, so a repeat waits a few minutes.
export const SPEED_REPEAT = 3 * 60000;
export const overspeed = (device, speed, previous) => Number(device.speedAlert ?? 1) !== 0 && speed > device.speedLimit && (!previous || previous.speed <= device.speedLimit);

// Tracker alarms split into the alerts customers act on differently. SOS and harsh driving get their
// own types (and voice); a held SOS button or a repeating alarm is reported once per window.
const OWN_TYPE = { sos: ['sos', 'SOS button pressed'], hardBraking: ['harsh_brake', 'Hard braking (reported by tracker)'],
  hardAcceleration: ['harsh', 'Hard acceleration'], hardCornering: ['harsh', 'Sharp turn at speed'] };
export const REPEAT = { sos: 2 * 60000, harsh_brake: 60000, harsh: 60000, alarm: 30 * 60000 };
ALARMS.hardBraking = 'Hard braking'; ALARMS.hardAcceleration = 'Hard acceleration'; ALARMS.hardCornering = 'Sharp turn at speed';
export function alarmAlerts(code) {
  const codes = [...new Set(String(code).split(',').map(c => c.trim()).filter(Boolean))];
  const out = codes.filter(c => OWN_TYPE[c]).map(c => ({ type: OWN_TYPE[c][0], message: OWN_TYPE[c][1] }));
  const rest = codes.filter(c => !OWN_TYPE[c]);
  if (rest.length) out.push({ type: 'alarm', message: alarmText(rest.join(',')) });
  return out;
}
// Hard braking worked out from GPS speed, for trackers without a motion sensor. Only fixes a few
// seconds apart can show it; the average slowdown must reach 7 km/h every second (about 0.2 g)
// from at least 20 km/h, which ordinary stopping does not.
export function hardBrake(previous, speed, recordedAt) {
  if (!previous || previous.valid === 0) return null;
  const seconds = (recordedAt - previous.recordedAt) / 1000;
  if (seconds < 1 || seconds > 15 || previous.speed < 20) return null;
  if ((previous.speed - speed) / seconds < 7) return null;
  return `Hard braking: ${Math.round(previous.speed)} → ${Math.round(speed)} km/h in ${Math.round(seconds)} s.`;
}

// How long a driver's phone link stays valid: 4 hours at the least, a year at the most.
export const SHARE_HOURS = [4, 12, 24, 168, 720, 8760];
export function shareHours(value) {
  if (value === undefined || value === null) return 168;
  const hours = Number(value);
  if (!SHARE_HOURS.includes(hours)) throw Object.assign(new Error('Choose 4 hours, 12 hours, 1 day, 1 week, 1 month or 1 year.'), { status: 400 });
  return hours;
}
// Why a driver's phone stopped sharing, in the words the customer sees.
export const SHARE_STOPPED = {
  stopped: 'Driver stopped sharing location.',
  permission: 'Location is switched off or blocked on the driver\'s phone.',
  closed: 'Driver closed the location sharing page.',
};
export const shareSilent = seconds => `Driver's phone stopped sending location (no update for ${seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds} sec`}).`;

// Types of place a customer can save (the map shows an icon for each).
export const PLACE_KINDS = ['fuel', 'food', 'depot', 'loading', 'unloading', 'parking', 'other'];

// Mobile network bars (0–4) from the tracker's rssi. GT06 sends a 0–4 level, Teltonika 0–5,
// and modems that send the raw CSQ use 0–31 (99 = unknown).
export function signalBars(rssi) {
  const v = Number(rssi);
  if (rssi == null || !Number.isFinite(v) || v < 0 || v === 99) return null;
  if (v <= 5) return Math.min(4, Math.round(v * (v > 4 ? 0.8 : 1)));
  return v > 31 ? null : Math.min(4, Math.ceil(v / 31 * 4));
}

// Parking lock: once the owner locks a parked vehicle, the engine starting or the vehicle moving
// more than PARK_RADIUS metres from where it was locked raises one alert.
export const PARK_RADIUS = 100;
export function parkBreach(device, { ignition, valid, latitude, longitude }, metres) {
  if (!Number(device.parkLock) || Number(device.parkAlerted)) return null;
  if (ignition === 1) return 'Parking lock: engine started.';
  if (valid && device.parkLat != null) {
    const m = metres({ latitude, longitude }, { latitude: Number(device.parkLat), longitude: Number(device.parkLon) });
    if (m > PARK_RADIUS) return `Parking lock: vehicle moved ${Math.round(m)} m from where it was parked.`;
  }
  return null;
}
export const cleanPhone = value => {
  if (value === '' || value == null) return '';
  const digits = String(value).replace(/[\s()-]/g, '');
  if (!/^\+?\d{10,13}$/.test(digits)) { const e = new Error('Enter a 10 digit mobile number.'); e.status = 400; throw e; }
  return digits;
};

// Is the vehicle moving, or is it standing still while its GPS wanders? A GPS at rest jumps about
// one spot: step by step it covers ground, but it keeps coming back, so the straight line from where
// it was stays short. A vehicle that is going somewhere keeps going, so the straight line is most of
// the path it walked. That is the test — not speed, which a resting GPS reports as 4-6 km/h anyway.
// It is read over a few fixes, not one, because a single jump tells you nothing; over that stretch
// MOVE_M of real ground is enough, so a vehicle that has pulled out 25 m is already running.
export const MOVING_KMH = 2;   // slower than a walking pace is not driving
export const MOVE_M = 25;      // this much ground in a straight line and it has really moved
export const STRAIGHT = 0.6;   // and most of the path walked has to be that straight line
export const ARRIVE_M = 100;   // standing "here" means within this of where it stands now
const WINDOW_MS = 30 * 60000;  // older fixes say nothing about what the vehicle is doing now
const at = p => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) });
// list is newest first; true when list[k] is a running fix.
export function movingAt(list, k, distance) {
  const a = list[k];
  if (!a || Number(a.speed) < MOVING_KMH) return false;
  const window = [];
  for (let j = k + 1; j < Math.min(list.length, k + 8); j++) {
    if (Math.abs(a.recordedAt - list[j].recordedAt) > WINDOW_MS) break;
    window.push(list[j]);
  }
  if (!window.length) return false;
  // One jump says nothing, so read a few fixes back — as many as there are, where that is fewer.
  const least = Math.min(3, window.length);
  let path = 0, previous = a;
  for (let n = 0; n < window.length; n++) {
    path += distance(at(previous), at(window[n]));
    previous = window[n];
    if (n + 1 < least) continue;
    const net = distance(at(a), at(window[n]));
    if (net >= MOVE_M && net >= path * STRAIGHT) return true;
  }
  return false;
}
// Was the vehicle running at fixes[i] of an oldest-first list? Judged against the fixes before it,
// or, for the very first one where there are none, against the fixes after it.
export function runningAt(fixes, i, distance) {
  const back = [fixes[i], ...fixes.slice(Math.max(0, i - 8), i).reverse()];
  return movingAt(back.length > 1 ? back : [fixes[i], ...fixes.slice(i + 1, i + 9)], 0, distance);
}
// Newest running fix in a newest-first list, or null.
export function lastRealMove(list, distance) {
  for (let k = 0; k < list.length; k++) if (movingAt(list, k, distance)) return list[k];
  return null;
}
// Since when the vehicle has been standing where it stands now: walk back while the fixes stay
// within ARRIVE_M of the latest one. Jitter never leaves that circle, so it cannot restart the clock,
// and the answer is the moment the vehicle arrived. Fixes come newest first.
export function standingSince(fixes, distance, gap = 12 * 3600000) {
  const valid = fixes.filter(p => p.valid !== 0);
  const here = valid[0];
  if (!here) return null;
  let since = here.recordedAt, previous = here;
  for (const p of valid.slice(1)) {
    // After a long silence we cannot claim the vehicle stayed put, so the standing run starts after it.
    if (previous.recordedAt - p.recordedAt > gap || distance(at(here), at(p)) > ARRIVE_M) break;
    since = p.recordedAt;
    previous = p;
  }
  return since;
}
