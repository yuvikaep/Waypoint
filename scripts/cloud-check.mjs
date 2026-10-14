// Read-only production check, run on the Oracle VM. The Vercel app owns registrations;
// this asks the local Traccar receiver what each tracker has actually sent.
const origin = process.env.WAYPOINT_URL?.replace(/\/$/, '');
const traccarUrl = process.env.TRACCAR_URL?.replace(/\/$/, '');
const traccarToken = process.env.TRACCAR_TOKEN;
if (!origin?.startsWith('https://') || !traccarUrl || !traccarToken) {
  console.error('Set WAYPOINT_URL, TRACCAR_URL and TRACCAR_TOKEN on the cloud VM.');
  process.exit(1);
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${new URL(url).pathname}: HTTP ${response.status}`);
  return response.json();
}

const age = value => value ? `${Math.round((Date.now() - Date.parse(value)) / 1000)}s ago` : 'never';
// A GT06 heartbeat is stored by Traccar as an invalid 0,0 point dated 1980; it is not a GPS fix.
const isRealFix = p => p?.valid && (p.latitude || p.longitude) && Date.parse(p.fixTime) > Date.UTC(2020, 0, 1);

try {
  await request(`${origin}/api/gps/health`);
  console.log(`Public HTTPS: ready (${origin})`);
  const headers = { Authorization: `Bearer ${traccarToken}` };
  const devices = await request(`${traccarUrl}/api/devices`, { headers });
  if (!devices.length) console.log('No hardware devices registered with the receiver yet.');
  let ready = devices.length > 0;
  for (const device of devices) {
    const [position] = device.positionId ? await request(`${traccarUrl}/api/positions?id=${device.positionId}`, { headers }) : [];
    const fix = isRealFix(position);
    ready &&= device.status === 'online';
    console.log(`${device.name} (${device.uniqueId}): receiver ${device.status}; last packet ${age(device.lastUpdate)}; ` +
      `GPS fix ${fix ? age(position.fixTime) : position ? 'none (last packet had no valid location)' : 'never'}`);
  }
  console.log(ready ? 'Every registered tracker is online.' : 'At least one tracker is offline or has not reported yet.');
  if (!ready) process.exitCode = 1;
} catch (error) {
  console.error(`Cloud check failed: ${error.message}`);
  process.exitCode = 1;
}
