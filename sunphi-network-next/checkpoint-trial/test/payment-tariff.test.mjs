import test from 'node:test';import assert from 'node:assert/strict';
import {hash,sign,keys} from '../crypto.mjs';
import {INITIAL_TARIFF,LEGACY_TARIFF_VERSION,workFee,activePaymentTariff,guardPaymentTariff} from '../payment-tariff.mjs';
import {SCHEDULE_TARIFF} from '../payment-tariff-governance.mjs';
import {reviewPaymentTariff} from '../research/payment-tariff-review.mjs';
import {issuanceFixture} from './century-issuance.test.mjs';import {rig} from './bounded-century.test.mjs';
import {paymentQuote,validatePaymentReview} from '../wallet-amounts.mjs';
import {plan,outgoingStatus} from '../wallet.mjs';
import {feeFor,releaseFeeFor,validateIntentShape} from '../payment-model.mjs';
function certificate(x,s,over={}){const body={domain:SCHEDULE_TARIFF,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,managementEpoch:s.networkReserves.development.access.epoch,notBefore:s.height,expires:s.height+100,previous:hash(activePaymentTariff(s.money)),profile:INITIAL_TARIFF,activation:s.money.time+86400,economics:null,...over};return {type:SCHEDULE_TARIFF,certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey)};}
function intent(x,s,value='1000000'){const parts=plan(s.money,value),schedule=activePaymentTariff(s.money);return x.intent(s,{inputs:Object.entries(s.money.outputs).filter(([,o])=>o.owner===x.f.alice.publicKey&&BigInt(o.value)>0n&&o.unlock<=s.money.time).map(([id])=>id),unitScale:'1000000',epoch:s.money.epoch,value,fee:String(feeFor(value,schedule,parts.length)),abortFee:String(releaseFeeFor(value,'1000000',schedule)),parts,...(schedule?{feeSchedule:schedule}:{})});}
test('0.06 percent fee has exact minimum boundaries, no cap or part surcharge, and preserves legacy schedules',()=>{
 for(const [v,f] of [['1',5000n],['1000000',5000n],['8333333',5000n],['8333334',5001n],['100000000',60000n],['1000000000',600000n],['10000000000',6000000n],['1000000000000',600000000n],['18446744073709551615',11068046444225731n]])assert.equal(feeFor(v,INITIAL_TARIFF),f);assert.equal(feeFor('1000000000000',INITIAL_TARIFF,32),600000000n);
 assert.equal(workFee(INITIAL_TARIFF,3),0n);assert.equal(workFee(INITIAL_TARIFF,32),0n);
 for(const p of [0,33,1.5])assert.throws(()=>workFee(INITIAL_TARIFF,p));assert.throws(()=>workFee({...INITIAL_TARIFF,baseMicro:'5001'}));
 assert.equal(releaseFeeFor('1','1000000',INITIAL_TARIFF),500n);assert.equal(feeFor('1000000'),30000n);
 const legacy={version:LEGACY_TARIFF_VERSION,baseMicro:'1000',capMicro:'100000',rateDen:'100000',additionalPartMicro:'200'};assert.equal(feeFor('1000000000000',legacy,32),106200n);assert.throws(()=>feeFor('1',{...INITIAL_TARIFF,capMicro:'100000'}));
});
test('signed UTC tariff activates prospectively, preserves old reservations and survives indexed restart',()=>{
 const x=issuanceFixture({utc:true,expanded:true}),r=rig(x,x.s,false,false);try{
  r.step([],r.s.money.time+20*86400);r.step([],r.s.money.time+20*86400);const supply=r.s.money.supply,a=certificate(x,r.s),activation=a.certificate.body.activation;
  const missing=structuredClone(a);missing.certificate.approvals=missing.certificate.approvals.slice(0,6);r.reject(x.wire(missing));
  const forged=structuredClone(a);forged.founderConsent=sign(a.certificate.body,keys().privateKey);r.reject(x.wire(forged));
  r.reject(x.wire(certificate(x,r.s,{activation:r.s.money.time+86399})));r.step([x.wire(a)]);r.step([x.wire(a)]);
  r.reject(x.wire(certificate(x,r.s,{activation:activation+10})),/pending/);r.step([],activation-10);
  const old=intent(x,r.s);r.step([x.reserve(old)]);r.step([],activation);r.reopen();assert.deepEqual(activePaymentTariff(r.s.money),INITIAL_TARIFF);
  r.step([x.reserve(old)]);r.step([x.finish(r.s,old)]);assert.equal(r.s.money.requests[old.pid].intent.fee,'30000');assert.equal(r.s.money.supply,supply);
  const i=intent(x,r.s);validateIntentShape(i);r.step([x.reserve(i)]);r.step([x.finish(r.s,i)]);assert.equal(r.s.money.requests[i.pid].intent.fee,'5000');
  const q=paymentQuote(r.s,'1','1000000'),review={value:'1',unitScale:q.unitScale,fee:q.fee,abortFee:q.abortFee,feeSchedule:q.feeSchedule,partsCount:q.partsCount};
  assert.equal(validatePaymentReview(r.s,review).fee,'5000');assert.throws(()=>validatePaymentReview(r.s,{...review,fee:'999'}));assert.throws(()=>validatePaymentReview(r.s,{...review,partsCount:2}));
  assert.throws(()=>guardPaymentTariff(r.s.money,old),/schedule changed/);const stale={...old,pid:hash('unsubmitted')};assert.equal(outgoingStatus(r.s,stale),'REVIEW_REQUIRED');
  const lower={...INITIAL_TARIFF,baseMicro:'4000'},next=certificate(x,r.s,{profile:lower,activation:activation+7*86400,economics:reviewPaymentTariff({...market(),now:r.s.money.time,trades:market().trades.map(t=>({...t,settledAt:r.s.money.time-(market().now-t.settledAt)}))}).summary});r.reject(x.wire(certificate(x,r.s,{profile:{...lower,baseMicro:'3999'},activation:activation+7*86400})),/20 percent/);r.step([x.wire(next)]);r.reopen();assert.deepEqual(activePaymentTariff(r.s.money),INITIAL_TARIFF);r.step([],next.certificate.body.activation);r.reopen();assert.deepEqual(activePaymentTariff(r.s.money),lower);
  r.reject(x.wire(certificate(x,r.s,{activation:r.s.money.time+7*86400})),/reductions/);assert.equal(r.s.money.supply,supply);
 }finally{r.db.close();}
});
const market=()=>{const now=2000000000;return {now,current:INITIAL_TARIFF,monthlyCostUsdMicro:'60000000',organicFeeRevenueUsdMicro:'100000000',trades:Array.from({length:120},(_,i)=>({id:'trade-'+i,settledAt:now-(i%12)*86400,kind:'EXTERNAL_SETTLEMENT',buyerGroup:'buyer-'+i%24,sellerGroup:'seller',dubytMicro:'10000000',usdMicro:'20000000'}))};};
test('price review requires diverse recent organic evidence, excludes warmup, and respects cost and weekly bounds',()=>{
 const q=market(),r=reviewPaymentTariff(q);assert.equal(r.priceUsdMicro,'2000000');assert.equal(r.proposed.baseMicro,'4000');assert.equal(r.proposed.rateNum,'3');assert.equal(r.proposed.rateDen,'5000');assert(!r.authorization);
 for(const change of [{trades:[]},{trades:q.trades.slice(0,20)},{organicFeeRevenueUsdMicro:'1000000'},{monthlyCostUsdMicro:'0'},{trades:q.trades.map(t=>({...t,warmup:true}))},{trades:q.trades.map(t=>({...t,buyerGroup:t.sellerGroup}))},{trades:q.trades.map(t=>({...t,buyerGroup:'single'}))},{trades:q.trades.map(t=>({...t,settledAt:t.settledAt-30*86400}))}])assert.equal(reviewPaymentTariff({...q,...change}).proposed,null);
 assert.throws(()=>reviewPaymentTariff({...q,trades:[...q.trades,q.trades[0]]}),/duplicate/);
 const low=reviewPaymentTariff({...q,trades:q.trades.map(t=>({...t,usdMicro:'10000000'}))});assert.equal(low.proposed,null);
});
