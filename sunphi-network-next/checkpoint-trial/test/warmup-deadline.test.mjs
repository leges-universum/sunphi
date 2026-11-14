import test from 'node:test';
import assert from 'node:assert/strict';
import {utcEconomicFixture} from './helpers/utc-economic-fixture.mjs';
import {openCenturyWarmupInterval,centuryWarmupPlan,reserveCenturyWarmup,applyCenturyWarmupAction,UPGRADE_WARMUP,WARMUP_EXECUTOR_V2} from '../century-warmup.mjs';
import {hash,sign} from '../crypto.mjs';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BoundedNetworkInterpreter} from '../research/bounded-network-interpreter.mjs';
import {INITIAL_TARIFF} from '../payment-tariff.mjs';
import {queryBounded,verifyBoundedQuery} from '../research/bounded-query.mjs';
import {createBoundedApi} from '../research/bounded-api.mjs';
import {loadBoundedServiceView} from '../research/bounded-wallet-view.mjs';
import {CenturyWarmupWorker,remoteWarmupReceipt} from '../century-warmup-worker.mjs';
import http from 'node:http';
import {workReceipt} from '../core.mjs';

function fixture(){const x=utcEconomicFixture({warmup:true,liability:{expanded:true,terminal:true}});x.s.centuryWarmup.controllerPolicy.intervalSeconds=20;x.s.centuryWarmup.ttlSeconds=120;return x;}
function upgrade(x,s,intervalSeconds=s.centuryWarmup.controllerPolicy.intervalSeconds){const body={domain:UPGRADE_WARMUP,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+100,planHash:s.centuryWarmup.planHash,previousBookHash:hash(s.centuryWarmup),managementEpoch:s.networkReserves.development.access?.epoch??0,intervalSeconds};return {type:UPGRADE_WARMUP,certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey)};}
function rig(x){const file=join(mkdtempSync(join(tmpdir(),'warmup-deadline-')),'state.sqlite');let db=BoundedNetworkInterpreter.create(file,x.s,x.c,hash(x.s)),s=x.s;const reads=[];
 return {get s(){return s;},get db(){return db;},reads,
 step(wires=[],time=s.money.time,options={}){const req={height:s.height+1,time,blockHash:hash(['deadline',s.height+1,time]),txs:wires.map(w=>Buffer.from(JSON.stringify(w)))};const scan=db.store.scanAuthenticated;db.store.scanAuthenticated=()=>{throw Error('hot path full scan');};let r;try{r=db.commitBlock(req,db.root,options);}finally{db.store.scanAuthenticated=scan;}s=db.snapshotForAudit();assert.deepEqual(r.value.codes,wires.map(()=>0));reads.push(r.value.recordsRead);return req;},
 reopen(){const root=db.root;db.close();db=BoundedNetworkInterpreter.open(file,x.c,root);assert.deepEqual(db.snapshotForAudit(),s);},close(){db.close();}};
}

test('legacy 20-second admission window truncates a configured 120-second payment',()=>{
 const x=utcEconomicFixture({warmup:true,liability:{expanded:true,terminal:true}});let s=x.s;
 s.centuryWarmup.controllerPolicy.intervalSeconds=20;s.centuryWarmup.ttlSeconds=120;
 const start=s.money.time;
 s.centuryWarmup=openCenturyWarmupInterval(s.centuryWarmup,s,x.capacity(s,{to:start+20}));
 const intent=centuryWarmupPlan(s.centuryWarmup,s.money);
 assert.equal(intent.deadline,start+20);
 s=x.run(s,[],start+10);
 const r=reserveCenturyWarmup(s.centuryWarmup,s.money,hash(intent));s={...s,money:r.money,centuryWarmup:r.book};
 s=x.run(s,[],start+21);
 assert.equal(s.money.requests[intent.pid].status,'EXPIRED');
 assert.equal(s.centuryWarmup.controller.spentMicro,'0');
 assert.equal(s.money.supply,x.s.money.supply);
});

test('warmup upgrade requires current book, founder and validator quorum; replay cannot change it',()=>{
 const x=fixture(),s=x.s,a=upgrade(x,s),before=hash(s);
 for(const mutate of [a=>a.founderConsent='invalid',a=>a.certificate.approvals=[],a=>a.certificate.body.previousBookHash=hash('stale'),a=>a.certificate.body.managementEpoch++,a=>a.certificate.body.network='other']){const bad=structuredClone(a);mutate(bad);assert.throws(()=>applyCenturyWarmupAction(s,bad,x.c));assert.equal(hash(s),before);}
 const next=applyCenturyWarmupAction(s,a,x.c);assert.equal(next.centuryWarmup.version,WARMUP_EXECUTOR_V2);assert.equal(hash(next.money),hash(s.money));assert.throws(()=>applyCenturyWarmupAction(next,a,x.c));
 const busy={...s,centuryWarmup:openCenturyWarmupInterval(s.centuryWarmup,s,x.capacity(s,{to:s.money.time+20}))};assert.throws(()=>applyCenturyWarmupAction(busy,upgrade(x,busy),x.c),/idle/);
});

test('signed admission duration changes neither settlement lifetime nor financial limits',()=>{
 const x=fixture(),s=x.s,before=hash(s),a=upgrade(x,s,60);
 const next=applyCenturyWarmupAction(s,a,x.c),expected=structuredClone(s);
 expected.centuryWarmup.version=WARMUP_EXECUTOR_V2;expected.centuryWarmup.controllerPolicy.intervalSeconds=60;
 assert.deepEqual(next,expected);assert.equal(hash(s),before);
 const tampered=structuredClone(a);tampered.certificate.body.intervalSeconds=120;
 assert.throws(()=>applyCenturyWarmupAction(s,tampered,x.c));
 for(const duration of [19,86401,20.5])assert.throws(()=>applyCenturyWarmupAction(s,upgrade(x,s,duration),x.c));
 assert.throws(()=>openCenturyWarmupInterval(next.centuryWarmup,next,x.capacity(next,{to:next.money.time+20})),/fixed UTC/);
 const book=openCenturyWarmupInterval(next.centuryWarmup,next,x.capacity(next,{to:next.money.time+60}));
 const intent=centuryWarmupPlan(book,next.money);assert(intent);
 assert.equal(intent.deadline,next.money.time+120);assert.equal(intent.lastReserve,next.money.time+59);
});

test('bounded warmup completes after admission closes, releases cover and pays fees exactly once after restart',()=>{
 const x=fixture(),r=rig(x),start=x.s.money.time;
 try{
  r.step([x.wire(upgrade(x,r.s))]);r.reopen();
  r.step([x.wire({type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:x.capacity(r.s,{to:start+20})})]);
  const i=centuryWarmupPlan(r.s.centuryWarmup,r.s.money);assert(i);assert.equal(i.deadline,start+120);assert.equal(i.lastReserve,start+19);
  r.step([x.wire({type:'RUN_CENTURY_WARMUP_V1',sequence:1,intentHash:hash(i)})],start+10);
  assert(i.parts[0].nodes.every(n=>BigInt(r.s.money.nodes[n].taskHeld)>0n));r.reopen();
  const receipt=x.finish(r.s,i),root=r.db.root,before=hash(r.s);
  assert.throws(()=>r.step([receipt],start+21,{beforeCommit:()=>{throw Error('interrupted commit');}}),/interrupted/);assert.equal(r.db.root,root);assert.equal(hash(r.db.snapshotForAudit()),before);
  r.reopen();const req=r.step([receipt],start+21);assert(r.db.commitBlock(req,r.db.root).value.duplicate);
  assert.equal(r.s.money.requests[i.pid].status,'SETTLED');assert.equal(r.s.centuryWarmup.controller.spentMicro,i.fee);assert.equal(r.s.rewards.collected,i.fee);
  assert(i.parts[0].nodes.every(n=>r.s.money.nodes[n].taskHeld==='0'));assert.equal(r.s.money.supply,x.s.money.supply);
  r.step([],r.s.rewards.period.end);const paid=i.parts[0].nodes.reduce((n,id)=>n+BigInt(r.s.rewards.nodes[id].paid),0n);assert(paid>0n&&paid<=BigInt(i.fee));
  const balances=hash(r.s.money.outputs);r.reopen();r.step([],r.s.money.time+10);assert.equal(hash(r.s.money.outputs),balances);assert(r.reads.every(n=>n<150));
 }finally{r.close();}
});

test('bounded warmup expiry returns principal and cover without fees; late admission is rejected',()=>{
 const x=fixture(),r=rig(x),start=x.s.money.time;
 try{
  r.step([x.wire(upgrade(x,r.s))]);r.step([x.wire({type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:x.capacity(r.s,{to:start+20})})]);
  const book=r.s.centuryWarmup,i=centuryWarmupPlan(book,r.s.money);assert.equal(centuryWarmupPlan(book,{...r.s.money,time:start+20}),null);
  const funds=s=>Object.values(s.money.outputs).filter(o=>book.accounts.includes(o.owner)).reduce((n,o)=>n+BigInt(o.value),0n),before=funds(r.s);
  r.step([x.wire({type:'RUN_CENTURY_WARMUP_V1',sequence:1,intentHash:hash(i)})],start+10);r.reopen();r.step([],i.deadline+1);
  assert.equal(r.s.money.requests[i.pid].status,'EXPIRED');assert.equal(funds(r.s),before);assert.equal(r.s.centuryWarmup.controller.spentMicro,'0');assert.equal(r.s.centuryWarmup.controller.reservedMicro,'0');assert.equal(r.s.rewards.collected,'0');assert(i.parts[0].nodes.every(n=>r.s.money.nodes[n].taskHeld==='0'));assert.equal(r.s.money.supply,x.s.money.supply);
 }finally{r.close();}
});

test('ten covered servers settle five DUBYT with the current minimum fee and conserve every unit',()=>{
 // Synthetic balances only. Match live routing amounts without issuing tokens
 // or importing production keys, custody, or signatures into this fixture.
 const x=utcEconomicFixture({warmup:true,liability:{expanded:true,terminal:true,workerCount:10}});
 x.s.centuryWarmup.controllerPolicy.intervalSeconds=20;x.s.centuryWarmup.ttlSeconds=120;x.s.centuryWarmup.maxPaymentMicro='5000000';
 x.s.money.paymentTariff={current:null,next:INITIAL_TARIFF,activation:x.s.money.time,certificateHash:hash('isolated current tariff')};
 for(const n of Object.values(x.s.money.nodes)){assert.equal(n.stake,'100000000');n.consensusHeld='1000000';n.tier='5000000';}
 const r=rig(x),start=x.s.money.time,supply=x.s.money.supply;
 try{
  r.step([x.wire(upgrade(x,r.s))]);
  r.step([x.wire({type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:x.capacity(r.s,{to:start+20})})]);
  const i=centuryWarmupPlan(r.s.centuryWarmup,r.s.money);assert.equal(i.value,'5000000');assert.equal(i.fee,'5000');assert.equal(i.abortFee,'0');assert.equal(i.parts[0].nodes.length,3);
  r.step([x.wire({type:'RUN_CENTURY_WARMUP_V1',sequence:1,intentHash:hash(i)})],start+10);r.reopen();
  for(const id of i.parts[0].nodes)assert.equal(r.s.money.nodes[id].taskHeld,'5000000');
  r.step([x.finish(r.s,i)],start+31);r.reopen();
  assert.equal(r.s.money.requests[i.pid].status,'SETTLED');assert.equal(r.s.centuryWarmup.controller.spentMicro,'5000');
  for(const n of Object.values(r.s.money.nodes)){assert.equal(n.taskHeld,'0');assert.equal(n.stake,'100000000');assert.equal(n.consensusHeld,'1000000');}
  r.step([],r.s.rewards.period.end);
  const paid=Object.values(r.s.rewards.nodes).reduce((n,v)=>n+BigInt(v.paid),0n);
  assert(paid>0n&&paid<=5000n);assert.equal(r.s.money.supply,supply);assert.equal(r.s.rewards.collected,'5000');
  const before=hash(r.s.money.outputs);r.reopen();r.step([],r.s.money.time+10);assert.equal(hash(r.s.money.outputs),before);
 }finally{r.close();}
});

test('authenticated warmup planning is bounded, replayable and rejects missing or modified evidence',()=>{
 const x=fixture(),r=rig(x),start=x.s.money.time,request={type:'warmup-plan',id:null};
 const read=()=>{const scan=r.db.store.scanAuthenticated;r.db.store.scanAuthenticated=()=>{throw Error('query full scan');};try{const reply=queryBounded(r.db,request,r.db.root);assert(reply.proofs.length<710);const result=verifyBoundedQuery(reply,request,r.db.root,r.s.configHash);assert.deepEqual(result.data.intent,centuryWarmupPlan(r.s.centuryWarmup,r.s.money));return reply;}finally{r.db.store.scanAuthenticated=scan;}};
 try{
  assert.equal(read().result.data.intent,null);
  r.step([x.wire(upgrade(x,r.s))]);r.step([x.wire({type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:x.capacity(r.s,{to:start+20})})]);
  const reply=read(),i=reply.result.data.intent;assert(i);r.reopen();assert.deepEqual(read(),reply);
  const missing=structuredClone(reply);missing.proofs.pop();assert.throws(()=>verifyBoundedQuery(missing,request,r.db.root,r.s.configHash));
  const modified=structuredClone(reply);modified.result.data.intent.deadline++;assert.throws(()=>verifyBoundedQuery(modified,request,r.db.root,r.s.configHash));
  const wrongRecord=structuredClone(reply),proof=wrongRecord.proofs.find(p=>p.key.startsWith('nodes/'));assert(proof);proof.value.stake='999999999999';assert.throws(()=>verifyBoundedQuery(wrongRecord,request,r.db.root,r.s.configHash));
  r.step([x.wire({type:'RUN_CENTURY_WARMUP_V1',sequence:1,intentHash:hash(i)})],start+10);assert.equal(read().result.data.intent,null);
  assert.throws(()=>verifyBoundedQuery(reply,request,r.db.root,r.s.configHash));r.reopen();assert.equal(read().result.data.intent,null);
  r.step([x.finish(r.s,i)],start+31);assert.equal(read().result.data.intent,null);
 }finally{r.close();}
});

test('HTTP warmup plan retains its certified root during writes and rejects stale unleased reads',async()=>{
 const x=fixture(),r=rig(x),start=x.s.money.time,request={type:'warmup-plan',id:null};
 r.step([x.wire(upgrade(x,r.s))]);r.step([x.wire({type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:x.capacity(r.s,{to:start+20})})]);
 const server=createBoundedApi(r.db);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port,root=r.db.root;
 const get=async suffix=>{const response=await fetch(base+suffix);return {status:response.status,body:await response.json()};};
 try{
  const leaseResponse=await fetch(base+'/v1/read-lease?root='+root,{method:'POST'});assert.equal(leaseResponse.status,200);const lease=await leaseResponse.json();
  const url='/v1/warmup-plan/summary?root='+root,first=await get(url);assert.equal(first.status,200);
  const i=verifyBoundedQuery(first.body,request,root,r.s.configHash).data.intent;assert(i);
  r.step([x.wire({type:'RUN_CENTURY_WARMUP_V1',sequence:1,intentHash:hash(i)})],start+10);
  assert.equal((await get(url)).status,409);
  const pinned=await get(url+'&lease='+lease.token);assert.equal(pinned.status,200);assert.deepEqual(pinned.body,first.body);
  const current=await get('/v1/warmup-plan/summary?root='+r.db.root);assert.equal(current.status,200);assert.equal(verifyBoundedQuery(current.body,request,r.db.root,r.s.configHash).data.intent,null);
  assert.equal((await get('/v1/warmup-plan/arbitrary?root='+r.db.root)).status,404);
  assert.equal((await get(url+'&unexpected=1')).status,400);
  assert.equal((await fetch(base+url,{headers:{Origin:'https://untrusted.invalid'}})).status,403);
  await fetch(base+'/v1/read-lease?lease='+lease.token,{method:'DELETE'});
  assert.equal((await get(url+'&lease='+lease.token)).status,400);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));r.close();}
});

test('bounded runner resumes consensus outbox, rejects forged receipts and settles while paused',async()=>{
 const x=fixture(),r=rig(x),start=x.s.money.time,sent=[],queries=[];let enabled=true,broken=false,wrongRoot=false,now=start;
 const query=async(request,root)=>{queries.push(request.type);return queryBounded(r.db,request,wrongRoot?hash('wrong root'):root);};
 const client={config:x.c,sync:async(_cp,_url,options)=>{assert.deepEqual(options,{service:true});const certificate={appHash:r.db.root,appHeight:r.s.height};return {...await loadBoundedServiceView(query,{root:certificate.appHash,height:certificate.appHeight,configHash:r.s.configHash}),certificate};}};
 const make=()=>new CenturyWarmupWorker({client,key:x.f.alice,planHash:x.s.economicPreparation.planHash,query,enabled:()=>enabled,now:()=>now,broadcast:async wire=>sent.push(wire),receipt:async({pid,index,node})=>{const receipt=workReceipt(r.s,pid,index,node,x.key(node));if(broken)receipt[broken==='profile'?'profileSignature':'signature']='invalid';return receipt;}});
 try{
  assert((await make().cycle()).paused);assert.equal(sent.length,0);
  r.step([x.wire(upgrade(x,r.s))]);r.step([x.wire({type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:x.capacity(r.s,{to:start+20})})]);
  const first=await make().cycle();assert.equal(first.submitted,'RUN_CENTURY_WARMUP_V1');
  await make().cycle();assert.deepEqual(sent[0],sent[1]);r.step([sent[0]],start+10);r.reopen();
  const pid=r.s.centuryWarmup.pending.pid;enabled=false;broken=true;now=start+10;
  await assert.rejects(make().cycle(),/invalid worker receipt/);assert.equal(sent.length,2);assert.equal(r.s.money.requests[pid].status,'RESERVED');
  broken='profile';await assert.rejects(make().cycle(),/invalid network-bound worker receipt/);assert.equal(sent.length,2);
  broken=false;wrongRoot=true;await assert.rejects(make().cycle());assert.equal(sent.length,2);wrongRoot=false;
  now=start+1000;assert.equal((await make().cycle()).reason,'stale-consensus');assert.equal(sent.length,2);
  now=start+31;r.step([],now);const last=await make().cycle();assert.equal(last.submitted,'FINALIZE');r.step([sent.at(-1)],now);r.reopen();
  assert.equal(r.s.money.requests[pid].status,'SETTLED');assert.equal(r.s.money.supply,x.s.money.supply);
  assert((await make().cycle()).paused);assert.equal(sent.length,3);
  assert(queries.every(t=>['wallet-meta','warmup-plan','request','node'].includes(t)));assert(queries.filter(t=>t==='node').length<=12);
 }finally{r.close();}
});

test('bounded runner closes unused admission intervals without spending funds',async()=>{
 const x=fixture(),r=rig(x),start=x.s.money.time,sent=[];
 const query=async(request,root)=>queryBounded(r.db,request,root);
 const client={config:x.c,sync:async()=>{const certificate={appHash:r.db.root,appHeight:r.s.height};return {...await loadBoundedServiceView(query,{root:certificate.appHash,height:certificate.appHeight,configHash:r.s.configHash}),certificate};}};
 const worker=new CenturyWarmupWorker({client,key:x.f.alice,planHash:x.s.economicPreparation.planHash,query,enabled:()=>true,now:()=>r.s.money.time,broadcast:async wire=>sent.push(wire)});
 try{
  r.step([x.wire(upgrade(x,r.s))]);r.step([x.wire({type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:x.capacity(r.s,{to:start+20})})]);r.step([],start+20);
  assert.equal((await worker.cycle()).submitted,'CLOSE_CENTURY_WARMUP_INTERVAL_V1');r.step(sent);r.reopen();
  assert.equal(r.s.centuryWarmup.controller.pending,null);assert.equal(r.s.centuryWarmup.controller.spentMicro,'0');assert.equal(r.s.money.supply,x.s.money.supply);
  assert.equal((await worker.cycle()).reason,'no-certified-work');assert.equal(sent.length,1);
 }finally{r.close();}
});

test('lost broadcast response and concurrent cycles cannot duplicate a warmup payment',async()=>{
 const x=fixture(),r=rig(x),start=x.s.money.time,sent=[];let release,entered,fail=true;
 const gate=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{entered=resolve;});
 const query=async(request,root)=>queryBounded(r.db,request,root);
 const client={config:x.c,sync:async()=>{const certificate={appHash:r.db.root,appHeight:r.s.height};return {...await loadBoundedServiceView(query,{root:certificate.appHash,height:certificate.appHeight,configHash:r.s.configHash}),certificate};}};
 const worker=new CenturyWarmupWorker({client,key:x.f.alice,planHash:x.s.economicPreparation.planHash,query,enabled:()=>true,now:()=>r.s.money.time,receipt:async({pid,index,node})=>workReceipt(r.s,pid,index,node,x.key(node)),broadcast:async wire=>{sent.push(wire);entered();await gate;if(fail)throw Error('response lost');}});
 try{
  r.step([x.wire(upgrade(x,r.s))]);r.step([x.wire({type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:x.capacity(r.s,{to:start+20})})]);
  const first=worker.cycle();await waiting;assert.equal((await worker.cycle()).reason,'another-cycle');release();await assert.rejects(first,/response lost/);
  fail=false;await worker.cycle();assert.deepEqual(sent[0],sent[1]);r.step([sent[0]],start+10);r.reopen();
  await worker.cycle();assert.equal(sent.at(-1).body.action.type,'FINALIZE');
  r.step([sent.at(-1)],start+31);r.reopen();const spent=r.s.centuryWarmup.controller.spentMicro;
  await worker.cycle();assert.equal(sent.length,3);assert.equal(r.s.centuryWarmup.controller.spentMicro,spent);assert.equal(r.s.money.supply,x.s.money.supply);
 }finally{release();r.close();}
});

test('unavailable workers expire safely without a running warmup service',async()=>{
 const x=fixture(),r=rig(x),start=x.s.money.time,sent=[];
 const query=async(request,root)=>queryBounded(r.db,request,root);
 const client={config:x.c,sync:async()=>{const certificate={appHash:r.db.root,appHeight:r.s.height};return {...await loadBoundedServiceView(query,{root:certificate.appHash,height:certificate.appHeight,configHash:r.s.configHash}),certificate};}};
 const worker=new CenturyWarmupWorker({client,key:x.f.alice,planHash:x.s.economicPreparation.planHash,query,enabled:()=>false,now:()=>r.s.money.time,broadcast:async wire=>sent.push(wire),receipt:async()=>{throw Error('worker offline');}});
 try{
  r.step([x.wire(upgrade(x,r.s))]);r.step([x.wire({type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:x.capacity(r.s,{to:start+20})})]);
  const i=centuryWarmupPlan(r.s.centuryWarmup,r.s.money),funds=s=>Object.values(s.money.outputs).filter(o=>s.centuryWarmup.accounts.includes(o.owner)).reduce((sum,o)=>sum+BigInt(o.value),0n),before=funds(r.s);
  r.step([x.wire({type:'RUN_CENTURY_WARMUP_V1',sequence:1,intentHash:hash(i)})],start+10);
  await assert.rejects(worker.cycle(),/worker offline/);assert.equal(sent.length,0);r.reopen();
  r.step([],i.deadline);assert.equal(r.s.money.requests[i.pid].status,'RESERVED');r.step([],i.deadline+1);r.reopen();
  assert.equal(r.s.money.requests[i.pid].status,'EXPIRED');assert.equal(funds(r.s),before);assert.equal(r.s.centuryWarmup.pending,null);assert.equal(r.s.centuryWarmup.controller.reservedMicro,'0');
  assert.equal(r.s.rewards.collected,'0');assert(Object.values(r.s.money.nodes).every(n=>n.taskHeld==='0'));assert.equal(r.s.money.supply,x.s.money.supply);
  assert((await worker.cycle()).paused);assert.equal(sent.length,0);
 }finally{r.close();}
});

test('worker receipt transport bounds responses and refuses redirects and remote routes',async()=>{
 let mode='ok',seen=0;const receipt={index:0,node:'worker',signature:'signed'};
 const server=http.createServer(async(req,res)=>{seen++;let body='';for await(const chunk of req)body+=chunk;const q=JSON.parse(body);assert.equal(q.params.path,'/work');assert.deepEqual(JSON.parse(Buffer.from(q.params.data,'hex')),{pid:'payment',index:0});
  if(mode==='redirect'){res.writeHead(307,{location:'http://127.0.0.1:'+server.address().port+'/redirect'});res.end();return;}
  if(mode==='oversize'){res.end(' '.repeat(16385));return;}
  if(mode==='error'){res.end(JSON.stringify({result:{response:{code:1}}}));return;}
  res.end(JSON.stringify({result:{response:{code:0,value:Buffer.from(JSON.stringify(receipt)).toString('base64')}}}));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  for(const route of ['https://example.com','http://localhost:80','http://user:pass@127.0.0.1','http://127.0.0.1/path'])assert.throws(()=>remoteWarmupReceipt({worker:route}));
  const fetchReceipt=remoteWarmupReceipt({worker:'http://127.0.0.1:'+server.address().port}),args={pid:'payment',index:0,node:'worker'};
  assert.deepEqual(await fetchReceipt(args),receipt);await assert.rejects(fetchReceipt({...args,node:'unknown'}),/route unavailable/);
  mode='redirect';const before=seen;await assert.rejects(fetchReceipt(args));assert.equal(seen,before+1);
  mode='oversize';await assert.rejects(fetchReceipt(args),/size/);mode='error';await assert.rejects(fetchReceipt(args),/unavailable/);
  const controller=new AbortController();controller.abort();await assert.rejects(fetchReceipt({...args,signal:controller.signal}));
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
