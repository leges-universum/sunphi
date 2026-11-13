import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';
import {hash} from '../crypto.mjs';import {resolutionFixture} from './helpers/exchange-resolution-fixture.mjs';
import {SigningCoordinator,coordinatorChannel,coordinatedExternalSigning} from '../research/exchange-signing-coordinator.mjs';
import {sealCoordinatorBackup,openCoordinatorRecovery} from '../research/exchange-coordinator-backup.mjs';
import {reconcileCoordinatorRecovery} from '../research/exchange-coordinator-reconciliation.mjs';
const password='isolated-reconciliation-fixture';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-reconcile-')),config=resolutionFixture().c,key=randomBytes(32);
 const c=new SigningCoordinator(path.join(dir,'coordinator.sqlite'),{config,key,create:true});
 t.after(()=>{c.close();key.fill(0);fs.rmSync(dir,{recursive:true,force:true});});
 let channel=coordinatorChannel(c,c.activate()),calls=0;
 const intent=(id,purpose='PAYOUT')=>({order:hash(id),purpose,attempt:0,request:hash(['request',id])});
 const backend=id=>({authorize:async()=>{},plan:async()=>({resources:['btc:input:'+id]}),sign:async p=>{calls++;return {raw:'abcd',transaction:hash(p)};},inspect:async(s,p)=>assert.equal(s.transaction,hash(p))});
 return {c,get channel(){return channel;},get calls(){return calls;},intent,backend,
  rotate(){channel=coordinatorChannel(c,c.activate());},
  view(){const b=sealCoordinatorBackup(c,password);return openCoordinatorRecovery(b.bundle,{password,config,checkpoint:b.checkpoint});}};
}
test('current recovery replays existing bytes and never creates new signatures',async t=>{
 const f=fixture(t),i=f.intent('first'),b=f.backend('first'),signed=await coordinatedExternalSigning(f.channel,i,b),view=f.view();
 f.rotate();const recovery=await reconcileCoordinatorRecovery(view,f.channel);
 assert.equal(recovery.report.signingEnabled,false);assert.equal(recovery.reserve,undefined);
 assert.deepEqual(await recovery.replay(i,b.inspect),signed);assert.equal(f.calls,1);
 await assert.rejects(recovery.replay(f.intent('new'),b.inspect),/no completed signature/);
 await assert.rejects(recovery.replay(i,async()=>{throw Error('bad native bytes');}),/bad native/);assert.equal(f.calls,1);
});
test('jointly stale backup and checkpoint fail against newer independent inventory',async t=>{
 const f=fixture(t),old=f.view();await coordinatedExternalSigning(f.channel,f.intent('later'),f.backend('later'));
 await assert.rejects(reconcileCoordinatorRecovery(old,f.channel),/differs/);
});
test('unknown signature, cached response, scope mismatch and outage never enable recovery',async t=>{
 const f=fixture(t),view=f.view(),reply=f.c.checkpoint(f.c.activate(),hash('old-challenge'));
 await assert.rejects(reconcileCoordinatorRecovery(view,{...f.channel,checkpoint:async()=>reply}),/replayed/);
 f.rotate();await assert.rejects(reconcileCoordinatorRecovery(view,{...f.channel,checkpoint:async q=>({...await f.channel.checkpoint(q),scope:hash('foreign')})}),/foreign/);
 await assert.rejects(reconcileCoordinatorRecovery(view,{...f.channel,checkpoint:async()=>{throw Error('offline');}}),/offline/);
 await assert.rejects(coordinatedExternalSigning({...f.channel,commit:async()=>{throw Error('lost commit');}},f.intent('unknown'),f.backend('unknown')));
 await assert.rejects(reconcileCoordinatorRecovery(f.view(),f.channel),/uncertain/);assert.equal(f.calls,1);
});
test('journal advance, session rotation and outage during inspection invalidate replay',async t=>{
 for(const mode of ['advance','rotation','outage']){
  const f=fixture(t),i=f.intent(mode),b=f.backend(mode);await coordinatedExternalSigning(f.channel,i,b);
  let offline=false;const ch={get:(...a)=>f.channel.get(...a),checkpoint:(...a)=>{if(offline)throw Error('offline');return f.channel.checkpoint(...a);}};
  const r=await reconcileCoordinatorRecovery(f.view(),ch);
  await assert.rejects(r.replay(i,async()=>{
   if(mode==='advance')await coordinatedExternalSigning(f.channel,f.intent('second'),f.backend('second'));
   if(mode==='rotation')f.rotate();if(mode==='outage')offline=true;
  }),/differs|restarted|offline/);
 }
});
