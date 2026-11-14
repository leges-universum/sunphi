import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {issuanceFixture,certify} from './century-issuance.test.mjs';
import {subsidyCertificate} from './century-subsidy.test.mjs';
import {rig} from './bounded-century.test.mjs';
import {ISSUE_CENTURY,START_CENTURY} from '../century-issuance.mjs';
import {centuryWarmupPlan} from '../century-warmup.mjs';
import {UTC_OBLIGATIONS} from '../obligation-clock.mjs';
import {CENTURY_SUBSIDY_ACTION,centuryOwnerSnapshot} from '../century-subsidy.mjs';
import {nextRewardProposal,nextCenturyRewardProposal} from '../reward-scheduler.mjs';
import {RewardCoordinator,RewardProposalSigner} from '../reward-coordinator.mjs';
import {readRewardConsent} from '../reward-services.mjs';
import {queryBounded,verifyBoundedQuery} from '../research/bounded-query.mjs';
import {loadBoundedRewardPlan,loadBoundedServiceView} from '../research/bounded-wallet-view.mjs';
import {hash,keys,sign} from '../crypto.mjs';
const home=()=>mkdtempSync(join(tmpdir(),'century-planning-'));
function fixture(){
 const x=issuanceFixture({utc:true,expanded:true,terminal:true,validatorPowers:[40,30,20,10]}),r=rig(x);
 r.step([x.wire(certify(x,r.s,ISSUE_CENTURY,{supplyBefore:r.s.money.supply}))]);
 const initial=subsidyCertificate(x,r.s,{start:r.s.centuryFunds.execution.start});
 initial.certificate.body.policy={...initial.certificate.body.policy,workers:Object.keys(r.s.money.nodes).sort()};
 initial.certificate.approvals=x.approvals(initial.certificate.body);initial.founderConsent=sign(initial.certificate.body,x.founder.privateKey);
 r.step([x.wire(initial)]);r.step([],r.s.centurySubsidy.pending.to);
 return {x,r};
}
function transport(x,r){
 // Real indexed proofs and interpreter; checkpoint transport is a component
 // fixture, not a claim of native CometBFT or WAN verification.
 const checkpoint=async()=>({body:{issuedAt:r.s.money.time,appHash:r.db.root,appHeight:r.s.height,height:r.s.height+1}});
 const query=async(req,root)=>queryBounded(r.db,req,root);
 const options=cp=>({root:cp.body.appHash,height:cp.body.appHeight,configHash:hash(x.c),allowIsolated:true});
 const client={config:x.c,bounded:{fixture:true},checkpointSnapshot:()=>assert.fail('full snapshot forbidden'),
  sync:async cp=>({...await loadBoundedServiceView(query,options(cp)),certificate:cp.body}),
  rewardPlanningEvidence:async(cp,url,offset)=>({...await loadBoundedRewardPlan(query,{...options(cp),offset}),checkpoint:cp})};
 return {client,query,checkpoint,now:()=>r.s.money.time,url:'isolated'};
}

test('century planner: explicit roster avoids census and cannot start issuance or select new tariffs',()=>{
 const {x,r}=fixture();try{
  const s=structuredClone(r.s),before=hash(s),old=centuryOwnerSnapshot(s,{}),p=s.centurySubsidy.policy;
  s.money.nodes=new Proxy(s.money.nodes,{ownKeys:()=>assert.fail('worker census')});
  assert.deepEqual(centuryOwnerSnapshot(s,{...p,workers:[...p.workers].reverse()}),old);
  s.money.requests=new Proxy(s.money.requests,{ownKeys:()=>assert.fail('payment history')});
  const proposal=nextRewardProposal(s);assert.equal(proposal.type,CENTURY_SUBSIDY_ACTION);assert.equal(proposal.fields.sequence,2);assert.equal(proposal.fields.ownersHash,hash(old));
  assert.deepEqual(proposal.fields.policy,p);assert.equal(proposal.fields.from,s.money.time+120);
  for(const change of [s=>delete s.centurySubsidy,s=>s.centurySubsidy.pending={},s=>s.centuryFunds.zeroStage={},s=>delete s.centuryFunds.execution,s=>s.economicPreparation.planHash=hash('other plan'),s=>delete s.centurySubsidy.policy.workers,s=>s.networkReserves.development.access.pending={}]){
   const altered=structuredClone(r.s);change(altered);assert.equal(nextRewardProposal(altered),null);
  }
  const boundary=structuredClone(r.s),book=boundary.centurySubsidy;
  book.policyControl={pending:{effectiveFrom:boundary.money.time+150,managementEpoch:boundary.networkReserves.development.access.epoch,policy:{...p,costPerPaymentMicro:'0'}}};
  assert.equal(nextRewardProposal(boundary),null,'must not cross a pending tariff boundary');
  boundary.money.time+=150;assert.equal(nextRewardProposal(boundary).fields.policy.costPerPaymentMicro,'0');
  book.policyControl.pending.managementEpoch++;assert.equal(nextRewardProposal(boundary),null,'stale custody');
  assert.equal(hash(r.s),before);assert.equal(r.s.rewards.minted,'0');
 }finally{r.db.close();}
});

test('century planner: authenticated UTC projection reads selected workers and no historical payments',async()=>{
 const {x,r}=fixture();try{
  const reads=[],proof=r.db.store.proof.bind(r.db.store);r.db.store.proof=(key,root)=>{reads.push(key);assert(!/^(requests|outputs|payment-events)\//.test(key)&&key!=='meta/paymentEvents','history read');return proof(key,root);};
  r.db.store.scanAuthenticated=()=>assert.fail('full scan');
  const req={type:'reward-planning',id:{offset:999999,limit:8}},response=queryBounded(r.db,req,r.db.root),data=verifyBoundedQuery(response,req,r.db.root,hash(x.c)).data;
  assert.equal(data.page,undefined);assert.equal(reads.filter(k=>k.startsWith('nodes/')).length,r.s.centurySubsidy.policy.workers.length);
  assert.deepEqual(nextRewardProposal(data.state),nextRewardProposal(r.s));
  for(const mutate of [v=>v.proofs.pop(),v=>v.result.data.state.centurySubsidy.policy.costPerPaymentMicro='999999',v=>v.result.data.state.money.nodes={}]){
   const bad=structuredClone(response);mutate(bad);assert.throws(()=>verifyBoundedQuery(bad,req,r.db.root,hash(x.c)));
  }
 }finally{r.db.close();}
});

test('century planner: consent, weighted independent signatures, durable retry and actual indexed acceptance',async()=>{
 const {x,r}=fixture(),t=transport(x,r),dir=home(),before=r.s.money.supply;
 const a=new RewardProposalSigner({...t,home:join(dir,'a'),validatorKeys:x.validators.slice(0,1)}),b=new RewardProposalSigner({...t,home:join(dir,'b'),validatorKeys:x.validators.slice(1)});
 let consent=false,offline=true,lost=true;const wires=[],options={...t,home:join(dir,'coordinator'),key:keys(),founderConsent:body=>consent?sign(body,x.founder.privateKey):null,
  signers:[p=>a.approve(p),p=>{if(offline)throw Error('signer offline');return b.approve(p);}],
  broadcast:async w=>{wires.push(w);if(lost)throw Error('lost acknowledgement');r.step([w]);}};
 let c=new RewardCoordinator(options);
 try{
  assert((await c.cycle()).prepared);assert((await c.cycle()).awaitingFounderConsent);assert.equal(wires.length,0);
  consent=true;await assert.rejects(()=>c.cycle(),/signer offline/);assert.equal(wires.length,0);
  const packet=JSON.parse(c.db.prepare('SELECT packet FROM proposals').get().packet),bad=structuredClone(packet);bad.founderConsent=sign(bad.body,keys().privateKey);
  await assert.rejects(()=>b.approve(bad),/founder subsidy consent/);
  offline=false;await assert.rejects(()=>c.cycle(),/lost acknowledgement/);
  c.close();c=new RewardCoordinator(options);lost=false;assert((await c.cycle()).submitted);assert.equal(hash(wires[0]),hash(wires[1]));
  assert.equal(r.s.centurySubsidy.sequence,2);assert((await c.cycle()).confirmed);
  r.reopen();r.step([],r.s.centurySubsidy.pending.to);assert.equal(r.s.money.supply,before);assert.equal(r.s.rewards.minted,'0');assert.equal(r.s.centurySubsidy.last.payments,0);
  // Continue the same authorized controller, then exercise a real accepted
  // programme receipt. No replay scan or legacy funded assignment is involved.
  assert((await c.cycle()).prepared);assert((await c.cycle()).submitted);assert((await c.cycle()).confirmed);
  r.step([],r.s.centurySubsidy.pending.from);
  r.step([x.wire(certify(x,r.s,START_CENTURY,{settings:{controllerPolicy:{maximumRiseMicroPerSecond:'1000',operationalRateMicroPerSecond:'10000',intervalSeconds:60},maxPaymentMicro:'1234567',timeBasis:UTC_OBLIGATIONS,ttlSeconds:100}}))]);
  const w=r.s.centuryWarmup,body={domain:'DUEBYTE_WARMUP_CAPACITY_V2',configHash:r.s.configHash,generation:r.s.authority.generation,start:w.controller.start,from:w.controller.cursor,to:w.controller.cursor+60,observedHeight:r.s.height+1,observedAt:w.controller.cursor,sequence:w.controller.sequence+1,healthy:true,capacityRateMicroPerSecond:'1000',controllerPolicyHash:hash(w.controllerPolicy)};
  r.step([x.wire({type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:{body,approvals:x.approvals(body)}})]);
  const intent=centuryWarmupPlan(r.s.centuryWarmup,r.s.money);assert(intent);
  r.step([x.wire({type:'RUN_CENTURY_WARMUP_V1',sequence:body.sequence,intentHash:hash(intent)})]);
  r.step([x.finish(r.s,intent)]);assert.equal(Object.keys(r.s.centurySubsidy.pending.receipts).length,1);
  r.step([],r.s.centurySubsidy.pending.to);assert.equal(r.s.centurySubsidy.last.payments,1);assert(BigInt(r.s.centurySubsidy.last.mintedMicro)>0n);
  const settledSupply=r.s.money.supply;r.reopen();r.step();assert.equal(r.s.money.supply,settledSupply,'restart must not repeat an earned credit');
 }finally{c.close();a.close();b.close();r.db.close();}
});

test('century planner: overdue unsigned interval is superseded and stale approval files cannot authorize it',async()=>{
 const {x,r}=fixture(),t=transport(x,r),dir=home(),file=join(dir,'consent.json'),c=new RewardCoordinator({...t,home:dir,key:keys(),plannerOptions:{settings:{noticeSeconds:10}},signers:[()=>assert.fail('unsigned signing')],broadcast:()=>assert.fail('unsigned broadcast')});
 try{
  assert((await c.cycle()).prepared);const packet=JSON.parse(c.db.prepare('SELECT packet FROM proposals').get().packet);
  assert.equal(readRewardConsent(file,packet.body),null);writeFileSync(file,JSON.stringify({body:packet.body,signature:sign(packet.body,x.founder.privateKey)}));
  assert.equal(typeof readRewardConsent(file,packet.body),'string');assert.equal(readRewardConsent(file,{...packet.body,sequence:99}),null);
  r.step([],r.s.money.time+11);assert((await c.cycle()).superseded);assert.equal(r.s.centurySubsidy.sequence,1);
  assert(nextCenturyRewardProposal(r.s).fields.from>packet.body.from);
 }finally{c.close();r.db.close();}
});
