export class TraccarBridge {
  constructor(store, { url, token, fetcher = fetch } = {}) {
    this.store=store; this.url=url?.replace(/\/$/,''); this.token=token; this.fetcher=fetcher;
    this.state={configured:!!(url && token),connected:false,lastSync:null,error:null};
  }
  async request(path, options={}) {
    if (!this.url || !this.token) throw new Error('Gateway command channel is not configured. Automatic GPS reports do not require this channel.');
    const response=await this.fetcher(`${this.url}/api${path}`,{...options,headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json',Accept:'application/json'},signal:AbortSignal.timeout(10000)});
    if (!response.ok) {
      const detail=await response.json().catch(()=>null);
      throw new Error(`Tracker gateway returned HTTP ${response.status}.${typeof detail?.error==='string'?' '+detail.error:''}`);
    }
    return {status:response.status,data:response.status===204?null:await response.json()};
  }
  async sync() {
    if (this.busy || !this.state.configured) return;
    this.busy=true;
    try {
      const remote=(await this.request('/devices')).data;
      const current=(await this.request('/positions')).data;
      const failures=[];
      for (const device of (await this.store.devices()).filter(d=>d.model!=='Mobile')) {
        try {
          let match=remote.find(d=>d.uniqueId===device.uniqueId);
          if (!match) {
            match=(await this.request('/devices',{method:'POST',body:JSON.stringify({name:device.name,uniqueId:device.uniqueId,model:device.model})})).data;
            remote.push(match);
          }
          await this.store.db.prepare('UPDATE devices SET traccarId=?,bridgeStatus=? WHERE id=?').run(match.id,match.status || 'unknown',device.id);
          const lastSeen=Date.parse(match.lastUpdate);
          if (Number.isFinite(lastSeen) && lastSeen<=this.store.now()+60000) await this.store.seen(device.id,lastSeen);
          const latest=current.find(p=>p.deviceId===match.id);
          // Backfill bounded windows with overlap; source position IDs deduplicate retries.
          // Record historical points before the current fix so fence transitions stay ordered.
          const from=Math.max(device.createdAt-60000,(device.cursor ?? device.createdAt)-60000);
          const to=Math.min(from+15*60000,this.store.now());
          const history=(await this.request(`/positions?${new URLSearchParams({deviceId:String(match.id),from:new Date(from).toISOString(),to:new Date(to).toISOString()})}`)).data;
          for (const position of history.sort((a,b)=>Date.parse(a.fixTime)-Date.parse(b.fixTime))) await this.ingest(device.id,position);
          await this.store.db.prepare('UPDATE devices SET cursor=? WHERE id=?').run(to,device.id);
          if (latest) await this.ingest(device.id,latest);
        } catch (e) {
          await this.store.db.prepare('UPDATE devices SET bridgeStatus=? WHERE id=?').run(`Sync failed: ${e.message}`,device.id);
          failures.push(`${device.name}: ${e.message}`);
        }
      }
      this.state={...this.state,connected:failures.length===0,lastSync:this.store.now(),error:failures.length?failures.join(' '):null};
    } catch (e) { this.state={...this.state,connected:false,error:e.message}; }
    finally { this.busy=false; }
  }
  async ingest(id,p) {
    if (!p.id || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || (p.latitude === 0 && p.longitude === 0)) return;
    const attrs=p.attributes || {};
    const receivedAt=Date.parse(p.serverTime) || this.store.now();
    // Cheap GT06 clones often report local time as UTC or an unset RTC. Fall back to
    // reception time rather than rejecting the point, which would stall the whole sync.
    const fixAt=Date.parse(p.fixTime);
    const recordedAt=Number.isFinite(fixAt) && fixAt >= Date.UTC(2020,0,1) && fixAt <= Math.min(receivedAt,this.store.now())+60000 ? p.fixTime : new Date(Math.min(receivedAt,this.store.now())).toISOString();
    // GT06 0x12 location packets carry ACC in a course/status bit that clones such as the G17 leave
    // unset while driving; the 0x13 heartbeat's terminal-info ACC bit is the reliable source.
    const ignition=typeof attrs.ignition!=='boolean'||(p.protocol==='gt06'&&attrs.type===0x12)?null:attrs.ignition;
    const within=(value,min,max)=>Number.isFinite(value) && value>=min && value<=max ? value : null;
    try {
      return await this.store.ingest(id,{eventId:`traccar:${p.id}`,recordedAt,latitude:p.latitude,longitude:p.longitude,
        speed:within(p.speed*1.852,0,400) ?? 0,heading:within(p.course,0,360),accuracy:p.accuracy>0?within(p.accuracy,0,100000):null,
        ignition,battery:within(attrs.batteryLevel,0,100),satellites:within(attrs.sat,0,100),valid:!!p.valid},
      {receivedAt,heartbeat:false});
    } catch (e) {
      // One malformed receiver point must not block every later fix for the fleet.
      if (e.status===400) { console.warn(`Skipped receiver position ${p.id}: ${e.message}`); return; }
      throw e;
    }
  }
  async importHistory(device,from,to) {
    if(!device.traccarId)throw new Error('Device is not yet linked to the gateway.');
    const result=await this.request(`/positions?${new URLSearchParams({deviceId:String(device.traccarId),from:new Date(from).toISOString(),to:new Date(to).toISOString()})}`);
    for(const position of result.data.sort((a,b)=>Date.parse(a.fixTime)-Date.parse(b.fixTime)))await this.ingest(device.id,position);
  }
  async ping(device) {
    if (!device.traccarId) throw new Error('Device is not registered with the tracker gateway yet.');
    const types=(await this.request(`/commands/types?deviceId=${device.traccarId}&textChannel=false`)).data;
    if (!types.some(t=>t.type==='positionSingle')) return {status:'unsupported',detail:'The gateway does not expose a built-in location Ping for this tracker. Automatic GPS uploads are separate and require a tracker data connection.'};
    const response=await this.request('/commands/send',{method:'POST',body:JSON.stringify({deviceId:device.traccarId,type:'positionSingle',textChannel:false,attributes:{}})});
    return {status:response.status===202?'queued':'sent',detail:response.status===202?'Gateway queued the location request.':'Location request sent to the tracker. Awaiting a fresh fix.'};
  }
  async relaySupported(device,protocol){
    if(!device.traccarId)return false;
    const remote=(await this.request(`/devices?id=${device.traccarId}`)).data.find(d=>d.id===device.traccarId);
    if(!remote||remote.uniqueId!==device.uniqueId||remote.status!=='online')return false;
    const positions=(await this.request(`/positions?deviceId=${device.traccarId}`)).data;
    const latest=positions.find(p=>p.deviceId===device.traccarId&&p.id===remote.positionId);
    if(!latest||latest.protocol!==protocol||!latest.valid)return false;
    await this.ingest(device.id,latest);
    const lastSeen=Date.parse(remote.lastUpdate);
    if(Number.isFinite(lastSeen)&&lastSeen<=this.store.now())await this.store.seen(device.id,lastSeen);
    const types=(await this.request(`/commands/types?deviceId=${device.traccarId}&textChannel=false`)).data;
    return ['engineStop','engineResume'].every(type=>types.some(t=>t.type===type));
  }
  async sendRelay(device,action){
    const response=await this.request('/commands/send',{method:'POST',body:JSON.stringify({deviceId:device.traccarId,type:action==='inhibit'?'engineStop':'engineResume',textChannel:false,attributes:{noQueue:true}})});
    if(response.status!==200)throw new Error('Unexpected relay delivery response.');
    return {detail:'Gateway accepted the command. Physical starter-relay state has NOT been verified.'};
  }
}
