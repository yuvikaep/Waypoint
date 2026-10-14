import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
const secretsPath=process.argv[2];
if(!secretsPath||!process.env.TRACCAR_TOKEN||process.env.TRACCAR_URL!=='http://127.0.0.1:8082')throw Error('Run on the Oracle gateway with its existing private environment.');
const secrets=JSON.parse(readFileSync(secretsPath,'utf8'));
if(typeof secrets.GPS_GATEWAY_SECRET!=='string'||secrets.GPS_GATEWAY_SECRET.length<24)throw Error('Invalid gateway secret.');
writeFileSync('server/private/gateway-agent.env',[
  'WAYPOINT_CLOUD_URL=https://waypoint-eta-pied.vercel.app',
  `GPS_GATEWAY_SECRET=${secrets.GPS_GATEWAY_SECRET}`,
  'TRACCAR_URL=http://127.0.0.1:8082',
  `TRACCAR_TOKEN=${process.env.TRACCAR_TOKEN}`,
].join('\n')+'\n',{mode:0o600});
unlinkSync(secretsPath);
console.log('Gateway-only environment prepared.');
