import { PostgresTrackingStore } from '../server/postgres-store.mjs';
import { createTrackingServer } from '../server/tracking.mjs';
import { createCloudFileHandler } from '../server/cloud-files.mjs';
import { isIP } from 'node:net';
import { normalizeCloudRequest } from '../server/cloud-routing.mjs';
import { databasePool,initializeDatabase,CloudSessions,cloudRateLimit,authenticateWorkspace,cloudBridge,gatewayRequest } from '../server/cloud-runtime.mjs';

export default async function handler(req,res){
  let client,store;
  try{
    normalizeCloudRequest(req);
    await initializeDatabase();
    client=await databasePool().connect();store=new PostgresTrackingStore(client);
    const sessions=new CloudSessions(client);
    const origin=`https://${req.headers.host}`;
    if(req.headers.origin&&req.headers.origin!==origin)throw Object.assign(new Error('Origin is not allowed.'),{status:403});
    const files=createCloudFileHandler({authenticate:request=>authenticateWorkspace(request,store,sessions)});
    if(await files(req,res))return;
    const bridge=await cloudBridge(store,client);
    if(await gatewayRequest(req,res,store,client,bridge))return;
    const adminToken=process.env.WAYPOINT_SESSION_SECRET;
    if(!adminToken||adminToken.length<24)throw new Error('Vercel session secret is not configured.');
    const server=createTrackingServer({store,adminToken,bridge,publicOrigin:origin,frontendOrigin:undefined,sessionStore:sessions,rateLimit:cloudRateLimit(client),clientAddressResolver:request=>{
      const address=String(request.headers['x-vercel-forwarded-for']||'').split(',')[0].trim();
      return isIP(address)?address:request.socket?.remoteAddress||'unknown';
    },backgroundTasks:false,relayEnabled:process.env.GPS_RELAY_ENABLED==='true'});
    await server.listeners('request')[0](req,res);
  }catch(error){
    console.error('Cloud request failed:',error.code||error.status||error.name);
    if(!res.headersSent){res.writeHead(error.status||503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:error.status?error.message:'Cloud service is temporarily unavailable.'}));}else res.end();
  }finally{if(store)await store.close();client?.release();}
}
