import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

const url = process.env.TRACCAR_SETUP_URL;
if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) {
  throw new Error('Set TRACCAR_SETUP_URL to a local SSH-forwarded Traccar URL.');
}

const dir = resolve('server/private');
const credentials = readFileSync(resolve(dir, 'cloud-gateway-admin.txt'), 'utf8');
const email = credentials.match(/^Email: (.+)$/m)?.[1];
const password = credentials.match(/^Password: (.+)$/m)?.[1];
if (!email || !password) throw new Error('Saved gateway admin credentials are incomplete.');

const response = await fetch(`${url}/api/session/token`, {
  method: 'POST',
  headers: {
    Authorization: `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({ expiration: new Date(Date.now() + 365 * 86400000).toISOString() }),
});
if (!response.ok) throw new Error(`Gateway token renewal failed: HTTP ${response.status}`);
const token = await response.text();
if (!token || /[\r\n]/.test(token)) throw new Error('Invalid gateway token response.');

const envPath = resolve(dir, 'cloud-gateway.env');
const tempPath = `${envPath}.tmp`;
writeFileSync(tempPath, `TRACCAR_URL=${url}\nTRACCAR_TOKEN=${token}\n`, { mode: 0o600 });
renameSync(tempPath, envPath);
console.log('Cloud gateway token renewed in server/private/cloud-gateway.env.');
