// Synthetic isolated V15 execution; never connects to working nodes or wallets.
import test from 'node:test';import assert from 'node:assert/strict';
import {hash,sign,keys} from '../crypto.mjs';
import {issuanceFixture,certify} from './century-issuance.test.mjs';
import {pilotFixture,admission} from './zero-stage-consensus.test.mjs';
import {rig} from './bounded-century.test.mjs';
import {ISSUE_WARMUP_TRANCHE,ISSUE_CENTURY,START_CENTURY,centuryVested} from '../century-issuance.mjs';
import {ISSUE_FOUNDER_ADVANCE,FOUNDER_ADVANCE_MICRO} from '../founder-advance-policy.mjs';
import {ZERO_STAGE_TERMINAL_DEFAULTS} from '../research/zero-stage-plan.mjs';
import {OPEN_SUPPORT,CLAIM_SUPPORT,QUEUE_SUPPORT,RETURN_SUPPORT,supportOwnerGroup} from '../worker-support.mjs';
import {FUND_WORKER,COLLATERAL_DOMAIN,QUEUE_RELEASE,EXECUTE_RELEASE,releasableCollateral} from '../worker-collateral.mjs';
import {anniversary} from '../economic-policy-v2.mjs';
import {feeFor,releaseFeeFor} from '../payment-model.mjs';
import {INITIAL_TARIFF} from '../payment-tariff.mjs';
import {WalletCollateral} from '../wallet-collateral.mjs';
import {WalletNodeLinks} from '../wallet-node-links.mjs';
import {signWorkerFunding} from '../worker-funding-consent.mjs';
import {loadBoundedWalletView} from '../research/bounded-wallet-view.mjs';
import {queryBounded} from '../research/bounded-query.mjs';
const owned=(s,key)=>Object.values(s.money.outputs).filter(o=>o.owner===key).reduce((n,o)=>n+BigInt(o.value),0n);
function reachTime(r,time){while(r.s.money.time<time)r.step([],Math.min(time,r.s.money.time+31*86400));}
function advance(x,s,extra={}){const a=certify(x,s,ISSUE_FOUNDER_ADVANCE,{supplyBefore:s.money.supply,trancheMicro:FOUNDER_ADVANCE_MICRO,recipient:x.recipient.publicKey,...extra});return {...a,recipientConsent:sign(a.certificate.body,x.recipient.privateKey)};}
function stakeAction(x,s,node,type=FUND_WORKER,value='90000000'){
 const b={domain:type===FUND_WORKER?COLLATERAL_DOMAIN:COLLATERAL_DOMAIN+'/'+type,configHash:s.configHash,node,owner:x.recipient.publicKey,sequence:(s.workerFunding?.accounts[node]?.sequence??0)+1,issuedAt:s.money.time,expires:s.money.time+300,valueMicro:value,...(type===FUND_WORKER?{unitScale:'1000000',inputs:Object.entries(s.money.outputs).filter(([,o])=>o.owner===x.recipient.publicKey).map(([id])=>id).sort()}:{})};
 return {type,body:b,ownerSignature:sign(b,x.recipient.privateKey),workerSignature:sign(b,x.key(node).privateKey)};
}
function supportConsent(x,s,node,type=CLAIM_SUPPORT){const body={domain:type,configHash:s.configHash,node,issuedAt:s.money.time,expires:s.money.time+300};return {type,body,managementSignature:sign(body,x.key(node).privateKey),workerSignature:sign(body,x.key(node).privateKey)};}
export function launch(isolatedIssuance=true){
 const p=pilotFixture(true,true,10),x=p.x,seed=structuredClone(p.r.s);p.r.db.close();
 const output=Object.values(seed.money.outputs).find(o=>o.owner===x.f.alice.publicKey);
 for(const n of Object.values(seed.money.nodes)){output.value=String(BigInt(output.value)+BigInt(n.stake));n.stake=n.consensusHeld=n.taskHeld=n.tier='0';}
 const r=rig(x,seed,isolatedIssuance,false);r.step([x.wire(admission(x,r,{settings:{...ZERO_STAGE_TERMINAL_DEFAULTS}}))]);
 r.step([x.wire(certify(x,r.s,ISSUE_WARMUP_TRANCHE,{supplyBefore:r.s.money.supply,trancheMicro:'9000000000'}))]);
 r.step([x.wire(advance(x,r.s))]);
 r.step([x.wire(certify(x,r.s,START_CENTURY,{settings:{controllerPolicy:{maximumRiseMicroPerSecond:'1000',operationalRateMicroPerSecond:'500000',intervalSeconds:20},maxPaymentMicro:'5000000',timeBasis:x.c.obligationClock,ttlSeconds:120}}))]);
 r.step([],r.s.money.time+3600);
 const s=r.s,body={domain:OPEN_SUPPORT,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+100,planHash:s.economicPreparation.planHash,managementEpoch:s.networkReserves.development.access.epoch,supplyBefore:s.money.supply,from:s.centuryFunds.execution.start,to:s.money.time,allocationMicro:'100000000',perNodeCapMicro:'10000000',ownerCaps:{[supportOwnerGroup(s,x.f.ids[0])]:'100000000'},matchPPM:1000000,bootstrapNodes:x.f.ids};
 r.step([x.wire({type:OPEN_SUPPORT,certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey)})]);
 return {x,r,original:seed.money.supply};
}

test('founder advance: exact award debit, signatures, crash recovery, replay and annual vesting',()=>{
 const x=issuanceFixture({utc:true}),r=rig(x,x.s,true,false);try{
  r.step([x.wire(certify(x,r.s,ISSUE_WARMUP_TRANCHE,{supplyBefore:r.s.money.supply,trancheMicro:'10000000'}))]);
  for(const change of [a=>a.certificate.approvals.pop(),a=>a.founderConsent=sign(a.certificate.body,keys().privateKey),a=>a.recipientConsent=sign(a.certificate.body,keys().privateKey)]){const a=advance(x,r.s);change(a);r.reject(x.wire(a));}
  for(const extra of [{trancheMicro:'900000001'},{recipient:keys().publicKey},{supplyBefore:'0'}])r.reject(x.wire(advance(x,r.s,extra)));
  const a=advance(x,r.s),before=hash(r.s),request={height:r.s.height+1,time:r.s.money.time,blockHash:hash('advance-crash'),txs:[Buffer.from(JSON.stringify(x.wire(a)))]};
  assert.throws(()=>r.db.commitBlock(request,r.db.root,{beforeCommit:()=>{throw Error('crash');}}),/crash/);r.reopen();assert.equal(hash(r.s),before);
  r.step([x.wire(a)]);r.step([x.wire(a)]);r.reopen();assert.equal(owned(r.s,x.recipient.publicKey),900000000n);
  assert.equal(BigInt(r.s.money.supply)-BigInt(x.s.money.supply),910000000n);assert.equal(centuryVested(r.s,'founder'),900000000n);
  r.reject(x.wire(advance(x,r.s)),/conflicting founder advance/);
  const start=r.s.centuryFunds.execution.start;r.step([x.wire(certify(x,r.s,ISSUE_CENTURY,{supplyBefore:r.s.money.supply}))]);r.reopen();
  assert.equal(BigInt(r.s.money.supply)-BigInt(x.s.money.supply),130000000000000n);const supply=r.s.money.supply;
  reachTime(r,anniversary(start,1)-1);r.reject(x.wire({type:'RELEASE_CENTURY_FOUNDER_V1',manifestHash:r.s.centuryFunds.manifestHash,cumulativeMicro:'1000000000000'}));
  r.step([],anniversary(start,1));const release={type:'RELEASE_CENTURY_FOUNDER_V1',manifestHash:r.s.centuryFunds.manifestHash,cumulativeMicro:'1000000000000'};
  const old=owned(r.s,x.recipient.publicKey);r.step([x.wire(release)]);assert.equal(owned(r.s,x.recipient.publicKey)-old,999100000000n);r.step([x.wire(release)]);
  reachTime(r,anniversary(start,10));r.step([x.wire({...release,cumulativeMicro:'10000000000000'})]);r.reopen();assert.equal(owned(r.s,x.recipient.publicKey),10000000000000n);assert.equal(r.s.money.supply,supply);
 }finally{r.db.close();}
});

for(const outcome of ['settle','expire','proven-fault'])test('founder advance: ten90 allocations plus10 support, '+outcome+' and separate returns',async()=>{
 const {x,r,original}=launch();try{
  for(const [index,node] of x.f.ids.entries()){
   const grant=()=>r.step([x.wire(supportConsent(x,r.s,node),x.key(node))]);
   if(index%2===0)grant();
   const view=async()=>{
    const height=r.db.networkHeader().height,root=r.db.root;
    const {state}=await loadBoundedWalletView(async(req,anchor)=>queryBounded(r.db,req,anchor),
     {root,height,configHash:hash(x.c),owner:x.recipient.publicKey,rewardIds:[node],allowIsolated:true});
    return {state,certificate:{appHash:root,appHeight:height,height:height+1}};
   };
   const flow=new WalletCollateral({key:x.recipient,client:{config:x.c},view});
   const review=await flow.review({node,amount:'90',unitScale:'1000000'});
   const consent=await flow.confirm({id:review.id});
   const signed=await signWorkerFunding(consent,{config:x.c,key:x.key(node),view,now:()=>r.s.money.time*1000,
    scope:{configHash:hash(x.c),node,owner:x.recipient.publicKey,valueMicro:'90000000'}});
   const a=signed.action,bad=structuredClone(a);bad.workerSignature=sign(bad.body,keys().privateKey);r.reject(x.wire(bad,x.recipient),/worker funding consent/);
   r.step([x.wire(a,x.recipient)]);r.step([x.wire(a,x.recipient)]);if(index%2!==0)grant();
   assert.equal(r.s.money.nodes[node].stake,'100000000');assert.equal(r.s.money.nodes[node].tier,'5000000');assert.equal(releasableCollateral(r.s,node),90000000n);
   const shown=await new WalletNodeLinks({key:x.recipient,client:{config:x.c},view}).options();
   assert.equal(shown.nodes.find(n=>n.id===node).collateral.display.remaining,'90');
   assert.equal(shown.nodes.find(n=>n.id===node).collateral.display.support,'10');
   assert.equal(shown.collateral.deposited,String((index+1)*90));
   assert.equal(shown.collateral.remaining,String((index+1)*90));
   assert.equal(shown.collateral.founder.released,'900');assert.equal(shown.collateral.founder.fullyIssued,false);
  }
  r.reopen();assert.equal(owned(r.s,x.recipient.publicKey),0n);assert.equal(BigInt(r.s.money.supply)-BigInt(original),10000000000n);
  const ids=x.f.ids.slice(0,6),i=x.intent(r.s,{epoch:r.s.money.epoch,unitScale:'1000000',feeSchedule:INITIAL_TARIFF,value:'10000000',fee:String(feeFor('10000000',INITIAL_TARIFF,2)),abortFee:String(releaseFeeFor('10000000','1000000',INITIAL_TARIFF)),parts:[{value:'5000000',nodes:ids.slice(0,3)},{value:'5000000',nodes:ids.slice(3)}]});
  r.step([x.reserve(i)]);assert(ids.every(id=>r.s.money.nodes[id].taskHeld==='5000000'));
  if(outcome==='settle')r.step([x.finish(r.s,i)],r.s.money.time+10);else{if(outcome==='proven-fault')r.step([x.wire(x.fault(r.s,i))]);r.step([],i.deadline+1);}
  assert(ids.every(id=>r.s.money.nodes[id].taskHeld==='0'));assert(!r.s.money.liability.records[i.pid]);r.reopen();
  const node=ids[0],value=String(releasableCollateral(r.s,node));assert(BigInt(value)<=90000000n);
  const release=stakeAction(x,r.s,node,QUEUE_RELEASE,value);r.step([x.wire(release,x.recipient)]);r.reject(x.wire({type:EXECUTE_RELEASE,node,sequence:release.body.sequence}),/cooldown/);
  r.step([x.wire(supportConsent(x,r.s,node,QUEUE_SUPPORT),x.key(node))]);
  r.step([],Math.max(r.s.workerFunding.accounts[node].release.readyAt,r.s.centuryFunds.support.book.grants[node].returnAfter));
  const supply=r.s.money.supply,locked=r.s.centuryFunds.support.book.grants[node].lockedMicro;
  r.step([x.wire({type:EXECUTE_RELEASE,node,sequence:release.body.sequence})]);r.step([x.wire({type:EXECUTE_RELEASE,node,sequence:release.body.sequence})]);
  assert.equal(owned(r.s,x.recipient.publicKey),BigInt(value));r.step([x.wire({type:RETURN_SUPPORT,node})]);r.step([x.wire({type:RETURN_SUPPORT,node})]);r.reopen();
  assert.equal(r.s.money.nodes[node].stake,'0');assert.equal(r.s.centuryFunds.support.book.poolMicro,locked);assert.equal(r.s.money.supply,supply);
 }finally{r.db.close();}
});

test('founder advance: ordinary production-configured store refuses new issuance',()=>{
 const x=issuanceFixture({utc:true}),r=rig(x,x.s,false,false);try{r.reject(x.wire(advance(x,r.s)),/issuance forbidden/);assert.equal(r.s.money.supply,x.s.money.supply);}finally{r.db.close();}
});
