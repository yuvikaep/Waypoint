import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { cleanExtra, alarmAlerts, hardBrake, overspeed, REPEAT, SPEED_REPEAT, shareHours, SHARE_STOPPED, shareSilent, PLACE_KINDS, parkBreach, cleanPhone } from './extra.mjs';
import { cleanSetup } from './provision.mjs';
import { cleanGpsRequest, REQUEST_STATUS } from './buy.mjs';

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

export class TrackingStore {
  constructor(path, { now = () => Date.now() } = {}) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, uniqueId TEXT NOT NULL UNIQUE,
        model TEXT NOT NULL, driver TEXT NOT NULL, tokenHash TEXT, createdAt INTEGER NOT NULL,
        lastSeen INTEGER, traccarId INTEGER, cursor INTEGER, bridgeStatus TEXT,
        offlineSeconds INTEGER NOT NULL, speedLimit INTEGER NOT NULL, offlineAlert INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY, deviceId TEXT NOT NULL REFERENCES devices(id), eventId TEXT NOT NULL,
        recordedAt INTEGER NOT NULL, receivedAt INTEGER NOT NULL,
        latitude REAL NOT NULL, longitude REAL NOT NULL, speed REAL NOT NULL,
        heading REAL, accuracy REAL, ignition INTEGER, battery REAL, satellites INTEGER, valid INTEGER NOT NULL DEFAULT 1,
        UNIQUE(deviceId,eventId)
      );
      CREATE INDEX IF NOT EXISTS position_time ON positions(deviceId,recordedAt,id);
      CREATE TABLE IF NOT EXISTS fences (id TEXT PRIMARY KEY, name TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, radius REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS fence_state (deviceId TEXT, fenceId TEXT, inside INTEGER, PRIMARY KEY(deviceId,fenceId));
      CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, deviceId TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL, createdAt INTEGER NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, deviceId TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS driver_links (hash TEXT PRIMARY KEY,deviceId TEXT NOT NULL REFERENCES devices(id),expiresAt INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS driver_sessions (hash TEXT PRIMARY KEY,linkHash TEXT NOT NULL REFERENCES driver_links(hash),expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,salt TEXT NOT NULL,passwordHash TEXT NOT NULL,createdAt INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS admins (email TEXT PRIMARY KEY,salt TEXT NOT NULL,passwordHash TEXT NOT NULL,createdAt INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS workspace_data (tenantId TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(tenantId,key));
    `);
    if(!this.db.prepare('PRAGMA table_info(devices)').all().some(c=>c.name==='tenantId'))this.db.exec("ALTER TABLE devices ADD COLUMN tenantId TEXT NOT NULL DEFAULT 'owner'");
    if(!this.db.prepare('PRAGMA table_info(positions)').all().some(c=>c.name==='valid'))this.db.exec('ALTER TABLE positions ADD COLUMN valid INTEGER NOT NULL DEFAULT 1');
    if(!this.db.prepare('PRAGMA table_info(positions)').all().some(c=>c.name==='extra'))this.db.exec('ALTER TABLE positions ADD COLUMN extra TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS position_moving ON positions(deviceId,recordedAt) WHERE valid=1 AND speed>=3; CREATE INDEX IF NOT EXISTS position_ignition ON positions(deviceId,receivedAt) WHERE ignition IS NOT NULL;');
    if(!this.db.prepare('PRAGMA table_info(devices)').all().some(c=>c.name==='speedAlert'))this.db.exec('ALTER TABLE devices ADD COLUMN speedAlert INTEGER NOT NULL DEFAULT 1');
    for(const column of ['simOperator','simType','simNumber','apn','apnUser','apnPass'])
      if(!this.db.prepare('PRAGMA table_info(devices)').all().some(c=>c.name===column))this.db.exec(`ALTER TABLE devices ADD COLUMN ${column} TEXT`);
    for(const [column,type] of [['driverPhone','TEXT'],['rssi','INTEGER'],['parkLock','INTEGER NOT NULL DEFAULT 0'],['parkLat','REAL'],['parkLon','REAL'],['parkAt','INTEGER'],['parkAlerted','INTEGER NOT NULL DEFAULT 0']])
      if(!this.db.prepare('PRAGMA table_info(devices)').all().some(c=>c.name===column))this.db.exec(`ALTER TABLE devices ADD COLUMN ${column} ${type}`);
    if(!this.db.prepare('PRAGMA table_info(fences)').all().some(c=>c.name==='kind'))this.db.exec("ALTER TABLE fences ADD COLUMN kind TEXT NOT NULL DEFAULT 'other'");
    this.db.exec('CREATE TABLE IF NOT EXISTS gps_requests (id TEXT PRIMARY KEY,tenantId TEXT NOT NULL,name TEXT NOT NULL,phone TEXT NOT NULL,vehicles INTEGER NOT NULL,product TEXT NOT NULL,note TEXT,status TEXT NOT NULL,createdAt INTEGER NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS landmark_tiles (key TEXT PRIMARY KEY,value TEXT NOT NULL,fetchedAt INTEGER NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS provision_steps (id TEXT PRIMARY KEY,deviceId TEXT NOT NULL,seq INTEGER NOT NULL,command TEXT NOT NULL,label TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,commandId TEXT,sentAt INTEGER,doneAt INTEGER,reply TEXT)');
    if(!this.db.prepare('PRAGMA table_info(fences)').all().some(c=>c.name==='tenantId'))this.db.exec("ALTER TABLE fences ADD COLUMN tenantId TEXT NOT NULL DEFAULT 'owner'");
    if(!this.db.prepare('PRAGMA table_info(driver_links)').all().some(c=>c.name==='code')){
      this.db.exec('ALTER TABLE driver_links ADD COLUMN code TEXT');
    }
    if(!this.db.prepare('PRAGMA table_info(driver_links)').all().some(c=>c.name==='notified')){
      this.db.exec('ALTER TABLE driver_links ADD COLUMN notified INTEGER NOT NULL DEFAULT 0');
      this.db.prepare('UPDATE driver_links SET expiresAt=0 WHERE revoked=0 AND expiresAt>?').run(this.now());
    }
  }
  close() { this.db.close(); }
  customers(){return this.db.prepare('SELECT c.id,c.name,c.email,c.createdAt,c.enabled,(SELECT COUNT(*) FROM devices d WHERE d.tenantId=c.id) AS devices FROM customers c ORDER BY c.createdAt').all();}
  admins(){return this.db.prepare('SELECT email,createdAt,enabled FROM admins ORDER BY createdAt').all();}
  createAdmin(email){
    email=text(email,'Admin email',254).toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'Enter a valid admin email.');
    const password=token(),salt=randomBytes(16).toString('hex');
    try{this.db.prepare('INSERT INTO admins(email,salt,passwordHash,createdAt) VALUES (?,?,?,?)').run(email,salt,scryptSync(password,salt,64).toString('hex'),this.now());}
    catch(e){if(/UNIQUE|PRIMARY KEY/i.test(e.message))fail(409,'An admin with this email already exists.');throw e;}
    return {email,password};
  }
  adminLogin(email,password){
    const row=typeof email==='string'&&this.db.prepare('SELECT * FROM admins WHERE email=? AND enabled=1').get(email.trim().toLowerCase());
    if(typeof password!=='string'||!row||!timingSafeEqual(Buffer.from(row.passwordHash,'hex'),scryptSync(password,row.salt,64)))fail(401,'Incorrect admin credentials.');
    return {email:row.email};
  }
  customer(id){return this.db.prepare('SELECT id,name,email,createdAt,enabled FROM customers WHERE id=?').get(id)||fail(404,'Customer not found.');}
  // Map landmarks per tile, shared by every customer (public place data, no tenant).
  // Buy GPS enquiries (customer → admin).
  addGpsRequest(tenantId,body){const r={id:randomUUID(),tenantId,...cleanGpsRequest(body),status:'new',createdAt:this.now()};this.db.prepare('INSERT INTO gps_requests(id,tenantId,name,phone,vehicles,product,note,status,createdAt) VALUES (?,?,?,?,?,?,?,?,?)').run(r.id,r.tenantId,r.name,r.phone,r.vehicles,r.product,r.note,r.status,r.createdAt);return r;}
  gpsRequests(tenantId){const q="SELECT r.*,COALESCE(c.name,'') AS customerName FROM gps_requests r LEFT JOIN customers c ON c.id=r.tenantId";return tenantId?this.db.prepare(q+' WHERE r.tenantId=? ORDER BY r.createdAt DESC LIMIT 100').all(tenantId):this.db.prepare(q+' ORDER BY r.createdAt DESC LIMIT 500').all();}
  setGpsRequestStatus(id,status){if(!REQUEST_STATUS.includes(status))fail(400,'Unknown status.');if(!this.db.prepare('UPDATE gps_requests SET status=? WHERE id=?').run(status,id).changes)fail(404,'Request not found.');}
  landmarkTile(key){const row=this.db.prepare('SELECT value FROM landmark_tiles WHERE key=?').get(key);return row?JSON.parse(row.value):null;}
  saveLandmarkTile(key,value){this.db.prepare('INSERT OR REPLACE INTO landmark_tiles(key,value,fetchedAt) VALUES (?,?,?)').run(key,JSON.stringify(value),value.fetchedAt);}
  workspaceData(tenantId,key){
    const row=this.db.prepare('SELECT value FROM workspace_data WHERE tenantId=? AND key=?').get(tenantId,key);
    return row?JSON.parse(row.value):null;
  }
  saveWorkspaceData(tenantId,key,value){
    if(!['documents','bills','preferences','ack'].includes(key))fail(404,'Workspace data not found.');
    if(key==='documents'||key==='bills'){
      if(!Array.isArray(value)||value.length>100)fail(400,'Store up to 100 records.');
    }else if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'Expected an object.');
    const data=JSON.stringify(value);
    if(Buffer.byteLength(data)>25*1024*1024)fail(413,'Workspace data is too large.');
    this.db.prepare('INSERT INTO workspace_data(tenantId,key,value,updatedAt) VALUES (?,?,?,?) ON CONFLICT(tenantId,key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt')
      .run(tenantId,key,data,this.now());
    return {ok:true};
  }
  createCustomer(body){
    const name=text(body.name,'Customer name',100);
    const email=text(body.email,'Customer email',254).toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'Enter a valid customer email.');
    const id=randomUUID(),secret=token(),salt=randomBytes(16).toString('hex');
    try{this.db.prepare('INSERT INTO customers(id,name,email,salt,passwordHash,createdAt) VALUES (?,?,?,?,?,?)').run(id,name,email,salt,scryptSync(secret,salt,64).toString('hex'),this.now());}
    catch(e){if(String(e).includes('UNIQUE'))fail(409,'Customer email is already registered.');throw e;}
    return {customer:this.customer(id),password:secret};
  }
  registerCustomer(body){
    const name=text(body.name,'Customer name',100);
    const email=text(body.email,'Customer email',254).toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'Enter a valid customer email.');
    const password=body.password;
    if(typeof password!=='string'||password.length<12||password.length>128)fail(400,'Password must be 12-128 characters.');
    const id=randomUUID(),salt=randomBytes(16).toString('hex');
    try{this.db.prepare('INSERT INTO customers(id,name,email,salt,passwordHash,createdAt) VALUES (?,?,?,?,?,?)').run(id,name,email,salt,scryptSync(password,salt,64).toString('hex'),this.now());}
    catch(e){if(String(e).includes('UNIQUE'))fail(409,'Customer email is already registered.');throw e;}
    return this.customer(id);
  }
  customerLogin(email,password){
    const row=typeof email==='string'&&this.db.prepare('SELECT * FROM customers WHERE email=? AND enabled=1').get(email.trim().toLowerCase());
    if(typeof password!=='string'||!row||!timingSafeEqual(Buffer.from(row.passwordHash,'hex'),scryptSync(password,row.salt,64)))fail(401,'Incorrect customer credentials.');
    return {id:row.id,name:row.name,email:row.email};
  }
  resetCustomer(id){
    this.customer(id);const password=token(),salt=randomBytes(16).toString('hex');
    this.db.prepare('UPDATE customers SET salt=?,passwordHash=? WHERE id=?').run(salt,scryptSync(password,salt,64).toString('hex'),id);
    return {password};
  }
  // Signed-in users change their own password; the current one is always re-checked.
  changePassword(role,email,current,next){
    if(typeof next!=='string'||next.length<12||next.length>128)fail(400,'New password must be 12-128 characters.');
    if(next===current)fail(400,'New password must be different from the current one.');
    let account;try{account=role==='admin'?this.adminLogin(email,current):this.customerLogin(email,current);}catch(e){fail(e.status===401?400:e.status||500,e.status===401?'Current password is incorrect.':e.message);}
    const salt=randomBytes(16).toString('hex');
    this.db.prepare(`UPDATE ${role==='admin'?'admins':'customers'} SET salt=?,passwordHash=? WHERE email=?`).run(salt,scryptSync(next,salt,64).toString('hex'),account.email);
    return account;
  }
  // Recovery with the server maintenance key: give the admin a temporary password to change after login.
  resetAdminPassword(email){
    const admins=this.db.prepare('SELECT email FROM admins WHERE enabled=1 ORDER BY createdAt').all();
    const target=email==null?(admins.length===1?admins[0].email:fail(409,'Specify which admin email to reset.')):String(email).trim().toLowerCase();
    if(!admins.some(a=>a.email===target))fail(404,'Admin not found.');
    const password=randomBytes(12).toString('base64url'),salt=randomBytes(16).toString('hex');
    this.db.prepare('UPDATE admins SET salt=?,passwordHash=? WHERE email=?').run(salt,scryptSync(password,salt,64).toString('hex'),target);
    return {email:target,password};
  }
  setCustomerEnabled(id,enabled){this.customer(id);this.db.prepare('UPDATE customers SET enabled=? WHERE id=?').run(Number(enabled),id);return this.customer(id);}
  raw(id) { return this.db.prepare('SELECT * FROM devices WHERE id=?').get(id) || fail(404, 'Device not found.'); }
  createDevice(body,tenantId='owner') {
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
      this.db.prepare('INSERT INTO devices (id,name,uniqueId,model,driver,tokenHash,createdAt,offlineSeconds,speedLimit,tenantId) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id,name,uniqueId,body.model,driver,secret ? hash(secret) : null,this.now(),offlineSeconds,speedLimit,tenantId);
    } catch (e) { if (String(e).includes('UNIQUE')) fail(409, 'This device identifier is already registered.'); throw e; }
    return { device: this.device(id), token: secret };
  }
  // Admin edits a vehicle or moves it to another customer ('owner' = unassigned).
  updateDevice(id,body) {
    const device=this.raw(id);
    const name=body.name===undefined?device.name:text(body.name,'Vehicle name');
    const driver=body.driver===undefined?device.driver:typeof body.driver==='string'?body.driver.trim().slice(0,100):'';
    const offlineSeconds=body.offlineSeconds===undefined?device.offlineSeconds:number(body.offlineSeconds,'Offline threshold',30,86400);
    const speedLimit=body.speedLimit===undefined?device.speedLimit:number(body.speedLimit,'Speed limit',1,250);
    let tenantId=device.tenantId;
    if(body.customerId!==undefined){tenantId=body.customerId?String(body.customerId):'owner';if(tenantId!=='owner')this.customer(tenantId);}
    this.db.prepare('UPDATE devices SET name=?,driver=?,offlineSeconds=?,speedLimit=?,tenantId=? WHERE id=?').run(name,driver,offlineSeconds,speedLimit,tenantId,id);
    if(body.speedAlert!==undefined)this.db.prepare('UPDATE devices SET speedAlert=? WHERE id=?').run(body.speedAlert?1:0,id);
    // A vehicle changing hands must not keep the previous owner's geofence state or driver links.
    if(tenantId!==device.tenantId){this.db.prepare('DELETE FROM fence_state WHERE deviceId=?').run(id);this.revokeDriverLinks(id);}
    return this.device(id);
  }
  // Removes the vehicle and everything recorded for it.
  deleteDevice(id) {
    this.raw(id);this.db.prepare('DELETE FROM provision_steps WHERE deviceId=?').run(id);
    const has=table=>!!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM driver_sessions WHERE linkHash IN (SELECT hash FROM driver_links WHERE deviceId=?)').run(id);
      for (const table of ['driver_links','positions','fence_state','alerts','commands','relay_installations','relay_commands']) if (has(table)) this.db.prepare(`DELETE FROM ${table} WHERE deviceId=?`).run(id);
      this.db.prepare('DELETE FROM devices WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  // SIM and APN details given when the device is onboarded (admin only; the APN password never leaves the server).
  setDeviceSetup(id,input){
    this.raw(id);const set=cleanSetup(input),keys=Object.keys(set);
    if(keys.length)this.db.prepare(`UPDATE devices SET ${keys.map(k=>`${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k=>set[k]),id);
    return this.raw(id);
  }
  provisionReplace(id,steps){
    this.raw(id);this.db.prepare('DELETE FROM provision_steps WHERE deviceId=?').run(id);
    for(const s of steps)this.db.prepare("INSERT INTO provision_steps(id,deviceId,seq,command,label,status) VALUES (?,?,?,?,?,'pending')").run(randomUUID(),id,s.seq,s.command,s.label);
  }
  // Rows decoded with a time-zone offset applied twice sit a fixed amount behind their reception time.
  shiftClock(id,minutes,tolerance=10){this.raw(id);const m=minutes*60000,t=tolerance*60000;return Number(this.db.prepare('UPDATE positions SET recordedAt=recordedAt+? WHERE deviceId=? AND receivedAt-recordedAt BETWEEN ? AND ?').run(m,id,m-t,m+t).changes);}
  provisionSteps(id){return this.db.prepare('SELECT * FROM provision_steps WHERE deviceId=? ORDER BY seq').all(id);}
  pendingProvisioning(){return this.db.prepare("SELECT DISTINCT deviceId FROM provision_steps WHERE status IN ('pending','sent')").all().map(r=>r.deviceId);}
  provisionUpdate(stepId,patch){
    const keys=Object.keys(patch).filter(k=>['status','attempts','commandId','sentAt','doneAt','reply'].includes(k));
    if(keys.length)this.db.prepare(`UPDATE provision_steps SET ${keys.map(k=>`${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k=>patch[k]),stepId);
  }
  rotateToken(id) {
    if (this.raw(id).model !== 'Mobile') fail(400, 'Only mobile devices use a sender token.');
    const secret = token();
    this.db.prepare('UPDATE devices SET tokenHash=? WHERE id=?').run(hash(secret), id);
    return secret;
  }
  authenticateDevice(secret) {
    if (typeof secret !== 'string') fail(401, 'Sender token required.');
    return this.db.prepare('SELECT * FROM devices WHERE tokenHash=?').get(hash(secret)) || fail(401, 'Invalid sender token.');
  }
  getDriverLink(id) {
    this.raw(id);
    const link=this.db.prepare('SELECT code,expiresAt FROM driver_links WHERE deviceId=? AND revoked=0 AND (expiresAt=0 OR expiresAt>?) ORDER BY rowid DESC LIMIT 1').get(id,this.now());
    return link?{code:link.code,expiresAt:Number(link.expiresAt)||null,active:true}:null;
  }
  createDriverLink(id,{regenerate=false,hours}={}) {
    if(this.raw(id).model!=='Mobile')fail(400,'Driver links are for mobile devices.');
    const existing=this.getDriverLink(id);
    // Changing how long it lasts keeps the same link, so the driver does not need a new one.
    if(existing&&!regenerate){if(hours===undefined)return existing;const until=this.now()+shareHours(hours)*3600000;this.db.prepare('UPDATE driver_links SET expiresAt=?,notified=0 WHERE code=? AND deviceId=?').run(until,existing.code,id);return {...existing,expiresAt:until};}
    const code=token(),expiresAt=this.now()+shareHours(hours)*3600000;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.revokeDriverLinks(id);
      this.db.prepare('UPDATE devices SET tokenHash=NULL WHERE id=?').run(id);
      this.db.prepare('INSERT INTO driver_links(hash,deviceId,expiresAt,code) VALUES (?,?,?,?)').run(hash(code),id,expiresAt,code);
      this.db.exec('COMMIT');return {code,expiresAt};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  revokeDriverLinks(id) {this.raw(id);this.db.prepare('UPDATE driver_links SET revoked=1 WHERE deviceId=?').run(id);}
  // The driver's page says why sharing ended; the customer hears it at once instead of after the offline wait.
  sharingStopped(id,reason) {
    const message=SHARE_STOPPED[reason]||SHARE_STOPPED.stopped;
    if(this.db.prepare("SELECT id FROM alerts WHERE deviceId=? AND type='share_stopped' AND createdAt>?").get(id,this.now()-120000))return;
    this.alert(id,'share_stopped',message);this.db.prepare('UPDATE devices SET offlineAlert=1 WHERE id=?').run(id);
  }
  joinDriver(code) {
    const link=typeof code==='string'&&this.db.prepare('SELECT * FROM driver_links WHERE hash=? AND revoked=0 AND (expiresAt=0 OR expiresAt>?)').get(hash(code),this.now());
    if(!link)fail(401,'This driver link has expired or been replaced. Ask your fleet admin for a new link.');
    if(!link.code)this.db.prepare('UPDATE driver_links SET code=? WHERE hash=?').run(code,link.hash);
    // The phone stays signed in for as long as the link lasts (12 h for links made before durations).
    const secret=token(),expiresAt=Number(link.expiresAt)||this.now()+12*3600000;
    this.db.prepare('INSERT INTO driver_sessions VALUES (?,?,?)').run(hash(secret),link.hash,expiresAt);
    return {secret,expiresAt,device:this.raw(link.deviceId)};
  }
  driverSession(secret) {
    const session=typeof secret==='string'&&this.db.prepare('SELECT l.deviceId,s.expiresAt FROM driver_sessions s JOIN driver_links l ON l.hash=s.linkHash WHERE s.hash=? AND s.expiresAt>? AND (l.expiresAt=0 OR l.expiresAt>?) AND l.revoked=0').get(hash(secret),this.now(),this.now());
    if(!session)fail(401,'Open the driver link shared by your fleet admin.');
    return {...session,device:this.raw(session.deviceId)};
  }
  device(id) {
    const { tokenHash, apnPass, ...device } = this.raw(id);
    const position = this.db.prepare('SELECT * FROM positions WHERE deviceId=? ORDER BY recordedAt DESC,id DESC LIMIT 1').get(id) || null;
    const online = device.lastSeen !== null && this.now()-device.lastSeen < device.offlineSeconds*1000;
    const fresh = position && position.valid !== 0 && this.now()-position.recordedAt < device.offlineSeconds*1000;
    // Hardware trackers (GT06 family) stop uploading fixes once parked and only send heartbeats,
    // so an online tracker whose last good fix was stationary is parked, not missing GPS.
    const parked = !fresh && device.model !== 'Mobile' && position && position.valid !== 0 && position.speed < 3;
    const status = !device.lastSeen ? 'Waiting' : !online ? 'Offline' : parked ? 'Stopped' : !fresh ? 'No GPS fix' : position.speed >= 3 ? 'Moving' : 'Stopped';
    const command = this.db.prepare('SELECT * FROM commands WHERE deviceId=? ORDER BY createdAt DESC,rowid DESC LIMIT 1').get(id) || null;
    // Ignition comes from whichever packet last reported it, not only the newest fix.
    const ignition = this.db.prepare('SELECT ignition FROM positions WHERE deviceId=? AND ignition IS NOT NULL ORDER BY receivedAt DESC,id DESC LIMIT 1').get(id)?.ignition ?? null;
    let stoppedSince = null;
    if (status === 'Stopped') {
      const moved = this.db.prepare('SELECT MAX(recordedAt) AS t FROM positions WHERE deviceId=? AND valid=1 AND speed>=3').get(id)?.t ?? null;
      stoppedSince = this.db.prepare('SELECT MIN(recordedAt) AS t FROM positions WHERE deviceId=? AND recordedAt>?').get(id, moved ?? -1)?.t ?? position.recordedAt;
    }
    return { ...device, position, online, fresh: !!fresh, status, command, ignition, stoppedSince };
  }
  // Parking lock is armed at the vehicle's last known point; switching it off clears any alert state.
  setParkLock(id,on) {
    if(typeof on!=='boolean')fail(400,'Parking lock must be on or off.');
    if(!on){this.db.prepare('UPDATE devices SET parkLock=0,parkAlerted=0 WHERE id=?').run(id);return this.device(id);}
    const d=this.device(id),p=d.position;
    if(!p)fail(409,'This vehicle has not sent a location yet.');
    if(d.status==='Moving')fail(409,'The vehicle is moving. Lock it once it is parked.');
    this.db.prepare('UPDATE devices SET parkLock=1,parkLat=?,parkLon=?,parkAt=?,parkAlerted=0 WHERE id=?').run(p.latitude,p.longitude,this.now(),id);
    return this.device(id);
  }
  setDriverPhone(id,phone) {this.db.prepare('UPDATE devices SET driverPhone=? WHERE id=?').run(cleanPhone(phone),id);return this.device(id);}
  devices(tenantId) {return (tenantId?this.db.prepare('SELECT id FROM devices WHERE tenantId=? ORDER BY createdAt').all(tenantId):this.db.prepare('SELECT id FROM devices ORDER BY createdAt').all()).map(d=>this.device(d.id));}
  seen(id, at = this.now()) {
    const previous = this.raw(id);
    this.db.prepare('UPDATE devices SET lastSeen=MAX(COALESCE(lastSeen,0),?),offlineAlert=CASE WHEN ?>? THEN 0 ELSE offlineAlert END WHERE id=?')
      .run(at, at, this.now()-previous.offlineSeconds*1000, id);
    if (previous.offlineAlert && at > this.now()-previous.offlineSeconds*1000) this.alert(id, previous.model==='Mobile'?'share_resumed':'online', previous.model==='Mobile'?'Driver started sharing location again.':'Tracker reconnected.');
  }
  ingest(id, body, { receivedAt = this.now(), heartbeat = true } = {}) {
    const device = this.raw(id);
    const latitude = number(body.latitude, 'Latitude', -90, 90), longitude = number(body.longitude, 'Longitude', -180, 180);
    const eventId = text(body.eventId, 'Event ID', 120);
    const recordedAt = typeof body.recordedAt === 'string' ? Date.parse(body.recordedAt) : NaN;
    if (!Number.isFinite(recordedAt) || recordedAt < Date.UTC(2020,0,1) || recordedAt > this.now()+60000) fail(400, 'recordedAt must be an ISO date from 2020 through one minute in the future.');
    const speed = number(body.speed ?? 0, 'Speed (km/h)', 0, 400);
    const optional = (key,min,max) => body[key] == null ? null : number(body[key],key,min,max);
    if (body.ignition != null && typeof body.ignition !== 'boolean') fail(400, 'Ignition must be boolean.');
    const values = [optional('heading',0,360),optional('accuracy',0,100000),body.ignition == null ? null : Number(body.ignition),optional('battery',0,100),optional('satellites',0,100)];
    if (body.commandId != null && !this.db.prepare('SELECT id FROM commands WHERE id=? AND deviceId=?').get(text(body.commandId,'Command ID'), id)) fail(400, 'Command does not belong to this device.');
    // A tracker without a satellite fix reports its last known point; keep it for display but never alert on it.
    const valid = body.valid === false ? 0 : 1;
    const extra = cleanExtra(body.extra), info = extra ? JSON.parse(extra) : {};
    const previous = this.device(id).position;
    // The newest earlier row that reported ignition, to detect a change (heartbeats carry it on GT06).
    const lastIgnition = values[2] == null ? null : this.db.prepare('SELECT ignition,receivedAt FROM positions WHERE deviceId=? AND ignition IS NOT NULL ORDER BY receivedAt DESC,id DESC LIMIT 1').get(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const inserted = this.db.prepare('INSERT OR IGNORE INTO positions(deviceId,eventId,recordedAt,receivedAt,latitude,longitude,speed,heading,accuracy,ignition,battery,satellites,valid,extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id,eventId,recordedAt,receivedAt,latitude,longitude,speed,...values,valid,extra).changes > 0;
      // Rows stored before health data was kept get it when the receiver sends them again.
      if (!inserted && extra) this.db.prepare('UPDATE positions SET extra=? WHERE deviceId=? AND eventId=? AND extra IS NULL').run(extra,id,eventId);
      if (heartbeat) this.seen(id, receivedAt);
      if (inserted && valid && (!previous || recordedAt > previous.recordedAt)) {
        if (overspeed(device,speed,previous) && !this.db.prepare("SELECT id FROM alerts WHERE deviceId=? AND type='speed' AND createdAt>?").get(id,recordedAt-SPEED_REPEAT)) this.alert(id,'speed',`Speed ${Math.round(speed)} km/h exceeds ${device.speedLimit} km/h.`,recordedAt);
        const braking = hardBrake(previous, speed, recordedAt);
        if (braking && !this.db.prepare("SELECT id FROM alerts WHERE deviceId=? AND type='harsh_brake' AND createdAt>?").get(id, recordedAt - REPEAT.harsh_brake)) this.alert(id,'harsh_brake',braking,recordedAt);
        for (const fence of this.fences(device.tenantId)) {
          const inside = Number(distance({latitude,longitude},fence) <= fence.radius);
          const old = this.db.prepare('SELECT inside FROM fence_state WHERE deviceId=? AND fenceId=?').get(id,fence.id);
          if (old && old.inside !== inside) this.alert(id,inside?'enter':'exit',`${inside?'Entered':'Left'} ${fence.name}.`,recordedAt);
          this.db.prepare('INSERT OR REPLACE INTO fence_state VALUES (?,?,?)').run(id,fence.id,inside);
        }
        // A fresh fix proves a location arrived, not that a hardware command was acknowledged.
        this.db.prepare("UPDATE commands SET status='location received',detail='A new GPS fix arrived after the request.',updatedAt=? WHERE deviceId=? AND status IN ('queued','dispatching','sent') AND detail NOT LIKE 'CMD %' AND createdAt<=? AND createdAt>=?")
          .run(this.now(),id,recordedAt,this.now()-120000);
      }
      if (inserted && typeof info.rssi === 'number') this.db.prepare('UPDATE devices SET rssi=? WHERE id=?').run(Math.round(info.rssi),id);
      const breach = inserted && recordedAt >= Number(device.parkAt || 0) ? parkBreach(device, { ignition: values[2], valid, latitude, longitude }, distance) : null;
      if (breach) { this.alert(id,'parking_lock',breach,Math.min(receivedAt,this.now())); this.db.prepare('UPDATE devices SET parkAlerted=1 WHERE id=?').run(id); }
      if (body.commandId && inserted && recordedAt >= this.now()-60000) this.db.prepare("UPDATE commands SET status='answered',detail='Mobile sender answered with a fresh GPS fix.',updatedAt=? WHERE id=? AND status IN ('queued','sent','location received')").run(this.now(),body.commandId);
      if (inserted && lastIgnition && receivedAt >= lastIgnition.receivedAt && lastIgnition.ignition !== values[2])
        this.alert(id, values[2] ? 'ignition_on' : 'ignition_off', values[2] ? 'Engine started.' : 'Engine stopped.', Math.min(receivedAt, this.now()));
      // The same tracker alarm repeats in consecutive packets; one alert per half hour is enough.
      if (inserted && info.alarm) for (const { type, message } of alarmAlerts(info.alarm))
        if (!this.db.prepare('SELECT id FROM alerts WHERE deviceId=? AND type=? AND message=? AND createdAt>=?').get(id, type, message, receivedAt - REPEAT[type])) this.alert(id,type,message,receivedAt);
      // A tracker's text reply belongs to the newest command still waiting within half an hour.
      if (inserted && typeof info.result === 'string') {
        const waiting = this.db.prepare("SELECT id,detail FROM commands WHERE deviceId=? AND status IN ('sent','queued','dispatching') AND detail LIKE 'CMD %' AND createdAt>=? ORDER BY createdAt DESC LIMIT 1").get(id,receivedAt-1800000);
        if (waiting) this.db.prepare("UPDATE commands SET status='answered',detail=?,updatedAt=? WHERE id=?").run(`${waiting.detail} → Reply: ${info.result}`.slice(0,1000),this.now(),waiting.id);
      }
      this.db.exec('COMMIT');
      return { accepted: true, duplicate: !inserted };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  history(id, from, to, after = 0, limit = 2000) {
    this.raw(id);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to-from > 31*86400000) fail(400,'Choose a valid date range of up to 31 days.');
    if (!Number.isSafeInteger(after) || after < 0) fail(400,'Invalid history cursor.');
    const rows = this.db.prepare('SELECT * FROM positions WHERE deviceId=? AND recordedAt>=? AND recordedAt<=? AND id>? ORDER BY id LIMIT ?').all(id,from,to,after,limit+1);
    const more = rows.length > limit;
    if (more) rows.pop();
    return { positions: rows, next: more ? rows.at(-1).id : null };
  }
  alert(id,type,message,at=this.now()) { this.db.prepare('INSERT INTO alerts(id,deviceId,type,message,createdAt) VALUES (?,?,?,?,?)').run(randomUUID(),id,type,message,at); }
  // Newest rows by arrival time: fixes and the heartbeats the receiver stores as copies of the last fix.
  recentPackets(id,limit=100){this.raw(id);return this.db.prepare('SELECT * FROM positions WHERE deviceId=? ORDER BY receivedAt DESC,id DESC LIMIT ?').all(id,limit);}
  // Rows that carry the vehicle-power flag, oldest first, for the power timeline.
  powerRows(id,since){return this.db.prepare("SELECT receivedAt,battery,extra FROM positions WHERE deviceId=? AND receivedAt>=? AND extra LIKE '%\"charge\"%' ORDER BY receivedAt,id").all(id,since);}
  latestIccid(id){const row=this.db.prepare("SELECT extra FROM positions WHERE deviceId=? AND extra LIKE '%iccid%' ORDER BY receivedAt DESC,id DESC LIMIT 1").get(id);try{return row?JSON.parse(row.extra).iccid||null:null}catch{return null}}
  deviceAlerts(id,limit=20){return this.db.prepare('SELECT * FROM alerts WHERE deviceId=? ORDER BY createdAt DESC LIMIT ?').all(id,limit);}
  alerts(tenantId){return tenantId?this.db.prepare('SELECT alerts.*,devices.name AS deviceName FROM alerts JOIN devices ON devices.id=alerts.deviceId WHERE devices.tenantId=? ORDER BY alerts.createdAt DESC LIMIT 200').all(tenantId):this.db.prepare('SELECT alerts.*,devices.name AS deviceName FROM alerts JOIN devices ON devices.id=alerts.deviceId ORDER BY alerts.createdAt DESC LIMIT 200').all();}
  acknowledge(id,tenantId){const result=tenantId?this.db.prepare('UPDATE alerts SET acknowledged=1 WHERE id=? AND deviceId IN (SELECT id FROM devices WHERE tenantId=?)').run(id,tenantId):this.db.prepare('UPDATE alerts SET acknowledged=1 WHERE id=?').run(id);if(!result.changes)fail(404,'Alert not found.');}
  fences(tenantId){return tenantId?this.db.prepare('SELECT * FROM fences WHERE tenantId=? ORDER BY name').all(tenantId):this.db.prepare('SELECT * FROM fences ORDER BY name').all();}
  addFence(body,tenantId='owner') {
    const id=randomUUID(), name=text(body.name,'Geofence name');
    const latitude=number(body.latitude,'Latitude',-90,90), longitude=number(body.longitude,'Longitude',-180,180), radius=number(body.radius,'Radius (m)',50,100000);
    const kind=body.kind===undefined||body.kind===null||body.kind===''?'other':String(body.kind);
    if(!PLACE_KINDS.includes(kind))fail(400,'Choose a place type from the list.');
    this.db.prepare('INSERT INTO fences(id,name,latitude,longitude,radius,tenantId,kind) VALUES (?,?,?,?,?,?,?)').run(id,name,latitude,longitude,radius,tenantId,kind);
    for (const device of this.devices(tenantId)) if (device.position) this.db.prepare('INSERT INTO fence_state VALUES (?,?,?)').run(device.id,id,Number(distance(device.position,{latitude,longitude}) <= radius));
    return {id,name,latitude,longitude,radius,kind};
  }
  deleteFence(id,tenantId){
    const result=tenantId?this.db.prepare('DELETE FROM fences WHERE id=? AND tenantId=?').run(id,tenantId):this.db.prepare('DELETE FROM fences WHERE id=?').run(id);
    if (!result.changes) fail(404,'Geofence not found.');
    this.db.prepare('DELETE FROM fence_state WHERE fenceId=?').run(id);
  }
  queue(id) {
    this.raw(id); this.tick();
    const existing=this.db.prepare("SELECT * FROM commands WHERE deviceId=? AND status IN ('queued','dispatching','sent') ORDER BY createdAt DESC LIMIT 1").get(id);
    if (existing) return existing;
    const command={id:randomUUID(),deviceId:id,status:'queued',detail:'Waiting for the sender.',createdAt:this.now(),updatedAt:this.now()};
    this.db.prepare('INSERT INTO commands VALUES (?,?,?,?,?,?)').run(...Object.values(command)); return command;
  }
  recordCommand(deviceId,status,detail){this.raw(deviceId);const row={id:randomUUID(),deviceId,status,detail:String(detail).slice(0,1000),createdAt:this.now(),updatedAt:this.now()};this.db.prepare('INSERT INTO commands VALUES (?,?,?,?,?,?)').run(...Object.values(row));return row;}
  deviceCommands(deviceId,limit=20){return this.db.prepare('SELECT * FROM commands WHERE deviceId=? ORDER BY createdAt DESC LIMIT ?').all(deviceId,limit);}
  updateCommand(id,status,detail) { this.db.prepare("UPDATE commands SET status=?,detail=?,updatedAt=? WHERE id=? AND status IN ('queued','dispatching','sent')").run(status,detail,this.now(),id); }
  commands(id) { this.tick(); return this.db.prepare("SELECT * FROM commands WHERE deviceId=? AND status='queued'").all(id); }
  tick() {
    for (const device of this.db.prepare('SELECT * FROM devices WHERE lastSeen IS NOT NULL AND offlineAlert=0').all()) {
      if (this.now()-device.lastSeen >= device.offlineSeconds*1000) {
        this.alert(device.id,device.model==='Mobile'?'share_stopped':'offline',device.model==='Mobile'?shareSilent(device.offlineSeconds):`No heartbeat for ${device.offlineSeconds} seconds.`);
        this.db.prepare('UPDATE devices SET offlineAlert=1 WHERE id=?').run(device.id);
      }
    }
    // A driver link that ran out: tell the customer once, so they can send a new one.
    for (const link of this.db.prepare('SELECT hash,deviceId FROM driver_links WHERE revoked=0 AND notified=0 AND expiresAt>0 AND expiresAt<=?').all(this.now())) {
      this.db.prepare('UPDATE driver_links SET notified=1 WHERE hash=?').run(link.hash);
      this.alert(link.deviceId,'share_expired','Driver location link expired. Send a new link to keep tracking.');
    }
    this.db.prepare("UPDATE commands SET status='timed out',detail='No fresh location received within two minutes.',updatedAt=? WHERE status IN ('queued','dispatching','sent') AND createdAt<?").run(this.now(),this.now()-120000);
  }
}
