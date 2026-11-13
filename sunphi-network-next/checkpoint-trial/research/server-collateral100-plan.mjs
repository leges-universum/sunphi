// Unsigned preparation only, never a consensus action or issuance authorization.
import assert from 'node:assert/strict';
import {hash} from '../crypto.mjs';
import {bootstrapFundingProposal,INITIAL_COLLATERAL_MICRO} from './bootstrap-funding-proposal.mjs';
import {terminalCollateralCapacity} from './terminal-collateral-capacity.mjs';
import {FOUNDER_ADVANCE_MICRO,PERSONAL_COLLATERAL_MICRO,ONBOARDING_SUPPORT_MICRO} from '../founder-advance-policy.mjs';
export function serverCollateral100Plan(observation,now=Date.now()){
 assert(observation.passed&&!observation.issuance&&!observation.publicPurchasesEnabled);
 assert(Number.isSafeInteger(now));const at=Date.parse(observation.receivedAt);
 assert(Number.isFinite(at)&&now>=at&&now-at<=180000,'fresh proof-checked observation required');
 const m=observation.zeroStage;assert.equal(m.supplyMicro,'0');assert.equal(m.unitScale,'1000000');assert.equal(m.liability,null,'already admitted liability needs a separate prospective plan');
 assert.equal(observation.rootMatchedByValidators,10);
 const workers=m.workers.map(w=>{
  for(const field of ['stake','consensusHeld','taskHeld'])assert.equal(w[field],'0','preserve existing collateral');
  assert.equal(w.recipient,observation.seller);
  assert.deepEqual(observation.bindings.find(b=>b.node===w.node)?.payouts,[{wallet:w.recipient,weight:1}]);
  return Object.fromEntries(['node','key','operator','recipient'].map(k=>[k,w[k]]));
 });
 assert.equal(workers.length,10,'fixed founder advance requires ten recipients');
 const proposal=bootstrapFundingProposal({configHash:m.configHash,root:observation.root,height:observation.height,workers},ONBOARDING_SUPPORT_MICRO);
 const roster=proposal.body.roster.map(w=>({...w,totalCollateralMicro:INITIAL_COLLATERAL_MICRO,additionalInitialCollateralMicro:PERSONAL_COLLATERAL_MICRO}));
 const total=BigInt(roster.length)*BigInt(INITIAL_COLLATERAL_MICRO),bonus=BigInt(roster.length)*BigInt(ONBOARDING_SUPPORT_MICRO);
 const capacity=terminalCollateralCapacity({stakeMicro:'100000000',paymentMicro:'5000000',spacingSeconds:10});assert(capacity.covered&&capacity.recordsFit);
 const body={domain:'DUEBYTE_SERVER_COLLATERAL100_PLAN_V2',configHash:m.configHash,observedRoot:observation.root,observedHeight:observation.height,observedAt:observation.receivedAt,observationHash:hash(observation),
  ownerGroup:proposal.body.ownerGroup,roster,totalCollateralMicro:String(total),onboardingPremiumMicro:String(bonus),additionalInitialCollateralMicro:String(total-bonus),
  zeroStageBudgetMicro:'10000000000',unallocatedBudgetMicro:String(10000000000n-total),liabilityPolicyVersion:4,postTerminalHoldSeconds:0,
  fundingProposal:{onboarding:'REGULAR_ISSUANCE_ALLOWANCE_LOCKED_SUPPORT',additional:'EXISTING_FOUNDER_AWARD_EARLY_RELEASE',founderAdvanceMicro:FOUNDER_ADVANCE_MICRO,firstAnnualRemainderMicro:'999100000000',warmupFeePoolDebitMicro:'0',eligibilityYears:5,supportReturnPolicy:'ALGORITHMIC_POOL_NO_REMINT',personalReturnPolicy:'FUNDING_OWNER_AFTER_OBLIGATIONS',consents:'FUNDING_OWNER_AND_EACH_WORKER'},
  capacity:{paymentMicro:capacity.paymentMicro,spacingSeconds:capacity.spacingSeconds,timeoutSeconds:120,assumedOutstanding:capacity.maximumOutstanding,requiredWithReserveMicro:capacity.requiredWithReserveMicro}};
 return {body,planHash:hash(body),preparedOnly:true,issuanceAuthorized:false,readyForIssuance:false,signatures:[],
  remaining:['Recheck physical server inventory; logical workers do not prove independent hosts or owners','Qualify 10 support plus 90 owner collateral per node','Replace old signed pilot restrictions prospectively; current V1 pace and tranche are unchanged','Install compatible release and collect V4 validator/founder/worker consents','Check recovery and obtain explicit issuance/start authorization'],
  limitations:['No funds have been issued, transferred or pledged','Unallocated budget is not authorized for spending','Capacity is financial planning, not a measured throughput or liveness guarantee','Home premiums remain a separate admission and anti-duplication task']};
}
