import {fail, text, distance} from './tracking-store.mjs';

export const relayProtocols={GT06:'gt06',GT06N:'gt06',FMB920:'teltonika',FMB125:'teltonika',FMC920:'teltonika',FMC130:'teltonika'};

// Engine lock through a relay on the starter or on the fuel-pump / ignition line. A fuel or
// ignition cut stops a running engine, so a lock is only ever sent to a parked vehicle: online,
// engine reported off for at least a minute, and no movement in the last three minutes. Unlock
// may be sent at any time. Commands are never queued, retried or reported as physically confirmed.
export const RELAY_WIRING={starter:'Starter wire (blocks the next start)',fuel:'Fuel pump / ignition wire (cuts the engine)'};
const ONLINE_MS=300000,STILL_MS=180000,OFF_MS=60000;
const plate=v=>String(v||'').replace(/[^0-9a-z]/gi,'').toUpperCase();

export class RelayService {
  constructor(store,bridge,{enabled=false}={}){
    this.store=store;this.bridge=bridge;this.enabled=enabled;this.busy=new Set();
    this.ready=Promise.resolve().then(()=>store.db.exec(`CREATE TABLE IF NOT EXISTS relay_installations(deviceId TEXT PRIMARY KEY REFERENCES devices(id),verifiedAt BIGINT NOT NULL,installer TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relay_commands(id TEXT PRIMARY KEY,deviceId TEXT NOT NULL REFERENCES devices(id),action TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,createdAt BIGINT NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL);`))
      // Installations recorded before the wiring choice were starter-only.
      .then(async()=>{try{await store.db.exec("ALTER TABLE relay_installations ADD COLUMN wiring TEXT NOT NULL DEFAULT 'starter'");}catch{/* column already there */}});
    // The handler awaits ready; also observe startup failures before the first request.
    this.ready.catch(()=>{});
  }
  async installation(id){await this.ready;return (await this.store.db.prepare('SELECT * FROM relay_installations WHERE deviceId=?').get(id))||null;}
  async history(id){await this.ready;return await this.store.db.prepare('SELECT * FROM relay_commands WHERE deviceId=? ORDER BY createdAt DESC,id DESC LIMIT 20').all(id);}
  async configure(id,input){
    await this.ready;
    if(!relayProtocols[(await this.store.raw(id)).model])fail(400,'This model has no relay profile.');
    if(this.busy.has(id))fail(409,'Wait for the current relay operation to finish.');
    if(input.enabled===false){await this.store.db.prepare('DELETE FROM relay_installations WHERE deviceId=?').run(id);return {configured:false};}
    const wiring=input.wiring??(input.starterOnly===true?'starter':null);
    if(!RELAY_WIRING[wiring])fail(400,'Choose where the relay is wired: starter or fuel pump / ignition.');
    if(input.polarityVerified!==true)fail(400,'Installer must test the relay once on the parked vehicle (lock and unlock) before it is switched on.');
    if(wiring==='fuel'&&input.parkedOnly!==true)fail(400,'Confirm that a fuel / ignition relay stops a running engine and may only be locked when the vehicle is parked.');
    const installer=text(input.installer,'Installer / verification reference',200);
    await this.store.db.prepare('INSERT INTO relay_installations (deviceId,verifiedAt,installer,wiring) VALUES (?,?,?,?) ON CONFLICT (deviceId) DO UPDATE SET verifiedAt=excluded.verifiedAt,installer=excluded.installer,wiring=excluded.wiring').run(id,this.store.now(),installer,wiring);
    return {configured:true,wiring};
  }
  async safety(id,action){
    await this.ready;
    const d=await this.store.device(id),now=this.store.now(),db=this.store.db;
    if(!await this.installation(id))fail(409,'The relay in this vehicle has not been fitted and tested yet.');
    if(!d.online||!d.lastSeen||d.lastSeen>now+60000||now-d.lastSeen>ONLINE_MS)fail(409,'The tracker is offline. The command can only go while it is connected.');
    if(action==='inhibit'){
      const fix=await db.prepare('SELECT * FROM positions WHERE deviceId=? AND valid=1 ORDER BY recordedAt DESC,id DESC LIMIT 1').get(id);
      if(!fix)fail(409,'This vehicle has no GPS location yet, so it cannot be locked.');
      const moving=await db.prepare('SELECT id FROM positions WHERE deviceId=? AND receivedAt>=? AND speed>1 LIMIT 1').get(id,now-STILL_MS);
      if(moving||Number(fix.speed)>1)fail(409,'The vehicle is moving. The engine can only be locked once it is parked with the engine off.');
      const ign=await db.prepare('SELECT ignition,receivedAt FROM positions WHERE deviceId=? AND ignition IS NOT NULL ORDER BY receivedAt DESC,id DESC LIMIT 1').get(id);
      if(!ign||Number(ign.ignition)!==0||now-Number(ign.receivedAt)>ONLINE_MS)fail(409,'The engine is on (or its state is not known). Lock only works when the vehicle is parked with the engine off.');
      const lastOn=await db.prepare('SELECT MAX(receivedAt) AS t FROM positions WHERE deviceId=? AND ignition=1').get(id);
      if(lastOn?.t!=null&&now-Number(lastOn.t)<OFF_MS)fail(409,'The engine was switched off less than a minute ago. Try again in a minute.');
      const recent=await db.prepare('SELECT latitude,longitude,accuracy FROM positions WHERE deviceId=? AND valid=1 AND recordedAt>=?').all(id,now-STILL_MS);
      if(recent.some(r=>(r.accuracy==null||Number(r.accuracy)<=50)&&distance(r,fix)>30))fail(409,'The vehicle moved in the last few minutes. Lock it once it is parked.');
    }
    return d;
  }
  async status(id){
    await this.ready;
    const d=await this.store.raw(id);let supported=false,error=null;
    if(this.enabled&&relayProtocols[d.model]&&d.traccarId){try{supported=await this.bridge.relaySupported(d,relayProtocols[d.model]);}catch(e){error=e.message;}}
    return {enabled:this.enabled,modelSupported:!!relayProtocols[d.model],supported,installation:await this.installation(id),history:await this.history(id),error};
  }
  // What an owner sees: whether the lock can be used and the last command, without gateway details.
  async customerStatus(id){
    await this.ready;
    const d=await this.store.raw(id),installation=await this.installation(id),history=await this.history(id);
    const last=history.find(c=>c.status==='sent-unverified')||null;
    return {available:this.enabled&&!!relayProtocols[d.model]&&!!installation,wiring:installation?.wiring||null,
      locked:last?last.action==='inhibit':null,last:last&&{action:last.action,createdAt:Number(last.createdAt)},
      history:history.slice(0,5).map(c=>({action:c.action,status:c.status,createdAt:Number(c.createdAt),detail:c.status==='sent-unverified'?'':c.detail}))};
  }
  async execute(id,input,actor='workspace-admin'){
    await this.ready;
    if(!this.enabled)fail(403,'Live relay control is disabled on this server.');
    const raw=await this.store.raw(id);
    if(!relayProtocols[raw.model])fail(400,'Unsupported relay model.');
    if(!['inhibit','restore'].includes(input.action))fail(400,'Choose inhibit or restore.');
    const requestId=text(input.requestId,'Request ID',80),reason=text(input.reason,'Reason',300);
    if(input.confirmation!==raw.uniqueId&&plate(input.confirmation)!==plate(raw.name))fail(400,'Type the vehicle number exactly to confirm.');
    const existing=await this.store.db.prepare('SELECT * FROM relay_commands WHERE id=?').get(requestId);
    if(existing){if(existing.deviceId!==id||existing.action!==input.action||existing.reason!==reason)fail(409,'Request ID belongs to another operation.');return existing;}
    if(this.busy.has(id))fail(409,'A relay operation is already in progress.');
    this.busy.add(id);
    try{
      if((await this.history(id)).some(c=>this.store.now()-c.createdAt<60000))fail(429,'Wait 60 seconds between relay operations.');
      await this.safety(id,input.action);
      await this.store.db.prepare('INSERT INTO relay_commands VALUES (?,?,?,?,?,?,?,?)').run(requestId,id,input.action,reason,actor,this.store.now(),'checking','Checking gateway and safety conditions.');
      try{
        if(!await this.bridge.relaySupported(raw,relayProtocols[raw.model]))fail(409,'Gateway does not advertise both relay commands for the expected protocol.');
        // Recheck after network I/O so a moving vehicle or revoked installation fails closed.
        await this.safety(id,input.action);
        const result=await this.bridge.sendRelay(raw,input.action);
        await this.store.db.prepare('UPDATE relay_commands SET status=?,detail=? WHERE id=?').run('sent-unverified',result.detail,requestId);
        await this.store.alert(id,'relay',input.action==='inhibit'?'Engine lock command sent to the tracker.':'Engine unlock command sent to the tracker.');
      }catch(e){
        await this.store.db.prepare('UPDATE relay_commands SET status=?,detail=? WHERE id=?').run(e.status?'blocked':'unknown',e.status?e.message:'Delivery or relay state is uncertain. Inspect gateway/device before any new request.',requestId);
      }
      return await this.store.db.prepare('SELECT * FROM relay_commands WHERE id=?').get(requestId);
    }finally{this.busy.delete(id);}
  }
}
