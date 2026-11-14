// Consensus preparation only. This action cannot issue, unlock or move funds.
import assert from 'node:assert/strict';
import { exact, hash, integer, verify, hex } from './crypto.mjs';
import {validatorQuorum} from './authority.mjs';
import { developmentManager } from './reserve-recovery.mjs';
import { makeEconomicPlan, ECONOMIC_POLICY_VERSION } from './economic-policy-v2.mjs';
import {versionedEconomicPlan,memorialAware,ECONOMIC_POLICY_VERSION_V3,ECONOMIC_POLICY_VERSION_V4,economicTermsHash} from './economic-policy-v3.mjs';
import {initialMemorialCustody,auditMemorialCustody} from './memorial-custody.mjs';
import {auditCenturyFees} from './century-fees.mjs';
import {auditCenturySubsidy} from './century-subsidy.mjs';
import {auditCenturyIssuance} from './century-issuance.mjs';
import {auditPaidAdmissionHead} from './paid-admission-view.mjs';
export const ECONOMIC_PREPARATION = 'PREPARE_ECONOMY_V2';
export const ECONOMIC_PREPARATION_V3 = 'PREPARE_ECONOMY_V3';
export const ECONOMIC_PREPARATION_V4 = 'PREPARE_ECONOMY_V4';
export const ECONOMIC_PREPARATION_ACTIONS = [ECONOMIC_PREPARATION,ECONOMIC_PREPARATION_V3,ECONOMIC_PREPARATION_V4];
export function applyEconomicPreparation(base, action, config) {
  exact(action, ['type', 'certificate', 'founderConsent']); assert(ECONOMIC_PREPARATION_ACTIONS.includes(action.type));
  const v4=action.type===ECONOMIC_PREPARATION_V4,v3=action.type!==ECONOMIC_PREPARATION;
  const version=v4?ECONOMIC_POLICY_VERSION_V4:v3?ECONOMIC_POLICY_VERSION_V3:ECONOMIC_POLICY_VERSION;
  exact(action.certificate, ['body', 'approvals']); const b=action.certificate.body;
  exact(b, ['domain','network','configHash','generation','notBefore','expires','version','supplyBefore','unitScale',...(v3?['previousPlanHash','termsHash','memorialManager']:[])]);
  assert.equal(b.domain, 'DUEBYTE_ECONOMIC_PREPARATION_V'+(v4?4:v3?3:2));
  assert.equal(b.version, version);assert.equal(b.network,config.chainId);
  assert.equal(b.configHash,base.configHash);assert.equal(b.generation,base.authority.generation);
  integer(b.notBefore,1);integer(b.expires,b.notBefore);
  assert(b.expires-b.notBefore<=100&&base.height>=b.notBefore&&base.height<=b.expires,'preparation inclusion window');
  validatorQuorum(b,action.certificate.approvals,base.authority.validators);
  assert(base.networkReserves,'reserve custody must exist');
  assert(verify(b,action.founderConsent,developmentManager(base.networkReserves)),'founder preparation consent');
  assert.equal(b.supplyBefore,base.money.supply,'supply changed');assert.equal(b.unitScale,base.money.unitScale??'1','denomination changed');
  const current=base.economicPreparation;
  if(current)auditEconomicPreparation(base);
  if(!v3){
    assert(!current||current.plan.version===ECONOMIC_POLICY_VERSION,'economic downgrade prohibited');
    if(current)return base;
  }else{
    assert(!base.networkReserves.development.access?.pending,'management recovery pending');
    assert(!current||current.plan.version!==ECONOMIC_POLICY_VERSION_V4||v4,'economic downgrade prohibited');
    const plan=versionedEconomicPlan(base,version);assert.equal(b.termsHash,economicTermsHash(plan),'approved economic terms');
    assert.equal(b.memorialManager,developmentManager(base.networkReserves),'initial memorial manager');
    if(current?.plan.version===version){
      assert.equal(current.certificateHash,hash(action.certificate),'conflicting preparation replay');return base;
    }
    assert.equal(b.previousPlanHash,current?.planHash??null,'previous economic plan');
    assert(!base.centuryFees&&!base.centurySubsidy&&!base.centuryFunds&&!base.centuryWarmup&&!base.nativeContracts,'dependent accounting must not be reinterpreted');
    assert(!current?.memorial||(!current.memorial.issued&&!current.memorial.pending&&current.memorial.sequence===0),'memorial history requires separate migration');
  }
  const plan=v3?versionedEconomicPlan(base,version):makeEconomicPlan(base),s={...base};
  s.economicPreparation={plan,planHash:hash(plan),certificateHash:hash(action.certificate),...(v3?{memorial:initialMemorialCustody(b.memorialManager)}:{})};
  auditEconomicPreparation(s);return s;
}
export function auditEconomicPreparation(s) {
  const e=s.economicPreparation;if(!e){assert(!s.centuryFees&&!s.centurySubsidy,'century accounting requires economic preparation');return;}
  const v3=memorialAware(e.plan.version);
  exact(e,['plan','planHash','certificateHash',...(v3?['memorial']:[]),...(e.paidAdmission?['paidAdmission']:[])]);if(e.paidAdmission)auditPaidAdmissionHead(e.paidAdmission);assert.equal(hash(e.plan),e.planHash,'economic plan integrity');
  assert(e.plan.version===ECONOMIC_POLICY_VERSION||v3);assert.equal(e.plan.networkConfigHash,s.configHash);
  assert.equal(e.plan.issuanceEnabled,false);assert.equal(e.plan.warmupEnabled,false);
  assert.equal(e.plan.emissionStart,null);assert.equal(e.plan.warmupStart,null);
  assert(!s.launchFund&&!s.networkReserves.issued,'prepared plan cannot activate legacy issuance');
  if(s.centuryFees)auditCenturyFees(s);else assert(!s.rewards&&!s.authority.nodeRewards,'prepared plan cannot activate legacy issuance');
  auditCenturySubsidy(s);
  auditCenturyIssuance(s);
  // Rebuild immutable preparation against its frozen pre-issuance supply only
  // after independently reconciling every newly issued micro-unit above.
  const view=s.centuryFees?{...s,authority:{...s.authority}}:s;
  if(s.centuryFees){delete view.rewards;delete view.authority.nodeRewards;}
  if(s.centurySubsidy||s.centuryFunds?.execution)view.money={...s.money,supply:e.plan.existingSupplyMicro};
  const expected=v3?versionedEconomicPlan(view,e.plan.version):makeEconomicPlan(view);
  exact(e.plan,Object.keys(expected));hex(e.certificateHash);integer(e.plan.observedHeight);
  hex(e.plan.observedStateHash);assert(e.plan.observedHeight<=s.height,'future preparation snapshot');
  // Snapshot provenance is historical; immutable economic fields must still agree.
  for(const key of Object.keys(expected))if(!['observedHeight','observedStateHash'].includes(key))assert.deepEqual(e.plan[key],expected[key],'economic plan field '+key);
  auditMemorialCustody(s);
}
export function guardPreparedEconomy(s,type) {
  if(!s.economicPreparation)return;
  if(s.centuryFees)assert(type!=='REWARD_WITNESS_V1','public checkpoint signatures are not paid work');
  assert(!['ENABLE_NODE_REWARDS_V1','ISSUE_NETWORK_RESERVES_V1','PREPARE_LAUNCH_FUND_V1',
    'ISSUE_LAUNCH_FUND_V1','ACTIVATE_TOKEN_PRECISION_V1'].includes(type),
    'prepared economy requires separately qualified activation; legacy issuance is blocked');
}
