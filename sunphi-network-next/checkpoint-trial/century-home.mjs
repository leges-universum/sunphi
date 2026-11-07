// Explicit bounded key availability, not proof of continuous uptime or history
// execution. Quorum-admitted keys share finite fees and the SAME century budget.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,verify} from './crypto.mjs';
import {amount} from './payment-model.mjs';
export const CENTURY_HOME='DUEBYTE_CENTURY_HOME_V1';
export const CENTURY_HOME_ACTION='COMPLETE_CENTURY_HOME_V1';
export const anonymousHomeGroup=configHash=>hash({domain:CENTURY_HOME+'/ANONYMOUS_POOL',configHash});
export const homeHeld=s=>BigInt(s.centurySubsidy?.pending?.home?.poolMicro??'0');
export function validateHomePolicy(h,interval){
 exact(h,['version','nodes','costPerSampleMicro','feeSharePPM','responseSeconds']);assert.equal(h.version,CENTURY_HOME);
 amount(h.costPerSampleMicro);integer(h.feeSharePPM);assert(h.feeSharePPM<=1000000);
 integer(h.responseSeconds,5);assert(h.responseSeconds<=180&&interval>=300,'bounded home sampling');
 assert(h.nodes&&typeof h.nodes==='object'&&!Array.isArray(h.nodes));assert(Object.keys(h.nodes).length<=32);
 for(const [id,g]of Object.entries(h.nodes)){hex(id);if(g!==null)hex(g);}
}
export function homeOwners(s,h){
 validateHomePolicy(h,s.centurySubsidy?.policy.intervalSeconds??300);
 return Object.fromEntries(Object.entries(h.nodes).map(([id,g])=>{assert(s.rewards.nodes[id]?.kind==='witness','admitted Home reward key required');return [id,g??anonymousHomeGroup(s.configHash)];}));
}
export function initialCenturyHome(){return {poolMicro:'0',sample:null,jobs:{}};}
export function sampleCenturyHome(s){
 const b=s.centurySubsidy,p=b?.pending,h=p?.home;if(!h||h.sample||s.money.time<p.from)return;
 // Do not turn an offline gap into a fresh paid sample after its response window.
 const deadline=p.from+b.policy.home.responseSeconds;if(s.money.time>deadline)return;
 h.sample={height:s.height,blockHash:s.blockHash,deadline,anchor:structuredClone(s.rewards.period.anchor)};
 for(const id of Object.keys(b.policy.home.nodes).sort())h.jobs[id]={status:'assigned'};
}
export function centuryHomeBody(s,node){
 const b=s.centurySubsidy,h=b?.pending?.home;assert(h?.sample&&h.jobs[node],'assigned home sample required');
 return {domain:CENTURY_HOME,configHash:s.configHash,planHash:b.planHash,sequence:b.sequence,node,
  challenge:hash({policy:b.policy.home,sample:h.sample,node,sequence:b.sequence}),result:hash(h.sample.anchor)};
}
export function completeCenturyHome(base,a,author){
 exact(a,['type','body','signature']);assert.equal(a.type,CENTURY_HOME_ACTION);const b=a.body;
 assert.deepEqual(b,centuryHomeBody(base,b.node),'assigned home challenge');
 const n=base.rewards.nodes[b.node];assert.equal(author,n.key);assert(verify(b,a.signature,n.key),'home response signature');
 const p=base.centurySubsidy.pending,h=p.home,j=h.jobs[b.node];
 if(j.status==='accepted')return base;
 assert(base.money.time<=h.sample.deadline&&base.money.time<p.to,'home response expired');
 const s=structuredClone(base);s.centurySubsidy.pending.home.jobs[b.node]={status:'accepted',proof:hash(b)};
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
 for(const [id,v]of Object.entries(b.homeFeesEarned)){assert(b.policyControl?s.rewards.nodes[id]?.kind==='witness':owners[id]);amount(v);assert(amount(v)+amount(b.earned[id]??'0')<=amount(s.rewards.nodes[id].earned));}
 const h=b.pending?.home;if(!b.pending)return;assert(h);exact(h,['poolMicro','sample','jobs']);amount(h.poolMicro);
 assert(amount(h.poolMicro)<=amount(b.pending.feesMicro));assert(Object.keys(h.jobs).length<=32);
 if(h.sample){exact(h.sample,['height','blockHash','deadline','anchor']);integer(h.sample.height,1);assert(h.sample.height<=s.height);hex(h.sample.blockHash);assert.equal(h.sample.deadline,b.pending.from+b.policy.home.responseSeconds);exact(h.sample.anchor,['height','stateHash']);integer(h.sample.anchor.height);hex(h.sample.anchor.stateHash);
  assert.deepEqual(Object.keys(h.jobs).sort(),Object.keys(owners).sort());
 }else assert.equal(Object.keys(h.jobs).length,0);
 for(const [id,j]of Object.entries(h.jobs)){assert(owners[id]);assert(['assigned','accepted'].includes(j.status));exact(j,j.status==='accepted'?['status','proof']:['status']);if(j.status==='accepted')assert.equal(j.proof,hash(centuryHomeBody(s,id)));}
}
