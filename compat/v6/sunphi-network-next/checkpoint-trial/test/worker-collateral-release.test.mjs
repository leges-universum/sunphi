// Synthetic balances; no network calls, real keys or issuance.
import test from 'node:test';import assert from 'node:assert/strict';
import {issuanceFixture} from './century-issuance.test.mjs';import {rig} from './bounded-century.test.mjs';
import {hash,keys,sign} from '../crypto.mjs';
import {FUND_WORKER,COLLATERAL_DOMAIN,QUEUE_RELEASE,CANCEL_RELEASE,EXECUTE_RELEASE,RELEASE_DELAY_SECONDS,collateralChangeId,collateralReleaseId,releasableCollateral,releaseWorkerCollateral} from '../worker-collateral.mjs';
function setup(){const x=issuanceFixture({utc:true}),r=rig(x,x.s,false,false),node=x.f.ids[0],owner=x.f.alice,work=x.key(node);
 const body={domain:COLLATERAL_DOMAIN,configHash:r.s.configHash,node,owner:owner.publicKey,sequence:1,issuedAt:r.s.money.time,expires:r.s.money.time+300,unitScale:'1000000',inputs:Object.entries(r.s.money.outputs).filter(([,o])=>o.owner===owner.publicKey).map(([id])=>id).sort(),valueMicro:'1234567'};
 r.step([x.wire({type:FUND_WORKER,body,ownerSignature:sign(body,owner.privateKey),workerSignature:sign(body,work.privateKey)})]);
 function command(type=QUEUE_RELEASE,extra={}){const b={domain:COLLATERAL_DOMAIN+'/'+type,configHash:r.s.configHash,node,owner:owner.publicKey,sequence:r.s.workerFunding.accounts[node].sequence+1,issuedAt:r.s.money.time,expires:r.s.money.time+300,...(type===QUEUE_RELEASE?{valueMicro:'1234567'}:{releaseSequence:r.s.workerFunding.accounts[node].release?.sequence}),...extra};return {type,body:b,ownerSignature:sign(b,owner.privateKey),workerSignature:sign(b,work.privateKey)};}
 const execute=()=>({type:EXECUTE_RELEASE,node,sequence:r.s.workerFunding.accounts[node].release.sequence});
 return {x,r,node,owner,work,command,execute,change:collateralChangeId(body)};
}
test('owned collateral returns only to its owner after UTC cooldown, survives restart and cannot pay twice',()=>{
 const q=setup(),{x,r,node,command,execute}=q;try{
  const supply=r.s.money.supply,before=structuredClone(r.s.money.nodes[node]);r.step([x.wire(command())]);assert.equal(r.s.money.nodes[node].tier,'0');assert.equal(r.s.money.nodes[node].consensusHeld,before.consensusHeld);
  const pay=execute(),ready=r.s.workerFunding.accounts[node].release.readyAt;assert.equal(ready-r.s.money.time,RELEASE_DELAY_SECONDS);r.reject(x.wire(pay),/cooldown/);
  r.step([],ready-1);r.reject(x.wire(pay),/cooldown/);r.reopen();r.step([x.wire(pay,keys())],ready);
  assert.equal(r.s.money.outputs[collateralReleaseId(r.s.configHash,node,pay.sequence)].owner,q.owner.publicKey);assert.equal(r.s.money.nodes[node].stake,x.s.money.nodes[node].stake);
  assert.equal(r.s.money.supply,supply);assert.equal(r.s.workerFunding.accounts[node].withdrawnMicro,'1234567');r.step([x.wire(pay)]);r.reopen();assert.equal(r.s.money.supply,supply);assert.equal(releasableCollateral(r.s,node),0n);
 }finally{r.db.close();}
});
test('release refuses forgery, redirection, stale sequence, oversized claims and unsafe provenance',()=>{
 const {x,r,node,command}=setup();try{
  r.reject(x.wire(command(QUEUE_RELEASE,{valueMicro:'1234568'})),/owned/);r.reject(x.wire(command(QUEUE_RELEASE,{configHash:hash('other')})));
  const a=command();r.reject(x.wire({...a,ownerSignature:sign(a.body,keys().privateKey)}));r.reject(x.wire({...a,workerSignature:sign(a.body,keys().privateKey)}));r.reject(x.wire(a,keys()));r.reject(x.wire({...a,recipient:keys().publicKey}));
  const old=structuredClone(r.s);for(const f of ['initialStakeMicro','withdrawnMicro','release','lastRelease'])delete old.workerFunding.accounts[node][f];assert.throws(()=>releaseWorkerCollateral(old,a,x.f.alice.publicKey),/provenance/);
  r.step([x.wire(a)]);r.step([x.wire(a)]);r.reject(x.wire(command(QUEUE_RELEASE,{sequence:a.body.sequence,valueMicro:'1'})),/replay/);
 }finally{r.db.close();}
});
test('queue drains new assignments but lets existing payments finish; cancellation does not re-enable work',()=>{
 const {x,r,node,change,command,execute}=setup();try{
  const i=x.intent(r.s,{inputs:[change],epoch:r.s.money.epoch,unitScale:'1000000',abortFee:'3'});r.step([x.reserve(i)]);r.step([x.wire(command())]);assert(BigInt(r.s.money.nodes[node].taskHeld)>0n);
  const pending=execute();r.reject(x.wire(pending));r.step([x.finish(r.s,i)]);assert(BigInt(r.s.money.nodes[node].taskHeld)>0n,'challenge holds retained');
  const cancel=command(CANCEL_RELEASE);r.step([x.wire(cancel)]);r.step([x.wire(cancel)]);assert.equal(r.s.money.nodes[node].tier,'0');r.reject(x.wire(pending),/current release/);
  const changeId=Object.entries(r.s.money.outputs).find(([,o])=>o.owner===x.f.alice.publicKey&&BigInt(o.value)>1000n)[0];r.reject(x.reserve(x.intent(r.s,{inputs:[changeId],epoch:r.s.money.epoch,unitScale:'1000000',abortFee:'3'})),/worker tier/);
  r.step([x.wire(command())]);const pay=execute();r.step([x.wire(pay)],r.s.workerFunding.accounts[node].release.readyAt);assert.equal(r.s.money.nodes[node].stake,x.s.money.nodes[node].stake);r.reopen();
 }finally{r.db.close();}
});
test('proved fault reduces refundable capital; release cannot escape penalties or erase suspension',()=>{
 const {x,r,node,change,command,execute}=setup();try{
  const i=x.intent(r.s,{inputs:[change],epoch:r.s.money.epoch,unitScale:'1000000',abortFee:'3'});r.step([x.reserve(i)]);r.step([x.wire(x.fault(r.s,i))]);r.step([x.wire(command())]);
  const old=execute(),ready=r.s.workerFunding.accounts[node].release.readyAt;r.step([],ready);assert(BigInt(r.s.money.nodes[node].taskHeld)>0n);r.reject(x.wire(old),/outstanding/);
  r.step([],ready+r.s.money.liability.policy.challengeSeconds);assert.equal(r.s.money.nodes[node].taskHeld,'0');assert(r.s.money.liability.discipline[node].suspended);assert(releasableCollateral(r.s,node)<1234567n);
  r.reject(x.wire(old),/reduced/);r.step([x.wire(command(CANCEL_RELEASE))]);const refund=String(releasableCollateral(r.s,node));r.step([x.wire(command(QUEUE_RELEASE,{valueMicro:refund}))]);
  r.step([x.wire(execute())],r.s.workerFunding.accounts[node].release.readyAt);assert(r.s.money.liability.discipline[node].suspended);assert.equal(r.s.money.supply,x.s.money.supply);assert.equal(r.s.money.nodes[node].stake,x.s.money.nodes[node].stake);r.reopen();
 }finally{r.db.close();}
});
test('release commit interruption leaves collateral and outputs intact',()=>{
 const {x,r,node,command,execute}=setup();try{
  r.step([x.wire(command())]);r.step([],r.s.workerFunding.accounts[node].release.readyAt);const root=r.db.root,before=hash(r.s),pay=execute();
  assert.throws(()=>r.db.commitBlock({height:r.s.height+1,time:r.s.money.time,blockHash:hash('interrupted refund'),txs:[Buffer.from(JSON.stringify(x.wire(pay)))]},root,{beforeCommit:()=>{throw Error('interrupted');}}),/interrupted/);r.reopen();assert.equal(hash(r.s),before);r.step([x.wire(pay)]);
 }finally{r.db.close();}
});
