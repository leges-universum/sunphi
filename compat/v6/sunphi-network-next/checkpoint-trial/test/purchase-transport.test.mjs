import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:https';
import {purchaseTlsFixture} from './helpers/purchase-tls-fixture.mjs';
import {serveSecurePurchaseBroker,securePurchaseRequest,purchaseTransport} from '../research/purchase-transport.mjs';
const dir=fs.mkdtempSync(join(tmpdir(),'purchase-tls-')),tls=purchaseTlsFixture(dir);
const profile=s=>({kind:'pinned-https-v1',url:s.url,spkiSha256:s.spkiSha256,caPem:tls.caPem});
const raw=(s,{method='POST',path='/purchase/v1',headers={},body='{}'}={})=>new Promise((resolve,reject)=>{
 const u=new URL(s.url);const q=request(u,{method,path,servername:u.hostname,ca:tls.caPem,agent:false,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),...headers}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});q.on('error',reject);q.end(body);
});
test('TLS authenticates certificate, hostname and pinned key before delivering buyer request',async()=>{
 let delivered=0;const s=await serveSecurePurchaseBroker({policy:{isolated:true},handle:async()=>({ok:++delivered})},tls);
 try{
  assert.deepEqual(await securePurchaseRequest(profile(s),{hello:'buyer'}),{ok:1});
  await assert.rejects(()=>securePurchaseRequest({...profile(s),spkiSha256:'0'.repeat(64)},{}));
  await assert.rejects(()=>securePurchaseRequest({...profile(s),caPem:null},{}));
  await assert.rejects(()=>securePurchaseRequest({...profile(s),url:s.url.replace('localhost','127.0.0.1')},{}));
  assert.equal(delivered,1);
  assert.throws(()=>purchaseTransport({...profile(s),url:s.url.replace('https:','http:')}));
  assert.throws(()=>purchaseTransport({...profile(s),url:s.url+'?redirect=https://example.com'}));
 }finally{await s.close();}
});
test('external gateway rejects browser origins, host substitution, generic RPC and oversized input',async()=>{
 let delivered=0;const s=await serveSecurePurchaseBroker({policy:{isolated:true},handle:()=>({ok:++delivered})},tls);
 try{
  for(const options of [{headers:{Origin:'https://example.com'}},{headers:{Host:'attacker.example'}},{method:'GET'},{path:'/admin'},{headers:{'Content-Type':'text/plain'}}])assert.equal(await raw(s,options),400);
  assert.equal(await raw(s,{body:'x'.repeat(16385)}),413);
  await assert.rejects(()=>securePurchaseRequest(profile(s),{data:'x'.repeat(16385)}));assert.equal(delivered,0);
 }finally{await s.close();}
});
test('rate limit uses socket peer rather than spoofable forwarded headers',async()=>{
 let delivered=0;const s=await serveSecurePurchaseBroker({policy:{isolated:true},handle:()=>({ok:++delivered})},{...tls,maxPerMinute:2});
 try{
  assert.equal(await raw(s,{headers:{'X-Forwarded-For':'192.0.2.1'}}),200);
  assert.equal(await raw(s,{headers:{'X-Forwarded-For':'192.0.2.2'}}),200);
  assert.equal(await raw(s,{headers:{'X-Forwarded-For':'192.0.2.3'}}),429);assert.equal(delivered,2);
 }finally{await s.close();}
});
test('invalid and excessive replies fail closed; no production admission',async()=>{
 await assert.rejects(()=>serveSecurePurchaseBroker({policy:{isolated:false}},tls));
 const s=await serveSecurePurchaseBroker({policy:{isolated:true},handle:()=>({data:'x'.repeat(4*1024*1024)})},tls);
 try{await assert.rejects(()=>securePurchaseRequest(profile(s),{}));}finally{await s.close();}
});
test('complete request may wait beyond body timeout for committed reservation',async()=>{
 const s=await serveSecurePurchaseBroker({policy:{isolated:true},handle:async()=>{await new Promise(resolve=>setTimeout(resolve,16000));return {committed:true};}},tls);
 try{assert.deepEqual(await securePurchaseRequest(profile(s),{}),{committed:true});}finally{await s.close();}
});

test('Home cancellation interrupts an outstanding TLS poll and next request remains usable',async()=>{
 let entered,release,first=true;const admitted=new Promise(r=>entered=r),pending=new Promise(r=>release=r);
 const s=await serveSecurePurchaseBroker({policy:{isolated:true},handle:async()=>{if(first){first=false;entered();await pending;}return {job:null};}},tls);
 try{
  const controller=new AbortController(),response=securePurchaseRequest(profile(s),{action:'poll'},{signal:controller.signal,timeoutMs:3000});
  await admitted;controller.abort();await assert.rejects(()=>response);release();
  assert.deepEqual(await securePurchaseRequest(profile(s),{action:'poll'}),{job:null});
 }finally{release();await s.close();}
});
