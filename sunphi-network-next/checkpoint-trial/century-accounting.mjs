// Exact bridge from retained ledger evidence to the century budget planner.
// This is an accounting view, not a tariff approval or an issuance instruction.
import assert from 'node:assert/strict';
import {amount,centuryWarmup,terminalProgramFee} from './payment-model.mjs';
import {intentUnits,unitScale} from './token-units.mjs';
import {reserveAddresses} from './network-reserves.mjs';
import {centuryWarmupAccounts,memorialAware,emissionBudgetV3} from './economic-policy-v3.mjs';
import {hash,integer} from './crypto.mjs';
export function retainedCenturyActivity(state,{afterHeight=0,throughHeight=state.money.height}={}) {
 integer(afterHeight);integer(throughHeight,afterHeight);assert(throughHeight<=state.money.height);
 const accounts=[...reserveAddresses(state.configHash),...centuryWarmupAccounts(state.configHash),...(state.launchFund?.policy.wallets??[])];
 let ordinaryVolume=0n,ordinaryFees=0n,warmupVolume=0n,warmupFees=0n;
 for(const r of Object.values(state.money.requests)){
  if(!['SETTLED','EXPIRED','CANCELLED'].includes(r.status)||r.terminalHeight<=afterHeight||r.terminalHeight>throughHeight)continue;
  const i=r.intent;assert.equal(r.digest,hash(i),'settlement evidence binding');
  const warmup=centuryWarmup(i)||terminalProgramFee(i)||accounts.includes(i.sender)||accounts.includes(i.recipient);
  const volume=r.status==='SETTLED'?amount(intentUnits(i,i.value,'1000000')):0n;
  const fee=amount(intentUnits(i,r.status==='SETTLED'?i.fee:i.abortFee,'1000000'));
  if(warmup){warmupVolume+=volume;warmupFees+=fee;}else{ordinaryVolume+=volume;ordinaryFees+=fee;}
 }
 return {afterHeight,throughHeight,ordinaryVolumeMicro:String(ordinaryVolume),ordinaryFeesMicro:String(ordinaryFees),
  warmupVolumeMicro:String(warmupVolume),warmupFeesMicro:String(warmupFees),
  scope:'RETAINED_SETTLEMENTS_ONLY',externalDemandProven:false};
}
export function centuryBudgetFromLedger(state,input) {
 const e=state.economicPreparation;assert(memorialAware(e?.plan.version));assert.equal(e.planHash,hash(e.plan));
 // A signed external-demand/service acceptance contract is still a launch gate.
 // Ordinary wallet transfers alone do not prove independent commercial demand.
 const {calendar,...costs}=input;
 assert.equal(calendar.existingSupplyMicro,e.plan.existingSupplyMicro,'frozen existing supply');
 assert(!Object.hasOwn(costs,'supplyMicro')&&!Object.hasOwn(costs,'memorialIssuedMicro'),'ledger-derived supply only');
 return emissionBudgetV3({...costs,calendar,
  supplyMicro:String(amount(state.money.supply)*1000000n/unitScale(state)),
  memorialIssuedMicro:e.memorial.issued?e.plan.memorialMicro:'0'},BigInt(e.plan.memorialMicro));
}
