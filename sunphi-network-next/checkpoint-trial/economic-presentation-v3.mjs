// Approved public planning arithmetic; never a ledger issuer or spend authority.
// Preserve V2 consensus readers until a separately qualified protocol migration.
import {allocation as programmeAllocation, CAP, UNIT} from './ecosystem-century-model.mjs';
export * from './ecosystem-century-model.mjs';
export const MEMORIAL = 1000000n * UNIT;
export const PLANNED_CAP = CAP + MEMORIAL;
export function allocation(existing) {
 const a=programmeAllocation(existing);
 return {...a,programmeCap:a.cap,cap:PLANNED_CAP,programmeFixed:a.fixed,
   fixed:a.fixed+MEMORIAL,memorial:MEMORIAL};
}
export const memorialTerms=Object.freeze({
 beneficiary:'Satoshi Nakamoto',name:'The memorial million for Satoshi Nakamoto',
 beneficiaryDefinition:'THE_ORIGINAL_BITCOIN_CREATOR_OR_VERIFIED_ORIGINAL_COCREATOR_GROUP_USING_THE_SATOSHI_NAKAMOTO_PSEUDONYM',
 namesakeEligibility:false,nameOrAccountRegistrationSufficient:false,
 earlyKeyPossessionAloneSufficient:false,laterBitcoinContributionAloneSufficient:false,
 groupMembership:'EACH_CLAIMANT_MUST_SUBSTANTIATE_ORIGINAL_GROUP_MEMBERSHIP',
 groupPayment:'ONE_SHARED_ALLOCATION_WITH_VERIFIED_ENTITLEMENTS_AND_REPRESENTATION',
 unresolvedCompetingClaims:'NO_TRANSFER_UNTIL_RESOLVED_UNDER_PUBLISHED_PROCEDURE_AND_APPLICABLE_LAW',
 plannedOneTimeIssuance:'AT_AUTHORIZED_LAUNCH',issued:false,acceptedByBeneficiary:false,
 founderCustody:'DOES_NOT_ESTABLISH_BENEFICIARY_OWNERSHIP',
 ordinaryFounderSpending:false,ordinaryProjectSpending:false,
 satoshiTransfer:'VERIFIED_CLAIM_UNDER_PUBLISHED_PROCEDURE',
 museumEligibility:'AT_100TH_EMISSION_ANNIVERSARY_IF_NOT_TRANSFERRED',
 museumUse:'CREATION_OR_DEVELOPMENT_OF_A_CRYPTOCURRENCY_HISTORY_MUSEUM',
 automaticMuseumTransfer:false,doubleTransfer:false,
 succession:'FOUNDER_PUBLIC_AUTHENTICATED_DECISION',
 implementationStatus:'APPROVED_RULES_REQUIRING_PROTOCOL_IMPLEMENTATION'
});
