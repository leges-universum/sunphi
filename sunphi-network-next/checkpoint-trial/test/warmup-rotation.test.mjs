import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {hash,sign} from '../crypto.mjs';
import {utcEconomicFixture} from './helpers/utc-economic-fixture.mjs';
import {UPGRADE_WARMUP,UPGRADE_WARMUP_ROTATION,WARMUP_EXECUTOR_V3,applyCenturyWarmupAction,centuryWarmupPlan} from '../century-warmup.mjs';
import {createCapacityIndex,rotatingWarmupCapacity} from '../research/bounded-capacity-index.mjs';
import {BoundedNetworkInterpreter} from '../research/bounded-network-interpreter.mjs';
import {queryBounded,verifyBoundedQuery} from '../research/bounded-query.mjs';
import {capacityProposal} from '../warmup-capacity-service.mjs';

const fixture=()=>utcEconomicFixture({warmup:true,liability:{expanded:true,terminal:true,workerCount:10,sameGroup:true,founderNodes:Array.from({length:10},(_,i)=>i)}});
function upgrade(x,s,type=UPGRADE_WARMUP_ROTATION){const body={domain:type,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+100,planHash:s.centuryWarmup.planHash,previousBookHash:hash(s.centuryWarmup),managementEpoch:s.networkReserves.development.access?.epoch??0,...(type===UPGRADE_WARMUP?{intervalSeconds:60}:{})};return{type,certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey)};}
function v2(x){return applyCenturyWarmupAction(x.s,upgrade(x,x.s,UPGRADE_WARMUP),x.c);}
function index(m){const records=new Map(),reads=new Set();createCapacityIndex({get:k=>records.get(k),set:(k,v)=>records.set(k,v),delete:k=>records.delete(k)},m);return{records,reads,get:k=>{reads.add(k);return records.get(k);}};}

test('rotation visits all 500 eligible workers with bounded reads and no persistent index change',t=>{
 const m={nodes:{}};for(let i=0;i<500;i++)m.nodes[hash(['rotation',i])]={stake:'100',tier:'5',taskHeld:'0',consensusHeld:'1',operator:hash(['group',i])};
 const a=index(m),before=hash([...a.records]),counts=new Map();let after=null,maxReads=0;
 for(let i=0;i<500;i++){a.reads.clear();const ids=rotatingWarmupCapacity(a.get,m,{after,minimum:'5'});assert.equal(ids.length,3);for(const id of ids)counts.set(id,(counts.get(id)??0)+1);after=ids.at(-1);maxReads=Math.max(maxReads,a.reads.size);}
 assert.equal(counts.size,500);assert([...counts.values()].every(n=>n===3));assert(maxReads<100);assert.equal(hash([...a.records]),before);t.diagnostic(JSON.stringify({workers:500,assignments:1500,maxReads}));
});
test('rotation skips a dominant owner group, low cover, revoked consent and suspension',()=>{
 const m={nodes:{},liability:{height:1,policy:{activation:1,founderNodes:[],founderGroup:hash('founder')},consents:{},discipline:{}}};
 for(let i=0;i<1000;i++){const id=i.toString(16).padStart(64,'0');m.nodes[id]={stake:'100',tier:'5',taskHeld:'0',consensusHeld:'1',operator:hash(i<990?'dominant':i)};if(i!==999)m.liability.consents[id]=true;if(i===998)m.liability.discipline[id]={suspended:true};if(i===997)m.nodes[id].taskHeld='99';}
 const a=index(m),ids=rotatingWarmupCapacity(a.get,m,{after:null,minimum:'5'});assert.equal(ids.length,3);assert.equal(new Set(ids.map(id=>m.nodes[id].operator)).size,3);assert(a.reads.size<100);assert(!ids.some(id=>parseInt(id,16)>=997));
 assert.deepEqual(rotatingWarmupCapacity(a.get,m,{after:null,minimum:'101'}),[]);
});
test('V3 transition requires current V2 idle book, founder consent and quorum, preserving all economics',()=>{
 const x=fixture(),s=v2(x),a=upgrade(x,s),before=hash(s);
 for(const mutate of [a=>a.founderConsent='invalid',a=>a.certificate.approvals=[],a=>a.certificate.body.previousBookHash=hash('stale'),a=>a.certificate.body.managementEpoch++,a=>a.certificate.body.generation++,a=>a.certificate.body.network='other']){const bad=structuredClone(a);mutate(bad);assert.throws(()=>applyCenturyWarmupAction(s,bad,x.c));assert.equal(hash(s),before);}
 assert.throws(()=>applyCenturyWarmupAction(x.s,upgrade(x,x.s),x.c),/predecessor/);
 const next=applyCenturyWarmupAction(s,a,x.c),expected=structuredClone(s);expected.centuryWarmup.version=WARMUP_EXECUTOR_V3;expected.centuryWarmup.routingCursor=null;assert.deepEqual(next,expected);assert.throws(()=>applyCenturyWarmupAction(next,a,x.c));
 const operational={...next,centuryFunds:{zeroStage:{body:{startsAt:next.money.time,settings:{durationSeconds:86400}}}}};
 assert(capacityProposal(operational,{planHash:next.centuryWarmup.planHash},next.money.time));
});
test('ten real worker identities receive and are paid for signed jobs; bounded/full plans agree through crash, expiry and replay',()=>{
 const x=fixture(),file=join(mkdtempSync(join(tmpdir(),'warmup-rotation-')),'state.sqlite');let s=v2(x),db=BoundedNetworkInterpreter.create(file,s,x.c,hash(s)),maxReads=0;
 const reopen=()=>{const root=db.root;db.close();db=BoundedNetworkInterpreter.open(file,x.c,root);assert.deepEqual(db.snapshotForAudit(),s);};
 const step=(actions=[],time=s.money.time,options={})=>{
  const request={height:s.height+1,time,blockHash:hash(['rotation',s.height+1,time]),txs:actions.map(w=>Buffer.from(JSON.stringify(w)))},scan=db.store.scanAuthenticated;
  db.store.scanAuthenticated=()=>{throw Error('full scan forbidden');};let r;try{r=db.commitBlock(request,db.root,options);}finally{db.store.scanAuthenticated=scan;}
  assert.deepEqual(r.value.codes,actions.map(()=>0));maxReads=Math.max(maxReads,r.value.recordsRead);s=db.snapshotForAudit();return request;
 };
 try{
  step([x.wire(upgrade(x,s))]);reopen();const assigned=new Set(),supply=s.money.supply;
  for(let round=0;round<5;round++){
   const time=Math.max(s.money.time,s.centuryWarmup.controller.cursor);step([],time);
   step([x.wire({type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:x.capacity(s)})]);
   const root=db.root,q={type:'warmup-plan',id:null},proof=queryBounded(db,q,root),i=verifyBoundedQuery(proof,q,root,s.configHash).data.intent;
   assert.deepEqual(i,centuryWarmupPlan(s.centuryWarmup,s.money));assert(i);
   const tampered=structuredClone(proof);tampered.result.data.intent.parts[0].nodes.reverse();assert.throws(()=>verifyBoundedQuery(tampered,q,root,s.configHash));
   const run=x.wire({type:'RUN_CENTURY_WARMUP_V1',sequence:s.centuryWarmup.controller.pending.sequence,intentHash:hash(i)}),before=hash(s);
   assert.throws(()=>step([run],time+1,{beforeCommit:()=>{throw Error('power loss');}}),/power loss/);assert.equal(db.root,root);assert.equal(hash(db.snapshotForAudit()),before);reopen();
   const request=step([run],time+1);assert.equal(s.centuryWarmup.routingCursor,i.parts[0].nodes.at(-1));assert(db.commitBlock(request,db.root).value.duplicate);reopen();
   if(round===4){step([],i.deadline+1);assert.equal(s.money.requests[i.pid].status,'EXPIRED');assert.equal(s.centuryWarmup.routingCursor,i.parts[0].nodes.at(-1));}
   else{step([x.finish(s,i)],time+2);for(const id of i.parts[0].nodes)assigned.add(id);assert.equal(s.money.requests[i.pid].status,'SETTLED');}
   reopen();
  }
  assert.equal(assigned.size,10);step([],s.rewards.period.end);assert.equal(s.money.supply,supply);assert.equal(s.rewards.minted,'0');
  for(const id of x.f.ids){const r=s.rewards.nodes[id];assert(BigInt(r.workerJobs)>0n);assert(BigInt(r.earned)>0n);assert.equal(r.paid,r.earned);assert.deepEqual(r.payouts,[{wallet:x.wallet.publicKey,weight:1}]);}
  const balances=hash(s.money.outputs);reopen();step([],s.money.time+1);assert.equal(hash(s.money.outputs),balances);assert(maxReads<250);
 }finally{db.close();}
});
