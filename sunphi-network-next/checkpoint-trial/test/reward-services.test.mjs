import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {MAX_ACTIVE_VALIDATORS} from '../validator-authority.mjs';
import {startRewardSignerHTTP,remoteRewardSigner,runRewardService,readServerWorkKey} from '../reward-services.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {hash,keys} from '../crypto.mjs';
import {serverWorkStatus} from '../server-management.mjs';

test('managed paid work pins the existing work identity and reads only local status',async()=>{
 const root=mkdtempSync(join(tmpdir(),'paid-service-')),profile=join(root,'profile'),home=join(root,'work');mkdirSync(profile);mkdirSync(home);
 writeFileSync(join(profile,'app-config.json'),JSON.stringify({chainId:'synthetic-service'}));writeFileSync(join(profile,'trust-policy.json'),'{}');
 const key={node:'a'.repeat(64),...keys()},keyFile=join(root,'work-key.json');writeFileSync(keyFile,JSON.stringify(key),{mode:0o600});
 assert.deepEqual(readServerWorkKey(keyFile,key.node,key.publicKey),key);
 assert.throws(()=>readServerWorkKey(keyFile,'b'.repeat(64),key.publicKey),/node pin/);
 assert.throws(()=>readServerWorkKey(keyFile,key.node,keys().publicKey),/public key pin/);
 const file=join(root,'service.json'),cfg={mode:'service-work',enabled:false,profile,home,url:'http://127.0.0.1:1',policyPin:hash({}),keyFile:'intentionally-missing'};
 writeFileSync(file,JSON.stringify(cfg),{mode:0o600});await runRewardService(file);
 assert.equal(JSON.parse(readFileSync(join(home,'status.json'))).monetaryActions,0);
 const row={role:'work',argv:['node','reward-services.mjs',file]},now=Date.now();
 writeFileSync(join(home,'status.json'),JSON.stringify({at:new Date(now).toISOString(),ok:true,serviceWork:{status:'ACCEPTED'},verifiedAt:new Date(now-5000).toISOString()}));
 assert.equal(serverWorkStatus(row,now).status,'Work accepted');assert.match(serverWorkStatus(row,now).detail,/UTC day/);
 assert.equal(serverWorkStatus(row,now+31000).status,'Checking work status');
 writeFileSync(join(home,'status.json'),JSON.stringify({at:new Date(now).toISOString(),ok:false}));assert.equal(serverWorkStatus(row,now).status,'Retrying work verification');
 writeFileSync(file,JSON.stringify({...cfg,enabled:true,bounded:{},custody:[]}),{mode:0o600});await assert.rejects(()=>runRewardService(file),/must not contain/);
});

test('indexed warmup service refuses ambiguous or unpinned configurations before creating keys',async()=>{
 const root=mkdtempSync(join(tmpdir(),'warmup-service-')),profile=join(root,'profile');mkdirSync(profile);
 writeFileSync(join(profile,'app-config.json'),JSON.stringify({chainId:'synthetic-service'}));
 writeFileSync(join(profile,'trust-policy.json'),'{}');
 const base={mode:'warmup',enabled:true,bounded:{url:'http://127.0.0.1:1'},url:'http://127.0.0.1:1',profile,policyPin:hash({}),centuryPlanHash:'a'.repeat(64)};
 for(const [i,over] of [{centuryPlanHash:null},{custody:[]},{reservePolicyHash:'b'.repeat(64)},{launchPolicyHash:'b'.repeat(64)},{bounded:null}].entries()){
  const home=join(root,'home'+i),file=join(root,'config'+i+'.json');writeFileSync(file,JSON.stringify({...base,...over,home}),{mode:0o600});
  await assert.rejects(()=>runRewardService(file),/warmup|ambiguous/);assert(!existsSync(join(home,'runner-author.json')));
 }
 const home=join(root,'disabled'),file=join(root,'disabled.json');writeFileSync(file,JSON.stringify({...base,enabled:false,home,custody:[{vaultFile:'not-readable'}]}),{mode:0o600});
 await runRewardService(file);assert.equal(JSON.parse(readFileSync(join(home,'status.json'))).monetaryActions,0);assert(!existsSync(join(home,'runner-author.json')));
});
test('loopback signer rejects browser requests and invalid proposals; transport retries after a busy signer',async()=>{
 let release,calls=0;const gate=new Promise(r=>release=r),server=await startRewardSignerHTTP({port:0,signer:{approve:async p=>{calls++;assert.equal(p.kind,'expected');if(p.wait)await gate;return[{key:'public',signature:'signature'}];}}});
 const url=`http://127.0.0.1:${server.port}/approve`,request=remoteRewardSigner(url);
 try{
  assert.throws(()=>remoteRewardSigner('https://example.com/approve'));assert.throws(()=>remoteRewardSigner('http://127.0.0.1:80/other'));
  const browser=await fetch(url,{method:'POST',headers:{'content-type':'application/json',origin:'https://example.com'},body:'{}'});assert.equal(browser.status,400);assert.equal(calls,0);
  await assert.rejects(()=>request({kind:'arbitrary'}),/unavailable/);
  const first=request({kind:'expected',wait:true});while(calls<2)await new Promise(r=>setTimeout(r,5));
  await assert.rejects(()=>request({kind:'expected'}),/unavailable/);release();assert.deepEqual(await first,[{key:'public',signature:'signature'}]);
  assert.deepEqual(await request({kind:'expected'}),[{key:'public',signature:'signature'}]);
 }finally{release();await server.close();}
});

test('signer transport supports the authority envelope and bounds chunked response bytes',async()=>{
 const approval={key:'k'.repeat(43),signature:'s'.repeat(86)},server=await startRewardSignerHTTP({port:0,signer:{approve:async p=>Array(p.count).fill(approval)}});
 try{
  const request=remoteRewardSigner(`http://127.0.0.1:${server.port}/approve`);
  assert.equal((await request({count:MAX_ACTIVE_VALIDATORS})).length,MAX_ACTIVE_VALIDATORS);
  await assert.rejects(()=>request({count:MAX_ACTIVE_VALIDATORS+1}),/approval count/);
 }finally{await server.close();}
 const oversized=http.createServer((req,res)=>{req.resume();res.writeHead(200,{'content-type':'application/json'});res.write('{"approvals":[],"padding":"');for(let i=0;i<64;i++)res.write('x'.repeat(1024));res.end('"}');});
 await new Promise(r=>oversized.listen(0,'127.0.0.1',r));
 try{await assert.rejects(()=>remoteRewardSigner(`http://127.0.0.1:${oversized.address().port}/approve`)({}),/response too large/);}
 finally{await new Promise(r=>{oversized.close(r);oversized.closeAllConnections();});}
});
