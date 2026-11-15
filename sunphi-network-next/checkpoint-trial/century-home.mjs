// Explicit bounded key availability, not proof of continuous uptime or history
// execution. Quorum-admitted keys share finite fees and the SAME century budget.
import assert from 'node:assert/strict';
import {PAID_ADMISSION,auditPaidAdmissionHead} from './paid-admission-view.mjs';
import {economicAuditEntries} from './economic-record-view.mjs';
import {rewardRegistryTotals,rewardRegistryChanges} from './reward-registry-view.mjs';
import {copyControllerState,controllerContext} from './controller-context.mjs';
import {exact,hash,hex,integer,verify,canonical} from './crypto.mjs';
import {verifyRecordProof} from './research/record-proof.mjs';
import {amount} from './payment-model.mjs';
export const CENTURY_HOME='DUEBYTE_CENTURY_HOME_V1';
export const CENTURY_HOME_ACTION='COMPLETE_CENTURY_HOME_V1';
export const INDEXED_HOME='DUEBYTE_HOME_RECORD_AVAILABILITY_V1';
export const INDEXED_HOME_ACTION='COMPLETE_HOME_RECORD_AVAILABILITY_V1';
export const anonymousHomeGroup=configHash=>hash({domain:CENTURY_HOME+'/ANONYMOUS_POOL',configHash});
export const homeHeld=s=>BigInt(s.centurySubsidy?.pending?.home?.poolMicro??'0');
export function validateHomePolicy(h,interval){
 exact(h,['version',...(h.admission?['admission','sampleSize']:['nodes']),'costPerSampleMicro','feeSharePPM','responseSeconds']);assert([CENTURY_HOME,INDEXED_HOME].includes(h.version));
 amount(h.costPerSampleMicro);integer(h.feeSharePPM);assert(h.feeSharePPM<=1000000);
 integer(h.responseSeconds,5);assert(h.responseSeconds<=180&&interval>=300,'bounded home sampling');
 if(h.admission){assert.equal(h.admission,PAID_ADMISSION);assert.equal(h.version,INDEXED_HOME,'indexed admission requires authenticated record service');integer(h.sampleSize,1);assert(h.sampleSize<=32);return;}
 assert(h.nodes&&typeof h.nodes==='object'&&!Array.isArray(h.nodes));assert(Object.keys(h.nodes).length<=32);
 for(const [id,g]of Object.entries(h.nodes)){hex(id);if(g!==null)hex(g);}
}
export function homeOwners(s,h){
 validateHomePolicy(h,s.centurySubsidy?.policy.intervalSeconds??300);
 if(h.admission){assert(s.economicPreparation?.paidAdmission,'Home paid admission registry required');return s.centurySubsidy?.pending?.home?.owners??{};}
 return Object.fromEntries(Object.entries(h.nodes).map(([id,g])=>{assert(s.rewards.nodes[id]?.kind==='witness','admitted Home reward key required');return [id,g??anonymousHomeGroup(s.configHash)];}));
}
export function initialCenturyHome(s,policy,from,sequence){
 const h={poolMicro:'0',sample:null,jobs:{}};if(policy?.admission){const ctx=controllerContext(s);assert(ctx?.paidHomeSelection,'authenticated Home admission selection required');h.admission=structuredClone(ctx.paidAdmissionHead());auditPaidAdmissionHead(h.admission);h.owners=ctx.paidHomeSelection(from,hash({domain:'DUEBYTE_HOME_SELECTION_V1',configHash:s.configHash,blockHash:s.blockHash,from,sequence}),policy.sampleSize);}return h;
}
export function sampleCenturyHome(s){
 const b=s.centurySubsidy,p=b?.pending,h=p?.home;if(!h||h.sample||s.money.time<p.from)return;
 // Do not turn an offline gap into a fresh paid sample after its response window.
 const deadline=p.from+b.policy.home.responseSeconds;if(s.money.time>deadline)return;
 h.sample={height:s.height,blockHash:s.blockHash,deadline,anchor:structuredClone(s.rewards.period.anchor)};
 const indexed=b.policy.home.version===INDEXED_HOME,ctx=controllerContext(s);
 if(indexed){assert(ctx?.parentRoot&&ctx.workerCount,'indexed record service requires authenticated parent');h.sample.root=ctx.parentRoot;h.sample.parentHeight=ctx.parentHeight;}
 for(const id of Object.keys(homeOwners(s,b.policy.home)).sort()){
  const pick=indexed?Number(BigInt('0x'+hash({sample:h.sample,node:id,sequence:b.sequence}))%BigInt(ctx.workerCount)):0;
  h.jobs[id]={status:'assigned',...(indexed?{key:'nodes/'+ctx.workerAt(pick)}:{})};
 }
}
export function centuryHomeBody(s,node,valueHash){
 const b=s.centurySubsidy,h=b?.pending?.home;assert(h?.sample&&h.jobs[node],'assigned home sample required');
 if(b.policy.home.version===INDEXED_HOME){const j=h.jobs[node],digest=valueHash??j.valueHash;hex(digest);return {domain:INDEXED_HOME,configHash:s.configHash,planHash:b.planHash,sequence:b.sequence,node,challenge:hash({policy:b.policy.home,sample:h.sample,node,sequence:b.sequence}),root:h.sample.root,key:j.key,valueHash:digest};}
 return {domain:CENTURY_HOME,configHash:s.configHash,planHash:b.planHash,sequence:b.sequence,node,
  challenge:hash({policy:b.policy.home,sample:h.sample,node,sequence:b.sequence}),result:hash(h.sample.anchor)};
}
export function completeCenturyHome(base,a,author){
 const indexed=base.centurySubsidy?.policy.home?.version===INDEXED_HOME;
 exact(a,['type','body','signature',...(indexed?['proof']:[])]);assert.equal(a.type,indexed?INDEXED_HOME_ACTION:CENTURY_HOME_ACTION);const b=a.body;
 assert.deepEqual(b,centuryHomeBody(base,b.node,indexed?b.valueHash:undefined),'assigned home challenge');
 if(indexed){assert(Buffer.byteLength(canonical(a.proof))<=48000,'home proof budget');assert.equal(a.proof.key,b.key);assert.equal(a.proof.found,true);verifyRecordProof(a.proof,b.root);assert.equal(hash(a.proof.value),b.valueHash,'home record content');}
 const n=base.rewards.nodes[b.node];assert.equal(author,n.key);assert(verify(b,a.signature,n.key),'home response signature');
 const p=base.centurySubsidy.pending,h=p.home,j=h.jobs[b.node];
 if(j.status==='accepted'){assert.equal(j.proof,hash(b),'conflicting home response');return base;}
 assert(base.money.time<=h.sample.deadline&&base.money.time<p.to,'home response expired');
 const s=copyControllerState(base,['centurySubsidy','rewards']);s.centurySubsidy.pending.home.jobs[b.node]={status:'accepted',proof:hash(b),...(indexed?{key:j.key,valueHash:b.valueHash}:{})};
 s.rewards.nodes[b.node].witnessJobs=String(amount(n.witnessJobs)+1000000n);return s;
}
export function reserveHomeFees(s,fee){
 const p=s.centurySubsidy.pending;if(!p.home)return;
 const value=amount(fee)*BigInt(s.centurySubsidy.policy.home.feeSharePPM)/1000000n;
 assert(value<=amount(s.rewards.period.fees));s.rewards.period.fees=String(amount(s.rewards.period.fees)-value);
 p.home.poolMicro=String(amount(p.home.poolMicro)+value);
}
export function cappedCredits(raw,owners,nodeCap,groupCap,prior={}){
 const byNode={},groups={},spent={};
 for(const [id,v]of Object.entries(prior))spent[owners[id]]=(spent[owners[id]]??0n)+BigInt(v);
 for(const id of Object.keys(raw).sort()){
  const remaining=BigInt(nodeCap)-BigInt(prior[id]??0);assert(remaining>=0n);
  byNode[id]=raw[id]<remaining?raw[id]:remaining;
  const group=owners[id];assert(group);groups[group]=(groups[group]??0n)+byNode[id];
 }
 return Object.fromEntries(Object.keys(byNode).map(id=>{
  const g=owners[id],remaining=BigInt(groupCap)-(spent[g]??0n);assert(remaining>=0n);
  return [id,groups[g]>remaining?byNode[id]*remaining/groups[g]:byNode[id]];
 }));
}
export function homeCosts(s){
 const b=s.centurySubsidy,h=b.pending.home;if(!h)return {};
 return Object.fromEntries(Object.entries(h.jobs).filter(([,j])=>j.status==='accepted').map(([id])=>[id,amount(b.policy.home.costPerSampleMicro)]));
}
export function auditCenturyHome(s){
 const b=s.centurySubsidy;if(!b?.policy.home)return;
 const owners=homeOwners(s,b.policy.home);assert(b.homeFeesEarned&&typeof b.homeFeesEarned==='object');
 const changedRewards=rewardRegistryTotals(s.rewards.nodes)?[...rewardRegistryChanges(s.rewards.nodes).keys()]:[];
 for(const [id,v]of economicAuditEntries(b.homeFeesEarned,[...economicAuditEntries(b.earned).map(([id])=>id),...changedRewards])){assert(b.policyControl||b.policy.home.admission?s.rewards.nodes[id]?.kind==='witness':owners[id]);amount(v);assert(amount(v)+amount(b.earned[id]??'0')<=amount(s.rewards.nodes[id].earned));}
 const h=b.pending?.home;if(!b.pending)return;assert(h);exact(h,['poolMicro','sample','jobs',...(b.policy.home.admission?['admission','owners']:[])]);amount(h.poolMicro);
 if(b.policy.home.admission){auditPaidAdmissionHead(h.admission);assert(Object.keys(h.owners).length<=b.policy.home.sampleSize);for(const [id,g]of Object.entries(h.owners)){hex(id);assert.equal(g,anonymousHomeGroup(s.configHash));assert.equal(s.rewards.nodes[id]?.kind,'witness');}}
 assert(amount(h.poolMicro)<=amount(b.pending.feesMicro));assert(Object.keys(h.jobs).length<=32);
 const indexed=b.policy.home.version===INDEXED_HOME;
 if(h.sample){exact(h.sample,['height','blockHash','deadline','anchor',...(indexed?['root','parentHeight']:[])]);if(indexed){hex(h.sample.root);integer(h.sample.parentHeight);assert(h.sample.parentHeight<h.sample.height);}integer(h.sample.height,1);assert(h.sample.height<=s.height);hex(h.sample.blockHash);assert.equal(h.sample.deadline,b.pending.from+b.policy.home.responseSeconds);exact(h.sample.anchor,['height','stateHash']);integer(h.sample.anchor.height);hex(h.sample.anchor.stateHash);
  assert.deepEqual(Object.keys(h.jobs).sort(),Object.keys(owners).sort());
 }else assert.equal(Object.keys(h.jobs).length,0);
 for(const [id,j]of Object.entries(h.jobs)){assert(owners[id]);assert(['assigned','accepted'].includes(j.status));exact(j,[...(j.status==='accepted'?['status','proof']:['status']),...(indexed?['key',...(j.status==='accepted'?['valueHash']:[])]:[])]);if(indexed)assert(/^nodes\/[a-f0-9]{64}$/.test(j.key));if(j.status==='accepted')assert.equal(j.proof,hash(centuryHomeBody(s,id)));}
}
