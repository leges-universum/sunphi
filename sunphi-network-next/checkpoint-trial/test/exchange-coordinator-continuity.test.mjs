import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';
import {hash} from '../crypto.mjs';import {resolutionFixture} from './helpers/exchange-resolution-fixture.mjs';
import {SigningCoordinator,coordinatorChannel,coordinatedExternalSigning} from '../research/exchange-signing-coordinator.mjs';
import {pairedCoordinator,recoverCoordinatorFromWitness} from '../research/exchange-coordinator-continuity.mjs';
import {coordinatorSession} from '../qa/helpers/exchange-coordinator-session.mjs';
import {connectSigningCoordinator} from '../research/exchange-signing-coordination.mjs';

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'continuity-')),config=resolutionFixture().c,open=new Set(),keys=[];
 const key=()=>{const k=randomBytes(32);keys.push(k);return k;};
 const make=(name)=>{const k=key(),file=path.join(dir,name+'.sqlite'),c=new SigningCoordinator(file,{config,key:k,create:true});open.add(c);return {c,file,key:k,cap:c.rotateContinuity(name)};};
 const primary=make('primary'),witness=make('witness');let calls=0;
 const channel=r=>coordinatorChannel(r.c,r.c.activate(),r.cap),p=channel(primary),w=channel(witness),pair=pairedCoordinator(p,w,hash(config));
 const close=c=>{c.close();open.delete(c);};
 t.after(()=>{for(const c of open)c.close();for(const k of keys)k.fill(0);fs.rmSync(dir,{recursive:true,force:true});});
 const intent=(id,purpose='PAYOUT')=>({order:hash(id),purpose,attempt:0,request:hash(['request',id,purpose])});
 const backend=resource=>({authorize:async()=>{},plan:async()=>({resources:[resource]}),sign:async plan=>{calls++;return {raw:'abcd',transaction:hash(plan)};},inspect:async(s,plan)=>assert.equal(s.transaction,hash(plan))});
 function recover(){
  const k=key(),r=recoverCoordinatorFromWitness({witness:witness.c,config,key:k,directory:dir}),c=new SigningCoordinator(r.file,{config,key:k});open.add(c);
  const next=pairedCoordinator(coordinatorChannel(c,c.activate(),r.primaryCapability),coordinatorChannel(witness.c,witness.c.activate(),r.witnessCapability),hash(config));
  return {pair:next,c,key:k,...r};
 }
 return {dir,config,primary,witness,p,w,pair,intent,backend,recover,close,get calls(){return calls;}};
}

test('loss after witness commit rebuilds exact bytes and retires old primary',async t=>{
 const f=fixture(t),i=f.intent('lost-primary'),b=f.backend('btc:utxo:first'),oldPair=pairedCoordinator({...f.p,commit:async()=>{throw Error('primary lost');}},f.w,hash(f.config));
 await assert.rejects(coordinatedExternalSigning(oldPair,i,b),/primary lost/);assert.equal(f.calls,1);
 assert.equal(f.witness.c.status()[0].status,'SIGNED');assert.equal(f.primary.c.status()[0].status,'PREPARING');
 const r=f.recover();assert.equal(r.report.mode,'LIVE_WITNESS_REBUILD');assert.equal(r.report.uncertain,0);
 assert.deepEqual(await coordinatedExternalSigning(r.pair,i,b),{raw:'abcd',transaction:hash({resources:['btc:utxo:first']})});assert.equal(f.calls,1);
 await assert.rejects(coordinatedExternalSigning(oldPair,f.intent('old-clone'),f.backend('btc:utxo:other')));assert.equal(f.calls,1);
 await assert.rejects(coordinatedExternalSigning(r.pair,f.intent('duplicate-input'),b));assert.equal(f.calls,1);
 await assert.rejects(coordinatedExternalSigning(r.pair,f.intent('lost-primary','REFUND'),f.backend('btc:utxo:refund')),/conflicting terminal/);assert.equal(f.calls,1);
 await coordinatedExternalSigning(r.pair,f.intent('next'),f.backend('eth:1:nonce:2'));assert.equal(f.calls,2);
 assert.equal(hash(r.c.recoverySnapshot()),hash(f.witness.c.recoverySnapshot()));
});

test('uncertain reservation or signature never becomes permission to repeat',async t=>{
 for(const stage of ['primary-reserve','sign','witness-commit']){
  const f=fixture(t),p={...f.p},w={...f.w},b=f.backend('eth:1:nonce:0');
  if(stage==='primary-reserve')p.reserve=async()=>{throw Error(stage);};
  if(stage==='sign')b.sign=async()=>{throw Error(stage);};
  if(stage==='witness-commit')w.commit=async()=>{throw Error(stage);};
  const pair=pairedCoordinator(p,w,hash(f.config));await assert.rejects(coordinatedExternalSigning(pair,f.intent(stage),b));
  assert.equal(f.calls,stage==='witness-commit'?1:0);assert.equal(f.witness.c.status()[0].status,'PREPARING');
  assert.throws(()=>f.recover(),/uncertain witness/);await assert.rejects(pair.checkpoint());
 }
});

test('lost replies after durable writes replay without a second signature',async t=>{
 for(const stage of ['witness','primary','both']){
  const f=fixture(t),i=f.intent(stage),b=f.backend('btc:utxo:'+stage),p={...f.p},w={...f.w};
  if(stage==='witness')w.commit=async(...a)=>{await f.w.commit(...a);throw Error('reply lost');};
  if(stage==='primary')p.commit=async(...a)=>{await f.p.commit(...a);throw Error('reply lost');};
  const pair=pairedCoordinator(p,w,hash(f.config));
  const ch=stage==='both'?{...pair,commit:async(...a)=>{await pair.commit(...a);throw Error('reply lost');}}:pair;
  await assert.rejects(coordinatedExternalSigning(ch,i,b),/reply lost/);assert.equal(f.calls,1);
  const next=stage==='witness'?f.recover().pair:f.pair;
  await coordinatedExternalSigning(next,i,b);assert.equal(f.calls,1);
 }
});

test('witness outage, divergent inventory and incorrect scope block new signing',async t=>{
 const f=fixture(t),i=f.intent('outage'),b=f.backend('btc:utxo:one');
 const offline=pairedCoordinator(f.p,{...f.w,checkpoint:async()=>{throw Error('offline');}},hash(f.config));
 await assert.rejects(coordinatedExternalSigning(offline,i,b),/offline/);assert.equal(f.calls,0);
 await assert.rejects(pairedCoordinator(f.p,f.w,hash('foreign')).checkpoint());
 await f.p.reserve(i,{resources:['btc:utxo:one']});await assert.rejects(f.pair.checkpoint(),/diverged/);assert.equal(f.calls,0);
});

test('revocation survives restart, legacy clients cannot bypass enrollment',t=>{
 const f=fixture(t),old=f.witness.cap,current=f.witness.c.rotateContinuity(),file=f.witness.file,key=f.witness.key;f.close(f.witness.c);
 const c=new SigningCoordinator(file,{config:f.config,key});try{
  const session=c.activate(),i=f.intent('new');assert.throws(()=>c.get(session,i,old),/retired continuity/);
  assert.throws(()=>c.get(session,i));assert.equal(c.get(session,i,current),null);
 }finally{c.close();}
});

test('unfinished recovery stays blocked and nonempty legacy inventory cannot enroll',async t=>{
 const f=fixture(t),r=f.recover();f.close(r.c);fs.writeFileSync(r.file+'.recovery-pending','incomplete');
 assert.throws(()=>new SigningCoordinator(r.file,{config:f.config,key:r.key}),/unfinished/);
 const key=randomBytes(32),c=new SigningCoordinator(path.join(f.dir,'legacy.sqlite'),{config:f.config,key,create:true});
 try{await coordinatedExternalSigning(coordinatorChannel(c,c.activate()),f.intent('legacy'),f.backend('btc:utxo:legacy'));assert.throws(()=>c.rotateContinuity('witness'),/nonempty unpaired/);}finally{c.close();key.fill(0);}
 assert.throws(()=>recoverCoordinatorFromWitness({witness:{},config:f.config,key:randomBytes(32),directory:f.dir}),/live enrolled/);
 assert.throws(()=>recoverCoordinatorFromWitness({witness:f.primary.c,config:f.config,key:randomBytes(32),directory:f.dir}),/designated witness/);
 assert.throws(()=>f.primary.c.rotateContinuity('witness'),/immutable/);
});

test('paired mTLS admission fences old remote credentials across service restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'continuity-tls-')),config=resolutionFixture().c;
 const a=path.join(dir,'a'),b=path.join(dir,'b');fs.mkdirSync(a);fs.mkdirSync(b);
 const primary=await coordinatorSession(a,config);let witness,replacement;
 try{
  witness=await coordinatorSession(b,config);
  const pc=await primary.supervise(c=>c.rotateContinuity('primary')),wc=await witness.supervise(c=>c.rotateContinuity('witness'));
  const profile={config,backendConfig:{coordinator:{}}},secrets={backendSecrets:{coordinator:{}}};
  for(const [role,s,cap] of [['primary',primary,pc],['witness',witness,wc]]){
   const {key,cert,ca,...policy}=s.options;profile.backendConfig.coordinator[role]=policy;secrets.backendSecrets.coordinator[role]={key,cert,ca,continuity:cap};
  }
  const pair=await connectSigningCoordinator(profile,secrets);let calls=0;
  const i={order:hash('tls-pair'),purpose:'PAYOUT',attempt:0,request:hash('tls-request')};
  const backend={authorize:async()=>{},plan:async()=>({resources:['btc:utxo:tls']}),sign:async()=>{calls++;return {raw:'abcd',transaction:hash('signed')};},inspect:async()=>{}};
  await coordinatedExternalSigning(pair,i,backend);await primary.restart();await witness.restart();
  await coordinatedExternalSigning(pair,i,backend);assert.equal(calls,1);
  await assert.rejects(primary.channel.get(i));await assert.rejects(witness.channel.get(i));
  const next=await witness.supervise(c=>c.rotateContinuity());await witness.restart();
  await assert.rejects(pair.checkpoint());await assert.rejects(connectSigningCoordinator(profile,secrets));
  secrets.backendSecrets.coordinator.witness.continuity=next;const restored=await connectSigningCoordinator(profile,secrets);
  await coordinatedExternalSigning(restored,i,backend);assert.equal(calls,1);
  const duplicate=structuredClone(profile);duplicate.backendConfig.coordinator.witness=duplicate.backendConfig.coordinator.primary;
  await assert.rejects(connectSigningCoordinator(duplicate,secrets),/distinct witness/);
  // Lose the primary process; rebuild from the still-live witness and serve
  // the restored inventory from a new process with a new pinned TLS identity.
  await primary.stop();const newKey=randomBytes(32);let recovery;
  try{
   recovery=await witness.supervise(c=>recoverCoordinatorFromWitness({witness:c,config,key:newKey,directory:dir}));
   const replacementDir=path.join(dir,'replacement');fs.mkdirSync(replacementDir);
   replacement=await coordinatorSession(replacementDir,config,{file:recovery.file,key:newKey});
  }finally{newKey.fill(0);}
  const {key,cert,ca,...newPolicy}=replacement.options;
  profile.backendConfig.coordinator.primary=newPolicy;
  secrets.backendSecrets.coordinator.primary={key,cert,ca,continuity:recovery.primaryCapability};
  secrets.backendSecrets.coordinator.witness.continuity=recovery.witnessCapability;
  const rebuilt=await connectSigningCoordinator(profile,secrets);await coordinatedExternalSigning(rebuilt,i,backend);assert.equal(calls,1);
  await primary.start();await assert.rejects(restored.checkpoint());
  await replacement.restart();await witness.restart();await coordinatedExternalSigning(rebuilt,i,backend);assert.equal(calls,1);
  await witness.stop();await assert.rejects(restored.checkpoint());assert.equal(calls,1);
  await assert.rejects(rebuilt.checkpoint());
 }finally{await primary.close();if(witness)await witness.close();if(replacement)await replacement.close();fs.rmSync(dir,{recursive:true,force:true});}
});
