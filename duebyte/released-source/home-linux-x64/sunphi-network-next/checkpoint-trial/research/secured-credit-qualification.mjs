// First-stage quote and loss-accounting checks for the test lending book.
// Amounts use six decimal places. This module cannot move collateral or cash.
import assert from 'node:assert/strict';
import {amount} from '../payment-model.mjs';
const SCALE=1000000n,BPS=10000n;
const ceil=(a,b)=>(a+b-1n)/b;

// Compute the actual cost of buying the complete DUBYT obligation from free
// native holdings at known ask prices. Ignore expired or self-funded liquidity.
export function stressedRepurchase(asks,{debt,now,excludedMakers,shockBps,feeBps}){
 let need=amount(debt),cost=0n;
 assert(need>0n&&Number.isSafeInteger(now)&&Number.isInteger(shockBps)&&shockBps>=0&&shockBps<=100000);
 assert(Number.isInteger(feeBps)&&feeBps>=0&&feeBps<=10000);
 const fills=[],ids=new Set(),live=[];
 for(const o of asks){
  assert(!ids.has(o.id),'Duplicate liquidity source.');ids.add(o.id);
  if(o.closed||o.expires<=now||excludedMakers.includes(o.maker))continue;
  const price=amount(o.price),remaining=amount(o.remaining);assert(price>0n);
  if(remaining>0n)live.push({id:o.id,price,remaining});
 }
 live.sort((a,b)=>a.price===b.price?a.id.localeCompare(b.id):a.price<b.price?-1:1);
 for(const o of live){
  const fill=o.remaining<need?o.remaining:need;
  const principal=ceil(fill*o.price*(BPS+BigInt(shockBps)),SCALE*BPS);
  cost+=principal+ceil(principal*BigInt(feeBps),BPS);
  fills.push({id:o.id,units:String(fill)});need-=fill;if(!need)break;
 }
 return {covered:need===0n,missing:String(need),cost:String(cost),fills};
}
export function qualifyCredit({principal,interest,inventory,allocatedRisk,riskRequired,collateral,collateralShockBps,executionCost,market,now,maxAge,distinctReaders}){
 const p=amount(principal),d=p+amount(interest);
 assert(p>0n&&Number.isInteger(collateralShockBps)&&collateralShockBps>=0&&collateralShockBps<=10000);
 assert(Number.isSafeInteger(now)&&Number.isSafeInteger(maxAge)&&maxAge>=0);
 if(p>amount(inventory))return {available:false,reason:'Credit inventory is insufficient.'};
 if(amount(riskRequired)===0n||amount(allocatedRisk)<amount(riskRequired))return {available:false,reason:'Loss capital is insufficient.'};
 if(new Set(distinctReaders).size<2||!market||!Number.isSafeInteger(market.observedAt)||market.observedAt>now||now-market.observedAt>maxAge)return {available:false,reason:'Current verified market depth is unavailable.'};
 const quote=stressedRepurchase(market.asks,{debt:String(d),now,excludedMakers:market.excludedMakers,shockBps:market.priceShockBps,feeBps:market.feeBps});
 if(!quote.covered)return {available:false,reason:'Insufficient funded DUBYT sell orders.',quote};
 const recovery=amount(collateral)*(BPS-BigInt(collateralShockBps))/BPS,required=BigInt(quote.cost)+amount(executionCost);
 if(recovery<required)return {available:false,reason:'Stressed collateral is insufficient.',quote};
 return {available:true,debt:String(d),requiredCash:String(required),stressedCollateral:String(recovery),quote};
}
// Apply after the actual external sale and native repurchase have both settled.
// Native loss capital absorbs DUBYT shortfall; all unused external cash is
// still held for the borrower. A pending sale has no realized recovery.
export function liquidationStatement({saleFinal,nativeFinal,debt,cashReceived,cashSpent,permittedCosts,dubytReceived,riskCapital}){
 if(!saleFinal||!nativeFinal)return {status:'Awaiting settlement'};
 const due=amount(debt),cash=amount(cashReceived),spent=amount(cashSpent),fees=amount(permittedCosts),received=amount(dubytReceived);
 assert(spent+fees<=cash,'Unfunded liquidation expenses.');
 const recovery=received<due?received:due,short=due-recovery,capital=amount(riskCapital),covered=short<capital?short:capital;
 return {status:'Settled',debtRecovered:String(recovery),riskCapitalUsed:String(covered),uncoveredLoss:String(short-covered),borrowerDubyt:String(received-recovery),borrowerCash:String(cash-spent-fees)};
}
