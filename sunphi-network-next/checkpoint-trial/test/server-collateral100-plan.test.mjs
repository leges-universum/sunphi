import test from 'node:test';import assert from 'node:assert/strict';
import {keys,hash} from '../crypto.mjs';
import {serverCollateral100Plan} from '../research/server-collateral100-plan.mjs';
function observation(){const seller=keys().publicKey,operator=hash('one founder'),workers=Array.from({length:10},(_,i)=>({node:hash(i),key:keys().publicKey,operator,recipient:seller,stake:'0',consensusHeld:'0',taskHeld:'0'}));return {passed:true,issuance:false,publicPurchasesEnabled:false,receivedAt:new Date(1000000).toISOString(),root:hash('root'),height:20,rootMatchedByValidators:10,seller,zeroStage:{workers,configHash:hash('config'),supplyMicro:'0',unitScale:'1000000',liability:null},bindings:workers.map(w=>({node:w.node,payouts:[{wallet:seller,weight:1}]}))};}
test('ten servers receive10 support and90 founder collateral inside10000 budget',()=>{
 const p=serverCollateral100Plan(observation(),1000000);assert.equal(p.body.totalCollateralMicro,'1000000000');assert.equal(p.body.onboardingPremiumMicro,'100000000');assert.equal(p.body.additionalInitialCollateralMicro,'900000000');assert.equal(p.body.unallocatedBudgetMicro,'9000000000');assert(p.body.roster.every(w=>w.totalCollateralMicro==='100000000'&&w.lockedSupportMicro==='10000000'&&w.additionalInitialCollateralMicro==='90000000'));assert.equal(p.body.fundingProposal.founderAdvanceMicro,'900000000');assert.equal(p.body.fundingProposal.firstAnnualRemainderMicro,'999100000000');assert.equal(p.issuanceAuthorized,false);assert.equal(p.readyForIssuance,false);assert.equal(p.body.capacity.requiredWithReserveMicro,'76000000');
});
test('stale evidence, duplicate workers, foreign recipients and funded balances cannot be reused',()=>{
 const o=observation();assert.throws(()=>serverCollateral100Plan(o,1180001));
 for(const mutate of [x=>x.zeroStage.workers.push(x.zeroStage.workers[0]),x=>x.zeroStage.workers[0].stake='1',x=>x.zeroStage.workers[0].recipient=keys().publicKey,x=>x.zeroStage.workers[1].key=x.zeroStage.workers[0].key,x=>x.zeroStage.liability={},x=>x.issuance=true]){const c=structuredClone(o);mutate(c);assert.throws(()=>serverCollateral100Plan(c,1000000));}
});
