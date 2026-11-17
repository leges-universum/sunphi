import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {hash,keys,sign} from '../crypto.mjs';
import {AuthenticatedRecordStore} from '../research/authenticated-record-store.mjs';
import {START,DAY,distributeNodePool} from '../research/calendar-node-emission-policy.mjs';
import {PILOT_DAILY_MICRO,pilotFundingPlan,affordablePilotFunding,inspectWarmupFunding,fundingRequirement,scheduledWorkPool,reserveServiceFunding,openFundedServiceDay,settleFundedServiceChunk,packServiceCredits,recordServiceContribution,readServiceFunding} from '../research/service-reward-funding.mjs';
import {SERVICE_WORK,serviceChallenge,serviceResponseBody,verifyServiceResponse,acceptServiceResponse} from '../research/service-work-measurement.mjs';

const FROM=Date.UTC(2026,10,18)/1000;
const temp=()=>fs.mkdtempSync(join(tmpdir(),'duebyte-service-funding-'));
const plan=days=>pilotFundingPlan({from:FROM,to:FROM+days*DAY});
test('finite source funds only whole 200-token days and stops without a fractional or minted last pool',()=>{
 const from=Date.UTC(2026,10,17)/1000;
 const a=affordablePilotFunding({from,freeMicro:'8992540000'});
 assert.equal(a.fundedDays,44);assert.equal(a.unfundedDays,1);assert.equal(a.reservedMicro,'8800000000');assert.equal(a.remainingFreeMicro,'192540000');
 assert.equal(a.plan.to,START-DAY);
 for(const [free,days]of [['0',0],['199999999',0],['200000000',1],['399999999',1],['400000000',2]]){
  const r=affordablePilotFunding({from,freeMicro:free});assert.equal(r.fundedDays,days);assert.equal(BigInt(r.reservedMicro)+BigInt(r.remainingFreeMicro),BigInt(free));
  assert.equal(r.plan===null,days===0);
 }
 const end=affordablePilotFunding({from:START-DAY,freeMicro:'99999999999'});assert.equal(end.fundedDays,1);assert.equal(end.plan.to,START);
});
function database(entries=[]){const file=join(temp(),'state.sqlite');return AuthenticatedRecordStore.create(file,entries.sort(([a],[b])=>a<b?-1:1));}
const transact=(db,fn,options)=>db.transact(db.root,{test:'service funding'},fn,options).value;
const read=(db,key)=>db.readRecords(db.root,tx=>tx.get(key));
function reserve(db,p=plan(1),free=p.budgetMicro){return transact(db,tx=>reserveServiceFunding(tx,p,FROM-1,free,value=>{
 const m=tx.get('test-money');assert(BigInt(m.warmup)-BigInt(m.reserved)>=BigInt(value));m.reserved=String(BigInt(m.reserved)+BigInt(value));tx.set('test-money',m);
}));}
function moneyDB(free='9000000000'){return database([['test-money',{warmup:free,reserved:'0',paid:'0',supply:free}]]);}
function credit(tx,rows,sum){
 const m=tx.get('test-money');assert(BigInt(m.warmup)>=BigInt(sum)&&BigInt(m.reserved)>=BigInt(sum));
 m.warmup=String(BigInt(m.warmup)-BigInt(sum));m.reserved=String(BigInt(m.reserved)-BigInt(sum));m.paid=String(BigInt(m.paid)+BigInt(sum));
 for(const r of rows){const key='test-earned/'+r.node;tx.set(key,{valueMicro:String(BigInt(tx.get(key)?.valueMicro??'0')+BigInt(r.valueMicro))});}
 tx.set('test-money',m);
}
function allocation(count=2,pool=PILOT_DAILY_MICRO){
 const work=Array.from({length:count},(_,i)=>({node:hash(['node',i]),workerUnits:String(i+1),witnessUnits:'0'}));
 const credits=distributeNodePool(pool,work).credits,db=database(credits.map((r,i)=>['credits/'+String(i).padStart(12,'0'),r]));
 return {db,root:db.root,credits,units:String(count*(count+1)/2),chunk(offset,size=8){return credits.slice(offset,offset+size).map((r,i)=>({...r,proof:db.proof('credits/'+String(offset+i).padStart(12,'0'),db.root)}));}};
}
function open(db,a,from=FROM){return transact(db,tx=>openFundedServiceDay(tx,{from,allocationHash:a.root,recipients:a.credits.length,acceptedUnits:a.units},from+DAY));}
function settle(db,a,ordinal=0,from=FROM,options){return transact(db,tx=>settleFundedServiceChunk(tx,{from,allocationHash:a.root,ordinal,verifiedCredits:a.chunk(ordinal)},(rows,sum)=>credit(tx,rows,sum)),options);}

test('200/day uses only preissued unreserved custody; 44 days fit and 45 require a top-up',()=>{
 const p=pilotFundingPlan({from:Date.UTC(2026,10,17)/1000,to:START});assert.equal(p.days,45);assert.equal(p.budgetMicro,'9000000000');
 const source=inspectWarmupFunding({fundedMicro:'9000000000',feeSpentMicro:'7270000',custodyMicro:'8992730000',capacityReservedMicro:'60000'});
 assert.equal(source.freeMicro,'8992670000');assert.equal(fundingRequirement(p,source.freeMicro).shortfallMicro,'7330000');
 assert(fundingRequirement(plan(44),source.freeMicro).covered);
 assert.throws(()=>inspectWarmupFunding({fundedMicro:'100',feeSpentMicro:'0',custodyMicro:'40',escrowMicro:'60',capacityReservedMicro:'41'}),/overlapping/);
 assert.throws(()=>pilotFundingPlan({from:FROM,to:START+DAY}));assert.throws(()=>pilotFundingPlan({from:FROM,to:START,dailyMicro:'200000001'}));
});

test('pilot and 2027 use an explicit source boundary and retained annual amounts',()=>{
 assert.equal(scheduledWorkPool({from:FROM,pilotPlan:plan(1)}).source,'PREISSUED_WARMUP');
 const annual=Array(100).fill('0');annual[0]='365000000';
 const v=scheduledWorkPool({from:START,pilotPlan:plan(1),annualMicro:annual});assert.equal(v.source,'CALENDAR_NODE_EMISSION');assert.equal(v.poolMicro,'1000000');
 assert.throws(()=>scheduledWorkPool({from:FROM}));assert.throws(()=>scheduledWorkPool({from:FROM+1,pilotPlan:plan(1)}));
});

test('reservation cannot overbook or mutate/restart an approved schedule',()=>{
 const db=moneyDB('199999999');try{assert.throws(()=>reserve(db,plan(1),'199999999'),/insufficient/);assert.equal(read(db,'service-funding/head'),undefined);}finally{db.close();}
 const funded=moneyDB();try{reserve(funded);const before=read(funded,'test-money');assert(reserve(funded).duplicate);assert.deepEqual(read(funded,'test-money'),before);assert.throws(()=>reserve(funded,plan(2)),/already committed/);}finally{funded.close();}
});

test('65 recipients settle in bounded pages, full pool exactly once, with no supply change',()=>{
 const db=moneyDB(),a=allocation(65);try{
  reserve(db);open(db,a);const before=read(db,'test-money').supply;
  for(let i=0;i<65;i+=8){settle(db,a,i);assert(settle(db,a,i).duplicate);}
  const h=db.readRecords(db.root,readServiceFunding),m=read(db,'test-money');assert.equal(h.committedMicro,PILOT_DAILY_MICRO);assert.equal(h.remainingMicro,'0');assert.equal(m.supply,before);assert.equal(m.paid,PILOT_DAILY_MICRO);assert.equal(m.reserved,'0');
  assert.equal(a.credits.reduce((sum,r)=>sum+BigInt(read(db,'test-earned/'+r.node).valueMicro),0n),200000000n);
  assert(open(db,a).duplicate);
 }finally{db.close();a.db.close();}
});

test('no accepted work keeps the entire daily entitlement reserved for reconciliation',()=>{
 const db=moneyDB();try{reserve(db);const root=db.root;assert.throws(()=>transact(db,tx=>openFundedServiceDay(tx,{from:FROM,allocationHash:hash('empty'),recipients:0,acceptedUnits:'0'},FROM+DAY)));assert.equal(db.root,root);assert.equal(db.readRecords(db.root,readServiceFunding).remainingMicro,PILOT_DAILY_MICRO);}finally{db.close();}
});

test('forged allocation, skipped ordinal, early close and changed daily allocation are rejected atomically',()=>{
 const db=moneyDB(),a=allocation();try{
  reserve(db);assert.throws(()=>transact(db,tx=>openFundedServiceDay(tx,{from:FROM,allocationHash:a.root,recipients:2,acceptedUnits:a.units},FROM+DAY-1)));open(db,a);
  const root=db.root,bad=a.chunk(0);bad[0].valueMicro='1';
  assert.throws(()=>transact(db,tx=>settleFundedServiceChunk(tx,{from:FROM,allocationHash:a.root,ordinal:0,verifiedCredits:bad},(rows,sum)=>credit(tx,rows,sum))));assert.equal(db.root,root);
  assert.throws(()=>settle(db,a,1),/cursor/);assert.throws(()=>transact(db,tx=>openFundedServiceDay(tx,{from:FROM,allocationHash:hash('other'),recipients:2,acceptedUnits:a.units},FROM+DAY)),/immutable/);
 }finally{db.close();a.db.close();}
});

test('short allocation cannot silently retain dust or call the payment adapter',()=>{
 const db=moneyDB(),a=allocation(2,'199999999');try{reserve(db);open(db,a);const root=db.root;assert.throws(()=>settle(db,a),/whole daily pool/);assert.equal(db.root,root);assert.equal(read(db,'test-money').paid,'0');}finally{db.close();a.db.close();}
});

test('top-up requires settled monetary evidence, deduplicates, and never increases daily rate',()=>{
 const db=database([['test-money',{warmup:'9000000000',reserved:'0',paid:'0',unadopted:'100000000',supply:'9100000000'}]]),receipt={paymentId:hash('topup'),valueMicro:'100000000',sender:'test-donor',recipient:'test-warmup',status:'SETTLED'};
 const adopt=tx=>r=>{assert.deepEqual(r,tx.get('test-confirmed-transfer'));const m=tx.get('test-money');assert.equal(m.unadopted,r.valueMicro);m.unadopted='0';m.warmup=String(BigInt(m.warmup)+BigInt(r.valueMicro));tx.set('test-money',m);};
 try{
  assert.throws(()=>transact(db,tx=>recordServiceContribution(tx,receipt,adopt(tx))));
  transact(db,tx=>tx.set('test-confirmed-transfer',receipt));
  transact(db,tx=>recordServiceContribution(tx,receipt,adopt(tx)));assert(transact(db,tx=>recordServiceContribution(tx,receipt,adopt(tx))).duplicate);
  reserve(db);const h=db.readRecords(db.root,readServiceFunding);assert.equal(h.contributedMicro,'100000000');assert.equal(h.plan.dailyMicro,PILOT_DAILY_MICRO);
  const money=read(db,'test-money');assert.equal(money.supply,'9100000000');assert.equal(BigInt(money.warmup)+BigInt(money.unadopted),BigInt(money.supply)); // custody adoption never mints
  assert.throws(()=>transact(db,tx=>recordServiceContribution(tx,{...receipt,status:'RESERVED'},adopt(tx))));
  assert.throws(()=>transact(db,tx=>recordServiceContribution(tx,{...receipt,valueMicro:'2'},adopt(tx))),/conflicting/);
 }finally{db.close();}
});

test('interrupted commit and reopened SQLite preserve custody, cursor and exact-once rewards',()=>{
 let db=moneyDB();const a=allocation(40),file=db.file;
 try{
  reserve(db);open(db,a);const root=db.root,seq=db.meta.sequence;
  assert.throws(()=>settle(db,a,0,FROM,{beforeCommit:()=>{throw Error('simulated interruption');}}),/interruption/);
  assert.equal(db.root,root);assert.equal(db.meta.sequence,seq);db.close();db=new AuthenticatedRecordStore(file,root);
  assert.equal(read(db,'test-money').paid,'0');settle(db,a);const pin=db.root;db.close();db=new AuthenticatedRecordStore(file,pin);
  assert(settle(db,a).duplicate);for(let i=8;i<40;i+=8)settle(db,a,i);assert.equal(read(db,'test-money').paid,PILOT_DAILY_MICRO);
 }finally{db.close();a.db.close();}
});

test('abrupt process exit before SQLite commit cannot leave a partial reward payment',()=>{
 let db=moneyDB();const a=allocation(),file=db.file;
 try{
  reserve(db);open(db,a);const root=db.root;db.close();
  const storeURL=new URL('../research/authenticated-record-store.mjs',import.meta.url).href,fundingURL=new URL('../research/service-reward-funding.mjs',import.meta.url).href;
  const command={from:FROM,allocationHash:a.root,ordinal:0,verifiedCredits:a.chunk(0)};
  const script=`import {AuthenticatedRecordStore} from ${JSON.stringify(storeURL)};import {settleFundedServiceChunk} from ${JSON.stringify(fundingURL)};const db=new AuthenticatedRecordStore(${JSON.stringify(file)},${JSON.stringify(root)});db.transact(db.root,{test:'crash'},tx=>settleFundedServiceChunk(tx,${JSON.stringify(command)},(rows,sum)=>{tx.set('test-money',{warmup:'8800000000',reserved:'0',paid:sum,supply:'9000000000'});}),{beforeCommit:()=>process.exit(77)});`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{windowsHide:true,encoding:'utf8',timeout:15000});assert.equal(child.status,77,child.stderr);
  db=new AuthenticatedRecordStore(file,root);assert.equal(read(db,'test-money').paid,'0');settle(db,a);assert.equal(read(db,'test-money').paid,PILOT_DAILY_MICRO);
 }finally{db.close();a.db.close();}
});

function evidence(kind='worker'){
 const db=database([['meta/blockHead',{height:42}],['payment-events/7',{status:'SETTLED',digest:hash('old payment') }]]),k=keys();
 const profile={version:SERVICE_WORK,intervalSeconds:3600,responseSeconds:120,workerUnits:'1000000',witnessUnits:'1000000',workerWeight:1,witnessWeight:1};
 const key=kind==='worker'?'payment-events/7':'meta/blockHead',proof=db.proof(key,db.root);
 const challenge=serviceChallenge({configHash:hash('config'),profile,node:hash(k.publicKey),kind,intervalStart:FROM,openedAt:FROM+5,anchorHeight:42,anchorRoot:db.root,key,valueHash:hash(proof.value)});
 const body=serviceResponseBody(challenge,proof),response={body,proof,signature:sign(body,k.privateKey)};
 return {db,k,input:{challenge,profile,publicKey:k.publicKey,eligible:true,response,acceptedAt:FROM+10}};
}

test('Linux archive-record and Home recent-record service count without any payment/fee in the day',()=>{
 for(const kind of ['worker','witness']){const e=evidence(kind),db=database();try{
  const result=transact(db,tx=>acceptServiceResponse(tx,e.input));assert.equal(result.receipt.weightedUnits,'1000000');assert.equal(result.receipt.kind,kind);
  assert(transact(db,tx=>acceptServiceResponse(tx,e.input)).duplicate);
  assert(transact(db,tx=>acceptServiceResponse(tx,{...e.input,acceptedAt:FROM+DAY})).duplicate);
  // No fees, balances or mint parameters enter evidence verification.
  assert(!Object.hasOwn(result.receipt,'fee'));
 }finally{e.db.close();db.close();}}
});

test('zero-payment day: ten server keys and one Home key earn the complete funded pool from verified service',()=>{
 const db=moneyDB(),e=evidence(),accepted=[];let allocations;
 try{
  reserve(db);
  for(let i=0;i<11;i++){
   const k=keys(),kind=i<10?'worker':'witness',key=kind==='worker'?'payment-events/7':'meta/blockHead',proof=e.db.proof(key,e.db.root);
   const challenge=serviceChallenge({...e.input.challenge,profile:e.input.profile,node:hash(k.publicKey),kind,key,valueHash:hash(proof.value)});
   const body=serviceResponseBody(challenge,proof),input={...e.input,challenge,publicKey:k.publicKey,response:{body,proof,signature:sign(body,k.privateKey)}};
   accepted.push(transact(db,tx=>acceptServiceResponse(tx,input)).receipt);
  }
  const credits=distributeNodePool(PILOT_DAILY_MICRO,accepted.map(r=>({node:r.node,workerUnits:r.kind==='worker'?r.weightedUnits:'0',witnessUnits:r.kind==='witness'?r.weightedUnits:'0'}))).credits;
  allocations=database(credits.map((r,i)=>['credits/'+String(i).padStart(12,'0'),r]));
  const a={credits,root:allocations.root,units:'11000000',chunk:i=>credits.slice(i,i+8).map((r,j)=>({...r,proof:allocations.proof('credits/'+String(i+j).padStart(12,'0'),allocations.root)}))};
  open(db,a);for(let i=0;i<11;i+=8)settle(db,a,i);
  for(const r of accepted)assert(BigInt(read(db,'test-earned/'+r.node).valueMicro)>0n);
  const m=read(db,'test-money');assert.equal(m.paid,'200000000');assert.equal(m.supply,'9000000000');assert.equal(BigInt(m.warmup)+BigInt(m.paid),BigInt(m.supply));
 }finally{db.close();e.db.close();allocations?.close();}
});

test('wrong key, wrong root, expired response, disabled admission and changed node fail verification',()=>{
 const e=evidence();try{
  for(const mutate of [x=>x.publicKey=keys().publicKey,x=>x.challenge.anchorRoot=hash('wrong'),x=>x.acceptedAt=x.challenge.deadline+1,x=>x.eligible=false,x=>x.response.body.node=hash('other')]){const input=structuredClone(e.input);mutate(input);assert.throws(()=>verifyServiceResponse(input));}
  const changed=structuredClone(e.input);changed.response.proof.value.height=99;const body=serviceResponseBody(changed.challenge,changed.response.proof);changed.response.body=body;changed.response.signature=sign(body,e.k.privateKey);assert.throws(()=>verifyServiceResponse(changed));
 }finally{e.db.close();}
});

test('10,500 reward recipients keep each settlement bounded and preserve the whole daily pool',()=>{
 const db=moneyDB(),a=allocation(10500);let maxReads=0;
 try{
  reserve(db);open(db,a);db.scanAuthenticated=()=>{throw Error('population scan in settlement');};
  for(let i=0;i<a.credits.length;){
   const command=packServiceCredits({from:FROM,allocationHash:a.root,ordinal:i},a.chunk(i));
   transact(db,tx=>{let reads=0;const bounded={...tx,get:key=>{reads++;return tx.get(key);}};
    const result=settleFundedServiceChunk(bounded,command,(rows,sum)=>credit(bounded,rows,sum));maxReads=Math.max(maxReads,reads);return result;
   });
   i+=command.verifiedCredits.length;
  }
  assert(maxReads<=12,'bounded keyed reads, independent of total population');
  const m=read(db,'test-money');assert.equal(m.paid,PILOT_DAILY_MICRO);assert.equal(m.supply,'9000000000');assert.equal(db.readRecords(db.root,readServiceFunding).remainingMicro,'0');
 }finally{db.close();a.db.close();}
});
