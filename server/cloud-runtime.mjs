import pg from 'pg';
import { randomBytes, scryptSync } from 'node:crypto';
import { PostgresTrackingStore } from './postgres-store.mjs';
import { fail, hash } from './tracking-store.mjs';
import { TraccarBridge } from './traccar.mjs';

let pool, initialized;
export function databasePool(){
  if(!process.env.DATABASE_URL)throw new Error('Vercel database is not connected.');
  return pool??=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3,idleTimeoutMillis:5000,connectionTimeoutMillis:5000,statement_timeout:10000,allowExitOnIdle:true});
}
export async function initializeDatabase(){
  if(initialized)return initialized;
  initialized=(async()=>{
    const client=await databasePool().connect();
    try{
      const store=await PostgresTrackingStore.create({client});
      const email=process.env.WAYPOINT_ADMIN_EMAIL?.trim().toLowerCase();
      const password=process.env.WAYPOINT_ADMIN_PASSWORD;
      if(email&&password){
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<12||password.length>128)throw new Error('Invalid admin bootstrap configuration.');
        const salt=randomBytes(16).toString('hex');
        await store.db.prepare('INSERT INTO admins(email,salt,passwordHash,createdAt) VALUES (?,?,?,?) ON CONFLICT(email) DO NOTHING').run(email,salt,scryptSync(password,salt,64).toString('hex'),Date.now());
      }
    }finally{client.release();}
  })().catch(error=>{initialized=undefined;throw error;});
  return initialized;
}
export class CloudSessions{
  constructor(client){this.client=client;}
  async get(key){const {rows}=await this.client.query('SELECT value FROM cloud_sessions WHERE key=$1 AND (expiresAt IS NULL OR expiresAt>$2)',[key,Date.now()]);return rows[0]?.value;}
  async set(key,value){await this.client.query('INSERT INTO cloud_sessions(key,value,expiresAt) VALUES ($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expiresAt=excluded.expiresAt',[key,JSON.stringify(value),value?.expiresAt??null]);}
  async delete(key){await this.client.query('DELETE FROM cloud_sessions WHERE key=$1',[key]);}
}
export function cloudRateLimit(client){
  return async(key,max,ms=60000)=>{
    const now=Date.now();
    const {rows}=await client.query('INSERT INTO rate_limits(key,count,resetAt) VALUES ($1,1,$2) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.resetAt<=$3 THEN 1 ELSE rate_limits.count+1 END,resetAt=CASE WHEN rate_limits.resetAt<=$3 THEN excluded.resetAt ELSE rate_limits.resetAt END RETURNING count',[String(key),now+ms,now]);
    if(rows[0].count>max)fail(429,'Too many requests. Try again shortly.');
  };
}
export async function authenticateWorkspace(req,store,sessions){
  const cookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('waypoint_session='))?.slice(17);
  const session=cookie&&await sessions.get(hash(cookie));
  if(!session||session.expiresAt<=Date.now())fail(401,'Sign in to your workspace.');
  if(session.role==='customer'){
    if(session.generation!==((await sessions.get(`tenant-generation:${session.tenantId}`))??null))fail(401,'Sign in to your workspace.');
    if(!(await store.customer(session.tenantId)).enabled)fail(403,'Customer access is disabled.');
  }
  return session;
}
export async function cloudBridge(store,client){
  const bridge=new TraccarBridge(store,{url:process.env.GPS_COMMAND_URL||'https://92.4.84.227.sslip.io/gps-command',token:process.env.GPS_GATEWAY_SECRET});
  // Durable history is imported by the outbound worker, not by exposing the
  // receiver's management/history APIs through the public command channel.
  bridge.importHistory=async()=>{};
  const {rows}=await client.query('SELECT * FROM gateway_state WHERE id=1');
  const state=rows[0];
  bridge.state={configured:!!process.env.GPS_GATEWAY_SECRET,connected:!!state?.connected&&Date.now()-Number(state.lastsync)<45000,lastSync:state?Number(state.lastsync):null,error:state?.error||(!state?'Awaiting GPS gateway connection.':null),trackerHost:process.env.GPS_TRACKER_PUBLIC_HOST||'92.4.84.227',gt06Port:5023,teltonikaPort:5027};
  return bridge;
}
export async function readJson(req,max=2*1024*1024){
  let value;
  if(req.body!==undefined)value=typeof req.body==='string'||Buffer.isBuffer(req.body)?JSON.parse(String(req.body)):req.body;
  else{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>max)fail(413,'Request is too large.');chunks.push(chunk);}value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  if(Buffer.byteLength(JSON.stringify(value))>max)fail(413,'Request is too large.');
  if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'Invalid JSON object.');return value;
}
export async function gatewayRequest(req,res,store,client,bridge){
  const url=new URL(req.url,'http://localhost');
  if(!url.pathname.startsWith('/api/gps/gateway/'))return false;
  const secret=process.env.GPS_GATEWAY_SECRET;
  const supplied=req.headers.authorization?.replace(/^Bearer /,'');
  if(!secret||!supplied||hash(secret)!==hash(supplied))fail(401,'Gateway authentication required.');
  if(url.pathname==='/api/gps/gateway/devices'&&req.method==='GET'){
    const devices=await store.db.prepare("SELECT id,name,uniqueId,model,createdAt,cursor FROM devices WHERE model!='Mobile' ORDER BY createdAt").all();
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({devices}));return true;
  }
  if(url.pathname==='/api/gps/gateway/sync'&&req.method==='POST'){
    const data=await readJson(req);
    if(typeof data.connected!=='boolean'||!Array.isArray(data.devices)||data.devices.length>500)fail(400,'Invalid gateway report.');
    for(const incoming of data.devices){
      const device=await store.raw(incoming.id);
      if(device.model==='Mobile'||device.uniqueId!==incoming.uniqueId)fail(409,'Tracker identity mismatch.');
      if(!Number.isSafeInteger(incoming.traccarId)||incoming.traccarId<=0||!Array.isArray(incoming.positions)||incoming.positions.length>1000)fail(400,'Invalid tracker report.');
      await store.db.transaction(async()=>{
        await store.db.prepare('UPDATE devices SET traccarId=?,bridgeStatus=? WHERE id=?').run(incoming.traccarId,String(incoming.status||'unknown').slice(0,100),device.id);
        const lastSeen=Date.parse(incoming.lastUpdate);
        if(Number.isFinite(lastSeen)&&lastSeen<=Date.now()+60000)await store.seen(device.id,lastSeen);
        for(const position of incoming.positions.sort((a,b)=>Date.parse(a.fixTime)-Date.parse(b.fixTime))){
          if(position.deviceId!==incoming.traccarId)fail(409,'Position belongs to another tracker.');
          if(Date.parse(position.fixTime)>=device.createdAt-60000)await bridge.ingest(device.id,position);
        }
        if(Number.isFinite(incoming.cursor)&&incoming.cursor<=Date.now()+60000&&incoming.cursor>=device.createdAt-60000)await store.db.prepare('UPDATE devices SET cursor=GREATEST(COALESCE(cursor,0),?) WHERE id=?').run(incoming.cursor,device.id);
      });
    }
    await client.query('INSERT INTO gateway_state(id,connected,lastSync,error) VALUES (1,$1,$2,$3) ON CONFLICT(id) DO UPDATE SET connected=excluded.connected,lastSync=excluded.lastSync,error=excluded.error',[data.connected,Date.now(),typeof data.error==='string'?data.error.slice(0,300):null]);
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"ok":true}');return true;
  }
  fail(404,'Gateway endpoint not found.');
}
