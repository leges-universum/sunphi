// Deterministic calendar arithmetic shared by policy checks and the daily allocator.
// Inputs are an EXISTING reconciled annual plan and ALREADY ACCEPTED work units.
// Accepted units include role-specific history maintenance/availability even
// with zero payments/fees. Work verification belongs to bounded-service-rewards.
// Never equate an empty payment-receipt list with absence of all service.
// This module does not verify work, sign, mint, persist, or activate any programme.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {anniversary} from '../economic-policy-v2.mjs';
import {CAP,WARMUP,DEVELOPMENT,FOUNDER} from '../ecosystem-century-model.mjs';

export const POLICY='DUEBYTE_CALENDAR_NODE_REWARDS_POLICY_V3';
export const START=Date.UTC(2027,0,1)/1000;
export const DAY=86400;
export const END=anniversary(START,100);
const amount=v=>{assert(typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v),'canonical micro amount');return BigInt(v);};
const time=v=>assert(Number.isSafeInteger(v)&&v>=0,'UTC seconds');
const sum=xs=>xs.reduce((a,b)=>a+b,0n);
export function inspectAnnualPlan(annualMicro){
 assert(Array.isArray(annualMicro)&&annualMicro.length===100,'existing 100-year plan required');
 const values=annualMicro.map(amount),total=sum(values);
 assert(total<=CAP-WARMUP-DEVELOPMENT-FOUNDER,'node plan overlaps fixed main funds');
 return {values,total,annualHash:createHash('sha256').update(JSON.stringify(annualMicro)).digest('hex')};
}
// No new curve: spread EACH retained annual value over its actual UTC year.
export function cumulativeNodeAllowance(annualMicro,at){
 time(at);const {values}=inspectAnnualPlan(annualMicro);if(at<=START)return 0n;
 let total=0n;
 for(let y=0;y<100;y++){
  const left=anniversary(START,y),right=anniversary(START,y+1);
  if(at>=right)total+=values[y];
  else {total+=values[y]*BigInt(at-left)/BigInt(right-left);break;}
 }
 return total;
}
export function dailyNodePool(annualMicro,from){
 time(from);assert((from-START)%DAY===0,'UTC day boundary');
 return String(cumulativeNodeAllowance(annualMicro,from+DAY)-cumulativeNodeAllowance(annualMicro,from));
}
// 1:1 are the existing work coefficients, NOT equal pay for every machine.
// Payment parts are aggregated by existing paymentWorkUnits before this call.
// Eligibility, quota caps, replay dedup and service evidence belong upstream.
export function distributeNodePool(poolMicro,acceptedWork){
 const pool=amount(poolMicro);assert(Array.isArray(acceptedWork),'accepted work required');
 const seen=new Set(),rows=acceptedWork.map(x=>{
  assert(x&&Object.keys(x).sort().join(',')==='node,witnessUnits,workerUnits','work fields');
  assert(typeof x.node==='string'&&/^[0-9a-f]{64}$/.test(x.node)&&!seen.has(x.node),'unique node');seen.add(x.node);
  return {node:x.node,weight:amount(x.workerUnits)+amount(x.witnessUnits)};
 }).filter(x=>x.weight>0n).sort((a,b)=>a.node<b.node?-1:1);
 const total=sum(rows.map(x=>x.weight));
 // Baseline maintenance exists independently of payment jobs. Empty evidence
 // requires reconciliation, not a loss of calendar entitlement or a new fund.
 // Do not claim to have committed mint/recipients before proofs are available.
 if(!total)return {status:'RECONCILIATION_REQUIRED',scheduledMicro:poolMicro,credits:[]};
 for(const r of rows){r.credit=pool*r.weight/total;r.remainder=pool*r.weight%total;}
 let residue=pool-sum(rows.map(r=>r.credit));
 const priority=[...rows].sort((a,b)=>a.remainder===b.remainder?(a.node<b.node?-1:1):(a.remainder>b.remainder?-1:1));
 for(const r of priority){if(!residue)break;r.credit++;residue--;}
 assert.equal(residue,0n);
 return {status:'ALLOCATED',mintedMicro:poolMicro,unissuedMicro:'0',credits:rows.map(r=>({node:r.node,valueMicro:String(r.credit)}))};
}
