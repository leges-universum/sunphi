// Consensus preparation only. This action cannot issue, unlock or move funds.
import assert from 'node:assert/strict';
import { exact, hash, integer, verify, hex } from './crypto.mjs';
import { quorum } from './authority.mjs';
import { developmentManager } from './reserve-recovery.mjs';
import { makeEconomicPlan, ECONOMIC_POLICY_VERSION } from './economic-policy-v2.mjs';
export const ECONOMIC_PREPARATION = 'PREPARE_ECONOMY_V2';
export function applyEconomicPreparation(base, action, config) {
  exact(action, ['type', 'certificate', 'founderConsent']); assert.equal(action.type, ECONOMIC_PREPARATION);
  exact(action.certificate, ['body', 'approvals']); const b=action.certificate.body;
  exact(b, ['domain','network','configHash','generation','notBefore','expires','version','supplyBefore','unitScale']);
  assert.equal(b.domain, 'DUEBYTE_ECONOMIC_PREPARATION_V2');
  assert.equal(b.version, ECONOMIC_POLICY_VERSION);assert.equal(b.network,config.chainId);
  assert.equal(b.configHash,base.configHash);assert.equal(b.generation,base.authority.generation);
  integer(b.notBefore,1);integer(b.expires,b.notBefore);
  assert(b.expires-b.notBefore<=100&&base.height>=b.notBefore&&base.height<=b.expires,'preparation inclusion window');
  quorum(b,action.certificate.approvals,base.authority.validators,7);
  assert(base.networkReserves,'reserve custody must exist');
  assert(verify(b,action.founderConsent,developmentManager(base.networkReserves)),'founder preparation consent');
  assert.equal(b.supplyBefore,base.money.supply,'supply changed');assert.equal(b.unitScale,base.money.unitScale??'1','denomination changed');
  if(base.economicPreparation){auditEconomicPreparation(base);return base;}
  const plan=makeEconomicPlan(base),s=structuredClone(base);
  s.economicPreparation={plan,planHash:hash(plan),certificateHash:hash(action.certificate)};
  auditEconomicPreparation(s);return s;
}
export function auditEconomicPreparation(s) {
  const e=s.economicPreparation;if(!e)return;
  exact(e,['plan','planHash','certificateHash']);assert.equal(hash(e.plan),e.planHash,'economic plan integrity');
  assert.equal(e.plan.version,ECONOMIC_POLICY_VERSION);assert.equal(e.plan.networkConfigHash,s.configHash);
  assert.equal(e.plan.issuanceEnabled,false);assert.equal(e.plan.warmupEnabled,false);
  assert.equal(e.plan.emissionStart,null);assert.equal(e.plan.warmupStart,null);
  assert(!s.rewards&&!s.authority.nodeRewards&&!s.launchFund&&!s.networkReserves.issued,'prepared plan cannot activate legacy issuance');
  const expected=makeEconomicPlan(s);
  exact(e.plan,Object.keys(expected));hex(e.certificateHash);integer(e.plan.observedHeight);
  hex(e.plan.observedStateHash);assert(e.plan.observedHeight<=s.height,'future preparation snapshot');
  // Snapshot provenance is historical; immutable economic fields must still agree.
  for(const key of Object.keys(expected))if(!['observedHeight','observedStateHash'].includes(key))assert.deepEqual(e.plan[key],expected[key],'economic plan field '+key);
}
export function guardPreparedEconomy(s,type) {
  if(!s.economicPreparation)return;
  assert(!['ENABLE_NODE_REWARDS_V1','ISSUE_NETWORK_RESERVES_V1','PREPARE_LAUNCH_FUND_V1',
    'ISSUE_LAUNCH_FUND_V1','ACTIVATE_TOKEN_PRECISION_V1'].includes(type),
    'prepared V2 economy requires qualified V2 activation; legacy issuance is blocked');
}
