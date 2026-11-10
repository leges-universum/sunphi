// Isolated native-template candidate. Not admitted by the live chain interpreter.
// External payment truth is attested by a pinned quorum, not proved by this VM.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,publicKey,verify} from '../crypto.mjs';
export const PURCHASE='DUEBYTE_PROTECTED_PURCHASE_LAB_V1';
const units=v=>{assert(typeof v==='string'&&/^(0|[1-9][0-9]{0,23})$/.test(v),'canonical atomic amount');return BigInt(v);};
const label=v=>assert(typeof v==='string'&&v.length>0&&v.length<=160&&!/[\u0000-\u001f\u007f]/.test(v),'bounded text');
export const orderId=offer=>hash(offer);
export const acceptance=(policy,offer)=>({domain:PURCHASE+'/ACCEPT',policyHash:hash(policy),orderId:orderId(offer)});
export function purchasePolicy(p){
 exact(p,['domain','isolated','network','seller','sellerName','attesters','threshold','routes',...(p.rpcPins?['rpcPins']:[])]);
 assert.equal(p.domain,PURCHASE);assert.equal(p.isolated,true,'live purchase admission is closed');
 assert(/^duebyte-purchase-lab-[a-z0-9-]+$/.test(p.network),'isolated chain required');publicKey(p.seller);label(p.sellerName);
 assert(p.attesters.length===3&&new Set(p.attesters).size===3&&p.threshold===2,'two of three payment attesters');
 p.attesters.forEach(publicKey);assert(!p.attesters.includes(p.seller),'seller cannot attest payment');
 if(p.rpcPins){
  exact(p.rpcPins,['BTC','USDC']);exact(p.rpcPins.BTC,['genesis']);hex(p.rpcPins.BTC.genesis);
  exact(p.rpcPins.USDC,['genesis','chainId','contract']);
  assert(/^0x[a-f0-9]{64}$/.test(p.rpcPins.USDC.genesis));assert(/^0x[1-9a-f][a-f0-9]*$/.test(p.rpcPins.USDC.chainId));
  assert(/^0x[a-f0-9]{40}$/.test(p.rpcPins.USDC.contract));
 }
 exact(p.routes,['BTC','USDC']);
 for(const [id,r] of Object.entries(p.routes)){
  exact(r,['network','asset','decimals','confirmations']);label(r.network);label(r.asset);integer(r.confirmations,1);
  assert.equal(r.decimals,id==='BTC'?8:6);assert(r.confirmations<=100);
  assert.equal(r.network,id==='BTC'?'bitcoin-regtest':'ethereum-local');
  assert.equal(r.asset,id==='BTC'?'native':'test-usdc','test assets only');
 }
}
export function purchaseGenesis(policy,inventoryMicro){
 purchasePolicy(policy);assert(units(inventoryMicro)>0n);
 return {policy:structuredClone(policy),time:0,supplyMicro:inventoryMicro,balances:{[policy.seller]:inventoryMicro},orders:{},used:{},destinations:{}};
}
export function auditPurchase(s){
 purchasePolicy(s.policy);integer(s.time);let total=0n;
 assert(Object.keys(s.orders).length<=16&&Object.keys(s.used).length<=64,'bounded pilot capacity');
 for(const [owner,value]of Object.entries(s.balances)){publicKey(owner);total+=units(value);}
 for(const o of Object.values(s.orders)){
  assert(['AWAITING_PAYMENT','CONFIRMING','PAYMENT_REVIEW','LATE_PAYMENT_REVIEW','COMPLETED','CANCELLED','REFUNDED'].includes(o.status));
  assert.equal(o.escrowMicro,['COMPLETED','CANCELLED','REFUNDED','LATE_PAYMENT_REVIEW'].includes(o.status)?'0':o.offer.dubytMicro);
  total+=units(o.escrowMicro);
 }
 assert.equal(total,units(s.supplyMicro),'escrow conservation');
}
function checkOffer(s,o,signature,now){
 exact(o,['domain','policyHash','network','nonce','seller','buyer','route','dubytMicro','payAtomic','feeAtomic','destination','refundDestination','createdAt','quoteUntil','payUntil']);
 assert.equal(o.domain,PURCHASE+'/OFFER');assert.equal(o.policyHash,hash(s.policy));assert.equal(o.network,s.policy.network);
 hex(o.nonce);publicKey(o.buyer);assert.notEqual(o.buyer,s.policy.seller);assert.equal(o.seller,s.policy.seller);
 assert(Object.hasOwn(s.policy.routes,o.route));assert(units(o.dubytMicro)>0n&&units(o.payAtomic)>0n);assert(units(o.feeAtomic)<=units(o.payAtomic));
 label(o.destination);label(o.refundDestination);assert.notEqual(o.destination,o.refundDestination);
 integer(o.createdAt,1);integer(o.quoteUntil,o.createdAt+1);integer(o.payUntil,o.quoteUntil+1);
 assert(o.quoteUntil-o.createdAt<=300&&o.payUntil-o.createdAt<=3600,'bounded UTC quote/payment windows');
 assert(now>=o.createdAt&&now<=o.quoteUntil,'quote expired or future');assert(verify(o,signature,s.policy.seller),'seller offer signature');
}
// Wallets validate seller terms before signing an acceptance.
export function verifyPurchaseOffer(policy,offer,signature,now){
 purchasePolicy(policy);checkOffer({policy},offer,signature,now);return offer;
}
function attest(s,b,approvals){
 assert.equal(b.domain,PURCHASE+'/EVIDENCE');assert.equal(b.policyHash,hash(s.policy));assert.equal(b.network,s.policy.network);
 integer(b.observedAt,1);assert(b.observedAt<=s.time&&s.time-b.observedAt<=300,'fresh evidence required');
 assert(Array.isArray(approvals)&&approvals.length<=3);const seen=new Set();
 for(const a of approvals){exact(a,['key','signature']);assert(s.policy.attesters.includes(a.key)&&!seen.has(a.key),'independent pinned attester');assert(verify(b,a.signature,a.key),'payment attester signature');seen.add(a.key);}
 assert(seen.size>=s.policy.threshold,'payment quorum required');
}
function credit(s,owner,value){s.balances[owner]=String(units(s.balances[owner]??'0')+units(value));}
export function applyPurchase(base,command,now){
 auditPurchase(base);integer(now,base.time);const s=structuredClone(base);s.time=now;
 if(command.type==='RESERVE'){
  exact(command,['type','offer','sellerSignature','buyerSignature']);const o=command.offer,id=orderId(o);
  assert(verify(acceptance(s.policy,o),command.buyerSignature,o.buyer),'buyer acceptance');
  assert(verify(o,command.sellerSignature,s.policy.seller),'seller offer signature');
  if(s.orders[id])return base;
  checkOffer(s,o,command.sellerSignature,now);assert(Object.keys(s.orders).length<16,'pilot order capacity');
  const destination=hash({route:o.route,destination:o.destination});assert(!s.destinations[destination],'deposit destination must be unique');
  const available=units(s.balances[o.seller]);assert(available>=units(o.dubytMicro),'seller inventory unavailable');
  s.balances[o.seller]=String(available-units(o.dubytMicro));s.destinations[destination]=id;
  s.orders[id]={offer:o,status:'AWAITING_PAYMENT',escrowMicro:o.dubytMicro,received:[],lastEvidence:null};
 }else{
  exact(command,['type','body','approvals']);const b=command.body,o=s.orders[b.orderId];assert(o,'unknown order');
  const q=o.offer,r=s.policy.routes[q.route];
  exact(b,['domain','policyHash','network','orderId','kind','observedAt','externalNetwork','asset','destination','amountAtomic','txid','index','confirmations','paidAt','reference','refunds']);
  attest(s,b,command.approvals);assert.equal(command.type,'EVIDENCE');
  assert.equal(b.externalNetwork,r.network);assert.equal(b.asset,r.asset);units(b.amountAtomic);integer(b.index);integer(b.confirmations);integer(b.paidAt);assert(b.paidAt<=b.observedAt);
  assert(Array.isArray(b.refunds)&&b.refunds.length<=16);b.refunds.forEach(hex);assert(new Set(b.refunds).size===b.refunds.length);assert(b.reference===null||typeof b.reference==='string'&&/^[a-f0-9]{64}$/.test(b.reference));
  const evidenceHash=hash(b);if(o.lastEvidence===evidenceHash)return base;
  assert(!['COMPLETED','REFUNDED'].includes(o.status),'terminal order; additional payments need external recovery');
  if(o.status==='CANCELLED')assert.equal(b.kind,'PAYMENT','cancelled purchase only accepts late-payment evidence');
  if(b.kind==='UNPAID'){
   assert.equal(b.destination,q.destination);assert.equal(b.amountAtomic,'0');assert.equal(b.txid,null);assert.equal(b.reference,null);assert.equal(b.refunds.length,0);
   assert(now>q.payUntil+3600&&b.observedAt>q.payUntil+3600,'unpaid observation grace');
   assert(o.received.length===0,'known payment prevents cancellation');
   // A signed absence is an explicit trusted decision, never a local timeout.
   credit(s,q.seller,o.escrowMicro);o.escrowMicro='0';o.status='CANCELLED';
  }else{
   hex(b.txid);const event=hash({network:b.externalNetwork,txid:b.txid,index:b.index});
   if(b.kind==='PAYMENT'){
    assert.equal(b.destination,q.destination);assert.equal(b.reference,null);assert.equal(b.refunds.length,0);assert(units(b.amountAtomic)>0n);
    assert(!s.used[event]||s.used[event]===b.orderId,'payment event already assigned');
    let record=o.received.find(x=>x.event===event);
    if(record){assert.equal(record.amountAtomic,b.amountAtomic);assert.equal(record.paidAt,b.paidAt);assert(b.observedAt>=record.observedAt,'out-of-order observation');}
    else{assert(o.received.length<16&&Object.keys(s.used).length<64,'evidence capacity');record={event,amountAtomic:b.amountAtomic,paidAt:b.paidAt};o.received.push(record);s.used[event]=b.orderId;}
    Object.assign(record,{confirmations:b.confirmations,observedAt:b.observedAt});
    // Partial, excess, late or multiple transfers stay locked for explicit refund.
    const exactPayment=!o.refundIntent&&o.received.length===1&&b.amountAtomic===q.payAtomic&&b.paidAt>=q.createdAt&&b.paidAt<=q.payUntil;
    if(o.escrowMicro==='0')o.status='LATE_PAYMENT_REVIEW';
    else if(exactPayment&&b.confirmations>=r.confirmations){credit(s,q.buyer,o.escrowMicro);o.escrowMicro='0';o.status='COMPLETED';}
    else o.status=exactPayment?'CONFIRMING':'PAYMENT_REVIEW';
   }else{
    assert.equal(b.kind,'REFUND');assert.equal(b.destination,q.refundDestination,'pinned refund destination');
    assert(o.received.length>0&&b.confirmations>=r.confirmations,'confirmed refund required');
    assert.equal(b.reference,b.orderId);assert(!s.used[event],'refund event already consumed');
    assert.deepEqual([...b.refunds].sort(),o.received.map(x=>x.event).sort(),'refund must cover all observed deposits');
    assert.equal(units(b.amountAtomic),o.received.reduce((n,x)=>n+units(x.amountAtomic),0n),'full external refund');
    assert(b.paidAt>=Math.max(...o.received.map(x=>x.paidAt)),'refund predates payment');
    assert(Object.keys(s.used).length<64);s.used[event]=b.orderId;credit(s,q.seller,o.escrowMicro);o.escrowMicro='0';o.status='REFUNDED';
   }
  }
  o.lastEvidence=evidenceHash;
 }
 auditPurchase(s);return s;
}
