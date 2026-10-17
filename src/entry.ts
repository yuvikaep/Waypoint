const params=new URLSearchParams(location.search);
if(!['localhost','127.0.0.1'].includes(location.hostname)){
  params.delete('demo');
  for(const key of Object.keys(window.localStorage))if(/^(waypoint-|tenant:|demo:)/.test(key))window.localStorage.removeItem(key);
}
if(params.get('workspace')==='documents'){
  params.delete('workspace');params.set('view','Documents');
}
if(!params.has('live')&&!params.has('sender')&&!params.has('demo'))params.set('live','1');
window.history.replaceState(null,'',location.pathname+'?'+params+location.hash);
// Only the Android app build sets an API origin; the website never loads the native plugins.
if(import.meta.env.VITE_API_ORIGIN)void import('./shared/native').then(m=>m.startNative()).catch(()=>{});
void import('./live');
