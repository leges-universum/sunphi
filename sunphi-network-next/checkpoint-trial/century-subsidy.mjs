// Closed-admission century candidate: pay accepted settlement receipts, not
// claimed CPU work, wallet turnover or a public-anchor signature. Tariffs below
// are prospective certified inputs, not a declaration of calibrated live rates.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,verify} from './crypto.mjs';
import {amount,policy as paymentPolicy} from './payment-model.mjs';
import {quorum} from './authority.mjs';
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
const min=(...xs)=>xs.reduce((a,b)=>a<b?a:b);
const sum=xs=>xs.reduce((a,b)=>a+amount(b),0n);
function policy(p){
 exact(p,['service','intervalSeconds','costPerPaymentMicro','intervalCapMicro','nodeCapMicro','groupCapMicro','maxPayments',...(p.home?['home']:[])]);
 assert.equal(p.service,CENTURY_SERVICE);
 for(const k of ['costPerPaymentMicro','intervalCapMicro','nodeCapMicro','groupCapMicro'])amount(p[k]);
 assert(amount(p.nodeCapMicro)<=amount(p.groupCapMicro));assert(amount(p.groupCapMicro)<=amount(p.intervalCapMicro));
 integer(p.maxPayments,1);assert(p.maxPayments<=256);
 integer(p.intervalSeconds,1);assert(p.intervalSeconds<=86400);
 if(p.home)validateHomePolicy(p.home,p.intervalSeconds);
}
function ownerSnapshot(s){return Object.fromEntries(Object.keys(s.money.nodes).sort().filter(id=>s.rewards.nodes[id]?.kind==='worker').map(id=>[id,effectiveWorkGroup(s.money,id)]));}
export function applyCenturySubsidy(base,action,c){
 exact(action,['type','certificate','founderConsent']);assert.equal(action.type,CENTURY_SUBSIDY_ACTION);
 exact(action.certificate,['body','approvals']);const b=action.certificate.body;
 exact(b,['domain','network','configHash','generation','notBefore','expires','planHash','sequence','start','from','to','policy','ownersHash']);
 assert.equal(b.domain,CENTURY_SUBSIDY_ACTION);assert.equal(b.network,c.chainId);assert.equal(b.configHash,base.configHash);
 assert.equal(b.generation,base.authority.generation);assert(base.centuryFees&&base.rewards,'century receipt accounting required');
 assert.equal(base.money.unitScale,'1000000');assert.equal(b.planHash,base.economicPreparation.planHash);
 integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.expires-b.notBefore<=100&&base.height>=b.notBefore&&base.height<=b.expires,'subsidy inclusion window');
 quorum(b,action.certificate.approvals,base.authority.validators,7);
 assert(verify(b,action.founderConsent,developmentManager(base.networkReserves)),'founder subsidy consent');
 const certificateHash=hash(action.certificate),old=base.centurySubsidy;
 if(old?.certificateHash===certificateHash)return base;
 integer(b.start,1);integer(b.from,b.start);integer(b.to,b.from+1);
 if(base.economicPreparation.plan.version===ECONOMIC_POLICY_VERSION_V4)assert.equal(b.start,base.centuryFunds?.execution?.start,'authorized emission clock required');
 assert(b.to-b.from<=86400&&b.to<=anniversary(b.start,100),'bounded century interval');
 assert(b.from>=base.money.time&&b.from-base.money.time<=300,'prospective subsidy interval');policy(b.policy);
 assert.equal(b.to-b.from,b.policy.intervalSeconds,'fixed tariff interval');
 const owners=ownerSnapshot(base);assert.equal(b.ownersHash,hash(owners),'current owner groups');
 if(b.policy.home)homeOwners(base,b.policy.home);
 assert(Object.keys(owners).length>0&&Object.keys(owners).length<=128);
 if(old){assert(!old.pending,'previous subsidy interval still open');assert.equal(b.sequence,old.sequence+1);assert.equal(b.start,old.start);assert(b.from>=old.cursor,'no reused or catchup interval');assert.deepEqual(b.policy,old.policy,'candidate tariff immutable');}
 else {assert.equal(b.sequence,1);if(!base.centuryFunds?.execution)assert.equal(b.from,b.start);assert.equal(base.rewards.minted,'0');}
 const s=structuredClone(base);
 s.centurySubsidy={...(old??{version:CENTURY_SUBSIDY_ACTION,planHash:b.planHash,start:b.start,policy:b.policy,totalMintedMicro:'0',earned:{},history:hash({domain:CENTURY_SUBSIDY_ACTION,configHash:base.configHash}),last:null,...(b.policy.home?{homeFeesEarned:{}}:{})}),
  sequence:b.sequence,cursor:b.to,certificateHash,pending:{from:b.from,to:b.to,owners,receipts:{},work:{},feesMicro:'0',...(b.policy.home?{home:initialCenturyHome()}:{})}};
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
 if(Object.keys(units).some(id=>!Object.hasOwn(p.owners,id)))return;
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
  lifetimeRemainingMicro:String(amount(e.regularMicro)-amount(b.totalMintedMicro)),operationalCapMicro:b.policy.intervalCapMicro,
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
 auditCenturySubsidy(s);
}
export function auditCenturySubsidy(s){
 const b=s.centurySubsidy;if(!b)return;
 assert(s.centuryFees&&s.rewards&&s.economicPreparation,'subsidy requires prepared receipt ledger');
 exact(b,['version','planHash','start','policy','totalMintedMicro','earned','history','last','sequence','cursor','certificateHash','pending',...(b.policy.home?['homeFeesEarned']:[])]);
 assert.equal(b.version,CENTURY_SUBSIDY_ACTION);assert.equal(b.planHash,s.economicPreparation.planHash);
 assert.equal(s.money.unitScale,'1000000');integer(b.start,1);integer(b.cursor,b.start+1);integer(b.sequence,1);policy(b.policy);hex(b.history);hex(b.certificateHash);
 const e=s.economicPreparation.plan,total=amount(b.totalMintedMicro);assert(total<=amount(e.regularMicro));
 assert.equal(s.rewards.minted,b.totalMintedMicro,'single century mint ledger');
 assert.equal(amount(s.money.supply),amount(e.existingSupplyMicro)+total+centuryIssued(s),'frozen supply plus authorized subsidy and funds');
 assert.equal(sum(Object.values(b.earned)),total);
 assert(total<=amount(datedAllowance({start:b.start,from:b.start,to:Math.max(b.start,Math.min(s.money.time,b.cursor)),existingSupplyMicro:e.existingSupplyMicro,kind:'regular'})));
 assert(amount(s.money.supply)-(e&&s.centuryFunds?.execution?amount(e.memorialMicro):0n)+sum([e.warmupMicro,e.developmentMicro,e.founderMicro])-centuryOrdinaryIssued(s)<=amount(e.programmeCapMicro));
 for(const [id,value]of Object.entries(b.earned)){hex(id);assert(s.rewards.nodes[id]?.kind==='worker'||Object.hasOwn(b.policy.home?.nodes??{},id));assert(amount(value)<=amount(s.rewards.nodes[id].earned));}
 auditCenturyHome(s);
 if(b.pending){const p=b.pending;exact(p,['from','to','owners','receipts','work','feesMicro',...(b.policy.home?['home']:[])]);integer(p.from,b.start);integer(p.to,p.from+1);assert.equal(p.to,b.cursor);assert(p.to-p.from<=86400);amount(p.feesMicro);
  assert.equal(p.to-p.from,b.policy.intervalSeconds);assert(Object.keys(p.owners).length<=128);for(const [id,g]of Object.entries(p.owners)){hex(id);assert(typeof g==='string'&&g.length>0&&g.length<=256);assert(s.rewards.nodes[id]?.kind==='worker');}
  assert(Object.keys(p.receipts).length<=b.policy.maxPayments);for(const [id,digest]of Object.entries(p.receipts)){hex(id);hex(digest);}
  assert.equal(sum(Object.values(p.work)),BigInt(Object.keys(p.receipts).length)*WORK_UNITS*BigInt(paymentPolicy.copies));for(const [id,v]of Object.entries(p.work)){assert(Object.hasOwn(p.owners,id));amount(v);}
 }
 if(b.last){const l=b.last;exact(l,['sequence','from','to','receiptsHash','payments','feesMicro','maximumMicro','mintedMicro','credits','externalDemandProven','renewalPaidMicro',...(b.policy.home?['home']:[])]);
  integer(l.sequence,1);assert(l.sequence<=b.sequence);integer(l.from,b.start);integer(l.to,l.from+1);assert(l.to<=s.money.time);hex(l.receiptsHash);integer(l.payments);assert(l.payments<=b.policy.maxPayments);amount(l.feesMicro);
  assert.equal(l.externalDemandProven,false);assert.equal(l.renewalPaidMicro,'0');assert.equal(sum(Object.values(l.credits)),amount(l.mintedMicro));assert(amount(l.mintedMicro)<=amount(l.maximumMicro)&&amount(l.maximumMicro)<=amount(b.policy.intervalCapMicro));
  if(l.home){exact(l.home,['sampleHash','accepted','feeCredits','returnedFeeMicro']);hex(l.home.sampleHash);integer(l.home.accepted);assert(l.home.accepted<=32);amount(l.home.returnedFeeMicro);for(const [id,v]of Object.entries(l.home.feeCredits)){assert(Object.hasOwn(b.policy.home.nodes,id));amount(v);}}
 }
}
