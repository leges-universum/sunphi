import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {BoundedNetworkInterpreter} from '../research/bounded-network-interpreter.mjs';
import {hash,sign,keys} from '../crypto.mjs';
import {issuanceFixture,certify} from './century-issuance.test.mjs';
import {rig} from './bounded-century.test.mjs';
import {ISSUE_CENTURY,ISSUE_WARMUP_TRANCHE,START_CENTURY,applyCenturyIssuance} from '../century-issuance.mjs';
import {pilotFixture,admission} from './zero-stage-consensus.test.mjs';
import {ZERO_STAGE_TERMINAL_DEFAULTS} from '../research/zero-stage-plan.mjs';
import {BoundedReadLeases} from '../research/bounded-read-leases.mjs';
import {createBoundedApi} from '../research/bounded-api.mjs';
import {VerifiedClient} from '../client.mjs';
import {SCHEDULE_PAID_ADMISSION} from '../research/bounded-paid-admission.mjs';
import {REWARDS,walletConsent,rewardNodeId} from '../node-rewards.mjs';
import {ENABLE_SERVICE,COMPLETE_SERVICE,PREPARE_MAIN_SERVICE,SERVICE_HEAD,serviceProfile,serviceSlot} from '../research/bounded-service-rewards.mjs';
import {pilotFundingPlan} from '../research/service-reward-funding.mjs';
import {DAY,START as MAIN_START,dailyNodePool,inspectAnnualPlan} from '../research/calendar-node-emission-policy.mjs';
import {serviceChallenge,serviceResponseBody} from '../research/service-work-measurement.mjs';
import {queryBounded,verifyBoundedQuery} from '../research/bounded-query.mjs';
import {runServiceWork} from '../service-work-agent.mjs';
import {ServerRewardWorker} from '../server-reward-worker.mjs';
import {RewardWorker} from '../reward-worker.mjs';
import {WalletStore} from '../wallet-store.mjs';
import {loadBoundedServiceView} from '../research/bounded-wallet-view.mjs';

const START=Date.UTC(2026,10,16,12)/1000;
export function serviceFixture(days=2,startTime=START,pilot=false,options={}){
 let x,r,s;
 if(pilot){({x,r}=pilotFixture(false,true,10,{startTime,rewardPeriodSeconds:3600,...options}));
  r.step([x.wire(admission(x,r,{settings:{...ZERO_STAGE_TERMINAL_DEFAULTS}}))]);
  r.step([x.wire(certify(x,r.s,ISSUE_WARMUP_TRANCHE,{supplyBefore:r.s.money.supply,trancheMicro:'9000000000'}))]);
  r.step([x.wire(certify(x,r.s,START_CENTURY,{settings:{controllerPolicy:{maximumRiseMicroPerSecond:'1000',operationalRateMicroPerSecond:'500000',intervalSeconds:20},maxPaymentMicro:'5000000',timeBasis:x.c.obligationClock,ttlSeconds:120}}))]);s=r.s;
 }else{x=issuanceFixture({utc:true,expanded:true,workerCount:10,startTime,rewardPeriodSeconds:3600,...options});s=applyCenturyIssuance(x.s,certify(x,x.s,ISSUE_CENTURY,{supplyBefore:x.s.money.supply}),x.c,x.founder.publicKey);
  s=applyCenturyIssuance(s,certify(x,s,START_CENTURY,{settings:{controllerPolicy:{maximumRiseMicroPerSecond:'1000',operationalRateMicroPerSecond:'10000',intervalSeconds:600},maxPaymentMicro:'1234567',timeBasis:x.c.obligationClock,ttlSeconds:120}}),x.c,x.founder.publicKey);r=rig(x,s,false,false);
 }
 const home=options.homeFactory?.(s.configHash)??{identity:keys(),work:keys(),management:keys()};home.node=rewardNodeId(s.configHash,home.work.publicKey);
 const peer=createHash('sha256').update(Buffer.from(home.identity.publicKey,'base64url')).digest('hex').slice(0,40);
 const allow={domain:REWARDS+'/ALLOW_REWARD_NODES_V1',network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:r.s.height+1,expires:r.s.height+3,peers:[peer]};
 r.step([x.wire({type:'ALLOW_REWARD_NODES_V1',certificate:{body:allow,approvals:x.approvals(allow)}})]);
 const reg={domain:REWARDS+'/REGISTER',configHash:s.configHash,identity:home.identity.publicKey,work:home.work.publicKey,management:home.management.publicKey};
 r.step([x.wire({type:'REGISTER_REWARD_NODE_V1',body:reg,identitySignature:sign(reg,home.identity.privateKey),workSignature:sign(reg,home.work.privateKey),managementSignature:sign(reg,home.management.privateKey)},home.work)]);
 const ids=Object.keys(r.s.rewards.nodes).sort();
 for(const node of ids){if(pilot&&node!==home.node)continue;const key=node===home.node?home.management:x.key(node),body={domain:REWARDS+'/BIND',configHash:s.configHash,node,sequence:1,payouts:[{wallet:x.f.bob.publicKey,weight:1}]};r.step([x.wire({type:'BIND_REWARD_WALLETS_V1',body,signature:sign(body,key.privateKey),consents:[sign(walletConsent(s.configHash,node,x.f.bob.publicKey),x.f.bob.privateKey)]},key)]);}
 const body={domain:SCHEDULE_PAID_ADMISSION,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,managementEpoch:s.networkReserves.development.access.epoch,notBefore:r.s.money.time,expires:r.s.money.time+600,sequence:1,previousHash:null,effectiveFrom:r.s.money.time+DAY,changes:ids.map(node=>({node,enabled:true})),reason:'Synthetic service acceptance test'};
 r.step([x.wire({type:SCHEDULE_PAID_ADMISSION,certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey)})]);
 const from=Math.ceil(body.effectiveFrom/DAY)*DAY,plan=pilotFundingPlan({from,to:from+days*DAY}),profile=serviceProfile(r.s.rewards.coefficients);
 const b={domain:ENABLE_SERVICE,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,managementEpoch:s.networkReserves.development.access.epoch,notBefore:r.s.money.time,expires:r.s.money.time+600,plan,profile};
 const activation={type:ENABLE_SERVICE,certificate:{body:b,approvals:x.approvals(b)},founderConsent:sign(b,x.founder.privateKey)};
 const read=req=>verifyBoundedQuery(queryBounded(r.db,req,r.db.root),req,r.db.root,hash(x.c)).data;
 const key=node=>node===home.node?home.work:x.key(node);
 function action(node,proof){const v=read({type:'service-work',id:node}),w=v.work,k=key(node),challenge=serviceChallenge({configHash:s.configHash,profile,node,kind:v.kind,intervalStart:w.intervalStart,openedAt:w.anchor.openedAt,anchorHeight:w.anchor.height,anchorRoot:w.anchor.root,key:w.key,valueHash:hash(proof.value)}),b=serviceResponseBody(challenge,proof);return {type:COMPLETE_SERVICE,node,intervalStart:w.intervalStart,response:{body:b,signature:sign(b,k.privateKey),proof}};}
 function work(interval=from){
  const ordered=ids.map(node=>({node,slot:serviceSlot(s.configHash,node,interval,profile)})).sort((a,b)=>a.slot-b.slot||a.node.localeCompare(b.node));
  for(const {node,slot}of ordered){
   // Pin the pre-block root as the real read transport does; no private action hooks.
   const before=r.db.store.readSnapshot(r.db.root);try{r.step([],slot);const v=read({type:'service-work',id:node});let proof;
    if(before.root===v.work.anchor.root)proof=before.proof(v.work.key,before.root);else proof=proofs.get(v.work.anchor.root+':'+v.work.key);
    assert(proof);proofs.set(v.work.anchor.root+':'+v.work.key,proof);r.step([x.wire(action(node,proof),key(node))]);
   }finally{before.close();}
  }
 }
 const proofs=new Map();return {x,r,home,ids,key,plan,profile,activation,read,action,work};
}
const owned=(s,k)=>Object.values(s.money.outputs).filter(o=>o.owner===k).reduce((v,o)=>v+BigInt(o.value),0n);
const fixture=serviceFixture;

test('Home daily work retains its real wallet outbox across restart without an unlocked spending wallet',async()=>{
 const f=fixture(1,START,true),{r,x,home:h}=f,dir=r.file+'.home-client';fs.mkdirSync(dir);
 fs.writeFileSync(dir+'/reward-identity.json',JSON.stringify({version:1,network:x.c.chainId,configHash:hash(x.c),work:h.work,management:h.management}));
 let store=new WalletStore(dir+'/wallet',x.c.chainId),snapshot,sends=0;
 const view=async()=>({...await loadBoundedServiceView((q,root)=>queryBounded(r.db,q,root),{root:r.db.root,height:r.s.height,configHash:hash(x.c),rewardIds:[h.node]}),certificate:{appHash:r.db.root,appHeight:r.s.height}});
 const worker=()=>new RewardWorker({home:dir+'/wallet',config:x.c,store,url:'isolated',serviceWorkReader:async()=>f.read({type:'service-work',id:h.node}),recordProofReader:async(root,key)=>snapshot.proof(key,root),broadcast:async wire=>{assert.equal(wire.body.action.type,COMPLETE_SERVICE);sends++;r.step([wire]);throw Error('lost acknowledgement');}});
 try{r.step([x.wire(f.activation)]);snapshot=r.db.store.readSnapshot(r.db.root);r.step([],serviceSlot(r.s.configHash,h.node,f.plan.from,f.profile));
  const pending=await worker().tick(await view());assert.equal(pending.serviceWork.status,'RETRYING');assert.equal(store.db.prepare('SELECT count(*) n FROM reward_outbox').get().n,1);
  store.close();store=new WalletStore(dir+'/wallet',x.c.chainId);const accepted=await worker().tick(await view());assert.equal(accepted.serviceWork.status,'ACCEPTED');assert.match(accepted.message,/UTC day/);assert.equal(sends,1);assert.equal(store.db.prepare('SELECT count(*) n FROM reward_outbox').get().n,0);assert.equal(store.list().length,0);
  r.step([],f.plan.to);for(let i=0;i<6;i++)r.step();assert.equal(r.s.rewards.nodes[h.node].earned,'200000000');assert.equal(r.s.rewards.nodes[h.node].paid,'200000000');
 }finally{store.close();snapshot?.close();r.db.close();}
});

test('published reader still verifies reward balances after new daily custody and payout',{skip:!process.env.DUEBYTE_SERVICE_PREDECESSOR},async()=>{
 const {loadBoundedWalletView:oldRead}=await import(pathToFileURL(process.env.DUEBYTE_SERVICE_PREDECESSOR+'/research/bounded-wallet-view.mjs'));
 const f=fixture(1,START,true),{r,x}=f;try{r.step([x.wire(f.activation)]);f.work();r.step([],f.plan.to);for(let i=0;i<6;i++)r.step();
  const v=await oldRead((q,root)=>queryBounded(r.db,q,root),{root:r.db.root,height:r.s.height,configHash:hash(x.c),owner:x.f.bob.publicKey});
  assert.equal(v.state.money.supply,r.s.money.supply);assert.equal(v.state.rewards.preissuedServiceMicro,'200000000');assert.equal(Object.keys(v.state.rewards.nodes).length,11);
 }finally{r.db.close();}
});

test('inactive daily runtime preserves exact roots of the published server for payments and idle days',{skip:!process.env.DUEBYTE_SERVICE_PREDECESSOR},async()=>{
 const f=fixture(1,START,true),{r,x}=f,{BoundedNetworkInterpreter:Old}=await import(pathToFileURL(process.env.DUEBYTE_SERVICE_PREDECESSOR+'/research/bounded-network-interpreter.mjs'));
 r.db.store.db.exec("VACUUM INTO '"+(r.file+'.old').replaceAll("'","''")+"'");const old=Old.open(r.file+'.old',x.c,r.db.root,{isolatedIssuance:false});
 const both=(wires=[],time=r.s.money.time)=>{const before=r.db.root;assert.equal(old.root,before);const next=r.step(wires,time);assert.equal(old.commitBlock(next.request,before).root,r.db.root);};
 try{both([],f.plan.from);const i=x.intent(r.s,{epoch:1,unitScale:'1000000',value:'1000000',fee:'5000',abortFee:'500',feeSchedule:r.s.money.paymentTariff.next,parts:[{value:'1000000',nodes:x.f.ids.slice(0,3)}]});both([x.reserve(i)]);both([x.finish(r.s,i)]);for(let j=0;j<48;j++)both([],r.s.money.time+3600);assert.deepEqual(old.snapshotForAudit(),r.s);assert.equal(r.s.rewards.preissuedServiceMicro,undefined);
 }finally{old.close();r.db.close();}
});

test('Linux worker persists an actual signed service outbox across lost acknowledgement and restart',async()=>{
 const f=fixture(1,START,true),{r,x}=f,node=f.ids.find(n=>n!==f.home.node),sent=[];let worker,snapshot,closed=false;
 const client={config:x.c,bounded:true,sync:async()=>{const root=r.db.root,height=r.s.height;return {...await loadBoundedServiceView((q,root)=>queryBounded(r.db,q,root),{root,height,configHash:hash(x.c),rewardIds:[node]}),certificate:{appHash:root,appHeight:height}};},serviceWorkView:async()=>f.read({type:'service-work',id:node}),homeRecordProof:async(root,key)=>snapshot.proof(key,root)};
 const options={home:r.file+'.linux-worker',client,key:{...f.key(node),node},url:'unused',checkpoint:async()=>null,broadcast:async wire=>{sent.push(hash(wire));r.step([wire]);if(sent.length===1)throw Error('acknowledgement lost after commit');}};
 try{r.step([x.wire(f.activation)]);snapshot=r.db.store.readSnapshot(r.db.root);r.step([],serviceSlot(r.s.configHash,node,f.plan.from,f.profile));worker=new ServerRewardWorker(options);
  await assert.rejects(worker.cycle(),/acknowledgement lost/);assert.equal(worker.db.prepare('SELECT count(*) AS n FROM outbox').get().n,1);worker.close();closed=true;worker=new ServerRewardWorker(options);closed=false;
  const result=await worker.cycle();assert.equal(result.serviceWork.status,'ACCEPTED');assert.equal(result.submitted,0);assert.equal(sent.length,1);assert.equal(worker.db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);
  assert.equal((await worker.cycle()).serviceWork.status,'ACCEPTED');assert.equal(f.read({type:'service-work',id:node}).work.status,'ACCEPTED');
 }finally{if(worker&&!closed)worker.close();snapshot?.close();r.db.close();}
});

test('partial pilot cannot activate the ordinary calendar without the joint fund transition',()=>{
 const f=fixture(1,START,true),{r,x}=f;try{r.step([x.wire(f.activation)]);const s=r.s,body={domain:PREPARE_MAIN_SERVICE,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,managementEpoch:s.networkReserves.development.access.epoch,notBefore:s.money.time,expires:s.money.time+600,start:MAIN_START,planHash:s.economicPreparation.planHash,annualHash:inspectAnnualPlan(s.economicPreparation.plan.annualRegularMicro).annualHash,profileHash:hash(f.profile)};
  r.reject(x.wire({type:PREPARE_MAIN_SERVICE,certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey)}),/joint main-programme transition/);assert.equal(r.s.rewards.calendarService,undefined);
 }finally{r.db.close();}
});

test('ordinary payment work adds verified units once, keeps fees separate and survives daily cleanup',()=>{
 const f=fixture(1,START,true),{r,x}=f;try{r.step([x.wire(f.activation)]);r.step([],f.plan.from);
  const i=x.intent(r.s,{epoch:1,unitScale:'1000000',value:'1000000',fee:'5000',abortFee:'500',feeSchedule:r.s.money.paymentTariff.next,parts:[{value:'1000000',nodes:x.f.ids.slice(0,3)}]});
  r.step([x.reserve(i)]);r.step([x.finish(r.s,i)]);assert.equal(r.s.money.requests[i.pid].status,'SETTLED');const k='service-rewards/tasks/'+i.pid,task=r.db.store.proof(k,r.db.root).value;assert.equal(task.rows.length,3);assert(task.rows.every(row=>BigInt(row.units)>0n));
  const credited=r.s.rewards.collected,supply=r.s.money.supply;assert(BigInt(credited)>0n);r.reopen();r.step([],f.plan.to);for(let j=0;j<8;j++)r.step();assert.equal(r.s.rewards.preissuedServiceMicro,'200000000');assert.equal(r.s.rewards.collected,credited);assert.equal(r.s.money.supply,supply);
  r.step([],f.plan.from+3*DAY);for(let j=0;j<50;j++)r.step();r.reopen();assert.equal(r.db.store.proof(k,r.db.root).value,undefined);assert(r.db.store.proof('service-rewards/days/'+f.plan.from,r.db.root).value.cleanup.done);assert.equal(r.s.money.requests[i.pid].status,'SETTLED');assert.equal(r.s.rewards.preissuedServiceMicro,'200000000');assert.equal(r.s.money.supply,supply);
 }finally{r.db.close();}
});

test('process termination before/after service payout and cleanup preserves exactly one committed result',async()=>{
 for(const cleanup of [false,true])for(const phase of ['before','after']){
  const f=fixture(1,START,true),{r,x}=f;let closed=false;
  try{r.step([x.wire(f.activation)]);f.work();r.step([],f.plan.to);r.step();if(cleanup)for(let i=0;i<5;i++)r.step();
   const root=r.db.root,before=r.s.money.supply,request={height:r.s.height+1,time:cleanup?f.plan.from+3*DAY:r.s.money.time,blockHash:hash(['process crash',cleanup,phase]),txs:[]},expected=r.db.commitBlock(request,root,{dryRun:true}).root;
   const file=r.file+'.crash.json';fs.writeFileSync(file,JSON.stringify({file:r.file,config:x.c,root,request,phase}));r.db.close();closed=true;
   await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('./service-crash-child.mjs',import.meta.url)),file],{windowsHide:true,stdio:['ignore','pipe','pipe']});let ready=false,output='',errors='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('crash child timeout '+errors));},20000);child.stdout.on('data',b=>{output+=b;if(output.includes('READY')&&!ready){ready=true;child.kill('SIGKILL');}});child.stderr.on('data',b=>{errors+=b;});child.on('error',reject);child.on('close',()=>{clearTimeout(timer);ready?resolve():reject(Error('child exited before fault point '+errors));});});
   const db=BoundedNetworkInterpreter.open(r.file,x.c,phase==='before'?root:expected,{isolatedIssuance:false});try{
    if(phase==='before'){assert.equal(db.snapshotForAudit().rewards.preissuedServiceMicro,cleanup?'200000000':'0');assert.equal(db.commitBlock(request,root).root,expected);}
    assert(db.commitBlock(request,expected).value.duplicate);const s=db.snapshotForAudit();assert.equal(s.money.supply,before);assert.equal(s.rewards.preissuedServiceMicro,'200000000');
    if(cleanup)assert.equal(db.store.proof('service-rewards/days/'+f.plan.from,db.root).value.cleanup.count,8);
    assert([...db.store.journal.headers()].some(row=>row.root===root));for(const row of db.store.journal.scan({offlineLegacy:true}))assert.equal(hash(JSON.parse(row.body)),row.digest,'immutable history retained');
   }finally{db.close();}
  }finally{if(!closed)r.db.close();}
 }
});

test('service agent waits locally between verified slots without repeated network polling',async()=>{
 const key=keys(),node=hash('scheduled service'),schedule={};let now=0,reads=0;const options={config:{},node,key,schedule,clock:()=>now,outbox:{get:()=>null},readView:async()=>{reads++;return {node,publicKey:key.publicKey,admitted:true,time:1000,work:{status:'WAITING',slot:1100,intervalStart:0}};}};
 await runServiceWork(options);for(let i=0;i<100;i++)await runServiceWork(options);assert.equal(reads,1);now=100001;await runServiceWork(options);assert.equal(reads,2);
});

test('closed service details compact in bounded restartable pages while earned funds and archived root remain',()=>{
 const f=fixture(1,START,true),{r,x}=f;try{
  r.step([x.wire(f.activation)]);f.work();r.step([],f.plan.to);for(let i=0;i<6;i++)r.step();const paid=owned(r.s,x.f.bob.publicKey),supply=r.s.money.supply;
  const root=r.db.root,request={height:r.s.height+1,time:f.plan.from+3*DAY,blockHash:hash('cleanup crash'),txs:[]};
  assert.throws(()=>r.db.commitBlock(request,root,{beforeCommit:()=>{throw Error('cleanup interrupted');}}),/cleanup interrupted/);assert.equal(r.db.root,root);r.reopen();
  r.step([],request.time);let d=r.db.store.proof('service-rewards/days/'+f.plan.from,r.db.root).value;assert.equal(d.cleanup.count,8);assert.equal(d.cleanup.root,root);r.reopen();
  r.step();r.reopen();assert.equal(r.db.store.proof('service-rewards/days/'+f.plan.from,r.db.root).value.cleanup.count,11);
  for(let i=0;i<48;i++)r.step();r.reopen();d=r.db.store.proof('service-rewards/days/'+f.plan.from,r.db.root).value;
  assert(d.cleanup.done);assert.equal(d.cleanup.count,11);assert.equal(d.cleanup.paid,'200000000');assert.equal(d.cleanup.root,root);assert.equal(r.db.store.proof(SERVICE_HEAD,r.db.root).value.cleanupDay,f.plan.to);
  for(const node of f.ids){assert.equal(r.db.store.proof('service-rewards/work/'+f.plan.from+'/'+node,r.db.root).value,undefined);assert.equal(r.db.store.proof('service-rewards/receipts/'+f.plan.from+'/'+node,r.db.root).value,undefined);}
  assert.equal(owned(r.s,x.f.bob.publicKey),paid);assert.equal(r.s.money.supply,supply);r.step();r.reopen();assert.equal(owned(r.s,x.f.bob.publicKey),paid);
 }finally{r.db.close();}
});

test('non-isolated partial pilot funds pay all eleven nodes without opening main issuance',()=>{
 const f=fixture(1,START,true),{r,x}=f;try{const supply=r.s.money.supply,before=owned(r.s,x.f.bob.publicKey);r.step([x.wire(f.activation)]);f.work();r.reopen();r.step([],f.plan.to);for(let i=0;i<6;i++)r.step();r.reopen();
  assert.equal(r.s.centuryFunds.execution.partialWarmupMicro,'9000000000');assert.equal(r.s.money.supply,supply);assert.equal(r.s.rewards.minted,'0');assert.equal(r.s.rewards.preissuedServiceMicro,'200000000');assert.equal(owned(r.s,x.f.bob.publicKey)-before,200000000n);
  assert(f.ids.every(n=>BigInt(r.s.rewards.nodes[n].earned)>0n&&r.s.rewards.nodes[n].earned===r.s.rewards.nodes[n].paid));r.reject(x.wire(certify(x,r.s,ISSUE_CENTURY,{supplyBefore:supply})),/issuance forbidden/);
 }finally{r.db.close();}
});

test('service HTTP proof retains the assigned root across writes and binds reads to the verified tail certificate',async()=>{
 const f=fixture(1),{r,x}=f;let clock=0;const options={clock:()=>clock,retained:2,ttl:1000},leases=new BoundedReadLeases(r.db,options),server=createBoundedApi(r.db,options);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{r.step([x.wire(f.activation)]);const node=f.home.node,slot=serviceSlot(r.s.configHash,node,f.plan.from,f.profile),old=r.db.root;r.step([],slot);
  const anchor=f.read({type:'service-work',id:node}).work.anchor;assert.equal(anchor.root,old);for(let i=0;i<10;i++)r.step();clock=2000;leases.prune();
  const certificate={appHash:r.db.root,appHeight:r.s.height,height:r.s.height+1},client={bounded:{url:'http://127.0.0.1:'+server.address().port},config:x.c,verifiedServiceCertificate:hash(certificate),book:{current:{body:{appHash:old}}}};
  const view=await VerifiedClient.prototype.serviceWorkView.call(client,certificate,node);assert.equal(view.work.anchor.root,old);
  const proof=await VerifiedClient.prototype.homeRecordProof.call(client,old,view.work.key);r.step([x.wire(f.action(node,proof),f.key(node))]);assert.equal(f.read({type:'service-work',id:node}).work.status,'ACCEPTED');
  await assert.rejects(VerifiedClient.prototype.serviceWorkView.call(client,{...certificate,appHash:old},node),/verified service certificate/);
  r.step([],slot+240);clock=240000;for(let i=0;i<10;i++)r.step();leases.prune();assert(!leases.roots.has(old),'obsolete service root released');
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));leases.close();r.db.close();}
});

test('signed daily service: ten Linux and Home earn and receive 200 without payments or mint; exhaustion stops new work',()=>{
 const f=fixture(1),{r,x}=f;try{
  const before=owned(r.s,x.f.bob.publicKey),supply=r.s.money.supply;r.step([x.wire(f.activation)]);r.step([x.wire(f.activation)]);
  f.work();r.reopen();r.step([],f.plan.to);for(let i=0;i<6;i++)r.step();
  assert.equal(r.s.money.supply,supply);assert.equal(r.s.rewards.preissuedServiceMicro,'200000000');assert.equal(r.s.rewards.minted,'0');assert.equal(r.s.centuryWarmup.serviceFunding.reservedMicro,'0');
  assert.equal(owned(r.s,x.f.bob.publicKey)-before,200000000n);assert(f.ids.every(id=>BigInt(r.s.rewards.nodes[id].earned)>0n&&r.s.rewards.nodes[id].earned===r.s.rewards.nodes[id].paid));
  assert.equal(f.read({type:'service-work',id:f.home.node}).work.status,'OUTSIDE_FUNDED_SCHEDULE');
  const last=r.step();assert(r.db.commitBlock(last.request,r.db.root).value.duplicate);r.reopen();assert.equal(owned(r.s,x.f.bob.publicKey)-before,200000000n);
 }finally{r.db.close();}
});

test('service work rejects fake authority, proof substitution, late submission; durable agent retries exact signed wire',async()=>{
 const f=fixture(),{r,x}=f;try{
  const weak=structuredClone(f.activation);weak.certificate.approvals.pop();r.reject(x.wire(weak));r.step([x.wire(f.activation)]);
  const node=f.home.node,slot=serviceSlot(r.s.configHash,node,f.plan.from,f.profile),snapshot=r.db.store.readSnapshot(r.db.root);r.step([],slot);
  try{const v=f.read({type:'service-work',id:node}),proof=snapshot.proof(v.work.key,snapshot.root),a=f.action(node,proof),bad=structuredClone(a);bad.response.proof.value.height++;
   r.reject(x.wire(bad,f.key(node)));r.reject(x.wire(a,keys()),/author/);
   let saved=null,calls=0;const sent=[];const options={config:x.c,node,key:f.key(node),readView:async()=>f.read({type:'service-work',id:node}),readProof:async()=>proof,outbox:{get:()=>saved,put:w=>{assert(!saved);saved=w;},remove:()=>{saved=null;}},broadcast:async wire=>{sent.push(hash(wire));if(!calls++)throw Error('response lost');r.step([wire]);}};
   await assert.rejects(runServiceWork(options),/response lost/);assert(saved);await runServiceWork(options);assert.equal(sent[0],sent[1]);
   const earned=r.s.rewards.preissuedServiceMicro;await runServiceWork(options);assert.equal(saved,null);assert.equal(r.s.rewards.preissuedServiceMicro,earned);
   r.step([],slot+181);r.step([x.wire(a,f.key(node))]); // exact accepted retry after deadline
   const other=f.ids.find(n=>n!==node),late={...a,node:other};r.reject(x.wire(late,f.key(other)));
  }finally{snapshot.close();}
 }finally{r.db.close();}
});

test('daily close rollback/restart retains source and cursors; empty day is retained for reconciliation',()=>{
 const f=fixture(),{r,x}=f;try{
  r.step([x.wire(f.activation)]);f.work();r.step([],f.plan.from+DAY);r.step();
  const root=r.db.root,supply=r.s.money.supply,request={height:r.s.height+1,time:r.s.money.time,blockHash:hash('service payout crash'),txs:[]};
  assert.throws(()=>r.db.commitBlock(request,root,{beforeCommit:()=>{throw Error('before commit crash');}}),/before commit crash/);assert.equal(r.db.root,root);r.reopen();
  r.step();r.reopen();r.step();assert.equal(r.s.rewards.preissuedServiceMicro,'200000000');
  r.step([],f.plan.to);r.reopen();assert.equal(r.s.centuryWarmup.serviceFunding.reservedMicro,'200000000');assert.equal(r.s.money.supply,supply);
  const h=r.db.store.proof(SERVICE_HEAD,r.db.root).value;assert.equal(h.nextDay,f.plan.to);assert.equal(h.creditedMicro,'200000000');
  assert.equal(r.db.store.proof('service-rewards/days/'+(f.plan.from+DAY),r.db.root).value.phase,'RECONCILIATION_REQUIRED');
 }finally{r.db.close();}
});

test('same signed work and allocator cross UTC 2027: no early mint, daily issuance and exact-once payment after restart',()=>{
 const f=fixture(1,MAIN_START-2.5*DAY),{r,x}=f;try{
  assert.equal(f.plan.to,MAIN_START);r.step([x.wire(f.activation)]);
  const s=r.s,body={domain:PREPARE_MAIN_SERVICE,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,managementEpoch:s.networkReserves.development.access.epoch,notBefore:s.money.time,expires:s.money.time+600,start:MAIN_START,planHash:s.economicPreparation.planHash,annualHash:inspectAnnualPlan(s.economicPreparation.plan.annualRegularMicro).annualHash,profileHash:hash(f.profile)};
  const a={type:PREPARE_MAIN_SERVICE,certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey)};
  const weak=structuredClone(a);weak.certificate.approvals.pop();r.reject(x.wire(weak));
  const supply=r.s.money.supply;r.step([x.wire(a)]);r.step([x.wire(a)]);r.reopen();assert.equal(r.s.money.supply,supply);
  f.work();r.step([],MAIN_START-1);assert.equal(r.s.rewards.minted,'0');
  r.step([],MAIN_START);for(let i=0;i<5;i++)r.step();assert.equal(r.s.rewards.preissuedServiceMicro,'200000000');assert.equal(r.s.rewards.minted,'0');
  f.work(MAIN_START+3600);const before=owned(r.s,x.f.bob.publicKey),pool=dailyNodePool(r.s.economicPreparation.plan.annualRegularMicro,MAIN_START);
  const root=r.db.root,request={height:r.s.height+1,time:MAIN_START+DAY,blockHash:hash('calendar boundary crash'),txs:[]};
  assert.throws(()=>r.db.commitBlock(request,root,{beforeCommit:()=>{throw Error('calendar before commit');}}),/calendar before commit/);r.reopen();assert.equal(r.s.money.supply,supply);
  r.step([],MAIN_START+DAY);r.reopen();for(let i=0;i<6;i++)r.step();
  assert.equal(r.s.rewards.minted,pool);assert.equal(BigInt(r.s.money.supply)-BigInt(supply),BigInt(pool));assert.equal(owned(r.s,x.f.bob.publicKey)-before,BigInt(pool));
  assert(f.ids.every(id=>r.s.rewards.nodes[id].earned===r.s.rewards.nodes[id].paid));
  const paid=owned(r.s,x.f.bob.publicKey);r.step([],MAIN_START+2*DAY);r.reopen();for(let i=0;i<3;i++)r.step();
  const next=dailyNodePool(r.s.economicPreparation.plan.annualRegularMicro,MAIN_START+DAY);assert.equal(r.s.rewards.calendarService.heldMicro,next);assert.equal(owned(r.s,x.f.bob.publicKey),paid);
  assert.equal(r.db.store.proof('service-rewards/days/'+(MAIN_START+DAY),r.db.root).value.phase,'RECONCILIATION_REQUIRED');
 }finally{r.db.close();}
});
