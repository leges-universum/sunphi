import {COMPANY_POLICY,checkRegistrarTerms,setRegistrar,companyOperations} from '../company-enrollment.mjs';
import assert from 'node:assert/strict';
import {exact,hex,integer} from '../crypto.mjs';
import {validateCoefficients,scheduleReviewedCoefficients} from '../node-rewards.mjs';
import {OPERATOR_ISSUERS,OPERATOR_POLICY,checkRewardIssuers,applyRewardIssuerTerms} from './operator-reward-policy.mjs';
import {SCHEDULE_TARIFF,applyTariffTerms} from '../payment-tariff-governance.mjs';
import {checkTariff} from '../payment-tariff.mjs';
import {RENEW_ENROLLMENT,checkEnrollmentRenewal,renewReviewedEnrollment} from './server-reward-registration.mjs';
import {checkedEconomicReduction} from '../payment-tariff-economics.mjs';
import {CHANGE_VALIDATOR_FACTOR,checkValidatorFactor,scheduleValidatorFactor,EXPAND_VALIDATOR_SET,checkExpansion,expandValidatorSet} from './open-validator-policy.mjs';

// Positive list of transactions performing an already authorized service.
// Newly introduced protocol actions need an explicit classification at cutover.
const operations=new Set(`
 RESERVE FINALIZE EXPIRE SCHEDULE_PAYMENT_V1 CANCEL_SCHEDULED_PAYMENT_V1
 SET_SPEND_POLICY_V1 RECOVER_SPEND_POLICY_V1 CANCEL_SPEND_RECOVERY_V1
 FUND_PAYMENT_WORKER_V1 QUEUE_WORKER_COLLATERAL_RELEASE_V1 CANCEL_WORKER_COLLATERAL_RELEASE_V1 EXECUTE_WORKER_COLLATERAL_RELEASE_V1
 BIND_CONSENSUS_BOND_V1 RELEASE_CONSENSUS_BOND_V1 UNJAIL_CONSENSUS_VALIDATOR_V1 JOIN_BONDED_VALIDATOR_V3 CANCEL_BONDED_APPLICATION_V3
 COMMIT_ARCHIVE_REPLICA_V1 PROVE_ARCHIVE_REPLICA_V1 JOIN_ROTATING_SEAT_V1
 REGISTER_SERVER_REWARD_ACCOUNT_V1 REGISTER_REWARD_NODE_V1 NOMINATE_SERVER_REWARD_RECIPIENT_V1 ACCEPT_SERVER_REWARD_RECIPIENT_V1
 BIND_REWARD_WALLETS_V1 SET_REWARD_MANAGEMENT_V1 SET_NODE_WALLET_LINK_V1 REWARD_RECORD_WITNESS_V1 REGISTER_HOME_KEYS_V1
 EXECUTE_EXCHANGE_LAB_V1 EXECUTE_PURCHASE_LAB_V1
 SET_OPERATOR_REWARD_STATUS_V1 LINK_OPERATOR_REWARD_PROFILE_V1
 SET_SETTLEMENT_OFFER_V1 BOOK_SETTLEMENT_ASSURANCE_V1 SUBMIT_SETTLEMENT_ATTESTATION_V1 REPORT_FALSE_SETTLEMENT_V1 CLOSE_SETTLEMENT_ASSURANCE_V1
 ACCEPT_PAYMENT_LIABILITY_V1 REPORT_PAYMENT_FAULT_V1 RESOLVE_PAYMENT_FAULT_V1 READMIT_PAYMENT_WORKER_V1 CERTIFY_PROTECTION_LOSS_V2
 QUEUE_PROTECTION_PAYMENT_V1 CANCEL_PROTECTION_PAYMENT_V1 EXECUTE_PROTECTION_PAYMENT_V1 QUEUE_PROTECTION_PAYMENT_V2 EXECUTE_PROTECTION_PAYMENT_V2
 CLAIM_COLLATERAL_SUPPORT_V1 QUEUE_COLLATERAL_SUPPORT_RETURN_V1 RETURN_COLLATERAL_SUPPORT_V1
 COMPLETE_CENTURY_HOME_V1 COMPLETE_HOME_RECORD_AVAILABILITY_V1 COMPLETE_BASELINE_SERVICE_V1
 CERTIFY_CENTURY_WARMUP_INTERVAL_V1 RUN_CENTURY_WARMUP_V1 CLOSE_CENTURY_WARMUP_INTERVAL_V1
 ISSUE_CENTURY_WARMUP_TRANCHE_V1 RELEASE_CENTURY_FOUNDER_V1 QUEUE_CENTURY_DEVELOPMENT_V1 CANCEL_CENTURY_DEVELOPMENT_V1 EXECUTE_CENTURY_DEVELOPMENT_V1
 SCHEDULE_ANNUAL_DEVELOPMENT_PAYOUT_V1
 PROPOSE_NATIVE_CONTRACT_V1 CANCEL_NATIVE_CONTRACT_V1 EXECUTE_NATIVE_CONTRACT_V1
 PROPOSE_SATOSHI_RESEARCH_V2 CANCEL_SATOSHI_RESEARCH_V2 EXECUTE_SATOSHI_RESEARCH_V2
 ROTATE_DEVELOPMENT_MANAGER_V1 SCHEDULE_DEVELOPMENT_RECOVERY_V1 CANCEL_DEVELOPMENT_RECOVERY_V1 EXECUTE_DEVELOPMENT_RECOVERY_V1
 PUBLISH_MEMORIAL_SUCCESSION_V1 CANCEL_MEMORIAL_SUCCESSION_V1 EXECUTE_MEMORIAL_SUCCESSION_V1
`.trim().split(/\s+/));
export function requireOperationalAction(s,action){
 if(action.type==='SCHEDULE_DEVELOPMENT_RECOVERY_V1'){
  const current=s.networkReserves.development.access.recovery,next=action.body.recovery;
  assert.equal(next.delaySeconds,current.delaySeconds,'fund recovery delay is fixed');
  assert.equal(next.threshold,current.threshold,'fund recovery threshold is fixed');
 }
 if(action.type==='RENEW_POLICY'){
  const current=s.authority.policy,next=action.certificate?.body?.next;
  for(const field of ['members','threshold','maxAge'])assert.deepEqual(next?.[field],current[field],'renewal cannot change policy after warmup');
  return;
 }
 assert(operations.has(action.type)||companyOperations.includes(action.type),'direct rule changes have retired; submit a reviewed operator proposal');
}
export function validateFinancialChange(change){
 exact(change,['type','terms']);
 if(change.type===COMPANY_POLICY)return checkRegistrarTerms(change.terms);
 if(change.type===SCHEDULE_TARIFF){
  const t=change.terms;exact(t,['previous','profile','activation','economics']);hex(t.previous);integer(t.activation,1);checkTariff(t.profile);
  if(t.economics!==null)checkedEconomicReduction(t.profile,t.economics,t.economics.periodEnd);
 }
 else if(change.type===CHANGE_VALIDATOR_FACTOR){
  const t=change.terms;exact(t,['previous','year','factorBps']);hex(t.previous);checkValidatorFactor(t.year,t.factorBps);
 }
 else if(change.type===EXPAND_VALIDATOR_SET)checkExpansion(change.terms);
 else if(change.type===RENEW_ENROLLMENT)checkEnrollmentRenewal(change.terms);
 else if(change.type==='SET_REWARD_COEFFICIENTS_V1'){
  const t=change.terms;exact(t,['previous','activation','coefficients']);hex(t.previous);assert.equal(t.activation,'after-one-full-period');
  assert(t.coefficients&&typeof t.coefficients==='object');validateCoefficients(t.coefficients);
  const c=t.coefficients;assert(c.alphaPPM===0&&c.periodMintLimit==='0'&&c.lifetimeMintLimit==='0'&&!c.calendar,'issuance is outside the voting agenda');
 }else if(change.type===OPERATOR_ISSUERS||change.type===OPERATOR_POLICY){
  const t=change.terms,rotation=change.type===OPERATOR_ISSUERS;exact(t,['effectiveFrom','issuers',...(rotation?['previousHash','sequence']:[])]);
  integer(t.effectiveFrom,1);assert.equal(t.effectiveFrom%86400,0);checkRewardIssuers(t.issuers);
  if(rotation){hex(t.previousHash);integer(t.sequence,1);}
 }
 else assert.fail('unsupported reviewed financial rule');
}
export function enactFinancialChange(s,config,change,decision,tx){
 validateFinancialChange(change);
 if(change.type===COMPANY_POLICY)return setRegistrar(s,change.terms,decision);
 if(change.type===RENEW_ENROLLMENT)return renewReviewedEnrollment(s,config,change.terms,tx);
 if(change.type===CHANGE_VALIDATOR_FACTOR)return scheduleValidatorFactor(s,change.terms,decision);
 if(change.type===EXPAND_VALIDATOR_SET)return expandValidatorSet(s,change.terms,decision);
 if(change.type===SCHEDULE_TARIFF)return applyTariffTerms(s,change.terms,config,decision);
 if(change.type==='SET_REWARD_COEFFICIENTS_V1')return scheduleReviewedCoefficients(s,config,change.terms,decision);
 if(change.type===OPERATOR_ISSUERS||change.type===OPERATOR_POLICY)return applyRewardIssuerTerms(s,change.type,change.terms,decision,tx);
 assert.fail('unsupported reviewed financial rule');
}
