export function normalizeCloudRequest(req){
  const url=new URL(req.url,'http://localhost');
  const route=req.query?.__route??url.searchParams.get('__route');
  if(route!==undefined&&route!==null){
    if(typeof route!=='string'||!/^[A-Za-z0-9_/-]+$/.test(route))throw Object.assign(new Error('Invalid API route.'),{status:400});
    url.pathname=`/api/gps/${route}`;url.searchParams.delete('__route');req.url=url.pathname+url.search;
  }
}
