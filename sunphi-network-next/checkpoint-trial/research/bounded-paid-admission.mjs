// Prospective paid-service admission. Population is unbounded; each signed
// change touches at most 64 registered workers. This grants no voting or funds.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,verify} from '../crypto.mjs';
import {validatorQuorum} from '../authority.mjs';
import {developmentManager} from '../reserve-recovery.mjs';
import {effectiveWorkGroup} from '../payment-liability.mjs';
import {ensureRewardWorker} from '../node-rewards.mjs';
import {anonymousHomeGroup} from '../century-home.mjs';
import {PAID_ADMISSION,auditPaidAdmissionHead} from '../paid-admission-view.mjs';
import {changeRadix,radixCount,radixIds} from './bounded-radix-index.mjs';
export const SCHEDULE_PAID_ADMISSION='SCHEDULE_PAID_ADMISSION_V1';
export const ADMISSION_NOTICE=86400,ADMISSION_BATCH=64;
export const ADMISSION_HEAD='paid-admission/head',ADMISSION_INDEX='paid-admission/index';
export const admissionKey=id=>'paid-admission/records/'+hex(id);
export const admissionIds=(get,options)=>radixIds(get,ADMISSION_INDEX,options);
export function admissionHead(get){const h=get(ADMISSION_HEAD);if(!h)return null;auditPaidAdmissionHead(h);assert.equal(h.count,radixCount(get,ADMISSION_INDEX));return h;}
function version(v){exact(v,['enabled','group','effectiveFrom']);assert.equal(typeof v.enabled,'boolean');assert(typeof v.group==='string'&&v.group.length>0&&v.group.length<=256);integer(v.effectiveFrom,1);}
export function auditAdmissionRecord(r){exact(r,['kind','sequence','current','pending']);assert(['worker','witness'].includes(r.kind));integer(r.sequence,1);if(r.current!==null)version(r.current);version(r.pending);assert(!r.current||r.pending.effectiveFrom>r.current.effectiveFrom);return r;}
export function admissionAt(get,id,time){integer(time,1);const r=get(admissionKey(id));if(!r)return null;auditAdmissionRecord(r);const v=time>=r.pending.effectiveFrom?r.pending:r.current;return v&&time>=v.effectiveFrom&&v.enabled?{kind:r.kind,group:v.group}:null;}
// Sample a fixed number of candidate slots; revoked/future entries consume a
// slot rather than triggering an unbounded search. Each retained identity has
// equal marginal selection probability. Selection is not a proof of humanity.
export function selectPaidHomes(get,time,seed,limit){
 integer(limit,1);assert(limit<=32);hex(seed);const count=radixCount(get,'paid-admission/homes'),owners={};if(!count)return owners;
 const start=Number(BigInt('0x'+seed)%BigInt(count)),slots=Math.min(limit,count),tail=Math.min(slots,count-start);
 const ids=[...radixIds(get,'paid-admission/homes',{offset:start,limit:tail}),...(tail<slots?[...radixIds(get,'paid-admission/homes',{offset:0,limit:slots-tail})]:[])];
 for(const id of ids){const a=admissionAt(get,id,time);if(a){assert.equal(a.kind,'witness');owners[id]=a.group;}}return owners;
}
export function schedulePaidAdmission(s,a,c,tx){
 exact(a,['type','certificate','founderConsent']);assert.equal(a.type,SCHEDULE_PAID_ADMISSION);exact(a.certificate,['body','approvals']);const b=a.certificate.body;
 exact(b,['domain','network','configHash','generation','managementEpoch','notBefore','expires','sequence','previousHash','effectiveFrom','changes','reason']);
 assert.equal(b.domain,SCHEDULE_PAID_ADMISSION);assert.equal(b.network,c.chainId);assert.equal(b.configHash,s.configHash);assert.equal(b.configHash,hash(c));assert.equal(b.generation,s.authority.generation);
 assert(!s.authority.pending,'validator transition pending');assert(s.centuryFees&&s.rewards,'prepared paid-service accounting required');
 const access=s.networkReserves?.development?.access;assert(access&&!access.pending,'stable admission custody required');assert.equal(b.managementEpoch,access.epoch);
 integer(b.notBefore,1);integer(b.expires,b.notBefore+1);assert(b.expires-b.notBefore<=600&&s.money.time>=b.notBefore&&s.money.time<b.expires,'admission UTC inclusion window');
 validatorQuorum(b,a.certificate.approvals,s.authority.validators);assert(verify(b,a.founderConsent,developmentManager(s.networkReserves)),'founder admission consent');
 const head=admissionHead(tx.get),digest=hash(b);assert.deepEqual(s.economicPreparation?.paidAdmission??null,head,'admission header mismatch');if(head?.lastActionHash===digest)return s;
 assert.equal(b.sequence,(head?.sequence??0)+1,'admission sequence');assert.equal(b.previousHash,head?.history??null,'stale admission head');
 integer(b.effectiveFrom,s.money.time+ADMISSION_NOTICE);assert(b.effectiveFrom<=s.money.time+30*ADMISSION_NOTICE,'bounded admission notice');
 assert(typeof b.reason==='string'&&b.reason.trim().length>0&&b.reason.length<=512&&!/[\u0000-\u001f]/.test(b.reason),'public admission reason');
 assert(Array.isArray(b.changes)&&b.changes.length>0&&b.changes.length<=ADMISSION_BATCH,'admission batch bound');
 const edits=[];let last='';
 for(const change of b.changes){
  exact(change,['node','enabled']);hex(change.node);assert(change.node>last,'canonical unique admission order');last=change.node;assert.equal(typeof change.enabled,'boolean');
  if(s.money.nodes[change.node])ensureRewardWorker(s,change.node);const n=s.rewards.nodes[change.node];assert(n&&['worker','witness'].includes(n.kind),'registered work key required');
  const old=tx.get(admissionKey(change.node));if(old)auditAdmissionRecord(old);
  assert(!old||old.pending.effectiveFrom<=s.money.time,'pending admission change');
  // Retain the version needed by the open accounting window. No rescheduling
  // can erase proof of previously accepted work or rewrite its owner group.
  assert(!old||!s.centurySubsidy?.pending||old.pending.effectiveFrom<=s.centurySubsidy.pending.from,'open interval needs admission history');
  if(old)assert.equal(old.kind,n.kind);
  const current=old?.pending??null,group=n.kind==='worker'?effectiveWorkGroup(s.money,change.node):anonymousHomeGroup(s.configHash);
  assert(current?current.enabled!==change.enabled||current.group!==group:change.enabled,'admission unchanged');
  edits.push([change.node,{kind:n.kind,sequence:b.sequence,current,pending:{enabled:change.enabled,group,effectiveFrom:b.effectiveFrom}},!old]);
 }
 let count=head?.count??0;
 for(const [id,r,insert]of edits){if(insert){changeRadix(tx,ADMISSION_INDEX,id,true);if(r.kind==='witness')changeRadix(tx,'paid-admission/homes',id,true);count++;}tx.set(admissionKey(id),r);}
 const next={version:PAID_ADMISSION,sequence:b.sequence,count,history:hash({previous:head?.history??null,action:digest}),lastActionHash:digest};
 tx.set(ADMISSION_HEAD,next);s.economicPreparation={...s.economicPreparation,paidAdmission:next};return s;
}
export function auditPaidAdmission(records,s){
 const rows=[...records].filter(([k])=>k.startsWith('paid-admission/'));if(!rows.length){assert(!s.economicPreparation?.paidAdmission&&!s.centurySubsidy?.policy.admission&&!s.centurySubsidy?.policyControl?.pending?.policy.admission,'missing paid admission');return;}
 const get=k=>records.get(k),head=admissionHead(get),expected=new Map(),tx={get:k=>expected.get(k),set:(k,v)=>expected.set(k,v),delete:k=>expected.delete(k)};assert(head);assert.deepEqual(s.economicPreparation?.paidAdmission,head,'admission header mismatch');
 for(const [key,r]of rows)if(key.startsWith('paid-admission/records/')){const id=key.slice('paid-admission/records/'.length);hex(id);auditAdmissionRecord(r);assert(r.sequence<=head.sequence);assert.equal(s.rewards?.nodes[id]?.kind,r.kind);if(r.kind==='worker')assert(s.money.nodes[id]);else {assert.equal(r.pending.group,anonymousHomeGroup(s.configHash));if(r.current)assert.equal(r.current.group,anonymousHomeGroup(s.configHash));changeRadix(tx,'paid-admission/homes',id,true);}changeRadix(tx,ADMISSION_INDEX,id,true);expected.set(key,r);}
 expected.set(ADMISSION_HEAD,head);const sorted=m=>[...m].sort(([a],[b])=>a<b?-1:a>b?1:0);assert.deepEqual(sorted(expected),sorted(rows),'admission records or index differ');
 const p=s.centurySubsidy?.pending;if(p?.admission){assert(p.admission.sequence<=head.sequence);for(const [id,group]of Object.entries(p.owners))assert.equal(admissionAt(get,id,p.from)?.group,group,'accepted work admission changed');}
 if(p?.home?.admission){assert(p.home.admission.sequence<=head.sequence);for(const [id,g]of Object.entries(p.home.owners)){const a=admissionAt(get,id,p.from);assert(a?.kind==='witness'&&a.group===g,'Home sample admission changed');}}
}
