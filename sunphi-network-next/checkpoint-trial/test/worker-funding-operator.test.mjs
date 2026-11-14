import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hash,verify} from '../crypto.mjs';
import {workerFundingOperator} from '../worker-funding-operator.mjs';
import {fixture} from './worker-funding-consent.test.mjs';

async function setup(){
 const f=await fixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'duebyte-funding-operator-'));
 const put=(name,value)=>{const file=path.join(dir,name);fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});return file;};
 const policy={isolatedFixture:true};put('app-config.json',f.x.c);put('trust-policy.json',policy);
 const keyFile=put('worker.json',{node:f.options.scope.node,...f.options.key}),request=put('owner-consent.json',f.consent),output=path.join(dir,'handoff.json');
 const cfg={format:'DUEBYTE_WORKER_FUNDING_OPERATOR_V1',profile:dir,policyPin:hash(policy),home:path.join(dir,'verifier'),binary:process.execPath,url:'http://127.0.0.1:1',bounded:{url:'http://127.0.0.1:2'},keyFile,scope:f.options.scope};
 const file=put('operator.json',cfg),calls=[];let closed=0;
 class Client{
  constructor(options){calls.push({construct:options});}
  async sync(cp,url,options){assert.deepEqual(cp,{testCheckpoint:true});assert.equal(url,cfg.url);assert.deepEqual(options,{owner:cfg.scope.owner,rewardIds:[cfg.scope.node]});calls.push({sync:options});return f.options.view(options);}
  close(){closed++;}
 }
 const deps={Client,query:async(url,method,params)=>{assert.equal(url,cfg.url);assert.equal(method,'abci_query');assert.deepEqual(params,{path:'/checkpoint'});return {response:{code:0,value:Buffer.from(JSON.stringify({testCheckpoint:true})).toString('base64')}};},now:f.options.now};
 return {...f,dir,put,cfg,file,request,output,deps,calls,getClosed:()=>closed,clean:()=>{f.r.db.close();fs.rmSync(dir,{recursive:true,force:true});}};
}

test('funding operator: bounded verified client handoff writes exact signatures without submission',async()=>{
 const f=await setup();try{
  const before=hash(f.r.s),result=await workerFundingOperator(f.file,f.request,f.output,f.deps),out=JSON.parse(fs.readFileSync(f.output));
  assert.equal(result.status,'SIGNED_NOT_SUBMITTED');assert.equal(result.submitted,false);assert.equal(hash(f.r.s),before);
  assert.deepEqual(out.action.body,f.consent.body);assert(verify(out.action.body,out.action.workerSignature,f.options.key.publicKey));
  assert(!fs.readFileSync(f.output,'utf8').includes(f.options.key.privateKey));assert.equal(f.calls[0].construct.home,f.cfg.home);assert.equal(f.getClosed(),1);
  await assert.rejects(workerFundingOperator(f.file,f.request,f.output,f.deps),/output already exists/);
  f.r.step([f.x.wire(out.action,f.x.f.alice)]);f.r.reopen();
  const second=path.join(f.dir,'already.json');assert.equal((await workerFundingOperator(f.file,f.request,second,f.deps)).status,'ALREADY_COMMITTED');
  assert.equal(JSON.parse(fs.readFileSync(second)).action,null);
 }finally{f.clean();}
});

test('funding operator: policy change, missing proof, expiry and occupied signer leave no output',async()=>{
 const f=await setup();try{
  f.put('trust-policy.json',{changed:true});await assert.rejects(workerFundingOperator(f.file,f.request,f.output,f.deps),/trust policy changed/);f.put('trust-policy.json',{isolatedFixture:true});
  await assert.rejects(workerFundingOperator(f.file,f.request,f.output,{...f.deps,query:async()=>({response:{code:1}})}),/checkpoint unavailable/);
  await assert.rejects(workerFundingOperator(f.file,f.request,f.output,{...f.deps,Client:class{sync(){throw new Error('certificate rejected');}close(){}}}),/certificate rejected/);
  await assert.rejects(workerFundingOperator(f.file,f.request,f.output,{...f.deps,now:()=>f.r.s.money.time*1000+61000}),/stale/);
  const lock=path.join(f.cfg.home,'funding-sign.lock');assert(!fs.existsSync(lock));fs.writeFileSync(lock,'other operator');
  await assert.rejects(workerFundingOperator(f.file,f.request,f.output,f.deps),/EEXIST/);assert.equal(fs.readFileSync(lock,'utf8'),'other operator');fs.unlinkSync(lock);
  assert(!fs.existsSync(f.output));assert.equal(f.getClosed(),2);
 }finally{f.clean();}
});

test('funding operator: production verifier cannot accept the fixture policy; malformed input and unsafe files fail closed',async()=>{
 const f=await setup();try{
  await assert.rejects(workerFundingOperator(f.file,f.request,f.output));assert(!fs.existsSync(f.output));
  fs.writeFileSync(f.request,' '.repeat(65537));await assert.rejects(workerFundingOperator(f.file,f.request,f.output,f.deps),/file size/);
  fs.writeFileSync(f.request,'{"secret":"DO_NOT_ECHO",');await assert.rejects(workerFundingOperator(f.file,f.request,f.output,f.deps),e=>e.message==='Invalid JSON file');
  f.put('owner-consent.json',f.consent);
  f.put('worker.json',{node:hash('other worker'),...f.options.key});await assert.rejects(workerFundingOperator(f.file,f.request,f.output,f.deps),/worker identity/);
  f.put('worker.json',{node:f.options.scope.node,...f.options.key});
  if(process.platform==='linux'){
   fs.chmodSync(f.cfg.keyFile,0o644);await assert.rejects(workerFundingOperator(f.file,f.request,f.output,f.deps),/must be private/);fs.chmodSync(f.cfg.keyFile,0o600);
   const link=path.join(f.dir,'symlink.json');fs.symlinkSync(f.request,link);await assert.rejects(workerFundingOperator(f.file,link,f.output,f.deps),/symbolic/);
  }
 }finally{f.clean();}
});
