// Authenticated fee accounting seed. No token issuance or public wire flags.
import assert from 'node:assert/strict';
import {controllerContext} from '../controller-context.mjs';
import {amount} from '../payment-model.mjs';
import {intentUnits,unitScale} from '../token-units.mjs';
import {paymentWorkUnits} from '../reward-work-budget.mjs';
export function emptySeed(){return {fees:'0',jobs:{},value:{}};}
export function addSettlement(seed,request,s){
 seed.fees=String(amount(seed.fees)+BigInt(intentUnits(request.intent,request.intent.fee,unitScale(s))));
 for(const p of request.intent.parts)for(const id of p.nodes)seed.jobs[id]=String(BigInt(seed.jobs[id]??'0')+1n);
 for(const [id,v]of Object.entries(paymentWorkUnits(request.intent)))seed.value[id]=String(BigInt(seed.value[id]??'0')+BigInt(v));
}
export function rewardContext(s,book,anchorRoot){
 const workers=controllerContext(s);assert(workers&&Number.isSafeInteger(workers.workerCount));
 const c=s.rewards?.coefficients??s.authority?.nodeRewards?.coefficients;
 return {indexed:true,workerCount:workers.workerCount,nextRewardWorkers:workers.nextRewardWorkers,anchorRoot,seed:{fees:book.seed.fees,work:c?.workMeasure?book.seed.value:book.seed.jobs}};
}
export function feeOnly(s){
 for(const c of [s.authority?.nodeRewards?.coefficients,s.rewards?.coefficients,s.rewards?.scheduled?.coefficients].filter(Boolean))assert(c.alphaPPM===0&&c.periodMintLimit==='0'&&c.lifetimeMintLimit==='0'&&!c.calendar,'bounded rewards are fee-only; issuance disabled');
 assert(!s.rewards?.fundedWork,'legacy funded issuance needs bounded integration');
}
