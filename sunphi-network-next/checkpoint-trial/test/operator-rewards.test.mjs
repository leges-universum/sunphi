import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BoundedNetworkInterpreter} from '../research/bounded-network-interpreter.mjs';
import {keys,hash,sign} from '../crypto.mjs';
import {redistributeLinux} from '../research/operator-reward-allocation.mjs';
import {OPERATOR_POLICY,OPERATOR_STATUS,OPERATOR_ISSUERS,OPERATOR_LINK,OPERATOR_HEAD,operatorFactor,operatorKey} from '../research/operator-reward-policy.mjs';
import {queryBounded,verifyBoundedQuery} from '../research/bounded-query.mjs';
import {createBoundedApi} from '../research/bounded-api.mjs';
import {boundedHttpQuery} from '../research/bounded-wallet-view.mjs';
import {rewardEvidence,reconcileRewardCredential} from '../../operator-registry/reward-bridge.mjs';
import {companyIdentity,reviewInput} from '../../operator-registry/verification-contract.mjs';
import {serviceFixture} from './bounded-service-rewards.test.mjs';
const DAY=86400;
test('account link + real admin review metadata -> authenticated network tier; reconnect is idempotent',async()=>{
 const f=serviceFixture(3,Date.UTC(2026,10,16,12)/1000,true),{r,x}=f,issuer=keys();
 try{
  r.step([x.wire(f.activation)]);enable(f,issuer);const node=f.ids.find(n=>n!==f.home.node);
  const application={id:'11111111-1111-1111-1111-111111111111',operator_key:keys().publicKey,decision:'under_review',submission:{body:{profile:{kind:'company',country:'US',legalName:'Example LLC',registrationNumber:'123',representative:'Example Person',commonControl:'Declared group'}}}},account={operator_key:application.operator_key,account_id:'duebyte-owner'},company={id:'company-1',company_name:'Example LLC',registration_country:'US',registration_number:'123',owner_id:'source-owner',status:'active',verification_status:'verified'},identity=companyIdentity(company),link={application_id:application.id,company_id:company.id,source_account:company.owner_id,status:'confirmed',identity};
  const review={company_id:company.id,status:'verified',identity,reviewed_at:new Date(r.s.money.time*1000).toISOString(),detail:reviewInput({lawyer:true,reviewer:'Counsel',organization:'Law practice',reference:'REVIEW-1',companyRecords:true,representativeAuthority:true,subjectName:'Example Person',authorityScope:'Represent operator',validUntil:null},company,r.s.money.time*1000)};
  const source=()=>rewardEvidence({application,account,company,link,review,now:r.s.money.time}),e=await source(),b={domain:OPERATOR_LINK,configHash:r.s.configHash,node,operator:e.operator,profileHash:e.profileHash,sequence:1,effectiveFrom:f.plan.from,validUntil:f.plan.to+DAY,automaticLegalUpdates:true};
  const consent={type:OPERATOR_LINK,body:b,signature:sign(b,f.key(node).privateKey)};
  r.reject(x.wire({...consent,signature:sign(b,keys().privateKey)},f.key(node)),/management consent/);
  r.step([x.wire(consent,f.key(node))]);r.step([x.wire(consent,f.key(node))]);r.reopen();
  const readVerified=async()=>{
   const server=createBoundedApi(r.db);await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
   try{const url='http://127.0.0.1:'+server.address().port,q={type:'operator-reward',id:node},root=r.db.root;
    assert.equal((await fetch(url+'/v1/operator-reward/'+node+'?root='+root,{headers:{origin:'https://invalid.example'}})).status,403);
    assert.equal((await fetch(url+'/v1/operator-reward/invalid?root='+root)).status,400);
    assert.equal((await fetch(url+'/v1/unknown/'+node+'?root='+root)).status,404);
    return await boundedHttpQuery(url).withLease(root,async query=>{const proof=await query(q,root);assert(proof.proofs.length<12,'bounded proof');return verifyBoundedQuery(proof,q,root,r.s.configHash).data;});
   }finally{server.closeAllConnections();await new Promise(ok=>server.close(ok));}
  };
  assert.equal((await readVerified()).factor,2);let saved=null,sends=0;
  const outbox={get:async()=>saved,putIfAbsent:async(_n,a)=>{if(saved)return false;saved=structuredClone(a);return true;},clear:async(_n,a)=>{assert.deepEqual(saved,a);saved=null;}};
  const args={node,readVerified,evidence:source,outbox,issuer:issuer.publicKey,configHash:r.s.configHash,sign:async b=>sign(b,issuer.privateKey),broadcast:async a=>{r.step([x.wire(a,issuer)]);sends++;return {accepted:true};}};
  assert.equal((await reconcileRewardCredential(args)).status,'SUBMITTED');r.reopen();
  assert.equal((await reconcileRewardCredential(args)).status,'CONFIRMED');assert.equal(sends,1);
  assert.equal((await reconcileRewardCredential(args)).status,'UNCHANGED');
  r.step([],f.plan.from);assert.equal((await readVerified()).factor,4);
  company.status='suspended';assert.equal((await reconcileRewardCredential(args)).status,'SUBMITTED');r.reopen();assert.equal((await reconcileRewardCredential(args)).status,'CONFIRMED');
  assert.equal((await readVerified()).factor,4,'earned day cannot change retrospectively');
  r.step([],f.plan.from+DAY);assert.equal((await readVerified()).factor,3);
  const unlink={...b,sequence:2,effectiveFrom:f.plan.from+2*DAY,validUntil:0};r.step([x.wire({type:OPERATOR_LINK,body:unlink,signature:sign(unlink,f.key(node).privateKey)},f.key(node))]);r.reopen();r.step([],f.plan.from+2*DAY);assert.equal((await readVerified()).factor,2);
 }finally{r.db.close();}
});
test('Linux 1/1.5/2 weights conserve budget and every Home rounding decision',()=>{
 for(let seed=1;seed<=1000;seed++){
  const rows=Array.from({length:1+seed%39},(_,i)=>({node:hash(['row',i]),units:BigInt(1+(seed*(i+3))%133),kind:i%4?'worker':'witness',factor:2+i%3}));
  const pool=BigInt(seed%17?seed*137:1),before=redistributeLinux(pool,rows.map(r=>({...r,factor:2}))),after=redistributeLinux(pool,rows);
  assert.equal([...after.values()].reduce((a,b)=>a+b,0n),pool);
  for(const r of rows)if(r.kind==='witness')assert.equal(after.get(r.node),before.get(r.node));
  assert.deepEqual(redistributeLinux(pool,[...rows].reverse()),after);
  for(const factor of [2,3,4])assert.deepEqual(redistributeLinux(pool,rows.map(r=>({...r,factor}))),before);
 }
 const rows=[2,3,4].map((factor,i)=>({node:hash(i),kind:'worker',units:1n,factor})),r=redistributeLinux(450000000n,rows);assert.deepEqual(rows.map(x=>r.get(x.node)),[100000000n,150000000n,200000000n]);
});
function enable(f,issuer){const {r,x}=f,b={domain:OPERATOR_POLICY,configHash:r.s.configHash,network:x.c.chainId,generation:r.s.authority.generation,managementEpoch:r.s.networkReserves.development.access.epoch,notBefore:r.s.money.time,expires:r.s.money.time+600,effectiveFrom:f.plan.from,issuers:[issuer.publicKey]};r.step([x.wire({type:OPERATOR_POLICY,certificate:{body:b,approvals:x.approvals(b)},founderConsent:sign(b,x.founder.privateKey)})]);}
function status(f,issuer,node,level,patch={}){const {r}=f,old=r.db.store.proof(operatorKey(node),r.db.root).value,b={domain:OPERATOR_STATUS,configHash:r.s.configHash,node,operator:hash('registered operator'),profileHash:hash('public profile'),sequence:(old?.sequence??0)+1,effectiveFrom:f.plan.from,registeredUntil:level>1?f.plan.to:0,legalUntil:level===2?f.plan.to:0,reviewedAt:level===2?r.s.money.time:0,sourceRevision:(old?.pending.sourceRevision??0)+1,issuer:issuer.publicKey,...patch};return {type:OPERATOR_STATUS,credential:b,issuerSignature:sign(b,issuer.privateKey),nodeSignature:sign(b,f.key(node).privateKey)};}
test('consensus redistribution retains Home, custody, replay, restart and pruning',()=>{
 const f=serviceFixture(2,Date.UTC(2026,10,16,12)/1000,true),{r,x}=f,issuer=keys();
 try{r.step([x.wire(f.activation)]);enable(f,issuer);const workers=f.ids.filter(n=>n!==f.home.node);
  for(const [n,level]of [[workers[0],1.5],[workers[1],2]]){const a=status(f,issuer,n,level);r.step([x.wire(a,f.key(n))]);r.step([x.wire(a,f.key(n))]);}
  f.work();const day=f.plan.from,read=k=>r.db.store.proof(k,r.db.root).value;
  const rows=f.ids.map(node=>({node,kind:r.s.rewards.nodes[node].kind,units:BigInt(read('service-rewards/work/'+day+'/'+node).units),factor:read('service-rewards/work/'+day+'/'+node).factor??2}));
  const expected=redistributeLinux(200000000n,rows),before=new Map(f.ids.map(n=>[n,BigInt(r.s.rewards.nodes[n].earned)])),supply=r.s.money.supply;
  r.step([],day+DAY);
  for(let i=0;i<15;i++){r.reopen();r.step();}
  for(const n of f.ids)assert.equal(BigInt(r.s.rewards.nodes[n].earned)-before.get(n),expected.get(n));
  assert.equal(r.s.money.supply,supply);assert.equal(r.s.centuryWarmup.serviceFunding.spentMicro,'200000000');
  const earned=f.ids.map(n=>r.s.rewards.nodes[n].earned);r.step([],day+3*DAY);for(let i=0;i<60;i++){r.step();if(i%5===0)r.reopen();}
  assert.equal(read('service-rewards/days/'+day).cleanup.done,true);assert.deepEqual(f.ids.map(n=>r.s.rewards.nodes[n].earned),earned);assert.equal(r.s.money.supply,supply);
 }finally{r.db.close();}
});
test('unsigned, foreign, Home, expired and retroactive promotions rejected; source can withdraw',()=>{
 const f=serviceFixture(3,Date.UTC(2026,10,16,12)/1000,true),{r,x}=f,issuer=keys();try{
  r.step([x.wire(f.activation)]);enable(f,issuer);const n=f.ids.find(n=>n!==f.home.node),a=status(f,issuer,n,2);
  r.reject(x.wire({...a,issuerSignature:sign(a.credential,keys().privateKey)},f.key(n)),/source signature/);
  r.reject(x.wire({...a,nodeSignature:sign(a.credential,keys().privateKey)},f.key(n)),/management consent/);
  r.reject(x.wire(status(f,issuer,f.home.node,2),f.home.work),/Linux worker/);
  r.reject(x.wire(status(f,issuer,n,2,{effectiveFrom:r.s.money.time-DAY}),f.key(n)),/integer bound|boundary/);
  r.reject(x.wire(status(f,issuer,n,2,{registeredUntil:f.plan.from}),f.key(n)),/registration validity/);
  r.step([x.wire(a,f.key(n))]);r.step([],f.plan.from);r.reopen();const get=k=>r.db.store.proof(k,r.db.root).value;
  assert.equal(operatorFactor(get,n,f.plan.from),4);assert.equal(operatorFactor(get,n,f.plan.to),2);
  const revoke=status(f,issuer,n,1,{effectiveFrom:f.plan.from+DAY});revoke.nodeSignature=null;r.step([x.wire(revoke,issuer)]);
  assert.equal(operatorFactor(get,n,f.plan.from),4);assert.equal(operatorFactor(get,n,f.plan.from+DAY),2);
  r.reject(x.wire(a,f.key(n)),/sequence/);
 }finally{r.db.close();}
});

test('pending promotion can be withdrawn; legal downgrade needs no operator cooperation; issuer rotation is prospective',()=>{
 const f=serviceFixture(4,Date.UTC(2026,10,16,12)/1000,true),{r,x}=f,issuer=keys(),next=keys();try{
  r.step([x.wire(f.activation)]);enable(f,issuer);const n=f.ids.find(n=>n!==f.home.node),get=k=>r.db.store.proof(k,r.db.root).value;
  r.step([x.wire(status(f,issuer,n,2),f.key(n))]);const lower=status(f,issuer,n,1.5);lower.nodeSignature=null;r.step([x.wire(lower,issuer)]);r.reopen();
  assert.equal(operatorFactor(get,n,f.plan.from),3);assert.equal(operatorFactor(get,n,f.plan.to),2);
  const h=get(OPERATOR_HEAD),b={domain:OPERATOR_ISSUERS,configHash:r.s.configHash,network:x.c.chainId,generation:r.s.authority.generation,managementEpoch:r.s.networkReserves.development.access.epoch,notBefore:r.s.money.time,expires:r.s.money.time+600,sequence:1,previousHash:h.certificateHash,effectiveFrom:f.plan.from,issuers:[next.publicKey]},a={type:OPERATOR_ISSUERS,certificate:{body:b,approvals:x.approvals(b)},founderConsent:sign(b,x.founder.privateKey)};
  r.step([x.wire(a)]);r.step([x.wire(a)]);r.reject(x.wire(status(f,next,n,1,{effectiveFrom:f.plan.from}),next),/source signature/);r.step([],f.plan.from);r.reopen();
  r.reject(x.wire(status(f,issuer,n,1,{effectiveFrom:f.plan.from+DAY}),issuer),/source signature/);
  const revoke=status(f,next,n,1,{effectiveFrom:f.plan.from+DAY});revoke.nodeSignature=null;r.step([x.wire(revoke,next)]);r.reopen();assert.equal(operatorFactor(get,n,f.plan.from),3);assert.equal(operatorFactor(get,n,f.plan.from+DAY),2);
 }finally{r.db.close();}
});

test('500 Linux and 10000 Home conserve all individual Home credits at target population',()=>{
 const rows=Array.from({length:10500},(_,i)=>({node:hash(['load',i]),kind:i<500?'worker':'witness',units:BigInt(1+i%77),factor:2+i%3})),pool=200000000n;
 const old=redistributeLinux(pool,rows.map(r=>({...r,factor:2}))),next=redistributeLinux(pool,rows);assert.equal([...next.values()].reduce((a,b)=>a+b,0n),pool);for(const r of rows)if(r.kind==='witness')assert.equal(next.get(r.node),old.get(r.node));
});

test('process kill in redistribution and payout resumes one exact allocation',async()=>{
 for(const target of ['ADJUST','PAY'])for(const phase of ['before','after']){
  const f=serviceFixture(1,Date.UTC(2026,10,16,12)/1000,true),{r,x}=f,issuer=keys();let closed=false;
  try{r.step([x.wire(f.activation)]);enable(f,issuer);const workers=f.ids.filter(n=>n!==f.home.node);r.step([x.wire(status(f,issuer,workers[0],2),f.key(workers[0]))]);f.work();r.step([],f.plan.to);
   const read=k=>r.db.store.proof(k,r.db.root).value;let steps=0;while(read('service-rewards/days/'+f.plan.from).phase!==target){assert(++steps<20);r.step();}
   const root=r.db.root,supply=r.s.money.supply,request={height:r.s.height+1,time:r.s.money.time,blockHash:hash(['operator crash',target,phase]),txs:[]},expected=r.db.commitBlock(request,root,{dryRun:true}).root,file=r.file+'.operator-crash.json';
   fs.writeFileSync(file,JSON.stringify({file:r.file,config:x.c,root,request,phase}));r.db.close();closed=true;
   await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('./service-crash-child.mjs',import.meta.url)),file],{windowsHide:true,stdio:['ignore','pipe','pipe']});let ready=false,out='',err='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('timeout '+err));},20000);child.stdout.on('data',b=>{out+=b;if(out.includes('READY')&&!ready){ready=true;child.kill('SIGKILL');}});child.stderr.on('data',b=>{err+=b;});child.on('error',reject);child.on('close',()=>{clearTimeout(timer);ready?resolve():reject(Error(err));});});
   const db=BoundedNetworkInterpreter.open(r.file,x.c,phase==='before'?root:expected,{isolatedIssuance:false});try{if(phase==='before')assert.equal(db.commitBlock(request,root).root,expected);assert(db.commitBlock(request,expected).value.duplicate);db.snapshotForAudit();for(let i=0;i<12;i++){const s=db.snapshotForAudit();db.commitBlock({height:s.height+1,time:s.money.time,blockHash:hash(['resume',i]),txs:[]},db.root);}const s=db.snapshotForAudit();assert.equal(s.money.supply,supply);assert.equal(s.rewards.preissuedServiceMicro,'200000000');assert.equal(s.centuryWarmup.serviceFunding.spentMicro,'200000000');}finally{db.close();}
  }finally{if(!closed)r.db.close();}
 }
});
