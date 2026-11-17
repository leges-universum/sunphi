import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './century-warmup.test.mjs';
import {keys,hash,sign} from '../crypto.mjs';import {stateHash,applyTx} from '../core.mjs';
import {applyCenturyFees,CENTURY_FEES_ACTION} from '../century-fees.mjs';
import {applyCenturySubsidy,CENTURY_SUBSIDY_ACTION,CENTURY_SERVICE,recordCenturySubsidy} from '../century-subsidy.mjs';
import {applyCenturyWarmupAction,centuryWarmupPlan} from '../century-warmup.mjs';
import {effectiveWorkGroup} from '../payment-liability.mjs';
import {REWARDS,walletConsent,rewardSummary} from '../node-rewards.mjs';
import {datedAllowance} from '../economic-policy-v2.mjs';
import {Store} from '../store.mjs';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
export function subsidyFixture(funded='10000000',options={}){
 const x=fixture(funded,options);const b={domain:CENTURY_FEES_ACTION,network:x.c.chainId,configHash:x.s.configHash,generation:x.s.authority.generation,notBefore:x.s.height,expires:x.s.height+2,activation:x.s.height+4,periodBlocks:10,planHash:x.s.economicPreparation.planHash};
 let s=applyCenturyFees({...x.s,centuryWarmup:x.book},{type:CENTURY_FEES_ACTION,certificate:{body:b,approvals:x.approvals(b)},founderConsent:sign(b,x.founder.privateKey)},x.c);while(!s.rewards)s=x.run(s);
 return {...x,s};
}
const tariff={service:CENTURY_SERVICE,intervalSeconds:60,costPerPaymentMicro:'100000',intervalCapMicro:'1000000',nodeCapMicro:'500000',groupCapMicro:'1000000',maxPayments:32};
function cert(x,s,over={}){
 const b={domain:CENTURY_SUBSIDY_ACTION,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+100,planHash:s.economicPreparation.planHash,
  sequence:(s.centurySubsidy?.sequence??0)+1,start:s.centurySubsidy?.start??s.money.time,from:s.money.time,to:s.money.time+60,policy:s.centurySubsidy?.policy??tariff,
  ownersHash:hash(Object.fromEntries(Object.keys(s.money.nodes).sort().map(id=>[id,effectiveWorkGroup(s.money,id)]))),...over};
 return {type:CENTURY_SUBSIDY_ACTION,certificate:{body:b,approvals:x.approvals(b)},founderConsent:sign(b,x.founder.privateKey)};
}
function open(x,s=x.s,over={}){return applyCenturySubsidy(s,cert(x,s,over),x.c);}
function reserve(x,s){s=applyCenturyWarmupAction(s,{type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:x.certificate(s,s.centuryWarmup)});const i=centuryWarmupPlan(s.centuryWarmup,s.money);s=applyCenturyWarmupAction(s,{type:'RUN_CENTURY_WARMUP_V1',sequence:s.centuryWarmup.controller.sequence,intentHash:hash(i)});return {s,i};}
function settle(x,s){const r=reserve(x,s),finish=x.finish(r.s,r.i);return {s:x.run(r.s,[finish]),i:r.i,finish};}
function close(x,s){return x.run(s,[],s.centurySubsidy.pending.to);}
export {cert as subsidyCertificate,open as openSubsidy,reserve as reserveProgramme,settle as settleProgramme,close as closeSubsidy};
const owned=(s,k)=>Object.values(s.money.outputs).filter(o=>o.owner===k.publicKey).reduce((a,o)=>a+BigInt(o.value),0n);
function bind(x,s,id,wallets){const manager=x.key(id),b={domain:REWARDS+'/BIND',configHash:s.configHash,node:id,sequence:s.rewards.nodes[id].sequence+1,payouts:wallets.map(k=>({wallet:k.publicKey,weight:1}))};return x.run(s,[x.wire({type:'BIND_REWARD_WALLETS_V1',body:b,signature:sign(b,manager.privateKey),consents:wallets.map(k=>sign(walletConsent(s.configHash,id,k.publicKey),k.privateKey))},manager)]);}
test('subsidy authority is prospective, exact-plan, quorum and founder bound; public action remains closed',()=>{
 const x=subsidyFixture(),a=cert(x,x.s);assert.throws(()=>applyTx(x.s,Buffer.from(JSON.stringify(x.wire(a))),x.c,x.s.money.time),/public action/);
 for(const mutate of [a=>a.certificate.approvals.pop(),a=>a.founderConsent=sign(a.certificate.body,keys().privateKey),a=>a.certificate.body.planHash=hash('bad'),a=>a.certificate.body.ownersHash=hash('bad')]){const bad=structuredClone(a);mutate(bad);assert.throws(()=>applyCenturySubsidy(x.s,bad,x.c));}
 for(const over of [{from:x.s.money.time-1},{start:x.s.money.time-1},{to:x.s.money.time+86401},{sequence:2}])assert.throws(()=>open(x,x.s,over));
 const s=open(x);assert.equal(applyCenturySubsidy(s,a,x.c),s);assert.throws(()=>open(x,s),/still open/);stateHash(s,x.c);
 stateHash(open(x,x.s,{start:x.s.money.time+5,from:x.s.money.time+5,to:x.s.money.time+65}),x.c);
});
test('accepted work -> fee gap -> bounded mint -> existing earnings -> split wallets, exactly once',()=>{
 const x=subsidyFixture(),wallets=[keys(),keys()];let {s,i,finish}=settle(x,open(x));const node=i.parts[0].nodes[0];
 assert.equal(s.rewards.minted,'0');s=bind(x,s,node,wallets);s=close(x,s);
 // (100000 - 37038) / 3 = 20987 each; one micro stays UNISSUED.
 assert.equal(s.centurySubsidy.totalMintedMicro,'62961');assert.equal(s.centurySubsidy.earned[node],'20987');
 assert.equal(BigInt(s.money.supply)-BigInt(x.s.money.supply),62961n);assert.equal(s.economicPreparation.planHash,x.s.economicPreparation.planHash);
 while(s.rewards.nodes[node].earned!=='33333')s=x.run(s);
 s=x.run(s);assert.equal(owned(s,wallets[0]),16666n);assert.equal(owned(s,wallets[1]),16666n);assert.equal(rewardSummary(s,node).display.pending,'0.000001');
 const before=hash(s);assert.throws(()=>x.run(s,[finish]),/unexpected liability attestation/);assert.equal(hash(s),before);
 assert.equal(s.centurySubsidy.last.externalDemandProven,false);assert.equal(s.centurySubsidy.last.renewalPaidMicro,'0');assert.equal(s.economicPreparation.memorial.balanceMicro,'0');assert(!s.networkReserves.issued);stateHash(s,x.c);
});
test('SQLite rollback and restart cannot issue or pay twice, including a retained fresh-envelope settlement replay',()=>{
 const x=subsidyFixture();let {s,finish}=settle(x,open(x));const path=join(mkdtempSync(join(tmpdir(),'century-subsidy-')),'state.sqlite');let db=new Store(path,x.c);db.restore(s);
 db.finalize({height:s.height+1,blockHash:hash('close'),time:s.centurySubsidy.pending.to,txs:[]});assert.equal(db.state.money.supply,s.money.supply);db.close();
 db=new Store(path,x.c);assert.equal(db.state.centurySubsidy.totalMintedMicro,'0');s=db.state;db.close();
 // Before liability evidence is pruned, a second valid envelope is a no-op.
 s=x.run(s,[finish]);assert.equal(Object.keys(s.centurySubsidy.pending.receipts).length,1);s=close(x,s);
 db=new Store(path+'.closed',x.c);db.restore(s);db.close();db=new Store(path+'.closed',x.c);assert.equal(stateHash(db.state,x.c),stateHash(s,x.c));s=x.run(db.state);db.close();assert.equal(s.centurySubsidy.totalMintedMicro,'62961');
});
test('empty and expired work earns zero; fees cover tariff; dust remains unissued; hard interval cap',()=>{
 for(const cost of ['0','37038','37039','100000']){const x=subsidyFixture();let s=open(x,x.s,{policy:{...tariff,costPerPaymentMicro:cost,intervalCapMicro:'3',nodeCapMicro:'1',groupCapMicro:'3'}});s=settle(x,s).s;s=close(x,s);assert.equal(s.rewards.minted,cost==='100000'?'3':'0');}
 const x=subsidyFixture();let s=close(x,open(x));assert.equal(s.rewards.minted,'0');assert.throws(()=>open(x,s,{from:x.s.money.time,to:x.s.money.time+60}),/prospective|catchup/);
 const y=subsidyFixture(),r=reserve(y,open(y));s=y.drain(r.s,r.i.pid);s=close(y,s);assert.equal(s.rewards.minted,'0');
});
test('wrong or incomplete receipts never earn; bounded count cannot be enlarged after work',()=>{
 const x=subsidyFixture(),r=reserve(x,open(x)),bad=x.finish(r.s,r.i);bad.body.action.receipts[0].signature='invalid';const action=x.wire(bad.body.action);
 assert.throws(()=>x.run(r.s,[action]));assert.equal(Object.keys(r.s.centurySubsidy.pending.receipts).length,0);
 const partial=x.finish(r.s,r.i);partial.body.action.receipts.pop();assert.throws(()=>x.run(r.s,[x.wire(partial.body.action)]));
 let s=close(x,settle(x,open(x)).s);assert.throws(()=>open(x,s,{policy:{...tariff,costPerPaymentMicro:'1000000'}}),/immutable/);
});
test('owner group caps aggregate multiple servers; small node cap is not redistributed to others',()=>{
 const x=subsidyFixture('10000000',{founderNodes:[0,1,2,3,4,5]});
 let s=open(x,x.s,{policy:{...tariff,nodeCapMicro:'1000',groupCapMicro:'1500'}});s=settle(x,s).s;s=close(x,s);assert.equal(s.rewards.minted,'1500');assert(Object.values(s.centurySubsidy.earned).every(v=>v==='500'));
});
test('no catchup, exact boundary, and frozen supply reconciliation reject state tampering',()=>{
 const x=subsidyFixture();let s=open(x);const r=reserve(x,s);s=x.run(r.s,[x.finish(r.s,r.i)],s.centurySubsidy.pending.to);assert.equal(s.rewards.minted,'0');assert.equal(s.centurySubsidy.last.payments,0);
 const gap=s.money.time+30;s=open(x,s,{from:gap,to:gap+60});assert.equal(s.centurySubsidy.start,x.s.money.time);s=x.run(s,[],gap);stateHash(s,x.c);
 for(const mutate of [q=>q.money.supply=String(BigInt(q.money.supply)+1n),q=>q.centurySubsidy.totalMintedMicro='1',q=>q.centurySubsidy.pending.work[x.f.ids[0]]='1']){const q=structuredClone(s);mutate(q);assert.throws(()=>stateHash(q,x.c));}
});
test('an ordinary transfer cannot claim the programme subsidy or multiply its period caps',()=>{
 const x=subsidyFixture(),s=open(x),r=settle(x,structuredClone(s));
 // A valid settled request alone is insufficient without the protected pending job.
 recordCenturySubsidy(s,r.s.money.requests[r.i.pid]);assert.equal(Object.keys(s.centurySubsidy.pending.receipts).length,0);
 assert.throws(()=>open(x,x.s,{to:x.s.money.time+1}),/fixed tariff interval/);
});
test('accepted-work count is bounded; later work does not expand the signed subsidy budget',()=>{
 const x=subsidyFixture();let s=open(x,x.s,{to:x.s.money.time+120,policy:{...tariff,intervalSeconds:120,maxPayments:1}});s=settle(x,s).s;
 s=x.run(s,[],s.centuryWarmup.controller.cursor);const second=settle(x,s);s=second.s;
 assert.equal(Object.keys(s.centurySubsidy.pending.receipts).length,1);assert.equal(BigInt(s.rewards.collected),37038n+BigInt(second.i.fee));s=close(x,s);assert.equal(s.rewards.minted,'62961');
});
test('unbound subsidy survives intervals and pays after recipient consent; old receipt cannot earn again',()=>{
 const x=subsidyFixture();let {s,i,finish}=settle(x,open(x));s=close(x,s);const id=i.parts[0].nodes[0],wallet=keys();
 while(s.height<s.rewards.period.end-1)s=x.run(s);s=x.run(s);assert.equal(s.rewards.nodes[id].earned,'33333');assert.equal(s.rewards.nodes[id].paid,'0');
 s=open(x,s);assert.throws(()=>x.run(s,[finish]),/unexpected liability attestation/);s=close(x,s);assert.equal(s.rewards.minted,'62961');assert.equal(s.centurySubsidy.last.mintedMicro,'0');
 s=bind(x,s,id,[wallet]);s=x.run(s);assert.equal(owned(s,wallet),33333n);assert.equal(s.rewards.nodes[id].paid,'33333');
});
test('calendar ceiling wins over excessive declared cost and retains every fixed reserve and memorial allocation',()=>{
 const x=subsidyFixture(),large='1000000000000000';let s=open(x,x.s,{policy:{...tariff,costPerPaymentMicro:large,intervalCapMicro:large,nodeCapMicro:large,groupCapMicro:large}});s=settle(x,s).s;s=close(x,s);
 const cap=BigInt(datedAllowance({start:x.s.money.time,from:x.s.money.time,to:x.s.money.time+60,existingSupplyMicro:s.economicPreparation.plan.existingSupplyMicro,kind:'regular'}));
 assert.equal(BigInt(s.rewards.minted),cap/3n*3n);assert.equal(s.centurySubsidy.last.maximumMicro,String(cap));
 assert.equal(s.economicPreparation.memorial.balanceMicro,'0');assert(!s.networkReserves.issued);stateHash(s,x.c);
});
