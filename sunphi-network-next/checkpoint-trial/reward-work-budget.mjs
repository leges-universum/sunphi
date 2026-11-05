// Deterministic funded assignments. Callers must certify policy/owner membership
// and validate the class-specific result before accepting work. No self-reported
// CPU time, OS bonus, or payment for merely registering a key.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer} from './crypto.mjs';
import {amount,policy as paymentPolicy} from './payment-model.mjs';
import {validateCalendar,periodAllowance,DUBYT_SUPPLY_CAP} from './emission-calendar.mjs';

export const WORK_UNITS=1000000n;
const sum=values=>values.reduce((a,b)=>a+BigInt(b),0n);
// Aggregate BEFORE rounding: splitting one part cannot increase measured work.
// A payment has exactly copies * WORK_UNITS, irrespective of its parts count.
export function paymentWorkUnits(intent){
 const total=amount(intent.value);assert(total>0n);const values={};let principal=0n;
 for(const part of intent.parts){const value=amount(part.value);assert(value>0n);
  assert.equal(part.nodes.length,paymentPolicy.copies);assert.equal(new Set(part.nodes).size,paymentPolicy.copies);
  principal+=value;for(const node of part.nodes){hex(node);values[node]=(values[node]??0n)+value;}}
 assert.equal(principal,total);
 const rows=Object.keys(values).sort().map(node=>({node,units:values[node]*WORK_UNITS/total,remainder:values[node]*WORK_UNITS%total}));
 let dust=WORK_UNITS*BigInt(paymentPolicy.copies)-sum(rows.map(x=>x.units));
 // Stable largest-remainder allocation conserves units exactly, not tokens.
 for(const row of [...rows].sort((a,b)=>a.remainder===b.remainder?(a.node<b.node?-1:1):(a.remainder>b.remainder?-1:1))){if(!dust)break;row.units++;dust--;}
 assert.equal(dust,0n);return Object.fromEntries(rows.map(x=>[x.node,String(x.units)]));
}

export function validateWorkPolicy(p){
 exact(p,['version','startTime','endTime','nodeEmissionCap','groupEmissionCap','homeEmissionBudget','serverEmissionBudget','maxAssignments','tariffs']);
 integer(p.version,1);integer(p.startTime,1);integer(p.endTime,p.startTime+1);
 for(const name of ['nodeEmissionCap','groupEmissionCap','homeEmissionBudget','serverEmissionBudget'])amount(p[name]);
 assert(amount(p.nodeEmissionCap)<=amount(p.groupEmissionCap),'group cap below node cap');
 integer(p.maxAssignments,1);assert(p.maxAssignments<=4096,'bounded trial work ledger');
 const kinds=Object.keys(p.tariffs);assert(kinds.length>0&&kinds.length<=16);
 for(const kind of kinds){assert(/^[a-z][a-z0-9_]{1,39}$/.test(kind));const t=p.tariffs[kind];exact(t,['segment','fee','emission']);assert(['home','server'].includes(t.segment));amount(t.fee);amount(t.emission);assert(amount(t.fee)+amount(t.emission)>0n,'unfunded tariff');}
 return p;
}
export function createWorkBudget({configHash,calendar,policy,feeBudget,supply,owners}){
 hex(configHash);validateCalendar(calendar);validateWorkPolicy(policy);amount(feeBudget);amount(supply);
 const emission=amount(policy.homeEmissionBudget)+amount(policy.serverEmissionBudget);
 assert(policy.startTime>=calendar.startTime&&(!emission||policy.endTime<=calendar.endTime),'assignment window outside emission horizon');
 assert(emission<=periodAllowance(calendar,policy.startTime,policy.endTime),'calendar assignment budget');
 assert(amount(supply)+emission<=DUBYT_SUPPLY_CAP,'global supply reservation');
 assert(owners&&typeof owners==='object'&&!Array.isArray(owners)&&Object.keys(owners).length<=256,'bounded owner snapshot');
 for(const [node,group] of Object.entries(owners)){hex(node);if(group!==null)hex(group);}
 return {configHash,calendar:structuredClone(calendar),policy:structuredClone(policy),feeBudget,supply,owners:structuredClone(owners),jobs:{},nodeUsed:{},groupUsed:{},reservedFees:'0',reservedEmission:{home:'0',server:'0'},paidFees:'0',minted:{home:'0',server:'0'},claims:{}};
}
export function assignmentId(configHash,kind,demand,replica){hex(configHash);hex(demand);integer(replica);return hash({domain:'DUEBYTE_FUNDED_WORK_V1',configHash,kind,demand,replica});}
export function assignWork(base,request,time){
 exact(request,['kind','demand','replica','node','units','deadline']);integer(time);hex(request.node);integer(request.units,1);assert(request.units<=1000000);
 const p=base.policy;assert(time>=p.startTime&&time<p.endTime,'assignment period');integer(request.deadline,time+1);assert(request.deadline<=p.endTime,'work must finish within funded period');
 const tariff=p.tariffs[request.kind];assert(tariff,'unknown work class');assert(Object.hasOwn(base.owners,request.node),'node outside owner snapshot');
 const id=assignmentId(base.configHash,request.kind,request.demand,request.replica);
 if(base.jobs[id]){assert.deepEqual(base.jobs[id].request,request,'assignment identity conflict');return base;}
 assert(Object.keys(base.jobs).length<p.maxAssignments,'assignment capacity');
 const fee=amount(tariff.fee)*BigInt(request.units),emission=amount(tariff.emission)*BigInt(request.units),segment=tariff.segment;
 const nodeUsed=BigInt(base.nodeUsed[request.node]??'0')+emission;
 // Anonymous membership is explicitly unknown, not falsely equated with a
 // verified owner. Node caps still apply; no claim of global Sybil resistance.
 const group=base.owners[request.node],groupUsed=group===null?0n:BigInt(base.groupUsed[group]??'0')+emission;
 assert(nodeUsed<=amount(p.nodeEmissionCap),'node subsidy quota');
 if(group!==null)assert(groupUsed<=amount(p.groupEmissionCap),'owner-group subsidy quota');
 assert(BigInt(base.reservedFees)+BigInt(base.paidFees)+fee<=amount(base.feeBudget),'fee budget exhausted');
 assert(BigInt(base.reservedEmission[segment])+BigInt(base.minted[segment])+emission<=amount(p[segment+'EmissionBudget']),'segment subsidy budget exhausted');
 assert(sum(Object.values(base.reservedEmission))+sum(Object.values(base.minted))+emission<=periodAllowance(base.calendar,p.startTime,time),'calendar budget not yet available');
 const b=structuredClone(base);b.nodeUsed[request.node]=String(nodeUsed);if(group!==null)b.groupUsed[group]=String(groupUsed);
 b.reservedFees=String(BigInt(b.reservedFees)+fee);b.reservedEmission[segment]=String(BigInt(b.reservedEmission[segment])+emission);
 b.jobs[id]={request:structuredClone(request),createdAt:time,policyHash:hash(p),segment,fee:String(fee),emission:String(emission),status:'assigned',proof:null};auditWorkBudget(b);return b;
}
export function finishWork(base,id,proof,time){
 hex(id);hex(proof);integer(time);const old=base.jobs[id];assert(old,'unknown assignment');
 if(old.status==='accepted'){assert.equal(old.proof,proof,'result conflict');return base;}
 assert.equal(old.status,'assigned');assert(time>=old.createdAt&&time<=old.request.deadline,'work acceptance deadline');
 const b=structuredClone(base),j=b.jobs[id];j.status='accepted';j.proof=proof;
 b.reservedFees=String(BigInt(b.reservedFees)-BigInt(j.fee));b.reservedEmission[j.segment]=String(BigInt(b.reservedEmission[j.segment])-BigInt(j.emission));
 b.paidFees=String(BigInt(b.paidFees)+BigInt(j.fee));b.minted[j.segment]=String(BigInt(b.minted[j.segment])+BigInt(j.emission));
 const claim=b.claims[j.request.node]??{fees:'0',emission:'0'};claim.fees=String(BigInt(claim.fees)+BigInt(j.fee));claim.emission=String(BigInt(claim.emission)+BigInt(j.emission));b.claims[j.request.node]=claim;
 auditWorkBudget(b);return b;
}
export function expireWork(base,id,time){
 hex(id);integer(time);const old=base.jobs[id];assert(old,'unknown assignment');if(old.status!=='assigned')return base;assert(time>old.request.deadline,'work still live');
 const b=structuredClone(base),j=b.jobs[id];j.status='expired';b.reservedFees=String(BigInt(b.reservedFees)-BigInt(j.fee));b.reservedEmission[j.segment]=String(BigInt(b.reservedEmission[j.segment])-BigInt(j.emission));
 // Do not recycle identity or quota within this period: failed jobs must not
 // create an unlimited loop of subsidised assignments for the same operator.
 auditWorkBudget(b);return b;
}
export function auditWorkBudget(b){
 validateCalendar(b.calendar);validateWorkPolicy(b.policy);const jobs=Object.values(b.jobs),live=jobs.filter(j=>j.status==='assigned'),done=jobs.filter(j=>j.status==='accepted');
 assert(jobs.length<=b.policy.maxAssignments);assert(b.policy.startTime>=b.calendar.startTime);if(amount(b.policy.homeEmissionBudget)+amount(b.policy.serverEmissionBudget)>0n)assert(b.policy.endTime<=b.calendar.endTime);
 assert(amount(b.policy.homeEmissionBudget)+amount(b.policy.serverEmissionBudget)<=periodAllowance(b.calendar,b.policy.startTime,b.policy.endTime));
 for(const [id,j] of Object.entries(b.jobs)){
  assert.equal(id,assignmentId(b.configHash,j.request.kind,j.request.demand,j.request.replica));assert.equal(j.policyHash,hash(b.policy));
  assert(['assigned','accepted','expired'].includes(j.status));integer(j.createdAt,b.policy.startTime);integer(j.request.deadline,j.createdAt+1);assert(j.request.deadline<=b.policy.endTime);
  assert(Object.hasOwn(b.owners,j.request.node));const t=b.policy.tariffs[j.request.kind];assert(t);assert.equal(j.segment,t.segment);integer(j.request.units,1);
  assert.equal(BigInt(j.fee),amount(t.fee)*BigInt(j.request.units));assert.equal(BigInt(j.emission),amount(t.emission)*BigInt(j.request.units));
  if(j.status==='accepted')hex(j.proof);else assert.equal(j.proof,null);
  assert(Object.hasOwn(b.nodeUsed,j.request.node));if(b.owners[j.request.node]!==null)assert(Object.hasOwn(b.groupUsed,b.owners[j.request.node]));
 }
 assert.equal(sum(live.map(j=>j.fee)),BigInt(b.reservedFees));assert.equal(sum(done.map(j=>j.fee)),BigInt(b.paidFees));
 assert(BigInt(b.reservedFees)+BigInt(b.paidFees)<=amount(b.feeBudget));
 for(const segment of ['home','server']){assert.equal(sum(live.filter(j=>j.segment===segment).map(j=>j.emission)),BigInt(b.reservedEmission[segment]));assert.equal(sum(done.filter(j=>j.segment===segment).map(j=>j.emission)),BigInt(b.minted[segment]));assert(BigInt(b.reservedEmission[segment])+BigInt(b.minted[segment])<=amount(b.policy[segment+'EmissionBudget']));}
 assert.equal(sum(Object.values(b.claims).map(c=>c.fees)),BigInt(b.paidFees));assert.equal(sum(Object.values(b.claims).map(c=>c.emission)),sum(Object.values(b.minted)));
 for(const [node,used] of Object.entries(b.nodeUsed)){assert.equal(BigInt(used),sum(jobs.filter(j=>j.request.node===node).map(j=>j.emission)));assert(BigInt(used)<=amount(b.policy.nodeEmissionCap));}
 for(const [group,used] of Object.entries(b.groupUsed)){assert.equal(BigInt(used),sum(jobs.filter(j=>b.owners[j.request.node]===group).map(j=>j.emission)));assert(BigInt(used)<=amount(b.policy.groupEmissionCap));}
 assert(amount(b.supply)+sum(Object.values(b.minted))+sum(Object.values(b.reservedEmission))<=DUBYT_SUPPLY_CAP);return true;
}
