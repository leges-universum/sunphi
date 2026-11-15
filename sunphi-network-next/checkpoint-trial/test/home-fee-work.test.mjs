// Isolated test ledgers; no connection to live nodes or wallets.
import test from 'node:test';import assert from 'node:assert/strict';
import {hash,keys,sign} from '../crypto.mjs';
import {pilotFixture,admission as pilotAdmission} from './zero-stage-consensus.test.mjs';
import {certify} from './century-issuance.test.mjs';
import {ZERO_STAGE_TERMINAL_DEFAULTS} from '../research/zero-stage-plan.mjs';
import {ISSUE_WARMUP_TRANCHE,START_CENTURY} from '../century-issuance.mjs';
import {REGISTER_HOMES} from '../research/bounded-home-registration.mjs';
import {SCHEDULE_PAID_ADMISSION,ADMISSION_NOTICE} from '../research/bounded-paid-admission.mjs';
import {REWARDS,rewardNodeId,walletConsent} from '../node-rewards.mjs';
import {HOME_FEE_WORK,feeHomeBody} from '../home-fee-work.mjs';
import {centuryWarmupPlan,UPGRADE_WARMUP} from '../century-warmup.mjs';
import {queryBounded,verifyBoundedQuery} from '../research/bounded-query.mjs';
import {loadBoundedServiceView} from '../research/bounded-wallet-view.mjs';
import {BoundedReadLeases} from '../research/bounded-read-leases.mjs';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {WalletStore} from '../wallet-store.mjs';import {RewardWorker} from '../reward-worker.mjs';import {VerifiedClient} from '../client.mjs';
import {createBoundedApi} from '../research/bounded-api.mjs';
import {purchaseCometNetwork,until} from '../qa/helpers/purchase-comet-network.mjs';

function setup(options={}){
 const {x,r}=pilotFixture(false,true,10,{rewardPeriodSeconds:3600,...options});
 r.step([x.wire(pilotAdmission(x,r,{settings:{...ZERO_STAGE_TERMINAL_DEFAULTS}}))]);
 r.step([x.wire(certify(x,r.s,ISSUE_WARMUP_TRANCHE,{supplyBefore:r.s.money.supply,trancheMicro:'9000000000'}))]);
 r.step([x.wire(certify(x,r.s,START_CENTURY,{settings:{controllerPolicy:{maximumRiseMicroPerSecond:'1000',operationalRateMicroPerSecond:'500000',intervalSeconds:20},maxPaymentMicro:'5000000',timeBasis:x.c.obligationClock,ttlSeconds:120}}))]);
 const h={identity:keys(),work:keys(),management:keys(),wallet:keys()};h.node=rewardNodeId(hash(x.c),h.work.publicKey);
 let s=r.s,b={domain:REGISTER_HOMES,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,managementEpoch:s.networkReserves.development.access.epoch,notBefore:s.money.time,expires:s.money.time+600,homes:[{node:h.node,identity:h.identity.publicKey,work:h.work.publicKey,management:h.management.publicKey}]};
 r.step([x.wire({type:REGISTER_HOMES,certificate:{body:b,approvals:x.approvals(b)},founderConsent:sign(b,x.founder.privateKey),consents:[Object.fromEntries(['identity','work','management'].map(k=>[k,sign(b,h[k].privateKey)]))]})]);
 s=r.s;b={domain:REWARDS+'/BIND',configHash:s.configHash,node:h.node,sequence:1,payouts:[{wallet:h.wallet.publicKey,weight:1}]};
 r.step([x.wire({type:'BIND_REWARD_WALLETS_V1',body:b,signature:sign(b,h.management.privateKey),consents:[sign(walletConsent(s.configHash,h.node,h.wallet.publicKey),h.wallet.privateKey)]},h.management)]);
 s=r.s;b={domain:SCHEDULE_PAID_ADMISSION,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,managementEpoch:s.networkReserves.development.access.epoch,notBefore:s.money.time,expires:s.money.time+600,sequence:1,previousHash:null,effectiveFrom:s.money.time+ADMISSION_NOTICE,changes:[{node:h.node,enabled:true}],reason:'Fee-only test admission'};
 r.step([x.wire({type:SCHEDULE_PAID_ADMISSION,certificate:{body:b,approvals:x.approvals(b)},founderConsent:sign(b,x.founder.privateKey)})]);
 const leases=new BoundedReadLeases(r.db);return {x,r,h,leases,effective:b.effectiveFrom};
}
function response(r,h,leases){const root=r.s.rewards.period.anchor.stateHash,l=leases.acquire(root);try{const proof=leases.resolve(l.token,root).store.proof('meta/blockHead',root),body=feeHomeBody(r.s,h.node,hash(proof.value));return {type:HOME_FEE_WORK,body,proof,signature:sign(body,h.work.privateKey)};}finally{leases.release(l.token);}}
function payment(x,r){
 const s=r.s,w=s.centuryWarmup,from=s.money.time,b={domain:'DUEBYTE_WARMUP_CAPACITY_V2',configHash:s.configHash,generation:s.authority.generation,start:w.controller.start,from,to:from+w.controllerPolicy.intervalSeconds,observedHeight:s.height+1,observedAt:from,sequence:w.controller.sequence+1,healthy:true,capacityRateMicroPerSecond:'1000',controllerPolicyHash:hash(w.controllerPolicy)};
 r.step([x.wire({type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:{body:b,approvals:x.approvals(b)}})]);
 const i=centuryWarmupPlan(r.s.centuryWarmup,r.s.money);assert(i);r.step([x.wire({type:'RUN_CENTURY_WARMUP_V1',sequence:b.sequence,intentHash:hash(i)})]);r.step([x.finish(r.s,i)]);return i;
}

test('fee Home: actual settlement, proof, unchanged coefficients, exact-once payout and crash recovery',async()=>{
 const {x,r,h,leases,effective}=setup();try{
  const supply=r.s.money.supply,coefficients=structuredClone(r.s.rewards.coefficients);
  assert(!r.s.rewards.period.assigned.includes(h.node));r.step([],effective);assert(r.s.rewards.period.assigned.includes(h.node));
  const a=response(r,h,leases),request={type:'block-head',id:null},root=r.s.rewards.period.anchor.stateHash,l=leases.acquire(root);
  assert.equal(verifyBoundedQuery(queryBounded(leases.resolve(l.token,root),request,root),request,root,hash(x.c)).data.height,r.s.rewards.period.anchor.height);leases.release(l.token);leases.close();
  const v=await loadBoundedServiceView((q,at)=>queryBounded(r.db,q,at),{root:r.db.root,height:r.s.height,configHash:hash(x.c),rewardIds:[h.node]});assert.deepEqual(feeHomeBody(v.state,h.node,a.body.valueHash),a.body);
  const before=r.db.root,crash={height:r.s.height+1,time:r.s.money.time,blockHash:hash('Home response crash'),txs:[Buffer.from(JSON.stringify(x.wire(a,h.work)))]};
  assert.throws(()=>r.db.commitBlock(crash,before,{beforeCommit:()=>{throw Error('injected crash');}}),/injected/);r.reopen();assert.equal(r.db.root,before);assert(!r.s.rewards.period.witnesses.includes(h.node));
  r.step([x.wire(a,h.work)]);r.step([x.wire(a,h.work)]);assert.equal(r.s.rewards.nodes[h.node].witnessJobs,'1000000');
  payment(x,r);const period=structuredClone(r.s.rewards.period),end=period.end;assert(BigInt(period.fees)>0n);
  const weights=Object.values(period.work).reduce((n,w)=>n+BigInt(w.worker)*BigInt(coefficients.workerWeight)+BigInt(w.witness)*BigInt(coefficients.witnessWeight),0n),expected=BigInt(period.fees)*1000000n*BigInt(coefficients.witnessWeight)/weights;
  const payoutRoot=r.db.root,payout={height:r.s.height+1,time:end,blockHash:hash('Home payout crash'),txs:[]};
  assert.throws(()=>r.db.commitBlock(payout,payoutRoot,{beforeCommit:()=>{throw Error('injected payout crash');}}),/injected/);r.reopen();assert.equal(r.db.root,payoutRoot);assert.equal(r.s.rewards.nodes[h.node].paid,'0');
  const committed=r.step([],end);assert(r.db.commitBlock(committed.request,r.db.root).value.duplicate);r.reopen();assert(expected>0n);assert.equal(r.s.rewards.nodes[h.node].paid,String(expected));
  assert.equal(Object.values(r.s.money.outputs).filter(o=>o.owner===h.wallet.publicKey).reduce((n,o)=>n+BigInt(o.value),0n),expected);
  assert.equal(r.s.money.supply,supply);assert.equal(r.s.rewards.minted,'0');assert.deepEqual(r.s.rewards.coefficients,coefficients);assert(!r.s.centurySubsidy);
 }finally{leases.close();r.db.close();}
});
test('fee Home: wrong author, altered proof, expired work and cross-period replay cannot earn',()=>{
 const {x,r,h,leases,effective}=setup();try{
  r.step([],effective);const a=response(r,h,leases);r.reject(x.wire(a,keys()));const bad=structuredClone(a);bad.proof.value.height++;r.reject(x.wire(bad,h.work));
  r.step([],r.s.money.time+181);r.reject(x.wire(a,h.work),/expired/);r.step([],r.s.rewards.period.end);r.reject(x.wire(a,h.work),/challenge/);assert.equal(r.s.rewards.nodes[h.node].earned,'0');assert.equal(r.s.rewards.nodes[h.node].witnessJobs,'0');
  const accepted=response(r,h,leases);r.step([x.wire(accepted,h.work)]);r.step([],r.s.rewards.period.end);assert.equal(r.s.rewards.nodes[h.node].earned,'0');assert.equal(r.s.rewards.nodes[h.node].paid,'0');
 }finally{leases.close();r.db.close();}
});

test('fee Home: real HTTP proof route, durable retry after restart and bounded outbox cleanup',async()=>{
 const {x,r,h,leases,effective}=setup(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-home-client-'));let api,store;
 try{
  leases.close();let clock=0;api=createBoundedApi(r.db,{clock:()=>clock});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+api.address().port;
  r.step([],effective);for(let i=0;i<12;i++){clock+=4000;r.step();}
  const proof=await VerifiedClient.prototype.homeRecordProof.call({bounded:{url},config:x.c},r.s.rewards.period.anchor.stateHash,'meta/blockHead');assert.equal(proof.value.height,r.s.rewards.period.anchor.height);
  fs.writeFileSync(path.join(dir,'reward-identity.json'),JSON.stringify({version:1,network:x.c.chainId,configHash:hash(x.c),work:h.work,management:h.management}));const home=path.join(dir,'wallet');store=new WalletStore(home,x.c.chainId);
  const view=async()=>({...await loadBoundedServiceView((q,root)=>queryBounded(r.db,q,root),{root:r.db.root,height:r.s.height,configHash:hash(x.c),rewardIds:[h.node]}),certificate:{appHash:r.db.root,appHeight:r.s.height}});
  let lost=true,sends=0;const options={home,config:x.c,store,url:'isolated',recordProofReader:async()=>proof,broadcast:async wire=>{sends++;if(lost){lost=false;throw Error('connection lost');}r.step([wire]);}};
  await assert.rejects(async()=>new RewardWorker(options).tick(await view()),/connection lost/);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM reward_outbox').get().n,1);
  api.closeAllConnections();await new Promise(resolve=>api.close(resolve));api=null;store.close();r.reopen();store=new WalletStore(home,x.c.chainId);
  await new RewardWorker({...options,store,recordProofReader:async()=>{throw Error('saved proof must be reused');}}).tick(await view());assert.equal(sends,2);
  await new RewardWorker({...options,store}).tick(await view());assert.equal(store.db.prepare('SELECT COUNT(*) n FROM reward_outbox').get().n,0);assert.equal(r.s.rewards.nodes[h.node].witnessJobs,'1000000');
  const id='fee-home:'+r.s.rewards.period.index;store.db.prepare('INSERT INTO reward_outbox VALUES(?,?)').run(id,'{}');r.step([],r.s.rewards.period.end);r.step([],r.s.money.time+181);await new RewardWorker({...options,store}).tick(await view());assert.equal(store.db.prepare('SELECT COUNT(*) n FROM reward_outbox').get().n,0);
 }finally{if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}store?.close();leases.close();r.db.close();}
});

test('fee Home real Comet: fee payout, lost response, validator restart and independent replay', {skip:!process.env.DUEBYTE_HOME_FEE_COMET,timeout:600000},async()=>{
 const out=path.resolve(process.env.DUEBYTE_HOME_FEE_COMET);assert(out.startsWith(path.resolve('F:/DueByteWork/home75-comet-'))&&!fs.existsSync(out));
 const now=Math.floor(Date.now()/1000),periodSeconds=180;
 const {x,r,h,leases,effective}=setup({rewardPeriodSeconds:periodSeconds,startTime:now-2*86400-20-periodSeconds,validatorPowers:[10,10,10,10]});
 leases.close();const before=r.s,upgrade={domain:UPGRADE_WARMUP,network:x.c.chainId,configHash:before.configHash,generation:before.authority.generation,notBefore:before.height,expires:before.height+100,planHash:before.centuryWarmup.planHash,previousBookHash:hash(before.centuryWarmup),managementEpoch:before.networkReserves.development.access.epoch,intervalSeconds:60};r.step([x.wire({type:UPGRADE_WARMUP,certificate:{body:upgrade,approvals:x.approvals(upgrade)},founderConsent:sign(upgrade,x.founder.privateKey)})]);
 r.step([],effective);r.step([],r.s.rewards.period.end-10);const source=r.s,snapshot={file:r.file,root:r.db.root};r.db.close();
 let net,api;const checks=[];
 try{
  net=await purchaseCometNetwork(out,{...x.f,c:x.c,validators:x.validators},{labSourceState:source,labRecordSnapshot:snapshot,rpcTimeoutMs:30000,bridgeBinary:'F:/DueByteWork/storage72-bridge-r6/duebyte-abci.exe',basePort:38000,onApplication:async(app,i)=>{if(!i){api=createBoundedApi(app.handler);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));}}});
  const submit=wire=>net.submit(Buffer.from(JSON.stringify(wire)));await until(()=>assert(net.state().rewards.period.index>source.rewards.period.index));
  const s=net.state(),url='http://127.0.0.1:'+api.address().port,proof=await VerifiedClient.prototype.homeRecordProof.call({bounded:{url},config:x.c},s.rewards.period.anchor.stateHash,'meta/blockHead'),body=feeHomeBody(s,h.node,hash(proof.value)),action={type:HOME_FEE_WORK,body,proof,signature:sign(body,h.work.privateKey)};
  await submit(x.wire(action,h.work));assert.equal(net.state().rewards.nodes[h.node].witnessJobs,'1000000');checks.push('authenticated HTTP record proof committed');
  await assert.rejects(submit(x.wire(action,h.work)),/already exists in cache/);
  api.closeAllConnections();await new Promise(resolve=>api.close(resolve));api=null;await net.restart(0);await until(()=>net.rpc(0,'status'));
  await submit(x.wire(action,h.work));assert.equal(net.state().rewards.nodes[h.node].witnessJobs,'1000000');checks.push('replayed signed response after validator restart did not earn twice');
  const current=net.state(),w=current.centuryWarmup,from=current.money.time,b={domain:'DUEBYTE_WARMUP_CAPACITY_V2',configHash:current.configHash,generation:current.authority.generation,start:w.controller.start,from,to:from+60,observedHeight:current.height,observedAt:from,sequence:w.controller.sequence+1,healthy:true,capacityRateMicroPerSecond:'1000',controllerPolicyHash:hash(w.controllerPolicy)};
  await submit(x.wire({type:'CERTIFY_CENTURY_WARMUP_INTERVAL_V1',certificate:{body:b,approvals:x.approvals(b)}}));const intent=centuryWarmupPlan(net.state().centuryWarmup,net.state().money);assert(intent);
  await submit(x.wire({type:'RUN_CENTURY_WARMUP_V1',sequence:b.sequence,intentHash:hash(intent)}));await submit(x.finish(net.state(),intent));assert.equal(net.state().money.requests[intent.pid].status,'SETTLED');checks.push('payment settled with existing Linux worker receipts');
  await net.restartAll();checks.push('all four Comet processes and SQLite applications restarted');
  await until(()=>assert(BigInt(net.state().rewards.nodes[h.node].paid)>0n),240000);const paid=net.state().rewards.nodes[h.node].paid;
  assert.equal(Object.values(net.state().money.outputs).filter(o=>o.owner===h.wallet.publicKey).reduce((n,o)=>n+BigInt(o.value),0n),BigInt(paid));assert.equal(net.state().money.supply,source.money.supply);assert.equal(net.state().rewards.minted,'0');checks.push('Home fee reward credited exactly to bound wallet without issuance');
  const replay=await net.replay();checks.push('independent replay matched all committed roots');
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({passed:true,isolated:true,validators:4,periodSeconds,productionPeriodSeconds:3600,fees:intent.fee,paidHomeMicro:paid,supply:source.money.supply,replay,checks,limits:['Synthetic signed admission was scheduled before laboratory genesis; production 24-hour notice is unchanged','Trusted local root adapter for setup; HTTP record proofs verified; production VerifiedClient trust bootstrap is a separate qualification']},null,2));
 }finally{if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}if(net)await net.close();}
});
