// Calendar source for the SAME daily work allocator and existing reward queue.
// Preparing the clock issues nothing. Closed UTC days are recognized once;
// missing work retains that day's backing instead of moving it to another day.
import assert from 'node:assert/strict';
import {exact,hash,integer,hex} from '../crypto.mjs';
import {amount} from '../payment-model.mjs';
import {START,END,DAY,inspectAnnualPlan,cumulativeNodeAllowance,dailyNodePool} from './calendar-node-emission-policy.mjs';
import {SMOOTH_EMISSION,compileOrdinaryCurve} from './smooth-emission.mjs';
export const CALENDAR_SERVICE='DUEBYTE_CALENDAR_SERVICE_SOURCE_V1';
export function calendarSource(s){return s.rewards?.calendarService??null;}
export function calendarSourceCeiling(s,at=s.money.time){
 if(!calendarSource(s))return 0n;
 return netAllowance(s,Math.max(START,Math.min(END,Math.floor(at/DAY)*DAY)));
}
function netAllowance(s,at){
 const annual=s.economicPreparation.plan.annualRegularMicro;
 const gross=s.centuryFees?.ordinaryCurve===SMOOTH_EMISSION?compileOrdinaryCurve(annual).cumulative(at):cumulativeNodeAllowance(annual,at);
 const advance=amount(calendarSource(s)?.advanceMicro??'0');return gross>advance?gross-advance:0n;
}
export const calendarDayPool=(s,day)=>String(netAllowance(s,day+DAY)-netAllowance(s,day));
export function calendarServiceIssued(s){return amount(calendarSource(s)?.mintedMicro??'0');}
export function prepareCalendarSource(s,certificateHash,advanceMicro){
 assert(s.rewards&&!s.centurySubsidy&&!s.rewards.scheduled,'one node calendar source only');
 assert.equal(s.rewards.coefficients.lifetimeMintLimit,'0','legacy work mint must remain disabled');
 assert.equal(s.rewards.minted,'0','reconcile previous node emission before calendar preparation');
 const p=s.economicPreparation;assert(p&&p.planHash===hash(p.plan));const schedule=inspectAnnualPlan(p.plan.annualRegularMicro);
 assert(!calendarSource(s));hex(certificateHash);
 if(advanceMicro!==undefined)amount(advanceMicro);
 s.rewards.calendarService={version:CALENDAR_SERVICE,start:START,end:END,planHash:p.planHash,annualHash:schedule.annualHash,certificateHash,nextMintDay:START,mintedMicro:'0',creditedMicro:'0',heldMicro:'0',...(advanceMicro!==undefined?{advanceMicro}:{})};
}
export function auditCalendarSource(s){
 const c=calendarSource(s);if(!c)return;
 exact(c,['version','start','end','planHash','annualHash','certificateHash','nextMintDay','mintedMicro','creditedMicro','heldMicro',...(c.advanceMicro!==undefined?['advanceMicro']:[])]);
 if(c.advanceMicro!==undefined){amount(c.advanceMicro);assert.equal(c.advanceMicro,s.centuryFunds?.mainProgramme?.body.baseline.supportIssuedMicro,'joint advance accounting required');}
 assert.equal(c.version,CALENDAR_SERVICE);assert.equal(c.start,START);assert.equal(c.end,END);hex(c.certificateHash);
 assert(!s.centurySubsidy,'legacy subsidy cannot overlap calendar service');assert.equal(c.planHash,s.economicPreparation?.planHash);assert.equal(hash(s.economicPreparation.plan),c.planHash);
 assert.equal(s.rewards.coefficients.lifetimeMintLimit,'0','legacy mint overlap');assert(!s.rewards.scheduled,'calendar coefficients must not change through legacy scheduling');
 const p=s.economicPreparation.plan.annualRegularMicro;assert.equal(c.annualHash,inspectAnnualPlan(p).annualHash);
 integer(c.nextMintDay,START);assert(c.nextMintDay<=END&&c.nextMintDay%DAY===0);
 assert(c.nextMintDay<=Math.max(START,Math.floor(s.money.time/DAY)*DAY),'calendar issuance before closed day');
 assert.equal(amount(c.mintedMicro),netAllowance(s,c.nextMintDay),'calendar issued cursor');
 assert.equal(amount(c.mintedMicro),amount(c.creditedMicro)+amount(c.heldMicro),'calendar custody conservation');
 assert.equal(s.rewards.minted,c.mintedMicro,'single ordinary node issuance counter');
 assert(amount(s.money.supply)<=amount(s.economicPreparation.plan.capMicro),'supply cap');
}
export function issueClosedServiceDay(s,day){
 const c=calendarSource(s);assert(c&&day===c.nextMintDay,'consecutive calendar day');assert(day+DAY<=s.money.time&&day<END,'closed calendar day required');
 const value=amount(calendarDayPool(s,day));
 const supply=String(amount(s.money.supply)+value),fees=String(amount(s.money.fees)+value),minted=String(amount(c.mintedMicro)+value),held=String(amount(c.heldMicro)+value);
 for(const n of [supply,fees,minted,held])amount(n);assert(amount(supply)<=amount(s.economicPreparation.plan.capMicro));
 s.money.supply=supply;s.money.fees=fees;c.mintedMicro=minted;c.heldMicro=held;c.nextMintDay+=DAY;s.rewards.minted=minted;auditCalendarSource(s);return value;
}
export function creditCalendarService(s,rows){
 const c=calendarSource(s);assert(c);assert(Array.isArray(rows)&&rows.length>0&&rows.length<=32);let last='',sum=0n;
 const earned=[];for(const row of rows){exact(row,['node','valueMicro']);hex(row.node);assert(row.node>last);last=row.node;const n=s.rewards.nodes[row.node];assert(n);sum+=amount(row.valueMicro);const next=String(amount(n.earned)+amount(row.valueMicro));amount(next);earned.push([n,next]);}
 assert(sum<=amount(c.heldMicro),'unbacked calendar credit');for(const [n,v]of earned)n.earned=v;
 c.heldMicro=String(amount(c.heldMicro)-sum);c.creditedMicro=String(amount(c.creditedMicro)+sum);auditCalendarSource(s);
}
