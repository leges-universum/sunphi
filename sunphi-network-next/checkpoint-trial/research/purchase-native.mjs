// Isolated consensus qualification. No public-chain activation or mint path.
import assert from 'node:assert/strict';
import {exact,hash,hex,verify} from '../crypto.mjs';
import {amount,MAX} from '../payment-model.mjs';
import {spendPolicy} from '../spend-protection.mjs';
import {centuryRestrictedAccounts} from '../century-funds.mjs';
import {centuryWarmupAccounts,memorialPolicy} from '../economic-policy-v3.mjs';
import {reserveAddresses} from '../network-reserves.mjs';
import {supportAccount} from '../support-accounting.mjs';
import {PURCHASE,purchasePolicy,applyPurchase,auditPurchase,orderId} from './purchase-contract.mjs';
export const PURCHASE_ACTION='EXECUTE_PURCHASE_LAB_V1';
export const purchaseOutput=(configHash,id,role)=>hash({domain:PURCHASE_ACTION,configHash,id,role});
export function checkPurchaseConfig(c){
 if(!c.purchaseLab)return;
 exact(c.purchaseLab,['policy','feeMicro']);purchasePolicy(c.purchaseLab.policy);
 assert(c.purchaseLab.policy.rpcPins,'genesis and stablecoin contract pins required');
 assert(/^duebyte-trial-purchase-lab-[a-z0-9-]+$/.test(c.chainId),'purchase laboratory chain only');
 assert.equal(c.purchaseLab.policy.network,c.chainId.replace('duebyte-trial-','duebyte-'));
 assert(amount(c.purchaseLab.feeMicro)>0n,'explicit nonzero laboratory fee');
}
export function auditNativePurchase(s,c){
 if(!s.purchaseBook)return;
 assert(c.purchaseLab,'purchase state without genesis authorization');checkPurchaseConfig(c);
 const b=s.purchaseBook;auditPurchase(b);assert.deepEqual(b.policy,c.purchaseLab.policy);
 // Virtual balances are drained into real outputs in the same atomic frame.
 assert(Object.values(b.balances).every(v=>v==='0'),'unsettled purchase accounting');
 for(const [id,o]of Object.entries(b.orders)){
  assert.equal(id,orderId(o.offer));const held=s.money.outputs[purchaseOutput(s.configHash,id,'escrow')];
  if(o.escrowMicro!=='0')assert.deepEqual(held,{owner:b.policy.seller,value:o.escrowMicro,unlock:Number.MAX_SAFE_INTEGER},'native escrow backing');
  else assert(!held,'terminal escrow retained');
 }
}
export function executeNativePurchase(s,a,author,c){
 assert(c.purchaseLab,'protected purchase admission disabled');checkPurchaseConfig(c);
 exact(a,['type','command','inputs']);assert.equal(a.type,PURCHASE_ACTION);
 assert.equal(s.money.unitScale,'1000000','fractional denomination required');
 const p=c.purchaseLab.policy,command=a.command;
 let book=structuredClone(s.purchaseBook??{policy:p,time:0,supplyMicro:'0',balances:{[p.seller]:'0'},orders:{},used:{},destinations:{}});
 const id=command.type==='RESERVE'?orderId(command.offer):command.body?.orderId;hex(id);
 assert(Array.isArray(a.inputs)&&a.inputs.length<=8);a.inputs.forEach(hex);
 assert.deepEqual(a.inputs,[...new Set(a.inputs)].sort(),'canonical purchase funding inputs');
 const prior=book.orders[id],escrow=purchaseOutput(s.configHash,id,'escrow');
 if(command.type==='RESERVE'){
  assert.equal(author,p.seller,'seller funds the reservation');
  assert(![...centuryRestrictedAccounts(s.configHash),...centuryWarmupAccounts(s.configHash),memorialPolicy(s.configHash).account,...Object.values(reserveAddresses(s.configHash)),supportAccount(s.configHash)].includes(p.seller),'programme funds cannot fund a sale');
  const protection=spendPolicy(s,p.seller);
  assert(!protection?.enabled&&!protection?.pending,'protected seller requires separate purchase consent');
  if(!prior){
   assert(a.inputs.length>0);const value=amount(command.offer.dubytMicro),fee=amount(c.purchaseLab.feeMicro);
   let total=0n;for(const input of a.inputs){const o=s.money.outputs[input];assert(o&&o.owner===p.seller,'missing or foreign seller funding');assert(o.unlock<=s.money.time,'locked seller funding');total+=amount(o.value);}
   assert(total>=value+fee&&total<=MAX,'seller inventory and fee unavailable');
   const change=purchaseOutput(s.configHash,id,'change');assert(!s.money.outputs[escrow]&&!s.money.outputs[change],'purchase output collision');
   book.balances[p.seller]=String(value);book.supplyMicro=String(amount(book.supplyMicro)+value);
   // Validate before writes; outer interpreter also rolls back failed frames.
   book=applyPurchase(book,command,s.money.time);
   for(const input of a.inputs)delete s.money.outputs[input];
   s.money.outputs[escrow]={owner:p.seller,value:String(value),unlock:Number.MAX_SAFE_INTEGER};
   if(total>value+fee)s.money.outputs[change]={owner:p.seller,value:String(total-value-fee),unlock:0};
   s.money.fees=String(amount(s.money.fees)+fee);
  }else book=applyPurchase(book,command,s.money.time);
 }else{
  assert.equal(a.inputs.length,0);assert(p.attesters.includes(author),'pinned payment observer submits evidence');
  if(command.body?.kind==='REFUND_INTENT'){
   exact(command,['type','body','approvals']);assert.equal(command.type,'EVIDENCE');const b=command.body;
   exact(b,['domain','policyHash','network','orderId','kind','observedAt','destination','amountAtomic','refunds']);
   assert.equal(b.domain,PURCHASE+'/REFUND_INTENT');assert.equal(b.policyHash,hash(p));assert.equal(b.network,p.network);
   assert(prior&&!['COMPLETED','CANCELLED','REFUNDED'].includes(prior.status),'refundable order required');
   assert(Number.isSafeInteger(b.observedAt)&&b.observedAt<=s.money.time&&s.money.time-b.observedAt<=300,'fresh refund intent');
   assert.equal(b.destination,prior.offer.refundDestination);assert(prior.received.length>0);
   assert(prior.received.every(x=>x.confirmations>=p.routes[prior.offer.route].confirmations&&s.money.time-x.observedAt<=300),'confirmed fresh deposits required before refund intent');
   assert.equal(amount(b.amountAtomic),prior.received.reduce((n,x)=>n+amount(x.amountAtomic),0n));
   assert.deepEqual(b.refunds,[...prior.received.map(x=>x.event)].sort());
   const seen=new Set();assert(Array.isArray(command.approvals)&&command.approvals.length<=3);
   for(const v of command.approvals){exact(v,['key','signature']);assert(p.attesters.includes(v.key)&&!seen.has(v.key)&&verify(b,v.signature,v.key),'refund intent quorum');seen.add(v.key);}
   assert(seen.size>=p.threshold,'refund intent quorum');
   if(prior.refundIntent)assert.equal(hash(prior.refundIntent),hash(b),'refund intent is immutable');
   prior.refundIntent=b;prior.status=prior.escrowMicro==='0'?'LATE_PAYMENT_REVIEW':'PAYMENT_REVIEW';
   s.purchaseBook=book;auditNativePurchase(s,c);return s;
  }
  if(command.body?.kind==='REFUND'){
   assert(prior?.refundIntent,'commit refund intent before external broadcast');
   assert.equal(command.body.amountAtomic,prior.refundIntent.amountAtomic);
   assert.deepEqual([...command.body.refunds].sort(),prior.refundIntent.refunds);
  }
  book=applyPurchase(book,command,s.money.time);
  for(const [owner,value]of Object.entries(book.balances))if(value!=='0'){
   const held=s.money.outputs[escrow];assert(held&&held.value===value&&held.owner===p.seller&&held.unlock===Number.MAX_SAFE_INTEGER,'escrow backing required');
   const output=purchaseOutput(s.configHash,id,'settlement');assert(!s.money.outputs[output],'purchase already settled');
   delete s.money.outputs[escrow];s.money.outputs[output]={owner,value,unlock:0};
   book.balances[owner]='0';book.supplyMicro=String(amount(book.supplyMicro)-amount(value));
  }
 }
 s.purchaseBook=book;auditNativePurchase(s,c);return s;
}
