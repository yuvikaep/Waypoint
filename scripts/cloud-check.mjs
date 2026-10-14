import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

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
  return { response, data: await response.json() };
}

const age = value => value ? `${Math.round((Date.now() - Date.parse(value)) / 1000)}s ago` : 'never';
const db = new DatabaseSync('server/private/tracking.sqlite', { readOnly: true });
try {
  await request(`${origin}/api/gps/health`);
  const adminToken = readFileSync('server/private/admin-token', 'utf8').trim();
  const login = await request('http://127.0.0.1:8180/api/gps/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: adminToken }),
  });
  const cookie = login.response.headers.get('set-cookie')?.split(';')[0];
  const { data: state } = await request('http://127.0.0.1:8180/api/gps/state', { headers: { Cookie: cookie } });
  const headers = { Authorization: `Bearer ${traccarToken}` };
  const { data: remoteDevices } = await request(`${traccarUrl}/api/devices`, { headers });
  const { data: remotePositions } = await request(`${traccarUrl}/api/positions`, { headers });
  const devices = db.prepare("SELECT name,uniqueId,model,traccarId FROM devices WHERE model!='Mobile' ORDER BY name").all();
  let ready = state.gateway.connected;
  console.log(`Public HTTPS: ready (${origin})`);
  console.log(`Waypoint bridge: ${state.gateway.connected ? 'connected' : state.gateway.error || 'disconnected'}`);
  if(!devices.length)console.log('No hardware devices registered yet.');
  for (const device of devices) {
    const remote = remoteDevices.find(item => item.uniqueId === device.uniqueId);
    const position = remotePositions.find(item => item.deviceId === remote?.id);
    const mapped = !!remote && remote.id === device.traccarId;
    ready &&= mapped;
    console.log(`${device.name} (${device.model}, ${device.uniqueId}): ${mapped ? 'mapped' : 'NOT MAPPED'}; cloud gateway ${remote?.status || 'missing'}; last packet ${age(remote?.lastUpdate)}; cloud GPS fix ${age(position?.fixTime)}`);
  }
  console.log(ready ? 'Cloud stack ready for incoming tracker packets.' : 'Cloud stack needs attention before tracker onboarding.');
  if (!ready) process.exitCode = 1;
} catch (error) {
  console.error(`Cloud check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
