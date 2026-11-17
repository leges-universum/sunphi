// A quorum-attested economic report, not a trustless USD oracle. Signers must
// verify the source records and common ownership before attesting this summary.
import assert from 'node:assert/strict';
import {exact,hex,integer} from './crypto.mjs';
import {checkTariff,TARIFF_VERSION} from './payment-tariff.mjs';
const units=s=>{assert(typeof s==='string'&&/^(0|[1-9][0-9]*)$/.test(s)&&s.length<=40,'economic amount');return BigInt(s);};
const ceil=(a,b)=>(a+b-1n)/b,max=(...a)=>a.reduce((x,y)=>x>y?x:y);
export function economicFeeTarget(current,price,cost,revenue){
 checkTariff(current);[price,cost,revenue].forEach(n=>assert(n>0n));
 const reduce=(field,target)=>String(max(ceil(target*1000000n,price),ceil(units(current[field])*80n,100n),ceil(units(current[field])*cost*125n,revenue*100n)));
 if(current.version===TARIFF_VERSION)return {...current,baseMicro:reduce('baseMicro',5000n)};
 return {...current,baseMicro:reduce('baseMicro',1000n),capMicro:reduce('capMicro',100000n),additionalPartMicro:reduce('additionalPartMicro',200n)};
}
export function checkedEconomicReduction(current,s,now){
 exact(s,['periodStart','periodEnd','trades','buyers','tradingDays','volumeUsdMicro','largestBuyerUsdMicro','largestTradeUsdMicro','lastTrade','priceUsdMicro','weekPriceUsdMicro','costUsdMicro','revenueUsdMicro','sourceRoot']);
 integer(now,1);integer(s.periodStart,1);integer(s.periodEnd,s.periodStart);assert.equal(s.periodEnd-s.periodStart,30*86400,'30-day cost and market period');
 assert(s.periodEnd<=now&&now-s.periodEnd<=3*86400,'fresh economic report');
 integer(s.trades,100);integer(s.buyers,20);assert(s.buyers<=s.trades);integer(s.tradingDays,10);assert(s.tradingDays<=30);
 const volume=units(s.volumeUsdMicro),buyer=units(s.largestBuyerUsdMicro),trade=units(s.largestTradeUsdMicro);
 assert(volume>=1000000000n&&buyer>0n&&trade>0n&&trade<=buyer&&buyer*10n<=volume&&trade*20n<=volume,'market concentration');
 integer(s.lastTrade,s.periodStart+1);assert(s.lastTrade<=s.periodEnd&&s.lastTrade>=now-3*86400,'recent settlement');
 const price=units(s.priceUsdMicro),week=units(s.weekPriceUsdMicro),cost=units(s.costUsdMicro),revenue=units(s.revenueUsdMicro);
 assert(price>1000000n&&week*4n>=price*3n&&week*4n<=price*5n,'stable higher exchange price');
 assert(cost>0n&&revenue>0n&&revenue*4n>=cost*5n,'organic fee cost coverage');hex(s.sourceRoot);
 const next=economicFeeTarget(current,price,cost,revenue);checkTariff(next);return next;
}
