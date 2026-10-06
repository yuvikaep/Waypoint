export const DEMO_MODE=new URLSearchParams(location.search).has('demo');
export const workspaceStorage={
  getItem:(key:string)=>window.localStorage.getItem(DEMO_MODE?'demo:'+key:key),
  setItem:(key:string,value:string)=>window.localStorage.setItem(DEMO_MODE?'demo:'+key:key,value)
};
const storageKey='waypoint-preview-v1';
const now=()=>Date.now();
const names=['MH 12 PQ 4821','MH 14 GT 9032','MH 12 AB 7654','MH 04 JK 2190','MH 12 CD 5588','MH 14 RS 6071'];
function seed(){
  const states=['Moving','Moving','Stopped','Moving','Offline','Stopped'];
  const points=[[18.755,73.43],[18.60,73.76],[18.52,73.88],[19.02,73.14],[18.84,73.28],[18.69,73.82]];
  const drivers=['Rajesh Kumar','Suresh Patil','Amit Singh','Vijay More','Prakash Jadhav','Deepak Shinde'];
  const routes:Record<string,any[]>={};
  const devices=names.map((name,index)=>{
    const id=`demo-vehicle-${index+1}`,at=now()-(index===4?7200000:5000);
    routes[id]=Array.from({length:36},(_,n)=>({id:index*100+n+1,deviceId:id,recordedAt:at-(35-n)*60000,receivedAt:at-(35-n)*60000,latitude:points[index][0]-(35-n)*.001,longitude:points[index][1]+(35-n)*.0012,speed:states[index]==='Moving'?45+index*4:0,heading:310,accuracy:7,ignition:states[index]==='Moving'?1:0,battery:86-index*3,satellites:10}));
    return {id,name,uniqueId:`86000000000000${index+1}`,model:index===2?'Mobile':index%2?'FMB920':'GT06',driver:drivers[index],lastSeen:at,offlineSeconds:180,speedLimit:80,bridgeStatus:'Demo gateway',traccarId:index+1,status:states[index],online:index!==4,fresh:index!==4,position:routes[id].at(-1),command:null};
  });
  return {devices,routes,fences:[{id:'demo-depot',name:'Pune depot',latitude:18.52,longitude:73.88,radius:1500}],alerts:[{id:'demo-alert-1',deviceId:devices[4].id,deviceName:names[4],type:'offline',message:'Demo: tracker has not reported for two hours.',createdAt:now()-7200000,acknowledged:0},{id:'demo-alert-2',deviceId:devices[0].id,deviceName:names[0],type:'speed',message:'Demo: recorded 84 km/h against an 80 km/h limit.',createdAt:now()-240000,acknowledged:0},{id:'demo-alert-3',deviceId:devices[2].id,deviceName:names[2],type:'enter',message:'Demo: vehicle entered Pune depot.',createdAt:now()-60000,acknowledged:0}]};
}
function read():ReturnType<typeof seed>{try{const saved=JSON.parse(window.localStorage.getItem(storageKey)||'null');if(saved?.devices&&saved?.routes)return saved}catch{}return seed()}
function save(data:ReturnType<typeof seed>){window.localStorage.setItem(storageKey,JSON.stringify(data))}
export async function demoRequest(path:string,options:RequestInit={}):Promise<any>{
  const data=read(),url=new URL(path,'http://demo'),method=options.method||'GET';
  const body=options.body?JSON.parse(String(options.body)):{};
  let result:any;
  if(url.pathname==='/state'){
    for(const d of data.devices){
      if(d.status==='Moving'||d.status==='Stopped'){
        if(d.position&&d.status==='Moving'&&now()-d.position.recordedAt>2500){d.position={...d.position,latitude:d.position.latitude+.00006,longitude:d.position.longitude-.00004,recordedAt:now(),receivedAt:now(),id:now()};data.routes[d.id].push(d.position);data.routes[d.id]=data.routes[d.id].slice(-1000)}
        d.lastSeen=now();if(d.position)d.position.recordedAt=now();
      }
    }
    result={...data,gateway:{configured:true,connected:true,lastSync:now(),error:null},serverTime:now()};
  }else if(url.pathname==='/devices'&&method==='POST'){
    if(!body.name?.trim())throw new Error('Vehicle name is required.');
    if(body.model!=='Mobile'&&!/^\d{15}$/.test(body.uniqueId||''))throw new Error('Enter a 15-digit IMEI.');
    if(body.uniqueId&&data.devices.some(d=>d.uniqueId===body.uniqueId))throw new Error('Identifier is already registered in this demo.');
    const device:any={id:crypto.randomUUID(),name:body.name,uniqueId:body.uniqueId||'demo-mobile-'+Date.now(),model:body.model,driver:body.driver||'',lastSeen:null,offlineSeconds:body.offlineSeconds,speedLimit:body.speedLimit,bridgeStatus:'Demo gateway',traccarId:null,status:'Waiting',online:false,fresh:false,position:null,command:null};
    data.devices.push(device);data.routes[device.id]=[];result={device,token:body.model==='Mobile'?'demo-only':null};
  }else if(url.pathname.startsWith('/devices/')){
    const [, ,id,action]=url.pathname.split('/');const d:any=data.devices.find(d=>d.id===id);if(!d)throw new Error('Demo device not found.');
    if(action==='history'){const from=Date.parse(url.searchParams.get('from')||''),to=Date.parse(url.searchParams.get('to')||'');result={positions:(data.routes[id]||[]).filter(p=>p.recordedAt>=from&&p.recordedAt<=to),next:null};}
    else if(action==='ping'){
      d.command={status:'answered',detail:'Demo response received. No real tracker was contacted.',createdAt:now()};d.lastSeen=now();d.online=true;d.fresh=true;if(d.position)d.position.recordedAt=now();d.status=d.position?.speed?'Moving':'Stopped';result=d.command;
    }else if(action==='driver-link'){result=method==='DELETE'?{ok:true}:{code:`demo:${d.id}`,expiresAt:now()+7*86400000};}
    else throw new Error('Not available in the demo.');
  }else if(url.pathname==='/fences'&&method==='POST'){
    if(!body.name||body.radius<50||body.radius>100000||Math.abs(body.latitude)>90||Math.abs(body.longitude)>180)throw new Error('Enter a valid geofence name, coordinates and radius.');
    result={...body,id:crypto.randomUUID()};data.fences.push(result);
  }else if(url.pathname.startsWith('/fences/')&&method==='DELETE'){data.fences=data.fences.filter(f=>f.id!==url.pathname.split('/')[2]);result={ok:true};}
  else if(url.pathname.startsWith('/alerts/')){const alert=data.alerts.find(a=>a.id===url.pathname.split('/')[2]);if(alert)alert.acknowledged=1;result={ok:true};}
  else if(url.pathname==='/sender/join'||url.pathname==='/sender/me'){
    const id=body.code?.replace(/^demo:/,'')||sessionStorage.getItem('demo-driver')||'demo-vehicle-3';
    const device=data.devices.find(d=>d.id===id);if(!device)throw new Error('Demo vehicle not found.');sessionStorage.setItem('demo-driver',id);result={device};
  }else if(url.pathname==='/sender/heartbeat'){result={commands:[]};}
  else if(url.pathname==='/session'){result={ok:true};}
  else throw new Error('Not available in the demo.');
  save(data);return structuredClone(result);
}
export function demoDocuments(){return names.map((vehicle,n)=>({vehicle,type:n%2?'Insurance policy':'Registration certificate',number:`DEMO-DOC-${n+1}`,expiry:new Date(now()+(n===1?12:120+n*20)*86400000).toISOString().slice(0,10),issuer:'Demo records',notes:'Sample document for preview.'}))}
export function demoBills(){return names.slice(0,3).map((vehicle,n)=>({number:`11110000000${n+1}`,vehicle,invoice:`DEMO-INV-${n+1}`,consignor:'Demo logistics',consignee:'Demo warehouse',origin:'Pune',destination:n?'Nashik':'Mumbai',generated:new Date(now()-3600000).toISOString(),validUntil:new Date(now()+(n?48:12)*3600000).toISOString(),status:'Issued',notes:'Sample only. Not a valid issued e-way bill.'}))}
