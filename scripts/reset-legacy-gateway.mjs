import { rmSync, readdirSync } from 'node:fs';
import { GatewayAgent } from '../server/gateway-agent.mjs';

if(process.env.WAYPOINT_RESET!=='DELETE_ALL_OLD_DATA'||process.cwd()!=='/opt/waypoint')throw Error('This approved reset must run on the Oracle gateway.');
const agent=new GatewayAgent({cloudUrl:process.env.WAYPOINT_CLOUD_URL,cloudSecret:process.env.GPS_GATEWAY_SECRET,traccarUrl:process.env.TRACCAR_URL,traccarToken:process.env.TRACCAR_TOKEN});
if((await agent.cloud('/devices')).devices.length)throw Error('Fresh cloud already has hardware registrations; do not wipe the receiver.');
if(await fetch('http://127.0.0.1:8180/api/gps/health',{signal:AbortSignal.timeout(3000)}).then(r=>r.ok).catch(()=>false))throw Error('Stop legacy waypoint.service first.');
const devices=await agent.tracker('/devices');
for(const device of devices)await agent.tracker(`/devices/${device.id}`,{method:'DELETE'});
if((await agent.tracker('/devices')).length||(await agent.tracker('/positions')).length)throw Error('Legacy gateway records still exist.');
for(const name of ['tracking.sqlite','tracking.sqlite-wal','tracking.sqlite-shm','admin-login.txt'])rmSync(`server/private/${name}`,{force:true});
rmSync('/opt/waypoint-rollback',{recursive:true,force:true});
// Traccar recreates logs; remove historical telemetry after reception is reset.
for(const name of readdirSync('/opt/traccar/logs'))if(name.startsWith('tracker-server.log'))rmSync(`/opt/traccar/logs/${name}`,{force:true});
console.log(`Removed ${devices.length} old tracker registrations and legacy app data. Fresh app storage remains on Vercel.`);
