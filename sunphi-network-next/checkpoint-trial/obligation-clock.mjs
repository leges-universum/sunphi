// Prospective protocol clock. UTC is integer Unix seconds from committed headers.
// Legacy signed height deadlines are never converted or inferred from magnitude.
import assert from 'node:assert/strict';
export const UTC_OBLIGATIONS='DUEBYTE_UTC_OBLIGATIONS_V1';
export const UTC_WINDOWS=Object.freeze({admissionSeconds:240,reviewSeconds:6000,completionSeconds:640,maxLifetimeSeconds:1000});
export const utcIntent=i=>i?.timeBasis===UTC_OBLIGATIONS;
export function paymentClock(m,i,height=m.height){return utcIntent(i)?m.time:height;}
export function canStillReserve(m,i){return utcIntent(i)?m.time<=i.lastReserve:m.height<i.lastReserve;}
export function liabilityClock(m){return m.liability.policy.version>=2?m.time:m.liability.height;}
export function checkObligationAdmission(config,intent){
 assert.equal(intent.timeBasis,config.obligationClock,'signed obligation clock must match genesis');
}
export function paymentWindow(m,config,{protectedPayment=false}={}){
 if(config.obligationClock===UTC_OBLIGATIONS){const lastReserve=m.time+(protectedPayment?UTC_WINDOWS.reviewSeconds:UTC_WINDOWS.admissionSeconds);return {timeBasis:UTC_OBLIGATIONS,lastReserve,deadline:lastReserve+UTC_WINDOWS.completionSeconds};}
 const lastReserve=m.height+(protectedPayment?600:24);return {lastReserve,deadline:lastReserve+64};
}
