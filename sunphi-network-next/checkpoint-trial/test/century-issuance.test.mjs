import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {setup} from './payment-liability.test.mjs';import {hash,keys,sign} from '../crypto.mjs';import {stateHash,applyTx} from '../core.mjs';
import {applyEconomicPreparation} from '../economic-preparation.mjs';import {makeEconomicPlanV4,makeEconomicPlanV3,economicTermsHash,ECONOMIC_POLICY_VERSION_V4,ECONOMIC_POLICY_VERSION_V3} from '../economic-policy-v3.mjs';
import {previewTokenPrecision} from '../precision-preview.mjs';import {applyCenturyFees,CENTURY_FEES_ACTION} from '../century-fees.mjs';
import {applyCenturyFunds,centuryFundsManifest,CENTURY_FUNDS_ACTION} from '../century-funds.mjs';
import {applyCenturyIssuance,ISSUE_CENTURY,START_CENTURY,centuryVested} from '../century-issuance.mjs';
import {anniversary} from '../economic-policy-v2.mjs';import {Store} from '../store.mjs';import {applyCenturyWarmupAction,centuryWarmupPlan} from '../century-warmup.mjs';
import {subsidyCertificate} from './century-subsidy.test.mjs';import {applyCenturySubsidy,CENTURY_SERVICE} from '../century-subsidy.mjs';
export function preparation(x,s,version=4){const plan=version===4?makeEconomicPlanV4(s):makeEconomicPlanV3(s),b={domain:'DUEBYTE_ECONOMIC_PREPARATION_V'+version,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+100,version:plan.version,supplyBefore:s.money.supply,unitScale:s.money.unitScale??'1',previousPlanHash:s.economicPreparation?.planHash??null,termsHash:economicTermsHash(plan),memorialManager:x.founder.publicKey};return {type:'PREPARE_ECONOMY_V'+version,certificate:{body:b,approvals:x.approvals(b)},founderConsent:sign(b,x.founder.privateKey)};}
export function issuanceFixture(){
 const x=setup(),recipient=keys();let s=applyEconomicPreparation(x.s,preparation(x,x.s),x.c);s=previewTokenPrecision(s).state;
 const b={domain:CENTURY_FEES_ACTION,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+1,activation:s.height+3,periodBlocks:10,planHash:s.economicPreparation.planHash};
 s=applyCenturyFees(s,{type:CENTURY_FEES_ACTION,certificate:{body:b,approvals:x.approvals(b)},founderConsent:sign(b,x.founder.privateKey)},x.c);while(!s.rewards)s=x.run(s);
 const body={domain:CENTURY_FUNDS_ACTION,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+100,manifest:centuryFundsManifest(s,recipient.publicKey),previousManifestHash:null};
 s=applyCenturyFunds(s,{type:CENTURY_FUNDS_ACTION,certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey),recipientConsent:sign(body,recipient.privateKey)},x.c);return {...x,s,recipient};
}
export function certify(x,s,type,extra={}){const b={domain:type,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+100,planHash:s.economicPreparation.planHash,manifestHash:s.centuryFunds.manifestHash,managementEpoch:s.networkReserves.development.access.epoch,...extra};return {type,certificate:{body:b,approvals:x.approvals(b)},founderConsent:sign(b,x.founder.privateKey)};}
const execute=(x,s,a,author=x.founder.publicKey)=>{const n=applyCenturyIssuance(s,a,x.c,author);stateHash(n,x.c);return n;};
const issue=x=>execute(x,x.s,certify(x,x.s,ISSUE_CENTURY,{supplyBefore:x.s.money.supply}));
const at=(s,t)=>({...s,money:{...s.money,time:t}});
const owned=(s,key)=>Object.values(s.money.outputs).filter(o=>o.owner===key).reduce((n,o)=>n+BigInt(o.value),0n);
const queue=(x,s,extra={})=>({type:'QUEUE_CENTURY_DEVELOPMENT_V1',managementEpoch:s.networkReserves.development.access.epoch,sequence:s.centuryFunds.execution.sequence+1,recipient:x.f.bob.publicKey,valueMicro:'1234567',purpose:'Sun-Phi business service development',reference:hash('synthetic decision'),...extra});
const command=(s,type)=>({type,sequence:s.centuryFunds.execution.pending.sequence,instructionHash:hash(s.centuryFunds.execution.pending)});

test('V4 adds nine memorial millions without changing V3 history or regular rewards; safe pre-activation upgrade',()=>{
 const x=setup(),old=applyEconomicPreparation(x.s,preparation(x,x.s,3),x.c),before=hash(old),next=applyEconomicPreparation(old,preparation(x,old),x.c);
 assert.equal(old.economicPreparation.plan.version,ECONOMIC_POLICY_VERSION_V3);assert.equal(hash(old),before);stateHash(old,x.c);
 assert.equal(next.economicPreparation.plan.version,ECONOMIC_POLICY_VERSION_V4);assert.equal(next.economicPreparation.plan.capMicro,'10010000000000000');assert.equal(next.economicPreparation.plan.memorialMicro,'10000000000000');
 assert.deepEqual(next.economicPreparation.plan.annualRegularMicro,old.economicPreparation.plan.annualRegularMicro);assert.deepEqual(next.money,old.money);
 assert.throws(()=>applyEconomicPreparation(next,preparation(x,next,3),x.c),/downgrade/);stateHash(next,x.c);
 assert.throws(()=>applyTx(x.s,Buffer.from(JSON.stringify(x.wire(preparation(x,x.s)))),x.c,x.s.money.time),/public action/);
});
test('exact one-time issuance preserves all existing outputs and mints only the four fixed allocations',()=>{
 const x=issuanceFixture(),a=certify(x,x.s,ISSUE_CENTURY,{supplyBefore:x.s.money.supply}),s=execute(x,x.s,a);
 assert.equal(BigInt(s.money.supply)-BigInt(x.s.money.supply),130000000000000n);assert.equal(s.money.fees,x.s.money.fees);
 for(const [id,o] of Object.entries(x.s.money.outputs))assert.deepEqual(s.money.outputs[id],o);
 assert.equal(s.centuryFunds.execution.start,s.money.time);assert.equal(s.centuryFunds.execution.warmupStart,null);assert(!s.centuryWarmup);
 assert.equal(s.economicPreparation.memorial.balanceMicro,'10000000000000');assert.equal(owned(s,x.recipient.publicKey),0n);assert.equal(execute(x,s,a),s);
 assert.throws(()=>applyTx(x.s,Buffer.from(JSON.stringify(x.wire(a))),x.c,x.s.money.time),/public action/);
 for(const change of [q=>q.certificate.approvals.pop(),q=>q.founderConsent=sign(q.certificate.body,keys().privateKey),q=>q.certificate.body.supplyBefore='1']){const bad=structuredClone(a);change(bad);assert.throws(()=>execute(x,x.s,bad));}
 const bad=structuredClone(s);bad.money.supply=String(BigInt(bad.money.supply)+1n);assert.throws(()=>stateHash(bad,x.c));
});
test('founder vesting at annual boundaries is cumulative, bounded, replay-safe and does not mint',()=>{
 const x=issuanceFixture(),s=issue(x),start=s.centuryFunds.execution.start;
 const release=(q,value)=>execute(x,q,{type:'RELEASE_CENTURY_FOUNDER_V1',manifestHash:q.centuryFunds.manifestHash,cumulativeMicro:value},keys().publicKey);
 assert.throws(()=>release(at(s,anniversary(start,1)-1),'1'),/still locked/);
 assert.throws(()=>release(at(s,anniversary(start,1)),'1'),/complete vested tranche/);
 let next=release(at(s,anniversary(start,1)),'1000000000000');assert.equal(owned(next,x.recipient.publicKey),1000000000000n);assert.equal(release(next,'1000000000000'),next);
 assert.throws(()=>release(next,'1000000000001'),/still locked/);next=release(at(next,anniversary(start,10)),'10000000000000');assert.equal(owned(next,x.recipient.publicKey),10000000000000n);assert.equal(next.money.supply,s.money.supply);
 const dbfile=join(mkdtempSync(join(tmpdir(),'century-vesting-')),'state.sqlite');let db=new Store(dbfile,x.c);db.restore(next);db.close();db=new Store(dbfile,x.c);assert.equal(stateHash(db.state,x.c),stateHash(next,x.c));db.close();
});
test('development unlocked funds require current manager, public purpose, cancellation and exact-once execution',()=>{
 const x=issuanceFixture();let s=issue(x);assert.throws(()=>execute(x,s,queue(x,s)),/still locked/);s=at(s,anniversary(s.centuryFunds.execution.start,1));
 assert.throws(()=>execute(x,s,queue(x,s),keys().publicKey));assert.throws(()=>execute(x,s,queue(x,s,{purpose:''})));assert.throws(()=>execute(x,s,queue(x,s,{recipient:s.centuryFunds.manifest.memorial.account})),/ordinary recipient/);
 s=execute(x,s,queue(x,s));const cancelled=command(s,'CANCEL_CENTURY_DEVELOPMENT_V1');s=execute(x,s,cancelled);assert.equal(execute(x,s,cancelled),s);
 s=execute(x,s,queue(x,s));const paid=command(s,'EXECUTE_CENTURY_DEVELOPMENT_V1'),before=owned(s,x.f.bob.publicKey),supply=s.money.supply;s=execute(x,s,paid,keys().publicKey);assert.equal(owned(s,x.f.bob.publicKey)-before,1234567n);assert.equal(s.money.supply,supply);assert.equal(execute(x,s,paid),s);
 assert.equal(s.centuryFunds.execution.last.purpose,'Sun-Phi business service development');
});
test('warmup starts separately, preserves full custody, settles fees and shares the launch subsidy clock',()=>{
 const x=issuanceFixture();let s=issue(x);s=x.run(s,[],s.money.time+10);
 const a=certify(x,s,START_CENTURY,{settings:{controllerPolicy:{maximumRiseMicroPerSecond:'1000',operationalRateMicroPerSecond:'10000'},maxPaymentMicro:'1234567',ttlBlocks:10}});s=execute(x,s,a);assert.equal(execute(x,s,a),s);
 assert.equal(s.centuryFunds.execution.warmupStart-s.centuryFunds.execution.start,10);
 s=applyCenturySubsidy(s,subsidyCertificate(x,s,{start:s.centuryFunds.execution.start}),x.c);
 const w=s.centuryWarmup,b={domain:'DUEBYTE_WARMUP_CAPACITY_V2',configHash:s.configHash,generation:s.authority.generation,start:w.controller.start,from:w.controller.cursor,to:w.controller.cursor+60,observedHeight:s.height+1,observedAt:w.controller.cursor,sequence:1,healthy:true,capacityRateMicroPerSecond:'1000',controllerPolicyHash:hash(w.controllerPolicy)};
 s=x.run(s);s=applyCenturyWarmupAction(s,{type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:{body:b,approvals:x.approvals(b)}});const i=centuryWarmupPlan(s.centuryWarmup,s.money);assert(i);
 s=applyCenturyWarmupAction(s,{type:'RUN_CENTURY_WARMUP_V1',sequence:1,intentHash:hash(i)});s=x.run(s,[x.finish(s,i)]);s=x.run(s,[],s.centurySubsidy.pending.to);
 assert.equal(s.centuryWarmup.controller.spentMicro,i.fee);assert(BigInt(s.rewards.minted)>0n);assert.equal(BigInt(s.money.supply),BigInt(x.s.money.supply)+130000000000000n+BigInt(s.rewards.minted));stateHash(s,x.c);
});

test('development expiry, recovery and changed manager cannot revive stale spending',()=>{
 const x=issuanceFixture();let s=issue(x);s=at(s,anniversary(s.centuryFunds.execution.start,1));s=execute(x,s,queue(x,s));
 const pay=command(s,'EXECUTE_CENTURY_DEVELOPMENT_V1');assert.throws(()=>execute(x,at(s,s.centuryFunds.execution.pending.expiresAt+1),pay),/execution window/);
 const frozen=structuredClone(s);frozen.networkReserves.development.access.pending={};assert.throws(()=>applyCenturyIssuance(frozen,pay,x.c,x.founder.publicKey),/stable current/);
 const manager=keys(),access=s.networkReserves.development.access,body={domain:'DUEBYTE_RESERVE_RECOVERY_V1/ROTATE_DEVELOPMENT_MANAGER_V1',configHash:s.configHash,epoch:access.epoch,manager:manager.publicKey};
 s=x.run(s,[x.wire({type:'ROTATE_DEVELOPMENT_MANAGER_V1',managementEpoch:access.epoch,manager:manager.publicKey,newConsent:sign(body,manager.privateKey)},x.founder)]);
 assert.throws(()=>execute(x,s,pay),/stale development/);assert.throws(()=>execute(x,s,command(s,'CANCEL_CENTURY_DEVELOPMENT_V1')));
 s=execute(x,s,command(s,'CANCEL_CENTURY_DEVELOPMENT_V1'),manager.publicKey);assert.equal(s.centuryFunds.execution.developmentSpentMicro,'0');
});

test('uncommitted synthetic issuance disappears on restart; source state and supply stay unchanged',()=>{
 const x=issuanceFixture(),path=join(mkdtempSync(join(tmpdir(),'century-issue-atomic-')),'state.sqlite');let db=new Store(path,x.c);db.restore(x.s);
 const candidate=issue(x);assert(BigInt(candidate.money.supply)>BigInt(db.state.money.supply));db.close();db=new Store(path,x.c);
 assert.equal(stateHash(db.state,x.c),stateHash(x.s,x.c));assert(!db.state.centuryFunds.execution);db.close();db=new Store(path+'.issued',x.c);db.restore(candidate);db.close();db=new Store(path+'.issued',x.c);assert.equal(stateHash(db.state,x.c),stateHash(candidate,x.c));db.close();
});
