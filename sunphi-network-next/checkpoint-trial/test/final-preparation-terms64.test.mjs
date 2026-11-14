import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers/liability-fixture.mjs';
import {hash,sign} from '../crypto.mjs';
import {applyLiabilityAction,liabilityConsent} from '../payment-liability.mjs';
import {preparationBody,assertPreparationAction} from '../qa/final-preparation-terms64.mjs';
function fixture(){
 const f=setup({utc:true,expanded:true,terminal:true,prepare:false,validatorPowers:[10,10,10,10]});
 const s=structuredClone(f.s);s.money.supply='0';s.money.fees='0';s.money.unitScale='1000000';
 const owner=f.f.alice.publicKey,rows=f.f.ids.map(node=>({node,workerKey:s.money.nodes[node].key}));
 s.rewards={nodes:{}};for(const r of rows){Object.assign(s.money.nodes[r.node],{stake:'0',tier:'0',taskHeld:'0',consensusHeld:'0'});s.rewards.nodes[r.node]={key:r.workerKey,payouts:[{wallet:owner,weight:1}]};}
 return {...f,s,options:{owner,rows,ownerGroup:hash('one-founder-group')}};
}
test('terminal collateral policy is accepted with current weighted approvals and exact worker consent',()=>{
 const f=fixture(),b=preparationBody('liability',f.s,f.c,f.options);
 assert.equal(b.policy.challengeSeconds,0);assert.equal(b.policy.penaltyBps,1000);
 const s=structuredClone(f.s);s.height=b.notBefore;s.money.height=s.height;
 const a={type:'PREPARE_PAYMENT_LIABILITY_V1',certificate:{body:b,approvals:f.approvals(b)},founderConsent:sign(b,f.founder.privateKey)};
 const next=applyLiabilityAction(s,a,f.c,f.founder.publicKey);
 const node=f.options.rows[0].node,k=f.key(node),consent={type:'ACCEPT_PAYMENT_LIABILITY_V1',node,signature:sign(liabilityConsent(next.money,node),k.privateKey)};
 const accepted=applyLiabilityAction(next,consent,f.c,k.publicKey);assert(accepted.money.liability.consents[node]);
 assert.throws(()=>applyLiabilityAction(next,{...consent,node:f.options.rows[1].node},f.c,k.publicKey));
 assert.throws(()=>applyLiabilityAction({...s,authority:{...s.authority,generation:1}},a,f.c,f.founder.publicKey));
});
test('preparation refuses issuance actions, changed recipients and changed balances',()=>{
 const f=fixture();for(const type of ['ISSUE_FOUNDER_ADVANCE_V1','ISSUE_CENTURY_WARMUP_TRANCHE_V1','RUN_CENTURY_WARMUP_V1'])assert.throws(()=>assertPreparationAction({type}));
 f.s.rewards.nodes[f.options.rows[0].node].payouts=[];assert.throws(()=>preparationBody('liability',f.s,f.c,f.options));
 const g=fixture();g.s.money.supply='1';assert.throws(()=>preparationBody('liability',g.s,g.c,g.options));
});
test('initial tariff on a previously funded chain keeps public notice and cannot overwrite a schedule',()=>{
 const f=fixture(),b=preparationBody('tariff',f.s,f.c,f.options);assert(b.activation>=f.s.money.time+86400);
 assert.equal(b.profile.baseMicro,'5000');assert.equal(b.profile.rateNum,'3');assert.equal(b.profile.rateDen,'5000');
 f.s.money.paymentTariff={};assert.throws(()=>preparationBody('tariff',f.s,f.c,f.options));
});

test('clean-chain preparation omits the one-day notice but retains an inclusion buffer',()=>{
 const f=fixture();f.c.initial={...f.c.initial,supply:'0',fees:'0',outputs:{},nodes:{}};f.s.configHash=hash(f.c);
 const b=preparationBody('tariff',f.s,f.c,f.options);assert.equal(b.activation,f.s.money.time+600);
 assert.equal(b.profile.baseMicro,'5000');assert.equal(b.profile.rateNum,'3');assert.equal(b.profile.rateDen,'5000');
});
