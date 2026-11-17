// Pure preparation calculator. NOT an issuance action or authorization verifier.
// Applicants must come from a future quorum-approved, bounded admission roster.
import assert from 'node:assert/strict';
import {amount} from '../payment-model.mjs';
import {hex,publicKey,integer,exact} from '../crypto.mjs';
import {anniversary} from '../economic-policy-v2.mjs';
const min=(...v)=>v.reduce((a,b)=>a<b?a:b);
// A new contribution is shared among explicitly selected workers. Existing
// collateral is never redistributed. Indivisible remainder stays in the wallet.
export function splitCollateralContribution(totalMicro,nodes){
 const total=amount(totalMicro);assert(total>0n);assert(Array.isArray(nodes)&&nodes.length>0&&nodes.length<=64);nodes.forEach(hex);assert.equal(new Set(nodes).size,nodes.length,'duplicate selected worker');
 const each=total/BigInt(nodes.length);assert(each>0n,'amount too small for every selected worker');
 return {allocations:[...nodes].sort().map(node=>({node,valueMicro:String(each)})),pledgedMicro:String(each*BigInt(nodes.length)),remainingMicro:String(total%BigInt(nodes.length))};
}
export function planCollateralBootstrap(p){
 exact(p,['periodBudgetMicro','periodAlreadyIssuedMicro','supportBudgetMicro','supportAlreadyIssuedMicro','perNodeCapMicro','ownerCaps','matchPPM','bootstrapNodes','nodes']);
 integer(p.matchPPM);assert(p.matchPPM<=1000000);assert(Array.isArray(p.nodes)&&p.nodes.length<=1024);assert(Array.isArray(p.bootstrapNodes)&&p.bootstrapNodes.length<=64);p.bootstrapNodes.forEach(hex);assert.equal(new Set(p.bootstrapNodes).size,p.bootstrapNodes.length);
 const period=amount(p.periodBudgetMicro),periodSpent=amount(p.periodAlreadyIssuedMicro),cap=amount(p.supportBudgetMicro),spent=amount(p.supportAlreadyIssuedMicro),perNode=amount(p.perNodeCapMicro);
 assert(periodSpent<=period&&spent<=cap&&spent<=periodSpent,'emission budget accounting');assert(cap<=period&&perNode>0n);assert(Object.keys(p.ownerCaps).length<=1024);
 const owners=new Map(),seen=new Set();let remaining=min(period-periodSpent,cap-spent);const allocations=[];
 for(const n of [...p.nodes].sort((a,b)=>a.node<b.node?-1:a.node>b.node?1:0)){
  exact(n,['node','ownerGroup','recipient','ownCollateralMicro','nodeGrantedMicro','ownerGrantedMicro']);hex(n.node);hex(n.ownerGroup);publicKey(n.recipient);assert(!seen.has(n.node),'duplicate node');seen.add(n.node);
  const own=amount(n.ownCollateralMicro),nodeGranted=amount(n.nodeGrantedMicro),ownerGranted=amount(n.ownerGrantedMicro);assert(nodeGranted<=ownerGranted&&ownerGranted<=spent,'grant history accounting');
  assert(Object.hasOwn(p.ownerCaps,n.ownerGroup),'owner admission cap required');const ownerCap=amount(p.ownerCaps[n.ownerGroup]);
  let o=owners.get(n.ownerGroup);if(!o){o={own:0n,prior:ownerGranted,cap:ownerCap,nodes:[],totalNodePrior:0n};owners.set(n.ownerGroup,o);}assert.equal(o.prior,ownerGranted,'owner history mismatch');o.own+=own;o.totalNodePrior+=nodeGranted;o.nodes.push(n);
 }
 let admittedPrior=0n;for(const o of owners.values()){assert(o.totalNodePrior<=o.prior,'inconsistent owner grants');admittedPrior+=o.prior;}assert(admittedPrior<=spent,'duplicate history budget');
 for(const [ownerGroup,o]of [...owners].sort(([a],[b])=>a<b?-1:1)){
  // Bootstrap exception is an explicit frozen node roster, never a self-claim.
  const bootstrapCount=o.nodes.filter(n=>p.bootstrapNodes.includes(n.node)).length;
  const limit=min(o.cap,o.own*BigInt(p.matchPPM)/1000000n+BigInt(bootstrapCount)*perNode);
  let allowance=limit>o.prior?limit-o.prior:0n;
  for(const n of o.nodes){
   // The frozen bootstrap exception belongs to this node, not to every node
   // controlled by its owner. Ordinary nodes need their own matching capital.
   const nodeLimit=p.bootstrapNodes.includes(n.node)?perNode:min(perNode,amount(n.ownCollateralMicro)*BigInt(p.matchPPM)/1000000n);
   const previous=amount(n.nodeGrantedMicro),space=previous===0n?nodeLimit:0n;
   // Do not consume a lifetime one-time award with an accidental dust remainder.
   const value=space<=allowance&&space<=remaining?space:0n;allowance-=value;remaining-=value;
   allocations.push({node:n.node,ownerGroup,recipient:n.recipient,lockedGrantMicro:String(value),withdrawableMicro:'0'});
  }
 }
 const issued=allocations.reduce((v,n)=>v+BigInt(n.lockedGrantMicro),0n);
 return {preparedOnly:true,issuanceAuthorized:false,allocations,newSupportMicro:String(issued),periodRemainingForOtherIssuanceMicro:String(period-periodSpent-issued),supportRemainingMicro:String(cap-spent-issued),maximumPlanSupplyChanged:false};
}
// Bonus admission ends with the five-calendar-year warmup, not with century
// issuance. Existing collateral/obligations are not unlocked by this deadline.
// start must come from the authorized on-chain warmup clock, never registration.
export function planWarmupCollateralSupport({start,at,plan}){
 integer(at,1);if(start!==null)integer(start,1);
 const result=planCollateralBootstrap(plan),end=start===null?null:anniversary(start,5);
 const open=start!==null&&at>=start&&at<end;
 if(!open){result.allocations=result.allocations.map(a=>({...a,lockedGrantMicro:'0'}));result.newSupportMicro='0';
  result.periodRemainingForOtherIssuanceMicro=String(amount(plan.periodBudgetMicro)-amount(plan.periodAlreadyIssuedMicro));
  result.supportRemainingMicro=String(amount(plan.supportBudgetMicro)-amount(plan.supportAlreadyIssuedMicro));}
 return {...result,bonusWindow:{start,end,open,years:5,source:'AUTHORIZED_WARMUP_CLOCK',reason:start===null?'NOT_STARTED':at<start?'NOT_STARTED':at>=end?'ENDED':'OPEN'},
  oneTimePerNode:true,returnDestination:'ALGORITHMIC_SUPPORT_POOL',existingCollateralUnlocked:false};
}
// Each assigned worker covers each assigned part. Do not assume P/3 if a worker
// appears in several parts or if several payments overlap.
export function requiredWorkerCollateral({consensusReserveMicro,parts,concurrentPayments}){
 integer(concurrentPayments,1);assert(concurrentPayments<=1000000);assert(Array.isArray(parts)&&parts.length>0&&parts.length<=32);const exposure=new Map();
 for(const p of parts){exact(p,['valueMicro','nodes']);const value=amount(p.valueMicro);assert(value>0n);assert(Array.isArray(p.nodes)&&p.nodes.length===3&&new Set(p.nodes).size===3);for(const n of p.nodes){hex(n);exposure.set(n,(exposure.get(n)??0n)+value);}}
 const reserve=amount(consensusReserveMicro);return Object.fromEntries([...exposure].sort(([a],[b])=>a<b?-1:1).map(([node,value])=>[node,String(amount(String(reserve+value*BigInt(concurrentPayments))))]));
}
