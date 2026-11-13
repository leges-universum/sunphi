// Candidate monetary sub-interpreter. NOT a full core.block replacement.
// Public RPC, authority/reward controllers and issuance are not wired.
import assert from 'node:assert/strict';
import {AuthenticatedRecordStore} from './authenticated-record-store.mjs';
import {audit,amount,count,exact,policy,scheduled,executePaymentAction,executeScheduledRelease} from '../payment-model.mjs';
import {resolveLiability,liabilityResolutionDue} from '../payment-liability.mjs';
import {paymentClock,liabilityClock} from '../obligation-clock.mjs';
import {RESOURCE_LIMITS} from '../resource-limits.mjs';
import {hash,canonical,publicKey} from '../crypto.mjs';
const buckets=['outputs','requests','nodes'];
const units=(bucket,value)=>!value?0n:amount(value[bucket==='outputs'?'value':bucket==='requests'?'escrow':'stake']);
const activeRecord=r=>['RESERVED','SCHEDULED'].includes(r.status)?{status:r.status,deadline:r.intent.deadline,...(r.intent.timeBasis?{timeBasis:r.intent.timeBasis}:{}),executeAt:r.executeAt??0}:null;
function activeIndex(requests){return Object.fromEntries(Object.entries(requests).filter(([,r])=>activeRecord(r)).map(([pid,r])=>[pid,activeRecord(r)]));}
function checkRules(r){exact(r,['height','delayedPayments','resources','active']);count(r.height);assert.equal(typeof r.delayedPayments,'boolean');assert.equal(typeof r.resources,'boolean');assert(Object.keys(r.active).length<=RESOURCE_LIMITS.activeTotal,'indexed active capacity');}
export class IndexedMoneyInterpreter{
 static create(file,money,expectedMoneyHash,{progress,blockRules}={}){
  audit(money);assert.equal(hash(money),expectedMoneyHash,'source monetary hash');
  assert(blockRules?.delayedPayments||!Object.values(money.requests).some(r=>scheduled(r.intent)),'scheduled history needs indexed scheduler');
  const {outputs,requests,nodes,...head}=money,entries=[['meta/anchor',{sourceMoneyHash:expectedMoneyHash,sourceHeight:money.height}],['meta/money',head]];
  if(blockRules){exact(blockRules,['height','delayedPayments','resources']);const rules={...blockRules,active:activeIndex(requests)};checkRules(rules);if(money.liability)assert.equal(money.liability.height,rules.height,'consensus height binding');assert(!money.liability?.protection.pending,'protection controller not integrated');entries.push(['meta/blockRules',rules]);}
  for(const bucket of buckets)for(const [id,value] of Object.entries(money[bucket]))entries.push([bucket+'/'+id,value]);
  entries.sort(([a],[b])=>a<b?-1:a>b?1:0);
  return new IndexedMoneyInterpreter(AuthenticatedRecordStore.create(file,entries,{progress}));
 }
 constructor(store){assert(store instanceof AuthenticatedRecordStore);this.store=store;}
 static open(file,expectedRoot){return new IndexedMoneyInterpreter(new AuthenticatedRecordStore(file,expectedRoot));}
 get root(){return this.store.root;}
 transition(event,expectedRoot,{beforeCommit}={}){
  exact(event,['epoch','time','action']);count(event.epoch);count(event.time);assert(['RESERVE','FINALIZE','EXPIRE','CANCEL','TICK'].includes(event.action?.type),'unsupported indexed action');
  return this._mutate(event,expectedRoot,(state,rules)=>{
   assert.equal(event.epoch,state.epoch,'epoch');assert(event.time>=state.time&&event.time-state.time<=policy.maxAdvance,'model time bounds');
   if(event.action.type==='CANCEL'||event.action.type==='RESERVE'&&scheduled(event.action.signed?.intent))assert(rules?.delayedPayments,'scheduled payment needs indexed scheduler');
   state.height=count(state.height+1);state.time=event.time;
   return {duplicate:executePaymentAction(state,event.action)};
  },{beforeCommit});
 }
 // Internal beginning-of-block monetary phase. NOT full core.block: feature
 // flags must come from verified activation; outer envelope/controllers remain
 // the caller's responsibility. All history is retained, with no pruning here.
 beginBlock(event,expectedRoot,{beforeCommit}={}){
  exact(event,['height','time']);count(event.height);count(event.time);
  return this._mutate({type:'INDEXED_BEGIN_BLOCK_V1',...event},expectedRoot,(state,rules)=>{
   assert(rules,'block rules not configured');checkRules(rules);assert.equal(event.height,rules.height+1,'consensus height');
   assert(event.time>=state.time&&event.time-state.time<=31*86400,'block time bounds');
   // Match legacy catch-up tick count; never release at an artificial tick time.
   const ticks=Math.max(1,Math.ceil((event.time-state.time)/policy.maxAdvance));state.height=count(state.height+ticks);state.time=event.time;rules.height=event.height;
   let resolved=0,released=0,expired=0;
   if(state.liability){const l=state.liability;assert(!l.protection.pending,'protection controller not integrated');l.height=event.height;assert(Object.keys(l.records).length<=l.policy.maxOpen,'liability capacity');for(const pid of Object.keys(l.records).sort()){const r=l.records[pid];if(liabilityResolutionDue(state,r)){resolveLiability(state,pid);resolved++;}}}
   if(rules.delayedPayments)for(const pid of Object.keys(rules.active).sort()){const r=rules.active[pid];if(r.status==='SCHEDULED'&&r.executeAt<=state.time){executeScheduledRelease(state,pid);released++;}}
   // Freeze eligibility BEFORE expirations increment the monetary height.
   if(rules.resources){const due=Object.keys(rules.active).filter(pid=>rules.active[pid].status==='RESERVED'&&paymentClock(state,rules.active[pid],state.height+1)>rules.active[pid].deadline).sort();for(const pid of due){const r=state.requests[pid];state.height=count(state.height+1);assert(!executePaymentAction(state,{type:'EXPIRE',pid,request:r.digest}));expired++;}}
   return {duplicate:false,resolved,released,expired};
  },{beforeCommit,recordLimit:8192});
 }
 _mutate(event,expectedRoot,apply,{beforeCommit,recordLimit=256}={}){
  return this.store.transact(expectedRoot,event,tx=>this.withRecords(tx,apply,{recordLimit}),{beforeCommit,recordLimit});
 }
 // Shared bounded view; caller owns the outer atomic transaction and staging.
 withRecords(tx,apply,{recordLimit=256,onChanges,allowSupplyChange=false}={}){
   const head=tx.get('meta/money');assert(head,'missing monetary head');const rules=tx.get('meta/blockRules'),oldRules=canonical(rules??null);if(rules)checkRules(rules);
   // Conservation needs only immutable opening totals, not a second copy of
   // every retained proof. The frame already owns an isolated monetary head.
   const original={supply:head.supply,fees:head.fees,liability:{pool:head.liability?.pool??'0'}},touched=new Map(),maps={};
   const load=(bucket,key)=>{assert(typeof key==='string'&&/^[a-f0-9]{64}$/.test(key),'record identifier');const id=bucket+'/'+key;if(!touched.has(id)){assert(touched.size<(recordLimit===256?128:8190),'payment read set bound');const value=tx.get(id);touched.set(id,{bucket,before:structuredClone(value),value});}return touched.get(id);};
   for(const bucket of buckets)maps[bucket]=new Proxy({}, {
    get:(_,key)=>load(bucket,key).value,
    getOwnPropertyDescriptor:(_,key)=>load(bucket,key).value===undefined?undefined:{enumerable:true,configurable:true,writable:true,value:load(bucket,key).value},
    set:(_,key,value)=>{load(bucket,key).value=value;return true;},
    deleteProperty:(_,key)=>{load(bucket,key).value=undefined;return true;},
    ownKeys:()=>{throw Error('unbounded collection traversal');}
   });
   const state={...head,...maps},result=apply(state,rules,touched);if(result.duplicate)return {...result,recordsRead:touched.size};
   const issued=amount(state.supply)-amount(original.supply);if(!allowSupplyChange)assert.equal(issued,0n,'issuance forbidden');assert(issued>=0n,'supply cannot decrease');
   let delta=amount(state.fees)-amount(original.fees)+amount(state.liability?.pool??'0')-amount(original.liability?.pool??'0')-issued;
   for(const r of touched.values()){
    delta+=units(r.bucket,r.value)-units(r.bucket,r.before);
    if(r.value&&r.bucket==='outputs'){publicKey(r.value.owner);count(r.value.unlock);amount(r.value.value);}
    if(r.value&&r.bucket==='nodes')assert(amount(r.value.taskHeld)+amount(r.value.consensusHeld)<=amount(r.value.stake),'personal coverage');
   }
   assert.equal(delta,0n,'incremental conservation');
   onChanges?.(touched);
   if(rules){for(const [key,r] of touched)if(r.bucket==='requests'){const pid=key.slice(9),active=r.value&&activeRecord(r.value);if(active)rules.active[pid]=active;else delete rules.active[pid];}checkRules(rules);if(canonical(rules)!==oldRules)tx.set('meta/blockRules',rules);}
   for(const [key,r] of [...touched].sort(([a],[b])=>a<b?-1:1)){
    if(r.value===undefined){if(r.before!==undefined)tx.delete(key);}
    else if(r.before===undefined||canonical(r.before)!==canonical(r.value))tx.set(key,r.value);
   }
   const {outputs,requests,nodes,...nextHead}=state;tx.set('meta/money',nextHead);
   return {...result,recordsRead:touched.size};
 }
 // Offline differential qualification only; never called by transition().
 snapshotForAudit(){this.store.db.exec('BEGIN');try{const m=this.store.meta,head=this.store._find({key:m.rootKey,hash:m.rootHash},'meta/money'),out={...head,outputs:{},requests:{},nodes:{}};let rules;this.store.scanAuthenticated((key,value)=>{const [bucket,id]=key.split('/');if(buckets.includes(bucket))out[bucket][id]=value;else{assert(['meta/anchor','meta/money','meta/blockRules'].includes(key),'unknown monetary namespace');if(key==='meta/blockRules')rules=value;}});audit(out);if(rules){checkRules(rules);assert.deepEqual(rules.active,activeIndex(out.requests),'active timer index');if(out.liability)assert.equal(out.liability.height,rules.height,'consensus height binding');}this.store.db.exec('COMMIT');return out;}catch(e){this.store.db.exec('ROLLBACK');throw e;}}
 close(){this.store.close();}
}
