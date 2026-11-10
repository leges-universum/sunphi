// Wallet-local consent preparation. No broadcast, worker key or issuance path.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {exact,hash,sign} from './crypto.mjs';
import {parseToken,formatToken} from './token-units.mjs';
import {prepareCollateralReview} from './worker-collateral-plan.mjs';
import {spendPolicy} from './spend-protection.mjs';
import {stateHash} from './core.mjs';
import {isBoundedWalletView,assertBoundedWalletView} from './research/bounded-wallet-view.mjs';
const available=(s,owner)=>Object.entries(s.money.outputs).filter(([,o])=>o.owner===owner&&o.unlock<=s.money.time&&BigInt(o.value)>0n);
export function collateralOptions(s,owner){
 const nodes=Object.entries(s.money.nodes).filter(([id])=>!s.workerFunding?.accounts[id]||s.workerFunding.accounts[id].owner===owner).map(([id,n])=>({id,operator:n.operator,releasePending:!!s.workerFunding?.accounts[id]?.release}));
 const protection=spendPolicy(s,owner),reason=(s.money.unitScale??'1')!=='1000000'||!s.centuryFees?'Collateral funding awaits the compatible network activation.':protection?.enabled||protection?.pending?'Separate collateral approval is not yet available for this protected wallet.':!nodes.length?'No eligible server worker is registered on this network.':null;
 return {enabled:!reason,reason,nodes,available:formatToken(String(available(s,owner).reduce((a,[,o])=>a+BigInt(o.value),0n)),s.money.unitScale??'1'),mode:'CONSENT_ONLY',broadcastEnabled:false};
}
function plan(s,owner,q){
 exact(q,['node','amount','unitScale']);assert(collateralOptions(s,owner).enabled,collateralOptions(s,owner).reason);
 const need=BigInt(parseToken(q.amount,q.unitScale)),inputs=[];let sum=0n;
 // Largest first avoids refusing a sufficiently funded wallet with many dust outputs.
 const outputs=available(s,owner).sort(([a,x],[b,y])=>BigInt(x.value)===BigInt(y.value)?a<b?-1:1:BigInt(x.value)>BigInt(y.value)?-1:1);
 for(const [id,o]of outputs){if(inputs.length===8||sum>=need)break;inputs.push(id);sum+=BigInt(o.value);}
 assert(need>0n&&sum>=need,'Insufficient spendable funds within the eight-input limit.');
 const result=prepareCollateralReview(s,{...q,owner,inputs});
 result.display.available=collateralOptions(s,owner).available;
 const total=outputs.reduce((a,[,o])=>a+BigInt(o.value),0n);result.display.remainingAvailable=formatToken(String(total-need),q.unitScale);
 return result;
}
export class WalletCollateral{
 constructor(wallet,{now=Date.now}={}){this.wallet=wallet;this.now=now;this.pending=new Map();}
 async current(){const v=await this.wallet.view(),{state,certificate}=v,w=this.wallet;
  if(isBoundedWalletView(state))assertBoundedWalletView(state,certificate,w.client.config,w.key.publicKey);else assert.equal(stateHash(state,w.client.config),certificate.appHash,'unverified collateral view');
  assert.equal(state.height,certificate.appHeight);return v;
 }
 async review(q){const {state,certificate}=await this.current(),review=plan(state,this.wallet.key.publicKey,q);this.pending.clear();const id=randomBytes(32).toString('hex');
  this.pending.set(id,{q:structuredClone(q),review,expires:this.now()+120000,workerKey:state.money.nodes[q.node].key});
  return {id,body:review.body,display:review.display,verifiedHeight:certificate.height,mode:'CONSENT_ONLY',expiresAt:state.money.time+300};
 }
 async confirm(q){exact(q,['id']);const p=this.pending.get(q.id);this.pending.delete(q.id);assert(p&&this.now()<p.expires,'Collateral review expired. Review again.');
  const {state}=await this.current(),fresh=plan(state,this.wallet.key.publicKey,p.q),b=p.review.body;
  assert(state.money.time>=b.issuedAt&&state.money.time<b.expires,'Collateral consent expired. Review again.');
  assert.equal(state.money.nodes[b.node].key,p.workerKey,'Worker key changed. Review again.');
  assert.equal(hash({...fresh.body,issuedAt:b.issuedAt,expires:b.expires}),hash(b),'Balance or collateral terms changed. Review again.');
  assert.deepEqual(fresh.display,p.review.display,'Available balance changed. Review again.');
  return {format:'DUEBYTE_COLLATERAL_OWNER_CONSENT_V1',type:fresh.type,body:b,ownerSignature:sign(b,this.wallet.key.privateKey),expectedWorkerKey:p.workerKey,workerSignatureRequired:true,submitted:false};
 }
 clear(){this.pending.clear();}
}
