// Non-minting preparation from a verified current state. No keys or network IO.
import assert from 'node:assert/strict';
import {hash} from '../crypto.mjs';
import {LIABILITY,liabilityPolicy,liabilityConsent} from '../payment-liability.mjs';
import {INITIAL_TARIFF,activePaymentTariff} from '../payment-tariff.mjs';
import {tariffNoticeSeconds} from '../payment-tariff-governance.mjs';
import {centuryFundsManifest,CENTURY_FUNDS_ACTION} from '../century-funds.mjs';
export const PREPARATION_ACTIONS=Object.freeze(['PREPARE_PAYMENT_LIABILITY_V1','ACCEPT_PAYMENT_LIABILITY_V1','SCHEDULE_PAYMENT_TARIFF_V1',CENTURY_FUNDS_ACTION]);
export function preparationGuard(s,c,owner,rows){
 assert.equal(s.configHash,hash(c));assert.equal(s.money.supply,'0');assert.equal(s.money.fees,'0');
 assert.equal(s.money.unitScale,'1000000');assert(!s.centuryFunds?.execution&&!s.centuryWarmup&&!s.centurySubsidy);
 assert(s.networkReserves?.development.access&&!s.networkReserves.development.access.pending);
 assert(!s.authority.pending,'stable validator authority required');
 assert(rows.length>0&&new Set(rows.map(r=>r.node)).size===rows.length);
 for(const r of rows){const n=s.money.nodes[r.node],p=s.rewards?.nodes[r.node];
  assert(n&&p);assert.equal(n.key,r.workerKey);assert.equal(p.key,r.workerKey);
  assert.deepEqual(p.payouts,[{wallet:owner,weight:1}]);
  for(const field of ['stake','taskHeld','consensusHeld','tier'])assert.equal(n[field],'0');
 }
}
export function preparationBody(kind,s,c,{owner,rows,ownerGroup}){
 preparationGuard(s,c,owner,rows);
 const common={network:c.chainId,configHash:hash(c),generation:s.authority.generation,notBefore:s.height+1,expires:s.height+24};
 if(kind==='liability'){
  assert(!s.money.liability,'existing liability policy is immutable');
  const policy={version:4,activation:common.expires+2,challengeSeconds:0,suspensionSeconds:100000,
   exceptionDelaySeconds:86400,penaltyBps:1000,maxOpen:256,maxAssignments:768,
   founderKey:s.networkReserves.development.access.manager,founderGroup:ownerGroup,founderNodes:rows.map(r=>r.node).sort()};
  liabilityPolicy(policy);return {domain:LIABILITY+'/POLICY',...common,policy};
 }
 if(kind==='tariff'){
  assert(!s.money.paymentTariff,'do not overwrite an existing tariff schedule');
  return {domain:'SCHEDULE_PAYMENT_TARIFF_V1',...common,managementEpoch:s.networkReserves.development.access.epoch,
   previous:hash(activePaymentTariff(s.money)),profile:{...INITIAL_TARIFF},activation:s.money.time+tariffNoticeSeconds(s,c)+600,economics:null};
 }
 assert.equal(kind,'funds');assert(!s.centuryFunds,'existing fund preparation must be reviewed, not replaced');
 return {domain:CENTURY_FUNDS_ACTION,...common,manifest:centuryFundsManifest(s,owner),previousManifestHash:null};
}
export function workerLiabilityAction(s,node,key){
 assert.equal(s.money.nodes[node]?.key,key.publicKey);assert(s.money.liability);
 assert(!s.money.liability.consents[node],'already accepted');
 return {type:'ACCEPT_PAYMENT_LIABILITY_V1',node,body:liabilityConsent(s.money,node)};
}
export function assertPreparationAction(a){assert(PREPARATION_ACTIONS.includes(a.type),'only non-minting preparation is authorized');}
