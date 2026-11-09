// Read-only candidate API. The caller must authenticate expectedRoot through
// consensus; a proof authenticates records, not the server supplying that root.
import assert from 'node:assert/strict';
import {exact,hex,hash,canonical,publicKey} from '../crypto.mjs';
import {verifyRecordProof} from './record-proof.mjs';
import {rewardSummary} from '../node-rewards.mjs';
import {BOUNDED_DOMAIN} from './bounded-schema.mjs';
import {eventSlot} from './bounded-payment-events.mjs';
import {paymentClock} from '../obligation-clock.mjs';
import {RESOURCE_LIMITS} from '../resource-limits.mjs';
import {walletHeadKey,walletSlotKey,emptyWalletHead} from './bounded-wallet-index.mjs';
const API='DUEBYTE_BOUNDED_QUERY_V5';
export const WALLET_PAGE_SIZE=32;
function pageRange(offset,limit,count){assert(Number.isSafeInteger(offset)&&offset>=0&&offset<=count,'page offset');assert(Number.isSafeInteger(limit)&&limit>=1&&limit<=WALLET_PAGE_SIZE,'page size');return Math.min(offset+limit,count);}
function decodeSection(get,key){const h=get(key);assert(h,'missing section');if(h.kind==='json'){exact(h,['kind','value']);return h.value;}exact(h,['kind','count','digest']);assert(h.kind==='chunks'&&Number.isSafeInteger(h.count)&&h.count>0&&h.count<=128);const parts=[];for(let i=0;i<h.count;i++){const p=get(key+'/chunk/'+i);exact(p,['data']);const b=Buffer.from(p.data,'base64');assert(b.length<=24000&&b.toString('base64')===p.data);parts.push(b);}const value=JSON.parse(Buffer.concat(parts).toString());assert.equal(hash(value),h.digest);return value;}
function answer(request,get){
 exact(request,['type','id']);const anchor=get('meta/anchor'),head=get('meta/blockHead');assert.equal(anchor.domain,BOUNDED_DOMAIN);assert.equal(typeof anchor.issuance,'boolean');if(anchor.archive){assert.equal(anchor.issuance,false);assert.equal(anchor.archive.status,'READY');}
 let data;
 if(request.type==='wallet-page'){
  exact(request.id,['owner','kind','offset','limit',...(Object.hasOwn(request.id,'through')?['through']:[])]);const {owner,kind,offset,limit}=request.id;publicKey(owner);assert(['outputs','requests','history'].includes(kind));
  assert(!Object.hasOwn(request.id,'through')||kind==='history');
  const counts=get(walletHeadKey(owner))??emptyWalletHead();exact(counts,['outputs','requests','history']);for(const n of Object.values(counts))assert(Number.isSafeInteger(n)&&n>=0);
  const total=request.id.through??counts[kind];assert(Number.isSafeInteger(total)&&total>=0&&total<=counts[kind],'history cursor');
  const end=pageRange(offset,limit,total),items=[];
  for(let index=offset;index<end;index++){const slot=get(walletSlotKey(owner,kind,kind==='history'?total-1-index:index));exact(slot,['id']);hex(slot.id);const value=get((kind==='history'?'requests':kind)+'/'+slot.id);assert(value,'missing wallet record');
   if(kind==='outputs')assert(value.owner===owner&&BigInt(value.value)>0n,'wallet output membership');
   else assert((kind==='history'||['RESERVED','SCHEDULED'].includes(value.status))&&[value.intent.sender,value.intent.recipient].includes(owner),'wallet request membership');
   items.push({id:slot.id,value});
  }
  data={owner,kind,offset,total,next:end<total?end:null,items,...(kind==='history'?{available:counts.history}:{})};
 }
 else if(request.type==='expiry-candidates'){
  assert.equal(request.id,null);const rules=get('meta/blockRules'),money=decodeSection(get,'meta/money');assert.equal(rules.height,head.height);
  const active=Object.entries(rules.active);assert(active.length<=RESOURCE_LIMITS.activeTotal,'active timer capacity');
  const due=active.filter(([,r])=>r.status==='RESERVED'&&paymentClock(money,r)>r.deadline).sort(([a,x],[b,y])=>x.deadline-y.deadline||a.localeCompare(b)).slice(0,16);
  data=due.map(([id,timer])=>{hex(id);const value=get('requests/'+id);assert(value?.status==='RESERVED');assert.equal(value.intent.pid,id);assert.equal(value.intent.deadline,timer.deadline);assert.equal(value.intent.timeBasis,timer.timeBasis);assert.equal(hash(value.intent),value.digest);return {id,value};});
 }
 else if(request.type==='payment-events'){
  exact(request.id,['offset','limit']);const {offset,limit}=request.id;assert(limit<=8,'notification page limit');
  const count=get('meta/paymentEvents');exact(count,['count']);assert(Number.isSafeInteger(count.count)&&count.count>=0);
  const end=pageRange(offset,limit,count.count),network=decodeSection(get,'meta/network');assert.equal(network.height,head.height);
  const items=[];for(let n=offset;n<end;n++){const row=get(eventSlot(n));exact(row,['pid','digest','status','terminalHeight','executeAt']);hex(row.pid);const r=get('requests/'+row.pid);assert(r&&hash(r.intent)===row.digest);const {pid,...fields}=row;items.push({index:n,value:{intent:r.intent,...fields}});}
  data={offset,total:count.count,next:end<count.count?end:null,items,anchor,authority:network.authority};
 }
 else if(request.type==='approval-context'){
  exact(request.id,['owner','pid']);const {owner,pid}=request.id;publicKey(owner);if(pid!==null)hex(pid);
  const network=decodeSection(get,'meta/network'),money=decodeSection(get,'meta/money');assert.equal(network.height,head.height);
  const outputs={},requests={},counts=get(walletHeadKey(owner))??emptyWalletHead();
  if(counts.outputs){const slot=get(walletSlotKey(owner,'outputs',0));hex(slot.id);const o=get('outputs/'+slot.id);assert(o?.owner===owner&&BigInt(o.value)>0n);outputs[slot.id]=o;}
  if(pid!==null){const r=get('requests/'+pid);if(r){assert([r.intent.sender,r.intent.recipient].includes(owner));requests[pid]=r;}}
  data={state:{...network,money:{...money,outputs,requests,nodes:{}}},anchor};
 }
 else if(request.type==='wallet-meta'){
  assert.equal(request.id,null);const network=decodeSection(get,'meta/network'),money=decodeSection(get,'meta/money'),book=decodeSection(get,'meta/economics');assert.equal(network.height,head.height);
  assert(Array.isArray(book.workerIds)&&book.workerIds.length<=1024);assert.deepEqual(book.workerIds,[...new Set(book.workerIds)].sort());for(const id of book.workerIds)hex(id);
  data={network,money,workerIds:book.workerIds,anchor};
 }
 else if(request.type==='worker-page'){
  exact(request.id,['offset','limit']);const ids=decodeSection(get,'meta/economics').workerIds;assert(ids.length<=1024);const {offset,limit}=request.id,end=pageRange(offset,limit,ids.length);
  data={offset,total:ids.length,next:end<ids.length?end:null,items:ids.slice(offset,end).map(id=>{hex(id);const value=get('nodes/'+id);assert(value);return {id,value};})};
 }
 else if(request.type==='contract'){
  hex(request.id);const network=decodeSection(get,'meta/network');assert.equal(network.height,head.height);data=network.nativeContracts?.records[request.id]??null;
 }
 else if(['output','request','node'].includes(request.type)){hex(request.id);const bucket={output:'outputs',request:'requests',node:'nodes'}[request.type];data=get(bucket+'/'+request.id)??null;}
 else if(request.type==='owner-count'){publicKey(request.id);data={positiveOutputs:get('owners/'+hash(request.id))?.count??0};}
 else if(request.type==='reward'){hex(request.id);const s={...decodeSection(get,'meta/network'),money:decodeSection(get,'meta/money')};assert.equal(s.height,head.height);data=rewardSummary(s,request.id);}
 else if(request.type==='economy'){
  assert.equal(request.id,null);const s=decodeSection(get,'meta/network'),m=decodeSection(get,'meta/money'),book=decodeSection(get,'meta/economics');assert.equal(s.height,head.height);
  const custody={};for(const [owner,ids]of Object.entries(book.custody)){assert(Array.isArray(ids)&&ids.length<=64);let held=0n;for(const id of ids){hex(id);const o=get('outputs/'+id);assert.equal(o?.owner,owner);held+=BigInt(o.value);}custody[owner]={outputs:ids.length,heldMicro:String(held)};}
  data={unitScale:m.unitScale??'1',supply:m.supply,fees:m.fees,preparation:s.economicPreparation??null,funds:s.centuryFunds??null,warmup:s.centuryWarmup??null,subsidy:s.centurySubsidy??null,tariff:s.centuryFees??null,custody};
 }
 else assert.fail('unsupported bounded query');
 return {height:head.height,configHash:anchor.configHash,isolatedIssuance:anchor.issuance,data};
}
export function queryBounded(handler,request,expectedRoot){
 hex(expectedRoot);const proofs=new Map(),get=key=>{if(!proofs.has(key))proofs.set(key,handler.store.proof(key,expectedRoot));const p=proofs.get(key);return p.found?p.value:undefined;};
 const result=answer(request,get);assert.equal(handler.root,expectedRoot,'stale query root');
 const response={domain:API,root:expectedRoot,request,result,proofs:[...proofs.values()]};assert(Buffer.byteLength(canonical(response))<=32*1024*1024,'query proof byte budget');return response;
}
export function verifyBoundedQuery(response,request,expectedRoot,configHash){
 exact(response,['domain','root','request','result','proofs']);assert.equal(response.domain,API);assert.equal(response.root,expectedRoot);assert.deepEqual(response.request,request);assert(Array.isArray(response.proofs)&&response.proofs.length<=710);assert(Buffer.byteLength(canonical(response))<=32*1024*1024,'query proof byte budget');
 const records=new Map();for(const p of response.proofs){assert(!records.has(p.key),'duplicate query proof');verifyRecordProof(p,expectedRoot);records.set(p.key,p);}const used=new Set(),get=key=>{assert(records.has(key),'missing query proof');used.add(key);const p=records.get(key);return p.found?p.value:undefined;};const result=answer(request,get);assert.equal(used.size,records.size,'unused query proof');assert.equal(result.configHash,configHash);assert.deepEqual(response.result,result);return result;
}
