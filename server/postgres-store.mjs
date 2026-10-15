import { readFile } from 'node:fs/promises';
import { PgAdapter } from './pg-adapter.mjs';
import { cleanExtra, alarmAlerts, hardBrake, overspeed, REPEAT, SPEED_REPEAT, shareHours, SHARE_STOPPED, shareSilent } from './extra.mjs';
import { cleanSetup } from './provision.mjs';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export function text(value, field, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, `${field} is required (max ${max} characters).`);
  return value.trim();
}
export function number(value, field, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(400, `${field} must be between ${min} and ${max}.`);
  return value;
}
export function distance(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin((b.latitude-a.latitude)*rad/2)**2 + Math.cos(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.sin((b.longitude-a.longitude)*rad/2)**2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export class PostgresTrackingStore {
  constructor(client, { now = () => Date.now() } = {}) {
    this.now = now;
    this.db = new PgAdapter(client);
  }
  static async create({ client, now } = {}) {
    const store = new PostgresTrackingStore(client, { now });
    await store.db.transaction(async () => {
      await store.db.exec(await readFile(new URL('./postgres-schema.sql', import.meta.url), 'utf8'));
    });
    return store;
  }
  async close() { await this.db.close(); }
  async customers(){return (await this.db.prepare('SELECT c.id,c.name,c.email,c.createdAt,c.enabled,(SELECT COUNT(*) FROM devices d WHERE d.tenantId=c.id)::int AS devices FROM customers c ORDER BY c.createdAt').all());}
  async admins(){return (await this.db.prepare('SELECT email,createdAt,enabled FROM admins ORDER BY createdAt').all());}
  async createAdmin(email){
    email=text(email,'Admin email',254).toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'Enter a valid admin email.');
    const password=token(),salt=randomBytes(16).toString('hex');
    try{(await this.db.prepare('INSERT INTO admins(email,salt,passwordHash,createdAt) VALUES (?,?,?,?)').run(email,salt,scryptSync(password,salt,64).toString('hex'),this.now()));}
    catch(e){if(e.code==='23505')fail(409,'An admin with this email already exists.');throw e;}
    return {email,password};
  }
  async adminLogin(email,password){
    const row=typeof email==='string'&&(await this.db.prepare('SELECT * FROM admins WHERE email=? AND enabled=1').get(email.trim().toLowerCase()));
    if(typeof password!=='string'||!row||!timingSafeEqual(Buffer.from(row.passwordHash,'hex'),scryptSync(password,row.salt,64)))fail(401,'Incorrect admin credentials.');
    return {email:row.email};
  }
  async customer(id){return (await this.db.prepare('SELECT id,name,email,createdAt,enabled FROM customers WHERE id=?').get(id))||fail(404,'Customer not found.');}
  // Map landmarks per tile, shared by every customer (public place data, no tenant).
  async landmarkTile(key){const row=(await this.db.prepare('SELECT value FROM landmark_tiles WHERE key=?').get(key));return row?JSON.parse(row.value):null;}
  async saveLandmarkTile(key,value){(await this.db.prepare('INSERT INTO landmark_tiles(key,value,fetchedAt) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,fetchedAt=excluded.fetchedAt').run(key,JSON.stringify(value),value.fetchedAt));}
  async workspaceData(tenantId,key){
    const row=(await this.db.prepare('SELECT value FROM workspace_data WHERE tenantId=? AND key=?').get(tenantId,key));
    return row?JSON.parse(row.value):null;
  }
  async saveWorkspaceData(tenantId,key,value){
    if(!['documents','bills','preferences','ack'].includes(key))fail(404,'Workspace data not found.');
    if(key==='documents'||key==='bills'){
      if(!Array.isArray(value)||value.length>100)fail(400,'Store up to 100 records.');
    }else if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'Expected an object.');
    const data=JSON.stringify(value);
    if(Buffer.byteLength(data)>25*1024*1024)fail(413,'Workspace data is too large.');
    (await this.db.prepare('INSERT INTO workspace_data(tenantId,key,value,updatedAt) VALUES (?,?,?,?) ON CONFLICT(tenantId,key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt')
      .run(tenantId,key,data,this.now()));
    return {ok:true};
  }
  async createCustomer(body){
    const name=text(body.name,'Customer name',100);
    const email=text(body.email,'Customer email',254).toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'Enter a valid customer email.');
    const id=randomUUID(),secret=token(),salt=randomBytes(16).toString('hex');
    try{(await this.db.prepare('INSERT INTO customers(id,name,email,salt,passwordHash,createdAt) VALUES (?,?,?,?,?,?)').run(id,name,email,salt,scryptSync(secret,salt,64).toString('hex'),this.now()));}
    catch(e){if(e.code === '23505')fail(409,'Customer email is already registered.');throw e;}
    return {customer:(await this.customer(id)),password:secret};
  }
  async registerCustomer(body){
    const name=text(body.name,'Customer name',100);
    const email=text(body.email,'Customer email',254).toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'Enter a valid customer email.');
    const password=body.password;
    if(typeof password!=='string'||password.length<12||password.length>128)fail(400,'Password must be 12-128 characters.');
    const id=randomUUID(),salt=randomBytes(16).toString('hex');
    try{(await this.db.prepare('INSERT INTO customers(id,name,email,salt,passwordHash,createdAt) VALUES (?,?,?,?,?,?)').run(id,name,email,salt,scryptSync(password,salt,64).toString('hex'),this.now()));}
    catch(e){if(e.code === '23505')fail(409,'Customer email is already registered.');throw e;}
    return (await this.customer(id));
  }
  async customerLogin(email,password){
    const row=typeof email==='string'&&(await this.db.prepare('SELECT * FROM customers WHERE email=? AND enabled=1').get(email.trim().toLowerCase()));
    if(typeof password!=='string'||!row||!timingSafeEqual(Buffer.from(row.passwordHash,'hex'),scryptSync(password,row.salt,64)))fail(401,'Incorrect customer credentials.');
    return {id:row.id,name:row.name,email:row.email};
  }
  // Signed-in users change their own password; the current one is always re-checked.
  async changePassword(role,email,current,next){
    if(typeof next!=='string'||next.length<12||next.length>128)fail(400,'New password must be 12-128 characters.');
    if(next===current)fail(400,'New password must be different from the current one.');
    let account;try{account=role==='admin'?(await this.adminLogin(email,current)):(await this.customerLogin(email,current));}catch(e){fail(e.status===401?400:e.status||500,e.status===401?'Current password is incorrect.':e.message);}
    const salt=randomBytes(16).toString('hex');
    (await this.db.prepare(`UPDATE ${role==='admin'?'admins':'customers'} SET salt=?,passwordHash=? WHERE email=?`).run(salt,scryptSync(next,salt,64).toString('hex'),account.email));
    return account;
  }
  // Recovery with the server maintenance key: give the admin a temporary password to change after login.
  async resetAdminPassword(email){
    const admins=(await this.db.prepare('SELECT email FROM admins WHERE enabled=1 ORDER BY createdAt').all());
    const target=email==null?(admins.length===1?admins[0].email:fail(409,'Specify which admin email to reset.')):String(email).trim().toLowerCase();
    if(!admins.some(a=>a.email===target))fail(404,'Admin not found.');
    const password=randomBytes(12).toString('base64url'),salt=randomBytes(16).toString('hex');
    (await this.db.prepare('UPDATE admins SET salt=?,passwordHash=? WHERE email=?').run(salt,scryptSync(password,salt,64).toString('hex'),target));
    return {email:target,password};
  }
  async resetCustomer(id){
    (await this.customer(id));const password=token(),salt=randomBytes(16).toString('hex');
    (await this.db.prepare('UPDATE customers SET salt=?,passwordHash=? WHERE id=?').run(salt,scryptSync(password,salt,64).toString('hex'),id));
    return {password};
  }
  async setCustomerEnabled(id,enabled){(await this.customer(id));(await this.db.prepare('UPDATE customers SET enabled=? WHERE id=?').run(Number(enabled),id));return (await this.customer(id));}
  async raw(id) { return (await this.db.prepare('SELECT * FROM devices WHERE id=?').get(id)) || fail(404, 'Device not found.'); }
  async createDevice(body,tenantId='owner') {
    const name = text(body.name, 'Vehicle name');
    const uniqueId = text(body.uniqueId || (body.model==='Mobile' ? `mobile-${randomUUID().slice(0,8)}` : ''), 'Device identifier', 32);
    if (!['GT06','GT06N','PT06','FMB920','FMB125','FMC920','FMC130','Mobile'].includes(body.model)) fail(400, 'Choose a supported tracker model.');
    if (body.model !== 'Mobile' && !/^\d{15}$/.test(uniqueId)) fail(400, 'Hardware trackers require a 15-digit IMEI.');
    if (body.model === 'Mobile' && !/^[a-zA-Z0-9_-]{3,32}$/.test(uniqueId)) fail(400, 'Mobile identifier must be 3-32 letters, digits, underscores or hyphens.');
    const driver = typeof body.driver === 'string' ? body.driver.trim().slice(0, 100) : '';
    const offlineSeconds = number(body.offlineSeconds ?? 180, 'Offline threshold', 30, 86400);
    const speedLimit = number(body.speedLimit ?? 80, 'Speed limit', 1, 250);
    const id = randomUUID(), secret = body.model === 'Mobile' ? token() : null;
    try {
      (await this.db.prepare('INSERT INTO devices (id,name,uniqueId,model,driver,tokenHash,createdAt,offlineSeconds,speedLimit,tenantId) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id,name,uniqueId,body.model,driver,secret ? hash(secret) : null,this.now(),offlineSeconds,speedLimit,tenantId));
    } catch (e) { if (e.code === '23505') fail(409, 'This device identifier is already registered.'); throw e; }
    return { device: (await this.device(id)), token: secret };
  }
  // Admin edits a vehicle or moves it to another customer ('owner' = unassigned).
  async updateDevice(id,body) {
    const device=(await this.raw(id));
    const name=body.name===undefined?device.name:text(body.name,'Vehicle name');
    const driver=body.driver===undefined?device.driver:typeof body.driver==='string'?body.driver.trim().slice(0,100):'';
    const offlineSeconds=body.offlineSeconds===undefined?device.offlineSeconds:number(body.offlineSeconds,'Offline threshold',30,86400);
    const speedLimit=body.speedLimit===undefined?device.speedLimit:number(body.speedLimit,'Speed limit',1,250);
    let tenantId=device.tenantId;
    if(body.customerId!==undefined){tenantId=body.customerId?String(body.customerId):'owner';if(tenantId!=='owner')(await this.customer(tenantId));}
    (await this.db.prepare('UPDATE devices SET name=?,driver=?,offlineSeconds=?,speedLimit=?,tenantId=? WHERE id=?').run(name,driver,offlineSeconds,speedLimit,tenantId,id));
    if(body.speedAlert!==undefined)(await this.db.prepare('UPDATE devices SET speedAlert=? WHERE id=?').run(body.speedAlert?1:0,id));
    // A vehicle changing hands must not keep the previous owner's geofence state or driver links.
    if(tenantId!==device.tenantId){(await this.db.prepare('DELETE FROM fence_state WHERE deviceId=?').run(id));(await this.revokeDriverLinks(id));}
    return (await this.device(id));
  }
  // Removes the vehicle and everything recorded for it.
  async deleteDevice(id) {
    (await this.raw(id));(await this.db.prepare('DELETE FROM provision_steps WHERE deviceId=?').run(id));
    await this.db.transaction(async()=>{
      (await this.db.prepare('DELETE FROM driver_sessions WHERE linkHash IN (SELECT hash FROM driver_links WHERE deviceId=?)').run(id));
      for (const table of ['driver_links','positions','fence_state','alerts','commands','relay_installations','relay_commands']) (await this.db.prepare(`DELETE FROM ${table} WHERE deviceId=?`).run(id));
      (await this.db.prepare('DELETE FROM devices WHERE id=?').run(id));
    });
  }
  // SIM and APN details given when the device is onboarded (admin only; the APN password never leaves the server).
  async setDeviceSetup(id,input){
    (await this.raw(id));const set=cleanSetup(input),keys=Object.keys(set);
    if(keys.length)(await this.db.prepare(`UPDATE devices SET ${keys.map(k=>`${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k=>set[k]),id));
    return (await this.raw(id));
  }
  async provisionReplace(id,steps){
    (await this.raw(id));
    await this.db.transaction(async()=>{
      (await this.db.prepare('DELETE FROM provision_steps WHERE deviceId=?').run(id));
      for(const s of steps)(await this.db.prepare("INSERT INTO provision_steps(id,deviceId,seq,command,label,status) VALUES (?,?,?,?,?,'pending')").run(randomUUID(),id,s.seq,s.command,s.label));
    });
  }
  // Rows decoded with a time-zone offset applied twice sit a fixed amount behind their reception time.
  async shiftClock(id,minutes,tolerance=10){(await this.raw(id));const m=minutes*60000,t=tolerance*60000;return Number((await this.db.prepare('UPDATE positions SET recordedAt=recordedAt+? WHERE deviceId=? AND receivedAt-recordedAt BETWEEN ? AND ?').run(m,id,m-t,m+t)).changes);}
  async provisionSteps(id){return (await this.db.prepare('SELECT * FROM provision_steps WHERE deviceId=? ORDER BY seq').all(id));}
  async pendingProvisioning(){return (await this.db.prepare("SELECT DISTINCT deviceId FROM provision_steps WHERE status IN ('pending','sent')").all()).map(r=>r.deviceId);}
  async provisionUpdate(stepId,patch){
    const keys=Object.keys(patch).filter(k=>['status','attempts','commandId','sentAt','doneAt','reply'].includes(k));
    if(keys.length)(await this.db.prepare(`UPDATE provision_steps SET ${keys.map(k=>`${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k=>patch[k]),stepId));
  }
  async rotateToken(id) {
    if ((await this.raw(id)).model !== 'Mobile') fail(400, 'Only mobile devices use a sender token.');
    const secret = token();
    (await this.db.prepare('UPDATE devices SET tokenHash=? WHERE id=?').run(hash(secret), id));
    return secret;
  }
  async authenticateDevice(secret) {
    if (typeof secret !== 'string') fail(401, 'Sender token required.');
    return (await this.db.prepare('SELECT * FROM devices WHERE tokenHash=?').get(hash(secret))) || fail(401, 'Invalid sender token.');
  }
  async getDriverLink(id) {
    (await this.raw(id));
    const link=(await this.db.prepare('SELECT code,expiresAt FROM driver_links WHERE deviceId=? AND revoked=0 AND (expiresAt=0 OR expiresAt>?) ORDER BY rowid DESC LIMIT 1').get(id,this.now()));
    return link?{code:link.code,expiresAt:Number(link.expiresAt)||null,active:true}:null;
  }
  async createDriverLink(id,{regenerate=false,hours}={}) {
    if((await this.raw(id)).model!=='Mobile')fail(400,'Driver links are for mobile devices.');
    const existing=(await this.getDriverLink(id));
    // Changing how long it lasts keeps the same link, so the driver does not need a new one.
    if(existing&&!regenerate){if(hours===undefined)return existing;const until=this.now()+shareHours(hours)*3600000;(await this.db.prepare('UPDATE driver_links SET expiresAt=?,notified=0 WHERE code=? AND deviceId=?').run(until,existing.code,id));return {...existing,expiresAt:until};}
    const code=token(),expiresAt=this.now()+shareHours(hours)*3600000;
    
    try{
      (await this.revokeDriverLinks(id));
      (await this.db.prepare('UPDATE devices SET tokenHash=NULL WHERE id=?').run(id));
      (await this.db.prepare('INSERT INTO driver_links(hash,deviceId,expiresAt,code) VALUES (?,?,?,?)').run(hash(code),id,expiresAt,code));
      return {code,expiresAt};
    }catch(e){throw e;}
  }
  async revokeDriverLinks(id) {(await this.raw(id));(await this.db.prepare('UPDATE driver_links SET revoked=1 WHERE deviceId=?').run(id));}
  // The driver's page says why sharing ended; the customer hears it at once instead of after the offline wait.
  async sharingStopped(id,reason) {
    const message=SHARE_STOPPED[reason]||SHARE_STOPPED.stopped;
    if((await this.db.prepare("SELECT id FROM alerts WHERE deviceId=? AND type='share_stopped' AND createdAt>?").get(id,this.now()-120000)))return;
    (await this.alert(id,'share_stopped',message));(await this.db.prepare('UPDATE devices SET offlineAlert=1 WHERE id=?').run(id));
  }
  async joinDriver(code) {
    const link=typeof code==='string'&&(await this.db.prepare('SELECT * FROM driver_links WHERE hash=? AND revoked=0 AND (expiresAt=0 OR expiresAt>?)').get(hash(code),this.now()));
    if(!link)fail(401,'This driver link has expired or been replaced. Ask your fleet admin for a new link.');
    if(!link.code)(await this.db.prepare('UPDATE driver_links SET code=? WHERE hash=?').run(code,link.hash));
    // The phone stays signed in for as long as the link lasts (12 h for links made before durations).
    const secret=token(),expiresAt=Number(link.expiresAt)||this.now()+12*3600000;
    (await this.db.prepare('INSERT INTO driver_sessions VALUES (?,?,?)').run(hash(secret),link.hash,expiresAt));
    return {secret,expiresAt,device:(await this.raw(link.deviceId))};
  }
  async driverSession(secret) {
    const session=typeof secret==='string'&&(await this.db.prepare('SELECT l.deviceId,s.expiresAt FROM driver_sessions s JOIN driver_links l ON l.hash=s.linkHash WHERE s.hash=? AND s.expiresAt>? AND (l.expiresAt=0 OR l.expiresAt>?) AND l.revoked=0').get(hash(secret),this.now(),this.now()));
    if(!session)fail(401,'Open the driver link shared by your fleet admin.');
    return {...session,device:(await this.raw(session.deviceId))};
  }
  async device(id) {
    const { tokenHash, apnPass, ...device } = (await this.raw(id));
    const position = (await this.db.prepare('SELECT * FROM positions WHERE deviceId=? ORDER BY recordedAt DESC,id DESC LIMIT 1').get(id)) || null;
    const online = device.lastSeen !== null && this.now()-device.lastSeen < device.offlineSeconds*1000;
    const fresh = position && position.valid !== 0 && this.now()-position.recordedAt < device.offlineSeconds*1000;
    // Hardware trackers (GT06 family) stop uploading fixes once parked and only send heartbeats,
    // so an online tracker whose last good fix was stationary is parked, not missing GPS.
    const parked = !fresh && device.model !== 'Mobile' && position && position.valid !== 0 && position.speed < 3;
    const status = !device.lastSeen ? 'Waiting' : !online ? 'Offline' : parked ? 'Stopped' : !fresh ? 'No GPS fix' : position.speed >= 3 ? 'Moving' : 'Stopped';
    const command = (await this.db.prepare('SELECT * FROM commands WHERE deviceId=? ORDER BY createdAt DESC,rowid DESC LIMIT 1').get(id)) || null;
    // Ignition comes from whichever packet last reported it, not only the newest fix.
    const ignition = (await this.db.prepare('SELECT ignition FROM positions WHERE deviceId=? AND ignition IS NOT NULL ORDER BY receivedAt DESC,id DESC LIMIT 1').get(id))?.ignition ?? null;
    let stoppedSince = null;
    if (status === 'Stopped') {
      const moved = (await this.db.prepare('SELECT MAX(recordedAt) AS t FROM positions WHERE deviceId=? AND valid=1 AND speed>=3').get(id))?.t ?? null;
      const first = (await this.db.prepare('SELECT MIN(recordedAt) AS t FROM positions WHERE deviceId=? AND recordedAt>?').get(id, moved ?? -1))?.t;
      stoppedSince = Number(first ?? position.recordedAt);
    }
    return { ...device, position, online, fresh: !!fresh, status, command, ignition, stoppedSince };
  }
  async devices(tenantId) { const ids = tenantId ? (await this.db.prepare('SELECT id FROM devices WHERE tenantId=? ORDER BY createdAt').all(tenantId)) : (await this.db.prepare('SELECT id FROM devices ORDER BY createdAt').all()); const result = []; for (const d of ids) result.push((await this.device(d.id))); return result; }
  async seen(id, at = this.now()) {
    const previous = (await this.raw(id));
    (await this.db.prepare('UPDATE devices SET lastSeen=GREATEST(COALESCE(lastSeen,0),?),offlineAlert=CASE WHEN ?>? THEN 0 ELSE offlineAlert END WHERE id=?')
      .run(at, at, this.now()-previous.offlineSeconds*1000, id));
    if (previous.offlineAlert && at > this.now()-previous.offlineSeconds*1000) (await this.alert(id, previous.model==='Mobile'?'share_resumed':'online', previous.model==='Mobile'?'Driver started sharing location again.':'Tracker reconnected.'));
  }
  async ingest(id, body, { receivedAt = this.now(), heartbeat = true } = {}) {
    const device = (await this.raw(id));
    const latitude = number(body.latitude, 'Latitude', -90, 90), longitude = number(body.longitude, 'Longitude', -180, 180);
    const eventId = text(body.eventId, 'Event ID', 120);
    const recordedAt = typeof body.recordedAt === 'string' ? Date.parse(body.recordedAt) : NaN;
    if (!Number.isFinite(recordedAt) || recordedAt < Date.UTC(2020,0,1) || recordedAt > this.now()+60000) fail(400, 'recordedAt must be an ISO date from 2020 through one minute in the future.');
    const speed = number(body.speed ?? 0, 'Speed (km/h)', 0, 400);
    const optional = (key,min,max) => body[key] == null ? null : number(body[key],key,min,max);
    if (body.ignition != null && typeof body.ignition !== 'boolean') fail(400, 'Ignition must be boolean.');
    const values = [optional('heading',0,360),optional('accuracy',0,100000),body.ignition == null ? null : Number(body.ignition),optional('battery',0,100),optional('satellites',0,100)];
    if (body.commandId != null && !(await this.db.prepare('SELECT id FROM commands WHERE id=? AND deviceId=?').get(text(body.commandId,'Command ID'), id))) fail(400, 'Command does not belong to this device.');
    // A tracker without a satellite fix reports its last known point; keep it for display but never alert on it.
    const valid = body.valid === false ? 0 : 1;
    const extra = cleanExtra(body.extra), info = extra ? JSON.parse(extra) : {};
    const previous = (await this.device(id)).position;
    // The newest earlier row that reported ignition, to detect a change (heartbeats carry it on GT06).
    const lastIgnition = values[2] == null ? null : (await this.db.prepare('SELECT ignition,receivedAt FROM positions WHERE deviceId=? AND ignition IS NOT NULL ORDER BY receivedAt DESC,id DESC LIMIT 1').get(id));
    
    try {
      const inserted = (await this.db.prepare('INSERT INTO positions(deviceId,eventId,recordedAt,receivedAt,latitude,longitude,speed,heading,accuracy,ignition,battery,satellites,valid,extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(deviceId,eventId) DO NOTHING')
        .run(id,eventId,recordedAt,receivedAt,latitude,longitude,speed,...values,valid,extra)).changes > 0;
      // Rows stored before health data was kept get it when the receiver sends them again.
      if (!inserted && extra) (await this.db.prepare('UPDATE positions SET extra=? WHERE deviceId=? AND eventId=? AND extra IS NULL').run(extra,id,eventId));
      if (heartbeat) (await this.seen(id, receivedAt));
      if (inserted && valid && (!previous || recordedAt > previous.recordedAt)) {
        if (overspeed(device,speed,previous) && !(await this.db.prepare("SELECT id FROM alerts WHERE deviceId=? AND type='speed' AND createdAt>?").get(id,recordedAt-SPEED_REPEAT))) (await this.alert(id,'speed',`Speed ${Math.round(speed)} km/h exceeds ${device.speedLimit} km/h.`,recordedAt));
        const braking = hardBrake(previous, speed, recordedAt);
        if (braking && !(await this.db.prepare("SELECT id FROM alerts WHERE deviceId=? AND type='harsh_brake' AND createdAt>?").get(id, recordedAt - REPEAT.harsh_brake))) (await this.alert(id,'harsh_brake',braking,recordedAt));
        for (const fence of (await this.fences(device.tenantId))) {
          const inside = Number(distance({latitude,longitude},fence) <= fence.radius);
          const old = (await this.db.prepare('SELECT inside FROM fence_state WHERE deviceId=? AND fenceId=?').get(id,fence.id));
          if (old && old.inside !== inside) (await this.alert(id,inside?'enter':'exit',`${inside?'Entered':'Left'} ${fence.name}.`,recordedAt));
          (await this.db.prepare('INSERT INTO fence_state(deviceId,fenceId,inside) VALUES (?,?,?) ON CONFLICT(deviceId,fenceId) DO UPDATE SET inside=excluded.inside').run(id,fence.id,inside));
        }
        // A fresh fix proves a location arrived, not that a hardware command was acknowledged.
        (await this.db.prepare("UPDATE commands SET status='location received',detail='A new GPS fix arrived after the request.',updatedAt=? WHERE deviceId=? AND status IN ('queued','dispatching','sent') AND detail NOT LIKE 'CMD %' AND createdAt<=? AND createdAt>=?")
          .run(this.now(),id,recordedAt,this.now()-120000));
      }
      if (body.commandId && inserted && recordedAt >= this.now()-60000) (await this.db.prepare("UPDATE commands SET status='answered',detail='Mobile sender answered with a fresh GPS fix.',updatedAt=? WHERE id=? AND status IN ('queued','sent','location received')").run(this.now(),body.commandId));
      if (inserted && lastIgnition && receivedAt >= Number(lastIgnition.receivedAt) && Number(lastIgnition.ignition) !== values[2])
        (await this.alert(id, values[2] ? 'ignition_on' : 'ignition_off', values[2] ? 'Engine started.' : 'Engine stopped.', Math.min(receivedAt, this.now())));
      // The same tracker alarm repeats in consecutive packets; one alert per half hour is enough.
      if (inserted && info.alarm) for (const { type, message } of alarmAlerts(info.alarm))
        if (!(await this.db.prepare('SELECT id FROM alerts WHERE deviceId=? AND type=? AND message=? AND createdAt>=?').get(id, type, message, receivedAt - REPEAT[type]))) (await this.alert(id,type,message,receivedAt));
      // A tracker's text reply belongs to the newest command still waiting within half an hour.
      if (inserted && typeof info.result === 'string') {
        const waiting = (await this.db.prepare("SELECT id,detail FROM commands WHERE deviceId=? AND status IN ('sent','queued','dispatching') AND detail LIKE 'CMD %' AND createdAt>=? ORDER BY createdAt DESC LIMIT 1").get(id,receivedAt-1800000));
        if (waiting) (await this.db.prepare("UPDATE commands SET status='answered',detail=?,updatedAt=? WHERE id=?").run(`${waiting.detail} → Reply: ${info.result}`.slice(0,1000),this.now(),waiting.id));
      }
      
      return { accepted: true, duplicate: !inserted };
    } catch (e) {  throw e; }
  }
  async history(id, from, to, after = 0, limit = 2000) {
    (await this.raw(id));
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to-from > 31*86400000) fail(400,'Choose a valid date range of up to 31 days.');
    if (!Number.isSafeInteger(after) || after < 0) fail(400,'Invalid history cursor.');
    const rows = (await this.db.prepare('SELECT * FROM positions WHERE deviceId=? AND recordedAt>=? AND recordedAt<=? AND id>? ORDER BY id LIMIT ?').all(id,from,to,after,limit+1));
    const more = rows.length > limit;
    if (more) rows.pop();
    return { positions: rows, next: more ? rows.at(-1).id : null };
  }
  async alert(id,type,message,at=this.now()) { (await this.db.prepare('INSERT INTO alerts(id,deviceId,type,message,createdAt) VALUES (?,?,?,?,?)').run(randomUUID(),id,type,message,at)); }
  // Newest rows by arrival time: fixes and the heartbeats the receiver stores as copies of the last fix.
  async recentPackets(id,limit=100){(await this.raw(id));return (await this.db.prepare('SELECT * FROM positions WHERE deviceId=? ORDER BY receivedAt DESC,id DESC LIMIT ?').all(id,limit));}
  // Rows that carry the vehicle-power flag, oldest first, for the power timeline.
  async powerRows(id,since){return (await this.db.prepare("SELECT receivedAt,battery,extra FROM positions WHERE deviceId=? AND receivedAt>=? AND extra LIKE '%\"charge\"%' ORDER BY receivedAt,id").all(id,since));}
  async latestIccid(id){const row=(await this.db.prepare("SELECT extra FROM positions WHERE deviceId=? AND extra LIKE '%iccid%' ORDER BY receivedAt DESC,id DESC LIMIT 1").get(id));try{return row?JSON.parse(row.extra).iccid||null:null}catch{return null}}
  async deviceAlerts(id,limit=20){return (await this.db.prepare('SELECT * FROM alerts WHERE deviceId=? ORDER BY createdAt DESC LIMIT ?').all(id,limit));}
  async alerts(tenantId){return tenantId?(await this.db.prepare('SELECT alerts.*,devices.name AS deviceName FROM alerts JOIN devices ON devices.id=alerts.deviceId WHERE devices.tenantId=? ORDER BY alerts.createdAt DESC LIMIT 200').all(tenantId)):(await this.db.prepare('SELECT alerts.*,devices.name AS deviceName FROM alerts JOIN devices ON devices.id=alerts.deviceId ORDER BY alerts.createdAt DESC LIMIT 200').all());}
  async acknowledge(id,tenantId){const result=tenantId?(await this.db.prepare('UPDATE alerts SET acknowledged=1 WHERE id=? AND deviceId IN (SELECT id FROM devices WHERE tenantId=?)').run(id,tenantId)):(await this.db.prepare('UPDATE alerts SET acknowledged=1 WHERE id=?').run(id));if(!result.changes)fail(404,'Alert not found.');}
  async fences(tenantId){return tenantId?(await this.db.prepare('SELECT * FROM fences WHERE tenantId=? ORDER BY name').all(tenantId)):(await this.db.prepare('SELECT * FROM fences ORDER BY name').all());}
  async addFence(body,tenantId='owner') {
    const id=randomUUID(), name=text(body.name,'Geofence name');
    const latitude=number(body.latitude,'Latitude',-90,90), longitude=number(body.longitude,'Longitude',-180,180), radius=number(body.radius,'Radius (m)',50,100000);
    (await this.db.prepare('INSERT INTO fences(id,name,latitude,longitude,radius,tenantId) VALUES (?,?,?,?,?,?)').run(id,name,latitude,longitude,radius,tenantId));
    for (const device of (await this.devices(tenantId))) if (device.position) (await this.db.prepare('INSERT INTO fence_state VALUES (?,?,?)').run(device.id,id,Number(distance(device.position,{latitude,longitude}) <= radius)));
    return {id,name,latitude,longitude,radius};
  }
  async deleteFence(id,tenantId){
    const result=tenantId?(await this.db.prepare('DELETE FROM fences WHERE id=? AND tenantId=?').run(id,tenantId)):(await this.db.prepare('DELETE FROM fences WHERE id=?').run(id));
    if (!result.changes) fail(404,'Geofence not found.');
    (await this.db.prepare('DELETE FROM fence_state WHERE fenceId=?').run(id));
  }
  async queue(id) {
    (await this.raw(id)); (await this.tick());
    const existing=(await this.db.prepare("SELECT * FROM commands WHERE deviceId=? AND status IN ('queued','dispatching','sent') ORDER BY createdAt DESC LIMIT 1").get(id));
    if (existing) return existing;
    const command={id:randomUUID(),deviceId:id,status:'queued',detail:'Waiting for the sender.',createdAt:this.now(),updatedAt:this.now()};
    (await this.db.prepare('INSERT INTO commands(id,deviceId,status,detail,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').run(...Object.values(command))); return command;
  }
  async recordCommand(deviceId,status,detail){(await this.raw(deviceId));const row={id:randomUUID(),deviceId,status,detail:String(detail).slice(0,1000),createdAt:this.now(),updatedAt:this.now()};(await this.db.prepare('INSERT INTO commands(id,deviceId,status,detail,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').run(...Object.values(row)));return row;}
  async deviceCommands(deviceId,limit=20){return (await this.db.prepare('SELECT * FROM commands WHERE deviceId=? ORDER BY createdAt DESC LIMIT ?').all(deviceId,limit));}
  async updateCommand(id,status,detail) { (await this.db.prepare("UPDATE commands SET status=?,detail=?,updatedAt=? WHERE id=? AND status IN ('queued','dispatching','sent')").run(status,detail,this.now(),id)); }
  async commands(id) { (await this.tick()); return (await this.db.prepare("SELECT * FROM commands WHERE deviceId=? AND status='queued'").all(id)); }
  async tick() {
    for (const device of (await this.db.prepare('SELECT * FROM devices WHERE lastSeen IS NOT NULL AND offlineAlert=0').all())) {
      if (this.now()-device.lastSeen >= device.offlineSeconds*1000) {
        (await this.alert(device.id,device.model==='Mobile'?'share_stopped':'offline',device.model==='Mobile'?shareSilent(device.offlineSeconds):`No heartbeat for ${device.offlineSeconds} seconds.`));
        (await this.db.prepare('UPDATE devices SET offlineAlert=1 WHERE id=?').run(device.id));
      }
    }
    // A driver link that ran out: tell the customer once, so they can send a new one.
    for (const link of (await this.db.prepare('SELECT hash,deviceId FROM driver_links WHERE revoked=0 AND notified=0 AND expiresAt>0 AND expiresAt<=?').all(this.now()))) {
      (await this.db.prepare('UPDATE driver_links SET notified=1 WHERE hash=?').run(link.hash));
      (await this.alert(link.deviceId,'share_expired','Driver location link expired. Send a new link to keep tracking.'));
    }
    (await this.db.prepare("UPDATE commands SET status='timed out',detail='No fresh location received within two minutes.',updatedAt=? WHERE status IN ('queued','dispatching','sent') AND createdAt<?").run(this.now(),this.now()-120000));
  }
}

// Public calls are serialized on the dedicated client and atomically committed.
// Nested calls join the transaction; callers must await every method and db call.
for (const name of Object.getOwnPropertyNames(PostgresTrackingStore.prototype)) {
  if (name === 'constructor' || name === 'close') continue;
  const method = PostgresTrackingStore.prototype[name];
  PostgresTrackingStore.prototype[name] = function (...args) {
    return this.db.transaction(() => method.apply(this, args));
  };
}

