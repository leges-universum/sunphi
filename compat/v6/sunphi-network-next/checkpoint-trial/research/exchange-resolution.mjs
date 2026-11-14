// Outcome-based isolated exchange. No production admission or oracle bypass.
import assert from 'node:assert/strict';
import {hash,hex,integer,verify,exact} from '../crypto.mjs';
export const EXCHANGE_V2='DUEBYTE_CONDITIONAL_EXCHANGE_LAB_V2';
export const armAcceptance=(q,plan)=>({domain:EXCHANGE_V2+'/ARM',order:hash(q),planHash:hash(plan)});
export function checkExchangePlan(q,plan){
 exact(plan,q.asset==='BTC'?['domain','order','asset','fundingTransaction','index','claimKey','refundKey','feeAtomic']:['domain','order','asset','escrow','codeHash']);
 assert.equal(plan.domain,EXCHANGE_V2+'/PLAN');assert.equal(plan.order,hash(q));assert.equal(plan.asset,q.asset);
 if(q.asset==='BTC'){
  hex(plan.fundingTransaction);integer(plan.index,0);assert(plan.index<1000000);assert.equal(plan.feeAtomic,'1000','isolated fee policy');
  for(const k of [plan.claimKey,plan.refundKey])assert(/^(02|03)[a-f0-9]{64}$/.test(k));assert.notEqual(plan.claimKey,plan.refundKey);
 }else{assert(/^0x[a-f0-9]{40}$/.test(plan.escrow)&&!/^0x0{40}$/.test(plan.escrow));hex(plan.codeHash);}
}
export function checkExchangeArm(q,command){
 exact(command,['type','id','plan','providerSignature','userSignature']);assert.equal(command.type,'ARM');assert.equal(command.id,hash(q));checkExchangePlan(q,command.plan);
 const body=armAcceptance(q,command.plan);assert(verify(body,command.providerSignature,q.provider),'provider plan consent');assert(verify(body,command.userSignature,q.user),'user plan consent');
}
export const resolutionEvent=b=>hash({domain:EXCHANGE_V2+'/EVENT',order:b.order,planHash:b.planHash,asset:b.asset,genesis:b.genesis,escrow:b.escrow,status:b.status,transaction:b.transaction});
export function verifyExchangeResolution(p,q,plan,receipt,now){
 assert.equal(p.domain,EXCHANGE_V2);checkExchangePlan(q,plan);exact(receipt,['body','signatures']);const b=receipt.body;
 exact(b,['domain','policyHash','order','planHash','asset','network','genesis','contract','escrow','status','transaction','block','amountAtomic','recipient','refundAddress','executedAt','observedAt','expiresAt']);
 assert.equal(b.domain,EXCHANGE_V2+'/RESOLUTION');assert.equal(b.policyHash,hash(p));assert.equal(b.order,hash(q));assert.equal(b.planHash,hash(plan));assert.equal(b.asset,q.asset);
 for(const f of ['network','genesis','contract'])assert.equal(b[f],p.routes[q.asset][f]);
 assert.equal(b.escrow,q.asset==='BTC'?plan.fundingTransaction+':'+plan.index:plan.escrow+':'+hash(q));
 assert(['PAYOUT','REFUND','CANCELLED'].includes(b.status));hex(b.transaction);hex(b.block);assert.equal(b.amountAtomic,q.externalAtomic);
 assert.equal(b.recipient,b.status==='PAYOUT'?q.externalRecipient:q.externalRefund);assert.equal(b.refundAddress,q.externalRefund);
 integer(b.executedAt,q.createdAt);integer(b.observedAt,b.executedAt);integer(b.expiresAt,b.observedAt);
 assert(b.observedAt<=now&&now<=b.expiresAt&&b.expiresAt-b.observedAt<=300,'fresh resolution observation required');
 if(b.status==='REFUND')assert(b.executedAt>=q.externalUntil,'external refund too early');
 // Bitcoin CLTV opens refunds but does not expire the claim branch.
 else if(b.status==='PAYOUT'&&q.asset==='USDC')assert(b.executedAt<q.externalUntil,'external claim execution deadline');
 assert(Array.isArray(receipt.signatures)&&receipt.signatures.length>=2&&receipt.signatures.length<=3);const seen=new Set();
 for(const s of receipt.signatures){exact(s,['observer','signature']);assert(p.observers.includes(s.observer)&&!seen.has(s.observer));assert(verify(b,s.signature,s.observer),'invalid resolution signature');seen.add(s.observer);}
 return b;
}
export function applyExchangeResolution(previous,command,now,{checkQuote,audit}){
 integer(now,1);assert(now>=previous.time,'consensus clock regression');const s=structuredClone(previous),p=s.policy;
 assert.equal(p.domain,EXCHANGE_V2);
 const id=command.type==='LOCK'?hash(command.quote):command.id;hex(id);
 if(command.type==='LOCK'){
  exact(command,['type','quote','providerSignature','userSignature']);const q=command.quote;
  assert(verify(q,command.providerSignature,p.provider),'provider signature');assert(verify({domain:EXCHANGE_V2+'/ACCEPT',id},command.userSignature,q.user),'user acceptance');
  if(s.orders[id])return previous;checkQuote(p,q,now);assert(!s.hashes[q.hashlock]);assert(Object.keys(s.orders).length<32);
  const payer=q.direction==='BUY_DUBYT'?q.provider:q.user,value=BigInt(q.dubytAtomic),balance=BigInt(s.balances[payer]??'0');assert(balance>=value);
  s.balances[payer]=String(balance-value);s.orders[id]={quote:q,status:'LOCKED',plan:null};s.hashes[q.hashlock]=id;
 }else{
  const o=s.orders[id];assert(o,'unknown order');const q=o.quote;
  if(command.type==='ARM'){
   checkExchangeArm(q,command);
   if(o.plan){assert.deepEqual(o.plan,command.plan,'plan already fixed');return previous;}
   assert.equal(o.status,'LOCKED');assert(now<q.dubytUntil&&now+p.minGap<q.externalUntil,'insufficient execution window');o.plan=structuredClone(command.plan);
  }else{
   assert(['RESOLVE','REFUND'].includes(command.type));exact(command,command.type==='RESOLVE'?['type','id','receipt']:['type','id']);
   let status,receiver;
   if(command.type==='REFUND'){
    assert(!o.plan,'armed exchange requires external outcome proof');if(o.status==='REFUNDED')return previous;
    assert.equal(o.status,'LOCKED');assert(now>=q.dubytUntil,'refund too early');status='REFUNDED';
   }else{
    assert(o.plan,'exchange not armed');const b=verifyExchangeResolution(p,q,o.plan,command.receipt,now),event=resolutionEvent(b);status=b.status==='PAYOUT'?'CLAIMED':'REFUNDED';
    if(o.status!=='LOCKED'){assert.equal(o.status,status,'conflicting terminal outcome');assert.equal(o.resolution,event,'different terminal event');return previous;}
    o.resolution=event;o.evidence=hash(command.receipt);
   }
   assert.equal(o.status,'LOCKED');receiver=status==='REFUNDED'?(q.direction==='BUY_DUBYT'?q.provider:q.user):(q.direction==='BUY_DUBYT'?q.user:q.provider);
   s.balances[receiver]=String(BigInt(s.balances[receiver]??'0')+BigInt(q.dubytAtomic));o.status=status;
  }
 }
 s.time=now;audit(s);return s;
}
