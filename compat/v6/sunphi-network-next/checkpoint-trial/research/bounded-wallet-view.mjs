// A complete owner view, not a full network snapshot. Expected roots come from
// the consensus verifier; neither the HTTP peer nor this reader chooses them.
import assert from 'node:assert/strict';
import {hash,hex,publicKey} from '../crypto.mjs';
import {verifyBoundedQuery,WALLET_PAGE_SIZE} from './bounded-query.mjs';
const verifiedViews=new WeakMap();
export function assertBoundedWalletView(state,certificate,config,owner){
 const pin=verifiedViews.get(state);assert(pin&&pin.owner!==null,'unverified owner view');
 assert.equal(pin.owner,owner);assert.equal(pin.configHash,hash(config));assert.equal(pin.root,certificate.appHash);assert.equal(state.height,certificate.appHeight);assert.equal(hash(state),pin.digest,'modified owner view');
}
export const isBoundedWalletView=state=>verifiedViews.has(state)&&verifiedViews.get(state).owner!==null;
export const isBoundedServiceView=state=>verifiedViews.has(state);
export function assertBoundedServiceView(state,certificate,config){
 const pin=verifiedViews.get(state);assert(pin,'unverified service view');assert.equal(pin.configHash,hash(config));assert.equal(pin.root,certificate.appHash);assert.equal(state.height,certificate.appHeight);assert.equal(hash(state),pin.digest,'modified service view');
}
export async function loadBoundedServiceView(query,{root,height,configHash,allowIsolated=false}){
 const result=verifyBoundedQuery(await query({type:'wallet-meta',id:null},root),{type:'wallet-meta',id:null},root,configHash);
 assert.equal(result.height,height);assert(allowIsolated||!result.isolatedIssuance,'isolated issuance view');
 const {network,money,anchor}=result.data,state={...network,money:{...money,outputs:{},requests:{},nodes:{}}};
 verifiedViews.set(state,{root,configHash,owner:null,digest:hash(state)});return {state,anchor};
}
export async function loadBoundedHistoryPage(query,{root,height,configHash,owner,offset=0,limit=WALLET_PAGE_SIZE,through=null,allowIsolated=false}){
 const request={type:'wallet-page',id:{owner,kind:'history',offset,limit,...(through===null?{}:{through})}},result=verifyBoundedQuery(await query(request,root),request,root,configHash);
 assert.equal(result.height,height,'mixed history height');assert(allowIsolated||!result.isolatedIssuance,'isolated issuance view');return result.data;
}
export async function loadBoundedWalletView(query,{root,height,configHash,owner,requestIds=[],allowIsolated=false,maxRecords=100000}){
 hex(root);hex(configHash);publicKey(owner);assert(Number.isSafeInteger(height)&&height>=0);assert(Number.isSafeInteger(maxRecords)&&maxRecords>0&&maxRecords<=100000);
 assert(Array.isArray(requestIds)&&requestIds.length<=256);for(const id of requestIds)hex(id);assert.equal(new Set(requestIds).size,requestIds.length);
 const read=async request=>{const r=verifyBoundedQuery(await query(request,root),request,root,configHash);assert.equal(r.height,height,'mixed query height');assert(allowIsolated||!r.isolatedIssuance,'isolated issuance view');return r.data;};
 const meta=await read({type:'wallet-meta',id:null}),state={...meta.network,money:{...meta.money,outputs:{},requests:{},nodes:{}}};assert.equal(state.configHash,configHash);let records=0;
 for(const kind of ['outputs','requests','nodes']){
  let offset=0,total=null;const seen=new Set();
  do{
   const request=kind==='nodes'?{type:'worker-page',id:{offset,limit:WALLET_PAGE_SIZE}}:{type:'wallet-page',id:{owner,kind,offset,limit:WALLET_PAGE_SIZE}};
   const page=await read(request);assert.equal(page.offset,offset);total??=page.total;assert.equal(page.total,total);assert(total<=maxRecords,'owner view record budget');
   for(const item of page.items){assert(!seen.has(item.id),'duplicate owner record');seen.add(item.id);assert(++records<=maxRecords,'owner view record budget');state.money[kind][item.id]=item.value;}
   offset+=page.items.length;assert.equal(page.next,offset<total?offset:null,'page continuity');assert(offset===total||page.items.length>0,'empty intermediate page');
  }while(offset<total);
  assert.equal(seen.size,total,'incomplete owner view');
 }
 assert.deepEqual(Object.keys(state.money.nodes),meta.workerIds,'worker census completeness');
 const history=await loadBoundedHistoryPage(query,{root,height,configHash,owner,allowIsolated});
 for(const {id,value}of history.items)state.money.requests[id]=value;
 for(const id of requestIds)if(!Object.hasOwn(state.money.requests,id)){
  const r=await read({type:'request',id});if(r){assert([r.intent.sender,r.intent.recipient].includes(owner),'unrelated outbox record');state.money.requests[id]=r;}
 }
 verifiedViews.set(state,{root,configHash,owner,digest:hash(state)});
 return {state,anchor:meta.anchor,history};
}
async function readQuery(url){
 for(let attempt=0;attempt<2;attempt++)try{
  const response=await fetch(url,{signal:AbortSignal.timeout(10000),...(attempt?{headers:{Connection:'close'}}:{})});assert(response.ok,response.status===409?'indexed root advanced; retry verification':'indexed query failed');let size=0;const parts=[];
  for await(const b of response.body){size+=b.length;assert(size<=32*1048576,'indexed response budget');parts.push(b);}return JSON.parse(Buffer.concat(parts));
 }catch(e){if(attempt||!['ECONNRESET','EPIPE','UND_ERR_SOCKET'].includes(e.cause?.code??e.code))throw e;}
}
export function boundedHttpQuery(endpoint,lease=null){
 const base=new URL(endpoint);assert(base.protocol==='http:'&&base.hostname==='127.0.0.1'&&base.pathname==='/'&&!base.username&&!base.password&&!base.search&&!base.hash,'local indexed endpoint required');
 const query=async(request,root)=>{
  const page=['wallet-page','worker-page','payment-events'].includes(request.type),id=['wallet-page','approval-context'].includes(request.type)?request.id.owner:['worker-page','payment-events'].includes(request.type)||request.id===null?'summary':request.id;
  const u=new URL('/v1/'+request.type+'/'+encodeURIComponent(id),base);u.searchParams.set('root',root);if(page){if(request.type==='wallet-page')u.searchParams.set('kind',request.id.kind);u.searchParams.set('offset',String(request.id.offset));u.searchParams.set('limit',String(request.id.limit));}
  if(request.type==='approval-context')u.searchParams.set('pid',request.id.pid??'none');
  if(request.type==='wallet-page'&&Object.hasOwn(request.id,'through'))u.searchParams.set('through',String(request.id.through));
  if(lease){assert.equal(root,lease.root);u.searchParams.set('lease',lease.token);}
  return readQuery(u);
 };
 query.withLease=async(root,read)=>{
  hex(root);const u=new URL('/v1/read-lease',base);u.searchParams.set('root',root);
  const response=await fetch(u,{method:'POST',signal:AbortSignal.timeout(5000)});assert(response.ok,'indexed read root unavailable; retry verification');
  let length=0;const parts=[];for await(const b of response.body){length+=b.length;assert(length<1024,'read lease response budget');parts.push(b);}const session=JSON.parse(Buffer.concat(parts));
  assert(session.root===root&&/^[a-f0-9]{48}$/.test(session.token),'invalid read lease');
  try{return await read(boundedHttpQuery(endpoint,session));}finally{const release=new URL('/v1/read-lease',base);release.searchParams.set('lease',session.token);try{await fetch(release,{method:'DELETE',signal:AbortSignal.timeout(2000)});}catch{}}
 };
 return query;
}
