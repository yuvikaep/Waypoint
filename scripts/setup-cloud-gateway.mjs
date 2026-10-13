import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const url = process.env.TRACCAR_SETUP_URL;
if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) {
  throw new Error('Set TRACCAR_SETUP_URL to a local SSH-forwarded Traccar URL.');
}

const dir = resolve('server/private');
const credentialsPath = resolve(dir, 'cloud-gateway-admin.txt');
const envPath = resolve(dir, 'cloud-gateway.env');
mkdirSync(dir, { recursive: true, mode: 0o700 });
if (existsSync(credentialsPath) || existsSync(envPath)) {
  throw new Error('Cloud gateway credentials already exist; refusing to replace them.');
}

const serverResponse = await fetch(`${url}/api/server`);
if (!serverResponse.ok || !(await serverResponse.json()).newServer) {
  throw new Error('Cloud gateway is unavailable or already initialized.');
}

const email = 'admin@waypoint.local';
const password = randomBytes(32).toString('base64url');
const userResponse = await fetch(`${url}/api/users`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Waypoint gateway admin', email, password }),
});
if (!userResponse.ok) throw new Error(`Admin creation failed: HTTP ${userResponse.status}`);
writeFileSync(credentialsPath, `Email: ${email}\nPassword: ${password}\n`, { mode: 0o600, flag: 'wx' });

const tokenResponse = await fetch(`${url}/api/session/token`, {
  method: 'POST',
  headers: {
    Authorization: `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({ expiration: new Date(Date.now() + 365 * 86400000).toISOString() }),
});
if (!tokenResponse.ok) throw new Error(`Token creation failed: HTTP ${tokenResponse.status}`);
const token = await tokenResponse.text();
if (!token || /[\r\n]/.test(token)) throw new Error('Invalid gateway token.');
writeFileSync(envPath, `TRACCAR_URL=${url}\nTRACCAR_TOKEN=${token}\n`, { mode: 0o600, flag: 'wx' });
console.log('Cloud gateway initialized. Credentials saved under server/private/.');
