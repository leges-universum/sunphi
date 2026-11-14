import assert from 'node:assert/strict';
import {checkedEconomicReduction} from './payment-tariff-economics.mjs';
import {exact,hash,integer,verify} from './crypto.mjs';
import {validatorQuorum} from './authority.mjs';
import {developmentManager} from './reserve-recovery.mjs';
import {INITIAL_TARIFF,checkTariff,activePaymentTariff,auditPaymentTariff,reductionFields} from './payment-tariff.mjs';
export const SCHEDULE_TARIFF='SCHEDULE_PAYMENT_TARIFF_V1';
// Only the first tariff of a clean, still-unfunded chain can skip notice.
// Read committed scalar headers, never enumerate wallets or registered nodes.
export function tariffNoticeSeconds(s,config){
 const pristine=config.initial?.supply==='0'&&config.initial?.fees==='0'
  &&s.money.supply==='0'&&s.money.fees==='0'&&!s.money.paymentTariff
  &&!s.centuryFunds?.execution&&!s.centuryFunds?.support&&!s.centuryFunds?.founderAdvance
  &&!s.centuryWarmup&&!s.centurySubsidy&&!s.networkReserves?.issued&&!s.launchFund?.issued
  &&(s.rewards?.minted===undefined||s.rewards.minted==='0');
 return pristine?0:86400;
}
export function schedulePaymentTariff(base,a,config){
 exact(a,['type','certificate','founderConsent']);assert.equal(a.type,SCHEDULE_TARIFF);exact(a.certificate,['body','approvals']);const b=a.certificate.body;
 exact(b,['domain','network','configHash','generation','managementEpoch','notBefore','expires','previous','profile','activation','economics']);
 assert.equal(b.domain,SCHEDULE_TARIFF);assert.equal(b.network,config.chainId);assert.equal(b.configHash,hash(config));assert.equal(b.generation,base.authority.generation);
 assert.equal(b.managementEpoch,base.networkReserves.development.access.epoch,'current management epoch');
 assert(config.obligationClock,'UTC network required');assert.equal(base.money.unitScale,'1000000');
 integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.expires-b.notBefore<=100&&base.height>=b.notBefore&&base.height<=b.expires,'tariff inclusion window');
 validatorQuorum(b,a.certificate.approvals,base.authority.validators);assert(verify(b,a.founderConsent,developmentManager(base.networkReserves)),'tariff manager consent');
 const certificateHash=hash(a.certificate),old=base.money.paymentTariff;
 if(old?.certificateHash===certificateHash)return base;
 assert(!old||base.money.time>=old.activation,'pending tariff cannot be replaced');
 const current=activePaymentTariff(base.money);assert.equal(b.previous,hash(current),'previous tariff changed');checkTariff(b.profile);
 integer(b.activation,base.money.time+tariffNoticeSeconds(base,config));assert(b.activation<=base.money.time+30*86400,'bounded tariff notice');
 if(current){assert.equal(b.profile.version,current.version,'tariff version changes need a separate upgrade');assert(b.activation>=old.activation+7*86400,'weekly tariff change limit');for(const field of reductionFields(current)){assert(BigInt(b.profile[field])<=BigInt(current[field]),'only prospective fee reductions');assert(BigInt(b.profile[field])*100n>=BigInt(current[field])*80n,'maximum weekly reduction is 20 percent');}assert.notEqual(hash(b.profile),hash(current),'unchanged tariff');assert.deepEqual(b.profile,checkedEconomicReduction(current,b.economics,base.money.time),'economic tariff target');}
 else {assert.equal(b.economics,null,'initial reference has no market evidence');assert.deepEqual(b.profile,INITIAL_TARIFF,'initial published tariff');}
 const s={...base,money:{...base.money,paymentTariff:{current:current&&structuredClone(current),next:structuredClone(b.profile),activation:b.activation,certificateHash}}};
 auditPaymentTariff(s.money);return s;
}
