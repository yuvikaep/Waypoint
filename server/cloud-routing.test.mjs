import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCloudRequest } from './cloud-routing.mjs';
test('Vercel rewrite preserves nested API paths and query parameters',()=>{
  const req={url:'/api/gps?__route=devices%2Fabc%2Fhistory&from=2026-10-14&after=3'};
  normalizeCloudRequest(req);assert.equal(req.url,'/api/gps/devices/abc/history?from=2026-10-14&after=3');
  const parsed={url:'/api/gps?pathname=tenants%2Fmine%2Ffiles%2Fx.pdf',query:{__route:'files/download'}};
  normalizeCloudRequest(parsed);assert.equal(new URL(parsed.url,'http://test').pathname,'/api/gps/files/download');
  assert.equal(new URL(parsed.url,'http://test').searchParams.get('pathname'),'tenants/mine/files/x.pdf');
  assert.throws(()=>normalizeCloudRequest({url:'/api/gps',query:{__route:'../../secret'}}),e=>e.status===400);
});
