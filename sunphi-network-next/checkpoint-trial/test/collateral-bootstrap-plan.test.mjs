import test from 'node:test';import assert from 'node:assert/strict';import {hash,keys} from '../crypto.mjs';
import {planCollateralBootstrap,planWarmupCollateralSupport,requiredWorkerCollateral,splitCollateralContribution} from '../research/collateral-bootstrap-plan.mjs';
import {anniversary} from '../economic-policy-v2.mjs';
import {MAX} from '../payment-model.mjs';
const node=i=>hash(['admitted',i]),group=hash('one owner'),wallet=keys().publicKey;
test('equal selected-server contributions conserve every micro-unit without reusing collateral',()=>{
 const ids=[node(1),node(2),node(3)],s=splitCollateralContribution('10000000',ids);assert(s.allocations.every(a=>a.valueMicro==='3333333'));assert.equal(s.pledgedMicro,'9999999');assert.equal(s.remainingMicro,'1');assert.deepEqual(s,splitCollateralContribution('10000000',[...ids].reverse()));assert.throws(()=>splitCollateralContribution('2',ids));assert.throws(()=>splitCollateralContribution('10',[ids[0],ids[0]]));
});
function policy(count=10){return {periodBudgetMicro:'1000000000',periodAlreadyIssuedMicro:'0',supportBudgetMicro:'100000000',supportAlreadyIssuedMicro:'0',perNodeCapMicro:'10000000',ownerCaps:{[group]:'100000000'},matchPPM:100000,bootstrapNodes:Array.from({length:count},(_,i)=>node(i)),nodes:Array.from({length:count},(_,i)=>({node:node(i),ownerGroup:group,recipient:wallet,ownCollateralMicro:'0',nodeGrantedMicro:'0',ownerGrantedMicro:'0'}))};}
test('ten explicitly admitted launch workers receive a planned100 token locked allocation within period budget',()=>{
 const p=policy(),r=planCollateralBootstrap(p);assert.equal(r.newSupportMicro,'100000000');assert.equal(r.periodRemainingForOtherIssuanceMicro,'900000000');assert(r.allocations.every(n=>n.lockedGrantMicro==='10000000'&&n.withdrawableMicro==='0'));assert(!r.issuanceAuthorized);
 p.nodes.forEach(n=>{n.nodeGrantedMicro='10000000';n.ownerGrantedMicro='100000000';});p.supportAlreadyIssuedMicro=p.periodAlreadyIssuedMicro='100000000';assert.equal(planCollateralBootstrap(p).newSupportMicro,'0');
});
test('splitting a fixed ordinary owner stake among many nodes does not increase the owner grant',()=>{
 const p=policy(1);p.bootstrapNodes=[];p.ownerCaps[group]='10000000';p.nodes[0].ownCollateralMicro='100000000';const a=planCollateralBootstrap(p);
 p.nodes=Array.from({length:100},(_,i)=>({...p.nodes[0],node:node(i),ownCollateralMicro:'1000000'}));assert.equal(planCollateralBootstrap(p).newSupportMicro,a.newSupportMicro);assert.equal(a.newSupportMicro,'10000000');p.nodes.forEach(n=>n.ownCollateralMicro='0');assert.equal(planCollateralBootstrap(p).newSupportMicro,'0');
});
test('budget exhaustion, invented history, duplicate nodes and missing owner cap are refused or bounded',()=>{
 const p=policy();p.periodAlreadyIssuedMicro='999999999';assert.equal(planCollateralBootstrap(p).newSupportMicro,'0');
 for(const change of [q=>q.nodes.push(q.nodes[0]),q=>q.nodes[0].ownerGrantedMicro='1',q=>delete q.ownerCaps[group],q=>q.supportAlreadyIssuedMicro='100000001',q=>q.matchPPM=1000001]){const q=policy();change(q);assert.throws(()=>planCollateralBootstrap(q));}
});
test('payment splitting does not understate repeated-worker exposure or parallel payment collateral',()=>{
 const ids=[0,1,2].map(node),parts=Array.from({length:3},()=>({valueMicro:'1000000',nodes:ids}));const exposure=requiredWorkerCollateral({consensusReserveMicro:'1000000',parts,concurrentPayments:3});assert(Object.values(exposure).every(v=>v==='10000000'));
 const disjoint=parts.map((p,i)=>({...p,nodes:[3*i,3*i+1,3*i+2].map(node)}));assert(Object.values(requiredWorkerCollateral({consensusReserveMicro:'1000000',parts:disjoint,concurrentPayments:3})).every(v=>v==='4000000'));
 assert.throws(()=>requiredWorkerCollateral({consensusReserveMicro:'1',parts:[{valueMicro:String(MAX),nodes:ids}],concurrentPayments:1}));
});

test('a same-owner unlisted node cannot consume the frozen bootstrap exception',()=>{
 const p=policy(1),listed=p.nodes[0];
 const outsider={...listed,node:'0'.repeat(64)};assert(outsider.node<listed.node);
 p.nodes.push(outsider);
 const r=planCollateralBootstrap(p);
 assert.equal(r.allocations.find(n=>n.node===outsider.node).lockedGrantMicro,'0');
 assert.equal(r.allocations.find(n=>n.node===listed.node).lockedGrantMicro,'10000000');
 outsider.ownCollateralMicro='5000000';
 const matched=planCollateralBootstrap(p);
 assert.equal(matched.allocations.find(n=>n.node===outsider.node).lockedGrantMicro,'500000');
 assert.deepEqual(matched,planCollateralBootstrap({...p,nodes:[...p.nodes].reverse()}));
});

test('a small first award is one-time and cannot be topped up by reconnection',()=>{
 const p=policy(1);p.periodAlreadyIssuedMicro=p.supportAlreadyIssuedMicro='1';p.nodes[0].nodeGrantedMicro=p.nodes[0].ownerGrantedMicro='1';
 assert.equal(planCollateralBootstrap(p).newSupportMicro,'0');
 p.nodes[0].recipient=keys().publicKey;assert.equal(planCollateralBootstrap(p).newSupportMicro,'0');
});

test('bonus admission follows five calendar years of warmup without unlocking existing collateral',()=>{
 const start=Date.UTC(2028,1,29,12)/1000,end=anniversary(start,5),plan=policy();
 assert.equal(new Date(end*1000).toISOString(),'2033-02-28T12:00:00.000Z');
 for(const [s,at]of [[null,start],[start,start-1],[start,end],[start,end+86400]]){
  const q=planWarmupCollateralSupport({start:s,at,plan});assert.equal(q.newSupportMicro,'0');assert(!q.bonusWindow.open);assert(!q.existingCollateralUnlocked);assert.equal(q.periodRemainingForOtherIssuanceMicro,'1000000000');
 }
 for(const at of [start,end-1])assert.equal(planWarmupCollateralSupport({start,at,plan}).newSupportMicro,'100000000');
});
