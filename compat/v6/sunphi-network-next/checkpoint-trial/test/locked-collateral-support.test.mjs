import test from 'node:test';import assert from 'node:assert/strict';
import {hash} from '../crypto.mjs';import {anniversary} from '../economic-policy-v2.mjs';
import {createSupportBook,auditSupportBook,claimSupport,reconcileSupportPenalty,queueSupportReturn,returnSupport,ownedRefundWithSupport} from '../research/locked-collateral-support.mjs';
const node=hash('server-one'),other=hash('server-two'),ownerGroup=hash('one-owner'),configHash=hash('isolated-only'),start=Date.UTC(2028,1,29)/1000;
function book(){return createSupportBook({configHash,warmupStart:start,allocationReference:hash('synthetic admitted regular issuance allocation'),allocationMicro:'20000000',perNodeCapMicro:'10000000',ownerCaps:{[ownerGroup]:'20000000'},matchPPM:100000,bootstrapNodes:[node]});}
const claim=(id=node,at=start)=>({configHash,node:id,ownerGroup,ownCollateralMicro:'50000000',at});
const refund=(stake,support)=>ownedRefundWithSupport({stakeMicro:String(stake),initialOwnedStakeMicro:'0',ownedDepositedMicro:'5000000',ownedWithdrawnMicro:'0',heldMicro:'0',lockedSupportMicro:String(support)});
test('five calendar years, bootstrap exception, matching and owner caps conserve a separately funded pool',()=>{
 let b=book();assert.equal(b.end,anniversary(start,5));const original=hash(b);
 assert.throws(()=>claimSupport(b,claim(node,start-1)),/window/);assert.throws(()=>claimSupport(b,claim(node,b.end)),/window/);
 const a=claimSupport(b,claim());assert.equal(hash(b),original);assert.equal(a.stakeCreditMicro,'10000000');assert.equal(a.mintedMicro,'0');assert.equal(a.walletCreditMicro,'0');b=a.book;
 b=claimSupport(b,claim(other,b.end-1)).book;assert.equal(b.grants[other].grantedMicro,'5000000');assert.equal(b.poolMicro,'5000000');
 assert.throws(()=>claimSupport(b,{...claim(hash('third')),ownCollateralMicro:'100000000'}),/pool|cap/);
 assert.throws(()=>claimSupport(book(),{...claim(other),ownCollateralMicro:'0'}),/matching/);
});
test('wallet changes, slashing, exit, restart and repeated requests cannot create another one-time award',()=>{
 let b=claimSupport(book(),claim()).book;assert(claimSupport(b,claim()).duplicate);
 assert.throws(()=>claimSupport(b,{...claim(),at:start+1}),/one-time/);assert.throws(()=>claimSupport(b,{...claim(),ownerGroup:hash('renamed owner')}),/one-time/);
 b=reconcileSupportPenalty(b,{node,stakeAfterMicro:'8000000',reference:hash('proved penalty')}).book;
 b=queueSupportReturn(b,{node,at:start+10,challengeSeconds:100000}).book;const ready=b.grants[node].returnAfter;
 const q={node,at:ready,tier:'0',heldMicro:'0',unresolvedLiabilities:0,stakeMicro:'8000000'};
 b=returnSupport(JSON.parse(JSON.stringify(b)),q).book;assert.equal(b.poolMicro,'18000000');assert.equal(b.grants[node].slashedMicro,'2000000');
 assert(returnSupport(b,q).duplicate);assert.throws(()=>claimSupport(b,{...claim(),at:ready}),/one-time/);assert(claimSupport(b,claim()).duplicate);assert.equal(claimSupport(b,claim()).stakeCreditMicro,'0');
 assert.equal(b.ownerGranted[ownerGroup],'10000000');assert(auditSupportBook(b));
});
test('return never pays a wallet, waits for all holds and liabilities and remains possible after year five',()=>{
 let b=claimSupport(book(),claim()).book;b=queueSupportReturn(b,{node,at:b.end,challengeSeconds:86400}).book;
 const q={node,at:b.end+86400,tier:'0',heldMicro:'0',unresolvedLiabilities:0,stakeMicro:'10000000'};
 for(const patch of [{at:q.at-1},{tier:'1'},{heldMicro:'1'},{unresolvedLiabilities:1},{stakeMicro:'9999999'}])assert.throws(()=>returnSupport(b,{...q,...patch}));
 const r=returnSupport(b,q);assert.equal(r.walletCreditMicro,'0');assert.equal(r.mintedMicro,'0');assert.equal(r.stakeDebitMicro,'10000000');assert.equal(r.book.poolMicro,r.book.issuedMicro);
 assert.throws(()=>claimSupport(r.book,claim(other,q.at)),/window/);
});
test('mixed own capital and support cannot turn grants into refundable deposits or restore proved losses',()=>{
 let b=claimSupport(book(),claim()).book;assert.equal(refund(15000000,10000000),'5000000');
 b=reconcileSupportPenalty(b,{node,stakeAfterMicro:'12000000',reference:hash('own loss')}).book;assert.equal(b.grants[node].slashedMicro,'0');assert.equal(refund(12000000,b.grants[node].lockedMicro),'2000000');
 b=reconcileSupportPenalty(b,{node,stakeAfterMicro:'7000000',reference:hash('support loss')}).book;assert.equal(b.grants[node].slashedMicro,'3000000');assert.equal(refund(7000000,b.grants[node].lockedMicro),'0');
 b=reconcileSupportPenalty(b,{node,stakeAfterMicro:'12000000',reference:hash('later own funding')}).book;assert.equal(b.grants[node].lockedMicro,'7000000');assert.equal(refund(12000000,b.grants[node].lockedMicro),'5000000');
 assert.equal(ownedRefundWithSupport({stakeMicro:'15000000',initialOwnedStakeMicro:'0',ownedDepositedMicro:'5000000',ownedWithdrawnMicro:'0',heldMicro:'14000000',lockedSupportMicro:'10000000'}),'1000000');
});
test('returned funds may serve another eligible node but are never reminted or reassigned to the same node',()=>{
 let b=claimSupport(book(),claim()).book;b=queueSupportReturn(b,{node,at:start,challengeSeconds:0}).book;
 b=returnSupport(b,{node,at:start+86400,tier:'0',heldMicro:'0',unresolvedLiabilities:0,stakeMicro:'10000000'}).book;
 const r=claimSupport(b,claim(other,start+86401));assert.equal(r.mintedMicro,'0');assert.equal(r.book.issuedMicro,'20000000');assert.equal(r.book.ownerGranted[ownerGroup],'15000000');
 const bad=structuredClone(r.book);bad.grants[other].lockedMicro='1';assert.throws(()=>auditSupportBook(bad));
 const forged=structuredClone(r.book);forged.poolMicro='999999999';assert.throws(()=>auditSupportBook(forged));
});
