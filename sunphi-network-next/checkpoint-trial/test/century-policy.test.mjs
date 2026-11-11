import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {hash,keys,sign} from '../crypto.mjs';import {applyTx,stateHash} from '../core.mjs';import {Store} from '../store.mjs';
import {homeFixture} from './century-home-funds.test.mjs';
import {settleProgramme,closeSubsidy,subsidyCertificate} from './century-subsidy.test.mjs';
import {CENTURY_POLICY_ACTIONS,CENTURY_POLICY_NOTICE,applyCenturyPolicy,applyCenturySubsidy} from '../century-subsidy.mjs';
import {completeCenturyHome,centuryHomeBody,CENTURY_HOME_ACTION} from '../century-home.mjs';import {effectiveWorkGroup} from '../payment-liability.mjs';
import {REWARDS,walletConsent} from '../node-rewards.mjs';
const [SCHEDULE,CANCEL]=CENTURY_POLICY_ACTIONS;
export function policyCertificate(x,s,type,extra={}){
 const b={domain:type,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+100,planHash:s.centurySubsidy.planHash,managementEpoch:s.networkReserves.development.access.epoch,sequence:(s.centurySubsidy.policyControl?.sequence??0)+1,previousPolicyHash:hash(s.centurySubsidy.policy),...extra};
 return {type,certificate:{body:b,approvals:x.approvals(b)},founderConsent:sign(b,x.founder.privateKey)};
}
function schedule(x,s,p,extra={}){return policyCertificate(x,s,SCHEDULE,{effectiveFrom:s.money.time+CENTURY_POLICY_NOTICE,policy:p,reason:'Measured service policy revision',...extra});}
function apply(x,s,a){const before=hash(s),n=applyCenturyPolicy(s,a,x.c);assert.equal(hash(s),before);stateHash(n,x.c);return n;}
function answer(s,h){const body=centuryHomeBody(s,h.node);return completeCenturyHome(s,{type:CENTURY_HOME_ACTION,body,signature:sign(body,h.work.privateKey)},h.work.publicKey);}
function next(x,s,p=s.centurySubsidy.policy){const workers=p.workers??Object.keys(s.money.nodes),owners=Object.fromEntries(workers.slice().sort().map(id=>[id,effectiveWorkGroup(s.money,id)]));return applyCenturySubsidy(s,subsidyCertificate(x,s,{policy:p,to:s.money.time+p.intervalSeconds,ownersHash:hash(owners)}),x.c);}
function reduced(s){const p=structuredClone(s.centurySubsidy.policy);p.costPerPaymentMicro='0';p.intervalCapMicro='0';p.nodeCapMicro='0';p.groupCapMicro='0';p.home.costPerSampleMicro='0';p.home.nodes={};return p;}
test('policy schedule is founder/quorum/epoch/plan bound and remains publicly closed',()=>{
 const x=homeFixture(),p=reduced(x.s),a=schedule(x,x.s,p);assert.throws(()=>applyTx(x.s,Buffer.from(JSON.stringify(x.wire(a))),x.c,x.s.money.time),/public action/);
 for(const mutate of [a=>a.certificate.approvals.pop(),a=>a.founderConsent=sign(a.certificate.body,keys().privateKey),a=>a.certificate.body.planHash=hash('wrong'),a=>a.certificate.body.managementEpoch++,a=>a.certificate.body.sequence++]){const bad=structuredClone(a);mutate(bad);assert.throws(()=>apply(x,x.s,bad));}
 const s=apply(x,x.s,a);assert.deepEqual(s.money,x.s.money);assert.deepEqual(s.rewards,x.s.rewards);assert.deepEqual(s.centurySubsidy.policy,x.s.centurySubsidy.policy);assert.equal(apply(x,s,a),s);
 assert.throws(()=>apply(x,s,schedule(x,s,p)),/cancel existing/);
});
test('notice and daily growth bounds prevent jumps, interval resets and micro rounding abuse',()=>{
 const x=homeFixture(),p=structuredClone(x.s.centurySubsidy.policy);p.costPerPaymentMicro='110000';apply(x,x.s,schedule(x,x.s,p));
 for(const extra of [{effectiveFrom:x.s.money.time+86399},{effectiveFrom:x.s.money.time+31*86400}])assert.throws(()=>apply(x,x.s,schedule(x,x.s,p,extra)),/notice/);
 for(const mutate of [p=>p.costPerPaymentMicro='110001',p=>p.intervalCapMicro='1100001',p=>p.intervalSeconds=600,p=>p.home.costPerSampleMicro='11001',p=>p.home.feeSharePPM+=10001,p=>p.maxPayments=36,p=>delete p.home]){const n=structuredClone(p);mutate(n);assert.throws(()=>apply(x,x.s,schedule(x,x.s,n)));}
 const z=reduced(x.s);let s=apply(x,x.s,schedule(x,x.s,z));s=x.run(s,[],s.centurySubsidy.policyControl.pending.effectiveFrom);s=next(x,s,z);const one=structuredClone(z);one.costPerPaymentMicro='1';apply(x,s,schedule(x,s,one));one.costPerPaymentMicro='2';assert.throws(()=>apply(x,s,schedule(x,s,one)),/ten percent/);
});
test('accepted work closes at old terms; lower future caps and removed Home keys preserve all earnings and history',()=>{
 const x=homeFixture();let s=settleProgramme(x,x.s).s;for(const h of x.homes)s=answer(s,h);
 const oldPolicy=structuredClone(s.centurySubsidy.policy),p=reduced(s);s=apply(x,s,schedule(x,s,p));const end=s.centurySubsidy.policyControl.pending.effectiveFrom;
 s=closeSubsidy(x,s);assert(x.homes.every(h=>s.rewards.nodes[h.node].earned==='10000'));const earned=structuredClone(s.rewards.nodes),minted=s.rewards.minted,statement=structuredClone(s.centurySubsidy.last),history=s.centurySubsidy.history;
 s=x.run(s,[],end-1);assert.throws(()=>next(x,s,p));assert.throws(()=>next(x,s,oldPolicy),/crosses/);s=x.run(s,[],end);
 const before=hash(s),n=next(x,s,p);assert.equal(hash(s),before);s=n;assert.equal(s.centurySubsidy.policyControl.revision,2);assert.deepEqual(s.centurySubsidy.last,statement);assert.equal(s.centurySubsidy.history,history);assert.deepEqual(s.rewards.nodes,earned);assert.equal(s.rewards.minted,minted);stateHash(s,x.c);
 s=x.run(s);assert.deepEqual(s.centurySubsidy.pending.home.jobs,{});s=closeSubsidy(x,s);assert.equal(s.rewards.minted,minted);assert(x.homes.every(h=>s.rewards.nodes[h.node].earned==='10000'));
 // Removal affects future assignments, never the right to withdraw earned fees/mint.
 const h=x.homes[0],w=keys(),body={domain:REWARDS+'/BIND',configHash:s.configHash,node:h.node,sequence:1,payouts:[{wallet:w.publicKey,weight:1}]};
 const binding=x.wire({type:'BIND_REWARD_WALLETS_V1',body,signature:sign(body,h.management.privateKey),consents:[sign(walletConsent(s.configHash,h.node,w.publicKey),w.privateKey)]},h.management);
 s=x.run(s,[binding]);while(s.rewards.nodes[h.node].paid!=='10000')s=x.run(s);
 const owned=q=>Object.values(q.money.outputs).filter(o=>o.owner===w.publicKey).reduce((n,o)=>n+BigInt(o.value),0n);assert.equal(owned(s),10000n);s=x.run(s,[binding]);assert.equal(owned(s),10000n);assert.equal(s.rewards.minted,minted);stateHash(s,x.c);
});
test('cancel and supersede use monotonic sequences; stale replays cannot restore a removed proposal',()=>{
 const x=homeFixture(),a=schedule(x,x.s,reduced(x.s));let s=apply(x,x.s,a);const cancel=policyCertificate(x,s,CANCEL,{proposalHash:s.centurySubsidy.policyControl.pending.proposalHash});
 assert.throws(()=>apply(x,s,policyCertificate(x,s,CANCEL,{proposalHash:hash('wrong')})),/proposal/);s=apply(x,s,cancel);assert.equal(apply(x,s,cancel),s);assert.throws(()=>apply(x,s,a),/sequence/);assert(!s.centurySubsidy.policyControl.pending);
 s=apply(x,s,schedule(x,s,reduced(s)));assert.equal(s.centurySubsidy.policyControl.sequence,3);assert.throws(()=>apply(x,s,cancel),/sequence/);
});
test('pending policy survives SQLite restart; recovery epoch requires cancel/re-certification',()=>{
 const x=homeFixture();let s=apply(x,x.s,schedule(x,x.s,reduced(x.s)));const folder=mkdtempSync(join(tmpdir(),'duebyte-policy-')),file=join(folder,'state.sqlite');let db=new Store(file,x.c);db.restore(s);db.close();db=new Store(file,x.c);assert.equal(stateHash(db.state,x.c),stateHash(s,x.c));s=db.state;db.close();
 const p=s.centurySubsidy.policyControl.pending.policy;s=x.run(s,[],s.centurySubsidy.policyControl.pending.effectiveFrom);s.networkReserves.development.access.epoch++;assert.throws(()=>next(x,s,p),/custody changed/);stateHash(s,x.c);
 s=apply(x,s,policyCertificate(x,s,CANCEL,{proposalHash:s.centurySubsidy.policyControl.pending.proposalHash}));s=apply(x,s,schedule(x,s,p));assert.equal(s.centurySubsidy.policyControl.pending.managementEpoch,s.networkReserves.development.access.epoch);
});
test('paid rosters require registered keys; additions do not expand the pool; workers are explicit',()=>{
 const x=homeFixture(),p=structuredClone(x.s.centurySubsidy.policy);p.home.nodes={};p.workers=x.f.ids.slice(0,3);
 for(const mutate of [p=>p.workers=[hash('unknown')],p=>p.home.nodes={[hash('unknown')]:null},p=>p.workers=[x.f.ids[0],x.f.ids[0]]]){const bad=structuredClone(p);mutate(bad);assert.throws(()=>apply(x,x.s,schedule(x,x.s,bad)));}
 let s=apply(x,x.s,schedule(x,x.s,p));s=x.run(s,[],s.centurySubsidy.policyControl.pending.effectiveFrom);s=next(x,s,p);assert.deepEqual(Object.keys(s.centurySubsidy.pending.owners).sort(),p.workers.slice().sort());
 const readd=structuredClone(p);readd.home.nodes=structuredClone(x.s.centurySubsidy.policy.home.nodes);s=apply(x,s,schedule(x,s,readd));s=x.run(s,[],s.centurySubsidy.policyControl.pending.effectiveFrom);s=next(x,s,readd);s=x.run(s);assert.equal(Object.keys(s.centurySubsidy.pending.home.jobs).length,2);assert.equal(s.centurySubsidy.policy.intervalCapMicro,p.intervalCapMicro);stateHash(s,x.c);
});
test('late activation and cancellation cannot bank multiple daily increases',()=>{
 const x=homeFixture(),p=structuredClone(x.s.centurySubsidy.policy);p.costPerPaymentMicro='110000';let s=apply(x,x.s,schedule(x,x.s,p));s=x.run(s,[],s.money.time+10*86400);s=next(x,s,p);
 const more=structuredClone(p);more.costPerPaymentMicro='121000';assert.throws(()=>apply(x,s,schedule(x,s,more,{effectiveFrom:s.money.time+1})),/notice/);apply(x,s,schedule(x,s,more));more.costPerPaymentMicro='121001';assert.throws(()=>apply(x,s,schedule(x,s,more)),/ten percent/);
});
