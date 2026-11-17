import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {BoundedNetworkInterpreter} from '../research/bounded-network-interpreter.mjs';
import {centuryWarmupPlan} from '../century-warmup.mjs';
import {anniversary} from '../economic-policy-v2.mjs';
import {queryBounded} from '../research/bounded-query.mjs';
import {hash,sign,keys} from '../crypto.mjs';
import {serviceFixture} from './bounded-service-rewards.test.mjs';
import {certify} from './century-issuance.test.mjs';
import {ISSUE_FOUNDER_ADVANCE,FOUNDER_ADVANCE_MICRO} from '../founder-advance-policy.mjs';
import {OPEN_SUPPORT,supportOwnerGroup} from '../worker-support.mjs';
import {centuryVested} from '../century-issuance.mjs';
import {START,DAY,inspectAnnualPlan,dailyNodePool} from '../research/calendar-node-emission-policy.mjs';
import {PREPARE_MAIN_PROGRAMME,programmeBaseline,fixedFundTotal,activeZeroStage} from '../research/main-programme-transition.mjs';
import {SERVICE_HEAD} from '../research/bounded-service-rewards.mjs';

export function programmeFixture(startTime=Date.UTC(2026,11,28,12)/1000,days=1,options={}){
 const f=serviceFixture(days,startTime,true,options),{x,r}=f;
 const advance=certify(x,r.s,ISSUE_FOUNDER_ADVANCE,{supplyBefore:r.s.money.supply,trancheMicro:FOUNDER_ADVANCE_MICRO,recipient:x.recipient.publicKey});
 advance.recipientConsent=sign(advance.certificate.body,x.recipient.privateKey);r.step([x.wire(advance)]);
 r.step([],r.s.money.time+60);const s=r.s,body={domain:OPEN_SUPPORT,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+100,planHash:s.economicPreparation.planHash,managementEpoch:s.networkReserves.development.access.epoch,supplyBefore:s.money.supply,from:s.centuryFunds.execution.start,to:s.money.time,allocationMicro:'100000000',perNodeCapMicro:'10000000',ownerCaps:{[supportOwnerGroup(s,x.f.ids[0])]:'100000000'},matchPPM:1000000,bootstrapNodes:x.f.ids};
 r.step([x.wire({type:OPEN_SUPPORT,certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey)})]);
 r.step([x.wire(f.activation)]);assert.equal(f.plan.to,START);
 // This fixture has no payment events. Capture the verified head before every
 // commit, including UTC activation, just as the live API pins its read lease.
 const step=r.step;r.step=(...args)=>{const root=r.db.root;f.rememberProof(root,r.db.store.proof('meta/blockHead',root));return step(...args);};return f;
}
const fixture=programmeFixture;
export function authorization(f,changes={}){const {x,r}=f,s=r.s,body={domain:PREPARE_MAIN_PROGRAMME,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,managementEpoch:s.networkReserves.development.access.epoch,notBefore:s.money.time,expires:s.money.time+600,start:START,planHash:s.economicPreparation.planHash,manifestHash:s.centuryFunds.manifestHash,annualHash:inspectAnnualPlan(s.economicPreparation.plan.annualRegularMicro).annualHash,profileHash:hash(f.profile),baseline:programmeBaseline(s),...changes};return{type:PREPARE_MAIN_PROGRAMME,certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey)};}

test('joint programme: authorization cannot change graphs, advance balances or mint early',()=>{
 const f=fixture(),{r,x}=f;try{
  for(const change of [{start:START-1},{planHash:hash('other plan')},{annualHash:hash('other graph')},{profileHash:hash('other coefficients')},{baseline:{...programmeBaseline(r.s),supportIssuedMicro:'0'}}])r.reject(x.wire(authorization(f,change)));
  for(const mutate of [a=>a.certificate.approvals.pop(),a=>a.founderConsent=sign(a.certificate.body,keys().privateKey)]){const a=authorization(f);mutate(a);r.reject(x.wire(a));}
  const supply=r.s.money.supply,earned=hash(r.s.rewards.nodes),a=authorization(f);r.step([x.wire(a)]);r.step([x.wire(a)]);r.reopen();
  assert.equal(r.s.money.supply,supply);assert.equal(hash(r.s.rewards.nodes),earned);assert.equal(r.s.rewards.calendarService.mintedMicro,'0');
  r.step([],START-1);assert.equal(r.s.money.supply,supply);assert.equal(r.s.centuryFunds.mainProgramme.activation,null);
 }finally{r.db.close();}
});

test('joint programme: UTC boundary crash/replay conserves advances and the last pilot day, then pays January work once',()=>{
 const f=fixture(),{r,x}=f;try{
  const annual=hash(r.s.economicPreparation.plan),pilot=hash(r.s.centuryFunds.zeroStage),support=hash(r.s.centuryFunds.support),oldStart=r.s.centuryFunds.execution.start;
  r.step([x.wire(authorization(f))]);f.work();r.step([],START-1);
  const root=r.db.root,supply=r.s.money.supply,reservation=structuredClone(r.s.centuryWarmup.serviceFunding),funded=BigInt(r.s.centuryFunds.execution.issuedMicro);
  const request={height:r.s.height+1,time:START,blockHash:hash('joint UTC crash'),txs:[]},expected=r.db.commitBlock(request,root,{dryRun:true}).root;
  assert.equal(r.db.root,root);assert.throws(()=>r.db.commitBlock(request,root,{beforeCommit:()=>{throw Error('simulated power loss');}}),/power loss/);r.reopen();assert.equal(r.db.root,root);assert.equal(r.s.money.supply,supply);
  const committed=r.step([],START);assert.notEqual(r.db.root,root);r.reopen();assert(r.db.commitBlock(committed.request,r.db.root).value.duplicate);
  assert.equal(BigInt(r.s.money.supply)-BigInt(supply),fixedFundTotal(r.s)-funded);
  assert.equal(r.s.centuryFunds.execution.start,oldStart);assert.equal(r.s.centuryFunds.execution.warmupStart,START);assert.equal(r.s.centuryWarmup.controller.start,START);
  assert.equal(r.s.centuryFunds.execution.founderAdvance.issuedAt,oldStart);assert.equal(hash(r.s.economicPreparation.plan),annual);assert.equal(hash(r.s.centuryFunds.zeroStage),pilot);assert.equal(hash(r.s.centuryFunds.support),support);
  assert.equal(activeZeroStage(r.s),null);assert.deepEqual(r.s.centuryWarmup.serviceFunding,reservation);assert.equal(centuryVested(r.s,'development'),0n);assert.equal(centuryVested(r.s,'founder'),BigInt(FOUNDER_ADVANCE_MICRO));
  for(let j=0;j<6;j++)r.step();assert.equal(r.s.rewards.preissuedServiceMicro,'200000000');
  const balances=f.ids.map(n=>r.s.rewards.nodes[n].earned);f.work(START);r.step([],START+DAY);for(let j=0;j<8;j++)r.step();r.reopen();
  const net=BigInt(dailyNodePool(r.s.economicPreparation.plan.annualRegularMicro,START))-100000000n;
  assert.equal(BigInt(r.s.rewards.minted),net);assert.equal(BigInt(r.s.rewards.calendarService.creditedMicro),net);assert.equal(r.s.rewards.calendarService.heldMicro,'0');
  assert.equal(f.ids.reduce((v,n,i)=>v+BigInt(r.s.rewards.nodes[n].earned)-BigInt(balances[i]),0n),net);
  assert(f.ids.every(n=>r.s.rewards.nodes[n].earned===r.s.rewards.nodes[n].paid));
  const paid=hash(r.s.rewards.nodes);r.step();r.reopen();assert.equal(hash(r.s.rewards.nodes),paid);
  assert.equal(r.s.centuryWarmup.serviceFunding.spentMicro,'200000000');assert.equal(r.s.centuryWarmup.serviceFunding.reservedMicro,'0');
  assert.equal(r.db.store.proof(SERVICE_HEAD,r.db.root).value.nextDay,START+DAY);
  assert(expected);for(const entry of r.db.store.journal.scan({offlineLegacy:true}))assert.equal(hash(JSON.parse(entry.body)),entry.digest);
 }finally{r.db.close();}
});

test('joint programme: pre-launch escrow settles after midnight without rewriting obligations or pilot history',()=>{
 const f=fixture(),{r,x}=f;try{
  r.step([x.wire(authorization(f))]);r.step([],START-10);const w=r.s.centuryWarmup,b={domain:'DUEBYTE_WARMUP_CAPACITY_V2',configHash:r.s.configHash,generation:r.s.authority.generation,start:w.controller.start,from:START-10,to:START+10,observedHeight:r.s.height+1,observedAt:START-10,sequence:w.controller.sequence+1,healthy:true,capacityRateMicroPerSecond:'1000',controllerPolicyHash:hash(w.controllerPolicy)};
  r.step([x.wire({type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:{body:b,approvals:x.approvals(b)}})]);
  const intent=centuryWarmupPlan(r.s.centuryWarmup,r.s.money);assert(intent);r.step([x.wire({type:'RUN_CENTURY_WARMUP_V1',sequence:b.sequence,intentHash:hash(intent)})]);
  const before=structuredClone(r.s.money.requests[intent.pid]),pilot=hash(r.s.centuryFunds.zeroStage),spent=r.s.centuryWarmup.controller.spentMicro;
  r.step([],START);r.reopen();assert.equal(r.s.centuryFunds.mainProgramme.warmupRebased,null);assert.deepEqual(r.s.money.requests[intent.pid],before);
  r.reject(x.wire({type:'RUN_CENTURY_WARMUP_V1',sequence:b.sequence,intentHash:hash(intent)}),/pre-launch/);
  r.step([x.finish(r.s,intent)],START+1);r.step();r.reopen();assert.equal(r.s.money.requests[intent.pid].status,'SETTLED');assert.equal(hash(r.s.centuryFunds.zeroStage),pilot);
  assert.equal(BigInt(r.s.centuryWarmup.controller.spentMicro)-BigInt(spent),BigInt(intent.fee));assert.equal(r.s.centuryWarmup.controller.start,START);assert.equal(r.s.centuryWarmup.controller.sequence,b.sequence);
 }finally{r.db.close();}
});

test('joint programme: no-work days retain backing; vesting begins at January anniversary and subtracts founder advance',()=>{
 const f=fixture(),{r,x}=f;try{
  r.step([x.wire(authorization(f))]);r.step([],START+DAY);for(let i=0;i<8;i++)r.step();
  const c=r.s.rewards.calendarService;assert(BigInt(c.heldMicro)>0n);assert.equal(c.creditedMicro,'0');assert.equal(r.db.store.proof('service-rewards/days/'+START,r.db.root).value.phase,'RECONCILIATION_REQUIRED');
  assert.equal(r.s.centuryWarmup.serviceFunding.reservedMicro,'200000000');r.reopen();
  const first=anniversary(START,1);while(r.s.money.time<first-1)r.step([],Math.min(first-1,r.s.money.time+31*DAY));
  assert.equal(centuryVested(r.s,'development'),0n);assert.equal(centuryVested(r.s,'founder'),BigInt(FOUNDER_ADVANCE_MICRO));
  r.step([],first);assert.equal(centuryVested(r.s,'development'),10000000000000n);assert.equal(centuryVested(r.s,'founder'),1000000000000n);
  const released={type:'RELEASE_CENTURY_FOUNDER_V1',manifestHash:r.s.centuryFunds.manifestHash,cumulativeMicro:'1000000000000'},owned=()=>Object.values(r.s.money.outputs).filter(o=>o.owner===x.recipient.publicKey).reduce((v,o)=>v+BigInt(o.value),0n),old=owned();
  r.step([x.wire(released)]);assert.equal(owned()-old,1000000000000n-BigInt(FOUNDER_ADVANCE_MICRO));const after=owned();r.step([x.wire(released)]);r.reopen();assert.equal(owned(),after);
 }finally{r.db.close();}
});

test('joint programme: published91 wallet reads authenticated balances before and after launch',{skip:!process.env.DUEBYTE_SERVICE_PREDECESSOR},async()=>{
 const {loadBoundedWalletView}=await import(pathToFileURL(process.env.DUEBYTE_SERVICE_PREDECESSOR+'/research/bounded-wallet-view.mjs'));
 const f=fixture(),{r,x}=f;try{r.step([x.wire(authorization(f))]);for(const time of [r.s.money.time,START,START+DAY]){
  r.step([],time);const view=await loadBoundedWalletView((q,root)=>queryBounded(r.db,q,root),{root:r.db.root,height:r.s.height,configHash:hash(x.c),owner:x.f.bob.publicKey});assert.equal(view.state.money.supply,r.s.money.supply);assert.equal(Object.keys(view.state.rewards.nodes).length,11);
 }}finally{r.db.close();}
});

for(const time of [START,START+DAY])for(const phase of ['before','after'])test('joint programme: physical crash '+phase+' commit at '+time,async()=>{
 const f=fixture(),{r,x}=f;let closed=false;
 try{r.step([x.wire(authorization(f))]);f.work();if(time>START){r.step([],START);f.work(START);}
  const root=r.db.root,request={height:r.s.height+1,time,blockHash:hash(['joint physical crash',time,phase]),txs:[]},expected=r.db.commitBlock(request,root,{dryRun:true}).root;
  const file=r.file+'.crash.json';fs.writeFileSync(file,JSON.stringify({file:r.file,config:x.c,root,request,phase}));r.db.close();closed=true;
  await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('./service-crash-child.mjs',import.meta.url)),file],{windowsHide:true,stdio:['ignore','pipe','pipe']});let ready=false,output='',errors='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('crash child timeout '+errors));},20000);child.stdout.on('data',b=>{output+=b;if(output.includes('READY')&&!ready){ready=true;child.kill('SIGKILL');}});child.stderr.on('data',b=>{errors+=b;});child.on('error',reject);child.on('close',()=>{clearTimeout(timer);ready?resolve():reject(Error('fault point not reached '+errors));});});
  const db=BoundedNetworkInterpreter.open(r.file,x.c,phase==='before'?root:expected,{isolatedIssuance:false});try{
   if(phase==='before')assert.equal(db.commitBlock(request,root).root,expected);
   assert(db.commitBlock(request,expected).value.duplicate);const s=db.snapshotForAudit();assert(s.centuryFunds.mainProgramme.activation);assert.equal(BigInt(s.centuryFunds.execution.issuedMicro),fixedFundTotal(s));
   assert.equal(s.rewards.calendarService.mintedMicro,time===START?'0':String(BigInt(dailyNodePool(s.economicPreparation.plan.annualRegularMicro,START))-100000000n));
   for(const entry of db.store.journal.scan({offlineLegacy:true}))assert.equal(hash(JSON.parse(entry.body)),entry.digest);
  }finally{db.close();}
 }finally{if(!closed)r.db.close();}
});
