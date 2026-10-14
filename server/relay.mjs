import {fail, text, distance} from './tracking-store.mjs';

export const relayProtocols={GT06:'gt06',GT06N:'gt06',FMB920:'teltonika',FMB125:'teltonika',FMC920:'teltonika',FMC130:'teltonika'};

export class RelayService {
  constructor(store,bridge,{enabled=false}={}){
    this.store=store;this.bridge=bridge;this.enabled=enabled;this.busy=new Set();
    this.ready=Promise.resolve().then(()=>store.db.exec(`CREATE TABLE IF NOT EXISTS relay_installations(deviceId TEXT PRIMARY KEY REFERENCES devices(id),verifiedAt BIGINT NOT NULL,installer TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relay_commands(id TEXT PRIMARY KEY,deviceId TEXT NOT NULL REFERENCES devices(id),action TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,createdAt BIGINT NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL);`));
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
    if(input.starterOnly!==true||input.polarityVerified!==true)fail(400,'Installer must verify starter-only wiring and command polarity. Fuel/ignition cut-off is not supported.');
    const installer=text(input.installer,'Installer / verification reference',200);
    await this.store.db.prepare('INSERT INTO relay_installations (deviceId,verifiedAt,installer) VALUES (?,?,?) ON CONFLICT (deviceId) DO UPDATE SET verifiedAt=excluded.verifiedAt,installer=excluded.installer').run(id,this.store.now(),installer);
    return {configured:true};
  }
  async safety(id,action){
    await this.ready;
    const d=await this.store.device(id),p=d.position,now=this.store.now();
    if(!await this.installation(id))fail(409,'Starter relay installation has not been verified.');
    if(!d.online||d.lastSeen>now||now-d.lastSeen>30000)fail(409,'A heartbeat within 30 seconds is required.');
    if(!p||p.recordedAt>now||now-p.recordedAt>30000)fail(409,'A GPS fix within 30 seconds is required.');
    if(action==='inhibit'){
      const fixes=await this.store.db.prepare('SELECT * FROM positions WHERE deviceId=? AND recordedAt>=? ORDER BY recordedAt,id').all(id,now-60000);
      if(fixes.length<2||p.recordedAt-fixes[0].recordedAt<30000)fail(409,'At least 30 seconds of parked telemetry is required.');
      if(fixes.some(f=>f.ignition!==0||f.speed>1||f.accuracy===null||f.accuracy<=0||f.accuracy>50||distance(f,p)>15))fail(409,'Vehicle must be stationary with ignition off and reliable GPS throughout the last minute.');
    }
    return d;
  }
  async status(id){
    await this.ready;
    const d=await this.store.raw(id);let supported=false,error=null;
    if(this.enabled&&relayProtocols[d.model]&&d.traccarId){try{supported=await this.bridge.relaySupported(d,relayProtocols[d.model]);}catch(e){error=e.message;}}
    return {enabled:this.enabled,modelSupported:!!relayProtocols[d.model],supported,installation:await this.installation(id),history:await this.history(id),error};
  }
  async execute(id,input,actor='workspace-admin'){
    await this.ready;
    if(!this.enabled)fail(403,'Live relay control is disabled on this server.');
    const raw=await this.store.raw(id);
    if(!relayProtocols[raw.model])fail(400,'Unsupported relay model.');
    if(!['inhibit','restore'].includes(input.action))fail(400,'Choose inhibit or restore.');
    const requestId=text(input.requestId,'Request ID',80),reason=text(input.reason,'Reason',300);
    if(input.confirmation!==raw.uniqueId)fail(400,'Enter the exact device IMEI to confirm.');
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
      }catch(e){
        await this.store.db.prepare('UPDATE relay_commands SET status=?,detail=? WHERE id=?').run(e.status?'blocked':'unknown',e.status?e.message:'Delivery or relay state is uncertain. Inspect gateway/device before any new request.',requestId);
      }
      return await this.store.db.prepare('SELECT * FROM relay_commands WHERE id=?').get(requestId);
    }finally{this.busy.delete(id);}
  }
}
