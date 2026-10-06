export class TraccarBridge {
  constructor(store, { url, token, fetcher = fetch } = {}) {
    this.store=store; this.url=url?.replace(/\/$/,''); this.token=token; this.fetcher=fetcher;
    this.state={configured:!!(url && token),connected:false,lastSync:null,error:null};
  }
  async request(path, options={}) {
    if (!this.state.configured) throw new Error('Set TRACCAR_URL and TRACCAR_TOKEN to connect hardware trackers.');
    const response=await this.fetcher(`${this.url}/api${path}`,{...options,headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json',Accept:'application/json'},signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error(`Tracker gateway returned HTTP ${response.status}.`);
    return {status:response.status,data:response.status===204?null:await response.json()};
  }
  async sync() {
    if (this.busy || !this.state.configured) return;
    this.busy=true;
    try {
      const remote=(await this.request('/devices')).data;
      const current=(await this.request('/positions')).data;
      const failures=[];
      for (const device of this.store.devices().filter(d=>d.model!=='Mobile')) {
        try {
          let match=remote.find(d=>d.uniqueId===device.uniqueId);
          if (!match) {
            match=(await this.request('/devices',{method:'POST',body:JSON.stringify({name:device.name,uniqueId:device.uniqueId,model:device.model})})).data;
            remote.push(match);
          }
          this.store.db.prepare('UPDATE devices SET traccarId=?,bridgeStatus=? WHERE id=?').run(match.id,match.status || 'unknown',device.id);
          const lastSeen=Date.parse(match.lastUpdate);
          if (Number.isFinite(lastSeen) && lastSeen<=this.store.now()+60000) this.store.seen(device.id,lastSeen);
          const latest=current.find(p=>p.deviceId===match.id);
          // Backfill bounded windows with overlap; source position IDs deduplicate retries.
          // Record historical points before the current fix so fence transitions stay ordered.
          const from=Math.max(device.createdAt-60000,(device.cursor ?? device.createdAt)-60000);
          const to=Math.min(from+15*60000,this.store.now());
          const history=(await this.request(`/positions?${new URLSearchParams({deviceId:String(match.id),from:new Date(from).toISOString(),to:new Date(to).toISOString()})}`)).data;
          for (const position of history.sort((a,b)=>Date.parse(a.fixTime)-Date.parse(b.fixTime))) this.ingest(device.id,position);
          this.store.db.prepare('UPDATE devices SET cursor=? WHERE id=?').run(to,device.id);
          if (latest) this.ingest(device.id,latest);
        } catch (e) {
          this.store.db.prepare('UPDATE devices SET bridgeStatus=? WHERE id=?').run(`Sync failed: ${e.message}`,device.id);
          failures.push(`${device.name}: ${e.message}`);
        }
      }
      this.state={...this.state,connected:failures.length===0,lastSync:this.store.now(),error:failures.length?failures.join(' '):null};
    } catch (e) { this.state={...this.state,connected:false,error:e.message}; }
    finally { this.busy=false; }
  }
  ingest(id,p) {
    if (!p.valid || !p.id) return;
    const attrs=p.attributes || {};
    this.store.ingest(id,{eventId:`traccar:${p.id}`,recordedAt:p.fixTime,latitude:p.latitude,longitude:p.longitude,
      speed:Math.max(0,p.speed*1.852),heading:p.course,accuracy:p.accuracy,
      ignition:attrs.ignition,battery:attrs.batteryLevel,satellites:attrs.sat},
    {receivedAt:Date.parse(p.serverTime) || this.store.now(),heartbeat:false});
  }
  async importHistory(device,from,to) {
    if(!device.traccarId)throw new Error('Device is not yet linked to the gateway.');
    const result=await this.request(`/positions?${new URLSearchParams({deviceId:String(device.traccarId),from:new Date(from).toISOString(),to:new Date(to).toISOString()})}`);
    for(const position of result.data.sort((a,b)=>Date.parse(a.fixTime)-Date.parse(b.fixTime)))this.ingest(device.id,position);
  }
  async ping(device) {
    if (!device.traccarId) throw new Error('Device is not registered with the tracker gateway yet.');
    const types=(await this.request(`/commands/types?deviceId=${device.traccarId}&textChannel=false`)).data;
    if (!types.some(t=>t.type==='positionSingle')) return {status:'unsupported',detail:'This tracker does not advertise an on-demand location command. Scheduled reports remain active.'};
    const response=await this.request('/commands/send',{method:'POST',body:JSON.stringify({deviceId:device.traccarId,type:'positionSingle',textChannel:false,attributes:{}})});
    return {status:response.status===202?'queued':'sent',detail:response.status===202?'Gateway queued the location request.':'Location request sent to the tracker. Awaiting a fresh fix.'};
  }
}
