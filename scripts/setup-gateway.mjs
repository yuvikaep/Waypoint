import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';

// Only bootstrap a brand-new loopback gateway. Existing installations keep their own users.
const url='http://127.0.0.1:8082/api';
const dir=resolve('server/private');
mkdirSync(dir,{recursive:true,mode:0o700});
if(existsSync(resolve(dir,'gateway.env')))throw new Error('Local gateway credentials already exist. Use the existing gateway.env.');
const server=await fetch(url+'/server',{signal:AbortSignal.timeout(5000)}).then(r=>r.json());
if(!server.newServer)throw new Error('Gateway is already initialized. Set TRACCAR_URL and TRACCAR_TOKEN in .env using your existing account.');
const password=randomBytes(32).toString('base64url');
const email='admin@waypoint.local';
const user=await fetch(url+'/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Waypoint local admin',email,password}),signal:AbortSignal.timeout(10000)});
if(!user.ok)throw new Error(`Gateway setup failed: HTTP ${user.status}`);
writeFileSync(resolve(dir,'gateway-admin.txt'),`Email: ${email}\nPassword: ${password}\n`,{mode:0o600,flag:'wx'});
const tokenResponse=await fetch(url+'/session/token',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(`${email}:${password}`).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({expiration:new Date(Date.now()+365*86400000).toISOString()}),signal:AbortSignal.timeout(10000)});
if(!tokenResponse.ok)throw new Error(`Account created; token request returned HTTP ${tokenResponse.status}. Sign in to the local gateway to generate a token.`);
const token=await tokenResponse.text();
if(!token || /[\r\n]/.test(token))throw new Error('Invalid token response.');
writeFileSync(resolve(dir,'gateway.env'),`TRACCAR_URL=http://127.0.0.1:8082\nTRACCAR_TOKEN=${token}\n`,{mode:0o600,flag:'wx'});
console.log('Local gateway connected. Private credentials saved under server/private/. Restart npm run dev.');
