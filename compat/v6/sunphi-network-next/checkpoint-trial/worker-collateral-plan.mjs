// Review only, from a verified ledger view. Purchase channels never authorize
// spending. A seller receipt or exchange status is not a DUBYT ledger output.
import assert from 'node:assert/strict';
import {exact,hex,publicKey,integer} from './crypto.mjs';
import {amount,MAX} from './payment-model.mjs';
import {parseToken,formatToken} from './token-units.mjs';
import {spendPolicy} from './spend-protection.mjs';
import {centuryRestrictedAccounts} from './century-funds.mjs';
import {centuryWarmupAccounts,memorialPolicy} from './economic-policy-v3.mjs';
import {reserveAddresses} from './network-reserves.mjs';
import {FUND_WORKER,COLLATERAL_DOMAIN} from './worker-collateral.mjs';
export function prepareCollateralReview(s,q){
 exact(q,['node','owner','inputs','amount','unitScale']);hex(q.node);publicKey(q.owner);
 assert.equal(s.money.unitScale,'1000000');assert.equal(q.unitScale,s.money.unitScale);assert(s.centuryFees,'qualified fee policy required');
 assert(s.money.nodes[q.node],'registered worker required');integer(s.money.time,1);
 const prior=s.workerFunding?.accounts[q.node];assert(!prior?.release,'release pending');assert(!prior||prior.owner===q.owner,'funding owner is fixed');
 const protection=spendPolicy(s,q.owner);assert(!protection?.enabled&&!protection?.pending,'protected collateral consent not yet supported');
 const restricted=[...centuryRestrictedAccounts(s.configHash),...centuryWarmupAccounts(s.configHash),memorialPolicy(s.configHash).account,...Object.values(reserveAddresses(s.configHash))];assert(!restricted.includes(q.owner),'restricted programme account');
 assert(Array.isArray(q.inputs)&&q.inputs.length>0&&q.inputs.length<=8);q.inputs.forEach(hex);assert.equal(new Set(q.inputs).size,q.inputs.length,'duplicate input');
 const inputs=[...q.inputs].sort();let confirmed=0n;
 for(const id of inputs){const o=s.money.outputs[id];assert(o&&o.owner===q.owner,'confirmed owned output required');assert(o.unlock<=s.money.time,'output not spendable yet');confirmed+=amount(o.value);}
 assert(confirmed<=MAX);const value=parseToken(q.amount,q.unitScale);assert(amount(value)>0n&&amount(value)<=confirmed,'collateral exceeds selected spendable funds');
 assert(amount(s.money.nodes[q.node].stake)+amount(value)<=MAX,'stake overflow');assert(amount(prior?.depositedMicro??'0')+amount(value)<=MAX,'deposit history overflow');
 const sequence=(prior?.sequence??0)+1,expires=s.money.time+300;integer(sequence,1);integer(expires,1);
 const body={domain:COLLATERAL_DOMAIN,configHash:s.configHash,node:q.node,owner:q.owner,sequence,issuedAt:s.money.time,expires,unitScale:q.unitScale,inputs,valueMicro:value};
 return {type:FUND_WORKER,body,reviewOnly:true,externalPaymentVerified:false,requiresOwnerSignature:true,requiresWorkerSignature:true,
  display:{selectedFunds:formatToken(String(confirmed),q.unitScale),collateral:formatToken(value,q.unitScale),remainingSelectedFunds:formatToken(String(confirmed-amount(value)),q.unitScale)},
  coverageActivated:false,issuanceAuthorized:false};
}
