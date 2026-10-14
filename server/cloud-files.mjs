import { get } from '@vercel/blob';
import { handleUpload } from '@vercel/blob/client';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const maximumSizeInBytes=2*1024*1024;
const allowedContentTypes=['application/pdf','image/png','image/jpeg','image/webp'];
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
function authorize(pathname,session){
  if(!session||!['admin','customer'].includes(session.role)||typeof session.tenantId!=='string'||!/^[A-Za-z0-9_-]+$/.test(session.tenantId))fail(403,'Workspace access required.');
  // Accept only canonical paths, never URLs, encoded separators or nested paths.
  if(typeof pathname!=='string'||!/^tenants\/[A-Za-z0-9_-]+\/files\/[A-Za-z0-9_-]+\.(pdf|png|jpg|jpeg|webp)$/.test(pathname))fail(400,'Invalid attachment pathname.');
  if(!pathname.startsWith(`tenants/${session.tenantId}/files/`))fail(403,'Attachment belongs to another workspace.');
  return pathname;
}
async function readBody(req){
  if(req.body!==undefined){
    const value=typeof req.body==='string'||Buffer.isBuffer(req.body)?JSON.parse(String(req.body)):req.body;
    if(Buffer.byteLength(JSON.stringify(value))>16384)fail(413,'Upload request is too large.');
    return value;
  }
  const chunks=[];let size=0;
  for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>16384)fail(413,'Upload request is too large.');chunks.push(Buffer.from(chunk));}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'Invalid upload request.');}
}
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};

// Node/Vercel handler: returns false for unrelated routes and true when handled.
export function createCloudFileHandler({authenticate}){
  if(typeof authenticate!=='function')throw new TypeError('authenticate is required.');
  return async function cloudFiles(req,res){
    const url=new URL(req.url,'http://localhost');
    if(!['/api/gps/files/upload','/api/gps/files/download'].includes(url.pathname))return false;
    try{
      if(url.pathname==='/api/gps/files/upload'){
        if(req.method!=='POST')fail(405,'Method not allowed.');
        const body=await readBody(req);
        if(!body||!['blob.generate-client-token','blob.upload-completed'].includes(body.type))fail(400,'Invalid upload request.');
        const result=await handleUpload({body,request:req,
          onBeforeGenerateToken:async pathname=>{
            const session=await authenticate(req);
            authorize(pathname,session);
            return {allowedContentTypes,maximumSizeInBytes,addRandomSuffix:true,allowOverwrite:false,validUntil:Date.now()+5*60000,tokenPayload:JSON.stringify({tenantId:session.tenantId,role:session.role})};
          },
          // handleUpload verifies Vercel's signature before invoking this callback.
          onUploadCompleted:async({blob,tokenPayload})=>{authorize(blob.pathname,JSON.parse(tokenPayload||'null'));}
        });
        json(res,200,result);
      }else{
        if(req.method!=='GET')fail(405,'Method not allowed.');
        const session=await authenticate(req);
        const pathname=authorize(url.searchParams.get('pathname'),session);
        const result=await get(pathname,{access:'private'});
        if(!result||result.statusCode!==200||!result.stream)fail(404,'Attachment not found.');
        if(!allowedContentTypes.includes(result.blob.contentType)||result.blob.size>maximumSizeInBytes){await result.stream.cancel();fail(415,'Unsupported attachment.');}
        res.writeHead(200,{'Content-Type':result.blob.contentType,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`inline; filename="${pathname.split('/').at(-1)}"`});
        await pipeline(Readable.fromWeb(result.stream),res);
      }
    }catch(error){
      if(res.headersSent){res.destroy(error);return true;}
      const status=Number(error.status||error.statusCode)||500;
      json(res,status>=400&&status<600?status:500,{error:status<500?error.message:'Could not access cloud attachment.'});
    }
    return true;
  };
}
