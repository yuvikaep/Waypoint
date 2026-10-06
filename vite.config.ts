import {defineConfig,loadEnv} from 'vite';
import {readFile} from 'node:fs/promises';
export default defineConfig(({mode})=>{const env=loadEnv(mode,process.cwd(),'');return {plugins:[{
  name:'local-workspace-session',
  configureServer(server){
    server.middlewares.use('/__local/workspace-session',async(req,res)=>{
      const address=req.socket.remoteAddress;
      const host=req.headers.host||'';
      // This convenience login exists only in Vite, for same-origin loopback requests.
      const allowed=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address||'')
        && /^(127\.0\.0\.1|localhost):\d+$/.test(host)
        && req.headers.origin===`http://${host}`
        && req.headers['sec-fetch-site']==='same-origin'
        && !Object.keys(req.headers).some(key=>key==='forwarded'||key.startsWith('x-forwarded-'));
      if(req.method!=='POST'||!allowed){res.statusCode=403;res.end();return;}
      try{
        const token=(await readFile('server/private/admin-token','utf8')).trim();
        const response=await fetch(`http://127.0.0.1:${process.env.GPS_PORT||env.GPS_PORT||5180}/api/gps/session`,{
          method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token}),signal:AbortSignal.timeout(5000)
        });
        const cookie=response.headers.get('set-cookie');
        if(response.ok&&cookie)res.setHeader('Set-Cookie',cookie);
        res.setHeader('Cache-Control','no-store');
        res.statusCode=response.ok?204:503;res.end();
      }catch{res.statusCode=503;res.end();}
    });
  }
}],server:{proxy:{
  '/api/gps':{target:`http://127.0.0.1:${process.env.GPS_PORT||env.GPS_PORT||5180}`},
  '/api':{target:'http://127.0.0.1:5174',changeOrigin:true}
}}};});
