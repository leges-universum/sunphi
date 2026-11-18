// Explicit prospective acceleration of INITIAL Home admission during the pilot.
// Normal admission/revocation and all reward accounting remain unchanged.
import assert from 'node:assert/strict';
import {activeZeroStage} from './main-programme-transition.mjs';
import {exact,hash,hex,integer,verify} from '../crypto.mjs';
import {validatorQuorum} from '../authority.mjs';import {developmentManager} from '../reserve-recovery.mjs';
import {anonymousHomeGroup} from '../century-home.mjs';
import {PAID_ADMISSION} from '../paid-admission-view.mjs';
import {ADMISSION_BATCH,ADMISSION_HEAD,admissionHead,admissionKey,auditAdmissionRecord} from './bounded-paid-admission.mjs';
export const EXPEDITE_ZERO_STAGE_HOME='EXPEDITE_ZERO_STAGE_HOME_ADMISSION_V1';
export function expediteZeroStageHome(s,a,c,tx){
 exact(a,['type','certificate','founderConsent']);assert.equal(a.type,EXPEDITE_ZERO_STAGE_HOME);exact(a.certificate,['body','approvals']);const b=a.certificate.body;
 exact(b,['domain','network','configHash','generation','managementEpoch','notBefore','expires','sequence','previousHash','zeroStageCertificateHash','effectiveFrom','changes','reason']);
 assert.equal(b.domain,EXPEDITE_ZERO_STAGE_HOME);assert.equal(b.network,c.chainId);assert.equal(b.configHash,s.configHash);assert.equal(b.configHash,hash(c));assert.equal(b.generation,s.authority.generation);
 assert(!s.authority.pending,'validator transition pending');const access=s.networkReserves?.development?.access;assert(access&&!access.pending,'stable admission custody required');assert.equal(b.managementEpoch,access.epoch);
 integer(b.notBefore,1);integer(b.expires,b.notBefore+1);assert(b.expires-b.notBefore<=600&&s.money.time>=b.notBefore&&s.money.time<b.expires,'admission UTC inclusion window');
 validatorQuorum(b,a.certificate.approvals,s.authority.validators);assert(verify(b,a.founderConsent,developmentManager(s.networkReserves)),'founder admission consent');
 const pilot=activeZeroStage(s);assert(pilot&&s.centuryFees&&s.rewards&&!s.centurySubsidy,'active fee-only zero stage required');assert.equal(b.zeroStageCertificateHash,pilot.certificateHash);
 const start=pilot.body.startsAt,end=start+pilot.body.settings.durationSeconds;assert(s.money.time>=start&&s.money.time<end,'zero-stage UTC window');
 assert.equal(s.rewards.coefficients.alphaPPM,0);assert.equal(s.rewards.coefficients.lifetimeMintLimit,'0');assert.equal(s.rewards.coefficients.periodMintLimit,'0');
 const head=admissionHead(tx.get),digest=hash(b);assert(head,'existing initial admission required');assert.deepEqual(s.economicPreparation?.paidAdmission,head,'admission header mismatch');if(head.lastActionHash===digest)return s;
 assert.equal(b.sequence,head.sequence+1,'admission sequence');assert.equal(b.previousHash,head.history,'stale admission head');
 integer(b.effectiveFrom,s.money.time);assert(b.effectiveFrom<=s.money.time+600&&b.effectiveFrom<end,'prospective zero-stage activation');
 assert(typeof b.reason==='string'&&b.reason.trim().length>0&&b.reason.length<=512&&!/[\u0000-\u001f]/.test(b.reason),'public admission reason');
 assert(Array.isArray(b.changes)&&b.changes.length>0&&b.changes.length<=ADMISSION_BATCH,'admission batch bound');
 const edits=[];let last='';for(const change of b.changes){
  exact(change,['node','previousRecordHash']);hex(change.node);hex(change.previousRecordHash);assert(change.node>last,'canonical unique admission order');last=change.node;
  const n=s.rewards.nodes[change.node];assert(n?.kind==='witness'&&n.payouts.length>0,'registered Home with payout consent required');assert(n.earned==='0'&&n.paid==='0'&&n.witnessJobs==='0','only initial unpaid Home admission');
  const old=tx.get(admissionKey(change.node));assert(old,'existing initial admission required');auditAdmissionRecord(old);assert.equal(hash(old),change.previousRecordHash,'stale admission record');
  assert(old.kind==='witness'&&old.current===null&&old.pending.enabled&&old.pending.effectiveFrom>s.money.time,'initial pending Home admission required');assert(b.effectiveFrom<old.pending.effectiveFrom,'admission must be accelerated');assert.equal(old.pending.group,anonymousHomeGroup(s.configHash));
  edits.push([change.node,{...old,sequence:b.sequence,pending:{...old.pending,effectiveFrom:b.effectiveFrom}}]);
 }
 for(const [id,record]of edits)tx.set(admissionKey(id),record);
 const next={version:PAID_ADMISSION,sequence:b.sequence,count:head.count,history:hash({previous:head.history,action:digest}),lastActionHash:digest};
 tx.set(ADMISSION_HEAD,next);s.economicPreparation={...s.economicPreparation,paidAdmission:next};return s;
}
