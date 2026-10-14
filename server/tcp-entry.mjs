import { createServer, createConnection } from 'node:net';
import { pathToFileURL } from 'node:url';

// This entry only transports bytes. Traccar remains the sole GPS decoder.
// Existing HTTP redirects and certificate challenges go to local Caddy.
export function createTcpEntry({gpsPort=5023,httpPort=8080,host='127.0.0.1'}={}){
  return createServer(client=>{
    let buffered=Buffer.alloc(0),upstream;
    client.setTimeout(15000,()=>client.destroy());
    client.on('error',()=>upstream?.destroy());
    client.on('close',()=>upstream?.destroy());
    const inspect=chunk=>{
      buffered=Buffer.concat([buffered,chunk]);
      if(buffered.length>16384){client.destroy();return;}
      if(buffered.length<2)return;
      const gps=(buffered[0]===0x78&&buffered[1]===0x78)||(buffered[0]===0x79&&buffered[1]===0x79);
      const text=buffered.toString('ascii');
      const methods=['GET ','HEAD ','POST ','PUT ','PATCH ','DELETE ','OPTIONS '];
      const http=methods.some(method=>text.startsWith(method));
      if(!gps&&!http){if(methods.some(method=>method.startsWith(text)))return;client.destroy();return;}
      client.pause();client.off('data',inspect);client.setTimeout(gps?300000:30000);
      upstream=createConnection({host,port:gps?gpsPort:httpPort});
      upstream.setTimeout(300000,()=>upstream.destroy());
      upstream.on('error',()=>client.destroy());
      upstream.on('close',()=>client.destroy());
      upstream.on('connect',()=>{upstream.write(buffered);buffered=Buffer.alloc(0);client.pipe(upstream);upstream.pipe(client);client.resume();});
    };
    client.on('data',inspect);
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const server=createTcpEntry();
  server.listen(80,'0.0.0.0',()=>console.log('GT06 alternate TCP entry and HTTP forwarding ready.'));
  process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
}
