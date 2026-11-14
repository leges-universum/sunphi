// Actual bounded-store transitions with synthetic balances and authorities.
import test from 'node:test';import assert from 'node:assert/strict';
import {issuanceFixture,certify} from './century-issuance.test.mjs';import {rig} from './bounded-century.test.mjs';
import {ISSUE_WARMUP_TRANCHE,ISSUE_CENTURY,START_CENTURY,centuryOrdinaryIssued,centuryVested} from '../century-issuance.mjs';
import {hash,keys,sign} from '../crypto.mjs';import {centuryWarmupPlan} from '../century-warmup.mjs';
const issue=(x,s,value='10000000')=>certify(x,s,ISSUE_WARMUP_TRANCHE,{supplyBefore:s.money.supply,trancheMicro:value});
const start=(x,s)=>certify(x,s,START_CENTURY,{settings:{controllerPolicy:{maximumRiseMicroPerSecond:'1000',operationalRateMicroPerSecond:'10000',intervalSeconds:600},maxPaymentMicro:'50000',timeBasis:x.c.obligationClock,ttlSeconds:120}});
test('small warmup tranche is closed in default stores and requires exact quorum/current manager',()=>{
 const x=issuanceFixture({utc:true}),closed=rig(x,x.s,false);try{closed.reject(x.wire(issue(x,closed.s)),/issuance forbidden/);}finally{closed.db.close();}
 const r=rig(x);try{
  for(const value of ['0','1','10000001'])r.reject(x.wire(issue(x,r.s,value)),/bounded/);
  const minority=issue(x,r.s);minority.certificate.approvals.pop();r.reject(x.wire(minority));
  const forged=issue(x,r.s);forged.founderConsent=sign(forged.certificate.body,keys().privateKey);r.reject(x.wire(forged));
  const original=structuredClone(r.s),a=issue(x,r.s);r.step([x.wire(a)]);assert.equal(BigInt(r.s.money.supply)-BigInt(original.money.supply),10000000n);
  assert.equal(r.s.centuryFunds.execution.partialWarmupMicro,'10000000');assert.equal(centuryOrdinaryIssued(r.s),10000000n);assert(!r.s.economicPreparation.memorial.issued);
  assert.equal(centuryVested(r.s,'founder'),0n);assert.equal(centuryVested(r.s,'development'),0n);
  for(const [id,o]of Object.entries(original.money.outputs))assert.deepEqual(r.s.money.outputs[id],o);
  r.step([x.wire(a)]);r.reopen();assert.equal(BigInt(r.s.money.supply)-BigInt(original.money.supply),10000000n);
  r.reject(x.wire(issue(x,r.s,'2')),/conflicting/);
  r.reject(x.wire({type:'RELEASE_CENTURY_FOUNDER_V1',manifestHash:r.s.centuryFunds.manifestHash,cumulativeMicro:'1'}),/unissued/);
 }finally{r.db.close();}
});
test('warmup principal, fees and later full allocation reconcile without issuing the tranche twice',()=>{
 const x=issuanceFixture({utc:true}),r=rig(x);try{
  r.step([x.wire(issue(x,r.s))]);const launch=r.s.centuryFunds.execution.start;r.step([x.wire(start(x,r.s))]);
  const w=r.s.centuryWarmup,b={domain:'DUEBYTE_WARMUP_CAPACITY_V2',configHash:r.s.configHash,generation:r.s.authority.generation,start:w.controller.start,from:w.controller.cursor,to:w.controller.cursor+600,observedHeight:r.s.height+1,observedAt:w.controller.cursor,sequence:1,healthy:true,capacityRateMicroPerSecond:'1000',controllerPolicyHash:hash(w.controllerPolicy)};
  r.step([x.wire({type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:{body:b,approvals:x.approvals(b)}})]);
  const i=centuryWarmupPlan(r.s.centuryWarmup,r.s.money);assert(i);r.step([x.wire({type:'RUN_CENTURY_WARMUP_V1',sequence:1,intentHash:hash(i)})]);
  r.reject(x.wire(certify(x,r.s,ISSUE_CENTURY,{supplyBefore:r.s.money.supply})),/finish current/);
  r.step([x.finish(r.s,i)]);assert.equal(r.s.centuryWarmup.controller.spentMicro,i.fee);
  const old=r.s.money.supply,full=certify(x,r.s,ISSUE_CENTURY,{supplyBefore:old});r.step([x.wire(full)]);
  assert.equal(BigInt(r.s.money.supply)-BigInt(old),130000000000000n-10000000n);
  assert.equal(r.s.centuryFunds.execution.start,launch);assert.equal(r.s.centuryWarmup.controller.start,launch);assert.equal(r.s.centuryWarmup.fundedMicro,'10000000000000');
  assert(!r.s.centuryFunds.execution.partialWarmupMicro);assert(r.s.economicPreparation.memorial.issued);r.step([x.wire(full)]);r.reopen();
  assert.equal(BigInt(r.s.money.supply)-BigInt(x.s.money.supply),130000000000000n);r.reject(x.wire(issue(x,r.s)),/conflicting/);
 }finally{r.db.close();}
});
test('interrupted partial allocation rolls back outputs and emission counters together',()=>{
 const x=issuanceFixture({utc:true}),r=rig(x);try{
  const before=hash(r.s),root=r.db.root,a=issue(x,r.s);
  assert.throws(()=>r.db.commitBlock({height:r.s.height+1,time:r.s.money.time,blockHash:hash('tranche-crash'),txs:[Buffer.from(JSON.stringify(x.wire(a)))]},root,{beforeCommit:()=>{throw Error('interrupted');}}),/interrupted/);
  r.reopen();assert.equal(hash(r.s),before);r.step([x.wire(a)]);r.reopen();assert.equal(r.s.centuryFunds.execution.issuedMicro,'10000000');
 }finally{r.db.close();}
});
