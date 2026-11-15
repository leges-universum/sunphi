// Isolated custody kernel. Not a public transaction or issuance authorization.
// Adapters must supply authenticated worker/collateral records and a separately
// admitted regular-issuance allocation. No wallet receipt can fund this book.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer} from '../crypto.mjs';
import {amount} from '../payment-model.mjs';
import {anniversary} from '../economic-policy-v2.mjs';
export const SUPPORT_BOOK='DUEBYTE_LOCKED_COLLATERAL_SUPPORT_V1';
const min=(a,b)=>a<b?a:b;
const sum=values=>values.reduce((n,v)=>n+amount(v),0n);
export function createSupportBook(q){
 exact(q,['configHash','warmupStart','allocationReference','allocationMicro','perNodeCapMicro','ownerCaps','matchPPM','bootstrapNodes']);
 hex(q.configHash);hex(q.allocationReference);integer(q.warmupStart,1);integer(q.matchPPM);assert(q.matchPPM<=1000000);
 assert(amount(q.allocationMicro)>0n&&amount(q.perNodeCapMicro)>0n);
 assert(Array.isArray(q.bootstrapNodes)&&q.bootstrapNodes.length<=64);q.bootstrapNodes.forEach(hex);assert.equal(new Set(q.bootstrapNodes).size,q.bootstrapNodes.length);
 const owners=Object.entries(q.ownerCaps);assert(owners.length>0&&owners.length<=1024);for(const [id,value]of owners){hex(id);amount(value);}
 const b={version:SUPPORT_BOOK,configHash:q.configHash,start:q.warmupStart,end:anniversary(q.warmupStart,5),
  allocationReference:q.allocationReference,issuedMicro:q.allocationMicro,poolMicro:q.allocationMicro,
  policy:{perNodeCapMicro:q.perNodeCapMicro,ownerCaps:structuredClone(q.ownerCaps),matchPPM:q.matchPPM,bootstrapNodes:[...q.bootstrapNodes].sort()},
  grants:{},ownerGranted:{},history:hash(q)};
 auditSupportBook(b);return b;
}
export function auditSupportBook(b){
 exact(b,['version','configHash','start','end','allocationReference','issuedMicro','poolMicro','policy','grants','ownerGranted','history']);
 assert.equal(b.version,SUPPORT_BOOK);hex(b.configHash);hex(b.allocationReference);hex(b.history);integer(b.start,1);assert.equal(b.end,anniversary(b.start,5));
 const p=b.policy;exact(p,['perNodeCapMicro','ownerCaps','matchPPM','bootstrapNodes']);integer(p.matchPPM);assert(p.matchPPM<=1000000);assert(amount(p.perNodeCapMicro)>0n);
 assert(Array.isArray(p.bootstrapNodes)&&p.bootstrapNodes.length<=64);p.bootstrapNodes.forEach(hex);assert.deepEqual(p.bootstrapNodes,[...new Set(p.bootstrapNodes)].sort());
 assert(Object.keys(p.ownerCaps).length>0&&Object.keys(p.ownerCaps).length<=1024);for(const [id,value]of Object.entries(p.ownerCaps)){hex(id);amount(value);}
 assert(Object.keys(b.grants).length<=1024);const owners={};let locked=0n,loss=0n;
 for(const [node,g]of Object.entries(b.grants)){
  hex(node);exact(g,['ownerGroup','grantedMicro','lockedMicro','returnedMicro','slashedMicro','claimHash','at','returnAfter','returned']);hex(g.ownerGroup);hex(g.claimHash);
  integer(g.at,b.start);assert(g.at<b.end);assert(amount(g.grantedMicro)>0n&&amount(g.grantedMicro)<=amount(p.perNodeCapMicro));
  assert.equal(amount(g.grantedMicro),sum([g.lockedMicro,g.returnedMicro,g.slashedMicro]));
  assert(g.returnAfter===null||Number.isSafeInteger(g.returnAfter)&&g.returnAfter>=g.at+86400);assert(typeof g.returned==='boolean');
  if(g.returned)assert.equal(g.lockedMicro,'0');else assert.equal(g.returnedMicro,'0');
  owners[g.ownerGroup]=(owners[g.ownerGroup]??0n)+amount(g.grantedMicro);locked+=amount(g.lockedMicro);loss+=amount(g.slashedMicro);
 }
 assert.deepEqual(Object.fromEntries(Object.entries(owners).map(([id,value])=>[id,String(value)])),b.ownerGranted);
 for(const [id,value]of Object.entries(owners)){assert(Object.hasOwn(p.ownerCaps,id));assert(value<=amount(p.ownerCaps[id]));}
 assert.equal(amount(b.issuedMicro),amount(b.poolMicro)+locked+loss,'support conservation');return true;
}
function transition(book,kind,q,run){auditSupportBook(book);const b=structuredClone(book);const result=run(b);b.history=hash({previous:book.history,kind,request:q});auditSupportBook(b);return {book:b,...result,mintedMicro:'0',walletCreditMicro:'0'};}
export function claimSupport(book,q){
 exact(q,['configHash','node','ownerGroup','ownCollateralMicro','at']);assert.equal(q.configHash,book.configHash);hex(q.node);hex(q.ownerGroup);integer(q.at,1);amount(q.ownCollateralMicro);
 const prior=book.grants[q.node];if(prior){assert.equal(prior.claimHash,hash(q),'node already received its one-time support');auditSupportBook(book);return {book,stakeCreditMicro:'0',mintedMicro:'0',walletCreditMicro:'0',duplicate:true};}
 return transition(book,'CLAIM',q,b=>{
  assert(q.at>=b.start&&q.at<b.end,'five-year support eligibility window');assert(Object.keys(b.grants).length<1024,'bounded admission capacity');assert(Object.hasOwn(b.policy.ownerCaps,q.ownerGroup),'admitted owner group required');
  const cap=amount(b.policy.perNodeCapMicro),v=b.policy.bootstrapNodes.includes(q.node)?cap:min(cap,amount(q.ownCollateralMicro)*BigInt(b.policy.matchPPM)/1000000n);
  assert(v>0n,'own matching capital required');assert(v<=amount(b.poolMicro),'insufficient pool: no partial one-time award');
  const owner=amount(b.ownerGranted[q.ownerGroup]??'0')+v;assert(owner<=amount(b.policy.ownerCaps[q.ownerGroup]),'lifetime owner cap');
  b.poolMicro=String(amount(b.poolMicro)-v);b.ownerGranted[q.ownerGroup]=String(owner);
  b.grants[q.node]={ownerGroup:q.ownerGroup,grantedMicro:String(v),lockedMicro:String(v),returnedMicro:'0',slashedMicro:'0',claimHash:hash(q),at:q.at,returnAfter:null,returned:false};
  return {stakeCreditMicro:String(v),duplicate:false};
 });
}
// Call atomically with a proven penalty. Owned capital takes losses first;
// support remaining cannot increase when the owner adds new capital later.
export function reconcileSupportPenalty(book,{node,stakeAfterMicro,reference}){
 hex(node);hex(reference);const stake=amount(stakeAfterMicro);
 return transition(book,'PROVEN_PENALTY',{node,stakeAfterMicro,reference},b=>{
  const g=b.grants[node];assert(g&&!g.returned,'active supported worker');const next=min(stake,amount(g.lockedMicro)),loss=amount(g.lockedMicro)-next;
  g.lockedMicro=String(next);g.slashedMicro=String(amount(g.slashedMicro)+loss);return {supportLossMicro:String(loss)};
 });
}
export function queueSupportReturn(book,{node,at,challengeSeconds}){
 hex(node);integer(at,1);integer(challengeSeconds);assert(challengeSeconds<=100000);
 return transition(book,'QUEUE_RETURN',{node,at,challengeSeconds},b=>{
  const g=b.grants[node];assert(g&&!g.returned,'active supported worker');integer(at,g.at);assert(g.returnAfter===null,'return already queued');
  g.returnAfter=at+Math.max(86400,challengeSeconds);integer(g.returnAfter,1);return {drainWorker:true,readyAt:g.returnAfter};
 });
}
export function returnSupport(book,q){
 exact(q,['node','at','tier','heldMicro','unresolvedLiabilities','stakeMicro']);hex(q.node);integer(q.at,1);integer(q.unresolvedLiabilities);amount(q.heldMicro);amount(q.stakeMicro);
 const prior=book.grants[q.node];if(prior?.returned){auditSupportBook(book);return {book,stakeDebitMicro:'0',mintedMicro:'0',walletCreditMicro:'0',duplicate:true};}
 return transition(book,'RETURN',q,b=>{
  const g=b.grants[q.node];assert(g&&g.returnAfter!==null&&q.at>=g.returnAfter,'support cooldown');
  assert.equal(q.tier,'0','worker must be drained');assert.equal(q.heldMicro,'0','held obligations');assert.equal(q.unresolvedLiabilities,0,'unresolved liability');
  assert(amount(q.stakeMicro)>=amount(g.lockedMicro),'reconcile proved losses before return');
  const value=g.lockedMicro;b.poolMicro=String(amount(b.poolMicro)+amount(value));g.returnedMicro=value;g.lockedMicro='0';g.returned=true;
  return {stakeDebitMicro:value,duplicate:false};
 });
}
export function ownedRefundWithSupport({stakeMicro,initialOwnedStakeMicro,ownedDepositedMicro,ownedWithdrawnMicro,heldMicro,lockedSupportMicro}){
 const stake=amount(stakeMicro),initial=amount(initialOwnedStakeMicro),deposited=amount(ownedDepositedMicro),withdrawn=amount(ownedWithdrawnMicro),held=amount(heldMicro),support=amount(lockedSupportMicro);
 assert(withdrawn<=deposited);const protectedCapital=initial+support,floor=protectedCapital>held?protectedCapital:held;
 return String(min(stake>floor?stake-floor:0n,deposited-withdrawn));
}
