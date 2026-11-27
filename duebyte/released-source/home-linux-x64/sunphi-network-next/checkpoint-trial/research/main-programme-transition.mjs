// One prospective authorization, one atomic UTC transition. Historical pilot
// certificates, payments and support grants remain part of the same ledger.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,publicKey,verify} from '../crypto.mjs';
import {amount} from '../payment-model.mjs';
import {validatorQuorum} from '../authority.mjs';
import {developmentManager} from '../reserve-recovery.mjs';
import {supportIssued} from '../support-accounting.mjs';
import {centuryFundOutputId,creditDevelopmentTranche} from '../century-issuance.mjs';
import {reserveAddresses} from '../network-reserves.mjs';
import {closeUnusedCenturyInterval} from '../century-warmup.mjs';
import {START,inspectAnnualPlan} from './calendar-node-emission-policy.mjs';
import {prepareCalendarSource,calendarSource} from './calendar-service-custody.mjs';
import {SERVICE_HEAD,serviceProfile} from './bounded-service-rewards.mjs';

export const PREPARE_MAIN_PROGRAMME='PREPARE_MAIN_PROGRAMME_V1';
export const SCHEDULE_DEVELOPMENT_PAYOUT='SCHEDULE_ANNUAL_DEVELOPMENT_PAYOUT_V1';
function validatePayoutBody(s,b){
 const f=s.centuryFunds;
 exact(b,['domain','network','configHash','programmeHash','generation','managementEpoch','notBefore','expires','recipient']);
 assert.equal(b.domain,SCHEDULE_DEVELOPMENT_PAYOUT);
 assert.equal(b.network,f.mainProgramme.body.network);assert.equal(b.configHash,s.configHash);
 assert.equal(b.programmeHash,f.mainProgramme.certificateHash);
 integer(b.generation);integer(b.managementEpoch);integer(b.notBefore,1);integer(b.expires,b.notBefore+1);
 assert(b.expires-b.notBefore<=600 && b.expires<=START);
 publicKey(b.recipient);
 const m=f.manifest;
 assert(![m.development.account,m.founder.account,m.memorial.account,...m.warmup.accounts,...reserveAddresses(s.configHash)].includes(b.recipient),'ordinary receiving wallet required');
}
export function scheduleDevelopmentPayout(s,a){
 exact(a,['type','certificate','founderConsent']);assert.equal(a.type,SCHEDULE_DEVELOPMENT_PAYOUT);
 exact(a.certificate,['body','approvals']);
 const f=s.centuryFunds,p=f?.mainProgramme,b=a.certificate.body;
 assert(p && !p.activation && s.money.time<START,'requires the prepared programme before launch');
 validatePayoutBody(s,b);
 const access=s.networkReserves.development.access;
 assert(!access.pending && !s.authority.pending);
 assert.equal(b.generation,s.authority.generation);assert.equal(b.managementEpoch,access.epoch);
 assert(![access.manager,...access.recovery.keys,s.economicPreparation.memorial.manager].includes(b.recipient),'separate receiving wallet required');
 assert(s.money.time>=b.notBefore && s.money.time<b.expires,'payout authorization window');
 validatorQuorum(b,a.certificate.approvals,s.authority.validators);
 assert(verify(b,a.founderConsent,developmentManager(s.networkReserves)),'development payout consent');
 const certificateHash=hash(b);
 if(p.developmentPayout){assert.equal(p.developmentPayout.certificateHash,certificateHash,'payout already registered');return s;}
 assert(f.execution.partialWarmupMicro && !f.execution.pending && f.execution.developmentSpentMicro==='0');
 p.developmentPayout={body:structuredClone(b),certificateHash};return s;
}
export const mainProgrammeActive=s=>Boolean(s.centuryFunds?.mainProgramme?.activation);
export const activeZeroStage=s=>mainProgrammeActive(s)?null:s.centuryFunds?.zeroStage;
export const fixedFundTotal=s=>['warmup','development','founder','memorial'].reduce((n,k)=>n+amount(s.centuryFunds.manifest[k].totalMicro),0n);
export function programmeBaseline(s){
 const f=s.centuryFunds,x=f.execution;
 return {pilotCertificateHash:f.zeroStage.certificateHash,issuanceStart:x.start,warmupStart:x.warmupStart,
  partialWarmupMicro:x.partialWarmupMicro,issuedMicro:x.issuedMicro,founderReleasedMicro:x.founderReleasedMicro,
  founderAdvanceHash:hash(x.founderAdvance??null),supportIssuedMicro:String(supportIssued(s)),supportCertificateHash:f.support?.certificateHash??null};
}
export function prepareMainProgramme(s,a,c,tx){
 exact(a,['type','certificate','founderConsent']);assert.equal(a.type,PREPARE_MAIN_PROGRAMME);exact(a.certificate,['body','approvals']);
 const b=a.certificate.body,f=s.centuryFunds,h=tx.get(SERVICE_HEAD);
 exact(b,['domain','network','configHash','generation','managementEpoch','notBefore','expires','start','planHash','manifestHash','annualHash','profileHash','baseline']);
 assert.equal(b.domain,PREPARE_MAIN_PROGRAMME);assert.equal(b.network,c.chainId);assert.equal(b.configHash,hash(c));assert.equal(b.configHash,s.configHash);
 assert.equal(b.generation,s.authority.generation);assert(!s.authority.pending);
 const access=s.networkReserves?.development?.access;assert(access&&!access.pending);assert.equal(b.managementEpoch,access.epoch);
 validatorQuorum(b,a.certificate.approvals,s.authority.validators);assert(verify(b,a.founderConsent,developmentManager(s.networkReserves)),'founder programme consent');
 if(f?.mainProgramme){assert.equal(f.mainProgramme.certificateHash,hash(b),'main programme already prepared');return s;}
 integer(b.notBefore,1);integer(b.expires,b.notBefore+1);assert(b.expires-b.notBefore<=600&&s.money.time>=b.notBefore&&s.money.time<b.expires,'programme inclusion window');
 assert(s.money.time<START,'prospective programme preparation required');assert.equal(b.start,START);
 assert(f?.zeroStage&&f.execution?.partialWarmupMicro&&s.centuryWarmup,'existing partial pilot required');
 assert(!s.centurySubsidy&&!s.rewards.scheduled&&!calendarSource(s));assert(h&&!h.main,'existing finite service funding required');
 assert(h.plan.to<=START);assert.deepEqual(h.profile,serviceProfile(s.rewards.coefficients));
 assert.equal(b.planHash,s.economicPreparation.planHash);assert.equal(b.manifestHash,f.manifestHash);
 assert.equal(b.annualHash,inspectAnnualPlan(s.economicPreparation.plan.annualRegularMicro).annualHash);assert.equal(b.profileHash,hash(h.profile));
 assert.deepEqual(b.baseline,programmeBaseline(s),'pilot advances changed');
 assert.equal(f.execution.developmentSpentMicro,'0');assert(!f.execution.pending&&!s.economicPreparation.memorial.issued);
 f.mainProgramme={body:structuredClone(b),certificateHash:hash(b),preparedHeight:s.height,activation:null,warmupRebased:null};
 prepareCalendarSource(s,hash(b),b.baseline.supportIssuedMicro);
 h.main={certificateHash:hash(b)};if(h.nextDay===h.plan.to)h.nextDay=START;tx.set(SERVICE_HEAD,h);
 auditMainProgramme(s);return s;
}
export function auditMainProgramme(s){
 const p=s.centuryFunds?.mainProgramme;if(!p)return;const f=s.centuryFunds,x=f.execution,b=p.body;
 exact(b,['domain','network','configHash','generation','managementEpoch','notBefore','expires','start','planHash','manifestHash','annualHash','profileHash','baseline']);
 assert.equal(b.domain,PREPARE_MAIN_PROGRAMME);integer(b.generation);integer(b.managementEpoch);integer(b.notBefore,1);integer(b.expires,b.notBefore+1);assert(b.expires-b.notBefore<=600);
 exact(b.baseline,['pilotCertificateHash','issuanceStart','warmupStart','partialWarmupMicro','issuedMicro','founderReleasedMicro','founderAdvanceHash','supportIssuedMicro','supportCertificateHash']);
 integer(b.baseline.issuanceStart,1);integer(b.baseline.warmupStart,b.baseline.issuanceStart);assert(b.baseline.warmupStart<START);
 for(const k of ['partialWarmupMicro','issuedMicro','founderReleasedMicro','supportIssuedMicro'])amount(b.baseline[k]);
 assert.equal(amount(b.baseline.issuedMicro),amount(b.baseline.partialWarmupMicro)+amount(b.baseline.founderReleasedMicro));
 assert.equal(b.annualHash,inspectAnnualPlan(s.economicPreparation.plan.annualRegularMicro).annualHash);hex(b.profileHash);
 exact(p,['body','certificateHash','preparedHeight','activation','warmupRebased',...(p.developmentPayout?['developmentPayout']:[])]);hex(p.certificateHash);assert.equal(hash(b),p.certificateHash);
 if(p.developmentPayout){
  const payout=p.developmentPayout;exact(payout,['body','certificateHash']);validatePayoutBody(s,payout.body);
  assert.equal(hash(payout.body),payout.certificateHash);
 }
 integer(p.preparedHeight,1);assert(p.preparedHeight<=s.height);assert.equal(b.start,START);assert.equal(b.configHash,s.configHash);
 assert.equal(b.planHash,s.economicPreparation.planHash);assert.equal(b.manifestHash,f.manifestHash);
 assert.equal(b.baseline.pilotCertificateHash,f.zeroStage.certificateHash);assert.equal(b.baseline.issuanceStart,x.start);
 assert.equal(b.baseline.founderAdvanceHash,hash(x.founderAdvance??null));assert.equal(b.baseline.supportIssuedMicro,String(supportIssued(s)));
 assert.equal(b.baseline.supportCertificateHash,f.support?.certificateHash??null);
 assert.equal(calendarSource(s)?.certificateHash,p.certificateHash);assert.equal(calendarSource(s)?.advanceMicro,b.baseline.supportIssuedMicro);
 if(!p.activation){assert.deepEqual(b.baseline,programmeBaseline(s));assert.equal(p.warmupRebased,null);return;}
 const a=p.activation;exact(a,['height','at','supplyBefore','deltaMicro','warmupControllerHash','serviceFundingHash']);
 integer(a.height,p.preparedHeight);assert(a.height<=s.height);integer(a.at,START);assert(a.at<=s.money.time);hex(a.warmupControllerHash);hex(a.serviceFundingHash);
 assert.equal(amount(a.deltaMicro),fixedFundTotal(s)-amount(b.baseline.issuedMicro));amount(a.supplyBefore);
 assert(!x.partialWarmupMicro);assert.equal(amount(x.issuedMicro),fixedFundTotal(s));assert.equal(s.centuryWarmup.fundedMicro,f.manifest.warmup.totalMicro);
 if(p.warmupRebased){exact(p.warmupRebased,['height','at','previousControllerHash']);integer(p.warmupRebased.height,a.height);assert(p.warmupRebased.height<=s.height);integer(p.warmupRebased.at,a.at);assert(p.warmupRebased.at<=s.money.time);hex(p.warmupRebased.previousControllerHash);assert.equal(x.warmupStart,START);}
 else assert.equal(x.warmupStart,b.baseline.warmupStart);
}
export function advanceMainProgramme(s){
 const f=s.centuryFunds,p=f?.mainProgramme;if(!p||s.money.time<START)return s;
 const x=f.execution,m=f.manifest,w=s.centuryWarmup;
 if(!p.activation){
  assert.deepEqual(programmeBaseline(s),p.body.baseline,'pilot advance changed before launch');
  const delta=fixedFundTotal(s)-amount(x.issuedMicro);assert(delta>=0n);
  const supply=amount(s.money.supply)+delta;assert(supply<=amount(s.economicPreparation.plan.capMicro));
  const extra=amount(m.warmup.totalMicro)-amount(x.partialWarmupMicro),half=extra/2n;
  for(const [kind,owner,value]of [['warmup-a',m.warmup.accounts[0],half],['warmup-b',m.warmup.accounts[1],extra-half]]){
   const id=centuryFundOutputId(s,kind),old=s.money.outputs[id];assert(!old||old.owner===owner&&old.unlock===0,'warmup funding collision');
   s.money.outputs[id]={owner,value:String(amount(old?.value??'0')+value),unlock:0};
  }
  for(const kind of ['development','founder','memorial']){
   const id=centuryFundOutputId(s,kind);assert(!s.money.outputs[id],'fund allocation collision');
   s.money.outputs[id]={owner:m[kind].account,value:String(amount(m[kind].totalMicro)-(kind==='founder'?amount(x.founderReleasedMicro):0n)),unlock:0};
  }
  p.activation={height:s.height,at:s.money.time,supplyBefore:s.money.supply,deltaMicro:String(delta),warmupControllerHash:hash(w.controller),serviceFundingHash:hash(w.serviceFunding)};
  s.money.supply=String(supply);x.issuedMicro=String(fixedFundTotal(s));delete x.partialWarmupMicro;
  x.history=hash({previous:x.history,programme:p.certificateHash,activation:p.activation});w.fundedMicro=m.warmup.totalMicro;
  s.economicPreparation.memorial.issued=true;s.economicPreparation.memorial.balanceMicro=m.memorial.totalMicro;
 }
 creditDevelopmentTranche(s);
 // A payment already in flight keeps its original deadline, escrow and work.
 // Only its controller's NEXT interval changes clock, after it has settled.
 if(!p.warmupRebased&&!w.pending){
  if(w.controller.pending&&s.money.time>=w.controller.pending.to)s.centuryWarmup=closeUnusedCenturyInterval(w,s.money);
  const book=s.centuryWarmup;
  if(!book.controller.pending){
   p.warmupRebased={height:s.height,at:s.money.time,previousControllerHash:hash(book.controller)};
   book.controller.start=START;book.controller.cursor=Math.max(START,book.controller.cursor);x.warmupStart=START;
  }
 }
 auditMainProgramme(s);return s;
}
