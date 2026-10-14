import { existsSync, writeFileSync } from 'node:fs';
import { TrackingStore } from '../server/tracking-store.mjs';

if (process.env.WAYPOINT_RESET !== 'DELETE_ALL_OLD_DATA' || process.env.TRACCAR_URL !== 'http://127.0.0.1:8082' || !process.env.TRACCAR_TOKEN || !process.env.WAYPOINT_URL?.startsWith('https://')) {
  throw new Error('This reset requires the explicit cloud confirmation flag and local Traccar URL.');
}
const email = process.env.WAYPOINT_ADMIN_EMAIL;
if (!email) throw new Error('Set WAYPOINT_ADMIN_EMAIL for the new admin account.');
const credentialPath = 'server/private/admin-login.txt';
if (existsSync(credentialPath)) throw new Error('Admin login file already exists; refusing to overwrite it.');
if (await fetch('http://127.0.0.1:8180/api/gps/health').then(r => r.ok).catch(() => false)) {
  throw new Error('Stop waypoint.service before resetting its database.');
}

const headers = { Authorization: `Bearer ${process.env.TRACCAR_TOKEN}`, Accept: 'application/json' };
async function traccar(path, method = 'GET') {
  const response = await fetch(`${process.env.TRACCAR_URL}/api${path}`, { method, headers, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Traccar ${method} ${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
const remote = await traccar('/devices');
for (const device of remote) await traccar(`/devices/${device.id}`, 'DELETE');
if ((await traccar('/devices')).length || (await traccar('/positions')).length) {
  throw new Error('Traccar still has devices or positions; Waypoint database was not reset.');
}

const store = new TrackingStore('server/private/tracking.sqlite');
try {
  store.db.exec(`PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;
    DELETE FROM driver_sessions; DELETE FROM driver_links; DELETE FROM commands;
    DELETE FROM alerts; DELETE FROM fence_state; DELETE FROM fences;
    DELETE FROM positions; DELETE FROM devices; DELETE FROM customers;
    DELETE FROM workspace_data; DELETE FROM admins;
    COMMIT; PRAGMA foreign_keys=ON;`);
  for (const table of ['relay_commands','relay_installations']) {
    if (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) store.db.exec(`DELETE FROM ${table}`);
  }
  const admin = store.createAdmin(email);
  writeFileSync(credentialPath, `Waypoint cloud admin login\nEmail: ${admin.email}\nPassword: ${admin.password}\nURL: ${process.env.WAYPOINT_URL}/?live=1&auth=admin\n`, { mode: 0o600, flag: 'wx' });
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  console.log(`Cleared ${remote.length} Traccar device(s), all Waypoint customer/fleet/workspace records, and created one fresh admin account.`);
} finally {
  store.close();
}
