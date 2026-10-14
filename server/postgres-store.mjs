import { readFile } from 'node:fs/promises';
import { PgAdapter } from './pg-adapter.mjs';
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
  async customers(){return (await this.db.prepare('SELECT id,name,email,createdAt,enabled FROM customers ORDER BY createdAt').all());}
  async createAdmin(email){
    email=text(email,'Admin email',254).toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'Enter a valid admin email.');
    const password=token(),salt=randomBytes(16).toString('hex');
    (await this.db.prepare('INSERT INTO admins(email,salt,passwordHash,createdAt) VALUES (?,?,?,?)').run(email,salt,scryptSync(password,salt,64).toString('hex'),this.now()));
    return {email,password};
  }
  async adminLogin(email,password){
    const row=typeof email==='string'&&(await this.db.prepare('SELECT * FROM admins WHERE email=? AND enabled=1').get(email.trim().toLowerCase()));
    if(typeof password!=='string'||!row||!timingSafeEqual(Buffer.from(row.passwordHash,'hex'),scryptSync(password,row.salt,64)))fail(401,'Incorrect admin credentials.');
    return {email:row.email};
  }
  async customer(id){return (await this.db.prepare('SELECT id,name,email,createdAt,enabled FROM customers WHERE id=?').get(id))||fail(404,'Customer not found.');}
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
    const link=(await this.db.prepare('SELECT code FROM driver_links WHERE deviceId=? AND revoked=0 AND expiresAt=0 ORDER BY rowid DESC LIMIT 1').get(id));
    return link?{code:link.code,expiresAt:null,active:true}:null;
  }
  async createDriverLink(id,{regenerate=false}={}) {
    if((await this.raw(id)).model!=='Mobile')fail(400,'Driver links are for mobile devices.');
    const existing=(await this.getDriverLink(id));
    if(existing&&!regenerate)return existing;
    const code=token(),expiresAt=null;
    
    try{
      (await this.revokeDriverLinks(id));
      (await this.db.prepare('UPDATE devices SET tokenHash=NULL WHERE id=?').run(id));
      (await this.db.prepare('INSERT INTO driver_links(hash,deviceId,expiresAt,code) VALUES (?,?,0,?)').run(hash(code),id,code));
      return {code,expiresAt};
    }catch(e){throw e;}
  }
  async revokeDriverLinks(id) {(await this.raw(id));(await this.db.prepare('UPDATE driver_links SET revoked=1 WHERE deviceId=?').run(id));}
  async joinDriver(code) {
    const link=typeof code==='string'&&(await this.db.prepare('SELECT * FROM driver_links WHERE hash=? AND revoked=0 AND (expiresAt=0 OR expiresAt>?)').get(hash(code),this.now()));
    if(!link)fail(401,'This driver link has expired or been replaced. Ask your fleet admin for a new link.');
    if(!link.code)(await this.db.prepare('UPDATE driver_links SET code=? WHERE hash=?').run(code,link.hash));
    const secret=token(),expiresAt=Math.min(link.expiresAt||Infinity,this.now()+12*3600000);
    (await this.db.prepare('INSERT INTO driver_sessions VALUES (?,?,?)').run(hash(secret),link.hash,expiresAt));
    return {secret,expiresAt,device:(await this.raw(link.deviceId))};
  }
  async driverSession(secret) {
    const session=typeof secret==='string'&&(await this.db.prepare('SELECT l.deviceId,s.expiresAt FROM driver_sessions s JOIN driver_links l ON l.hash=s.linkHash WHERE s.hash=? AND s.expiresAt>? AND (l.expiresAt=0 OR l.expiresAt>?) AND l.revoked=0').get(hash(secret),this.now(),this.now()));
    if(!session)fail(401,'Open the driver link shared by your fleet admin.');
    return {...session,device:(await this.raw(session.deviceId))};
  }
  async device(id) {
    const { tokenHash, ...device } = (await this.raw(id));
    const position = (await this.db.prepare('SELECT * FROM positions WHERE deviceId=? ORDER BY recordedAt DESC,id DESC LIMIT 1').get(id)) || null;
    const online = device.lastSeen !== null && this.now()-device.lastSeen < device.offlineSeconds*1000;
    const fresh = position && this.now()-position.recordedAt < device.offlineSeconds*1000;
    const status = !device.lastSeen ? 'Waiting' : !online ? 'Offline' : !fresh ? 'No GPS fix' : position.speed >= 3 ? 'Moving' : 'Stopped';
    const command = (await this.db.prepare('SELECT * FROM commands WHERE deviceId=? ORDER BY createdAt DESC,rowid DESC LIMIT 1').get(id)) || null;
    return { ...device, position, online, fresh: !!fresh, status, command };
  }
  async devices(tenantId) { const ids = tenantId ? (await this.db.prepare('SELECT id FROM devices WHERE tenantId=? ORDER BY createdAt').all(tenantId)) : (await this.db.prepare('SELECT id FROM devices ORDER BY createdAt').all()); const result = []; for (const d of ids) result.push((await this.device(d.id))); return result; }
  async seen(id, at = this.now()) {
    const previous = (await this.raw(id));
    (await this.db.prepare('UPDATE devices SET lastSeen=GREATEST(COALESCE(lastSeen,0),?),offlineAlert=CASE WHEN ?>? THEN 0 ELSE offlineAlert END WHERE id=?')
      .run(at, at, this.now()-previous.offlineSeconds*1000, id));
    if (previous.offlineAlert && at > this.now()-previous.offlineSeconds*1000) (await this.alert(id, 'online', 'Tracker reconnected.'));
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
    const previous = (await this.device(id)).position;
    
    try {
      const inserted = (await this.db.prepare('INSERT INTO positions(deviceId,eventId,recordedAt,receivedAt,latitude,longitude,speed,heading,accuracy,ignition,battery,satellites) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(deviceId,eventId) DO NOTHING')
        .run(id,eventId,recordedAt,receivedAt,latitude,longitude,speed,...values)).changes > 0;
      if (heartbeat) (await this.seen(id, receivedAt));
      if (inserted && (!previous || recordedAt > previous.recordedAt)) {
        if (speed > device.speedLimit && (!previous || previous.speed <= device.speedLimit)) (await this.alert(id,'speed',`Speed ${Math.round(speed)} km/h exceeds ${device.speedLimit} km/h.`,recordedAt));
        for (const fence of (await this.fences(device.tenantId))) {
          const inside = Number(distance({latitude,longitude},fence) <= fence.radius);
          const old = (await this.db.prepare('SELECT inside FROM fence_state WHERE deviceId=? AND fenceId=?').get(id,fence.id));
          if (old && old.inside !== inside) (await this.alert(id,inside?'enter':'exit',`${inside?'Entered':'Left'} ${fence.name}.`,recordedAt));
          (await this.db.prepare('INSERT INTO fence_state(deviceId,fenceId,inside) VALUES (?,?,?) ON CONFLICT(deviceId,fenceId) DO UPDATE SET inside=excluded.inside').run(id,fence.id,inside));
        }
        // A fresh fix proves a location arrived, not that a hardware command was acknowledged.
        (await this.db.prepare("UPDATE commands SET status='location received',detail='A new GPS fix arrived after the request.',updatedAt=? WHERE deviceId=? AND status IN ('queued','dispatching','sent') AND createdAt<=? AND createdAt>=?")
          .run(this.now(),id,recordedAt,this.now()-120000));
      }
      if (body.commandId && inserted && recordedAt >= this.now()-60000) (await this.db.prepare("UPDATE commands SET status='answered',detail='Mobile sender answered with a fresh GPS fix.',updatedAt=? WHERE id=? AND status IN ('queued','sent','location received')").run(this.now(),body.commandId));
      
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
  async updateCommand(id,status,detail) { (await this.db.prepare("UPDATE commands SET status=?,detail=?,updatedAt=? WHERE id=? AND status IN ('queued','dispatching','sent')").run(status,detail,this.now(),id)); }
  async commands(id) { (await this.tick()); return (await this.db.prepare("SELECT * FROM commands WHERE deviceId=? AND status='queued'").all(id)); }
  async tick() {
    for (const device of (await this.db.prepare('SELECT * FROM devices WHERE lastSeen IS NOT NULL AND offlineAlert=0').all())) {
      if (this.now()-device.lastSeen >= device.offlineSeconds*1000) {
        (await this.alert(device.id,'offline',`No heartbeat for ${device.offlineSeconds} seconds.`));
        (await this.db.prepare('UPDATE devices SET offlineAlert=1 WHERE id=?').run(device.id));
      }
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

