// A complete owner view, not a full network snapshot. Expected roots come from
// the consensus verifier; neither the HTTP peer nor this reader chooses them.
import assert from 'node:assert/strict';
import {hash,hex,publicKey} from '../crypto.mjs';
import {verifyBoundedQuery,WALLET_PAGE_SIZE} from './bounded-query.mjs';
import {parseToken} from '../token-units.mjs';
import {bindPaidAdmissionView} from '../paid-admission-view.mjs';
import {BOUNDED_DOMAIN} from './bounded-schema.mjs';
const verifiedViews=new WeakMap();
export function assertBoundedWalletView(state,certificate,config,owner){
 const pin=verifiedViews.get(state);assert(pin&&pin.owner!==null,'unverified owner view');
 assert.equal(pin.owner,owner);assert.equal(pin.configHash,hash(config));assert.equal(pin.root,certificate.appHash);assert.equal(state.height,certificate.appHeight);assert.equal(hash(state),pin.digest,'modified owner view');
}
export const isBoundedWalletView=state=>verifiedViews.has(state)&&verifiedViews.get(state).owner!==null;
export const isBoundedServiceView=state=>verifiedViews.has(state);
export const usesIndexedHomeAdmission=state=>verifiedViews.get(state)?.domain===BOUNDED_DOMAIN;
export function boundedPaymentPlan(state,value){
 const pin=verifiedViews.get(state);assert(pin?.payment,'Payment coverage has not been verified for this amount.');
 assert.equal(hash(state),pin.digest,'modified owner view');assert.equal(value,pin.payment.value,'payment coverage amount changed');
 return structuredClone(pin.payment.parts);
}
export function assertBoundedRewardAccount(state,id){
 const pin=verifiedViews.get(state);hex(id);assert(pin&&pin.rewardIds?.includes(id),'reward account membership was not queried');
}
async function loadRewardPages(read,state,maxRecords=100000,owner=null){
 if(!state.rewards)return;let offset=0,total=null;const nodes={};
 do{const page=await read({type:owner===null?'reward-page':'reward-owner-page',id:{...(owner===null?{}:{owner}),offset,limit:WALLET_PAGE_SIZE}});assert.equal(page.offset,offset);total??=page.total;assert.equal(page.total,total);assert(total<=maxRecords,'reward view record budget');
  for(const {id,value}of page.items){assert(!Object.hasOwn(nodes,id),'duplicate reward record');nodes[id]=value;}
  offset+=page.items.length;assert.equal(page.next,offset<total?offset:null);assert(offset===total||page.items.length>0,'empty reward page');
 }while(offset<total);
 assert.equal(Object.keys(nodes).length,total);state.rewards.nodes=nodes;
}
export function assertBoundedServiceView(state,certificate,config){
 const pin=verifiedViews.get(state);assert(pin,'unverified service view');assert.equal(pin.configHash,hash(config));assert.equal(pin.root,certificate.appHash);assert.equal(state.height,certificate.appHeight);assert.equal(hash(state),pin.digest,'modified service view');
}
export async function loadBoundedServiceView(query,{root,height,configHash,allowIsolated=false,rewardIds=[]}){
 assert(Array.isArray(rewardIds)&&rewardIds.length<=128&&new Set(rewardIds).size===rewardIds.length);for(const id of rewardIds)hex(id);
 const result=verifyBoundedQuery(await query({type:'wallet-meta',id:null},root),{type:'wallet-meta',id:null},root,configHash);
 assert.equal(result.height,height);assert(allowIsolated||!result.isolatedIssuance,'isolated issuance view');
 const {network,money,anchor}=result.data,state={...network,money:{...money,outputs:{},requests:{},nodes:{}}};
 if(state.rewards)for(const id of rewardIds){const req={type:'reward-account',id},r=verifyBoundedQuery(await query(req,root),req,root,configHash);assert.equal(r.height,height);assert(allowIsolated||!r.isolatedIssuance);if(r.data)state.rewards.nodes[id]=r.data;}
 verifiedViews.set(state,{root,configHash,domain:anchor.domain,owner:null,rewardIds:[...rewardIds],digest:hash(state)});return {state,anchor};
}
export async function loadBoundedRewardPlan(query,{root,height,configHash,offset=0,allowIsolated=false}){
 const request={type:'reward-planning',id:{offset,limit:8}},result=verifyBoundedQuery(await query(request,root),request,root,configHash);
 assert.equal(result.height,height,'mixed planning height');assert(allowIsolated||!result.isolatedIssuance,'isolated issuance view');
 const {state,anchor,page}=result.data;assert.equal(state.configHash,configHash);
 // Legacy planning needs the full admitted registry. Fetch it in independently
 // verified bounded pages; modern planning already reads its explicit roster.
 if(!state.centuryFees)await loadRewardPages(async req=>{const r=verifyBoundedQuery(await query(req,root),req,root,configHash);assert.equal(r.height,height);assert(allowIsolated||!r.isolatedIssuance);return r.data;},state);
 if(result.data.admission)bindPaidAdmissionView(state,result.data.admission);
 verifiedViews.set(state,{root,configHash,owner:null,digest:hash(state)});return {state,anchor,page};
}
export async function loadBoundedHistoryPage(query,{root,height,configHash,owner,offset=0,limit=WALLET_PAGE_SIZE,through=null,allowIsolated=false}){
 const request={type:'wallet-page',id:{owner,kind:'history',offset,limit,...(through===null?{}:{through})}},result=verifyBoundedQuery(await query(request,root),request,root,configHash);
 assert.equal(result.height,height,'mixed history height');assert(allowIsolated||!result.isolatedIssuance,'isolated issuance view');return result.data;
}
export async function loadBoundedWalletView(query,{root,height,configHash,owner,requestIds=[],rewardIds=[],payment=null,allowIsolated=false,maxRecords=100000}){
 hex(root);hex(configHash);publicKey(owner);assert(Number.isSafeInteger(height)&&height>=0);assert(Number.isSafeInteger(maxRecords)&&maxRecords>0&&maxRecords<=100000);
 assert(Array.isArray(requestIds)&&requestIds.length<=256);for(const id of requestIds)hex(id);assert.equal(new Set(requestIds).size,requestIds.length);
 assert(Array.isArray(rewardIds)&&rewardIds.length<=128&&new Set(rewardIds).size===rewardIds.length);for(const id of rewardIds)hex(id);
 const read=async request=>{const r=verifyBoundedQuery(await query(request,root),request,root,configHash);assert.equal(r.height,height,'mixed query height');assert(allowIsolated||!r.isolatedIssuance,'isolated issuance view');return r.data;};
 const meta=await read({type:'wallet-meta',id:null}),state={...meta.network,money:{...meta.money,outputs:{},requests:{},nodes:{}}};assert.equal(state.configHash,configHash);let records=0;
 for(const kind of ['outputs','requests']){
  let offset=0,total=null;const seen=new Set();
  do{
   const request={type:'wallet-page',id:{owner,kind,offset,limit:WALLET_PAGE_SIZE}};
   const page=await read(request);assert.equal(page.offset,offset);total??=page.total;assert.equal(page.total,total);assert(total<=maxRecords,'owner view record budget');
   for(const item of page.items){assert(!seen.has(item.id),'duplicate owner record');seen.add(item.id);assert(++records<=maxRecords,'owner view record budget');state.money[kind][item.id]=item.value;}
   offset+=page.items.length;assert.equal(page.next,offset<total?offset:null,'page continuity');assert(offset===total||page.items.length>0,'empty intermediate page');
  }while(offset<total);
  assert.equal(seen.size,total,'incomplete owner view');
 }
 await loadRewardPages(read,state,maxRecords-records,owner);
 const covered=new Set(Object.keys(state.rewards?.nodes??{}));records+=covered.size;
 // Funding is still an authenticated controller section. Include funded nodes
 // even after their last payout recipient has been detached.
 const requested=new Set([...rewardIds,...Object.entries(state.workerFunding?.accounts??{}).filter(([,a])=>a.owner===owner).map(([id])=>id)]);
 if(state.rewards)for(const id of requested)if(!covered.has(id)){
  hex(id);assert(++records<=maxRecords,'owner view record budget');const value=await read({type:'reward-account',id});covered.add(id);if(value)state.rewards.nodes[id]=value;
 }
 // Pairing, collateral and Home classification need only these accounts. A
 // missing worker is proved as absent, never inferred from a partial census.
 for(const id of new Set([...covered,...requested])){hex(id);assert(++records<=maxRecords,'owner view record budget');const n=await read({type:'node',id});if(n)state.money.nodes[id]=n;}
 let capacity=null;
 if(payment){
  assert.deepEqual(Object.keys(payment).sort(),['unitScale','value']);const scale=state.money.unitScale??'1';
  if(payment.unitScale!==null)assert.equal(payment.unitScale,scale,'Payment units changed. Review the amount again.');
  const value=payment.unitScale===null?payment.value:parseToken(payment.value,scale);
  capacity=await read({type:'payment-capacity',id:{value,unitScale:scale}});
 }
 const history=await loadBoundedHistoryPage(query,{root,height,configHash,owner,allowIsolated});
 for(const {id,value}of history.items)state.money.requests[id]=value;
 for(const id of requestIds)if(!Object.hasOwn(state.money.requests,id)){
  const r=await read({type:'request',id});if(r){assert([r.intent.sender,r.intent.recipient].includes(owner),'unrelated outbox record');state.money.requests[id]=r;}
 }
 verifiedViews.set(state,{root,configHash,domain:meta.anchor.domain,owner,rewardIds:[...covered],payment:capacity,digest:hash(state)});
 return {state,anchor:meta.anchor,history};
}
async function readQuery(url,{method='GET',timeout=10000,budget=32*1048576}={}){
 for(let attempt=0;attempt<2;attempt++)try{
  const response=await fetch(url,{method,signal:AbortSignal.timeout(timeout),...(attempt?{headers:{Connection:'close'}}:{})});assert(response.ok,response.status===409?'indexed root advanced; retry verification':'indexed query failed');let size=0;const parts=[];
  for await(const b of response.body){size+=b.length;assert(size<=budget,'indexed response budget');parts.push(b);}return JSON.parse(Buffer.concat(parts));
 }catch(e){if(attempt||!['ECONNRESET','EPIPE','UND_ERR_SOCKET'].includes(e.cause?.code??e.code))throw e;}
}
export function boundedHttpQuery(endpoint,lease=null){
 const base=new URL(endpoint);assert(base.protocol==='http:'&&base.hostname==='127.0.0.1'&&base.pathname==='/'&&!base.username&&!base.password&&!base.search&&!base.hash,'local indexed endpoint required');
 const query=async(request,root)=>{
  const page=['paid-admission-page','reward-owner-page','wallet-page','worker-page','reward-page','payment-events','reward-planning'].includes(request.type),id=['reward-owner-page','wallet-page','approval-context'].includes(request.type)?request.id.owner:['paid-admission-page','payment-capacity','worker-page','reward-page','payment-events','reward-planning'].includes(request.type)||request.id===null?'summary':request.id;
  const u=new URL('/v1/'+request.type+'/'+encodeURIComponent(id),base);u.searchParams.set('root',root);if(page){if(request.type==='wallet-page')u.searchParams.set('kind',request.id.kind);u.searchParams.set('offset',String(request.id.offset));u.searchParams.set('limit',String(request.id.limit));}
  if(request.type==='approval-context')u.searchParams.set('pid',request.id.pid??'none');
  if(request.type==='payment-capacity'){u.searchParams.set('value',request.id.value);u.searchParams.set('unitScale',request.id.unitScale);}
  if(request.type==='wallet-page'&&Object.hasOwn(request.id,'through'))u.searchParams.set('through',String(request.id.through));
  if(lease){assert.equal(root,lease.root);u.searchParams.set('lease',lease.token);}
  return readQuery(u);
 };
 query.withLease=async(root,read)=>{
  hex(root);const u=new URL('/v1/read-lease',base);u.searchParams.set('root',root);
  // Only read-lease allocation is retried, never a payment mutation. A lost
  // allocation response can leave one bounded lease until its short TTL expires.
  const session=await readQuery(u,{method:'POST',timeout:5000,budget:1023});
  assert(session.root===root&&/^[a-f0-9]{48}$/.test(session.token),'invalid read lease');
  try{return await read(boundedHttpQuery(endpoint,session));}finally{const release=new URL('/v1/read-lease',base);release.searchParams.set('lease',session.token);try{await fetch(release,{method:'DELETE',signal:AbortSignal.timeout(2000)});}catch{}}
 };
 return query;
}
