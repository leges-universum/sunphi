// API amounts are decimal strings; signed ledger amounts are integer strings.
// The verified state selects the scale, never the caller or the current theme.
import assert from 'node:assert/strict';
import {parseToken,formatToken,unitScale,intentUnits} from './token-units.mjs';
import {feeFor,releaseFeeFor,MAX,policyId} from './payment-model.mjs';
export function paymentQuote(state,text,expectedScale){
 const scale=String(unitScale(state));
 assert.equal(expectedScale??'1',scale,'Payment units changed. Review the amount again.');
 const value=parseToken(text,scale);assert(BigInt(value)>0n,'Enter a positive amount.');
 const fee=String(feeFor(value)),abortFee=String(releaseFeeFor(value,scale)),total=String(BigInt(value)+BigInt(fee));
 assert(BigInt(total)<=MAX,'Payment total exceeds the supported amount.');
 return {unitScale:scale,policy:policyId,value,fee,abortFee,total,display:Object.fromEntries(Object.entries({value,fee,abortFee,total}).map(([k,v])=>[k,formatToken(v,scale)]))};
}
export function validatePaymentReview(state,q){
 const quote=paymentQuote(state,q.value,q.unitScale);
 // Old whole-unit clients remain compatible; fractional clients must bind fees.
 if(quote.unitScale!=='1'||q.fee!==undefined||q.abortFee!==undefined){
  assert.equal(q.fee,quote.fee,'Network fee changed. Review the payment again.');
  assert.equal(q.abortFee,quote.abortFee,'Release fee changed. Review the payment again.');
 }
 return quote;
}
export const displayAmounts=(values,scale)=>Object.fromEntries(Object.entries(values).map(([k,v])=>[k,v===null?null:formatToken(v,scale)]));
export function paymentAmounts(intent,fee=null){
 const scale=String(unitScale(intent));
 return {unitScale:scale,display:displayAmounts({value:intent.value,fee,cancelFee:intent.abortFee},scale)};
}
export function monetaryAnalytics(state){
 const scale=String(unitScale(state));
 const volume=String(Object.values(state.money.requests).filter(r=>r.status==='SETTLED').reduce((n,r)=>n+BigInt(intentUnits(r.intent,r.intent.value,scale)),0n));
 return {unitScale:scale,supply:state.money.supply,volume,display:displayAmounts({supply:state.money.supply,volume},scale)};
}
