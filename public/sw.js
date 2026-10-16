// Waypoint service worker: shows fleet alerts on the phone even when the app is closed.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('push',e=>{
  let d={};try{d=e.data?e.data.json():{}}catch{d={title:'Waypoint',body:e.data?.text()||''}}
  const urgent=!!d.urgent;
  e.waitUntil(self.registration.showNotification(d.title||'Waypoint',{
    body:d.body||'',tag:d.tag,renotify:true,icon:'/icon-192.png',badge:'/icon-192.png',
    requireInteraction:urgent,vibrate:urgent?[500,150,500,150,800,150,800]:[200,100,200],silent:false,
    data:{url:d.url||'/?live=1'}}));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const url=new URL(e.notification.data?.url||'/?live=1',self.location.origin).href;
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const c of list)if(new URL(c.url).origin===self.location.origin&&'focus'in c)return c.focus();
    return self.clients.openWindow(url);
  }));
});
