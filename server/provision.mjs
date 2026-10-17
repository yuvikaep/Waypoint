// Automatic set-up of a newly onboarded tracker. A brand-new tracker does not know this server yet, so
// the first two texts (APN and server) are sent by hand; once it connects, the remaining commands go
// out one at a time over GPRS, each waiting for the tracker's reply.

// Ordinary prepaid/postpaid APNs that are publicly documented. IoT / M2M SIMs are not listed on purpose:
// they use a secure APN that the SIM seller assigns, so it must be typed in, never guessed.
export const OPERATORS = {
  airtel: { label: 'Airtel', apn: { personal: 'airtelgprs.com' } },
  jio: { label: 'Jio', apn: { personal: 'jionet' } },
  bsnl: { label: 'BSNL', apn: { personal: 'bsnlnet' } },
  vi: { label: 'Vi (Vodafone Idea)', apn: {} },
  other: { label: 'Other', apn: {} },
};
export const apnFor = (operator, simType) => OPERATORS[operator]?.apn?.[simType === 'iot' ? 'iot' : 'personal'] || '';

const GT06_FAMILY = ['GT06', 'GT06N', 'PT06'];
const HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9.-]{3,100})$/;

// The two texts to send by hand, because the tracker cannot receive anything over GPRS yet.
export function bootstrapSms(device, gateway) {
  if (!GT06_FAMILY.includes(device.model)) return [];
  const sms = [];
  if (device.apn) sms.push({ label: 'Set the SIM\'s APN', text: `APN,${[device.apn, ...(device.apnUser || device.apnPass ? [device.apnUser || '', device.apnPass || ''] : [])].join(',')}#` });
  if (gateway?.trackerHost && HOST.test(gateway.trackerHost)) {
    const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(gateway.trackerHost);
    sms.push({ label: 'Point it at this server', text: `SERVER,${ip ? 0 : 1},${gateway.trackerHost},${gateway.gt06Port ?? 5023},0#` });
  }
  sms.push({ label: 'Check it connected', text: 'STATUS#' });
  return sms;
}

// Ordered steps run over GPRS after the first connection. Every text is on the command channel's allowlist.
export function buildPlan(device, options = {}) {
  const moving = Number(options.moving ?? 10), parked = Number(options.parked ?? 60);
  if (GT06_FAMILY.includes(device.model)) {
    const steps = [
      { command: 'VERSION#', label: 'Read firmware version' },
      { command: 'GMT,E,5,30#', label: 'Set time zone to IST' },
      // Both TIMER values are seconds; the firmware ignores anything under 5 and then uploads nothing
      // while the ignition is off, which looks exactly like a tracker that has lost GPS.
      { command: `TIMER,${moving},${parked}#`, label: `Upload every ${moving} s with ignition on, ${parked} s with it off` },
      // Minutes the GPS runs after a wake-up. 0 keeps it on, so a standing vehicle still reports.
      { command: 'SENDS,0#', label: 'Keep GPS on even when the vehicle stands still' },
      { command: 'ACCREP,ON#', label: 'Report ignition changes immediately' },
      { command: 'BATCH,OFF#', label: 'Send every fix at once (no batching)' },
      { command: 'GPRSON,1#', label: 'Keep mobile data on' },
      { command: 'STATUS#', label: 'Read status (signal, power, GPS)' },
      { command: 'PARAM#', label: 'Read back the settings' },
      { command: 'RESET#', label: 'Restart so the settings take effect' },
    ];
    return steps.map((s, i) => ({ ...s, seq: i + 1 }));
  }
  if (device.model === 'Mobile') return [];
  return [{ command: 'getver', label: 'Read firmware version' }, { command: 'getstatus', label: 'Read status' }].map((s, i) => ({ ...s, seq: i + 1 }));
}

// What a tracker's reply means. Concox firmware answers with the setting it applied, or an error word.
export function classifyReply(text) {
  const t = String(text || '');
  if (!t.trim()) return 'unknown';
  return /\b(error|fail(?:ed)?|invalid|unknown|wrong|incorrect|not support)/i.test(t) ? 'failed' : 'ok';
}

const REPLY_WAIT = 4 * 60000;     // how long to wait for an answer before trying again
const MAX_ATTEMPTS = 3;
const SEND_GAP = 15000;           // breathing room between two commands
const RECENT = 4 * 60000;         // the tracker must have been heard from this recently

// One tick: move the plan along by at most one command. Safe to call as often as the gateway syncs.
export async function provisionTick(store, bridge, device, now = Date.now()) {
  const steps = await store.provisionSteps(device.id);
  const open = steps.filter(s => s.status === 'pending' || s.status === 'sent');
  if (!open.length) return { done: steps.length > 0, steps };
  const current = open[0];
  if (current.status === 'sent') {
    const command = current.commandId ? (await store.deviceCommands(device.id, 50)).find(c => c.id === current.commandId) : null;
    if (command?.status === 'answered') {
      const reply = (command.detail.split('→ Reply:')[1] || '').trim();
      const verdict = classifyReply(reply);
      await store.provisionUpdate(current.id, { status: verdict === 'failed' ? 'failed' : 'ok', reply: reply || null, doneAt: now });
      return { advanced: true };
    }
    // RESET# often gets no text reply; a reconnect afterwards is the proof that it worked.
    if (current.command === 'RESET#' && device.lastSeen && device.lastSeen > Number(current.sentAt) + 20000) {
      await store.provisionUpdate(current.id, { status: 'ok', reply: 'Reconnected after restart', doneAt: now });
      return { advanced: true };
    }
    if (now - Number(current.sentAt) < REPLY_WAIT) return { waiting: true };
    if (current.attempts >= MAX_ATTEMPTS) { await store.provisionUpdate(current.id, { status: 'failed', reply: 'No reply from the tracker after 3 tries', doneAt: now }); return { advanced: true }; }
    await store.provisionUpdate(current.id, { status: 'pending' });   // time out: send it again below
  }
  const next = (await store.provisionSteps(device.id)).find(s => s.status === 'pending');
  if (!next) return {};
  // Pace the commands and only talk to a tracker that is actually in contact.
  const last = Math.max(0, ...steps.map(s => Number(s.sentAt || 0)));
  if (now - last < SEND_GAP) return { waiting: true };
  if (!device.lastSeen || now - device.lastSeen > RECENT) return { waiting: true, reason: 'tracker not connected yet' };
  // The restart goes last and only after the others are settled, since it drops the connection.
  if (next.command === 'RESET#' && steps.some(s => s.id !== next.id && (s.status === 'pending' || s.status === 'sent'))) return { waiting: true };
  try {
    const result = await bridge.sendText(device, next.command);
    const row = await store.recordCommand(device.id, result, `CMD ${next.command} sent over GPRS (automatic set-up).`);
    await store.provisionUpdate(next.id, { status: 'sent', attempts: Number(next.attempts) + 1, commandId: row.id, sentAt: now });
    return { sent: next.command };
  } catch (e) {
    const attempts = Number(next.attempts) + 1;
    await store.provisionUpdate(next.id, attempts >= MAX_ATTEMPTS ? { status: 'failed', attempts, reply: String(e.message).slice(0, 200), doneAt: now } : { attempts, sentAt: now });
    return { error: e.message };
  }
}

const OPERATOR_KEYS = Object.keys(OPERATORS);
const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
// SIM and APN details collected when a device is onboarded; only supplied fields are returned.
export function cleanSetup(input = {}) {
  const out = {};
  if (input.simOperator !== undefined) { const v = input.simOperator || null; if (v && !OPERATOR_KEYS.includes(v)) bad('Choose a SIM operator from the list.'); out.simOperator = v; }
  if (input.simType !== undefined) { const v = input.simType || null; if (v && !['personal', 'iot'].includes(v)) bad('SIM type must be personal or IoT.'); out.simType = v; }
  if (input.simNumber !== undefined) { const v = String(input.simNumber || '').trim(); if (v && !/^[+0-9 -]{6,20}$/.test(v)) bad('SIM number may contain digits, spaces, + and - only.'); out.simNumber = v || null; }
  if (input.apn !== undefined) { const v = String(input.apn || '').trim(); if (v && !/^[A-Za-z0-9._-]{1,40}$/.test(v)) bad('APN may contain letters, digits, dots, dashes and underscores only.'); out.apn = v || null; }
  for (const key of ['apnUser', 'apnPass']) if (input[key] !== undefined) { const v = String(input[key] || '').trim(); if (v && !/^[A-Za-z0-9._@-]{1,40}$/.test(v)) bad('APN user and password may use letters, digits and . _ @ - only.'); out[key] = v || null; }
  return out;
}
export function cleanIntervals(input = {}) {
  const num = (v, d) => { const n = Number(v ?? d); if (!Number.isInteger(n) || n < 5 || n > 18000) bad('Upload intervals must be 5-18000 seconds.'); return n; };
  return { moving: num(input.moving, 10), parked: num(input.parked, 60) };
}

// What the vehicle itself is, collected when it is onboarded. Shown to the customer on the card.
export const VEHICLE_TYPES = {
  truck: 'Truck / Lorry', trailer: 'Trailer', tipper: 'Tipper / Dumper', tanker: 'Tanker',
  bus: 'Bus', van: 'Van / Tempo', pickup: 'Pickup', car: 'Car', auto: 'Auto rickshaw',
  bike: 'Bike / Scooter', tractor: 'Tractor', jcb: 'JCB / Excavator', ambulance: 'Ambulance', other: 'Other',
};
export const FUEL_TYPES = { diesel: 'Diesel', petrol: 'Petrol', cng: 'CNG', lpg: 'LPG', electric: 'Electric', hybrid: 'Hybrid' };
const VEHICLE_TEXT = { makeModel: ['Make and model', 120], registration: ['Registration number', 20], chassisNumber: ['Chassis number', 25], engineNumber: ['Engine number', 25], ownerName: ['Registered owner', 120], vehicleNotes: ['Vehicle notes', 300] };
// Only the fields that were supplied are returned, so a partial edit never clears the rest.
export function cleanVehicle(input = {}) {
  const out = {};
  if (input.vehicleType !== undefined) { const v = input.vehicleType || null; if (v && !VEHICLE_TYPES[v]) bad('Choose a vehicle type from the list.'); out.vehicleType = v; }
  if (input.fuelType !== undefined) { const v = input.fuelType || null; if (v && !FUEL_TYPES[v]) bad('Choose a fuel type from the list.'); out.fuelType = v; }
  for (const [key, [label, max]] of Object.entries(VEHICLE_TEXT)) if (input[key] !== undefined) {
    const v = String(input[key] ?? '').trim();
    if (v.length > max) bad(`${label} may be at most ${max} characters.`);
    out[key] = v || null;
  }
  if (input.modelYear !== undefined) { const v = input.modelYear === '' || input.modelYear === null ? null : Number(input.modelYear); if (v !== null && (!Number.isInteger(v) || v < 1950 || v > new Date().getFullYear() + 1)) bad('Enter a model year between 1950 and next year.'); out.modelYear = v; }
  if (input.capacityKg !== undefined) { const v = input.capacityKg === '' || input.capacityKg === null ? null : Number(input.capacityKg); if (v !== null && (!Number.isInteger(v) || v < 0 || v > 200000)) bad('Load capacity must be 0-200000 kg.'); out.capacityKg = v; }
  return out;
}
