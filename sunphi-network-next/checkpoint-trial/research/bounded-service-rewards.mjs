// Finite, preissued daily service rewards in the existing authenticated state.
// No caller supplies a payout table, allocation root or destination wallet.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,verify} from '../crypto.mjs';
import {validatorQuorum} from '../authority.mjs';
import {developmentManager} from '../reserve-recovery.mjs';
import {amount,centuryWarmup,terminalProgramFee} from '../payment-model.mjs';
import {WORK_UNITS,paymentWorkUnits} from '../reward-work-budget.mjs';
import {admissionAt} from './bounded-paid-admission.mjs';
import {changeRadix,radixIds,radixCount} from './bounded-radix-index.mjs';
import {pilotFundingPlan} from './service-reward-funding.mjs';
import {DAY,START,END,dailyNodePool,inspectAnnualPlan} from './calendar-node-emission-policy.mjs';
import {prepareCalendarSource,auditCalendarSource,calendarSource,calendarDayPool,issueClosedServiceDay,creditCalendarService} from './calendar-service-custody.mjs';
import {reserveServiceCustody,creditServiceCustody} from './service-custody.mjs';
import {SERVICE_WORK,serviceChallenge,validateServiceProfile,verifyServiceResponse} from './service-work-measurement.mjs';
import {operatorPolicyActive,operatorFactor} from './operator-reward-policy.mjs';
import {newAdjustment,advanceAdjustment,finalServiceCredit,removeAdjustment,isAdjustmentRecord,auditAdjustment} from './operator-reward-allocation.mjs';

import {isReserveDay,prepareTrialReserve,openPayroll,releasePayroll,reserveWork,tariffMicro} from './network-reserve.mjs';
export const ENABLE_SERVICE='ENABLE_PREISSUED_SERVICE_V1',COMPLETE_SERVICE='COMPLETE_BASELINE_SERVICE_V1';
export const PREPARE_MAIN_SERVICE='PREPARE_MAIN_SERVICE_CALENDAR_V1';
export const SERVICE_HEAD='service-rewards/head',SERVICE_LIVE='service-rewards/live';
const prefix='service-rewards/',dayKey=d=>prefix+'days/'+d,workKey=(d,n)=>prefix+'work/'+d+'/'+n;
const index=d=>prefix+'index/'+d,creditKey=(d,n)=>prefix+'credits/'+d+'/'+n;
const rankIndex=d=>prefix+'rank/'+d,rankMembers=(d,r)=>prefix+'rank-members/'+d+'/'+r;
const receiptKey=(i,n)=>prefix+'receipts/'+i+'/'+n;
const anchorKey=t=>prefix+'anchors/'+t;
const taskIndex=d=>prefix+'task-index/'+d;
const MAX=(1n<<256n)-1n,BATCH=32;
const rank=remainder=>(MAX-remainder).toString(16).padStart(64,'0');
const sorted=m=>[...m].sort(([a],[b])=>a<b?-1:a>b?1:0);
const isFundedDay=(h,d)=>d>=h.plan.from&&d<h.plan.to||!!h.main&&d>=START&&d<END;
const programmeEnd=h=>h.main?END:h.plan.to;
const nextDay=(h,d)=>h.main&&d+DAY===h.plan.to?START:d+DAY;
const dayPool=(h,s,day,record)=>isReserveDay(s,day)?record.totalUnits:day<START?h.plan.dailyMicro:calendarDayPool(s,day);
export function operatorPayroll(get,s,node){
 const head=checkedHead(get),day=head?.nextDay-DAY;
 if(!isReserveDay(s,day))return null;
 const period=get(dayKey(day));
 if(period?.phase!=='COMPLETE'||period.cleanup)return null;
 const account=get(workKey(day,node)),kind=s.rewards.nodes[node]?.kind;
 if(!account||!kind)return null;
 const readiness=tariffMicro(kind,account.intervals,0,head.profile.intervalSeconds);
 return {day,intervals:account.intervals,jobs:account.jobs,readinessMicro:String(readiness),jobMicro:String(BigInt(account.units)-readiness),totalMicro:account.units};
}
export function serviceProfile(coefficients){
 return {version:SERVICE_WORK,intervalSeconds:3600,responseSeconds:180,workerUnits:String(WORK_UNITS),witnessUnits:String(WORK_UNITS),workerWeight:coefficients.workerWeight,witnessWeight:coefficients.witnessWeight};
}
function checkedHead(get){
 const h=get(SERVICE_HEAD);if(!h)return null;
 exact(h,['version','plan','profile','activationHash','nextDay','cleanupDay','creditedMicro',...(h.main?['main']:[])]);assert.equal(h.version,ENABLE_SERVICE);
 assert.deepEqual(h.plan,pilotFundingPlan(h.plan));validateServiceProfile(h.profile);hex(h.activationHash);
 if(h.main){exact(h.main,['certificateHash']);hex(h.main.certificateHash);}
 assert.deepEqual(h.profile,serviceProfile(h.profile));integer(h.nextDay,h.plan.from);assert(h.nextDay<=programmeEnd(h)&&h.nextDay%DAY===0);assert(h.nextDay<=h.plan.to||h.nextDay>=START);integer(h.cleanupDay,h.plan.from);assert(h.cleanupDay<=h.nextDay&&h.cleanupDay%DAY===0);amount(h.creditedMicro);assert(amount(h.creditedMicro)<=amount(h.plan.budgetMicro));return h;
}
export function auditServiceBinding(get,s){
 const h=checkedHead(get);if(!h)return;
 const f=s.centuryWarmup?.serviceFunding;assert(f,'daily rewards require existing reserved custody');
 assert.equal(f.spentMicro,h.creditedMicro,'service spent cursor');
 assert.equal(amount(f.reservedMicro)+amount(f.spentMicro),amount(h.plan.budgetMicro),'finite service reservation');
 assert.equal(Boolean(h.main),Boolean(calendarSource(s)),'calendar source binding');if(h.main){assert.equal(h.main.certificateHash,calendarSource(s).certificateHash);auditCalendarSource(s);}
}
export function prepareMainService(s,a,c,tx){
 // The live partial pilot needs a separately qualified joint fund/clock
 // transition. A calendar-only certificate must never bypass its mint guard.
 assert(!s.centuryFunds?.zeroStage,'joint main-programme transition required for the partial pilot');
 exact(a,['type','certificate','founderConsent']);assert.equal(a.type,PREPARE_MAIN_SERVICE);exact(a.certificate,['body','approvals']);const b=a.certificate.body,h=checkedHead(tx.get);assert(h,'shared work protocol must be prepared first');
 exact(b,['domain','network','configHash','generation','managementEpoch','notBefore','expires','start','planHash','annualHash','profileHash']);
 assert.equal(b.domain,PREPARE_MAIN_SERVICE);assert.equal(b.network,c.chainId);assert.equal(b.configHash,s.configHash);assert.equal(b.configHash,hash(c));assert.equal(b.generation,s.authority.generation);assert(!s.authority.pending);
 const access=s.networkReserves?.development?.access;assert(access&&!access.pending);assert.equal(b.managementEpoch,access.epoch);
 validatorQuorum(b,a.certificate.approvals,s.authority.validators);assert(verify(b,a.founderConsent,developmentManager(s.networkReserves)),'founder calendar consent');
 if(h.main){assert.equal(h.main.certificateHash,hash(b),'main calendar already prepared');return s;}
 integer(b.notBefore,1);integer(b.expires,b.notBefore+1);assert(b.expires-b.notBefore<=600&&s.money.time>=b.notBefore&&s.money.time<b.expires);assert(s.money.time<START,'prepare main calendar before common launch');
 assert.equal(b.start,START);assert.equal(b.planHash,s.economicPreparation.planHash);assert.equal(b.annualHash,inspectAnnualPlan(s.economicPreparation.plan.annualRegularMicro).annualHash);assert.equal(b.profileHash,hash(h.profile));
 prepareCalendarSource(s,hash(b));prepareTrialReserve(calendarSource(s),c);h.main={certificateHash:hash(b)};if(h.nextDay===h.plan.to)h.nextDay=START;tx.set(SERVICE_HEAD,h);return s;
}
export function enablePreissuedService(s,a,c,tx){
 exact(a,['type','certificate','founderConsent']);assert.equal(a.type,ENABLE_SERVICE);exact(a.certificate,['body','approvals']);const b=a.certificate.body;
 exact(b,['domain','network','configHash','generation','managementEpoch','notBefore','expires','plan','profile']);
 assert.equal(b.domain,ENABLE_SERVICE);assert.equal(b.network,c.chainId);assert.equal(b.configHash,s.configHash);assert.equal(b.configHash,hash(c));
 assert.equal(b.generation,s.authority.generation);assert(!s.authority.pending,'validator transition pending');
 const access=s.networkReserves?.development?.access;assert(access&&!access.pending,'stable source management required');assert.equal(b.managementEpoch,access.epoch);
 validatorQuorum(b,a.certificate.approvals,s.authority.validators);assert(verify(b,a.founderConsent,developmentManager(s.networkReserves)),'founder service consent');
 const old=checkedHead(tx.get);if(old){assert.equal(old.activationHash,hash(b),'service schedule already committed');return s;}
 integer(b.notBefore,1);integer(b.expires,b.notBefore+1);assert(b.expires-b.notBefore<=600&&s.money.time>=b.notBefore&&s.money.time<b.expires,'service activation inclusion window');
 assert.deepEqual(b.plan,pilotFundingPlan(b.plan));assert(b.plan.from>s.money.time,'prospective complete UTC days');
 assert(s.rewards&&!s.rewards.scheduled&&!s.centurySubsidy,'stable preissued service accounting required');
 assert.deepEqual(b.profile,serviceProfile(s.rewards.coefficients),'preserve existing normalized work coefficients');
 assert(!s.centuryWarmup?.serviceFunding,'source already reserved');reserveServiceCustody(s,b.plan.budgetMicro);
 tx.set(SERVICE_HEAD,{version:ENABLE_SERVICE,plan:b.plan,profile:b.profile,activationHash:hash(b),nextDay:b.plan.from,cleanupDay:b.plan.from,creditedMicro:'0'});tx.set(SERVICE_LIVE,{anchors:[]});return s;
}
// Spread all participants across the hour. A shared minute anchor needs only
// the existing three-minute proof-retention window, not hour-long WAL pins.
export function serviceSlot(configHash,node,intervalStart,profile){
 hex(node);integer(intervalStart,1);const slots=Math.floor((profile.intervalSeconds-profile.responseSeconds)/60);
 return intervalStart+60*Number(BigInt('0x'+hash({domain:SERVICE_WORK+'/SLOT',configHash,node,intervalStart}))%BigInt(slots));
}
function assignment(get,h,configHash,node,kind,now){
 const intervalStart=Math.floor(now/h.profile.intervalSeconds)*h.profile.intervalSeconds;
 const day=Math.floor(intervalStart/DAY)*DAY;if(!isFundedDay(h,day))return null;
 const slot=serviceSlot(configHash,node,intervalStart,h.profile),anchor=get(anchorKey(slot));
 if(!anchor)return {status:now<slot?'WAITING':'MISSED',intervalStart,slot};
 const key=kind==='worker'&&anchor.events>0?'payment-events/'+Number(BigInt('0x'+hash({domain:SERVICE_WORK+'/ARCHIVE',node,root:anchor.root}))%BigInt(anchor.events)):'meta/blockHead';
 return {status:now>anchor.openedAt+h.profile.responseSeconds?'EXPIRED':'ASSIGNED',intervalStart,slot,anchor,key};
}
export function serviceWorkView(get,{configHash,node,kind,time,reserve=false}){
 const h=checkedHead(get);if(!h)return null;
 const a=assignment(get,h,configHash,node,kind,time);if(!a)return {status:'OUTSIDE_FUNDED_SCHEDULE',plan:h.plan};
 const receipt=get(receiptKey(a.intervalStart,node));
 const day=Math.floor(time/DAY)*DAY;
 if(reserve&&day>=START&&!receipt){
  const payroll=get(dayKey(day))?.payroll,earned=get(workKey(day,node));
  if(!payroll||!reserveWork(structuredClone(payroll),earned,kind,false,h.profile.intervalSeconds))return {status:'OUTSIDE_FUNDED_SCHEDULE',intervalStart:a.intervalStart,plan:h.plan};
 }
 return {...a,...(receipt?{status:'ACCEPTED',receipt}:{}),profile:h.profile,plan:h.plan};
}
function eligible(get,s,node,openedAt){
 const n=s.rewards?.nodes[node];assert(n,'registered service worker required');
 // Explicit paid admission is required for BOTH roles, including own servers.
 const then=admissionAt(get,node,openedAt),now=admissionAt(get,node,s.money.time);
 assert(then?.kind===n.kind&&now?.kind===n.kind,'paid-service admission required');
 if(n.kind==='worker')assert(s.money.nodes[node]&&amount(s.money.nodes[node].stake)>0n,'active collateralized server required');
 return n;
}
function emptyDay(day){return {day,phase:'COLLECTING',totalUnits:'0',count:0,after:null,baseMicro:'0',bonusLeft:0,rankAfter:null,memberAfter:null,creditedMicro:'0'};}
function addUnits(tx,day,node,units,kind,s,h,job=false){
 if(isReserveDay(s,day)){
  const d=tx.get(dayKey(day)),key=workKey(day,node),old=tx.get(key);
  if(!d || d.phase!=='COLLECTING')return false;
  const next=reserveWork(d.payroll,old,kind,job,h.profile.intervalSeconds);
  if(!next)return false;
  if(!old){changeRadix(tx,index(day),node,true);d.count++;}
  d.totalUnits=String(BigInt(d.totalUnits)+BigInt(next.units)-BigInt(old?.units??'0'));
  assert(BigInt(d.totalUnits)<=BigInt(d.payroll.budgetMicro));
  tx.set(key,next);tx.set(dayKey(day),d);return true;
 }
 assert(units>0n&&units<=MAX);let d=tx.get(dayKey(day))??emptyDay(day);assert.equal(d.phase,'COLLECTING','closed service work day');
 const k=workKey(day,node),old=tx.get(k);if(!old){changeRadix(tx,index(day),node,true);d.count++;}
 const total=BigInt(old?.units??'0')+units;assert(total<=MAX);const policyActive=operatorPolicyActive(tx.get,day),factor=old?.factor??(kind==='worker'&&policyActive?operatorFactor(tx.get,node,day):undefined);tx.set(k,{units:String(total),...(factor!==undefined?{factor}:{})});d.totalUnits=String(BigInt(d.totalUnits)+units);assert(BigInt(d.totalUnits)<=(policyActive?MAX/4n:MAX),'service work arithmetic bound');tx.set(dayKey(day),d);
}
export function completeBaselineService(s,a,author,tx){
 exact(a,['type','node','intervalStart','response']);assert.equal(a.type,COMPLETE_SERVICE);hex(a.node);integer(a.intervalStart,1);
 const h=checkedHead(tx.get);assert(h,'daily service not activated');const old=tx.get(receiptKey(a.intervalStart,a.node));
 if(old){assert.equal(old.responseHash,hash(a.response),'conflicting service retry');assert.equal(old.publicKey,author,'work author');return s;}
 assert.equal(a.intervalStart,Math.floor(s.money.time/h.profile.intervalSeconds)*h.profile.intervalSeconds,'current service interval required');
 const n=s.rewards?.nodes[a.node];assert(n&&n.key===author,'work author');
 const v=assignment(tx.get,h,s.configHash,a.node,n.kind,s.money.time);assert(v?.status==='ASSIGNED','service not assigned or expired');eligible(tx.get,s,a.node,v.anchor.openedAt);
 const challenge=serviceChallenge({configHash:s.configHash,profile:h.profile,node:a.node,kind:n.kind,intervalStart:a.intervalStart,openedAt:v.anchor.openedAt,anchorHeight:v.anchor.height,anchorRoot:v.anchor.root,key:v.key,valueHash:hash(a.response.proof?.value)});
 const r=verifyServiceResponse({challenge,profile:h.profile,publicKey:n.key,eligible:true,response:a.response,acceptedAt:s.money.time});
 assert(addUnits(tx,r.day,a.node,BigInt(r.weightedUnits),n.kind,s,h)!==false,'no funded service slot');tx.set(receiptKey(a.intervalStart,a.node),{...r,publicKey:n.key});return s;
}
export function recordServicePaymentWork(s,pid,request,tx){
 const h=checkedHead(tx.get),day=Math.floor(s.money.time/DAY)*DAY;
 if(!h||!isFundedDay(h,day)||centuryWarmup(request.intent)||terminalProgramFee(request.intent)||request.intent.sender===request.intent.recipient)return;
 const key=prefix+'tasks/'+pid;assert(!tx.get(key),'service task already accounted');const rows=[];
 for(const [node,units]of Object.entries(paymentWorkUnits(request.intent)).sort(([a],[b])=>a<b?-1:1)){
  if(admissionAt(tx.get,node,s.money.time)?.kind!=='worker')continue;
  const weighted=BigInt(units)*BigInt(h.profile.workerWeight);if(!weighted)continue;
  if(addUnits(tx,day,node,weighted,'worker',s,h,true)!==false)rows.push({node,units:String(weighted)});
 }tx.set(key,{day,rows,digest:request.digest});changeRadix(tx,taskIndex(day),pid,true);
}
function nextIds(get,kind,after,limit=BATCH){return [...radixIds(get,kind,{after,limit})];}
// Closed-day details remain recoverable from the immutable consensus journal.
// Keep its pre-pruning authenticated root/height and a deterministic removal
// commitment in the small day summary. Cleanup shares the block transaction:
// a crash cannot persist deletions without advancing their accounting cursor.
function cleanupServiceDay(s,tx,h,parentRoot,parentHeight){
 const day=h.cleanupDay;if(day>=h.nextDay||s.money.time<day+3*DAY)return;
 const d=tx.get(dayKey(day));assert(d&&['COMPLETE','RECONCILIATION_REQUIRED'].includes(d.phase));
 const c=d.cleanup??{root:parentRoot,height:parentHeight,after:null,count:0,units:'0',base:'0',bonuses:0,paid:'0',commitment:hash({domain:SERVICE_WORK+'/ARCHIVE',day,root:parentRoot,height:parentHeight}),anchorNext:day,done:false};
 assert(!c.done);const remove=k=>{const v=tx.get(k);if(v!==undefined&&v!==null){c.commitment=hash({previous:c.commitment,key:k,value:v});tx.delete(k);}};
 const ids=nextIds(tx.get,index(day),null,8);
 if(ids.length){for(const node of ids){
  const w=tx.get(workKey(day,node)),credit=tx.get(creditKey(day,node));assert(w&&credit);const r=rank(BigInt(credit.remainder));
  for(let t=day;t<day+DAY;t+=h.profile.intervalSeconds)remove(receiptKey(t,node));
  c.units=String(BigInt(c.units)+BigInt(w.units));c.base=String(BigInt(c.base)+BigInt(credit.baseMicro));c.bonuses+=Number(credit.bonus);c.paid=String(BigInt(c.paid)+finalServiceCredit(tx.get,day,node,credit));c.count++;c.after=node;
  removeAdjustment(tx,day,node,remove);
  remove(workKey(day,node));remove(creditKey(day,node));changeRadix(tx,index(day),node,false);changeRadix(tx,rankMembers(day,r),node,false);if(!radixCount(tx.get,rankMembers(day,r)))changeRadix(tx,rankIndex(day),r,false);
 }}else{
  const tasks=nextIds(tx.get,taskIndex(day),null);
  if(tasks.length){for(const pid of tasks){remove(prefix+'tasks/'+pid);changeRadix(tx,taskIndex(day),pid,false);}}
  else{let left=BATCH;while(left--&&c.anchorNext<day+DAY){remove(anchorKey(c.anchorNext));c.anchorNext+=60;}
   if(c.anchorNext===day+DAY){assert.equal(c.count,d.count);assert.equal(c.units,d.totalUnits);assert.equal(c.paid,d.creditedMicro);c.done=true;h.cleanupDay=nextDay(h,day);}
  }
 }
 d.cleanup=c;tx.set(dayKey(day),d);tx.set(SERVICE_HEAD,h);
}
// At most one bounded allocation page per block. State, source debit and reward
// credits are committed together; the cursor cannot outrun its monetary effects.
export function advanceServiceRewards(s,tx,parentRoot,parentHeight){
 const h=checkedHead(tx.get);if(!h)return s;const now=s.money.time;
 const calendar=calendarSource(s);if(calendar&&calendar.nextMintDay<END&&now>=calendar.nextMintDay+DAY)issueClosedServiceDay(s,calendar.nextMintDay);
 const today=Math.floor(now/DAY)*DAY;
 if(isReserveDay(s,today)&&calendar.nextMintDay===today&&!tx.get(dayKey(today))){
  const d=emptyDay(today),payroll=openPayroll(calendar);if(payroll)d.payroll=payroll;tx.set(dayKey(today),d);
 }
 if(isFundedDay(h,today)){
  const minute=Math.floor(now/60)*60,key=anchorKey(minute),interval=Math.floor(now/h.profile.intervalSeconds)*h.profile.intervalSeconds;
  if(!tx.get(key)&&now<interval+h.profile.intervalSeconds-h.profile.responseSeconds){
   const anchor={slot:minute,openedAt:now,root:parentRoot,height:parentHeight,events:tx.get('meta/paymentEvents')?.count??0};
   tx.set(key,anchor);const live=tx.get(SERVICE_LIVE);live.anchors=live.anchors.filter(a=>a.openedAt+h.profile.responseSeconds>=now);live.anchors.push(anchor);assert(live.anchors.length<=4);tx.set(SERVICE_LIVE,live);
  }
 }
 // Also expire the last live anchors when a finite programme has ended.
 const live=tx.get(SERVICE_LIVE),fresh=live.anchors.filter(a=>a.openedAt+h.profile.responseSeconds>=now);if(fresh.length!==live.anchors.length)tx.set(SERVICE_LIVE,{anchors:fresh});
 cleanupServiceDay(s,tx,h,parentRoot,parentHeight);
 if(h.nextDay>=programmeEnd(h)||now<h.nextDay+DAY)return s;
 const day=h.nextDay;if(day>=START&&day>=calendar.nextMintDay)return s;
 const d=tx.get(dayKey(day))??emptyDay(day),pool=BigInt(dayPool(h,s,day,d));
 if(d.phase==='COLLECTING'){
  if(d.count===0){if(d.payroll)releasePayroll(calendar,BigInt(d.payroll.budgetMicro));d.phase=isReserveDay(s,day)?'COMPLETE':'RECONCILIATION_REQUIRED';tx.set(dayKey(day),d);h.nextDay=nextDay(h,day);tx.set(SERVICE_HEAD,h);return s;}
  assert.equal(d.count,radixCount(tx.get,index(day)));d.phase='BASE';
 }
 if(d.phase==='BASE'){
  const ids=nextIds(tx.get,index(day),d.after),total=BigInt(d.totalUnits);
  for(const node of ids){const u=BigInt(tx.get(workKey(day,node)).units),base=pool*u/total,remainder=pool*u%total,r=rank(remainder);
   const members=rankMembers(day,r);if(!radixCount(tx.get,members))changeRadix(tx,rankIndex(day),r,true);changeRadix(tx,members,node,true);
   tx.set(creditKey(day,node),{baseMicro:String(base),remainder:String(remainder),bonus:false});d.baseMicro=String(BigInt(d.baseMicro)+base);d.after=node;
  }
  if(ids.length<BATCH||nextIds(tx.get,index(day),d.after,1).length===0){d.phase='BONUS';d.after=null;d.bonusLeft=Number(pool-BigInt(d.baseMicro));assert(d.bonusLeft>=0&&d.bonusLeft<d.count);}
 }else if(d.phase==='BONUS'){
  let left=BATCH;
  while(left&&d.bonusLeft){
   const r=d.memberAfter!==null?d.rankAfter:nextIds(tx.get,rankIndex(day),d.rankAfter,1)[0];assert(r,'missing remainder bucket');
   const ids=nextIds(tx.get,rankMembers(day,r),d.memberAfter,Math.min(left,d.bonusLeft));assert(ids.length);
   for(const node of ids){const c=tx.get(creditKey(day,node));assert(!c.bonus);c.bonus=true;tx.set(creditKey(day,node),c);d.bonusLeft--;left--;d.memberAfter=node;}
   d.rankAfter=r;if(!nextIds(tx.get,rankMembers(day,r),d.memberAfter,1).length)d.memberAfter=null;
  }
  if(!d.bonusLeft){d.phase=!isReserveDay(s,day)&&operatorPolicyActive(tx.get,day)?'ADJUST':'PAY';if(d.phase==='ADJUST')d.adjustment=newAdjustment();d.after=null;}
 }else if(d.phase==='ADJUST'){
  if(advanceAdjustment(tx,day,d.adjustment,{ids:(after,limit)=>nextIds(tx.get,index(day),after,limit),work:n=>tx.get(workKey(day,n)),credit:n=>tx.get(creditKey(day,n))}))d.phase='PAY';
 }else if(d.phase==='PAY'){
  const ids=nextIds(tx.get,index(day),d.after),rows=ids.map(node=>{const c=tx.get(creditKey(day,node));return {node,valueMicro:String(finalServiceCredit(tx.get,day,node,c))};});assert(rows.length);
  const sum=rows.reduce((v,r)=>v+BigInt(r.valueMicro),0n);if(day<START){creditServiceCustody(s,rows,String(sum));h.creditedMicro=String(BigInt(h.creditedMicro)+sum);}else{if(d.payroll)releasePayroll(calendar,sum);creditCalendarService(s,rows);}
  d.creditedMicro=String(BigInt(d.creditedMicro)+sum);d.after=ids.at(-1);
  if(ids.length<BATCH||nextIds(tx.get,index(day),d.after,1).length===0){assert.equal(BigInt(d.creditedMicro),pool);if(d.payroll)releasePayroll(calendar,BigInt(d.payroll.budgetMicro)-pool);d.phase='COMPLETE';h.nextDay=nextDay(h,day);}
  tx.set(SERVICE_HEAD,h);
 }
 tx.set(dayKey(day),d);return s;
}

export function isServiceRecord(key){return isAdjustmentRecord(key)||/^service-rewards\/(head|live|anchors\/[1-9][0-9]*|days\/[1-9][0-9]*|(work|credits|receipts)\/[1-9][0-9]*\/[a-f0-9]{64}|tasks\/[a-f0-9]{64}|(index|rank|task-index)\/[1-9][0-9]*\/(root|[a-f0-9]{1,64})|rank-members\/[1-9][0-9]*\/[a-f0-9]{64}\/(root|[a-f0-9]{1,64}))$/.test(key);}

// Expensive census is explicitly offline. Hot paths use keyed reads only.
export function auditServiceRewards(records,s){
 const get=k=>records.get(k),h=checkedHead(get),rows=new Map([...records].filter(([k])=>k.startsWith(prefix)));
 if(!h){assert.equal(rows.size,0,'orphan service records');return;}auditServiceBinding(get,s);
 const expected=new Map(),tx={get:k=>expected.get(k),set:(k,v)=>expected.set(k,v),delete:k=>expected.delete(k)},units=new Map();
 const evidence=new Map();
 const add=(day,node,value,job=false)=>{assert(isFundedDay(h,day)&&day%DAY===0);assert(s.rewards.nodes[node]);const c=get(dayKey(day))?.cleanup;if(c?.after&&node<=c.after)return;const k=workKey(day,node);if(isReserveDay(s,day)){const e=evidence.get(k)??{intervals:0,jobs:0};if(job)e.jobs++;else e.intervals++;evidence.set(k,e);units.set(k,tariffMicro(s.rewards.nodes[node].kind,e.intervals,e.jobs,h.profile.intervalSeconds));}else units.set(k,(units.get(k)??0n)+value);};
 expected.set(SERVICE_HEAD,h);const live=get(SERVICE_LIVE);exact(live,['anchors']);assert(Array.isArray(live.anchors)&&live.anchors.length<=4);let last=0;
 for(const a of live.anchors){assert(a.slot>last);assert.deepEqual(get(anchorKey(a.slot)),a);last=a.slot;}expected.set(SERVICE_LIVE,live);
 for(const [k,v]of rows){
  assert(isServiceRecord(k));
  if(k.startsWith(prefix+'anchors/')){const c=get(dayKey(Math.floor(v.slot/DAY)*DAY))?.cleanup;if(c)assert(v.slot>=c.anchorNext,'pruned anchor returned');}
  if(k.startsWith(prefix+'receipts/')){const c=get(dayKey(v.day))?.cleanup;if(c?.after)assert(v.node>c.after,'pruned receipt returned');}
  if(k.startsWith(prefix+'tasks/'))changeRadix(tx,taskIndex(v.day),k.slice((prefix+'tasks/').length),true);
  if(k.startsWith(prefix+'anchors/')){exact(v,['slot','openedAt','root','height','events']);assert.equal(k,anchorKey(v.slot));integer(v.slot,h.plan.from);assert(isFundedDay(h,Math.floor(v.slot/DAY)*DAY)&&v.slot%60===0);integer(v.openedAt,v.slot);assert(v.openedAt<v.slot+60);integer(v.height,1);integer(v.events);hex(v.root);expected.set(k,v);}
  if(k.startsWith(prefix+'receipts/')){
   exact(v,['domain','configHash','profileHash','node','kind','day','intervalStart','challengeHash','responseHash','rawUnits','weightedUnits','acceptedAt','publicKey']);
   assert.equal(v.domain,SERVICE_WORK+'/ACCEPTED');assert.equal(v.configHash,s.configHash);assert.equal(v.profileHash,hash(h.profile));assert.equal(k,receiptKey(v.intervalStart,v.node));assert.equal(v.day,Math.floor(v.intervalStart/DAY)*DAY);assert.equal(v.intervalStart%h.profile.intervalSeconds,0);
   assert(['worker','witness'].includes(v.kind));hex(v.challengeHash);hex(v.responseHash);assert.equal(v.rawUnits,h.profile[v.kind==='worker'?'workerUnits':'witnessUnits']);assert.equal(BigInt(v.weightedUnits),BigInt(v.rawUnits)*BigInt(h.profile[v.kind==='worker'?'workerWeight':'witnessWeight']));
   const a=get(anchorKey(serviceSlot(s.configHash,v.node,v.intervalStart,h.profile)));assert(a);integer(v.acceptedAt,a.openedAt);assert(v.acceptedAt<=a.openedAt+h.profile.responseSeconds);add(v.day,v.node,BigInt(v.weightedUnits));expected.set(k,v);
  }
  if(k.startsWith(prefix+'tasks/')){exact(v,['day','rows','digest']);hex(v.digest);const r=s.money.requests[k.slice((prefix+'tasks/').length)];assert(r?.status==='SETTLED'&&r.digest===v.digest);assert(!centuryWarmup(r.intent)&&!terminalProgramFee(r.intent)&&r.intent.sender!==r.intent.recipient);const measured=paymentWorkUnits(r.intent);let prev='';for(const row of v.rows){exact(row,['node','units']);assert(row.node>prev);prev=row.node;assert.equal(BigInt(row.units),BigInt(measured[row.node])*BigInt(h.profile.workerWeight));add(v.day,row.node,BigInt(row.units),true);}expected.set(k,v);}
 }
 for(const [k,v]of sorted(units)){assert(v>0n&&v<=MAX);const [, ,day,node]=k.split('/'),w=get(k),active=!isReserveDay(s,Number(day))&&operatorPolicyActive(get,Number(day))&&s.rewards.nodes[node].kind==='worker';if(active)assert([2,3,4].includes(w.factor));else assert.equal(w.factor,undefined);expected.set(k,{...evidence.get(k),units:String(v),...(active?{factor:w.factor}:{})});changeRadix(tx,index(Number(day)),node,true);}
 let spent=0n,calendarSpent=0n,committed=0n;
 for(const [k,d]of rows)if(k.startsWith(prefix+'days/')){
  exact(d,[...Object.keys(emptyDay(d.day)),...(d.payroll?['payroll']:[]),...(d.cleanup?['cleanup']:[]),...(d.adjustment?['adjustment']:[])]);assert.equal(k,dayKey(d.day));assert(isFundedDay(h,d.day)&&d.day%DAY===0);
  const ids=[...radixIds(tx.get,index(d.day))],total=ids.reduce((n,id)=>n+BigInt(tx.get(workKey(d.day,id)).units),0n);
  if(isReserveDay(s,d.day)){
   assert(!d.adjustment);
   if(d.payroll){
    const p=d.payroll;exact(p,['budgetMicro','worker','witness','jobs']);assert.equal(p.budgetMicro,'100000000');integer(p.worker);integer(p.witness);integer(p.jobs);
    assert(p.worker<=10&&p.witness<=4&&p.jobs<=280&&BigInt(d.totalUnits)<=BigInt(p.budgetMicro));
    if(!d.cleanup){const counts={worker:0,witness:0,jobs:0};for(const id of ids){const e=evidence.get(workKey(d.day,id));if(e.intervals)counts[s.rewards.nodes[id].kind]++;counts.jobs+=e.jobs;}for(const field of Object.keys(counts))assert.equal(counts[field],p[field]);}
    if(d.phase!=='COMPLETE')committed+=BigInt(p.budgetMicro)-BigInt(d.creditedMicro);
   }else assert.equal(d.count,0);
  }else assert(!d.payroll);
  if(d.adjustment){assert(operatorPolicyActive(get,d.day));assert(['ADJUST','PAY','COMPLETE'].includes(d.phase));auditAdjustment(get,tx,d.day,d.adjustment,ids,n=>get(workKey(d.day,n)),n=>get(creditKey(d.day,n)),!!d.cleanup);if(d.phase!=='ADJUST')assert.equal(d.adjustment.phase,'DONE');}
  if(d.cleanup){
   const c=d.cleanup;exact(c,['root','height','after','count','units','base','bonuses','paid','commitment','anchorNext','done']);hex(c.root);hex(c.commitment);integer(c.height,1);assert(c.height<s.height);integer(c.count);integer(c.bonuses);assert(c.bonuses<=c.count);assert.equal(typeof c.done,'boolean');for(const f of ['units','base','paid'])amount(c[f]);
   assert(['COMPLETE','RECONCILIATION_REQUIRED'].includes(d.phase));assert(d.day<h.nextDay);assert.equal(c.count+ids.length,d.count);assert.equal(BigInt(c.units)+total,BigInt(d.totalUnits));assert.equal(Boolean(c.after),c.count>0);if(c.after){hex(c.after);assert(ids.every(n=>n>c.after));}
   integer(c.anchorNext,d.day);assert(c.anchorNext<=d.day+DAY&&(c.anchorNext-d.day)%60===0);if(c.anchorNext>d.day)assert.equal(ids.length+radixCount(tx.get,taskIndex(d.day)),0);
   const pool=d.phase==='COMPLETE'?BigInt(dayPool(h,s,d.day,d)):0n,allUnits=BigInt(d.totalUnits);let base=BigInt(c.base),bonuses=c.bonuses;
   for(const node of ids){const u=BigInt(tx.get(workKey(d.day,node)).units),b=pool*u/allUnits,remainder=pool*u%allUnits,r=rank(remainder),credit=get(creditKey(d.day,node));exact(credit,['baseMicro','remainder','bonus']);assert.equal(credit.baseMicro,String(b));assert.equal(credit.remainder,String(remainder));assert.equal(credit.bonus,d.rankAfter!==null&&(r<d.rankAfter||r===d.rankAfter&&(d.memberAfter===null||node<=d.memberAfter)));
    base+=b;bonuses+=Number(credit.bonus);if(!radixCount(tx.get,rankMembers(d.day,r)))changeRadix(tx,rankIndex(d.day),r,true);changeRadix(tx,rankMembers(d.day,r),node,true);expected.set(creditKey(d.day,node),credit);
   }
   assert.equal(base,BigInt(d.baseMicro));assert.equal(base+BigInt(bonuses),pool);if(!d.adjustment)assert.equal(BigInt(c.paid),BigInt(c.base)+BigInt(c.bonuses));assert.equal(BigInt(c.paid)+ids.reduce((v,n)=>v+finalServiceCredit(get,d.day,n,get(creditKey(d.day,n))),0n),pool);assert.equal(BigInt(d.creditedMicro),pool);assert.equal(d.bonusLeft,0);
   if(d.phase==='RECONCILIATION_REQUIRED')assert.equal(d.count,0);
   if(c.done){assert.equal(ids.length,0);assert.equal(radixCount(tx.get,taskIndex(d.day)),0);assert.equal(c.anchorNext,d.day+DAY);assert(d.day<h.cleanupDay);}else assert.equal(d.day,h.cleanupDay);
   if(d.day<START)spent+=pool;else calendarSpent+=pool;expected.set(k,d);continue;
  }
  assert(d.day>=h.cleanupDay,'missing cleanup summary');assert.equal(d.count,ids.length);assert.equal(d.totalUnits,String(total));
  assert(['COLLECTING','BASE','BONUS','ADJUST','PAY','COMPLETE','RECONCILIATION_REQUIRED'].includes(d.phase));
  if(d.phase==='COLLECTING'||d.phase==='RECONCILIATION_REQUIRED'){assert.deepEqual(d,{...emptyDay(d.day),...(d.payroll?{payroll:d.payroll}:{}),phase:d.phase,count:ids.length,totalUnits:String(total)});if(d.phase==='RECONCILIATION_REQUIRED')assert.equal(ids.length,0);}
  else{
   const selected=d.phase==='BASE'?ids.filter(n=>d.after!==null&&n<=d.after):ids;let bases=0n,bonuses=0,paid=0n;const pool=BigInt(dayPool(h,s,d.day,d)),ordered=[];
   for(const node of selected){const u=BigInt(tx.get(workKey(d.day,node)).units),base=pool*u/total,remainder=pool*u%total,r=rank(remainder),c=get(creditKey(d.day,node));assert(c);exact(c,['baseMicro','remainder','bonus']);assert.equal(c.baseMicro,String(base));assert.equal(c.remainder,String(remainder));assert.equal(typeof c.bonus,'boolean');if(d.phase==='BASE')assert(!c.bonus);bases+=base;bonuses+=Number(c.bonus);ordered.push({node,remainder,bonus:c.bonus});
    if(!radixCount(tx.get,rankMembers(d.day,r)))changeRadix(tx,rankIndex(d.day),r,true);changeRadix(tx,rankMembers(d.day,r),node,true);expected.set(creditKey(d.day,node),c);
    if(['PAY','COMPLETE'].includes(d.phase)&&d.after!==null&&node<=d.after)paid+=finalServiceCredit(get,d.day,node,c);
   }
   assert.equal(d.baseMicro,String(bases));ordered.sort((a,b)=>a.remainder===b.remainder?(a.node<b.node?-1:1):a.remainder>b.remainder?-1:1);ordered.forEach((r,i)=>assert.equal(r.bonus,i<bonuses,'canonical largest remainders'));
   if(d.phase!=='BASE'){assert.equal(BigInt(bonuses+d.bonusLeft),pool-bases);if(['PAY','COMPLETE'].includes(d.phase))assert.equal(d.bonusLeft,0);}
   assert.equal(d.creditedMicro,String(paid));if(d.phase==='COMPLETE')assert.equal(paid,pool);if(d.day<START)spent+=paid;else calendarSpent+=paid;
  }
  if(d.day<h.nextDay)assert(['COMPLETE','RECONCILIATION_REQUIRED'].includes(d.phase));else if(d.day>h.nextDay)assert.equal(d.phase,'COLLECTING');expected.set(k,d);
 }
 for(let day=h.plan.from;day<h.nextDay;day=nextDay(h,day))assert(expected.has(dayKey(day)),'missing closed service day');
 for(const k of units.keys()){const day=Number(k.split('/')[2]);assert(expected.has(dayKey(day)),'missing work day');}
 assert.equal(String(committed),calendarSource(s)?.reserve?.committedMicro??'0');assert.equal(h.creditedMicro,String(spent));assert.equal(calendarSource(s)?.creditedMicro??'0',String(calendarSpent));assert.deepEqual(sorted(expected),sorted(rows),'service census or indices differ');
}
