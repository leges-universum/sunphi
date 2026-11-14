import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {consumerRuntime,verifyCompatibilityRuntime,serviceRuntime} from '../runtime-compatibility.mjs';
import {readApplicationAuth} from '../application-auth.mjs';
import {keys,hash,sign} from '../crypto.mjs';
import {cleanConfig} from '../research/fresh-chain-preparation.mjs';
import {prepareIndexedSchemaUpgrade} from '../research/indexed-schema-upgrade.mjs';
import {persistIndexedSchemaBoundary} from '../research/indexed-schema-readiness.mjs';
const root=process.env.DUEBYTE_COMPAT_PACKAGE??path.resolve(import.meta.dirname,'../../..');
const read=file=>JSON.parse(fs.readFileSync(file));
const profile=read(path.join(root,'connection-profile.json')),pin=read(path.join(root,'connection-pin.json')).sha256;
const runtime=await consumerRuntime(root,profile,pin);
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'duebyte-compat-'));t.after(()=>{assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});});return dir;}
async function port(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('packaged compatibility interpreter authenticates the unchanged released genesis',async()=>{
 assert.equal(runtime.kind,'v6');assert.equal(runtime.directory,verifyCompatibilityRuntime(root));
 const changed=structuredClone(profile);changed.fresh.manifest.root='a'.repeat(64);
 await assert.rejects(consumerRuntime(root,changed,pin));await assert.rejects(consumerRuntime(root,profile,'b'.repeat(64)));
});
test('unrecognized compatibility code is refused before importing it',async t=>{
 const dir=temp(t);for(const name of ['release-config.json','update-root.json'])fs.copyFileSync(path.join(root,name),path.join(dir,name));
 fs.mkdirSync(path.join(dir,'compat/v6'),{recursive:true});fs.writeFileSync(path.join(dir,'compat/v6/manifest.json'),'{}');
 assert.throws(()=>verifyCompatibilityRuntime(dir),/unrecognized/);
});
test('ordinary packaged application preserves V6 commits and restart without changing the profile',async t=>{
 const home=temp(t),appPort=await port(),readPort=await port();
 for(const [name,value]of [['app-config.json',profile.config],['trust-policy.json',profile.policy],['fresh-activation.json',{...profile.fresh,readPort}]])fs.writeFileSync(path.join(home,name),JSON.stringify(value));
 const {createFreshChain}=await runtime.load('research/fresh-chain-preparation');
 const created=createFreshChain(path.join(home,'application-indexed.sqlite'),profile.config);assert.equal(created.manifest.root,profile.fresh.manifest.root);created.handler.close();
 assert.equal((await serviceRuntime(root,home)).kind,'v6');
 const query=async q=>{const r=await fetch('http://127.0.0.1:'+appPort,{method:'POST',headers:{'Content-Type':'application/json','x-duebyte-app-auth':readApplicationAuth(home)},body:JSON.stringify(q)});const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b;};
 let child;
 async function start(){child=spawn(process.execPath,[path.join(root,'sunphi-network-next/checkpoint-trial/app.mjs'),home,String(appPort)],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  for(let i=0;i<300;i++){if(child.exitCode!==null)throw Error(output);if(output.includes('app ready'))return;await new Promise(r=>setTimeout(r,100));}throw Error('Application startup timeout: '+output);
 }
 async function stop(){if(child&&child.exitCode===null){const closed=once(child,'close');child.kill('SIGTERM');await closed;}child=null;}
 t.after(stop);await start();const initial=await query({method:'info'});assert.equal(initial.height,0);
 const result=await query({method:'finalize',height:1,hash:Buffer.alloc(32,3).toString('base64'),time:profile.config.initial.time+10,txs:[]});await query({method:'commit'});await stop();await start();
 const restored=await query({method:'info'});assert.equal(restored.height,1);assert.equal(restored.hash,result.hash);await stop();
 assert.deepEqual(read(path.join(home,'app-config.json')),profile.config);assert(!fs.existsSync(path.join(home,'indexed-schema-activation.json')));
});
test('packaged application enforces the persisted old-rule boundary before and after restart',async t=>{
 const home=temp(t),validators=Array.from({length:10},keys),members=Array.from({length:4},keys),now=Math.floor(Date.now()/1000);
 const config=cleanConfig({chainId:'duebyte-trial-compat-guard-test',previousChainId:'other',time:now,control:{validators:validators.map((k,i)=>({key:k.publicKey,group:hash(i)})),policy:{version:1,members:members.map((k,i)=>({key:k.publicKey,group:hash(i)})),threshold:3,maxAge:3600,notAfter:now+86400}}});
 const {createFreshChain}=await runtime.load('research/fresh-chain-preparation'),source=path.join(home,'application-indexed.sqlite'),created=createFreshChain(source,config),manifest=created.manifest;
 created.handler.commitBlock({height:1,time:now+10,blockHash:hash('old'),txs:[]},created.handler.root);
 const state=created.handler.snapshotForAudit(),trustedBoundary={network:config.chainId,configHash:hash(config),genesisRoot:manifest.root,height:1,root:created.handler.root,journalHash:created.handler.store.meta.journalHash,generation:state.authority.generation,validators:state.authority.validators};created.handler.close();
 const prepared=prepareIndexedSchemaUpgrade({source,target:path.join(home,'converted.sqlite'),config,trustedBoundary}),certificate={body:prepared.body,approvals:validators.slice(0,7).map(k=>({key:k.publicKey,signature:sign(prepared.body,k.privateKey)}))};
 const appPort=await port(),readPort=await port(),write=(name,value)=>fs.writeFileSync(path.join(home,name),JSON.stringify(value));
 write('app-config.json',config);write('trust-policy.json',{...profile.policy,network:config.chainId,...config.control.policy});write('fresh-activation.json',{manifest,manifestHash:hash(manifest),readPort});
 persistIndexedSchemaBoundary(home,config,certificate,trustedBoundary);write('indexed-schema-prepare.json',{certificate,trustedBoundary});
 for(let restart=0;restart<2;restart++){
  const child=spawn(process.execPath,[path.join(root,'sunphi-network-next/checkpoint-trial/app.mjs'),home,String(appPort)],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  try{for(let i=0;!output.includes('app ready');i++){assert(i<300&&child.exitCode===null,output);await new Promise(r=>setTimeout(r,100));}
   async function q(body){const response=await fetch('http://127.0.0.1:'+appPort,{method:'POST',headers:{'x-duebyte-app-auth':readApplicationAuth(home)},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};}
   assert.equal((await q({method:'info'})).body.height,1);
   assert.equal((await q({method:'check',txs:[]})).body.code,1);
   assert.equal((await q({method:'process',height:2,time:now+20,txs:[]})).body.accept,false);
   for(const method of ['finalize','commit'])assert.equal((await q({method,height:2,time:now+20,txs:[]})).status,400);
   assert.equal((await q({method:'info'})).body.hash,Buffer.from(trustedBoundary.root,'hex').toString('base64'));
  }finally{if(child.exitCode===null){const closed=once(child,'close');child.kill('SIGTERM');await closed;}}
 }
});
