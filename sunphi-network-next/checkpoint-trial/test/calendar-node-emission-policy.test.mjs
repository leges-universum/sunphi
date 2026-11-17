import test from 'node:test';
import assert from 'node:assert/strict';
import {annualRegularCeilings,UNIT} from '../ecosystem-century-model.mjs';
import {anniversary,datedCumulative} from '../economic-policy-v2.mjs';
import {START,END,DAY,inspectAnnualPlan,cumulativeNodeAllowance,dailyNodePool,distributeNodePool} from '../research/calendar-node-emission-policy.mjs';
// Historical public example, deliberately not a live supply assertion.
const existing='2000000000',plan=annualRegularCeilings(BigInt(existing)).map(String);
const id=n=>n.toString(16).padStart(64,'0');
const row=(n,w,h='0')=>({node:id(n),workerUnits:String(w),witnessUnits:String(h)});
const total=r=>r.credits.reduce((a,x)=>a+BigInt(x.valueMicro),0n);

test('retains all 100 existing annual values, anniversaries and lifetime total',()=>{
 const before=JSON.stringify(plan);let accumulated=0n;
 for(let y=0;y<100;y++){
  const a=cumulativeNodeAllowance(plan,anniversary(START,y)),b=cumulativeNodeAllowance(plan,anniversary(START,y+1));
  assert.equal(b-a,BigInt(plan[y]));accumulated+=b-a;
  assert.equal(String(b),datedCumulative({start:START,at:anniversary(START,y+1),existingSupplyMicro:existing,kind:'regular'}));
 }
 assert.equal(accumulated,9879998000n*UNIT);assert.equal(JSON.stringify(plan),before);
 assert.equal(inspectAnnualPlan(plan).annualHash,inspectAnnualPlan([...plan]).annualHash);
});
test('daily exact differences conserve first normal and leap-year plans without float dust',()=>{
 for(const y of [0,1,8,9,10,73,99]){
  let issued=0n;const a=anniversary(START,y),b=anniversary(START,y+1);
  for(let t=a;t<b;t+=DAY)issued+=BigInt(dailyNodePool(plan,t));
  assert.equal(issued,BigInt(plan[y]));
 }
 assert.equal(anniversary(START,2)-anniversary(START,1),366*DAY);
 assert.equal(anniversary(START,74)-anniversary(START,73),365*DAY); // 2100
});
test('nothing before launch or beyond the century; no skewed day boundaries',()=>{
 assert.equal(dailyNodePool(plan,START-DAY),'0');assert.equal(dailyNodePool(plan,END),'0');
 assert.equal(new Date(START*1000).toISOString(),'2027-01-01T00:00:00.000Z');
 assert.equal(new Date(END*1000).toISOString(),'2127-01-01T00:00:00.000Z');
 assert.throws(()=>dailyNodePool(plan,START+1),/boundary/);
 assert.throws(()=>dailyNodePool(plan,NaN),/UTC/);
});
test('common 2027 start retains five-year warmup curve and existing fund vesting',()=>{
 const cumulative=(kind,y)=>BigInt(datedCumulative({start:START,at:anniversary(START,y),kind}));
 assert.equal(cumulative('warmup',0),0n);assert.equal(cumulative('warmup',2),5000000n*UNIT);
 assert.equal(cumulative('warmup',5),10000000n*UNIT);assert.equal(cumulative('warmup',6),10000000n*UNIT);
 for(const [kind,annual]of [['development',10000000n],['founder',1000000n]]){
  assert.equal(datedCumulative({start:START,at:anniversary(START,1)-1,kind}),'0');
  for(let y=1;y<=10;y++)assert.equal(cumulative(kind,y),annual*BigInt(y)*UNIT);
 }
 assert.equal(new Date(anniversary(START,1)*1000).toISOString(),'2028-01-01T00:00:00.000Z');
});
test('full calendar reward is allocated independently of fees and service cost',()=>{
 const pool=dailyNodePool(plan,START),work=[row(1,3),row(2,0,1)];
 const r=distributeNodePool(pool,work);assert.equal(total(r),BigInt(pool));assert.equal(r.unissuedMicro,'0');
 // Existing fee/tariff budgets are not parameters of this allocation.
 assert.deepEqual(r,distributeNodePool(pool,work));
 assert(BigInt(r.mintedMicro)>100n*UNIT);
});
test('small eligible population has larger shares; no per-machine fixed award',()=>{
 for(const n of [1,10,500,10500]){
  const pool='10500000000',work=Array.from({length:n},(_,i)=>row(i+1,1)),r=distributeNodePool(pool,work);
  assert.equal(total(r),BigInt(pool));assert.equal(r.credits[0].valueMicro,String(BigInt(pool)/BigInt(n)));
 }
});
test('missing work evidence preserves scheduled issue and requires reconciliation',()=>{
 for(const work of [[],[row(1,0)]]){
  const r=distributeNodePool('123',work);
  assert.deepEqual(r,{status:'RECONCILIATION_REQUIRED',scheduledMicro:'123',credits:[]});
  assert.equal(Object.hasOwn(r,'mintedMicro'),false);
 }
 // Prior issue is retained separately, not minted a second time by later days.
 assert.equal(dailyNodePool(plan,START+DAY),String(cumulativeNodeAllowance(plan,START+2*DAY)-cumulativeNodeAllowance(plan,START+DAY)));
});
test('calendar entitlement survives an outage independently of who supplied work',()=>{
 const a=START,b=START+DAY,c=START+3*DAY;
 const first=BigInt(dailyNodePool(plan,a));
 const catchup=cumulativeNodeAllowance(plan,c)-cumulativeNodeAllowance(plan,b);
 assert.equal(first+catchup,cumulativeNodeAllowance(plan,c));
 const paused=distributeNodePool(String(catchup),[]);
 assert.equal(BigInt(paused.scheduledMicro),catchup);assert.equal(paused.status,'RECONCILIATION_REQUIRED');assert.equal(paused.credits.length,0);
});
test('fractional micro-unit residue is fully assigned in deterministic node order',()=>{
 const work=[row(3,1),row(2,1),row(1,1)],r=distributeNodePool('2',work);
 assert.deepEqual(r.credits.map(x=>x.valueMicro),['1','1','0']);assert.deepEqual(r,distributeNodePool('2',[...work].reverse()));
});
test('splitting roles of the same node does not duplicate identity or increase weight',()=>{
 assert.deepEqual(distributeNodePool('101',[row(1,4),row(2,2)]),distributeNodePool('101',[row(1,2,2),row(2,2)]));
 assert.throws(()=>distributeNodePool('101',[row(1,2),row(1,2)]),/unique/);
});
test('invalid amounts, schedules and weights fail closed',()=>{
 for(const bad of ['-1','0.1','01','1e6',1])assert.throws(()=>distributeNodePool(bad,[]),/canonical/);
 assert.throws(()=>distributeNodePool('1',[row(1,-1)]),/canonical/);
 assert.throws(()=>inspectAnnualPlan(plan.slice(1)),/100-year/);
 assert.throws(()=>inspectAnnualPlan(Array(100).fill('10000000000000000')),/overlaps/);
});
test('generated work sets preserve every micro-unit without mutating inputs',()=>{
 let seed=17;const rand=()=>{seed=(seed*48271)%2147483647;return seed;};
 for(let t=0;t<300;t++){
  const work=Array.from({length:1+rand()%100},(_,i)=>row(i+1,rand()%10000,rand()%10000)),before=JSON.stringify(work),pool=String(rand());
  const r=distributeNodePool(pool,work);assert.equal(total(r),BigInt(pool));assert.equal(JSON.stringify(work),before);
  assert.deepEqual(r,distributeNodePool(pool,[...work].reverse()));
 }
});
