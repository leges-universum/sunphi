import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {issuanceFixture,certify,preparation} from './century-issuance.test.mjs';
import {subsidyCertificate} from './century-subsidy.test.mjs';
import {setup} from './payment-liability.test.mjs';
import {hash,sign,keys} from '../crypto.mjs';
import {block} from '../core.mjs';
import {applyEconomicPreparation} from '../economic-preparation.mjs';
import {ISSUE_CENTURY,START_CENTURY,applyCenturyIssuance} from '../century-issuance.mjs';
import {centuryWarmupPlan} from '../century-warmup.mjs';
import {anniversary} from '../economic-policy-v2.mjs';
import {REWARDS,walletConsent} from '../node-rewards.mjs';
import {CENTURY_ACTIONS,centuryAction} from '../research/bounded-century-context.mjs';
import {BoundedNetworkInterpreter} from '../research/bounded-network-interpreter.mjs';
import {queryBounded,verifyBoundedQuery} from '../research/bounded-query.mjs';
import {createBoundedApi} from '../research/bounded-api.mjs';
import {homeFixture} from './century-home-funds.test.mjs';
import {policyCertificate} from './century-policy.test.mjs';
import {CENTURY_POLICY_ACTIONS,CENTURY_POLICY_NOTICE} from '../century-subsidy.mjs';
import {centuryHomeBody,CENTURY_HOME_ACTION} from '../century-home.mjs';
import {CENTURY_FUNDS_ACTION,centuryFundsManifest} from '../century-funds.mjs';
export function rig(x,initial=x.s,isolatedIssuance=true,differential=true){
 const file=join(fs.mkdtempSync(join(tmpdir(),'bounded-century-')),'state.sqlite');let db=BoundedNetworkInterpreter.create(file,initial,x.c,hash(initial),{isolatedIssuance}),s=structuredClone(initial);const reads=[];
 function step(wires=[],time=s.money.time){
  const root=db.root,request={height:s.height+1,time,blockHash:hash(['bounded-century',s.height+1,time]),txs:wires.map(w=>Buffer.from(JSON.stringify(w)))};
  const special=wires.some(w=>CENTURY_ACTIONS.includes(w.body.action.type));assert(!special||wires.length===1);
  let expected;if(differential){const oracle=block(s,x.c,{...request,txs:special?[]:request.txs},false).state;
   if(oracle.rewards&&(!s.rewards||oracle.rewards.period.index!==s.rewards.period.index))oracle.rewards.period.anchor.stateHash=root;
   expected=special?centuryAction(oracle,wires[0].body.action,wires[0].body.author,x.c):oracle;}
  const scan=db.store.scanAuthenticated;db.store.scanAuthenticated=()=>{throw Error('hot path full scan');};let result;
  try{result=db.commitBlock(request,root);}finally{db.store.scanAuthenticated=scan;}
  s=db.snapshotForAudit();if(differential)assert.deepEqual(s,expected);assert.deepEqual(result.value.codes,wires.map(()=>0));reads.push(result.value.recordsRead);return {request,result};
 }
 function reject(wire,pattern){const root=db.root,request={height:s.height+1,time:s.money.time,blockHash:hash(['rejection',s.height]),txs:[Buffer.from(JSON.stringify(wire))]};assert.throws(()=>db.commitBlock(request,root),pattern);assert.equal(db.root,root);assert.deepEqual(db.snapshotForAudit(),s);}
 return {file,reads,step,reject,get s(){return s;},get db(){return db;},reopen(){const root=db.root;db.close();db=BoundedNetworkInterpreter.open(file,x.c,root,{isolatedIssuance});assert.deepEqual(db.snapshotForAudit(),s);}};
}
const issue=(x,r)=>r.step([x.wire(certify(x,r.s,ISSUE_CENTURY,{supplyBefore:r.s.money.supply}))]);
function start(x,r){r.step([x.wire(certify(x,r.s,START_CENTURY,{settings:{controllerPolicy:{maximumRiseMicroPerSecond:'1000',operationalRateMicroPerSecond:'10000'},maxPaymentMicro:'1234567',ttlBlocks:10}}))]);}
function open(x,r){r.step([x.wire(subsidyCertificate(x,r.s,{start:r.s.centuryFunds.execution.start}))]);}
function reserve(x,r){const w=r.s.centuryWarmup,b={domain:'DUEBYTE_WARMUP_CAPACITY_V2',configHash:r.s.configHash,generation:r.s.authority.generation,start:w.controller.start,from:w.controller.cursor,to:w.controller.cursor+60,observedHeight:r.s.height+1,observedAt:w.controller.cursor,sequence:w.controller.sequence+1,healthy:true,capacityRateMicroPerSecond:'1000',controllerPolicyHash:hash(w.controllerPolicy)};r.step([x.wire({type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:{body:b,approvals:x.approvals(b)}})]);const i=centuryWarmupPlan(r.s.centuryWarmup,r.s.money);assert(i);r.step([x.wire({type:'RUN_CENTURY_WARMUP_V1',sequence:b.sequence,intentHash:hash(i)})]);return i;}
test('bounded century explicit issuance gate, exact funds, restart and complete block replay',()=>{
 const x=issuanceFixture(),closed=rig(x,x.s,false);closed.reject(x.wire(certify(x,closed.s,ISSUE_CENTURY,{supplyBefore:closed.s.money.supply})),/issuance forbidden/);closed.db.close();
 const r=rig(x),before=hash(x.s),bad=certify(x,r.s,ISSUE_CENTURY,{supplyBefore:r.s.money.supply});bad.certificate.approvals.pop();r.reject(x.wire(bad));const issued=issue(x,r);
 assert.equal(BigInt(r.s.money.supply)-BigInt(x.s.money.supply),130000000000000n);assert.equal(hash(x.s),before);assert(r.db.commitBlock(issued.request,r.db.root).value.duplicate);
 r.reopen();assert.throws(()=>BoundedNetworkInterpreter.open(r.file,x.c,r.db.root),/explicit/);assert(r.reads.every(n=>n<30));r.db.close();
});
test('bounded warmup, accepted receipts, fee gap, subsidy, payout and retained programme history match legacy',()=>{
 const x=issuanceFixture(),r=rig(x);issue(x,r);start(x,r);open(x,r);const i=reserve(x,r),node=i.parts[0].nodes[0],manager=x.key(node),b={domain:REWARDS+'/BIND',configHash:r.s.configHash,node,sequence:1,payouts:[{wallet:x.f.bob.publicKey,weight:1}]};
 r.step([x.wire({type:'BIND_REWARD_WALLETS_V1',body:b,signature:sign(b,manager.privateKey),consents:[sign(walletConsent(r.s.configHash,node,x.f.bob.publicKey),x.f.bob.privateKey)]},manager)]);
 const invalid=x.finish(r.s,i);invalid.body.action.receipts[0].signature='invalid';r.reject(x.wire(invalid.body.action));r.step([x.finish(r.s,i)]);assert.equal(r.s.centuryWarmup.controller.spentMicro,i.fee);
 r.step([],r.s.centurySubsidy.pending.to);assert.equal(r.s.centurySubsidy.totalMintedMicro,'62961');assert.equal(r.s.centurySubsidy.last.externalDemandProven,false);
 const end=r.s.rewards.period.end;while(r.s.height<=end)r.step();assert.equal(r.s.rewards.nodes[node].paid,'33333');r.reopen();assert(r.reads.every(n=>n<60));
 const request={type:'economy',id:null},response=queryBounded(r.db,request,r.db.root);assert.equal(verifyBoundedQuery(response,request,r.db.root,hash(x.c)).isolatedIssuance,true);const forged=structuredClone(response);forged.result.data.supply='0';assert.throws(()=>verifyBoundedQuery(forged,request,r.db.root,hash(x.c)));r.db.close();
});
test('bounded programme timeout returns custody and cannot earn subsidy',()=>{
 const x=issuanceFixture(),r=rig(x);issue(x,r);start(x,r);open(x,r);const i=reserve(x,r);while(r.s.money.requests[i.pid].status==='RESERVED')r.step();assert.equal(r.s.centuryWarmup.controller.spentMicro,'0');r.step([],r.s.centurySubsidy.pending.to);assert.equal(r.s.centurySubsidy.totalMintedMicro,'0');assert.equal(r.s.money.supply,String(BigInt(x.s.money.supply)+130000000000000n));r.db.close();
});
test('bounded vested founder and development payouts retain fractional amounts and cancel/replay behavior',()=>{
 const x=issuanceFixture(),issued=applyCenturyIssuance(x.s,certify(x,x.s,ISSUE_CENTURY,{supplyBefore:x.s.money.supply}),x.c,x.founder.publicKey);issued.money.time=anniversary(issued.centuryFunds.execution.start,1);const r=rig(x,issued);
 const a={type:'RELEASE_CENTURY_FOUNDER_V1',manifestHash:r.s.centuryFunds.manifestHash,cumulativeMicro:'1000000000000'};r.step([x.wire(a)]);r.step([x.wire(a)]);assert.equal(r.s.centuryFunds.execution.founderReleasedMicro,'1000000000000');
 const queue=()=>({type:'QUEUE_CENTURY_DEVELOPMENT_V1',managementEpoch:r.s.networkReserves.development.access.epoch,sequence:r.s.centuryFunds.execution.sequence+1,recipient:x.f.bob.publicKey,valueMicro:'1234567',purpose:'Synthetic integration test',reference:hash('test decision')});r.reject(x.wire(queue(),keys()));r.step([x.wire(queue(),x.founder)]);
 const command=type=>({type,sequence:r.s.centuryFunds.execution.pending.sequence,instructionHash:hash(r.s.centuryFunds.execution.pending)});r.step([x.wire(command('CANCEL_CENTURY_DEVELOPMENT_V1'),x.founder)]);r.step([x.wire(queue(),x.founder)]);const pay=command('EXECUTE_CENTURY_DEVELOPMENT_V1');r.step([x.wire(pay)]);r.step([x.wire(pay)]);assert.equal(r.s.centuryFunds.execution.developmentSpentMicro,'1234567');assert.equal(r.s.money.supply,issued.money.supply);r.db.close();
});
test('bounded preparation pins previous authenticated root without enumerating money',()=>{
 const x=setup(),r=rig(x,x.s,false),root=r.db.root,action=preparation(x,x.s),request={height:x.s.height+1,time:x.s.money.time,blockHash:hash('prepare bounded'),txs:[Buffer.from(JSON.stringify(x.wire(action)))]};r.db.commitBlock(request,root);const s=r.db.snapshotForAudit();assert.equal(s.economicPreparation.plan.observedStateHash,root);assert.equal(s.economicPreparation.plan.observedHeight,x.s.height);assert.equal(s.money.supply,x.s.money.supply);r.db.close();
});
test('bounded read-only HTTP API requires a pinned current root and exposes no commands',async()=>{
 const x=issuanceFixture(),r=rig(x,x.s,false),server=createBoundedApi(r.db);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{const request={type:'economy',id:null},reply=await fetch(base+'/v1/economy/summary?root='+r.db.root);assert.equal(reply.status,200);const response=await reply.json();assert.equal(verifyBoundedQuery(response,request,r.db.root,hash(x.c)).isolatedIssuance,false);assert.equal((await fetch(base+'/v1/economy/summary')).status,400);assert.equal((await fetch(base+'/v1/economy/summary?root='+hash('stale'))).status,409);assert.equal((await fetch(base+'/v1/economy/summary',{method:'POST'})).status,405);assert.equal((await fetch(base+'/v1/issue/now?root='+r.db.root)).status,404);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));r.db.close();}
});
test('bounded Home key availability, future policy and removed keys preserve earned funds',()=>{
 const x=homeFixture(),r=rig(x),i=reserve(x,r);r.step([x.finish(r.s,i)]);
 for(const h of x.homes){const body=centuryHomeBody(r.s,h.node),a={type:CENTURY_HOME_ACTION,body,signature:sign(body,h.work.privateKey)};r.reject(x.wire(a,keys()));r.step([x.wire(a,h.work)]);r.step([x.wire(a,h.work)]);}
 const p=structuredClone(r.s.centurySubsidy.policy);p.home.nodes={};p.costPerPaymentMicro='0';p.intervalCapMicro='0';p.nodeCapMicro='0';p.groupCapMicro='0';p.home.costPerSampleMicro='0';
 const effectiveFrom=r.s.money.time+CENTURY_POLICY_NOTICE,a=policyCertificate(x,r.s,CENTURY_POLICY_ACTIONS[0],{effectiveFrom,policy:p,reason:'Measured zero tariff'});r.step([x.wire(a)]);r.reopen();r.step([],r.s.centurySubsidy.pending.to);assert(x.homes.every(h=>r.s.rewards.nodes[h.node].earned==='10000'));
 const earned=x.homes.map(h=>r.s.rewards.nodes[h.node].earned),minted=r.s.rewards.minted;r.step([],effectiveFrom);r.step([x.wire(subsidyCertificate(x,r.s,{policy:p,to:r.s.money.time+p.intervalSeconds}))]);r.step();r.step([],r.s.centurySubsidy.pending.to);assert.deepEqual(x.homes.map(h=>r.s.rewards.nodes[h.node].earned),earned);assert.equal(r.s.rewards.minted,minted);assert.equal(r.s.centurySubsidy.policyControl.revision,2);r.db.close();
});
test('bounded issuance and subsidy commit interruptions roll back all custody and earnings',()=>{
 const x=issuanceFixture(),r=rig(x),before=hash(r.s);let root=r.db.root,request={height:r.s.height+1,time:r.s.money.time,blockHash:hash('issue interruption'),txs:[Buffer.from(JSON.stringify(x.wire(certify(x,r.s,ISSUE_CENTURY,{supplyBefore:r.s.money.supply}))))]};
 assert.throws(()=>r.db.commitBlock(request,root,{beforeCommit:()=>{throw Error('storage interrupted');}}),/interrupted/);assert.equal(r.db.root,root);r.reopen();assert.equal(hash(r.s),before);issue(x,r);start(x,r);open(x,r);const i=reserve(x,r);r.step([x.finish(r.s,i)]);
 root=r.db.root;request={height:r.s.height+1,time:r.s.centurySubsidy.pending.to,blockHash:hash('subsidy interruption'),txs:[]};assert.throws(()=>r.db.commitBlock(request,root,{beforeCommit:()=>{throw Error('storage interrupted');}}),/interrupted/);assert.equal(r.db.root,root);r.reopen();assert.equal(r.s.centurySubsidy.totalMintedMicro,'0');r.step([],request.time);assert.equal(r.s.centurySubsidy.totalMintedMicro,'62961');r.step();assert.equal(r.s.centurySubsidy.totalMintedMicro,'62961');r.db.close();
});
test('bounded century controllers above one MiB touch only programme and assigned work records',()=>{
 const x=issuanceFixture(),s=structuredClone(x.s);for(let n=0;n<10000;n++)s.money.outputs[hash(['century-large',n])]={owner:x.f.bob.publicKey,value:'0',unlock:0};assert(Buffer.byteLength(JSON.stringify(s))>1048576);
 // Legacy pruning removes empty outputs; this candidate intentionally retains
 // them. Compare monetary invariants and retained history, not pruned bytes.
 const r=rig(x,s,true,false);issue(x,r);start(x,r);open(x,r);const i=reserve(x,r);r.step([x.finish(r.s,i)]);r.step([],r.s.centurySubsidy.pending.to);assert.equal(r.s.centurySubsidy.totalMintedMicro,'62961');assert.equal(BigInt(r.s.money.supply)-BigInt(s.money.supply),130000000062961n);for(const [id,o]of Object.entries(s.money.outputs))assert.deepEqual(r.s.money.outputs[id],o);assert(r.reads.every(n=>n<60));r.db.close();
});
test('bounded unissued fund preparation requires recipient consent and rejects protected-address dust',()=>{
 const x=issuanceFixture(),s=structuredClone(x.s);delete s.centuryFunds;const r=rig(x,s,false),body={domain:CENTURY_FUNDS_ACTION,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+100,manifest:centuryFundsManifest(s,x.recipient.publicKey),previousManifestHash:null},a={type:CENTURY_FUNDS_ACTION,certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey),recipientConsent:sign(body,x.recipient.privateKey)};
 r.reject(x.wire({...a,recipientConsent:sign(body,keys().privateKey)}));r.step([x.wire(a)]);assert.equal(r.s.money.supply,s.money.supply);assert(!r.s.centuryFunds.execution);
 for(const recipient of [body.manifest.development.account,body.manifest.founder.account,body.manifest.memorial.account,...body.manifest.warmup.accounts]){const i=x.intent(r.s,{epoch:1,unitScale:'1000000',recipient});r.reject(x.reserve(i));}r.db.close();
});
test('bounded default store cannot open a minting interval or import pending subsidy',()=>{
 const x=issuanceFixture(),s=applyCenturyIssuance(x.s,certify(x,x.s,ISSUE_CENTURY,{supplyBefore:x.s.money.supply}),x.c,x.founder.publicKey),r=rig(x,s,false);r.reject(x.wire(subsidyCertificate(x,s,{start:s.centuryFunds.execution.start})),/issuance forbidden/);r.db.close();
 const home=homeFixture(),file=join(fs.mkdtempSync(join(tmpdir(),'bounded-mint-gate-')),'state.sqlite');assert.throws(()=>BoundedNetworkInterpreter.create(file,home.s,home.c,hash(home.s)),/pending subsidy/);assert(!fs.existsSync(file));
});
