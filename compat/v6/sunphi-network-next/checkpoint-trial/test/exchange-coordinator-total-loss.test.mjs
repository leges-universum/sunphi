import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {hash} from '../crypto.mjs';
import {resolutionFixture} from './helpers/exchange-resolution-fixture.mjs';
import {SigningCoordinator,coordinatorChannel,coordinatedExternalSigning} from '../research/exchange-signing-coordinator.mjs';
import {recoveryProtectedCoordinator,recoverCoordinatorPair} from '../research/exchange-coordinator-continuity.mjs';
import {sealCoordinatorBackup,openCoordinatorRecovery} from '../research/exchange-coordinator-backup.mjs';
import {coordinatorSession} from '../qa/helpers/exchange-coordinator-session.mjs';
import {connectSigningCoordinator} from '../research/exchange-signing-coordination.mjs';
import {sealSigningVault,openSigningVault} from '../research/exchange-signing-vault.mjs';

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'total-loss-')),config=resolutionFixture().c,open=new Set(),keys=[];
 const key=()=>{const k=randomBytes(32);keys.push(k);return k;};
 const make=role=>{const k=key(),file=path.join(dir,role+'.sqlite'),c=new SigningCoordinator(file,{config,key:k,create:true});open.add(c);return {c,key:k,file,cap:c.rotateContinuity(role)};};
 const primary=make('primary'),witness=make('witness'),recovery=make('recovery');let calls=0;
 const channel=r=>coordinatorChannel(r.c,r.c.activate(),r.cap);
 const p=channel(primary),w=channel(witness),a=channel(recovery),pair=recoveryProtectedCoordinator(p,w,a,hash(config));
 const intent=(id,purpose='PAYOUT')=>({order:hash(id),purpose,attempt:0,request:hash(['request',id,purpose])});
 const backend=resource=>({authorize:async()=>{},plan:async()=>({resources:[resource]}),sign:async plan=>{calls++;return {raw:'abcd',transaction:hash(plan)};},inspect:async(s,plan)=>assert.equal(s.transaction,hash(plan))});
 const close=c=>{c.close();open.delete(c);};
 function recover(){
  const primaryKey=key(),witnessKey=key(),r=recoverCoordinatorPair({recovery:recovery.c,config,primaryKey,witnessKey,directory:dir});
  const pc=new SigningCoordinator(r.primary.file,{config,key:primaryKey}),wc=new SigningCoordinator(r.witness.file,{config,key:witnessKey});open.add(pc);open.add(wc);
  const next=recoveryProtectedCoordinator(coordinatorChannel(pc,pc.activate(),r.primary.capability),coordinatorChannel(wc,wc.activate(),r.witness.capability),coordinatorChannel(recovery.c,recovery.c.activate(),r.recoveryCapability),hash(config));
  return {...r,pair:next,pc,wc,primaryKey,witnessKey};
 }
 t.after(()=>{for(const c of open)c.close();for(const k of keys)k.fill(0);fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,config,primary,witness,recovery,p,w,a,pair,intent,backend,close,recover,get calls(){return calls;}};
}

test('loss of both working inventories restores exact signed bytes, resource and terminal locks',async t=>{
 const f=fixture(t),i=f.intent('payout'),b=f.backend('btc:utxo:reserved');
 const result=await coordinatedExternalSigning(f.pair,i,b);assert.equal(f.calls,1);
 f.close(f.primary.c);f.close(f.witness.c);
 // Delete only disposable test databases, proving the rebuild needs neither.
 for(const r of [f.primary,f.witness])fs.unlinkSync(r.file);
 const r=f.recover();assert.equal(r.report.mode,'LIVE_RECOVERY_PAIR_REBUILD');assert.equal(r.report.signed,1);
 assert.deepEqual(await coordinatedExternalSigning(r.pair,i,b),result);assert.equal(f.calls,1);
 await assert.rejects(coordinatedExternalSigning(r.pair,f.intent('reuse'),b));
 // Recovery is required again after a failed replicated reservation. Its
 // PREPARING record must not be erased merely because this signature failed.
 assert.equal(f.calls,1);
 const g=fixture(t),j=g.intent('terminal');await coordinatedExternalSigning(g.pair,j,g.backend('eth:1:nonce:1'));
 const rebuilt=g.recover();await assert.rejects(coordinatedExternalSigning(rebuilt.pair,g.intent('terminal','REFUND'),g.backend('eth:1:nonce:2')),/conflicting terminal/);
 assert.equal(g.calls,1);
});

test('signature durable only in recovery authority survives loss of both journals',async t=>{
 const f=fixture(t),i=f.intent('witness-commit-failed'),b=f.backend('eth:1:nonce:4');
 const failed=recoveryProtectedCoordinator(f.p,{...f.w,commit:async()=>{throw Error('both working disks lost');}},f.a,hash(f.config));
 await assert.rejects(coordinatedExternalSigning(failed,i,b),/disks lost/);assert.equal(f.calls,1);
 assert.equal(f.recovery.c.status()[0].status,'SIGNED');assert.equal(f.witness.c.status()[0].status,'PREPARING');
 const r=f.recover();await coordinatedExternalSigning(r.pair,i,b);assert.equal(f.calls,1);
 await assert.rejects(failed.checkpoint(),/retired|diverged/);
 await coordinatedExternalSigning(r.pair,f.intent('next'),f.backend('eth:1:nonce:5'));assert.equal(f.calls,2);
});

test('any missing authority blocks signing with no two-of-three fallback',async t=>{
 for(const index of [0,1,2]){
  const f=fixture(t),channels=[f.p,f.w,f.a];channels[index]={...channels[index],checkpoint:async()=>{throw Error('offline');}};
  await assert.rejects(coordinatedExternalSigning(recoveryProtectedCoordinator(...channels,hash(f.config)),f.intent('offline'),f.backend('btc:utxo:a')),/offline/);
  assert.equal(f.calls,0);assert.equal(f.recovery.c.status().length,0);
 }
});

test('uncertain phases block total-loss recovery and durably retire old profiles',async t=>{
 for(const stage of ['recovery-reserve-reply','witness-reserve','primary-reserve','sign','recovery-commit']){
  const f=fixture(t),p={...f.p},w={...f.w},a={...f.a},b=f.backend('btc:utxo:uncertain');
  if(stage==='recovery-reserve-reply')a.reserve=async(...args)=>{await f.a.reserve(...args);throw Error(stage);};
  if(stage==='witness-reserve')w.reserve=async()=>{throw Error(stage);};
  if(stage==='primary-reserve')p.reserve=async()=>{throw Error(stage);};
  if(stage==='sign')b.sign=async()=>{throw Error(stage);};
  if(stage==='recovery-commit')a.commit=async()=>{throw Error(stage);};
  const ch=recoveryProtectedCoordinator(p,w,a,hash(f.config));await assert.rejects(coordinatedExternalSigning(ch,f.intent(stage),b));
  assert.equal(f.calls,stage==='recovery-commit'?1:0);
  assert.throws(()=>f.recover(),/uncertain recovery/);assert.throws(()=>f.a.checkpoint(hash('challenge')),/retired/);
  f.close(f.recovery.c);const reopened=new SigningCoordinator(f.recovery.file,{config:f.config,key:f.recovery.key});
  try{assert.throws(()=>reopened.checkpoint(reopened.activate(),hash('probe'),f.recovery.cap),/retired/);assert.equal(reopened.status()[0].status,'PREPARING');}finally{reopened.close();}
 }
});

test('matching stale pair cannot override current recovery authority or replay new signing',async t=>{
 const f=fixture(t);f.close(f.primary.c);f.close(f.witness.c);
 const snapshots=[f.primary,f.witness].map(r=>fs.readFileSync(r.file));
 const fresh=[];for(const r of [f.primary,f.witness]){r.c=new SigningCoordinator(r.file,{config:f.config,key:r.key});fresh.push(r.c);}
 try{
  const ch=recoveryProtectedCoordinator(coordinatorChannel(fresh[0],fresh[0].activate(),f.primary.cap),coordinatorChannel(fresh[1],fresh[1].activate(),f.witness.cap),f.a,hash(f.config));
  await coordinatedExternalSigning(ch,f.intent('newer-than-backup'),f.backend('eth:1:nonce:8'));
 }finally{fresh.forEach(c=>c.close());}
 const stale=[];
 try{
  for(const [n,r] of [f.primary,f.witness].entries()){const file=path.join(f.dir,'stale'+n+'.sqlite');fs.writeFileSync(file,snapshots[n]);stale.push(new SigningCoordinator(file,{config:f.config,key:r.key}));}
  const ch=recoveryProtectedCoordinator(coordinatorChannel(stale[0],stale[0].activate(),f.primary.cap),coordinatorChannel(stale[1],stale[1].activate(),f.witness.cap),f.a,hash(f.config));
  await assert.rejects(ch.checkpoint(),/diverged/);assert.equal(f.calls,1);
  const r=f.recover();await assert.rejects(ch.checkpoint());
  await coordinatedExternalSigning(r.pair,f.intent('newer-than-backup'),f.backend('eth:1:nonce:8'));assert.equal(f.calls,1);
 }finally{stale.forEach(c=>c.close());}
});

test('offline backup, wrong role, foreign scope and shared keys cannot restore both authorities',t=>{
 const f=fixture(t),password='isolated recovery password',b=sealCoordinatorBackup(f.recovery.c,password);
 const offline=openCoordinatorRecovery(b.bundle,{password,config:f.config,checkpoint:b.checkpoint});
 const args={config:f.config,primaryKey:randomBytes(32),witnessKey:randomBytes(32),directory:f.dir};
 for(const recovery of [offline,{},f.primary.c,f.witness.c])assert.throws(()=>recoverCoordinatorPair({...args,recovery}));
 assert.throws(()=>recoverCoordinatorPair({...args,recovery:f.recovery.c,config:{wrong:true}}),/foreign/);
 assert.throws(()=>recoverCoordinatorPair({...args,recovery:f.recovery.c,witnessKey:args.primaryKey}),/distinct/);
 assert.equal(offline.report.signingEnabled,false);
});

test('recovery profile is vault-bound and removing the third journal invalidates unlock',()=>{
 const config=resolutionFixture().c,profile={config,inventory:'/lab/inventory',backend:'/lab/backend',backendConfig:{coordinator:{primary:{url:'p'},witness:{url:'w'},recovery:{url:'a'}}},clients:[],port:9000};
 const secrets={inventoryKey:randomBytes(32).toString('hex'),tlsKey:'key',tlsCert:'cert',tlsCA:'ca',backendSecrets:{}},password=Buffer.from('isolated password long enough');
 try{const vault=sealSigningVault(secrets,profile,password);const downgraded=structuredClone(profile);delete downgraded.backendConfig.coordinator.recovery;
  assert.throws(()=>openSigningVault(vault,downgraded,password));assert.deepEqual(openSigningVault(vault,profile,password),secrets);
 }finally{password.fill(0);}
});

test('failure building the second replacement leaves old authority revoked and permits safe retry',async t=>{
 const f=fixture(t),i=f.intent('partial-rebuild'),b=f.backend('btc:utxo:partial');
 const signed=await coordinatedExternalSigning(f.pair,i,b),original=fs.mkdtempSync;let creations=0;
 const mock=t.mock.method(fs,'mkdtempSync',(...args)=>{if(++creations===2)throw Error('injected destination unavailable');return original(...args);});
 try{assert.throws(()=>f.recover(),/destination unavailable/);}finally{mock.mock.restore();}
 await assert.rejects(f.pair.checkpoint(),/retired/);assert.equal(f.calls,1);
 const r=f.recover();assert.deepEqual(await coordinatedExternalSigning(r.pair,i,b),signed);assert.equal(f.calls,1);
 // A second supervised rebuild retires the first rebuilt profile as well.
 const again=f.recover();await assert.rejects(r.pair.checkpoint());
 assert.deepEqual(await coordinatedExternalSigning(again.pair,i,b),signed);assert.equal(f.calls,1);
});

test('three mTLS processes restore two lost authorities and fence pre-recovery signer across restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'total-loss-tls-')),config=resolutionFixture().c,sessions=[],roles=['primary','witness','recovery'];
 const profile={config,backendConfig:{coordinator:{}}},secrets={backendSecrets:{coordinator:{}}};
 const attach=(role,s,cap)=>{const {key,cert,ca,...policy}=s.options;profile.backendConfig.coordinator[role]=policy;secrets.backendSecrets.coordinator[role]={key,cert,ca,continuity:cap};};
 const make=async(name,recovered)=>{const out=path.join(dir,name);fs.mkdirSync(out);const s=await coordinatorSession(out,config,recovered);sessions.push(s);return s;};
 let calls=0;const intent={order:hash('tls-total-loss'),purpose:'PAYOUT',attempt:0,request:hash('tls-request')};
 const backend={authorize:async()=>{},plan:async()=>({resources:['btc:utxo:total-loss']}),sign:async()=>{calls++;return {raw:'abcd',transaction:hash('signed')};},inspect:async()=>{}};
 try{
  for(const role of roles){const s=await make(role);attach(role,s,await s.supervise(c=>c.rotateContinuity(role)));}
  const old=await connectSigningCoordinator(profile,secrets);const signed=await coordinatedExternalSigning(old,intent,backend);
  await sessions[0].stop();await sessions[1].stop();await assert.rejects(old.checkpoint());
  const keys=[randomBytes(32),randomBytes(32)];let recovered;
  try{
   recovered=await sessions[2].supervise(recovery=>recoverCoordinatorPair({recovery,config,primaryKey:keys[0],witnessKey:keys[1],directory:dir}));
   for(const [n,role] of ['primary','witness'].entries()){const r=recovered[role],s=await make('replacement-'+role,{file:r.file,key:keys[n]});attach(role,s,r.capability);}
  }finally{keys.forEach(k=>k.fill(0));}
  secrets.backendSecrets.coordinator.recovery.continuity=recovered.recoveryCapability;
  const next=await connectSigningCoordinator(profile,secrets);assert.deepEqual(await coordinatedExternalSigning(next,intent,backend),signed);assert.equal(calls,1);
  await sessions[0].start();await sessions[1].start();await assert.rejects(old.checkpoint());
  for(const s of sessions)await s.restart();assert.deepEqual(await coordinatedExternalSigning(next,intent,backend),signed);assert.equal(calls,1);
  await sessions[2].stop();await assert.rejects(connectSigningCoordinator(profile,secrets));await assert.rejects(next.checkpoint());
  await sessions[2].start();const wrong=structuredClone(profile);wrong.backendConfig.coordinator.recovery=wrong.backendConfig.coordinator.witness;
  await assert.rejects(connectSigningCoordinator(wrong,secrets),/distinct/);
  const missing=structuredClone(secrets);delete missing.backendSecrets.coordinator.recovery;await assert.rejects(connectSigningCoordinator(profile,missing));
 }finally{for(const s of sessions)await s.close();fs.rmSync(dir,{recursive:true,force:true});}
});
