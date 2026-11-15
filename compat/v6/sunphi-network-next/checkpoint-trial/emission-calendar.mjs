// Calendar envelopes use consensus UTC seconds and exact token base units.
import assert from 'node:assert/strict';
import {exact,integer} from './crypto.mjs';
import {amount} from './payment-model.mjs';
export const EMISSION_YEARS=30;
// The current payment profile denominates integer amounts in DUBYT. A future
// precision migration must preserve balances explicitly, never reinterpret them.
export const DUBYT_SUPPLY_CAP=100000000000n;
export function emissionEnd(start){
 integer(start,1);const d=new Date(start*1000);assert(Number.isFinite(d.getTime()));
 const month=d.getUTCMonth();d.setUTCFullYear(d.getUTCFullYear()+EMISSION_YEARS);
 // A leap-day start ends on the last day of February in a non-leap year.
 if(d.getUTCMonth()!==month)d.setUTCDate(0);
 return integer(d.getTime()/1000,start+1);
}
export function validateCalendar(c){
 exact(c,['startTime','endTime','budget','supplyCap']);integer(c.startTime,1);
 assert.equal(c.endTime,emissionEnd(c.startTime),'thirty calendar years');
 assert.equal(amount(c.supplyCap),DUBYT_SUPPLY_CAP,'one hundred billion DUBYT cap');
 assert(amount(c.budget)>0n&&amount(c.budget)<=amount(c.supplyCap),'calendar budget');return c;
}
export function cumulativeAllowance(c,time){
 validateCalendar(c);integer(time);if(time<=c.startTime)return 0n;if(time>=c.endTime)return amount(c.budget);
 const t=BigInt(time-c.startTime),T=BigInt(c.endTime-c.startTime);
 return amount(c.budget)*t*(2n*T-t)/(T*T);
}
export function periodAllowance(c,from,to){integer(from);integer(to,from);return cumulativeAllowance(c,to)-cumulativeAllowance(c,from);}
export function boundedEmission({calendar,from,to,workBudget,periodLimit,lifetimeRemaining,supply}){
 const globalRemaining=DUBYT_SUPPLY_CAP-amount(supply);assert(globalRemaining>=0n,'existing supply exceeds emission cap');
 // The intermediate work budget may exceed uint64 before caps are applied.
 // Only the resulting mint is a monetary amount stored in the state.
 assert(/^(0|[1-9][0-9]{0,39})$/.test(String(workBudget)),'work budget');
 const limits=[BigInt(workBudget),amount(periodLimit),amount(lifetimeRemaining),globalRemaining];
 if(calendar){validateCalendar(calendar);const remaining=amount(calendar.supplyCap)-amount(supply);assert(remaining>=0n,'existing supply exceeds emission cap');limits.push(periodAllowance(calendar,from,to),remaining);}
 return limits.reduce((a,b)=>a<b?a:b);
}
