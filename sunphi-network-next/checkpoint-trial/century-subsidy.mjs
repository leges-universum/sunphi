// Closed-admission century candidate: pay accepted settlement receipts, not
// claimed CPU work, wallet turnover or a public-anchor signature. Tariffs below
// are prospective certified inputs, not a declaration of calibrated live rates.
import assert from 'node:assert/strict';
import {cloneSubsidy,economicRecordTotals,economicAuditEntries} from './economic-record-view.mjs';
import {rewardRegistryTotals,rewardRegistryChanges} from './reward-registry-view.mjs';
import {supportIssued} from './support-accounting.mjs';
import {controllerContext,copyControllerState} from './controller-context.mjs';
import {PAID_ADMISSION,auditPaidAdmissionHead,paidAdmissionView} from './paid-admission-view.mjs';
import {exact,hash,hex,integer,verify} from './crypto.mjs';
import {amount,policy as paymentPolicy} from './payment-model.mjs';
import {validatorQuorum} from './authority.mjs';
import {developmentManager} from './reserve-recovery.mjs';
import {effectiveWorkGroup} from './payment-liability.mjs';
import {paymentWorkUnits,WORK_UNITS} from './reward-work-budget.mjs';
import {anniversary,datedAllowance} from './economic-policy-v2.mjs';
import {centuryBudgetFromLedger} from './century-accounting.mjs';
import {centuryIssued,centuryOrdinaryIssued} from './century-issuance.mjs';
import {ECONOMIC_POLICY_VERSION_V4} from './economic-policy-v3.mjs';
import {validateHomePolicy,homeOwners,initialCenturyHome,sampleCenturyHome,reserveHomeFees,cappedCredits,homeCosts,auditCenturyHome} from './century-home.mjs';
export const CENTURY_SUBSIDY_ACTION='OPEN_CENTURY_SUBSIDY_V1';
export const CENTURY_SERVICE='accepted_programme_settlement_receipts_v1';
export const CENTURY_POLICY_ACTIONS=['SCHEDULE_CENTURY_POLICY_V1','CANCEL_CENTURY_POLICY_V1'];
export const CENTURY_POLICY_NOTICE=86400;
const min=(...xs)=>xs.reduce((a,b)=>a<b?a:b);
const sum=xs=>xs.reduce((a,b)=>a+amount(b),0n);
function policy(p){
 exact(p,['service','intervalSeconds','costPerPaymentMicro','intervalCapMicro','nodeCapMicro','groupCapMicro','maxPayments',...(p.home?['home']:[]),...(p.workers?['workers']:[]),...(p.admission?['admission']:[])]);
 assert.equal(p.service,CENTURY_SERVICE);
 for(const k of ['costPerPaymentMicro','intervalCapMicro','nodeCapMicro','groupCapMicro'])amount(p[k]);
 assert(amount(p.nodeCapMicro)<=amount(p.groupCapMicro));assert(amount(p.groupCapMicro)<=amount(p.intervalCapMicro));
 integer(p.maxPayments,1);assert(p.maxPayments<=256);
 integer(p.intervalSeconds,1);assert(p.intervalSeconds<=86400);
 if(p.home)validateHomePolicy(p.home,p.intervalSeconds);
 if(p.admission){assert.equal(p.admission,PAID_ADMISSION);assert(!p.workers,'indexed admission replaces the inline roster');}
 if(p.workers){assert(Array.isArray(p.workers)&&p.workers.length>0&&p.workers.length<=128);assert.equal(new Set(p.workers).size,p.workers.length);for(const id of p.workers)hex(id);}
}
export function centuryOwnerSnapshot(s,p){
 if(p.admission){assert.equal(p.admission,PAID_ADMISSION);return auditPaidAdmissionHead(controllerContext(s)?.paidAdmissionHead?.()??paidAdmissionView(s));}
 // An explicitly admitted roster needs only keyed reads, even in a sparse view.
 // Preserve canonical ordering and the legacy unscoped policy interpretation.
 if(p.workers)for(const id of p.workers)assert(s.money.nodes[id]&&s.rewards.nodes[id]?.kind==='worker','registered paid worker required');
 const ctx=controllerContext(s);
 // An unscoped policy cannot fit its existing 128-owner contract in a larger
 // population. Reject before touching any worker, rather than scanning first.
 if(!p.workers&&ctx){assert(ctx.workerCount<=128,'explicit paid roster required above 128 workers');assert(!ctx.rewardEnrollmentPending?.(),'reward enrollment still in progress');}
 const ids=p.workers?[...p.workers].sort():(ctx?.workerIds(128)??Object.keys(s.money.nodes).sort());
 return Object.fromEntries(ids.filter(id=>s.rewards.nodes[id]?.kind==='worker').map(id=>[id,effectiveWorkGroup(s.money,id)]));
}
const ownerSnapshot=centuryOwnerSnapshot;
function boundedPolicyChange(old,next){
 if(old.admission)assert.equal(next.admission,old.admission,'cannot restore an inline admission ceiling');
 policy(next);assert.equal(next.service,old.service);assert.equal(next.intervalSeconds,old.intervalSeconds,'interval duration is immutable');assert.equal(Boolean(next.home),Boolean(old.home),'Home service mode is immutable; use an empty roster to pause');
 const rise=(a,b)=>{a=BigInt(a);b=BigInt(b);assert(b<=a+(a/10n||1n),'policy increase exceeds ten percent per daily step');};
 for(const key of ['costPerPaymentMicro','intervalCapMicro','nodeCapMicro','groupCapMicro','maxPayments'])rise(old[key],next[key]);
 if(old.home){if(old.home.admission)assert.equal(next.home.admission,old.home.admission,'cannot restore inline Home admission');if(next.home.admission)rise(old.home.sampleSize??Object.keys(old.home.nodes).length,next.home.sampleSize);if(old.home.version==='DUEBYTE_HOME_RECORD_AVAILABILITY_V1')assert.equal(next.home.version,old.home.version,'cannot downgrade authenticated Home service');rise(old.home.costPerSampleMicro,next.home.costPerSampleMicro);assert(next.home.feeSharePPM<=old.home.feeSharePPM+10000,'Home fee share rise exceeds one percentage point');}
}
export function applyCenturyPolicy(base,a,c){
 exact(a,['type','certificate','founderConsent']);assert(CENTURY_POLICY_ACTIONS.includes(a.type));exact(a.certificate,['body','approvals']);const b=a.certificate.body,book=base.centurySubsidy;assert(book,'subsidy must be prepared');
 const schedule=a.type===CENTURY_POLICY_ACTIONS[0];exact(b,['domain','network','configHash','generation','notBefore','expires','planHash','managementEpoch','sequence','previousPolicyHash',...(schedule?['effectiveFrom','policy','reason']:['proposalHash'])]);
 assert.equal(b.domain,a.type);assert.equal(b.network,c.chainId);assert.equal(b.configHash,base.configHash);assert.equal(b.generation,base.authority.generation);assert.equal(b.planHash,book.planHash);
 const access=base.networkReserves.development.access;assert(access&&!access.pending,'stable policy management required');assert.equal(b.managementEpoch,access.epoch);
 integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.expires-b.notBefore<=100&&base.height>=b.notBefore&&base.height<=b.expires,'policy inclusion window');validatorQuorum(b,a.certificate.approvals,base.authority.validators);assert(verify(b,a.founderConsent,developmentManager(base.networkReserves)),'founder policy consent');
 const digest=hash(a.certificate),old=book.policyControl;if(old?.lastActionHash===digest)return base;
 assert.equal(b.previousPolicyHash,hash(book.policy),'stale policy base');assert.equal(b.sequence,(old?.sequence??0)+1,'policy sequence');
 const s=copyControllerState(base,['centurySubsidy']),r=s.centurySubsidy,ctl=r.policyControl??={version:1,revision:1,sequence:0,lastActivatedAt:book.start,lastActionHash:null,history:hash({domain:'DUEBYTE_CENTURY_POLICY_V1',policy:book.policy}),lastStatementPolicy:structuredClone(book.policy),pending:null};
 if(schedule){
  assert(!ctl.pending,'cancel existing proposal first');boundedPolicyChange(book.policy,b.policy);assert.notEqual(hash(b.policy),hash(book.policy),'policy unchanged');
  integer(b.effectiveFrom,1);assert(b.effectiveFrom>=Math.max(base.money.time+CENTURY_POLICY_NOTICE,book.cursor,ctl.lastActivatedAt+CENTURY_POLICY_NOTICE),'prospective daily policy notice');
  assert(b.effectiveFrom<=base.money.time+30*CENTURY_POLICY_NOTICE,'bounded policy notice');
  assert(typeof b.reason==='string'&&b.reason.trim().length>0&&b.reason.length<=512&&!/[\u0000-\u001f]/.test(b.reason),'public policy reason');ownerSnapshot(base,b.policy);if(b.policy.home)homeOwners(base,b.policy.home);
  ctl.pending={effectiveFrom:b.effectiveFrom,policy:structuredClone(b.policy),managementEpoch:b.managementEpoch,scheduledAt:base.money.time,proposalHash:digest,reason:b.reason};
 }else{assert(ctl.pending&&b.proposalHash===ctl.pending.proposalHash,'current proposal required');ctl.pending=null;}
 ctl.sequence=b.sequence;ctl.lastActionHash=digest;ctl.history=hash({previous:ctl.history,action:digest});auditCenturySubsidy(s);return s;
}
export function applyCenturySubsidy(base,action,c){
 assert(!base.centuryFunds?.zeroStage,'pilot requires separate post-pilot authorization');
 exact(action,['type','certificate','founderConsent']);assert.equal(action.type,CENTURY_SUBSIDY_ACTION);
 exact(action.certificate,['body','approvals']);const b=action.certificate.body;
 exact(b,['domain','network','configHash','generation','notBefore','expires','planHash','sequence','start','from','to','policy','ownersHash']);
 assert.equal(b.domain,CENTURY_SUBSIDY_ACTION);assert.equal(b.network,c.chainId);assert.equal(b.configHash,base.configHash);
 assert.equal(b.generation,base.authority.generation);assert(base.centuryFees&&base.rewards,'century receipt accounting required');
 assert.equal(base.money.unitScale,'1000000');assert.equal(b.planHash,base.economicPreparation.planHash);
 integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.expires-b.notBefore<=100&&base.height>=b.notBefore&&base.height<=b.expires,'subsidy inclusion window');
 validatorQuorum(b,action.certificate.approvals,base.authority.validators);
 assert(verify(b,action.founderConsent,developmentManager(base.networkReserves)),'founder subsidy consent');
 const certificateHash=hash(action.certificate),old=base.centurySubsidy;
 if(old?.certificateHash===certificateHash)return base;
 integer(b.start,1);integer(b.from,b.start);integer(b.to,b.from+1);
 if(base.centuryFunds?.support)assert(b.from>=base.centuryFunds.support.to,'support interval already consumed');
 if(base.economicPreparation.plan.version===ECONOMIC_POLICY_VERSION_V4)assert.equal(b.start,base.centuryFunds?.execution?.start,'authorized emission clock required');
 assert(b.to-b.from<=86400&&b.to<=anniversary(b.start,100),'bounded century interval');
 assert(b.from>=base.money.time&&b.from-base.money.time<=300,'prospective subsidy interval');policy(b.policy);
 assert.equal(b.to-b.from,b.policy.intervalSeconds,'fixed tariff interval');
 const owners=ownerSnapshot(base,b.policy);assert.equal(b.ownersHash,hash(owners),'current owner groups');
 if(b.policy.home)homeOwners(base,b.policy.home);
 if(!b.policy.admission)assert(Object.keys(owners).length>0&&Object.keys(owners).length<=128);
 const change=old?.policyControl?.pending,due=change&&b.from>=change.effectiveFrom;
 if(old){assert(!old.pending,'previous subsidy interval still open');assert.equal(b.sequence,old.sequence+1);assert.equal(b.start,old.start);assert(b.from>=old.cursor,'no reused or catchup interval');assert.deepEqual(b.policy,due?change.policy:old.policy,'candidate tariff immutable without effective certified proposal');if(change&&!due)assert(b.to<=change.effectiveFrom,'old interval crosses policy boundary');if(due){const access=base.networkReserves.development.access;assert(access&&!access.pending&&access.epoch===change.managementEpoch,'scheduled policy custody changed');assert(base.money.time>=change.effectiveFrom,'policy notice not complete');}}
 else {assert.equal(b.sequence,1);if(!base.centuryFunds?.execution)assert.equal(b.from,b.start);assert.equal(base.rewards.minted,'0');}
 const s=copyControllerState(base,['centurySubsidy']);
 s.centurySubsidy={...(old?cloneSubsidy(old):{version:CENTURY_SUBSIDY_ACTION,planHash:b.planHash,start:b.start,policy:structuredClone(b.policy),totalMintedMicro:'0',earned:{},history:hash({domain:CENTURY_SUBSIDY_ACTION,configHash:base.configHash}),last:null,...(b.policy.home?{homeFeesEarned:{}}:{})}),
  sequence:b.sequence,cursor:b.to,certificateHash,pending:{from:b.from,to:b.to,...(b.policy.admission?{admission:owners,owners:{}}:{owners}),receipts:{},work:{},feesMicro:'0',...(b.policy.home?{home:initialCenturyHome(s,b.policy.home,b.from,b.sequence)}:{})}};
 // Do not share control/history objects with the caller's prior committed state.
 if(old?.policyControl)s.centurySubsidy.policyControl=structuredClone(old.policyControl);
 if(due){const r=s.centurySubsidy,ctl=r.policyControl;r.policy=structuredClone(change.policy);ctl.revision++;ctl.lastActivatedAt=base.money.time;ctl.history=hash({previous:ctl.history,applied:change.proposalHash,interval:b.sequence});ctl.pending=null;}
 auditCenturySubsidy(s);return s;
}
// Called only after the monetary interpreter accepted a NEW settled payment.
// All parts and network-bound worker signatures have already been checked there.
export function recordCenturySubsidy(s,request){
 const book=s.centurySubsidy,p=book?.pending;if(!p||s.money.time<p.from||s.money.time>=p.to)return;
 // Ordinary self-transfers are not accepted external demand. Only the protected
 // network programme can supply this candidate service until a separate external
 // demand admission contract has been qualified. No wallet can create its jobs.
 const programme=s.centuryWarmup?.pending;
 if(!programme||programme.pid!==request.intent.pid||programme.intentHash!==request.digest)return;
 if(Object.hasOwn(p.receipts,request.intent.pid))return;
 if(Object.keys(p.receipts).length>=book.policy.maxPayments)return;
 const units=paymentWorkUnits(request.intent);
 if(book.policy.admission){
  // The existing programme creates exactly one part with three independent
  // assignments. Thus accepted work is bounded by maxPayments * copies, not
  // by the total population admitted to the service. Never broaden this
  // service silently to arbitrary multi-part payments.
  assert.equal(request.intent.parts.length,1,'indexed programme receipt shape');
  assert(Object.keys(units).length<=paymentPolicy.copies);
  const ctx=controllerContext(s);assert(ctx?.paidAdmissionAt,'indexed admission reader required');const owners={};
  for(const id of Object.keys(units)){const a=ctx.paidAdmissionAt(id,p.from);if(!a||a.group!==effectiveWorkGroup(s.money,id))return;owners[id]=a.group;if(Object.hasOwn(p.owners,id))assert.equal(p.owners[id],a.group);}
  Object.assign(p.owners,owners);
 }else if(Object.keys(units).some(id=>!Object.hasOwn(p.owners,id)))return;
 assert.equal(request.status,'SETTLED');assert.equal(request.digest,hash(request.intent));
 assert.equal(request.intent.unitScale,'1000000','fractional receipt required');
 // No volume multiplier: one complete accepted receipt set has fixed units.
 assert.equal(sum(Object.values(units)),WORK_UNITS*BigInt(paymentPolicy.copies));
 p.receipts[request.intent.pid]=request.digest;
 for(const [id,n]of Object.entries(units))p.work[id]=String(amount(p.work[id]??'0')+amount(n));
 p.feesMicro=String(amount(p.feesMicro)+amount(request.intent.fee));
 reserveHomeFees(s,request.intent.fee);
}
function budget(s,p){
 const b=s.centurySubsidy,e=s.economicPreparation.plan;
 return centuryBudgetFromLedger(s,{calendar:{start:b.start,from:p.from,to:p.to,existingSupplyMicro:e.existingSupplyMicro},
  futureFixedReservedMicro:String(sum([e.warmupMicro,e.developmentMicro,e.founderMicro])-centuryOrdinaryIssued(s)),
  lifetimeRemainingMicro:String(amount(e.regularMicro)-amount(b.totalMintedMicro)-supportIssued(s)),operationalCapMicro:b.policy.intervalCapMicro,
  ordinaryCostMicro:String(BigInt(Object.keys(p.receipts).length)*amount(b.policy.costPerPaymentMicro)+Object.values(homeCosts(s)).reduce((a,v)=>a+v,0n)),ordinaryFeesMicro:p.feesMicro,
  renewalCostMicro:'0',renewalFeesMicro:'0',renewalQualified:false});
}
export function advanceCenturySubsidy(s){
 const b=s.centurySubsidy,p=b?.pending;if(!p)return;sampleCenturyHome(s);if(s.money.time<p.to)return;
 const owners={...p.owners,...(b.policy.home?homeOwners(s,b.policy.home):{})},costs=homeCosts(s),homeTotal=Object.values(costs).reduce((a,v)=>a+v,0n),pool=BigInt(p.home?.poolMicro??'0');
 const feeRaw=Object.fromEntries(Object.entries(costs).map(([id,c])=>[id,homeTotal?min(pool,homeTotal)*c/homeTotal:0n]));
 const homeFees=cappedCredits(feeRaw,owners,b.policy.nodeCapMicro,b.policy.groupCapMicro),paidHomeFees=Object.values(homeFees).reduce((a,v)=>a+v,0n);
 const limits=budget(s,p),available=amount(limits.maximumMicro),W=sum(Object.values(p.work))||1n;
 const serverCost=BigInt(Object.keys(p.receipts).length)*amount(b.policy.costPerPaymentMicro),serverFees=amount(p.feesMicro)-paidHomeFees;
 const serverGap=serverCost>serverFees?serverCost-serverFees:0n;
 const weights=Object.fromEntries(Object.entries(p.work).map(([id,w])=>[id,amount(w)*serverGap]));
 for(const [id,cost]of Object.entries(costs))weights[id]=(cost-(homeFees[id]??0n))*W;
 const totalWeight=Object.values(weights).reduce((a,v)=>a+v,0n);
 const raw=Object.fromEntries(Object.entries(weights).map(([id,w])=>[id,totalWeight?available*w/totalWeight:0n]));
 const bounded=cappedCredits(raw,owners,b.policy.nodeCapMicro,b.policy.groupCapMicro,homeFees),credits={};let issued=0n;
 for(const [id,value]of Object.entries(bounded)){
  credits[id]=String(value);issued+=value;
  b.earned[id]=String(amount(b.earned[id]??'0')+value);
  s.rewards.nodes[id].earned=String(amount(s.rewards.nodes[id].earned)+value);
 }
 if(p.home){
  for(const [id,v]of Object.entries(homeFees)){b.homeFeesEarned[id]=String(amount(b.homeFeesEarned[id]??'0')+v);s.rewards.nodes[id].earned=String(amount(s.rewards.nodes[id].earned)+v);}
  s.rewards.carry=String(amount(s.rewards.carry)+pool-paidHomeFees);
 }
 // Dust, unclaimed capacity, renewal allowances and skipped intervals stay
 // unissued. They cannot be reassigned or requested again after this close.
 b.totalMintedMicro=String(amount(b.totalMintedMicro)+issued);
 s.rewards.minted=String(amount(s.rewards.minted)+issued);
 s.money.supply=String(amount(s.money.supply)+issued);s.money.fees=String(amount(s.money.fees)+issued);
 b.last={sequence:b.sequence,from:p.from,to:p.to,receiptsHash:hash(p.receipts),payments:Object.keys(p.receipts).length,feesMicro:p.feesMicro,
  maximumMicro:limits.maximumMicro,mintedMicro:String(issued),credits,externalDemandProven:false,renewalPaidMicro:'0',...(p.home?{home:{sampleHash:hash(p.home.sample),accepted:Object.keys(costs).length,feeCredits:Object.fromEntries(Object.entries(homeFees).map(([id,v])=>[id,String(v)])),returnedFeeMicro:String(pool-paidHomeFees)}}:{})};
 b.history=hash({previous:b.history,statement:b.last});b.pending=null;
 if(b.policyControl)b.policyControl.lastStatementPolicy=structuredClone(b.policy);
 auditCenturySubsidy(s);
}
export function auditCenturySubsidy(s){
 const b=s.centurySubsidy;if(!b)return;
 assert(s.centuryFees&&s.rewards&&s.economicPreparation,'subsidy requires prepared receipt ledger');
 exact(b,['version','planHash','start','policy','totalMintedMicro','earned','history','last','sequence','cursor','certificateHash','pending',...(b.policy.home?['homeFeesEarned']:[]),...(b.policyControl?['policyControl']:[])]);
 assert.equal(b.version,CENTURY_SUBSIDY_ACTION);assert.equal(b.planHash,s.economicPreparation.planHash);
 assert.equal(s.money.unitScale,'1000000');integer(b.start,1);integer(b.cursor,b.start+1);integer(b.sequence,1);policy(b.policy);hex(b.history);hex(b.certificateHash);
 const e=s.economicPreparation.plan,total=amount(b.totalMintedMicro);assert(total+supportIssued(s)<=amount(e.regularMicro));
 assert.equal(s.rewards.minted,b.totalMintedMicro,'single century mint ledger');
 assert.equal(amount(s.money.supply),amount(e.existingSupplyMicro)+total+centuryIssued(s)+supportIssued(s),'frozen supply plus authorized subsidy and funds');
 assert.equal(economicRecordTotals(b.earned)?.total??sum(Object.values(b.earned)),total);
 assert(total+supportIssued(s)<=amount(datedAllowance({start:b.start,from:b.start,to:Math.max(b.start,Math.min(s.money.time,b.cursor)),existingSupplyMicro:e.existingSupplyMicro,kind:'regular'})));
 assert(amount(s.money.supply)-(s.economicPreparation.memorial.issued?amount(e.memorialMicro):0n)+sum([e.warmupMicro,e.developmentMicro,e.founderMicro])-centuryOrdinaryIssued(s)<=amount(e.programmeCapMicro));
 const changedRewards=rewardRegistryTotals(s.rewards.nodes)?[...rewardRegistryChanges(s.rewards.nodes).keys()]:[];
 for(const [id,value]of economicAuditEntries(b.earned,changedRewards)){hex(id);assert(s.rewards.nodes[id]?.kind==='worker'||(b.policyControl||b.policy.home?.admission?s.rewards.nodes[id]?.kind==='witness':Object.hasOwn(b.policy.home?.nodes??{},id)));assert(amount(value)<=amount(s.rewards.nodes[id].earned));}
 if(b.policyControl){const ctl=b.policyControl;exact(ctl,['version','revision','sequence','lastActivatedAt','lastActionHash','history','lastStatementPolicy','pending']);assert.equal(ctl.version,1);integer(ctl.revision,1);integer(ctl.sequence,1);assert(ctl.revision<=ctl.sequence+1);integer(ctl.lastActivatedAt,b.start);assert(ctl.lastActivatedAt<=s.money.time);hex(ctl.lastActionHash);hex(ctl.history);policy(ctl.lastStatementPolicy);
  if(ctl.pending){const p=ctl.pending;exact(p,['effectiveFrom','policy','managementEpoch','scheduledAt','proposalHash','reason']);integer(p.scheduledAt,b.start);assert(p.scheduledAt<=s.money.time);integer(p.effectiveFrom,p.scheduledAt+CENTURY_POLICY_NOTICE);assert(p.effectiveFrom>=ctl.lastActivatedAt+CENTURY_POLICY_NOTICE);assert(p.effectiveFrom<=p.scheduledAt+30*CENTURY_POLICY_NOTICE);if(b.pending)assert(b.pending.to<=p.effectiveFrom);integer(p.managementEpoch);hex(p.proposalHash);assert(typeof p.reason==='string'&&p.reason.trim().length>0&&p.reason.length<=512);boundedPolicyChange(b.policy,p.policy);}
 }
 auditCenturyHome(s);
 if(b.pending){const p=b.pending;exact(p,['from','to','owners','receipts','work','feesMicro',...(b.policy.home?['home']:[]),...(b.policy.admission?['admission']:[])]);integer(p.from,b.start);integer(p.to,p.from+1);assert.equal(p.to,b.cursor);assert(p.to-p.from<=86400);amount(p.feesMicro);
  if(b.policy.admission){auditPaidAdmissionHead(p.admission);assert.deepEqual(Object.keys(p.owners).sort(),Object.keys(p.work).sort());}
  assert.equal(p.to-p.from,b.policy.intervalSeconds);assert(Object.keys(p.owners).length<=(b.policy.admission?b.policy.maxPayments*paymentPolicy.copies:128));for(const [id,g]of Object.entries(p.owners)){hex(id);assert(typeof g==='string'&&g.length>0&&g.length<=256);assert(s.rewards.nodes[id]?.kind==='worker');}
  assert(Object.keys(p.receipts).length<=b.policy.maxPayments);for(const [id,digest]of Object.entries(p.receipts)){hex(id);hex(digest);}
  assert.equal(sum(Object.values(p.work)),BigInt(Object.keys(p.receipts).length)*WORK_UNITS*BigInt(paymentPolicy.copies));for(const [id,v]of Object.entries(p.work)){assert(Object.hasOwn(p.owners,id));amount(v);}
 }
 if(b.last){const l=b.last,lp=b.policyControl?.lastStatementPolicy??b.policy;exact(l,['sequence','from','to','receiptsHash','payments','feesMicro','maximumMicro','mintedMicro','credits','externalDemandProven','renewalPaidMicro',...(lp.home?['home']:[])]);
  integer(l.sequence,1);assert(l.sequence<=b.sequence);integer(l.from,b.start);integer(l.to,l.from+1);assert(l.to<=s.money.time);hex(l.receiptsHash);integer(l.payments);assert(l.payments<=lp.maxPayments);amount(l.feesMicro);
  assert.equal(l.externalDemandProven,false);assert.equal(l.renewalPaidMicro,'0');assert.equal(sum(Object.values(l.credits)),amount(l.mintedMicro));assert(amount(l.mintedMicro)<=amount(l.maximumMicro)&&amount(l.maximumMicro)<=amount(lp.intervalCapMicro));
  if(l.home){exact(l.home,['sampleHash','accepted','feeCredits','returnedFeeMicro']);hex(l.home.sampleHash);integer(l.home.accepted);assert(l.home.accepted<=32);amount(l.home.returnedFeeMicro);for(const [id,v]of Object.entries(l.home.feeCredits)){assert(lp.home.admission?s.rewards.nodes[id]?.kind==='witness':Object.hasOwn(lp.home.nodes,id));amount(v);}}
 }
}
