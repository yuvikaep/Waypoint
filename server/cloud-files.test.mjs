import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudFileHandler } from './cloud-files.mjs';

function response(){return {status:null,value:null,writeHead(status){this.status=status;},end(value){this.value=JSON.parse(value);}};}
test('private cloud download requires login and rejects another tenant before storage access',async()=>{
  const req={method:'GET',url:'/api/gps/files/download?pathname=tenants/other/files/test.pdf',headers:{}};
  let res=response();
  await createCloudFileHandler({authenticate:async()=>{throw Object.assign(Error('Sign in'),{status:401});}})(req,res);
  assert.equal(res.status,401);
  res=response();await createCloudFileHandler({authenticate:async()=>({role:'customer',tenantId:'mine'})})(req,res);
  assert.equal(res.status,403);assert.match(res.value.error,/another workspace/);
});
test('private cloud files reject path traversal, unexpected methods and malformed upload requests',async()=>{
  const handler=createCloudFileHandler({authenticate:async()=>({role:'customer',tenantId:'mine'})});
  for(const path of ['tenants/mine/files/../test.pdf','https://files.example/test.pdf','tenants/mine/files/test.svg']){
    const res=response();await handler({method:'GET',url:`/api/gps/files/download?pathname=${encodeURIComponent(path)}`,headers:{}},res);assert.equal(res.status,400);
  }
  let res=response();await handler({method:'DELETE',url:'/api/gps/files/download',headers:{}},res);assert.equal(res.status,405);
  res=response();await handler({method:'POST',url:'/api/gps/files/upload',headers:{},body:{type:'unexpected'}},res);assert.equal(res.status,400);
});
