// Unsigned preparation only. No RPC, private keys, mint or transaction dispatch.
import assert from 'node:assert/strict';
import {INITIAL_TARIFF,checkTariff} from '../payment-tariff.mjs';
import {exact,hash,hex,integer} from '../crypto.mjs';
import {amount,feeFor} from '../payment-model.mjs';
import {bootstrapFundingProposal} from './bootstrap-funding-proposal.mjs';
import {datedCumulative} from '../economic-policy-v2.mjs';
import {centuryWarmupAccounts} from '../economic-policy-v3.mjs';
import {FOUNDER_ADVANCE_MICRO,PERSONAL_COLLATERAL_MICRO,ONBOARDING_SUPPORT_MICRO} from '../founder-advance-policy.mjs';
export const ZERO_STAGE_DEFAULTS=Object.freeze({feeSchedule:INITIAL_TARIFF,ramp:'CAUTIOUS_WEEK_V1',durationSeconds:604800,spacingSeconds:600,
 paymentMicro:'50000',warmupTrancheMicro:'10000000',consensusReserveMicro:'1000000',
 ttlSeconds:120,challengeSeconds:86400,maxOpen:256,maxAssignments:768});
export const ZERO_STAGE_TERMINAL_DEFAULTS=Object.freeze({...ZERO_STAGE_DEFAULTS,ramp:'TERMINAL_WEEK_V2',spacingSeconds:20,
 paymentMicro:'5000000',warmupTrancheMicro:'9000000000',challengeSeconds:0});
export const terminalPilot=p=>p.ramp==='TERMINAL_WEEK_V2';
export function zeroStageSchedule(p){
 assert(['CAUTIOUS_WEEK_V1','TERMINAL_WEEK_V2'].includes(p.ramp),'pilot ramp');
 integer(p.durationSeconds,1);assert(p.durationSeconds<=604800);integer(p.spacingSeconds,terminalPilot(p)?20:600);
 return [[0,86400,6],[86400,259200,3],[259200,604800,1]]
  .filter(([from])=>from<p.durationSeconds).map(([from,to,multiple])=>{
   to=Math.min(to,p.durationSeconds);const spacingSeconds=p.spacingSeconds*multiple;
   return {from,to,spacingSeconds,maximumPayments:Math.ceil((to-from)/spacingSeconds)};
  });
}
export function zeroStageSlot(p,elapsed){
 integer(elapsed);const phase=zeroStageSchedule(p).find(v=>elapsed>=v.from&&elapsed<v.to);
 assert(phase,'pilot UTC window');return {...phase,slot:Math.floor((elapsed-phase.from)/phase.spacingSeconds)};
}
export function zeroStageProposal(q){
 exact(q,['configHash','root','height','workers','settings']);
 const p=q.settings,terminal=terminalPilot(p),support=bootstrapFundingProposal(qWithoutSettings(q),ONBOARDING_SUPPORT_MICRO);
 exact(p,Object.keys(ZERO_STAGE_DEFAULTS));
 integer(p.durationSeconds,1);assert(p.durationSeconds<=7*86400,'pilot duration ceiling');
 integer(p.spacingSeconds,10);integer(p.ttlSeconds,40);if(!terminal)assert(p.ttlSeconds<p.spacingSeconds,'one pending payment per slot');
 if(terminal){assert.equal(p.challengeSeconds,0);assert(p.ttlSeconds<=120,'terminal pilot TTL ceiling');}else{integer(p.challengeSeconds,20);assert(p.challengeSeconds<=100000);}
 integer(p.maxOpen,1);assert(p.maxOpen<=256);integer(p.maxAssignments,3);assert(p.maxAssignments<=768);
 const value=amount(p.paymentMicro),fund=amount(p.warmupTrancheMicro),reserve=amount(p.consensusReserveMicro);
 const advance=terminal?amount(FOUNDER_ADVANCE_MICRO):0n;
 assert(value>0n&&fund>0n&&fund<=(terminal?10000000000n-amount(support.body.totalMicro)-advance:10000000n),'small pilot funding ceiling');
 const phases=zeroStageSchedule(p),count=phases.reduce((n,p)=>n+p.maximumPayments,0),fee=feeFor(p.paymentMicro,checkTariff(p.feeSchedule));
 // Include a conservative boundary slot and the full payment timeout, not just
 // the nominal settlement time. No assumption of fair worker rotation.
 const retained=1+Math.ceil((p.ttlSeconds+p.challengeSeconds+(terminal?20:0))/p.spacingSeconds);
 assert(retained<=p.maxOpen&&3*retained<=p.maxAssignments,'liability retention capacity');
 const exposure=value*BigInt(retained),required=reserve+exposure;
 assert(reserve>0n&&support.body.roster.length>=3);
 const collateral=n=>amount(n.lockedSupportMicro)+(terminal?amount(PERSONAL_COLLATERAL_MICRO):0n);
 assert(support.body.roster.every(n=>required<=collateral(n)),'worst-case worker collateral');
 if(terminal)assert(support.body.roster.every(n=>required*5n<=collateral(n)*4n),'pilot twenty-percent collateral margin');
 const feeBudget=fee*BigInt(count);assert(fund>=feeBudget+value+fee,'principal and fees must be separately covered');
 const body={domain:terminal?'DUEBYTE_ZERO_STAGE_PROPOSAL_V2':'DUEBYTE_ZERO_STAGE_PROPOSAL_V1',configHash:q.configHash,
  observedRoot:q.root,observedHeight:q.height,supportProposalHash:support.proposalHash,
  settings:{...p},phases,supportMicro:support.body.totalMicro,warmupTrancheMicro:p.warmupTrancheMicro,
  totalInitialMicro:String(amount(support.body.totalMicro)+fund+advance),
  ...(terminal?{founderAdvanceMicro:FOUNDER_ADVANCE_MICRO,personalCollateralPerWorkerMicro:PERSONAL_COLLATERAL_MICRO}:{}),
  accounts:centuryWarmupAccounts(q.configHash),fundingSources:{support:'REGULAR_ISSUANCE_ALLOWANCE',warmup:'DEDUCT_FROM_APPROVED_10M_WARMUP',...(terminal?{founder:'DEDUCT_FROM_EXISTING_FOUNDER_AWARD_FIRST_ANNUAL_RELEASE'}:{})},
  maximumPayments:count,feePerPaymentMicro:String(fee),maximumFeesMicro:String(feeBudget),
  remainingWarmupMicro:String(fund-feeBudget),retainedRecords:retained,retainedAssignments:3*retained,
  worstCaseWorkerMicro:String(required),maximumInFlight:terminal?retained:1,externalDemandMicro:'0',
  bonusEligibility:{years:5,startSource:'AUTHORIZED_WARMUP_CLOCK',oneTimePerNode:true,withdrawable:false,afterEnd:'NO_NEW_GRANTS_EXISTING_OBLIGATIONS_RETAINED'},
  emissionStart:null,warmupStart:null,issuanceAuthorized:false};
 return {preparedOnly:true,body,proposalHash:hash(body),support,
  blockers:['PARTIAL_WARMUP_TRANCHE_NOT_ADMITTED','LOCKED_SUPPORT_SHARED_ISSUANCE_ACCOUNTING_NOT_ADMITTED',
   'LIABILITY_CONSENTS_AND_COLLATERAL_COVERAGE_REQUIRED','SIGNED_BOUNDED_PILOT_ADMISSION_REQUIRED',
   'EXPLICIT_ISSUANCE_AMOUNT_AND_START_AUTHORIZATION_REQUIRED']};
}
function qWithoutSettings({configHash,root,height,workers}){return {configHash,root,height,workers};}
// Caller supplies verified observation only; this does not verify a certificate
// and is never itself admission authority. A changed root invalidates the review.
export function zeroStageReadiness(proposal,observation){
 const b=proposal.body;assert.equal(hash(b),proposal.proposalHash);
 exact(observation,['configHash','root','height','unitScale','supplyMicro','boundNodes','liabilityReady','coverageReady']);
 hex(observation.configHash);hex(observation.root);integer(observation.height,1);amount(observation.supplyMicro);
 for(const k of ['liabilityReady','coverageReady'])assert.equal(typeof observation[k],'boolean');
 assert(Array.isArray(observation.boundNodes));observation.boundNodes.forEach(hex);
 assert.equal(new Set(observation.boundNodes).size,observation.boundNodes.length);
 const reasons=[...proposal.blockers];
 if(observation.configHash!==b.configHash||observation.root!==b.observedRoot||observation.height!==b.observedHeight)reasons.push('REVIEW_STATE_CHANGED');
 if(observation.unitScale!=='1000000')reasons.push('PRECISION_NOT_READY');
 if(observation.supplyMicro==='0')reasons.push('NO_EXISTING_TOKENS_FOR_PURCHASE_OR_BOND');
 if(proposal.support.body.roster.some(n=>!observation.boundNodes.includes(n.node)))reasons.push('PAYOUT_BINDING_MISSING');
 if(!observation.liabilityReady)reasons.push('LIABILITY_NOT_READY');
 if(!observation.coverageReady)reasons.push('COVERAGE_NOT_READY');
 return {readyForIssuance:false,issuanceAuthorized:false,reasons};
}
// Bootstrap support and useful-work subsidy compete for ONE dated allowance.
// Recycled pool transfers must not decrement either lifetime issuance counter.
export function sharedRegularAllowance({start,at,existingSupplyMicro,supportIssuedMicro,subsidyIssuedMicro}){
 const ceiling=amount(datedCumulative({start,at,kind:'regular',existingSupplyMicro}));
 const support=amount(supportIssuedMicro),subsidy=amount(subsidyIssuedMicro);
 assert(support+subsidy<=ceiling,'shared regular issuance ceiling');
 return {calendarMicro:String(ceiling),consumedMicro:String(support+subsidy),remainingMicro:String(ceiling-support-subsidy),issuanceAuthorized:false};
}
