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
