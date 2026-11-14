import {SCHEDULE_TARIFF} from '../payment-tariff-governance.mjs';
import {INITIAL_TARIFF} from '../payment-tariff.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {issuanceFixture,certify} from './century-issuance.test.mjs';import {rig} from './bounded-century.test.mjs';
import {hash,keys,sign} from '../crypto.mjs';import {REWARDS,walletConsent} from '../node-rewards.mjs';
import {PREPARE_ZERO_STAGE,zeroStageConsent,recordZeroStageAttempt,guardZeroStageAction,assertZeroStageAttemptTerms} from '../zero-stage.mjs';
import {ZERO_STAGE_DEFAULTS} from '../research/zero-stage-plan.mjs';
import {ISSUE_WARMUP_TRANCHE,START_CENTURY,ISSUE_CENTURY} from '../century-issuance.mjs';
import {OPEN_SUPPORT,CLAIM_SUPPORT,QUEUE_SUPPORT,RETURN_SUPPORT,supportOwnerGroup} from '../worker-support.mjs';
import {supportOutput} from '../support-accounting.mjs';
import {releasePilotSupportReserve} from '../zero-stage.mjs';
import {centuryWarmupPlan} from '../century-warmup.mjs';import {effectiveWorkGroup} from '../payment-liability.mjs';
import {subsidyCertificate} from './century-subsidy.test.mjs';
import {UPGRADE_WARMUP} from '../century-warmup.mjs';
import {CenturyWarmupWorker} from '../century-warmup-worker.mjs';
import {queryBounded} from '../research/bounded-query.mjs';
import {loadBoundedServiceView} from '../research/bounded-wallet-view.mjs';
import {workReceipt} from '../core.mjs';
export function pilotFixture(isolated=true,terminal=false,workerCount=6){
 const x=issuanceFixture({utc:true,expanded:true,terminal,workerCount,challengeBlocks:8640,sameGroup:true,founderNodes:Array.from({length:workerCount},(_,i)=>i)});
 const r=rig(x,x.s,isolated,false);
 const s=r.s,body={domain:SCHEDULE_TARIFF,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,managementEpoch:s.networkReserves.development.access.epoch,notBefore:s.height,expires:s.height+100,previous:hash(null),profile:INITIAL_TARIFF,activation:s.money.time+86400,economics:null};
 r.step([x.wire({type:SCHEDULE_TARIFF,certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey)})]);
 r.step([],body.activation);
 for(const node of x.f.ids){const k=x.key(node),body={domain:REWARDS+'/BIND',configHash:r.s.configHash,node,sequence:1,payouts:[{wallet:x.f.bob.publicKey,weight:1}]};
  r.step([x.wire({type:'BIND_REWARD_WALLETS_V1',body,signature:sign(body,k.privateKey),consents:[sign(walletConsent(r.s.configHash,node,x.f.bob.publicKey),x.f.bob.privateKey)]},k)]);}
 return {x,r};
}
export function admission(x,r,over={}){
 const s=r.s,body={domain:PREPARE_ZERO_STAGE,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+100,
  manifestHash:s.centuryFunds.manifestHash,managementEpoch:s.networkReserves.development.access.epoch,observedRoot:r.db.root,observedHeight:s.height,
  liabilityPolicyHash:hash(s.money.liability.policy),startsAt:s.money.time,
  workers:x.f.ids.map(node=>({node,key:s.money.nodes[node].key,operator:effectiveWorkGroup(s.money,node),recipient:x.f.bob.publicKey})).sort((a,b)=>a.node.localeCompare(b.node)),settings:{...ZERO_STAGE_DEFAULTS},...over};
 return {type:PREPARE_ZERO_STAGE,certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey),workerConsents:body.workers.map(w=>({node:w.node,signature:sign(zeroStageConsent(body,w.node),x.key(w.node).privateKey)}))};
}
function launch(x,r){r.step([x.wire(admission(x,r))]);r.step([x.wire(certify(x,r.s,ISSUE_WARMUP_TRANCHE,{supplyBefore:r.s.money.supply,trancheMicro:'10000000'}))]);
 r.step([x.wire(certify(x,r.s,START_CENTURY,{settings:{controllerPolicy:{maximumRiseMicroPerSecond:'1000',operationalRateMicroPerSecond:'10000',intervalSeconds:600},maxPaymentMicro:'50000',timeBasis:x.c.obligationClock,ttlSeconds:120}}))]);}
function capacity(x,r,from=r.s.money.time){const s=r.s,w=s.centuryWarmup,body={domain:'DUEBYTE_WARMUP_CAPACITY_V2',configHash:s.configHash,generation:s.authority.generation,start:w.controller.start,from,to:from+600,observedHeight:s.height+1,observedAt:from,sequence:w.controller.sequence+1,healthy:true,capacityRateMicroPerSecond:'1000',controllerPolicyHash:hash(w.controllerPolicy)};
 return {type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:{body,approvals:x.approvals(body)}};}
function runAction(r){const i=centuryWarmupPlan(r.s.centuryWarmup,r.s.money);assert(i);return {i,a:{type:'RUN_CENTURY_WARMUP_V1',sequence:r.s.centuryWarmup.controller.sequence,intentHash:hash(i)}};}

test('authenticated pilot worker waits for exact terms and spacing while pending settlement remains available',async()=>{
 const prepared=pilotFixture(),x=prepared.x;let r=prepared.r;
 try{
  launch(x,r);
  const s=r.s,body={domain:UPGRADE_WARMUP,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+100,planHash:s.centuryWarmup.planHash,previousBookHash:hash(s.centuryWarmup),managementEpoch:s.networkReserves.development.access.epoch,intervalSeconds:600};
  r.step([x.wire({type:UPGRADE_WARMUP,certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey)})]);
  // Only synthetic fixture state is reopened with production query semantics.
  const seed=structuredClone(r.s);r.db.close();r=rig(x,seed,false,false);
  const start=r.s.money.time,supply=r.s.money.supply,sent=[];
  const query=async(request,root)=>queryBounded(r.db,request,root);
  const client={config:x.c,sync:async()=>{const certificate={appHash:r.db.root,appHeight:r.s.height};return {...await loadBoundedServiceView(query,{root:certificate.appHash,height:certificate.appHeight,configHash:r.s.configHash}),certificate};}};
  const worker=new CenturyWarmupWorker({client,key:x.f.alice,planHash:r.s.centuryWarmup.planHash,query,enabled:()=>true,now:()=>r.s.money.time,broadcast:async wire=>sent.push(wire),receipt:async({pid,index,node})=>workReceipt(r.s,pid,index,node,x.key(node))});
  r.step([x.wire(capacity(x,r))]);
  r.step([],start+50);
  const {i}=runAction(r),before=hash(r.s);
  assert.throws(()=>assertZeroStageAttemptTerms(r.s.centuryFunds.zeroStage,{...i,value:'49999'},r.s.money.time),/exact amount/);
  assert.throws(()=>assertZeroStageAttemptTerms(r.s.centuryFunds.zeroStage,{...i,fee:'1'},r.s.money.time),/exact fee/);
  assertZeroStageAttemptTerms(r.s.centuryFunds.zeroStage,i,r.s.money.time);assert.equal(hash(r.s),before);
  assert.equal((await worker.cycle()).submitted,'RUN_CENTURY_WARMUP_V1');r.step([sent.shift()]);r.reopen();
  assert.equal((await worker.cycle()).submitted,'FINALIZE');r.step([sent.shift()]);
  assert.equal(r.s.money.requests[i.pid].status,'SETTLED');
  // This legacy admission retains its signed challenge window. The worker
  // must not shorten old obligations when adopting the new executor.
  assert(i.parts[0].nodes.every(id=>BigInt(r.s.money.nodes[id].taskHeld)>0n));
  assert.equal(r.s.centuryFunds.zeroStage.attempts,1);
  r.step([],start+600);r.step([x.wire(capacity(x,r))]);r.step([],start+650);
  const wait=await worker.cycle();assert.equal(wait.reason,'pilot-terms');assert.match(wait.detail,/minimum spacing/);assert.equal(sent.length,0);
  r.reopen();assert.equal((await worker.cycle()).reason,'pilot-terms');
  r.step([],start+3600);assert.equal((await worker.cycle()).submitted,'CLOSE_CENTURY_WARMUP_INTERVAL_V1');r.step([sent.shift()]);
  r.step([x.wire(capacity(x,r))]);r.step([],start+3650);
  assert.equal((await worker.cycle()).submitted,'RUN_CENTURY_WARMUP_V1');r.step([sent.shift()]);
  assert.equal(r.s.centuryFunds.zeroStage.attempts,2);assert.equal(r.s.money.supply,supply);
 }finally{r.db.close();}
});

test('pilot preparation requires every exact worker consent, current root, quorum and manager; closed store never mints',()=>{
 const {x,r}=pilotFixture(false);try{const original=r.s.money.supply;
  for(const alter of [a=>a.workerConsents.pop(),a=>a.workerConsents[1]=a.workerConsents[0],a=>a.workerConsents[0].signature=sign(zeroStageConsent(a.certificate.body,a.workerConsents[0].node),keys().privateKey),a=>a.certificate.approvals.pop(),a=>a.founderConsent=sign(a.certificate.body,keys().privateKey)]){const a=admission(x,r);alter(a);r.reject(x.wire(a));}
  r.reject(x.wire(admission(x,r,{observedRoot:hash('stale')})),/review root/);
  r.reject(x.wire(admission(x,r,{liabilityPolicyHash:hash('different')})),/policy changed/);
  r.reject(x.wire(admission(x,r,{startsAt:r.s.money.time-1})),/prospective/);
  r.reject(x.wire(admission(x,r,{settings:{...ZERO_STAGE_DEFAULTS,paymentMicro:'100000'}})));
  const a=admission(x,r);r.step([x.wire(a)]);r.step([x.wire(a)]);r.reopen();assert.equal(r.s.money.supply,original);assert(!r.s.centuryFunds.execution);
  r.reject(x.wire(admission(x,r)),/immutable/);r.reject(x.wire(certify(x,r.s,ISSUE_WARMUP_TRANCHE,{supplyBefore:original,trancheMicro:'10000000'})),/issuance forbidden/);
 }finally{r.db.close();}
});
test('pilot bounds tranche, controller, support owner/roster and refuses full funds or subsidy escalation',()=>{
 const {x,r}=pilotFixture();try{r.step([x.wire(admission(x,r))]);r.reject(x.wire(certify(x,r.s,ISSUE_WARMUP_TRANCHE,{supplyBefore:r.s.money.supply,trancheMicro:'9999999'})),/pilot tranche/);
  r.reject(x.wire(certify(x,r.s,ISSUE_CENTURY,{supplyBefore:r.s.money.supply})),/post-pilot/);
  r.step([x.wire(certify(x,r.s,ISSUE_WARMUP_TRANCHE,{supplyBefore:r.s.money.supply,trancheMicro:'10000000'}))]);
  const settings={controllerPolicy:{maximumRiseMicroPerSecond:'1000',operationalRateMicroPerSecond:'10000',intervalSeconds:600},maxPaymentMicro:'50000',timeBasis:x.c.obligationClock,ttlSeconds:120};
  for(const q of [{...settings,ttlSeconds:130},{...settings,maxPaymentMicro:'50001'},{...settings,controllerPolicy:{...settings.controllerPolicy,intervalSeconds:300}}])r.reject(x.wire(certify(x,r.s,START_CENTURY,{settings:q})),/pilot/);
  r.step([x.wire(certify(x,r.s,START_CENTURY,{settings}))]);
  const allocate=()=>{const s=r.s,body={domain:OPEN_SUPPORT,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+100,planHash:s.economicPreparation.planHash,managementEpoch:s.networkReserves.development.access.epoch,supplyBefore:s.money.supply,from:s.centuryFunds.execution.start,to:s.money.time,allocationMicro:'60000000',perNodeCapMicro:'10000000',ownerCaps:{[supportOwnerGroup(s,x.f.ids[0])]:'60000000'},matchPPM:1000000,bootstrapNodes:x.f.ids};return {type:OPEN_SUPPORT,certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey)};};
  r.step([],r.s.money.time+1);r.reject(x.wire(allocate()),/allowance/);r.step([],r.s.money.time+30);r.step([x.wire(allocate())]);r.reopen();assert.equal(r.s.centuryFunds.support.book.issuedMicro,'60000000');
  r.reject(x.wire(subsidyCertificate(x,r.s,{start:r.s.centuryFunds.execution.start})),/post-pilot/);
  const bad=allocate();bad.certificate.body.ownerCaps={};assert.throws(()=>guardZeroStageAction(r.s,bad),/owner cap/);
 }finally{r.db.close();}
});
test('pilot commits fee/attempt budget atomically, survives restart, rejects rapid catch-up and expires in UTC',()=>{
 const {x,r}=pilotFixture();try{launch(x,r);const start=r.s.money.time;r.step([x.wire(capacity(x,r))]);r.step([],start+50);const {i,a}=runAction(r),before=hash(r.s),request={height:r.s.height+1,time:r.s.money.time,blockHash:hash('pilot crash'),txs:[Buffer.from(JSON.stringify(x.wire(a)))]};
  assert.throws(()=>r.db.commitBlock(request,r.db.root,{beforeCommit:()=>{throw Error('disk failure');}}),/disk failure/);r.reopen();assert.equal(hash(r.s),before);
  const commit=r.step([x.wire(a)]);assert(r.db.commitBlock(commit.request,r.db.root).value.duplicate);r.reopen();assert.equal(r.s.centuryFunds.zeroStage.attempts,1);
  r.step([x.finish(r.s,i)]);assert.equal(r.s.centuryWarmup.controller.spentMicro,'5000');
  r.step([],start+599);r.reject(x.wire(capacity(x,r,r.s.centuryWarmup.controller.cursor)),/not current/);
  r.step([],start+600);r.step([x.wire(capacity(x,r))]);const second=runAction(r);r.reject(x.wire(second.a),/minimum spacing/);
  r.step([],start+3600);r.step([x.wire({type:'CLOSE_CENTURY_WARMUP_INTERVAL_V1',sequence:r.s.centuryWarmup.controller.sequence})]);r.step([x.wire(capacity(x,r))]);r.step([],start+3650);const expired=runAction(r);r.step([x.wire(expired.a)]);r.step([],start+3721);r.reopen();assert.equal(r.s.money.requests[expired.i.pid].status,'EXPIRED');assert.equal(r.s.centuryFunds.zeroStage.attempts,2);assert.equal(r.s.centuryFunds.zeroStage.chargedFeeMicro,'10000');assert.equal(r.s.centuryWarmup.controller.spentMicro,'5000');
  r.step([],start+10800);r.step([x.wire(capacity(x,r))]);const third=runAction(r);r.step([x.wire(third.a)]);r.step([x.finish(r.s,third.i)]);r.reopen();assert.equal(r.s.centuryFunds.zeroStage.attempts,3);
  r.step([],start+604800);r.reject(x.wire(capacity(x,r)),/pilot UTC/);assert.equal(r.s.centuryFunds.zeroStage.attempts,3);assert.equal(Object.keys(r.s.money.liability.records).length,0);
 }finally{r.db.close();}
});
test('pilot independent guard refuses changed payout/key, suspension, insufficient cover and count/fee exhaustion',()=>{
 const {x,r}=pilotFixture();try{launch(x,r);r.step([x.wire(capacity(x,r))]);const {i}=runAction(r);
  const id=x.f.ids[0];for(const mutate of [s=>s.money.nodes[id].key=keys().publicKey,s=>s.rewards.nodes[id].payouts=[],s=>s.money.liability.discipline[id]={suspended:true},s=>s.money.nodes[id].stake='8299999',s=>s.money.nodes[id].consensusHeld='0',s=>s.money.nodes[id].tier='0',s=>s.centuryFunds.zeroStage.attempts=696,s=>s.centuryFunds.zeroStage.chargedFeeMicro='3480000',s=>s.money.time+=604800]){const s=structuredClone(r.s);mutate(s);assert.throws(()=>recordZeroStageAttempt(s,i));}
  const s=structuredClone(r.s);recordZeroStageAttempt(s,i);s.money.time+=3599;assert.throws(()=>recordZeroStageAttempt(s,i),/minimum spacing/);s.money.time++;recordZeroStageAttempt(s,i);assert.equal(s.centuryFunds.zeroStage.attempts,2);
 }finally{r.db.close();}
});

test('unfunded pilot workers activate only from locked grants, earn fees and drain back to the pool without remint',()=>{
 const prepared=pilotFixture(),x=prepared.x,seed=structuredClone(prepared.r.s);prepared.r.db.close();
 // Preserve fixture supply while starting every payment worker at zero.
 const owned=Object.values(seed.money.outputs).find(o=>o.owner===x.f.alice.publicKey);
 for(const n of Object.values(seed.money.nodes)){owned.value=String(BigInt(owned.value)+BigInt(n.stake));n.stake='0';n.consensusHeld='0';n.taskHeld='0';n.tier='0';}
 const r=rig(x,seed,true,false),initialSupply=BigInt(seed.money.supply);
 const supportConsent=(node,type)=>{const body={domain:type,configHash:r.s.configHash,node,issuedAt:r.s.money.time,expires:r.s.money.time+300},signature=sign(body,x.key(node).privateKey);return {type,body,managementSignature:signature,workerSignature:signature};};
 try{
  launch(x,r);const start=r.s.money.time;r.step([],start+60);
  const s=r.s,total=String(BigInt(x.f.ids.length)*10000000n),body={domain:OPEN_SUPPORT,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+100,planHash:s.economicPreparation.planHash,managementEpoch:s.networkReserves.development.access.epoch,supplyBefore:s.money.supply,from:s.centuryFunds.execution.start,to:s.money.time,allocationMicro:total,perNodeCapMicro:'10000000',ownerCaps:{[supportOwnerGroup(s,x.f.ids[0])]:total},matchPPM:1000000,bootstrapNodes:x.f.ids};
  r.step([x.wire({type:OPEN_SUPPORT,certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey)})]);
  const outputs=structuredClone(r.s.money.outputs);let firstClaim;
  for(const node of x.f.ids){const a=supportConsent(node,CLAIM_SUPPORT);firstClaim??=a;r.step([x.wire(a,x.key(node))]);assert.equal(r.s.money.nodes[node].stake,'10000000');assert.equal(r.s.money.nodes[node].consensusHeld,'1000000');assert.equal(r.s.money.nodes[node].tier,'50000');}
  r.step([x.wire(firstClaim,x.key(firstClaim.body.node))]);r.reopen();
  for(const [id,o]of Object.entries(outputs))if(id!==supportOutput(r.s.configHash))assert.deepEqual(r.s.money.outputs[id],o);
  assert.equal(r.s.money.outputs[supportOutput(r.s.configHash)].value,'0');
  assert.equal(BigInt(r.s.money.supply)-initialSupply,BigInt(total)+10000000n);
  r.step([x.wire(capacity(x,r))]);r.step([],start+110);const {i,a}=runAction(r);r.step([x.wire(a)]);r.step([x.finish(r.s,i)]);
  assert.equal(r.s.money.requests[i.pid].status,'SETTLED');assert.equal(r.s.centuryWarmup.controller.spentMicro,'5000');
  const node=i.parts[0].nodes[0];r.step([x.wire(supportConsent(node,QUEUE_SUPPORT),x.key(node))]);
  assert.equal(r.s.money.nodes[node].tier,'0');assert.equal(r.s.money.nodes[node].consensusHeld,'1000000');
  r.reject(x.wire({type:RETURN_SUPPORT,node}),/cooldown/);
  // Even after the queue timer, independent unresolved obligations still fence release.
  const blocked=structuredClone(r.s);blocked.money.time=blocked.centuryFunds.support.book.grants[node].returnAfter;
  blocked.money.nodes[node].taskHeld='0';assert.throws(()=>releasePilotSupportReserve(blocked,node,blocked.centuryFunds.support.book.grants[node]),/unresolved/);
  r.step([],r.s.centuryFunds.support.book.grants[node].returnAfter);r.reopen();
  assert(BigInt(r.s.rewards.nodes[node].earned)>0n,'confirmed work earned fees');
  const beforeSupply=r.s.money.supply,beforeOutputs=structuredClone(r.s.money.outputs);
  r.step([x.wire({type:RETURN_SUPPORT,node})]);r.step([x.wire({type:RETURN_SUPPORT,node})]);r.reopen();
  assert.equal(r.s.money.nodes[node].stake,'0');assert.equal(r.s.money.nodes[node].consensusHeld,'0');assert.equal(r.s.money.supply,beforeSupply);
  assert.equal(r.s.money.outputs[supportOutput(r.s.configHash)].value,'10000000');
  for(const [id,o]of Object.entries(beforeOutputs))if(id!==supportOutput(r.s.configHash))assert.deepEqual(r.s.money.outputs[id],o);
  r.reject(x.wire(supportConsent(node,CLAIM_SUPPORT),x.key(node)),/one-time/);
 }finally{r.db.close();}
});
