import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {keys,hash} from '../crypto.mjs';
import {CHECKPOINT,attest} from '../checkpoint.mjs';
import {cleanConfig,createFreshChain} from '../research/fresh-chain-preparation.mjs';
import {openFreshApplication} from '../research/fresh-application.mjs';
import {IndexedCheckpointRepository,indexedCheckpointBody} from '../research/indexed-checkpoint.mjs';
import {readApplicationAuth} from '../application-auth.mjs';
import {validateConsumerProfile} from '../consumer-profile.mjs';
import {consumerIdentity,prepareConsumer} from '../consumer-setup.mjs';

for(const version of [1,2])test('ordinary fresh app authority V'+version+' authenticates snapshot, resumes lost acknowledgement and refuses missing committed state',async t=>{
 const root=fs.mkdtempSync(join(tmpdir(),'duebyte-fresh-runtime-')),home=join(root,'server'),target=join(root,'home');fs.mkdirSync(home);fs.mkdirSync(target);
 const members=Array.from({length:4},keys),validators=Array.from({length:version===2?11:10},keys),time=Math.floor(Date.now()/1000);
 const config=cleanConfig({chainId:'duebyte-trial-fresh-runtime',previousChainId:'old',time,control:{...(version===2?{version:2}:{}),validators:validators.map((v,i)=>({key:v.publicKey,group:hash(i),...(version===2?{power:10+i%3}:{})})),policy:{version:1,members:members.map((v,i)=>({key:v.publicKey,group:hash(i)})),threshold:3,maxAge:3600,notAfter:time+86400}}});
 const policy={domain:CHECKPOINT+'/POLICY',network:config.chainId,genesisHash:hash('isolated-runtime-genesis'),...config.control.policy};
 const file=join(home,'application-indexed.sqlite'),created=createFreshChain(file,config),fresh={manifest:created.manifest,manifestHash:hash(created.manifest)};created.handler.close();
 const genesis={chain_id:config.chainId,app_state:config,validators:validators.map((k,i)=>({pub_key:{type:'tendermint/PubKeyEd25519',value:Buffer.from(k.publicKey,'base64url').toString('base64')},power:String(config.control.validators[i].power??10)}))};
 const wire=Buffer.concat([Buffer.from('0000000b7373682d6564323535313900000020','hex'),Buffer.alloc(32,1)]),pin='ssh-ed25519 '+wire.toString('base64');
 const profile={version:1,config,genesis,policy:{...policy,genesisHash:hash(genesis)},basePort:28000,walletPort:28010,hosts:[{ip:'192.0.2.1',port:2244,user:'duebytefollower',pin,forwards:[[28100,26000],[28101,26001],[28105,26005]]},{ip:'192.0.2.2',port:2244,user:'duebytefollower',pin,forwards:[[28110,26010],[28111,26011]]}],peers:[{id:'a'.repeat(40),port:28100},{id:'b'.repeat(40),port:28110}],rpcServers:['http://127.0.0.1:28101','http://127.0.0.1:28111'],workers:{},fresh:{...fresh,readPort:28005,url:'http://127.0.0.1:28105'}};
 validateConsumerProfile(profile,hash(profile));
 for(const mutate of [p=>p.indexed={},p=>p.fresh.manifestHash=hash('wrong'),p=>p.fresh.manifest.imports=true,p=>p.fresh.manifest.timing.targetSeconds=2,p=>p.fresh.readPort=p.walletPort,p=>p.fresh.url='http://127.0.0.1:28106']){const p=structuredClone(profile);mutate(p);assert.throws(()=>validateConsumerProfile(p,hash(p)));}
 const legacy=join(root,'existing-home');fs.mkdirSync(legacy);fs.writeFileSync(join(legacy,'installation.json'),JSON.stringify({network:config.chainId,profileHash:hash(profile),nodeDirectory:'node'}));fs.mkdirSync(join(legacy,'wallet'));fs.writeFileSync(join(legacy,'wallet/retain.txt'),'working wallet');assert.throws(()=>consumerIdentity(legacy,profile,hash(profile)));assert.equal(fs.readFileSync(join(legacy,'wallet/retain.txt'),'utf8'),'working wallet');
 const app=openFreshApplication(file,config,fresh);assert.equal(Buffer.from(app.dispatch({method:'info'}).hash,'base64').toString('hex'),fresh.manifest.root);
 const advance=()=>{const height=app.blocks.header.height+1;app.blocks.finalize({height,time:time+height*10,blockHash:hash(['fresh',height]),txs:[]});app.blocks.commit();};
 advance();advance();const repo=new IndexedCheckpointRepository(home,app,policy),{manifest}=await repo.prepare();advance();const body=indexedCheckpointBody(app,manifest,policy),document={body,signatures:members.slice(0,3).map(k=>attest(body,k))};repo.install(document,manifest);
 assert.deepEqual(repo.list(),{snapshots:[]},'H+1 is insufficient for Comet next-validator verification');advance();assert.equal(repo.list().snapshots.length,1,'snapshot becomes available at H+2');app.close();
 const unproved=join(root,'unproved-home');consumerIdentity(unproved,profile,hash(profile));const alteredBody={...body,policyHash:hash(profile.policy),genesisHash:hash(genesis)},signed={body:alteredBody,signatures:members.slice(0,3).map(k=>attest(alteredBody,k))};assert.throws(()=>prepareConsumer(unproved,profile,hash(profile),signed),/authenticated indexed checkpoint/);assert(!fs.existsSync(join(unproved,'node-fresh-v1')));
 const probes=Array.from({length:4},()=>createServer());for(const p of probes)await new Promise(ok=>p.listen(0,'127.0.0.1',ok));const [port,readPort,otherPort,otherRead]=probes.map(p=>p.address().port);for(const p of probes)await new Promise(ok=>p.close(ok));
 const write=(h,n,v)=>fs.writeFileSync(join(h,n+'.json'),JSON.stringify(v));
 for(const [h,apiPort,bootstrap] of [[home,readPort,false],[target,otherRead,true]]){write(h,'app-config',config);write(h,'trust-policy',policy);write(h,'fresh-activation',{...fresh,readPort:apiPort,bootstrap});}
 const children=new Set(),call=(p,q,token)=>fetch('http://127.0.0.1:'+p,{method:'POST',headers:token?{'x-duebyte-app-auth':token}:{},body:JSON.stringify(q),signal:AbortSignal.timeout(30000)});
 const start=async(h,p)=>{const log=fs.openSync(join(h,'test.log'),'a'),child=spawn(process.execPath,[resolve(import.meta.dirname,'../app.mjs'),h,String(p)],{stdio:['ignore',log,log],windowsHide:true});fs.closeSync(log);children.add(child);for(let n=0;n<100;n++){try{if((await call(p,{method:'info'})).ok)return child;}catch{}assert.equal(child.exitCode,null,fs.readFileSync(join(h,'test.log'),'utf8'));await new Promise(r=>setTimeout(r,50));}throw Error('start timeout');};
 const stop=async c=>{if(c.exitCode===null&&c.signalCode===null){const end=new Promise(r=>c.once('exit',r));c.kill();await end;}children.delete(c);};
 t.after(async()=>{for(const c of children)await stop(c);fs.rmSync(root,{recursive:true,force:true});});
 await start(home,port);let child=await start(target,otherPort),token=readApplicationAuth(target);
 assert(!fs.existsSync(join(target,'application.sqlite')));assert.equal((await call(otherPort,{method:'finalize',height:1,txs:[]},token)).status,400);
 const listing=await(await call(port,{method:'listSnapshots'})).json(),snapshot=listing.snapshots[0],offer={method:'offerSnapshot',snapshot,appHash:manifest.root};assert(snapshot);
 assert.equal((await call(otherPort,{...offer,appHash:hash('wrong')},token)).status,400);assert.equal((await call(otherPort,offer)).status,403);assert.equal((await call(otherPort,offer,token)).status,200);
 const chunks=[];for(let index=0;index<snapshot.chunks;index++){const c=await(await call(port,{method:'loadSnapshotChunk',height:manifest.height,index})).json();chunks.push(c);const r=await call(otherPort,{method:'applySnapshotChunk',index,chunk:c.chunk},token);assert.equal(r.status,200,await r.text());}
 const ready=await(await call(otherPort,{method:'info'})).json();assert.equal(ready.height,2);assert.equal(Buffer.from(ready.hash,'base64').toString('hex'),manifest.root);
 await stop(child);child=await start(target,otherPort);token=readApplicationAuth(target);assert.equal((await call(otherPort,offer,token)).status,200);
 for(let index=0;index<chunks.length;index++)assert.equal((await call(otherPort,{method:'applySnapshotChunk',index,chunk:chunks[index].chunk},token)).status,200);
 const bad=JSON.parse(Buffer.from(chunks[0].chunk,'base64'));bad.data=Buffer.from('bad').toString('base64');assert.equal((await call(otherPort,{method:'applySnapshotChunk',index:0,chunk:Buffer.from(JSON.stringify(bad)).toString('base64')},token)).status,400);
 const r=await call(otherPort,{method:'finalize',height:3,hash:Buffer.from(hash(['fresh',3]),'hex').toString('base64'),time:time+30,txs:[]},token);assert.equal(r.status,200,await r.text());assert.equal((await call(otherPort,{method:'commit'},token)).status,200);assert.equal((await call(otherPort,offer,token)).status,400);
 await stop(child);child=await start(target,otherPort);assert.equal((await(await call(otherPort,{method:'info'})).json()).height,3);await stop(child);
 fs.renameSync(join(target,'application-indexed.sqlite'),join(target,'retained.sqlite'));
 const failed=spawn(process.execPath,[resolve(import.meta.dirname,'../app.mjs'),target,String(otherPort)],{stdio:'ignore',windowsHide:true});children.add(failed);const code=await new Promise(r=>failed.once('exit',r));assert.notEqual(code,0);assert(!fs.existsSync(join(target,'application-indexed.sqlite')));assert(!fs.existsSync(join(target,'application.sqlite')));
});
