// Signed DUBYT amounts, never a promise of a USD exchange rate.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer} from './crypto.mjs';
export const LEGACY_TARIFF_VERSION='DUEBYTE_HYBRID_FEE_V1';
export const TARIFF_VERSION='DUEBYTE_PAYMENT_FEE_006_V2';
export const INITIAL_TARIFF=Object.freeze({version:TARIFF_VERSION,baseMicro:'5000',rateNum:'3',rateDen:'5000'});
export const reductionFields=p=>p.version===TARIFF_VERSION?['baseMicro']:['baseMicro','capMicro','additionalPartMicro'];
export function checkTariff(p){
 if(p?.version===TARIFF_VERSION){exact(p,['version','baseMicro','rateNum','rateDen']);assert(typeof p.baseMicro==='string'&&/^[1-9][0-9]{0,3}$/.test(p.baseMicro),'canonical minimum fee');assert(BigInt(p.baseMicro)<=5000n,'base fee bound');assert.equal(p.rateNum,'3');assert.equal(p.rateDen,'5000','fixed 0.06 percent rate');return p;}
 exact(p,['version','baseMicro','capMicro','rateDen','additionalPartMicro']);assert.equal(p.version,LEGACY_TARIFF_VERSION);
 for(const k of ['baseMicro','capMicro','additionalPartMicro'])assert(typeof p[k]==='string'&&/^(0|[1-9][0-9]*)$/.test(p[k]),'canonical tariff amount');
 assert(BigInt(p.baseMicro)>=1n&&BigInt(p.baseMicro)<=1000n,'base fee bound');
 assert.equal(p.rateDen,'100000','fixed 0.001 percent rate');assert(BigInt(p.capMicro)>=BigInt(p.baseMicro)&&BigInt(p.capMicro)<=100000n,'base fee cap');
 assert(BigInt(p.additionalPartMicro)<=200n,'additional part fee bound');return p;
}
export function workFee(p,parts=1){checkTariff(p);integer(parts,1);assert(parts<=32,'payment part limit');return p.version===TARIFF_VERSION?0n:BigInt(parts-1)*BigInt(p.additionalPartMicro);}
export function paymentFee(p,value,parts=1){checkTariff(p);assert(typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value),'canonical payment amount');const minimum=BigInt(p.baseMicro),den=BigInt(p.rateDen),proportional=(BigInt(value)*BigInt(p.rateNum??'1')+den-1n)/den,extra=workFee(p,parts);if(p.version===TARIFF_VERSION)return proportional<minimum?minimum:proportional;const cap=BigInt(p.capMicro);return (proportional<minimum?minimum:proportional>cap?cap:proportional)+extra;}
export function auditPaymentTariff(money){
 const t=money.paymentTariff;if(!t)return;
 assert.equal(money.unitScale,'1000000','tariff needs fractional units');
 exact(t,['current','next','activation','certificateHash']);if(t.current!==null)checkTariff(t.current);checkTariff(t.next);integer(t.activation,1);hex(t.certificateHash);
 if(t.current){assert.equal(t.next.version,t.current.version,'tariff version changes need a separate upgrade');for(const k of reductionFields(t.current))assert(BigInt(t.next[k])<=BigInt(t.current[k]));}
}
export function activePaymentTariff(money){auditPaymentTariff(money);const t=money.paymentTariff;return t?(money.time>=t.activation?t.next:t.current):null;}
export function guardPaymentTariff(money,intent){assert.equal(hash(intent.feeSchedule??null),hash(activePaymentTariff(money)),'Network fee schedule changed. Review the payment again.');}
export function paymentTariffStatus(money){const p=activePaymentTariff(money),t=money.paymentTariff;return {active:p,pending:t&&money.time<t.activation?{profile:t.next,activation:t.activation}:null,referenceUsdPerToken:'1',referenceOnly:true};}
