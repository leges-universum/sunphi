import test from 'node:test';import assert from 'node:assert/strict';
import {keys,hash} from '../crypto.mjs';
import {zeroStageProposal,zeroStageReadiness,sharedRegularAllowance,ZERO_STAGE_DEFAULTS} from '../research/zero-stage-plan.mjs';
import {planCollateralBootstrap} from '../research/collateral-bootstrap-plan.mjs';
const owner=hash('pilot owner'),recipient=keys().publicKey;
const workers=Array.from({length:10},(_,i)=>({node:hash(['pilot',i]),key:keys().publicKey,operator:owner,recipient}));
const input=()=>({configHash:hash('pilot chain'),root:hash('observed root'),height:10,workers,settings:{...ZERO_STAGE_DEFAULTS}});

test('seven-day zero stage separates principal, fees and locked collateral with exact fractions',()=>{
 const p=zeroStageProposal(input()),b=p.body;
 assert.equal(b.supportMicro,'100000000');assert.equal(b.totalInitialMicro,'110000000');
 assert.equal(b.maximumPayments,696);assert.equal(b.feePerPaymentMicro,'5000');
 assert.equal(b.maximumFeesMicro,'3480000');assert.equal(b.remainingWarmupMicro,'6520000');
 assert.deepEqual(b.phases.map(p=>p.maximumPayments),[24,96,576]);
 assert.equal(b.retainedRecords,146);assert.equal(b.retainedAssignments,438);assert.equal(b.worstCaseWorkerMicro,'8300000');
 assert.equal(b.externalDemandMicro,'0');assert.equal(b.emissionStart,null);assert(!b.issuanceAuthorized);
 assert.equal(zeroStageProposal({...input(),workers:[...workers].reverse()}).proposalHash,p.proposalHash);
 for(const change of [{paymentMicro:'100000'},{spacingSeconds:120},{maxOpen:32},{maxAssignments:400},{warmupTrancheMicro:'700000'},{durationSeconds:604801}])
  assert.throws(()=>zeroStageProposal({...input(),settings:{...ZERO_STAGE_DEFAULTS,...change}}));
});

test('readiness cannot authorize mint; stale state, foreign chain and missing payouts fail closed',()=>{
 const p=zeroStageProposal(input()),o={configHash:p.body.configHash,root:p.body.observedRoot,height:10,unitScale:'1000000',supplyMicro:'0',boundNodes:workers.map(w=>w.node),liabilityReady:false,coverageReady:false};
 const r=zeroStageReadiness(p,o);assert(!r.readyForIssuance);assert(r.reasons.includes('NO_EXISTING_TOKENS_FOR_PURCHASE_OR_BOND'));assert(r.reasons.includes('LIABILITY_NOT_READY'));
 const stale=zeroStageReadiness(p,{...o,root:hash('next block'),boundNodes:[]});assert(stale.reasons.includes('REVIEW_STATE_CHANGED'));assert(stale.reasons.includes('PAYOUT_BINDING_MISSING'));
 assert(!zeroStageReadiness(p,{...o,supplyMicro:'110000000',liabilityReady:true,coverageReady:true}).readyForIssuance);
 assert.throws(()=>zeroStageReadiness({...p,body:{...p.body,totalInitialMicro:'1'}},o));
});

test('bootstrap and normal subsidy cannot spend the same calendar allowance twice',()=>{
 const start=1794240000,q={start,at:start,existingSupplyMicro:'0',supportIssuedMicro:'0',subsidyIssuedMicro:'0'};
 assert.equal(sharedRegularAllowance(q).remainingMicro,'0');
 assert.throws(()=>sharedRegularAllowance({...q,supportIssuedMicro:'1'}));
 assert.throws(()=>sharedRegularAllowance({...q,at:start+20,supportIssuedMicro:'100000000'}));
 const a=sharedRegularAllowance({...q,at:start+30,supportIssuedMicro:'100000000'});
 assert.equal(a.calendarMicro,'128424657');assert.equal(a.remainingMicro,'28424657');
 assert.equal(sharedRegularAllowance({...q,at:start+30,supportIssuedMicro:'100000000',subsidyIssuedMicro:a.remainingMicro}).remainingMicro,'0');
 assert.throws(()=>sharedRegularAllowance({...q,at:start+30,supportIssuedMicro:'100000000',subsidyIssuedMicro:String(BigInt(a.remainingMicro)+1n)}));
});

test('slashed or retired support cannot reset lifetime admission history for another grant',()=>{
 const node=workers[0].node,p={periodBudgetMicro:'1000000000',periodAlreadyIssuedMicro:'10000000',supportBudgetMicro:'100000000',supportAlreadyIssuedMicro:'10000000',perNodeCapMicro:'10000000',ownerCaps:{[owner]:'10000000'},matchPPM:100000,bootstrapNodes:[node],nodes:[{node,ownerGroup:owner,recipient,ownCollateralMicro:'0',nodeGrantedMicro:'10000000',ownerGrantedMicro:'10000000'}]};
 assert.equal(planCollateralBootstrap(p).newSupportMicro,'0');
 const replacement={...p.nodes[0],node:hash('replacement'),nodeGrantedMicro:'0'};
 assert.equal(planCollateralBootstrap({...p,nodes:[replacement]}).newSupportMicro,'0');
});

// Arithmetic rehearsal, not a consensus qualification. Every slot is at most
// one attempt; missed slots are discarded rather than replayed after downtime.
test('seven-day principal circulation conserves funds through expiry, partitions and restart',()=>{
 const b=zeroStageProposal(input()).body;
 for(const scenario of ['healthy','partition','expiry','stopped']){
  let ledger={balances:['5000000','5000000'],fees:'0',success:0,failed:0,skipped:0,holds:[]},peak=0;
  const times=b.phases.flatMap(p=>Array.from({length:p.maximumPayments},(_,i)=>p.from+i*p.spacingSeconds));
  for(let slot=0;slot<b.maximumPayments;slot++){
   const time=times[slot];ledger.holds=ledger.holds.filter(h=>h.release>time);
   if(scenario==='partition'&&slot>=100&&slot<200||scenario==='stopped'&&slot>=144){ledger.skipped++;continue;}
   const held=ledger.holds.reduce((v,h)=>v+BigInt(h.value),0n);
   assert(held+BigInt(b.settings.paymentMicro)+BigInt(b.settings.consensusReserveMicro)<=10000000n);
   assert(ledger.holds.length<b.settings.maxOpen); // worst case: same three workers
   const failed=scenario==='expiry'&&slot%3===0;
   ledger.holds.push({release:time+(failed?b.settings.ttlSeconds:20)+b.settings.challengeSeconds,value:b.settings.paymentMicro});
   peak=Math.max(peak,ledger.holds.length);
   if(failed){ledger.failed++;continue;}
   const from=ledger.success%2,to=1-from,value=BigInt(b.settings.paymentMicro),fee=BigInt(b.feePerPaymentMicro);
   assert(BigInt(ledger.balances[from])>=value+fee);
   ledger.balances[from]=String(BigInt(ledger.balances[from])-value-fee);ledger.balances[to]=String(BigInt(ledger.balances[to])+value);
   ledger.fees=String(BigInt(ledger.fees)+fee);ledger.success++;
   if(slot%71===0)ledger=JSON.parse(JSON.stringify(ledger));
   assert.equal(BigInt(ledger.balances[0])+BigInt(ledger.balances[1])+BigInt(ledger.fees),10000000n);
  }
  assert(peak<=b.retainedRecords);assert(BigInt(ledger.fees)<=BigInt(b.maximumFeesMicro));
  assert.equal(ledger.success+ledger.failed+ledger.skipped,b.maximumPayments);
  if(scenario==='healthy')assert.equal(ledger.fees,'3480000');
  if(scenario==='partition')assert.equal(ledger.success,596);
  if(scenario==='stopped')assert.equal(ledger.success,144);
 }
});
