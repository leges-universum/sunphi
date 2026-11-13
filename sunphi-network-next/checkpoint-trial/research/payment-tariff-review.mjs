// Deterministic advisory calculation. Inputs must first be authenticated by the
// settlement/cost evidence adapter. This module cannot admit a tariff or mint.
import assert from 'node:assert/strict';
import {economicFeeTarget} from '../payment-tariff-economics.mjs';
import {hash,integer} from '../crypto.mjs';
import {checkTariff,reductionFields} from '../payment-tariff.mjs';
const ceil=(a,b)=>(a+b-1n)/b,max=(...a)=>a.reduce((x,y)=>x>y?x:y);
const units=s=>{assert(typeof s==='string'&&/^(0|[1-9][0-9]*)$/.test(s));return BigInt(s);};
export const MARKET_REVIEW_RULES=Object.freeze({windowDays:30,minimumTrades:100,minimumBuyers:20,minimumTradingDays:10,minimumVolumeUsd:1000,maximumBuyerSharePercent:10,maximumTradeSharePercent:5,maximumWeeklyReductionPercent:20,costBufferPercent:25});
export function reviewPaymentTariff({now,current,trades,monthlyCostUsdMicro,organicFeeRevenueUsdMicro}){
 integer(now,1);checkTariff(current);assert(Array.isArray(trades)&&trades.length<=100000);const cost=units(monthlyCostUsdMicro),revenue=units(organicFeeRevenueUsdMicro),seen=new Set(),rows=[];
 for(const t of trades){assert(typeof t.id==='string'&&t.id.length>0);assert(!seen.has(t.id),'duplicate settlement');seen.add(t.id);integer(t.settledAt,1);assert(t.settledAt<=now,'future settlement');
  if(t.settledAt<=now-30*86400||t.kind!=='EXTERNAL_SETTLEMENT'||t.buyerGroup===t.sellerGroup||t.warmup===true)continue;
  assert(typeof t.buyerGroup==='string'&&t.buyerGroup.length>0&&typeof t.sellerGroup==='string'&&t.sellerGroup.length>0);
  const value=units(t.dubytMicro),usd=units(t.usdMicro);assert(value>0n&&usd>0n);rows.push({...t,value,usd,price:usd*1000000n/value});
 }
 const volume=rows.reduce((n,t)=>n+t.usd,0n),buyers=new Map(),days=new Set();let largest=0n;
 for(const t of rows){buyers.set(t.buyerGroup,(buyers.get(t.buyerGroup)??0n)+t.usd);days.add(Math.floor(t.settledAt/86400));if(t.usd>largest)largest=t.usd;}
 const reasons=[];if(rows.length<100)reasons.push('INSUFFICIENT_TRADES');if(buyers.size<20)reasons.push('INSUFFICIENT_BUYER_GROUPS');if(days.size<10)reasons.push('INSUFFICIENT_TRADING_DAYS');if(volume<1000000000n)reasons.push('INSUFFICIENT_VOLUME');
 if(volume&&[...buyers.values()].some(v=>v*10n>volume))reasons.push('BUYER_CONCENTRATION');if(largest*20n>volume)reasons.push('TRADE_CONCENTRATION');
 if(!rows.some(t=>t.settledAt>=now-3*86400))reasons.push('STALE_MARKET');if(cost===0n||revenue===0n)reasons.push('COST_OR_ORGANIC_REVENUE_MISSING');
 const median=rs=>{const list=[...rs].sort((a,b)=>a.price<b.price?-1:a.price>b.price?1:(a.id<b.id?-1:a.id>b.id?1:0)),half=ceil(list.reduce((n,t)=>n+t.usd,0n),2n);let sum=0n;for(const t of list){sum+=t.usd;if(sum>=half)return t.price;}return 0n;};
 const price=median(rows),recent=median(rows.filter(t=>t.settledAt>=now-7*86400));
 if(!price||!recent||recent*4n<price*3n||recent*4n>price*5n)reasons.push('UNSTABLE_MARKET');
 if(revenue*4n<cost*5n)reasons.push('ORGANIC_FEES_DO_NOT_COVER_BUFFERED_COST');
 let proposed=null;
 if(!reasons.length&&price>1000000n){
  const target=economicFeeTarget(current,price,cost,revenue),fields=reductionFields(current);
  if(fields.every(k=>units(target[k])<=units(current[k]))&&fields.some(k=>units(target[k])<units(current[k])))proposed=target;
 }
 const sourceRoot=hash({now,current,trades,monthlyCostUsdMicro,organicFeeRevenueUsdMicro});
 const summary={periodStart:now-30*86400,periodEnd:now,trades:rows.length,buyers:buyers.size,tradingDays:days.size,volumeUsdMicro:String(volume),largestBuyerUsdMicro:String([...buyers.values()].reduce((a,b)=>a>b?a:b,0n)),largestTradeUsdMicro:String(largest),lastTrade:rows.reduce((a,t)=>Math.max(a,t.settledAt),0),priceUsdMicro:String(price),weekPriceUsdMicro:String(recent),costUsdMicro:String(cost),revenueUsdMicro:String(revenue),sourceRoot};
 return {summary,advisoryOnly:true,authorization:false,evidenceHash:hash({now,current,trades,monthlyCostUsdMicro,organicFeeRevenueUsdMicro}),rules:MARKET_REVIEW_RULES,eligibleTrades:rows.length,buyerGroups:buyers.size,tradingDays:days.size,volumeUsdMicro:String(volume),priceUsdMicro:price?String(price):null,referenceUsdPerToken:'1',reasons,proposed,decision:proposed?'PROPOSE_REDUCTION':'KEEP_CURRENT'};
}
