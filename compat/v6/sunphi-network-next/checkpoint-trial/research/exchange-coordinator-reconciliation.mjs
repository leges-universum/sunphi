// Recovery against a SURVIVING independently operated, pinned mTLS coordinator.
// Never use this with a coordinator rolled back/copied from the same backup.
// Matching the online journal is not proof that its authority was never cloned.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {exact,hex,integer} from '../crypto.mjs';

export async function reconcileCoordinatorRecovery(view,channel){
 const expected=view.report;
 assert(expected?.mode==='RECONCILIATION_ONLY'&&expected.signingEnabled===false);
 hex(expected.scope);hex(expected.snapshotHash);
 assert.equal(typeof channel.checkpoint,'function');assert.equal(typeof channel.get,'function');
 async function current(epoch){
  const challenge=randomBytes(32).toString('hex'),r=await channel.checkpoint(challenge);
  exact(r,['domain','scope','challenge','epoch','snapshotHash','records','uncertain']);
  assert.equal(r.domain,'DUEBYTE_COORDINATOR_LIVE_CHECKPOINT_V1');
  assert.equal(r.challenge,challenge,'replayed coordinator checkpoint');
  assert.equal(r.scope,expected.scope,'foreign coordinator scope');integer(r.epoch,1);
  assert.equal(r.snapshotHash,expected.snapshotHash,'backup differs from current coordinator');
  assert.equal(r.records,expected.records);assert.equal(r.uncertain,expected.uncertain);
  assert.equal(r.uncertain,0,'uncertain signing requires independent reconciliation');
  if(epoch!==undefined)assert.equal(r.epoch,epoch,'coordinator restarted during recovery');
  return r;
 }
 const start=await current();
 return Object.freeze({
  report:Object.freeze({mode:'ONLINE_MATCH_REPLAY_ONLY',scope:expected.scope,snapshotHash:expected.snapshotHash,
   epoch:start.epoch,matchesCurrentCoordinator:true,signingEnabled:false,coordinatorRollbackExcluded:false,
   requiresSurvivingIndependentCoordinator:true}),
  async replay(intent,inspect){
   assert.equal(typeof inspect,'function','native signed transaction inspection required');
   intent=structuredClone(intent);await current(start.epoch);
   const saved=view.get(intent);assert(saved?.status==='SIGNED','no completed signature in backup');
   const live=await channel.get(intent);assert(live?.status==='SIGNED','current signature missing');
   assert.deepEqual(live.intent,saved.intent);assert.deepEqual(live.plan,saved.plan);assert.deepEqual(live.signed,saved.signed);
   await inspect(structuredClone(live.signed),structuredClone(live.plan));
   // Inspection may await external RPC. Recheck after that asynchronous gap.
   await current(start.epoch);return structuredClone(live.signed);
  }
 });
}
