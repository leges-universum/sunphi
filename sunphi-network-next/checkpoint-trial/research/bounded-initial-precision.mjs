// One-time denomination preparation on an unfunded clean chain only.
// Existing nonzero balances must use a separately qualified migration.
import assert from 'node:assert/strict';
import {exact,hash,integer,verify} from '../crypto.mjs';import {validatorQuorum} from '../authority.mjs';
import {developmentManager} from '../reserve-recovery.mjs';import {previewTokenPrecision} from '../precision-preview.mjs';
export const INITIAL_PRECISION='PREPARE_INITIAL_PRECISION_V1';
export function prepareInitialPrecision(s,a,c,{anchor,nonzeroWorkers,active,paymentEvents}){
 exact(a,['type','certificate','founderConsent']);assert.equal(a.type,INITIAL_PRECISION);exact(a.certificate,['body','approvals']);const b=a.certificate.body;
 exact(b,['domain','network','configHash','generation','notBefore','expires','decimals','supplyBefore','planHash']);
 assert.equal(b.domain,INITIAL_PRECISION);assert.equal(b.network,c.chainId);assert.equal(b.configHash,hash(c));assert.equal(s.configHash,b.configHash);assert.equal(b.generation,s.authority.generation);assert(!s.authority.pending);
 integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.expires-b.notBefore<=100&&s.height>=b.notBefore&&s.height<=b.expires,'precision inclusion window');
 assert.equal(b.decimals,6);assert.equal(b.supplyBefore,'0');assert.equal(s.money.supply,'0');assert.equal(s.money.fees,'0');assert(!s.money.unitScale,'precision already prepared');
 assert.equal(anchor.height,0);assert.equal(anchor.archive,null);assert.equal(anchor.issuance,false);
 assert.equal(c.initial.supply,'0');assert.equal(c.initial.fees,'0');for(const k of ['outputs','requests','nodes'])assert.deepEqual(c.initial[k],{});
 assert.deepEqual(active,{});assert.equal(paymentEvents,0);
 assert(s.economicPreparation&&s.networkReserves&&!s.networkReserves.issued);assert.equal(s.economicPreparation.plan.issuanceEnabled,false);assert.equal(s.economicPreparation.plan.emissionStart,null);assert.equal(s.economicPreparation.planHash,b.planHash);
 assert(!s.rewards&&!s.authority.nodeRewards&&!s.centuryFees&&!s.centuryFunds&&!s.centurySubsidy&&!s.centuryWarmup&&!s.workerFunding&&!s.money.liability&&!s.launchFund,'initial preparation only');
 validatorQuorum(b,a.certificate.approvals,s.authority.validators);assert(verify(b,a.founderConsent,developmentManager(s.networkReserves)),'founder precision consent');
 // This count is supplied by the authenticated worker index, never by a wire.
 // Zero-valued workers are denomination-invariant and need no rewrite.
 assert.equal(nonzeroWorkers,0,'unfunded workers required');const nodes={};
 // Clean zero-supply provenance and the disabled issuance gate exclude monetary
 // records. No unbounded output/history scan or signed-history rewrite is needed.
 const before={...s,money:{...s.money,outputs:{},requests:{},nodes}},converted=previewTokenPrecision(before).state;
 assert.equal(converted.money.supply,'0');assert.deepEqual(converted.money.nodes,nodes);
 const money={...s.money,unitScale:converted.money.unitScale,precisionHeight:converted.money.precisionHeight,epoch:converted.money.epoch};
 converted.networkReserves.history=hash({previous:s.networkReserves.history,precision:hash(a.certificate),height:s.height});
 return {...converted,money};
}
