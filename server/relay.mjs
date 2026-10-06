import {fail, text, distance} from './tracking-store.mjs';

export const relayProtocols={GT06:'gt06',GT06N:'gt06',FMB920:'teltonika',FMB125:'teltonika',FMC920:'teltonika',FMC130:'teltonika'};

export class RelayService {
  constructor(store,bridge,{enabled=false}={}){
    this.store=store;this.bridge=bridge;this.enabled=enabled;this.busy=new Set();
    store.db.exec(`CREATE TABLE IF NOT EXISTS relay_installations(deviceId TEXT PRIMARY KEY REFERENCES devices(id),verifiedAt INTEGER NOT NULL,installer TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relay_commands(id TEXT PRIMARY KEY,deviceId TEXT NOT NULL REFERENCES devices(id),action TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,createdAt INTEGER NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL);`);
  }
  installation(id){return this.store.db.prepare('SELECT * FROM relay_installations WHERE deviceId=?').get(id)||null;}
  history(id){return this.store.db.prepare('SELECT * FROM relay_commands WHERE deviceId=? ORDER BY createdAt DESC,rowid DESC LIMIT 20').all(id);}
  configure(id,input){
    if(!relayProtocols[this.store.raw(id).model])fail(400,'This model has no relay profile.');
    if(this.busy.has(id))fail(409,'Wait for the current relay operation to finish.');
    if(input.enabled===false){this.store.db.prepare('DELETE FROM relay_installations WHERE deviceId=?').run(id);return {configured:false};}
    if(input.starterOnly!==true||input.polarityVerified!==true)fail(400,'Installer must verify starter-only wiring and command polarity. Fuel/ignition cut-off is not supported.');
    const installer=text(input.installer,'Installer / verification reference',200);
    this.store.db.prepare('INSERT OR REPLACE INTO relay_installations VALUES (?,?,?)').run(id,this.store.now(),installer);
    return {configured:true};
  }
  safety(id,action){
    const d=this.store.device(id),p=d.position,now=this.store.now();
    if(!this.installation(id))fail(409,'Starter relay installation has not been verified.');
    if(!d.online||d.lastSeen>now||now-d.lastSeen>30000)fail(409,'A heartbeat within 30 seconds is required.');
    if(!p||p.recordedAt>now||now-p.recordedAt>30000)fail(409,'A GPS fix within 30 seconds is required.');
    if(action==='inhibit'){
      const fixes=this.store.db.prepare('SELECT * FROM positions WHERE deviceId=? AND recordedAt>=? ORDER BY recordedAt,id').all(id,now-60000);
      if(fixes.length<2||p.recordedAt-fixes[0].recordedAt<30000)fail(409,'At least 30 seconds of parked telemetry is required.');
      if(fixes.some(f=>f.ignition!==0||f.speed>1||f.accuracy===null||f.accuracy<=0||f.accuracy>50||distance(f,p)>15))fail(409,'Vehicle must be stationary with ignition off and reliable GPS throughout the last minute.');
    }
    return d;
  }
  async status(id){
    const d=this.store.raw(id);let supported=false,error=null;
    if(this.enabled&&relayProtocols[d.model]&&d.traccarId){try{supported=await this.bridge.relaySupported(d,relayProtocols[d.model]);}catch(e){error=e.message;}}
    return {enabled:this.enabled,modelSupported:!!relayProtocols[d.model],supported,installation:this.installation(id),history:this.history(id),error};
  }
  async execute(id,input,actor='workspace-admin'){
    if(!this.enabled)fail(403,'Live relay control is disabled on this server.');
    const raw=this.store.raw(id);
    if(!relayProtocols[raw.model])fail(400,'Unsupported relay model.');
    if(!['inhibit','restore'].includes(input.action))fail(400,'Choose inhibit or restore.');
    const requestId=text(input.requestId,'Request ID',80),reason=text(input.reason,'Reason',300);
    if(input.confirmation!==raw.uniqueId)fail(400,'Enter the exact device IMEI to confirm.');
    const existing=this.store.db.prepare('SELECT * FROM relay_commands WHERE id=?').get(requestId);
    if(existing){if(existing.deviceId!==id||existing.action!==input.action||existing.reason!==reason)fail(409,'Request ID belongs to another operation.');return existing;}
    if(this.busy.has(id))fail(409,'A relay operation is already in progress.');
    if(this.history(id).some(c=>this.store.now()-c.createdAt<60000))fail(429,'Wait 60 seconds between relay operations.');
    this.busy.add(id);
    try{
      this.safety(id,input.action);
      this.store.db.prepare('INSERT INTO relay_commands VALUES (?,?,?,?,?,?,?,?)').run(requestId,id,input.action,reason,actor,this.store.now(),'checking','Checking gateway and safety conditions.');
      try{
        if(!await this.bridge.relaySupported(raw,relayProtocols[raw.model]))fail(409,'Gateway does not advertise both relay commands for the expected protocol.');
        // Recheck after network I/O so a moving vehicle or revoked installation fails closed.
        this.safety(id,input.action);
        const result=await this.bridge.sendRelay(raw,input.action);
        this.store.db.prepare('UPDATE relay_commands SET status=?,detail=? WHERE id=?').run('sent-unverified',result.detail,requestId);
      }catch(e){
        this.store.db.prepare('UPDATE relay_commands SET status=?,detail=? WHERE id=?').run(e.status?'blocked':'unknown',e.status?e.message:'Delivery or relay state is uncertain. Inspect gateway/device before any new request.',requestId);
      }
      return this.store.db.prepare('SELECT * FROM relay_commands WHERE id=?').get(requestId);
    }finally{this.busy.delete(id);}
  }
}
