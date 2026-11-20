// Wallet-local consent preparation. No broadcast, worker key or issuance path.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {exact,hash,sign} from './crypto.mjs';
import {parseToken,formatToken} from './token-units.mjs';
import {prepareCollateralReview,prepareReleaseReview} from './worker-collateral-plan.mjs';
import {outsideCollateralPilot} from './wallet-collateral-status.mjs';
import {spendPolicy} from './spend-protection.mjs';
import {stateHash} from './core.mjs';
import {consolidationEnabled,LEGACY_INPUTS} from './payment-input-policy.mjs';
import {MAX} from './payment-model.mjs';
import {isBoundedWalletView,assertBoundedWalletView} from './research/bounded-wallet-view.mjs';
const available=(s,owner)=>Object.entries(s.money.outputs).filter(([,o])=>o.owner===owner&&o.unlock<=s.money.time&&BigInt(o.value)>0n);
export function collateralOptions(s,owner){
 const nodes=Object.entries(s.money.nodes).filter(([id])=>!outsideCollateralPilot(s,id)&&(!s.workerFunding?.accounts[id]||s.workerFunding.accounts[id].owner===owner)).map(([id,n])=>({id,operator:n.operator,releasePending:!!s.workerFunding?.accounts[id]?.release}));
 const protection=spendPolicy(s,owner),reason=(s.money.unitScale??'1')!=='1000000'||!s.centuryFees?'Collateral funding awaits the compatible network activation.':protection?.enabled||protection?.pending?'Separate collateral approval is not yet available for this protected wallet.':!nodes.length?'No linked or funded server worker is available in this wallet.':null;
 return {enabled:!reason,reason,nodes,available:formatToken(String(available(s,owner).reduce((a,[,o])=>a+BigInt(o.value),0n)),s.money.unitScale??'1'),mode:'CONSENT_ONLY',broadcastEnabled:false};
}
function plan(s,owner,q,allowConsolidation=false){
 if(q.operation==='withdraw'){
  exact(q,['operation','node','amount','unitScale']);assert.equal(q.unitScale,s.money.unitScale);
  return prepareReleaseReview(s,{node:q.node,owner,valueMicro:parseToken(q.amount,q.unitScale)});
 }
 exact(q,['node','amount','unitScale']);assert(!outsideCollateralPilot(s,q.node),'Deposits are limited to servers in the current collateral pilot.');assert(collateralOptions(s,owner).enabled,collateralOptions(s,owner).reason);
 const need=BigInt(parseToken(q.amount,q.unitScale)),inputs=[];let sum=0n;
 assert(need>0n,'Enter a positive collateral amount.');
 const outputs=available(s,owner).sort(([a,x],[b,y])=>BigInt(x.value)===BigInt(y.value)?a<b?-1:1:BigInt(x.value)>BigInt(y.value)?-1:1);
 const total=outputs.reduce((a,[,o])=>a+BigInt(o.value),0n);
 assert(need<=total,'Amount exceeds your confirmed available balance of '+formatToken(String(total),q.unitScale)+' DUBYT.');
 for(const [id,o]of outputs){if(sum>=need)break;inputs.push(id);sum+=BigInt(o.value);}
 if(inputs.length>LEGACY_INPUTS){
  assert(allowConsolidation&&consolidationEnabled(s),'Your balance covers this amount, but free consolidation is not active for this deposit. No deposit was submitted.');
  const check=prepareCollateralReview(s,{...q,owner,amount:'0.000001',inputs:[inputs[0]]});
  assert(BigInt(s.money.nodes[q.node].stake)+need<=MAX&&BigInt(s.workerFunding?.accounts[q.node]?.depositedMicro??0)+need<=MAX,'Collateral overflow.');
  return {preparation:{domain:'DUEBYTE_HOME_CONSOLIDATED_DEPOSIT_V1',configHash:s.configHash,node:q.node,owner,
   worker:s.money.nodes[q.node].key,sequence:check.body.sequence,unitScale:q.unitScale,valueMicro:String(need),inputs,
   created:s.money.time,expires:s.money.time+86400}};
 }
 const result=prepareCollateralReview(s,{...q,owner,inputs});
 result.display.available=collateralOptions(s,owner).available;
 result.display.remainingAvailable=formatToken(String(total-need),q.unitScale);
 return result;
}
export class WalletCollateral{
 constructor(wallet,{now=Date.now}={}){this.wallet=wallet;this.now=now;this.pending=new Map();}
 async current(options){const v=await this.wallet.view(options),{state,certificate}=v,w=this.wallet;
  if(isBoundedWalletView(state))assertBoundedWalletView(state,certificate,w.client.config,w.key.publicKey);else assert.equal(stateHash(state,w.client.config),certificate.appHash,'unverified collateral view');
  assert.equal(state.height,certificate.appHeight);return v;
 }
 async review(q,{allowConsolidation=false}={}){const {state,certificate}=await this.current({rewardIds:[q.node]}),review=plan(state,this.wallet.key.publicKey,q,allowConsolidation);this.pending.clear();if(review.preparation)return review;const id=randomBytes(32).toString('hex');
  this.pending.set(id,{q:structuredClone(q),review,expires:this.now()+120000,workerKey:state.money.nodes[q.node].key});
  return {id,body:review.body,display:review.display,verifiedHeight:certificate.height,mode:'CONSENT_ONLY',expiresAt:state.money.time+300};
 }
 async confirm(q){exact(q,['id']);const p=this.pending.get(q.id);this.pending.delete(q.id);assert(p&&this.now()<p.expires,'Collateral review expired. Review again.');
  const {state}=await this.current({rewardIds:[p.q.node]}),b=p.review.body,owner=this.wallet.key.publicKey;
  let fresh;
  if(p.q.operation==='withdraw')fresh=plan(state,owner,p.q);
  else{
   assert(!outsideCollateralPilot(state,b.node),'The server can no longer accept collateral.');
   fresh=prepareCollateralReview(state,{...p.q,owner,inputs:b.inputs});
  }
  assert(state.money.time>=b.issuedAt&&state.money.time<b.expires,'Collateral consent expired. Review again.');
  assert.equal(state.money.nodes[b.node].key,p.workerKey,'Worker key changed. Review again.');
  assert.equal(hash({...fresh.body,issuedAt:b.issuedAt,expires:b.expires}),hash(b),'Balance or collateral terms changed. Review again.');
  if(p.q.operation==='withdraw')assert.deepEqual(fresh.display,p.review.display,'Withdrawable collateral changed. Review again.');
  else assert.equal(fresh.display.selectedFunds,p.review.display.selectedFunds,'Selected funds changed. Review again.');
  return {format:'DUEBYTE_COLLATERAL_OWNER_CONSENT_V1',type:fresh.type,body:b,ownerSignature:sign(b,this.wallet.key.privateKey),expectedWorkerKey:p.workerKey,workerSignatureRequired:true,submitted:false};
 }
 clear(){this.pending.clear();}
}
