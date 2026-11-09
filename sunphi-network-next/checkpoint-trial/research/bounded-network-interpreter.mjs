// Protocol candidate: sparse blocks, a versioned indexed root and retained journal.
// No production routing. New issuance requires an explicit isolated test store.
import assert from 'node:assert/strict';
import {paymentClock} from '../obligation-clock.mjs';
import {AuthenticatedRecordStore} from './authenticated-record-store.mjs';
import {IndexedMoneyInterpreter} from './indexed-money-interpreter.mjs';
import {auditState,validateConfig,immutableConfig,parseTx,PROFILE} from '../core.mjs';
import {hash,canonical,integer,hex,exact,verify} from '../crypto.mjs';
import {amount,policy,scheduled,executePaymentAction,executeScheduledRelease} from '../payment-model.mjs';
import {activate,applyControl,delayedPaymentsEnabled,resourceLimitsEnabled} from '../authority.mjs';
import {checkResourceAdmission} from '../resource-limits.mjs';
import {checkReservedPayment} from '../network-reserves.mjs';
import {prepareCleanCustody} from './bounded-custody-preparation.mjs';
import {PREPARE_WORKERS,prepareInitialWorkers} from './bounded-worker-preparation.mjs';
import {FUND_WORKER,fundWorker,COLLATERAL_ACTIONS,releaseWorkerCollateral} from '../worker-collateral.mjs';
import {NODE_LINK_ACTION,applyNodeLink} from '../node-wallet-link.mjs';
import {nodeLinkBlockers} from '../node-link-state.mjs';
import {LIABILITY_ACTIONS,executeLiabilityAction,executeLiabilityAdvance,checkLiabilityReceipt,stagePaymentFault,validatePaymentFault} from '../payment-liability.mjs';
import {reconcileProtection} from '../protection-reserve.mjs';
import {RECOVERY_ACTIONS,applyRecovery} from '../reserve-recovery.mjs';
import {PROTECTION_ACTIONS,applySpendPolicy,advanceSpendPolicies,checkApproval,spendPolicy,protectionEnabled} from '../spend-protection.mjs';
import {REWARD_ACTIONS,applyRewardAction,beginRewards,recordRewardSettlements} from '../node-rewards.mjs';
import {emptySeed,addSettlement,rewardContext,feeOnly} from './bounded-reward-context.mjs';
import {withControllerContext} from '../controller-context.mjs';
import {guardPreparedEconomy} from '../economic-preparation.mjs';
import {recordCenturyWarmupSettlement} from '../century-warmup.mjs';
import {CENTURY_ACTIONS,parseBoundedTx,centuryAction,issuedTotal,auditControllers,custodyIndex,executionContext,updateCustody,guardCustodyRequest} from './bounded-century-context.mjs';
import {createWalletIndex,indexWalletChanges,auditWalletIndex} from './bounded-wallet-index.mjs';
import {BOUNDED_DOMAIN} from './bounded-schema.mjs';
export {BOUNDED_DOMAIN} from './bounded-schema.mjs';
const DOMAIN=BOUNDED_DOMAIN,sections=new Set(['meta/money','meta/network','meta/economics']);
class StorageReadError extends Error {}
const ownerKey=owner=>'owners/'+hash(owner),active=r=>['RESERVED','SCHEDULED'].includes(r.status)?{status:r.status,deadline:r.intent.deadline,...(r.intent.timeBasis?{timeBasis:r.intent.timeBasis}:{}),executeAt:r.executeAt??0}:null;
function section(tx,key){const v=tx.get(key);assert(v,'missing section');if(v.kind==='json'){exact(v,['kind','value']);return v.value;}exact(v,['kind','count','digest']);assert.equal(v.kind,'chunks');integer(v.count,1);assert(v.count<=128);const parts=[];for(let i=0;i<v.count;i++){const part=tx.get(key+'/chunk/'+i);exact(part,['data']);const bytes=Buffer.from(part.data,'base64');assert.equal(bytes.toString('base64'),part.data);assert(bytes.length<=24000);parts.push(bytes);}const value=JSON.parse(Buffer.concat(parts).toString());assert.equal(hash(value),v.digest);return value;}
function putSection(tx,key,value){const old=tx.get(key),bytes=Buffer.from(canonical(value));let count=0;if(bytes.length<60000)tx.set(key,{kind:'json',value});else{count=Math.ceil(bytes.length/24000);assert(count<=128,'bounded controller section');tx.set(key,{kind:'chunks',count,digest:hash(value)});for(let i=0;i<count;i++)tx.set(key+'/chunk/'+i,{data:bytes.subarray(i*24000,(i+1)*24000).toString('base64')});}for(let i=count;i<(old?.kind==='chunks'?old.count:0);i++)tx.delete(key+'/chunk/'+i);}
function auditNamespaces(records){for(const key of records.keys()){
 if(key==='meta/paymentEvents'||/^payment-events\/(0|[1-9][0-9]*)$/.test(key))continue;
 if(/^wallet\/[a-f0-9]{64}(?:\/(?:outputs|requests|history)\/(?:0|[1-9][0-9]*))?$/.test(key)||/^wallet-reverse\/(?:outputs|requests|history)\/[a-f0-9]{64}\/[a-f0-9]{64}$/.test(key))continue;
 if(/^(outputs|requests|nodes|owners)\/[a-f0-9]{64}$/.test(key)||['meta/anchor','meta/blockRules','meta/blockHead'].includes(key)||sections.has(key))continue;
 const match=/^(meta\/(?:money|network|economics))\/chunk\/(0|[1-9][0-9]*)$/.exec(key),head=match&&records.get(match[1]);assert(head?.kind==='chunks'&&Number(match[2])<head.count,'unexpected authenticated record namespace');
}}
// Decode controller sections once per block. Successful frames update this
// private overlay; failed frames never reach it. Encode only at atomic commit.
function decodedSections(tx){const cache=new Map(),dirty=new Set();return {
 // Every caller is a frame overlay: its get() clones before exposing a value.
 get(key){if(!sections.has(key))return tx.get(key);if(!cache.has(key))cache.set(key,section(tx,key));return cache.get(key);},
 // set() receives the owned value of a completed private frame overlay.
 // No references are returned to that frame; subsequent reads clone it.
 set(key,value){if(!sections.has(key))return tx.set(key,value);assert(Buffer.byteLength(canonical(value))<=128*24000,'bounded controller section');cache.set(key,value);dirty.add(key);},
 delete(key){assert(!sections.has(key),'cannot delete a controller section');tx.delete(key);},
 flush(){for(const key of [...dirty].sort())putSection(tx,key,cache.get(key));}
};}
function overlay(parent){const values=new Map();return {get:key=>structuredClone(values.has(key)?values.get(key):parent.get(key)),set:(key,value)=>values.set(key,structuredClone(value)),delete(key){assert((values.has(key)?values.get(key):parent.get(key))!==undefined,'overlay deletes absent record: '+key);values.set(key,undefined);},commit(){for(const [key,value]of [...values].sort(([a],[b])=>a<b?-1:1)){if(value===undefined){if(parent.get(key)!==undefined)parent.delete(key);}else parent.set(key,value);}},size:()=>values.size};}
function supported(s){feeOnly(s);assert(!s.launchFund,'active economic controller needs bounded integration');assert(!s.networkReserves?.issued,'issued legacy reserve needs bounded integration');}
export function evidenceBudget(m){const {outputs,requests,nodes,...head}=m;let reserve=196608;for(const r of Object.values(m.liability?.records??{}))for(const a of r.assignments)if(!r.faults[a.index+':'+a.node])reserve+=1200;return Buffer.byteLength(canonical(head))+reserve;}
function moneyHeadroom(m){assert(evidenceBudget(m)<=128*24000,'bounded liability evidence headroom');}
// A successful fault fork changes exactly these three existing JSON subtrees
// and consumes one reserved assignment. Canonical JSON lengths are additive;
// object keys/separators outside the replaced subtrees remain identical.
export function faultBudget(previous,next,pid,budget){
 const a=previous.liability,b=next.liability,bytes=value=>Buffer.byteLength(canonical(value));
 for(const key of Object.keys(a))if(!['records','discipline','protection'].includes(key))assert.equal(b[key],a[key],'fault budget branch');
 return budget+bytes(b.records[pid])-bytes(a.records[pid])+bytes(b.discipline)-bytes(a.discipline)+bytes(b.protection)-bytes(a.protection)-1200;
}
function eventOf(request,filter){exact(request,['height','blockHash','time','txs']);integer(request.height,1);integer(request.time,1);hex(request.blockHash);assert(typeof filter==='boolean');assert(Array.isArray(request.txs)&&request.txs.length<=64);let bytes=0;const txs=request.txs.map(v=>{assert(v instanceof Uint8Array&&v.length>0&&v.length<=65536);bytes+=v.length;return Buffer.from(v).toString('base64');});assert(bytes<=1048576,'block byte budget');return {domain:DOMAIN,height:request.height,blockHash:request.blockHash,time:request.time,txs,filter};}
export class BoundedNetworkInterpreter{
 static create(file,state,config,expectedStateHash,{progress,archive=null,isolatedIssuance=false}={}){
  assert(typeof isolatedIssuance==='boolean');assert(!isolatedIssuance||archive===null,'isolated issuance cannot import a production archive');
  auditState(state,config);assert.equal(hash(state),expectedStateHash,'source state pin');supported(state);moneyHeadroom(state.money);if(!isolatedIssuance)assert(!state.centurySubsidy?.pending,'pending subsidy requires isolated issuance');
  const {money,...network}=state,{outputs,requests,nodes,...head}=money,entries=new Map(),tx={get:key=>entries.get(key),set:(key,value)=>entries.set(key,value),delete:key=>entries.delete(key)};
  putSection(tx,'meta/network',network);putSection(tx,'meta/money',head);const owners=new Map();
  for(const [bucket,map]of Object.entries({outputs,requests,nodes}))for(const [id,value]of Object.entries(map)){entries.set(bucket+'/'+id,value);if(bucket==='outputs'&&amount(value.value)>0n)owners.set(ownerKey(value.owner),(owners.get(ownerKey(value.owner))??0)+1);}
  for(const [key,count]of owners)entries.set(key,{count});
  createWalletIndex(entries,money);
  const workerIds=Object.keys(nodes).sort();assert(workerIds.length<=1024,'bounded worker census');const seed=emptySeed();if(!state.rewards)for(const r of Object.values(requests))if(r.status==='SETTLED')addSettlement(seed,r,state);putSection(tx,'meta/economics',{workerIds,seed,custody:custodyIndex(state)});
  const pending=Object.fromEntries(Object.entries(requests).filter(([,r])=>active(r)).map(([id,r])=>[id,active(r)]));assert(Object.keys(pending).length<=32);
  entries.set('meta/blockRules',{height:state.height,delayedPayments:delayedPaymentsEnabled(state),resources:resourceLimitsEnabled(state),active:pending});
  entries.set('meta/anchor',{domain:DOMAIN,configHash:hash(config),height:state.height,sourceStateHash:expectedStateHash,issuance:isolatedIssuance,retainsTerminalHistory:true,archive});entries.set('meta/blockHead',{height:state.height,requestDigest:null,codes:[]});
  return new this(AuthenticatedRecordStore.create(file,[...entries].sort(([a],[b])=>a<b?-1:1),{progress}),config,{allowIncomplete:archive!==null,isolatedIssuance});
 }
 constructor(store,config,{allowIncomplete=false,isolatedIssuance=false}={}){this.store=store;this.config=immutableConfig(config);this.configHash=validateConfig(this.config);this.money=new IndexedMoneyInterpreter(store);const anchor=store.proof('meta/anchor',store.root).value;assert.equal(anchor?.domain,DOMAIN);assert.equal(anchor.configHash,this.configHash);assert.equal(anchor.issuance,isolatedIssuance,'isolated issuance mode must be explicit');this.isolatedIssuance=isolatedIssuance;if(anchor.archive){assert(!isolatedIssuance);if(!allowIncomplete)assert.equal(anchor.archive.status,'READY','incomplete archive migration');}}
 static open(file,config,root,options={}){const store=new AuthenticatedRecordStore(file,root);try{return new this(store,config,options);}catch(e){store.close();throw e;}}
 get root(){return this.store.root;}
 networkHeader(){const m=this.store.meta;return section({get:key=>this.store._find({key:m.rootKey,hash:m.rootHash},key)},'meta/network');}
 #admission=null;
 checkFaultAdmission(bytes,{time}={}){
  // Mempool screening only. Never writes, settles, signs or prepares a block.
  // Prepare/Process/Finalize still execute ALL block rules independently.
  const t=parseBoundedTx(Buffer.from(bytes),this.config);if(t.body.action.type!=='REPORT_PAYMENT_FAULT_V1')return false;
  const root=this.root;return this.store.readRecords(root,({get})=>{
  // A single committed-root memo is admission-only. Any SQL write on this
  // connection (including rollback) or another connection invalidates it.
  // Consensus execution never uses this memo and reauthenticates its reads.
  const revision=root+':'+this.store.db.prepare('SELECT total_changes() AS n').get().n+':'+this.store.db.prepare('PRAGMA data_version').get().data_version;
  if(this.#admission?.revision!==revision){
   this.#admission=null;
   const network=section({get},'meta/network'),money=section({get},'meta/money'),anchor=get('meta/anchor');
   assert(!anchor.archive||anchor.archive.status==='READY','incomplete archive migration');
   this.#admission={revision,network,money,budget:evidenceBudget(money),requests:new Map()};
  }
  const memo=this.#admission,network=memo.network,money={...memo.money};
  guardPreparedEconomy(network,t.body.action.type);
  if(!money.liability||money.liability.height<money.liability.policy.activation)return false;
  const pid=t.body.action.attestation?.body?.pid;hex(pid);
  if(time!==undefined){integer(time,1);assert(time>=money.time&&time-money.time<=31*86400,'admission time bounds');money.time=time;}
  if(!memo.requests.has(pid)){if(memo.requests.size>=256)memo.requests.clear();memo.requests.set(pid,get('requests/'+pid));}
  money.requests={[pid]:memo.requests.get(pid)};assert(money.requests[pid],'liability request required');money.nodes={};money.outputs={};
  validatePaymentFault(money,t.body.action);
  // Only screen committed headroom here. Projected per-proof and whole-block
  // budgets remain mandatory in consensus; admission cannot authorize writes.
  assert(memo.budget<=128*24000,'bounded liability evidence headroom');
  assert.equal(this.root,root,'admission root changed');return true;
  });
 }
 _frame(parent,apply){const staged=overlay(parent),tx=staged;let reads=0;
  const result=this.money.withRecords(tx,(money,rules,touched)=>{
   let s={...tx.get('meta/network'),money};assert.equal(s.configHash,this.configHash);supported(s);const supply=amount(money.supply),issued=issuedTotal(s),book=tx.get('meta/economics'),ctx=executionContext(s,book,money,rules,touched,this.root,tx.get('meta/blockHead').height);
   return withControllerContext(money,ctx,()=>{s=apply(s,rules,tx,rewardContext(s,book))??s;for(const bucket of ['outputs','requests','nodes'])assert.equal(s.money[bucket],money[bucket],'shared bounded monetary collection');Object.assign(money,s.money);s.money=money;supported(s);auditControllers(s);assert.equal(amount(money.supply)-supply,issuedTotal(s)-issued,'authorized century issuance delta');moneyHeadroom(money);rules.height=s.height;rules.delayedPayments=delayedPaymentsEnabled(s);rules.resources=resourceLimitsEnabled(s);const updated=tx.get('meta/economics');updateCustody(s,updated,touched);tx.set('meta/economics',updated);const {money:ignored,...network}=s;tx.set('meta/network',network);return {duplicate:false};});
  },{recordLimit:8192,allowSupplyChange:this.isolatedIssuance,onChanges:touched=>{reads=touched.size;indexWalletChanges(tx,touched);for(const r of touched.values())if(r.bucket==='outputs')for(const [value,direction]of [[r.before,-1],[r.value,1]])if(value&&amount(value.value)>0n){const key=ownerKey(value.owner),count=(tx.get(key)?.count??0)+direction;integer(count);if(count)tx.set(key,{count});else if(tx.get(key))tx.delete(key);}}});
  assert(staged.size()<=8192,'block frame record budget');staged.commit();return {...result,recordsRead:reads};
 }
 checkBlockAdmission(request){
  // Run the same ordered rules against authenticated records, but retain the
  // write set only in memory. This result cannot be finalized or committed.
  const root=this.root,event=eventOf(request,false);assert(Buffer.byteLength(canonical(event))<=2*1024*1024,'event size');
  return this.store.readRecords(root,({get})=>{
   const values=new Map(),touch=key=>{if(!values.has(key)){assert(values.size<8192,'transaction record bound');values.set(key,get(key));}};
   const raw={get:key=>values.has(key)?structuredClone(values.get(key)):get(key),set:(key,value)=>{touch(key);assert(Buffer.byteLength(canonical(value))<=65536,'record size');values.set(key,structuredClone(value));},delete:key=>{touch(key);values.set(key,undefined);}};
   const result=this.#blockRules(request,root,event,false)(raw);assert.equal(this.root,root,'admission root changed');return result;
  });
 }
 commitBlock(request,expectedRoot,{filter=false,beforeCommit,dryRun=false,observeRead}={}){
  const event=eventOf(request,filter);assert(observeRead===undefined||typeof observeRead==='function');
  return this.store.transact(expectedRoot,event,this.#blockRules(request,expectedRoot,event,filter,observeRead),{beforeCommit,dryRun,recordLimit:8192,eventLimit:2*1024*1024});
 }
 #blockRules(request,expectedRoot,event,filter,observeRead){const requestDigest=hash(event);
  return raw=>{const readKeys=new Set(),guarded={...raw,get:key=>{readKeys.add(key);if(readKeys.size>16384)throw new StorageReadError('block read budget');try{const value=raw.get(key);observeRead?.(key,value);return value;}catch(e){throw new StorageReadError('authenticated storage read failed',{cause:e});}}},staged=overlay(guarded),decoded=decodedSections(staged),head=staged.get('meta/blockHead');if(request.height===head.height){assert.equal(head.requestDigest,requestDigest,'conflicting committed block replay');return {duplicate:true,codes:head.codes};}assert.equal(head.height+1,request.height,'consecutive block height');let readCount=0;
   const archive=staged.get('meta/anchor').archive;if(archive)assert.equal(archive.status,'READY','incomplete archive migration');
   readCount+=this._frame(decoded,(s,rules,tx,context)=>{assert.equal(s.height,head.height);const baseHeight=s.height;assert(request.time>=s.money.time&&request.time-s.money.time<=31*86400,'block time bounds');s.money.height=integer(s.money.height+Math.max(1,Math.ceil((request.time-s.money.time)/policy.maxAdvance)));s.money.time=request.time;s.height=request.height;s.blockHash=request.blockHash;if(s.authority)s.authority=activate(s.authority,s.height);s=beginRewards({height:baseHeight},s,{...context,anchorRoot:expectedRoot});if(s.rewards){const book=tx.get('meta/economics');book.seed=emptySeed();tx.set('meta/economics',book);}s=advanceSpendPolicies(s);executeLiabilityAdvance(s);
    if(delayedPaymentsEnabled(s))for(const pid of Object.keys(rules.active).sort()){const r=rules.active[pid];if(r.status==='SCHEDULED'&&r.executeAt<=s.money.time){const before=structuredClone(s.money.requests[pid]);executeScheduledRelease(s.money,pid);s=this._settled(s,pid,before,tx);}}
    if(resourceLimitsEnabled(s)){const due=Object.keys(rules.active).filter(pid=>rules.active[pid].status==='RESERVED'&&paymentClock(s.money,rules.active[pid],s.money.height+1)>rules.active[pid].deadline).sort();for(const pid of due){const r=s.money.requests[pid];s.money.height++;executePaymentAction(s.money,{type:'EXPIRE',pid,request:r.digest});}}
    return recordCenturyWarmupSettlement(s);
   }).recordsRead;
   // Parsing is state-independent; preserve order and error positions.
   const parsed=request.txs.map(bytes=>{try{return {tx:parseBoundedTx(Buffer.from(bytes),this.config)};}catch(error){return {error};}}),codes=[];
   for(let i=0;i<parsed.length;){const item=parsed[i];
    if(item.tx?.body.action.type==='REPORT_PAYMENT_FAULT_V1'){
     const replayAllowed=!decoded.get('meta/network').centuryWarmup;
     const replay=item=>{const a=item.tx?.body.action,pid=a?.signed?.intent?.pid;return replayAllowed&&a?.type==='RESERVE'&&typeof pid==='string'&&/^[a-f0-9]{64}$/.test(pid)&&!!decoded.get('requests/'+pid);};
     const run=[];while(i<parsed.length&&(parsed[i].error||parsed[i].tx?.body.action.type==='REPORT_PAYMENT_FAULT_V1'||replay(parsed[i])))run.push(parsed[i++]);
     const result=this._faultReports(decoded,run,filter);codes.push(...result.codes);readCount+=result.recordsRead;continue;
    }
    i++;try{if(item.error)throw item.error;readCount+=this._frame(decoded,(s,rules,tx)=>this._action(s,item.tx,rules,tx)).recordsRead;codes.push(0);}catch(e){if(!filter||e instanceof StorageReadError)throw e;codes.push(1);}
   }
   decoded.flush();staged.set('meta/blockHead',{height:request.height,requestDigest,codes});assert(staged.size()<=8192,'block write budget');staged.commit();return {duplicate:false,codes,recordsRead:readCount};
  };
 }
 _faultReports(parent,transactions,filter){
  const codes=[];try{
   const result=this._frame(parent,(s,rules,tx)=>{let budget=evidenceBudget(s.money);for(const item of transactions){try{
    if(item.error)throw item.error;const t=item.tx;
    guardPreparedEconomy(s,t.body.action.type);
    let next,projected=budget;
    if(t.body.action.type==='RESERVE'){
     // A known ordinary RESERVE replay performs all normal admission and
     // signature checks, but its monetary kernel cannot write any records.
     // Programme settlement controllers stay on the general serial path.
     assert(!s.centuryWarmup&&s.money.requests[t.body.action.signed.intent.pid]);
     next=this._action({...s,money:{...s.money}},t,rules,tx);
     for(const key of Object.keys(s.money))assert.equal(next.money[key],s.money[key],'reservation replay must be read-only');
    }else{next=stagePaymentFault(s,t.body.action,this.config,t.body.author);projected=faultBudget(s.money,next.money,t.body.action.attestation.body.pid,budget);}
    // Preserve the exact per-action evidence admission bound, not just the
    // final batch size. No failed fork is ever published to the next report.
    assert(projected<=128*24000,'bounded liability evidence headroom');s=next;budget=projected;codes.push(0);
   }catch(e){if(!filter||e instanceof StorageReadError)throw e;codes.push(1);}}return s;});
   return {codes,recordsRead:result.recordsRead};
  }catch(e){
   if(!filter||e instanceof StorageReadError)throw e;
   // A shared frame budget/audit failure must keep serial filtering semantics.
   const serial=[];let reads=0;for(const item of transactions){try{if(item.error)throw item.error;const t=item.tx;reads+=this._frame(parent,(s,rules,tx)=>this._action(s,t,rules,tx)).recordsRead;serial.push(0);}catch(error){if(error instanceof StorageReadError)throw error;serial.push(1);}}
   return {codes:serial,recordsRead:reads};
  }
 }
 _action(s,t,rules,tx){let a=t.body.action;const author=t.body.author;
  guardPreparedEconomy(s,a.type);
  if(a.type===NODE_LINK_ACTION)return applyNodeLink(s,a,author);
  if(a.type==='BIND_REWARD_WALLETS_V1'){
   const n=s.rewards?.nodes[a.body?.node];
   if(n?.payouts.length&&hash(n.payouts)!==hash(a.body.payouts))assert.equal(nodeLinkBlockers(s,a.body.node).length,0,'Settle existing reward obligations before changing payout wallets.');
  }
  if(a.type===FUND_WORKER)return fundWorker(s,a,author);
  if(COLLATERAL_ACTIONS.includes(a.type))return releaseWorkerCollateral(s,a,author);
  if(a.type===PREPARE_WORKERS){const book=tx.get('meta/economics'),prepared=prepareInitialWorkers(s,a,this.config,{anchor:tx.get('meta/anchor'),workerIds:book.workerIds});book.workerIds=prepared.workerIds;tx.set('meta/economics',book);return prepared.state;}
  if(a.type==='PREPARE_NETWORK_RESERVES_V1')return prepareCleanCustody(s,a,author,this.config,{anchor:tx.get('meta/anchor'),workerIds:tx.get('meta/economics').workerIds});
  if(CENTURY_ACTIONS.includes(a.type)){if(['ISSUE_CENTURY_FUNDS_V1','OPEN_CENTURY_SUBSIDY_V1'].includes(a.type))assert(this.isolatedIssuance,'issuance forbidden');return centuryAction(s,a,author,this.config);}
  if(REWARD_ACTIONS.includes(a.type)){assert(['ENABLE_NODE_REWARDS_V1','SET_REWARD_COEFFICIENTS_V1','ALLOW_REWARD_NODES_V1','REGISTER_REWARD_NODE_V1','BIND_REWARD_WALLETS_V1','SET_REWARD_MANAGEMENT_V1'].includes(a.type),'unverified witness work is not payable');return applyRewardAction(s,a,author,this.config,rewardContext(s,tx.get('meta/economics')));}
  if(['ROTATE_VALIDATOR','RENEW_POLICY','ENABLE_DELAYED_PAYMENTS','ENABLE_RESOURCE_LIMITS','ENABLE_SPEND_PROTECTION_V1'].includes(a.type)){s.authority=applyControl(s.authority,a,{config:this.config,height:s.height,time:s.money.time});return s;}
  if(LIABILITY_ACTIONS.includes(a.type))return executeLiabilityAction(s,a,this.config,author);
  if(RECOVERY_ACTIONS.includes(a.type)){applyRecovery(s,a,author);s.networkReserves.history=hash({previous:s.networkReserves.history,action:a,height:s.height});return reconcileProtection(s);}
  if(PROTECTION_ACTIONS.includes(a.type))return applySpendPolicy(s,a,author,{hasOutput:wallet=>(tx.get(ownerKey(wallet))?.count??0)>0});
  assert(['RESERVE','SCHEDULE_PAYMENT_V1','CANCEL_SCHEDULED_PAYMENT_V1','FINALIZE','EXPIRE'].includes(a.type),'unsupported bounded action; issuance disabled');
  if(['RESERVE','SCHEDULE_PAYMENT_V1'].includes(a.type)){const i=a.signed.intent;checkReservedPayment(s,i);guardCustodyRequest(s,i);if(!Object.hasOwn(s.money.requests,i.pid)){assert.equal(i.unitScale??'1',s.money.unitScale??'1');checkApproval(s,i,a.approval);if(resourceLimitsEnabled(s)){const pending=Object.fromEntries(Object.keys(rules.active).map(pid=>[pid,s.money.requests[pid]]));checkResourceAdmission({...s.money,requests:pending},i,s.configHash,{protectedPayment:protectionEnabled(s)&&spendPolicy(s,i.sender)?.enabled===true});}}if(Object.hasOwn(a,'approval')){const {approval,...rest}=a;a=rest;}}
  if(a.type==='SCHEDULE_PAYMENT_V1'){assert(delayedPaymentsEnabled(s)&&scheduled(a.signed?.intent),'scheduled capability');a={...a,type:'RESERVE'};}else if(a.type==='RESERVE')assert(!scheduled(a.signed?.intent),'use scheduled payment action');
  if(a.type==='CANCEL_SCHEDULED_PAYMENT_V1'){assert(delayedPaymentsEnabled(s));const r=s.money.requests[a.pid];assert(r&&scheduled(r.intent)&&author===r.intent.sender,'cancel authority');a={...a,type:'CANCEL'};}
  if(a.type==='FINALIZE'){assert(Array.isArray(a.receipts)&&a.receipts.length<=policy.maxParts*policy.copies);a={...a,receipts:a.receipts.map(r=>{exact(r,['index','node','signature','profileSignature',...(r.attestation?['attestation']:[])]);checkLiabilityReceipt(s.money,a.pid,r.index,r.node,r.attestation);assert(verify({domain:PROFILE+'/WORK',configHash:s.configHash,request:a.request,index:r.index,node:r.node,signature:r.signature},r.profileSignature,s.money.nodes[r.node]?.key),'network-bound work signature');return {index:r.index,node:r.node,signature:r.signature};})};}
  const pid=a.pid??a.signed?.intent?.pid,before=pid?structuredClone(s.money.requests[pid]):undefined,h=s.money.height;s.money.height=integer(h+1);if(executePaymentAction(s.money,a))s.money.height=h;return pid?this._settled(s,pid,before,tx):s;
 }
 _settled(s,pid,before,tx){const r=s.money.requests[pid];if(r?.status==='SETTLED'&&before?.status!=='SETTLED'){const book=tx.get('meta/economics');if(!s.rewards){addSettlement(book.seed,r,s);tx.set('meta/economics',book);}else s=recordRewardSettlements(s,{requests:{[pid]:before}},{...rewardContext(s,book),changedRequests:[[pid,r]]});}return recordCenturyWarmupSettlement(s);}
 // Full audit is explicitly offline. Never used by commitBlock/open.
 snapshotForAudit(){const records=new Map();this.store.db.exec('BEGIN');try{this.store.scanAuthenticated((k,v)=>records.set(k,v));auditNamespaces(records);const tx={get:key=>records.get(key)},s={...section(tx,'meta/network'),money:{...section(tx,'meta/money'),outputs:{},requests:{},nodes:{}}},owners=new Map();assert.equal(records.get('meta/blockHead')?.height,s.height,'block head height');for(const [key,value]of records){const [bucket,id]=key.split('/');if(['outputs','requests','nodes'].includes(bucket)){s.money[bucket][id]=value;if(bucket==='outputs'&&amount(value.value)>0n)owners.set(ownerKey(value.owner),(owners.get(ownerKey(value.owner))??0)+1);}}
   auditWalletIndex(records,s.money);
   auditState(s,this.config);supported(s);const seed=emptySeed();if(!s.rewards)for(const r of Object.values(s.money.requests))if(r.status==='SETTLED')addSettlement(seed,r,s);assert.deepEqual(section(tx,'meta/economics'),{workerIds:Object.keys(s.money.nodes).sort(),seed,custody:custodyIndex(s)},'economic census');for(const [key,value]of records)if(key.startsWith('owners/')){assert.equal(value.count,owners.get(key),'owner index');owners.delete(key);}assert.equal(owners.size,0,'missing owner index');const rules=records.get('meta/blockRules');assert.equal(rules.height,s.height);assert.equal(rules.delayedPayments,delayedPaymentsEnabled(s));assert.equal(rules.resources,resourceLimitsEnabled(s));assert.deepEqual(rules.active,Object.fromEntries(Object.entries(s.money.requests).filter(([,r])=>active(r)).map(([pid,r])=>[pid,active(r)])));this.store.db.exec('COMMIT');return s;
  }catch(e){this.store.db.exec('ROLLBACK');throw e;}}
 close(){this.store.close();}
}
