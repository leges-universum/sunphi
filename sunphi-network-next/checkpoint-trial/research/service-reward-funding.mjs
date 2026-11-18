// Source reservation for the shared daily work allocator. No mint, wallet key,
// public transaction route or second database. The caller must use the SAME
// authenticated transaction as custody debit and earned/payout accounting.
// Admission/profile governance and the monetary-interpreter adapter are separate.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,canonical} from '../crypto.mjs';
import {START,DAY,dailyNodePool} from './calendar-node-emission-policy.mjs';
import {verifyRecordProof} from './record-proof.mjs';

export const FUNDING='DUEBYTE_PREISSUED_SERVICE_FUNDING_V1';
export const PILOT_DAILY_MICRO='200000000'; // Explicit owner decision, 17 Nov 2026.
const micro=v=>{assert(typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)&&v.length<=32,'canonical micro amount');return BigInt(v);};
const day=t=>{integer(t,1);assert.equal(t%DAY,0,'UTC day boundary');return t;};
const prefix='service-funding/';
const headKey=prefix+'head';
const contributionHead=prefix+'contribution-total';
const receiptKey=id=>prefix+'contributions/'+hex(id);
const dailyKey=from=>prefix+'days/'+day(from);

export function pilotFundingPlan({from,to,dailyMicro=PILOT_DAILY_MICRO}){
 day(from);day(to);assert(to>from&&to<=START,'pilot ends before the common 2027 launch');
 assert.equal(dailyMicro,PILOT_DAILY_MICRO,'owner-approved pilot daily budget');
 const days=(to-from)/DAY;assert(days<=366,'bounded funding horizon');
 return {version:FUNDING,source:'PREISSUED_WARMUP',from,to,dailyMicro,days,budgetMicro:String(micro(dailyMicro)*BigInt(days))};
}

// Exclude programme capacity reservations AND principal held in a live request.
// `custodyMicro` is free authenticated outputs, never supply or wallet balance.
export function inspectWarmupFunding({fundedMicro,feeSpentMicro,custodyMicro,escrowMicro='0',capacityReservedMicro='0',contributedMicro='0',serviceSpentMicro='0',serviceReservedMicro='0'}){
 const funded=micro(fundedMicro),fees=micro(feeSpentMicro),custody=micro(custodyMicro),escrow=micro(escrowMicro),capacity=micro(capacityReservedMicro),contributed=micro(contributedMicro),spent=micro(serviceSpentMicro),reserved=micro(serviceReservedMicro);
 assert.equal(custody+escrow+fees+spent,funded+contributed,'warmup source conservation');
 // Deliberately conservative: capacity stays reserved until its controller
 // releases it, even if some fee is already included in request escrow.
 assert(custody>=capacity+reserved,'overlapping service and programme reservations');
 return {freeMicro:String(custody-capacity-reserved),fundedMicro,contributedMicro,feeSpentMicro,serviceSpentMicro,serviceReservedMicro};
}

export function fundingRequirement(plan,freeMicro){
 assert.deepEqual(plan,pilotFundingPlan(plan));const free=micro(freeMicro),needed=micro(plan.budgetMicro);
 return {requiredMicro:plan.budgetMicro,freeMicro,shortfallMicro:String(needed>free?needed-free:0n),covered:free>=needed};
}

// Owner chose natural exhaustion of the original fund, not wallet top-ups.
// Never authorize a fractional last day or an unfunded future entitlement.
export function affordablePilotFunding({from,to=START,freeMicro}){
 const requested=pilotFundingPlan({from,to}),free=micro(freeMicro),rate=micro(PILOT_DAILY_MICRO);
 const fundedDays=Number(free/rate>BigInt(requested.days)?BigInt(requested.days):free/rate);
 const plan=fundedDays?pilotFundingPlan({from,to:from+fundedDays*DAY}):null;
 return {plan,fundedDays,reservedMicro:plan?.budgetMicro??'0',remainingFreeMicro:String(free-BigInt(fundedDays)*rate),
  unfundedDays:requested.days-fundedDays};
}

// Same day/allocator for both stages; source is explicit in the resulting record.
// This function cannot mint and cannot silently fall back to another fund.
export function scheduledWorkPool({from,pilotPlan,annualMicro}){
 day(from);
 if(from<START){assert(pilotPlan,'approved preissued pilot plan required');assert.deepEqual(pilotPlan,pilotFundingPlan(pilotPlan));assert(from>=pilotPlan.from&&from<pilotPlan.to,'outside funded pilot schedule');return {source:'PREISSUED_WARMUP',from,to:from+DAY,poolMicro:pilotPlan.dailyMicro};}
 return {source:'CALENDAR_NODE_EMISSION',from,to:from+DAY,poolMicro:dailyNodePool(annualMicro,from)};
}

function checkedHead(tx){
 const h=tx.get(headKey);assert(h,'service funding not reserved');
 exact(h,['version','plan','planHash','committedMicro','remainingMicro','nextDay','contributedMicro']);
 assert.equal(h.version,FUNDING);assert.deepEqual(h.plan,pilotFundingPlan(h.plan));assert.equal(h.planHash,hash(h.plan));
 assert.equal(micro(h.committedMicro)+micro(h.remainingMicro),micro(h.plan.budgetMicro),'reserved budget conservation');
 day(h.nextDay);assert(h.nextDay>=h.plan.from&&h.nextDay<=h.plan.to);micro(h.contributedMicro);return h;
}

// `reserve` is an INTERNAL monetary adapter: it must exclude this amount from
// all other custody consumers in the surrounding atomic consensus transition.
export function reserveServiceFunding(tx,plan,now,freeMicro,reserve){
 integer(now,1);assert.deepEqual(plan,pilotFundingPlan(plan));assert(plan.from>now,'prospective full UTC days');
 const old=tx.get(headKey);if(old){const h=checkedHead(tx);assert.equal(h.planHash,hash(plan),'funding plan already committed');return {duplicate:true};}
 assert(fundingRequirement(plan,freeMicro).covered,'insufficient unreserved preissued funds');
 assert.equal(typeof reserve,'function');reserve(plan.budgetMicro);
 tx.set(headKey,{version:FUNDING,plan,planHash:hash(plan),committedMicro:'0',remainingMicro:plan.budgetMicro,nextDay:plan.from,contributedMicro:tx.get(contributionHead)?.valueMicro??'0'});
 return {duplicate:false};
}

// Accept ONLY a settled transfer supplied by the monetary interpreter. A user
// promise, balance screenshot, pending request or top-up declaration is not money.
// The adapter verifies ownership/receipt and adopts custody in the same commit.
export function recordServiceContribution(tx,receipt,adopt){
 exact(receipt,['paymentId','valueMicro','sender','recipient','status']);hex(receipt.paymentId);assert.equal(receipt.status,'SETTLED');
 assert(micro(receipt.valueMicro)>0n);assert(typeof receipt.sender==='string'&&receipt.sender.length>0);assert(typeof receipt.recipient==='string'&&receipt.recipient.length>0);
 const key=receiptKey(receipt.paymentId),digest=hash(receipt),old=tx.get(key);
 if(old){assert.equal(old.digest,digest,'conflicting contribution replay');return {duplicate:true};}
 assert.equal(typeof adopt,'function');adopt(receipt);
 const contributed=String(micro(tx.get(contributionHead)?.valueMicro??'0')+micro(receipt.valueMicro));
 tx.set(contributionHead,{valueMicro:contributed});
 if(tx.get(headKey)){const h=checkedHead(tx);h.contributedMicro=contributed;tx.set(headKey,h);}tx.set(key,{digest,receipt});
 // Contributions do not increase the approved daily rate or reserved schedule.
 return {duplicate:false};
}

// `allocation` MUST be the result of the authenticated work allocator, never an
// RPC-supplied list. This contract freezes a closed day's plan before paginated
// monetary settlement. Missing work is reconciliation, not a zero/burn/treasury.
export function openFundedServiceDay(tx,{from,allocationHash,recipients,acceptedUnits},now){
 day(from);hex(allocationHash);integer(recipients,1);assert(micro(acceptedUnits)>0n,'accepted work required');integer(now,from+DAY);
 const h=checkedHead(tx),key=dailyKey(from),old=tx.get(key);
 if(old){assert.equal(old.allocationHash,allocationHash,'day allocation is immutable');assert.equal(old.recipients,recipients);assert.equal(old.acceptedUnits,acceptedUnits);return {duplicate:true};}
 assert.equal(from,h.nextDay,'reconcile original days in order');assert(from<h.plan.to,'pilot schedule exhausted');assert(micro(h.remainingMicro)>=micro(h.plan.dailyMicro));
 tx.set(key,{from,allocationHash,recipients,acceptedUnits,poolMicro:h.plan.dailyMicro,creditedMicro:'0',nextOrdinal:0,lastNode:'',status:'ALLOCATING'});return {duplicate:false};
}

// Fixed-size chunks; no population scan. `verifiedCredits` are read by the
// consensus adapter from the frozen allocation, including canonical ordinal.
// `credit` performs exact custody debit + reward-earned credit, never supply++.
export function packServiceCredits({from,allocationHash,ordinal},candidates){
 day(from);hex(allocationHash);integer(ordinal);assert(Array.isArray(candidates)&&candidates.length>0);
 const command={from,allocationHash,ordinal,verifiedCredits:[]};
 for(const row of candidates.slice(0,32)){
  command.verifiedCredits.push(row);
  if(Buffer.byteLength(canonical(command))>60000){command.verifiedCredits.pop();break;}
 }
 assert(command.verifiedCredits.length>0,'single allocation proof exceeds wire budget');return command;
}
export function settleFundedServiceChunk(tx,{from,allocationHash,ordinal,verifiedCredits},credit){
 const h=checkedHead(tx),key=dailyKey(from),d=tx.get(key);assert(d,'closed accepted work day required');hex(allocationHash);assert.equal(d.allocationHash,allocationHash);
 integer(ordinal);assert(Array.isArray(verifiedCredits)&&verifiedCredits.length>0&&verifiedCredits.length<=32,'bounded settlement chunk');
 assert(Buffer.byteLength(canonical({from,allocationHash,ordinal,verifiedCredits}))<=60000,'settlement wire budget');
 assert.equal(typeof credit,'function');const digest=hash({allocationHash,ordinal,verifiedCredits}),chunkKey=prefix+'chunks/'+from+'/'+ordinal,old=tx.get(chunkKey);
 if(old){assert.equal(old.digest,digest,'conflicting settlement replay');return {duplicate:true};}
 assert.equal(d.status,'ALLOCATING');assert.equal(ordinal,d.nextOrdinal,'consecutive allocation cursor');assert.equal(from,h.nextDay);
 assert(ordinal+verifiedCredits.length<=d.recipients);let sum=0n,last=d.lastNode;
 for(const [i,row]of verifiedCredits.entries()){
  exact(row,['node','valueMicro','proof']);hex(row.node);assert(row.node>last,'unique canonical allocation order');last=row.node;sum+=micro(row.valueMicro);
  assert(Buffer.byteLength(JSON.stringify(row.proof))<=48000,'bounded allocation proof');
  assert.equal(row.proof.key,'credits/'+String(ordinal+i).padStart(12,'0'));assert.equal(row.proof.found,true);
  verifyRecordProof(row.proof,allocationHash);assert.deepEqual(row.proof.value,{node:row.node,valueMicro:row.valueMicro});
 }
 assert(micro(d.creditedMicro)+sum<=micro(d.poolMicro),'daily budget exceeded');
 const done=ordinal+verifiedCredits.length===d.recipients;
 if(done)assert.equal(micro(d.creditedMicro)+sum,micro(d.poolMicro),'whole daily pool must be allocated');
 credit(verifiedCredits.map(({node,valueMicro})=>({node,valueMicro})),String(sum));
 d.nextOrdinal+=verifiedCredits.length;d.lastNode=last;d.creditedMicro=String(micro(d.creditedMicro)+sum);
 h.committedMicro=String(micro(h.committedMicro)+sum);h.remainingMicro=String(micro(h.remainingMicro)-sum);
 if(done){d.status='ALLOCATED';h.nextDay=from+DAY;}
 tx.set(key,d);tx.set(headKey,h);tx.set(chunkKey,{digest});return {duplicate:false,complete:done};
}

export function readServiceFunding(tx){return checkedHead(tx);}
