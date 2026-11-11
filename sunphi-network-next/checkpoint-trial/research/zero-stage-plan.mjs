// Unsigned preparation only. No RPC, private keys, mint or transaction dispatch.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer} from '../crypto.mjs';
import {amount,feeFor} from '../payment-model.mjs';
import {bootstrapFundingProposal} from './bootstrap-funding-proposal.mjs';
import {datedCumulative} from '../economic-policy-v2.mjs';
import {centuryWarmupAccounts} from '../economic-policy-v3.mjs';
export const ZERO_STAGE_DEFAULTS=Object.freeze({durationSeconds:604800,spacingSeconds:600,
 paymentMicro:'50000',warmupTrancheMicro:'10000000',consensusReserveMicro:'1000000',
 ttlSeconds:120,challengeSeconds:86400,maxOpen:256,maxAssignments:768});
export function zeroStageProposal(q){
 exact(q,['configHash','root','height','workers','settings']);
 const support=bootstrapFundingProposal(qWithoutSettings(q)),p=q.settings;
 exact(p,Object.keys(ZERO_STAGE_DEFAULTS));
 integer(p.durationSeconds,1);assert(p.durationSeconds<=7*86400,'pilot duration ceiling');
 integer(p.spacingSeconds,10);integer(p.ttlSeconds,40);assert(p.ttlSeconds<p.spacingSeconds,'one pending payment per slot');
 integer(p.challengeSeconds,20);assert(p.challengeSeconds<=100000);
 integer(p.maxOpen,1);assert(p.maxOpen<=256);integer(p.maxAssignments,3);assert(p.maxAssignments<=768);
 const value=amount(p.paymentMicro),fund=amount(p.warmupTrancheMicro),reserve=amount(p.consensusReserveMicro);
 assert(value>0n&&fund>0n&&fund<=10000000n,'small pilot funding ceiling');
 const count=Math.ceil(p.durationSeconds/p.spacingSeconds),fee=feeFor(p.paymentMicro);
 // Include a conservative boundary slot and the full payment timeout, not just
 // the nominal settlement time. No assumption of fair worker rotation.
 const retained=1+Math.ceil((p.ttlSeconds+p.challengeSeconds)/p.spacingSeconds);
 assert(retained<=p.maxOpen&&3*retained<=p.maxAssignments,'liability retention capacity');
 const exposure=value*BigInt(retained),required=reserve+exposure;
 assert(reserve>0n&&support.body.roster.length>=3);
 assert(support.body.roster.every(n=>required<=amount(n.lockedSupportMicro)),'worst-case worker collateral');
 const feeBudget=fee*BigInt(count);assert(fund>=feeBudget+value+fee,'principal and fees must be separately covered');
 const body={domain:'DUEBYTE_ZERO_STAGE_PROPOSAL_V1',configHash:q.configHash,
  observedRoot:q.root,observedHeight:q.height,supportProposalHash:support.proposalHash,
  settings:{...p},supportMicro:support.body.totalMicro,warmupTrancheMicro:p.warmupTrancheMicro,
  totalInitialMicro:String(amount(support.body.totalMicro)+fund),
  accounts:centuryWarmupAccounts(q.configHash),fundingSources:{support:'REGULAR_ISSUANCE_ALLOWANCE',warmup:'DEDUCT_FROM_APPROVED_10M_WARMUP'},
  maximumPayments:count,feePerPaymentMicro:String(fee),maximumFeesMicro:String(feeBudget),
  remainingWarmupMicro:String(fund-feeBudget),retainedRecords:retained,retainedAssignments:3*retained,
  worstCaseWorkerMicro:String(required),maximumInFlight:1,externalDemandMicro:'0',
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
