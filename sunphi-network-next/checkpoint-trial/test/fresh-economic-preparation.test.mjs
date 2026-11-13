import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash,keys,sign} from '../crypto.mjs';
import {envelope} from '../core.mjs';
import {cleanConfig,createFreshChain,openFreshChain} from '../research/fresh-chain-preparation.mjs';
import {RESERVES,reserveConsent,unrestrictedDevelopmentControls} from '../network-reserves.mjs';
import {makeEconomicPlanV4,economicTermsHash,ECONOMIC_POLICY_VERSION_V4} from '../economic-policy-v3.mjs';
import {prepareCleanCustody} from '../research/bounded-custody-preparation.mjs';
import {PREPARE_WORKERS,WORKERS_DOMAIN,paymentWorkerId,prepareInitialWorkers} from '../research/bounded-worker-preparation.mjs';
import {REWARDS,walletConsent} from '../node-rewards.mjs';
import {UTC_REWARDS} from '../economic-clock.mjs';
import {prepareInitialPrecision} from '../research/bounded-initial-precision.mjs';

test('clean indexed chain prepares V4 custody without minting; rejects forged approvals and legacy issuance',t=>{
 const dir=fs.mkdtempSync(join(tmpdir(),'duebyte-fresh-economy-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const validators=Array.from({length:10},keys),members=Array.from({length:4},keys),founder=keys(),backups=Array.from({length:3},keys);
 const config=cleanConfig({chainId:'duebyte-trial-fresh-economic-qualification',previousChainId:'old-lab',time:1794000000,control:{validators:validators.map((k,i)=>({key:k.publicKey,group:hash(['control-seat',i])})),policy:{version:1,members:members.map((k,i)=>({key:k.publicKey,group:hash(i)})),threshold:3,maxAge:3600,notAfter:1794086400}}});
 const file=join(dir,'state.sqlite'),initial=createFreshChain(file,config),manifest=initial.manifest;initial.handler.close();
 let app=openFreshChain(file,config,manifest,hash(manifest),manifest.root),height=0;
 const approvals=body=>validators.slice(0,7).map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)}));
 const step=actions=>{const next=height+1;app.finalize({height:next,blockHash:hash(['block',next]),time:config.initial.time+next*10,txs:actions.map(a=>Buffer.from(JSON.stringify(envelope(config,a,validators[0]))))});app.commit();height=next;return app.handler.snapshotForAudit();};
 const refused=action=>{const root=app.root;assert.throws(()=>step([action]));assert.equal(app.root,root);assert.equal(app.handler.snapshotForAudit().money.supply,'0');};
 try{
  // V1 only initializes custody. Its historical allocation fields are never
  // issued; V4 below replaces the applicable economic terms and disables V1 mint.
  const policy={warmup:{allocation:'100000000',dailyFeeBudget:'1',maxPayment:'1',intervalSeconds:60,ttlBlocks:10},development:{allocation:'1000000000',manager:founder.publicKey,controls:unrestrictedDevelopmentControls(),recovery:{keys:backups.map(k=>k.publicKey).sort(),threshold:2,delaySeconds:86400}}};
  const body={domain:RESERVES+'/PREPARE_NETWORK_RESERVES_V1',network:config.chainId,configHash:hash(config),generation:0,notBefore:1,expires:20,policy},consent=reserveConsent(hash(config),policy);
  const custody={type:'PREPARE_NETWORK_RESERVES_V1',certificate:{body,approvals:approvals(body)},founderConsent:sign(consent,founder.privateKey),recoveryConsents:backups.map(k=>({key:k.publicKey,signature:sign(consent,k.privateKey)})).sort((a,b)=>a.key<b.key?-1:1)};
  const wrong=structuredClone(custody);wrong.recoveryConsents[0].signature=sign(consent,validators[0].privateKey);refused(wrong);
  for(const kind of ['minority','duplicate','founder','foreign']){
   const bad=structuredClone(custody);
   if(kind==='minority')bad.certificate.approvals.pop();
   if(kind==='duplicate')bad.certificate.approvals[6]=bad.certificate.approvals[0];
   if(kind==='founder')bad.founderConsent=sign(consent,validators[0].privateKey);
   if(kind==='foreign')bad.certificate.body.configHash=hash('old-chain');
   refused(bad);
  }
  const pristine=app.handler.snapshotForAudit(),anchor={height:0,archive:null,issuance:false};
  for(const guard of [{anchor:{...anchor,issuance:true},workerCount:0},{anchor:{...anchor,height:1},workerCount:0},{anchor:{...anchor,archive:{}},workerCount:0},{anchor,workerCount:1}])assert.throws(()=>prepareCleanCustody(pristine,custody,validators[0].publicKey,config,guard));
  assert.throws(()=>prepareCleanCustody({...pristine,money:{...pristine.money,supply:'1'}},custody,validators[0].publicKey,config,{anchor,workerCount:0}));
  let s=step([custody]);assert.equal(s.networkReserves.issued,null);assert.equal(s.money.supply,'0');
  refused(custody);
  const plan=makeEconomicPlanV4(s),b={domain:'DUEBYTE_ECONOMIC_PREPARATION_V4',network:config.chainId,configHash:hash(config),generation:0,notBefore:2,expires:20,version:ECONOMIC_POLICY_VERSION_V4,supplyBefore:'0',unitScale:'1',previousPlanHash:null,termsHash:economicTermsHash(plan),memorialManager:founder.publicKey};
  const prepare={type:'PREPARE_ECONOMY_V4',certificate:{body:b,approvals:approvals(b)},founderConsent:sign(b,founder.privateKey)};
  const minority=structuredClone(prepare);minority.certificate.approvals.pop();refused(minority);
  s=step([prepare]);const saved=structuredClone(s.economicPreparation);
  assert.equal(saved.plan.capMicro,'10010000000000000');assert.equal(saved.plan.memorialMicro,'10000000000000');assert.equal(saved.plan.warmupMicro,'10000000000000');assert.equal(saved.plan.developmentMicro,'100000000000000');
  assert.equal(saved.plan.issuanceEnabled,false);assert.equal(saved.plan.emissionStart,null);assert.equal(saved.memorial.issued,false);
  const root=app.root;app.close();app=openFreshChain(file,config,manifest,hash(manifest),root);
  s=step([prepare]);assert.deepEqual(s.economicPreparation,saved);assert.equal(s.money.supply,'0');assert.equal(s.money.fees,'0');assert.deepEqual(s.money.outputs,{});
  refused({type:'ISSUE_NETWORK_RESERVES_V1'});
  assert.equal(s.networkReserves.warmup.mode,'PAUSED');assert.equal(s.networkReserves.development.mode,'PAUSED');
  const workKeys=Array.from({length:10},keys),owner=hash('one-founder-owned-company');
  const roster=workKeys.map(k=>({node:paymentWorkerId(hash(config),k.publicKey),key:k.publicKey,operator:owner})).sort((a,b)=>a.node<b.node?-1:1);
  const wb={domain:WORKERS_DOMAIN,network:config.chainId,configHash:hash(config),generation:0,notBefore:s.money.time,expires:s.money.time+600,workers:roster};
  const actionFor=body=>({type:PREPARE_WORKERS,certificate:{body,approvals:approvals(body)},consents:body.workers.map(w=>({node:w.node,signature:sign(body,workKeys.find(k=>k.publicKey===w.key)?.privateKey??validators[0].privateKey)}))});
  const workers=actionFor(wb);
  for(const kind of ['minority','duplicate-approval','possession','foreign','future','expired','duplicate-worker','order','validator-key','manager-key','inflated-stake']){
   const b=structuredClone(wb);
   if(kind==='foreign')b.network='foreign-chain';
   if(kind==='future'){b.notBefore=s.money.time+100;b.expires=b.notBefore+100;}
   if(kind==='expired'){b.notBefore=s.money.time-100;b.expires=s.money.time;}
   if(kind==='duplicate-worker')b.workers[1]=b.workers[0];
   if(kind==='order')b.workers.reverse();
   if(['validator-key','manager-key'].includes(kind)){b.workers[0].key=kind==='validator-key'?validators[0].publicKey:founder.publicKey;b.workers[0].node=paymentWorkerId(hash(config),b.workers[0].key);b.workers.sort((a,b)=>a.node<b.node?-1:1);}
   if(kind==='inflated-stake')b.workers[0].stake='1';
   const bad=actionFor(b);
   if(kind==='minority')bad.certificate.approvals.pop();
   if(kind==='duplicate-approval')bad.certificate.approvals[6]=bad.certificate.approvals[0];
   if(kind==='possession')bad.consents[0].signature=sign(wb,founder.privateKey);
   refused(bad);assert.deepEqual(app.handler.snapshotForAudit().money.nodes,{});
  }
  const beforeWorkers=structuredClone(s);
  for(const change of [{rewards:{}},{centuryFees:{}},{centuryFunds:{}},{money:{...s.money,supply:'1'}}])assert.throws(()=>prepareInitialWorkers({...structuredClone(s),...change},workers,config,{anchor}));
  const maximum=Array.from({length:64},keys),largeBody={...wb,workers:maximum.map(k=>({node:paymentWorkerId(hash(config),k.publicKey),key:k.publicKey,operator:owner})).sort((a,b)=>a.node<b.node?-1:1)};
  const large={type:PREPARE_WORKERS,certificate:{body:largeBody,approvals:approvals(largeBody)},consents:largeBody.workers.map(w=>({node:w.node,signature:sign(largeBody,maximum.find(k=>k.publicKey===w.key).privateKey)}))};
  const bounded=prepareInitialWorkers(structuredClone(s),large,config,{anchor});assert.equal(bounded.workerIds.length,64);assert.equal(bounded.state.money.supply,'0');
  assert(Buffer.byteLength(JSON.stringify(envelope(config,large,validators[0])))<65536,'maximum roster fits transaction bound');
  const oversized=structuredClone(large);oversized.certificate.body.workers.push(largeBody.workers[0]);oversized.certificate.approvals=approvals(oversized.certificate.body);oversized.consents.push(large.consents[0]);refused(oversized);
  const batchConflict=structuredClone(wb);batchConflict.workers[0].operator=hash('conflicting-second-frame');
  const batchRoot=app.root;assert.throws(()=>step([workers,actionFor(batchConflict)]));assert.equal(app.root,batchRoot);assert.deepEqual(app.handler.snapshotForAudit().money.nodes,{});
  s=step([workers,workers]);assert.equal(Object.keys(s.money.nodes).length,10);
  assert.equal(new Set(Object.values(s.money.nodes).map(n=>n.operator)).size,1);
  assert(Object.values(s.money.nodes).every(n=>['stake','consensusHeld','taskHeld','tier'].every(f=>n[f]==='0')));
  assert.equal(s.money.supply,'0');assert.equal(s.money.fees,'0');assert.deepEqual(s.money.outputs,beforeWorkers.money.outputs);assert.deepEqual(s.economicPreparation,saved);
  const enrolled=structuredClone(s.money.nodes),workerRoot=app.root;app.close();app=openFreshChain(file,config,manifest,hash(manifest),workerRoot);
  s=step([workers]);assert.deepEqual(s.money.nodes,enrolled);
  const changed=structuredClone(wb);changed.workers[0].operator=hash('invented-owner');refused(actionFor(changed));
  assert.deepEqual(app.handler.snapshotForAudit().money.nodes,enrolled);
  // Register additional signed batches: 64 limits one wire, not the population.
  const commit=app.handler.commitBlock.bind(app.handler);let tracked=null;
  app.handler.commitBlock=(request,pin,options={})=>commit(request,pin,{...options,observeRead:(k,v)=>{tracked?.add(k);options.observeRead?.(k,v);}});
  let largestBatchReads=0;
  for(let batch=0;batch<3;batch++){
   const extra=Array.from({length:64},keys);workKeys.push(...extra);
   const body={...wb,notBefore:s.money.time,expires:s.money.time+600,workers:extra.map(k=>({node:paymentWorkerId(hash(config),k.publicKey),key:k.publicKey,operator:owner})).sort((a,b)=>a.node<b.node?-1:1)},action=actionFor(body);
   if(batch===0){const pin=app.root,request={height:height+1,time:config.initial.time+(height+1)*10,blockHash:hash('interrupted registration'),txs:[Buffer.from(JSON.stringify(envelope(config,action,validators[0])))]};assert.throws(()=>app.handler.commitBlock(request,pin,{beforeCommit:()=>{throw Error('registration interrupted');}}),/registration interrupted/);assert.equal(app.root,pin);assert.deepEqual(app.handler.snapshotForAudit(),s);}
   tracked=new Set();s=step([action]);const readNodes=[...tracked].filter(k=>k.startsWith('nodes/'));largestBatchReads=Math.max(largestBatchReads,readNodes.length);
   assert.equal(readNodes.length,64);assert(readNodes.every(k=>body.workers.some(w=>k==='nodes/'+w.node)),'registration reads only its batch');
   assert.equal(Object.keys(s.money.nodes).length,10+(batch+1)*64);for(const [id,node]of Object.entries(enrolled))assert.deepEqual(s.money.nodes[id],node);
   const nodes=structuredClone(s.money.nodes);s=step([action]);assert.deepEqual(s.money.nodes,nodes,'batch replay is idempotent');
  }
  tracked=null;
  // A mixed replay/new batch must reject every write when an existing row conflicts.
  const mixedKey=keys();workKeys.push(mixedKey);const mixedBody={...wb,notBefore:s.money.time,expires:s.money.time+600,workers:[roster[0],{node:paymentWorkerId(hash(config),mixedKey.publicKey),key:mixedKey.publicKey,operator:owner}].sort((a,b)=>a.node<b.node?-1:1)};
  const mixedConflict=structuredClone(mixedBody);mixedConflict.workers.find(w=>w.node===roster[0].node).operator=hash('forged-owner');refused(actionFor(mixedConflict));
  assert.equal(Object.keys(app.handler.snapshotForAudit().money.nodes).length,202);
  s=step([actionFor(mixedBody)]);assert.equal(Object.keys(s.money.nodes).length,203);
  // Complete the zero-funded registration path, including fractional accounting
  // and fee-only payout records. No fund or subsidy issuance is enabled.
  s=app.handler.snapshotForAudit();
  const precisionBody={domain:'PREPARE_INITIAL_PRECISION_V1',network:config.chainId,configHash:hash(config),generation:0,notBefore:height+1,expires:height+80,decimals:6,supplyBefore:'0',planHash:s.economicPreparation.planHash};
  const precision={type:'PREPARE_INITIAL_PRECISION_V1',certificate:{body:precisionBody,approvals:approvals(precisionBody)},founderConsent:sign(precisionBody,founder.privateKey)};
  for(const mutate of [a=>a.certificate.approvals.pop(),a=>a.founderConsent=sign(a.certificate.body,validators[0].privateKey),a=>a.certificate.body.configHash=hash('foreign'),a=>a.certificate.body.decimals=8]){const bad=structuredClone(precision);mutate(bad);refused(bad);}
  const precisionState={...s,height:height+1},precisionGuard={anchor,nonzeroWorkers:0,active:{},paymentEvents:0};
  for(const patch of [{anchor:{...anchor,issuance:true}},{anchor:{...anchor,archive:{}}},{anchor:{...anchor,height:1}},{active:{unfinished:{}}},{paymentEvents:1},{nonzeroWorkers:1},{nonzeroWorkers:-1},{nonzeroWorkers:undefined}])assert.throws(()=>prepareInitialPrecision(precisionState,precision,config,{...precisionGuard,...patch}));
  for(const patch of [{height:precisionBody.expires+1},{money:{...s.money,supply:'1'}},{money:{...s.money,fees:'1'}},{money:{...s.money,unitScale:'1000000'}},{rewards:{}},{centurySubsidy:{}},{workerFunding:{}}])assert.throws(()=>prepareInitialPrecision({...precisionState,...patch},precision,config,precisionGuard));
  const funded=structuredClone(precisionState);funded.money.nodes[roster[0].node].stake='1';assert.throws(()=>prepareInitialPrecision(funded,precision,config,{...precisionGuard,nonzeroWorkers:1}));
  const policyBefore=hash(s.networkReserves.policy),memorialBefore=hash(s.economicPreparation.memorial),epochBefore=s.money.epoch;
  const allWorkers=structuredClone(s.money.nodes);tracked=new Set();s=step([precision]);assert.equal(s.money.unitScale,'1000000');assert(![...tracked].some(k=>k.startsWith('nodes/')),'precision does not scan workers');assert(tracked.has('workers/nonzero'));tracked=null;assert.deepEqual(s.money.nodes,allWorkers);refused(precision);
  assert.equal(hash(s.networkReserves.policy),policyBefore);assert.equal(hash(s.economicPreparation.memorial),memorialBefore);assert.equal(s.money.epoch,epochBefore+1);
  const feeBody={domain:'ENABLE_CENTURY_FEES_V1',network:config.chainId,configHash:hash(config),generation:0,notBefore:height+1,expires:height+80,planHash:s.economicPreparation.planHash,activation:s.money.time+60,timeBasis:UTC_REWARDS,periodSeconds:3600};
  const fees={type:'ENABLE_CENTURY_FEES_V1',certificate:{body:feeBody,approvals:approvals(feeBody)},founderConsent:sign(feeBody,founder.privateKey)};
  const forgedFees=structuredClone(fees);forgedFees.certificate.approvals.pop();refused(forgedFees);
  s=step([fees]);while(!s.rewards)s=step([]);
  const submitBy=(action,key)=>{const next=height+1;app.finalize({height:next,blockHash:hash(['block',next]),time:config.initial.time+next*10,txs:[Buffer.from(JSON.stringify(envelope(config,action,key)))]});app.commit();height=next;return app.handler.snapshotForAudit();};
  const recipient=keys();
  for(const worker of roster){
   const key=workKeys.find(k=>k.publicKey===worker.key),management=keys();
   const mb={domain:REWARDS+'/MANAGEMENT',configHash:hash(config),node:worker.node,sequence:1,management:management.publicKey};
   s=submitBy({type:'SET_REWARD_MANAGEMENT_V1',body:mb,signature:sign(mb,key.privateKey),newSignature:sign(mb,management.privateKey)},key);
   const bb={domain:REWARDS+'/BIND',configHash:hash(config),node:worker.node,sequence:2,payouts:[{wallet:recipient.publicKey,weight:1}]};
   const binding={type:'BIND_REWARD_WALLETS_V1',body:bb,signature:sign(bb,management.privateKey),consents:[sign(walletConsent(hash(config),worker.node,recipient.publicKey),recipient.privateKey)]};
   const wrong=structuredClone(binding);wrong.consents[0]=sign(walletConsent(hash(config),worker.node,recipient.publicKey),key.privateKey);
   const before=app.root;assert.throws(()=>submitBy(wrong,management));assert.equal(app.root,before);
   assert.throws(()=>submitBy(binding,key));assert.equal(app.root,before);
   s=submitBy(binding,management);const record=structuredClone(s.rewards.nodes[worker.node]);s=submitBy(binding,management);assert.deepEqual(s.rewards.nodes[worker.node],record);
   const conflict=structuredClone(binding);conflict.body.payouts[0].weight=2;conflict.signature=sign(conflict.body,management.privateKey);assert.throws(()=>submitBy(conflict,management));
  }
  const finalRoot=app.root;app.close();app=openFreshChain(file,config,manifest,hash(manifest),finalRoot);s=step([]);
  assert.equal(Object.keys(s.rewards.nodes).length,203);assert(roster.every(w=>s.rewards.nodes[w.node].sequence===2&&s.rewards.nodes[w.node].payouts[0].wallet===recipient.publicKey));assert(Object.values(s.rewards.nodes).every(n=>n.earned==='0'&&n.paid==='0'));
  t.diagnostic(JSON.stringify({initialWorkers:203,maxWorkerReadsPerRegistration:largestBatchReads,precisionWorkerReads:0,boundRecipients:10,issuance:false}));
  assert.equal(s.money.supply,'0');assert.equal(s.money.fees,'0');assert.equal(s.rewards.minted,'0');assert(!s.networkReserves.issued&&!s.centurySubsidy&&!s.centuryFunds&&!s.centuryWarmup);assert.equal(s.economicPreparation.plan.emissionStart,null);
 }finally{app.close();}
});
