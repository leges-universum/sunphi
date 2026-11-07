import test from 'node:test';
import assert from 'node:assert/strict';
import { UNIT, CAP } from '../ecosystem-century-model.mjs';
import { anniversary, makeEconomicPlan, datedCumulative, datedAllowance, emissionBudget,
  initialWarmupController, planWarmupInterval, settleWarmupInterval, certifiedWarmupInterval } from '../economic-policy-v2.mjs';
import {keys,hash,sign} from '../crypto.mjs';
import { setupReserves } from './network-reserves.test.mjs';
import { origin, stateHash } from '../core.mjs';
const start=Date.UTC(2028,1,29,12,30,0)/1000, micro=n=>String(BigInt(n)*UNIT);
test('prepared plan integrates with existing unissued reserve state and preserves every balance',()=>{
 const x=setupReserves();let s=origin(x.c);s=x.run(s,[x.prepare(s)]);const before=structuredClone(s),h=stateHash(s,x.c);
 const plan=makeEconomicPlan(s);assert.equal(plan.existingSupplyMicro,micro(1600));assert.equal(plan.regularMicro,micro(9879998400));
 assert.equal(plan.issuanceEnabled,false);assert.equal(plan.emissionStart,null);assert.equal(plan.warmupStart,null);
 assert.deepEqual(s,before);assert.equal(stateHash(s,x.c),h);assert.equal(plan.observedStateHash,h);
 assert.throws(()=>makeEconomicPlan({...s,rewards:{}}),/activation/);
 assert.throws(()=>makeEconomicPlan({...s,networkReserves:{...s.networkReserves,issued:'yes'}}),/unissued/);
});
test('UTC leap-day anniversaries clamp without drifting from the original start',()=>{
 assert.equal(new Date(anniversary(start,1)*1000).toISOString(),'2029-02-28T12:30:00.000Z');
 assert.equal(new Date(anniversary(start,4)*1000).toISOString(),'2032-02-29T12:30:00.000Z');
 assert.equal(new Date(anniversary(start,100)*1000).toISOString(),'2128-02-29T12:30:00.000Z');
 for(const kind of ['regular','renewal','warmup','development','founder'])assert.equal(datedCumulative({start,at:start-1,kind,existingSupplyMicro:micro(2000)}),'0');
});
test('dated budgets retain exact half warmup and capped vesting, including final seconds',()=>{
 const cum=(kind,at)=>datedCumulative({start,at,kind,existingSupplyMicro:micro(2000)});
 assert.equal(cum('warmup',anniversary(start,2)),micro(5000000));assert.equal(cum('warmup',anniversary(start,5)),micro(10000000));
 assert.equal(cum('warmup',anniversary(start,10)),micro(10000000));
 assert.equal(cum('development',anniversary(start,1)-1),'0');assert.equal(cum('development',anniversary(start,1)),micro(10000000));
 assert.equal(cum('founder',anniversary(start,10)),micro(10000000));
 assert.equal(cum('regular',anniversary(start,100)),micro(9879998000));
});
test('calendar differences telescope exactly across all century boundaries',()=>{
 for(const kind of ['regular','renewal','warmup']){
  let total=0n;
  for(let year=0;year<100;year++){
   const from=anniversary(start,year),to=anniversary(start,year+1),mid=from+Math.floor((to-from)/3);
   const read=(a,b)=>BigInt(datedAllowance({start,from:a,to:b,kind,existingSupplyMicro:micro(2000)}));
   assert.equal(read(from,mid)+read(mid,to),read(from,to));assert(read(from,to)>=0n);total+=read(from,to);
  }
  assert.equal(String(total),datedCumulative({start,at:anniversary(start,100),kind,existingSupplyMicro:micro(2000)}));
 }
});
test('renewal bonus cannot be paid as ordinary work; paid fees remove subsidy demand',()=>{
 const args={calendar:{start,from:anniversary(start,8),to:anniversary(start,9),existingSupplyMicro:micro(2000)},
  supplyMicro:micro(2000),futureFixedReservedMicro:micro(120000000),lifetimeRemainingMicro:micro(9879998000),
  operationalCapMicro:micro(400000000),ordinaryCostMicro:micro(400000000),ordinaryFeesMicro:'0',
  renewalCostMicro:micro(250000000),renewalFeesMicro:'0',renewalQualified:false};
 assert.equal(emissionBudget(args).maximumMicro,micro(150000000));
 assert.equal(emissionBudget({...args,renewalQualified:true}).maximumMicro,micro(400000000));
 assert.equal(emissionBudget({...args,ordinaryFeesMicro:micro(400000000)}).maximumMicro,'0');
 assert.equal(emissionBudget({...args,operationalCapMicro:micro(1)}).maximumMicro,micro(1));
 assert.equal(emissionBudget({...args,supplyMicro:String(CAP-120000000n*UNIT-7n)}).maximumMicro,'7');
 assert.throws(()=>emissionBudget({...args,supplyMicro:String(CAP)}),/overcommitted/);
});
function input(s,extra={}){return{from:s.cursor,to:s.cursor+60,observedHeight:s.lastMeasurementHeight+1,
 observedAt:s.cursor,sequence:s.sequence+1,healthy:true,capacityRateMicroPerSecond:micro(2),
 maximumRiseMicroPerSecond:'1000',operationalRateMicroPerSecond:micro(1),...extra};}
test('warmup reserves once, survives serialization, settles once and rejects conflicting replay',()=>{
 const s=initialWarmupController(start,100),req=input(s);let next=planWarmupInterval(s,req);
 assert.equal(s.pending,null);assert.equal(next.reservedMicro,'60000');
 assert.throws(()=>planWarmupInterval(next,req),/interval|sequence/);
 next=JSON.parse(JSON.stringify(next));next=settleWarmupInterval(next,1,'25000');
 assert.equal(next.spentMicro,'25000');assert.deepEqual(settleWarmupInterval(next,1,'25000'),next);
 assert.throws(()=>settleWarmupInterval(next,1,'26000'),/conflicting/);
 const second=planWarmupInterval(next,input(next));assert.equal(second.reservedMicro,'120000');
 assert.throws(()=>settleWarmupInterval(second,2,'120001'),/unreserved/);
});
test('health failure and capacity loss reduce budget; stale observations and missing intervals rejected',()=>{
 let s=initialWarmupController(start,100);
 assert.throws(()=>planWarmupInterval(s,input(s,{observedHeight:100})),/observation/);
 assert.throws(()=>planWarmupInterval(s,input(s,{observedAt:start-301})),/stale/);
 assert.throws(()=>planWarmupInterval(s,input(s,{observedAt:start+1})),/future/);
 assert.throws(()=>planWarmupInterval(s,input(s,{from:start+60,to:start+120})),/contiguous/);
 s=settleWarmupInterval(planWarmupInterval(s,input(s)),1,'0');
 const low=planWarmupInterval(s,input(s,{capacityRateMicroPerSecond:'1'}));assert.equal(low.reservedMicro,'60');
 const stopped=planWarmupInterval(s,input(s,{healthy:false}));assert.equal(stopped.reservedMicro,'0');
});
test('warmup stops at five years and cannot repay missed allowance',()=>{
 const end=anniversary(start,5),s={...initialWarmupController(start,100),cursor:end,sequence:1};
 assert.equal(planWarmupInterval(s,input(s)).reservedMicro,'0');
 const normal=initialWarmupController(start,100);
 assert.throws(()=>planWarmupInterval(normal,input(normal,{to:start+86401})),/bounded/);
});
test('capacity certificates bind network, policy, epoch and interval and require seven signers',()=>{
 const validators=Array.from({length:10},keys),s=initialWarmupController(start,100);
 const context={configHash:hash('network'),generation:3,height:101,
  validators:validators.map((k,i)=>({key:k.publicKey,group:hash({i})})),
  controllerPolicy:{maximumRiseMicroPerSecond:'1000',operationalRateMicroPerSecond:micro(1)}};
 const body={domain:'DUEBYTE_WARMUP_CAPACITY_V2',configHash:context.configHash,generation:3,start,
  from:start,to:start+60,observedHeight:101,observedAt:start,sequence:1,healthy:true,
  capacityRateMicroPerSecond:micro(2),controllerPolicyHash:hash(context.controllerPolicy)};
 const certificate={body,approvals:validators.slice(0,7).map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)}))};
 assert.equal(certifiedWarmupInterval(s,certificate,context).reservedMicro,'60000');
 assert.throws(()=>certifiedWarmupInterval(s,{...certificate,approvals:certificate.approvals.slice(0,6)},context));
 for(const changed of [{generation:4},{configHash:hash('other')},{controllerPolicyHash:hash('other')},{observedHeight:102}])
  assert.throws(()=>certifiedWarmupInterval(s,{...certificate,body:{...body,...changed}},context));
 const next=settleWarmupInterval(certifiedWarmupInterval(s,certificate,context),1,'0');
 assert.throws(()=>certifiedWarmupInterval(next,certificate,context),/interval|sequence/);
});
