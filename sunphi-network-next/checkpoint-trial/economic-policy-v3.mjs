// Memorial-aware preparation. No mint, activation or monetary state mutation.
import assert from 'node:assert/strict';
import {makeEconomicPlan as ordinaryPlan, emissionBudget as ordinaryBudget, anniversary} from './economic-policy-v2.mjs';
import {CAP, UNIT} from './ecosystem-century-model.mjs';
import {hash} from './crypto.mjs';
export const ECONOMIC_POLICY_VERSION_V3 = 'DUEBYTE_ECONOMY_10001000000_CENTURY_V3';
export const MEMORIAL_MICRO = 1000000n * UNIT;
export const TOTAL_CAP_MICRO = CAP + MEMORIAL_MICRO;
export function memorialPolicy(configHash) {
  return {
    version: 'DUEBYTE_MEMORIAL_POLICY_V1', allocationMicro: String(MEMORIAL_MICRO),
    account: Buffer.from(hash({domain:'DUEBYTE_SATOSHI_MEMORIAL_ACCOUNT_V1',configHash}),'hex').toString('base64url'),
    beneficiary: 'Satoshi Nakamoto', issuance: 'ONCE_AT_EXPLICITLY_AUTHORIZED_LAUNCH',
    beneficiaryDefinition: 'THE_ORIGINAL_BITCOIN_CREATOR_OR_VERIFIED_ORIGINAL_COCREATOR_GROUP_USING_THE_SATOSHI_NAKAMOTO_PSEUDONYM',
    namesakeEligibility: false, nameOrAccountRegistrationSufficient: false,
    earlyKeyPossessionAloneSufficient: false, laterBitcoinContributionAloneSufficient: false,
    groupMembership: 'EACH_CLAIMANT_MUST_SUBSTANTIATE_ORIGINAL_GROUP_MEMBERSHIP',
    groupPayment: 'ONE_SHARED_ALLOCATION_WITH_VERIFIED_ENTITLEMENTS_AND_REPRESENTATION',
    unresolvedCompetingClaims: 'NO_TRANSFER_UNTIL_RESOLVED_UNDER_PUBLISHED_PROCEDURE_AND_APPLICABLE_LAW',
    ordinarySpending: false, founderOwnership: false, beneficiaryAcceptance: false,
    claim: 'VERIFIED_IDENTITY_UNDER_SEPARATELY_QUALIFIED_PUBLIC_PROCEDURE',
    museum: 'ELIGIBLE_AT_100TH_EMISSION_ANNIVERSARY_IF_NOT_TRANSFERRED',
    museumPurpose: 'CREATION_OR_DEVELOPMENT_OF_A_CRYPTOCURRENCY_HISTORY_MUSEUM',
    automaticMuseumTransfer: false, mutuallyExclusiveDestinations: true,
    succession: 'PUBLIC_AUTHENTICATED_MANAGER_DECISION_WITH_SUCCESSOR_CONSENT',
    recovery: 'MUST_PRESERVE_PUBLIC_SUCCESSION_AND_RESERVE_RESTRICTIONS',
    claimExecutionEnabled: false, museumExecutionEnabled: false
  };
}
export function makeEconomicPlanV3(state) {
  const p=ordinaryPlan(state);
  return {...p,version:ECONOMIC_POLICY_VERSION_V3,capMicro:String(TOTAL_CAP_MICRO),
    programmeCapMicro:String(CAP),memorialMicro:String(MEMORIAL_MICRO),
    // Ordinary calendars never include the memorial award as payable node work.
    memorial:memorialPolicy(state.configHash)};
}
export function economicTermsHash(plan) {
  const {observedHeight,observedStateHash,...terms}=plan;
  return hash(terms);
}
const amount=n=>{assert(typeof n==='string'&&/^(0|[1-9][0-9]*)$/.test(n),'canonical amount');return BigInt(n);};
export function emissionBudgetV3(input) {
  const {memorialIssuedMicro,...ordinary}=input,issued=amount(memorialIssuedMicro);
  assert(issued===0n||issued===MEMORIAL_MICRO,'memorial issuance must be zero or complete');
  const supply=amount(ordinary.supplyMicro);assert(supply>=issued,'memorial exceeds supply');
  // futureFixedReservedMicro covers ordinary fixed allocations only. Both before
  // and after memorial issuance, node rewards remain bounded by the ordinary cap.
  return ordinaryBudget({...ordinary,supplyMicro:String(supply-issued)});
}
export function memorialMuseumEligibility({emissionStart,at,transferred}) {
  assert(typeof transferred==='boolean');
  assert(Number.isSafeInteger(at)&&at>=0,'UTC integer seconds');
  if(emissionStart===null)return false;
  assert(Number.isSafeInteger(emissionStart)&&emissionStart>0,'authorized launch date');
  return !transferred&&at>=anniversary(emissionStart,100);
}
