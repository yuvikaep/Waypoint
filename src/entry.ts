const params=new URLSearchParams(location.search);
if(params.get('workspace')==='documents'){
  params.delete('workspace');params.set('view','Documents');
}
if(!params.has('live')&&!params.has('sender')&&!params.has('demo'))params.set('live','1');
window.history.replaceState(null,'',location.pathname+'?'+params+location.hash);
void import('./live');
