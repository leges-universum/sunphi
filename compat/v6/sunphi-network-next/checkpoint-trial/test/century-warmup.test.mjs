import test from 'node:test';import assert from 'node:assert/strict';
import {setup} from './payment-liability.test.mjs';
import {hash,sign} from '../crypto.mjs';import {stateHash,applyTx} from '../core.mjs';
import {previewTokenPrecision} from '../precision-preview.mjs';
import {makeEconomicPlanV3,economicTermsHash,ECONOMIC_POLICY_VERSION_V3,centuryWarmupAccounts} from '../economic-policy-v3.mjs';
import {applyEconomicPreparation} from '../economic-preparation.mjs';
import {initialCenturyWarmup,openCenturyWarmupInterval,centuryWarmupPlan,reserveCenturyWarmup,settleCenturyWarmup,closeUnusedCenturyInterval,auditCenturyWarmup} from '../century-warmup.mjs';
import {checkReservedPayment} from '../network-reserves.mjs';
import {paymentEvents} from '../../sunphi-wallet/payment-events.mjs';
import {paymentAmount} from '../../sunphi-wallet/frontend/payment-amounts.mjs';
import {anniversary,datedCumulative} from '../economic-policy-v2.mjs';
import {retainedCenturyActivity,centuryBudgetFromLedger} from '../century-accounting.mjs';
import {applyCenturyWarmupAction} from '../century-warmup.mjs';
import {Store} from '../store.mjs';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';

export function fixture(funded='10000000',options={}){
 const x=setup(options);let s=previewTokenPrecision(x.s).state;
 // Isolated fixture funds the programme from existing synthetic tokens. No mint.
 const output=Object.values(s.money.outputs).find(o=>o.owner===x.f.alice.publicKey);
 output.value=String(BigInt(output.value)-BigInt(funded));
 s.money.outputs[hash('synthetic programme funding')]={owner:centuryWarmupAccounts(s.configHash)[0],value:funded,unlock:0};
 const b={domain:'DUEBYTE_ECONOMIC_PREPARATION_V3',network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,
  notBefore:s.height,expires:s.height+100,version:ECONOMIC_POLICY_VERSION_V3,supplyBefore:s.money.supply,unitScale:s.money.unitScale,
  previousPlanHash:null,termsHash:economicTermsHash(makeEconomicPlanV3(s)),memorialManager:x.founder.publicKey};
 s=applyEconomicPreparation(s,{type:'PREPARE_ECONOMY_V3',certificate:{body:b,approvals:x.approvals(b)},founderConsent:sign(b,x.founder.privateKey)},x.c);
 const book=initialCenturyWarmup(s,{start:s.money.time,controllerPolicy:{maximumRiseMicroPerSecond:'1000',operationalRateMicroPerSecond:'10000'},maxPaymentMicro:'1234567',ttlBlocks:10});
 s=x.run(s);const certificate=(state,book,extra={})=>{const body={domain:'DUEBYTE_WARMUP_CAPACITY_V2',configHash:state.configHash,generation:state.authority.generation,start:book.controller.start,
  from:book.controller.cursor,to:book.controller.cursor+60,observedHeight:state.height,observedAt:book.controller.cursor,sequence:book.controller.sequence+1,healthy:true,capacityRateMicroPerSecond:'1000',controllerPolicyHash:hash(book.controllerPolicy),...extra};
  return {body,approvals:x.approvals(body)};};
 return {...x,s,book,certificate};
}
test('century controller reserves real fractional work and charges exactly one fee without mint',async()=>{
 const x=fixture(),source=hash(x.s);let book=openCenturyWarmupInterval(x.book,x.s,x.certificate(x.s,x.book));
 const intent=centuryWarmupPlan(book,x.s.money);assert.equal(intent.value,'1234567');assert.equal(intent.fee,'37038');assert.equal(intent.abortFee,'0');
 const reserved=reserveCenturyWarmup(book,x.s.money,hash(intent));book=reserved.book;
 let s={...x.s,money:reserved.money};stateHash(s,x.c);const finish=x.finish(s,intent);s=x.run(s,[finish]);
 book=settleCenturyWarmup(book,s.money);assert.equal(book.controller.spentMicro,'37038');assert.equal(s.money.fees,'37038');
 assert.equal(book.last.externalDemandMicro,'0');assert.equal(s.money.supply,x.s.money.supply);assert.equal(hash(x.s),source);
 const activity=retainedCenturyActivity(s);assert.equal(activity.ordinaryFeesMicro,'0');assert.equal(activity.warmupFeesMicro,'37038');assert.equal(activity.externalDemandProven,false);
 const saved=JSON.parse(JSON.stringify({book,s}));assert.deepEqual(settleCenturyWarmup(saved.book,saved.s.money),book);
 s=x.run(s,[finish]);assert.deepEqual(settleCenturyWarmup(book,s.money),book);assert.equal(s.money.fees,'37038');
 const [event]=await paymentEvents(s,{body:{network:x.c.chainId}});assert.equal(paymentAmount(event.amount,event.unitScale),'1.234567');
 assert.equal(paymentAmount(event.chargedFee,event.unitScale),'0.037038');
 assert(!s.rewards&&!s.networkReserves.issued);assert.equal(s.economicPreparation.memorial.balanceMicro,'0');
 assert.throws(()=>applyTx(x.s,Buffer.from(JSON.stringify(x.wire({type:'RUN_CENTURY_WARMUP_V1'}))),x.c,x.s.money.time),/public action/);
});
test('warmup expiry returns all principal and reserved commission, including after restart',()=>{
 const x=fixture();let book=openCenturyWarmupInterval(x.book,x.s,x.certificate(x.s,x.book));
 const i=centuryWarmupPlan(book,x.s.money),r=reserveCenturyWarmup(book,x.s.money,hash(i));
 let s={...x.s,money:r.money};book=JSON.parse(JSON.stringify(r.book));s=x.drain(s,i.pid);
 assert.equal(s.money.requests[i.pid].status,'EXPIRED');book=settleCenturyWarmup(book,s.money);
 assert.equal(book.controller.spentMicro,'0');assert.equal(s.money.fees,'0');assert.equal(book.controller.reservedMicro,'0');auditCenturyWarmup(book,s.money);
});
test('capacity loss closes unused allowance without catchup; stale, future and minority certificates fail',()=>{
 const x=fixture(),cert=x.certificate(x.s,x.book);const few=structuredClone(cert);few.approvals.pop();assert.throws(()=>openCenturyWarmupInterval(x.book,x.s,few),/quorum/);
 assert.throws(()=>openCenturyWarmupInterval(x.book,x.s,x.certificate(x.s,x.book,{from:x.s.money.time+1})),/not current/);
 const book=openCenturyWarmupInterval(x.book,x.s,x.certificate(x.s,x.book,{healthy:false}));assert.equal(centuryWarmupPlan(book,x.s.money),null);
 assert.throws(()=>closeUnusedCenturyInterval(book,x.s.money),/still open/);
 const later=x.run(x.s,[],book.controller.pending.to),closed=closeUnusedCenturyInterval(book,later.money);
 assert.equal(closed.controller.spentMicro,'0');assert.throws(()=>openCenturyWarmupInterval(closed,later,cert),/not current/);
 const next=openCenturyWarmupInterval(closed,later,x.certificate(later,closed));assert.equal(next.controller.reservedMicro,'60000');
});
test('program accounts reject ordinary transfers and a changed payment plan cannot spend',()=>{
 const x=fixture(),book=openCenturyWarmupInterval(x.book,x.s,x.certificate(x.s,x.book));
 assert.throws(()=>checkReservedPayment(x.s,{sender:x.f.alice.publicKey,recipient:book.accounts[0]}),/program accounts/);
 assert.throws(()=>reserveCenturyWarmup(book,x.s.money,hash('other')),/plan changed/);
 const i=centuryWarmupPlan(book,x.s.money);assert.throws(()=>x.run(x.s,[x.reserve(i)]));
 const damaged=structuredClone(x.s.money);damaged.outputs[hash('synthetic programme funding')].value='0';assert.throws(()=>auditCenturyWarmup(book,damaged),/conservation|conserved/);
});
test('one remaining micro-unit is consumed once as programme fee, never as an ordinary transfer',async()=>{
 const x=fixture('1'),book=openCenturyWarmupInterval(x.book,x.s,x.certificate(x.s,x.book)),i=centuryWarmupPlan(book,x.s.money);
 assert.equal(i.value,'0');assert.equal(i.fee,'1');const r=reserveCenturyWarmup(book,x.s.money,hash(i));
 const s=x.run({...x.s,money:r.money},[x.finish({...x.s,money:r.money},i)]),settled=settleCenturyWarmup(r.book,s.money);
 assert.equal(settled.controller.spentMicro,'1');assert.equal(s.money.fees,'1');auditCenturyWarmup(settled,s.money);
 assert.deepEqual(await paymentEvents(s,{body:{network:x.c.chainId}}),[]);
});
test('five-year warmup and century regular allocations preserve the memorial separation exactly',()=>{
 const x=fixture(),start=x.book.controller.start,e=x.s.economicPreparation.plan;
 assert.equal(datedCumulative({start,at:anniversary(start,2),kind:'warmup'}),'5000000000000');
 assert.equal(datedCumulative({start,at:anniversary(start,5),kind:'warmup'}),e.warmupMicro);
 const regular=datedCumulative({start,at:anniversary(start,100),kind:'regular',existingSupplyMicro:e.existingSupplyMicro});
 assert.equal(BigInt(regular)+BigInt(e.existingSupplyMicro)+BigInt(e.warmupMicro)+BigInt(e.developmentMicro)+BigInt(e.founderMicro)+BigInt(e.memorialMicro),BigInt(e.capMicro));
 assert.equal(datedCumulative({start,at:anniversary(start,1)-1,kind:'founder'}),'0');
 assert.equal(datedCumulative({start,at:anniversary(start,1),kind:'founder'}),'1000000000000');
 const input={calendar:{start,from:start,to:start+60,existingSupplyMicro:e.existingSupplyMicro},futureFixedReservedMicro:String(BigInt(e.warmupMicro)+BigInt(e.developmentMicro)+BigInt(e.founderMicro)),
  lifetimeRemainingMicro:e.regularMicro,operationalCapMicro:'1000000',ordinaryCostMicro:'12345',ordinaryFeesMicro:'0',renewalCostMicro:'0',renewalFeesMicro:'0',renewalQualified:false};
 assert.equal(centuryBudgetFromLedger(x.s,input).maximumMicro,'12345');
 assert.equal(centuryBudgetFromLedger(x.s,input).issuanceEnabled,false);
 assert.throws(()=>centuryBudgetFromLedger(x.s,{...input,supplyMicro:'0'}),/ledger-derived/);
});

test('core commits programme and ledger outcome together and restores both from SQLite',()=>{
 const x=fixture();let s={...x.s,centuryWarmup:x.book};stateHash(s,x.c);
 s=applyCenturyWarmupAction(s,{type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:x.certificate(s,s.centuryWarmup)});
 const i=centuryWarmupPlan(s.centuryWarmup,s.money);
 s=applyCenturyWarmupAction(s,{type:'RUN_CENTURY_WARMUP_V1',sequence:1,intentHash:hash(i)});stateHash(s,x.c);
 const path=join(mkdtempSync(join(tmpdir(),'century-warmup-')),'state.sqlite');let db=new Store(path,x.c);db.restore(s);db.close();db=new Store(path,x.c);s=db.state;db.close();
 const finish=x.finish(s,i);db=new Store(path,x.c);
 db.finalize({height:s.height+1,blockHash:hash({height:s.height+1}),time:s.money.time,txs:[Buffer.from(JSON.stringify(finish))]});
 assert.equal(db.state.centuryWarmup.controller.spentMicro,'0');assert(db.state.centuryWarmup.pending);
 db.commit();s=db.state;db.close();assert.equal(s.centuryWarmup.controller.spentMicro,'37038');assert.equal(s.centuryWarmup.pending,null);
 db=new Store(path,x.c);assert.equal(stateHash(db.state,x.c),stateHash(s,x.c));db.close();
 s=x.run(s,[finish]);assert.equal(s.centuryWarmup.controller.spentMicro,'37038');
 const changed=structuredClone(s);changed.centuryWarmup.controller.reservedMicro='1';assert.throws(()=>stateHash(changed,x.c));
 assert.equal(s.money.supply,x.s.money.supply);
});
