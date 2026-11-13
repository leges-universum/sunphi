// Private block-local copy-on-write views over plain or partitioned reward records.
// A view cannot be supplied over the wire: its capability lives in this WeakMap.
import assert from 'node:assert/strict';
import {canonical,hex} from './crypto.mjs';
const views=new WeakMap();
const bytes=v=>Buffer.byteLength(canonical(v));
const entryBytes=(id,n)=>Buffer.byteLength(JSON.stringify(id))+1+bytes(n);
const payable=n=>n&&BigInt(n.earned)>BigInt(n.paid)&&n.payouts.length>0;
function lookup(v,id){for(let p=v;p;p=p.parent){if(p.changes.has(id))return p.changes.get(id);if(p.read)return p.read(id);}}
function snapshot(nodes){
 const view=views.get(nodes);assert(view,'private reward registry required');
 const parent=view.base,changes=new Map();let {count,earned,paid,size}=parent;
 for(const [id,value]of view.loaded){
  const before=lookup(parent,id);if(before!==undefined&&canonical(value)===canonical(before))continue;
  assert(value,'reward accounts cannot be deleted');view.validate(id,value);
  if(before){earned-=BigInt(before.earned);paid-=BigInt(before.paid);size-=entryBytes(id,before);}
  else{if(count++)size++;}
  earned+=BigInt(value.earned);paid+=BigInt(value.paid);size+=entryBytes(id,value);
  changes.set(id,structuredClone(value));
 }
 return changes.size||view.cursor!==parent.cursor?{parent,changes,count,earned,paid,size,cursor:view.cursor}:parent;
}
function fork(base,validate){
 const loaded=new Map(),read=id=>{hex(id);if(!loaded.has(id)){const value=lookup(base,id);if(value!==undefined)loaded.set(id,structuredClone(value));}return loaded.get(id);};
 const nodes=new Proxy(Object.create(null),{
  get(_target,id){return typeof id==='string'&&/^[a-f0-9]{64}$/.test(id)?read(id):undefined;},
  set(_target,id,value){hex(id);assert(value,'reward accounts cannot be deleted');loaded.set(id,structuredClone(value));return true;},
  has(_target,id){return typeof id==='string'&&(loaded.has(id)||lookup(base,id)!==undefined);},
  getOwnPropertyDescriptor(_target,id){return typeof id==='string'&&(loaded.has(id)||lookup(base,id)!==undefined)?{configurable:true,enumerable:true,writable:true,value:read(id)}:undefined;},
  ownKeys(){assert.fail('full reward registry enumeration in a block frame');},
  deleteProperty(){assert.fail('reward accounts cannot be deleted');},
  defineProperty(){assert.fail('reward property definition forbidden');},
  setPrototypeOf(){assert.fail('reward prototype mutation forbidden');}
 });views.set(nodes,{base,loaded,validate,cursor:base.cursor});return nodes;
}
export function indexedRewardLedger(r,validate){
 if(!r)return r;if(views.has(r.nodes))return cloneRewardLedger(r);
 const {nodes,...header}=r,changes=new Map(),index={witness:[],payable:[]};let earned=0n,paid=0n,size=2;
 for(const [id,n]of Object.entries(nodes)){
  validate(id,n);if(changes.size)size++;size+=entryBytes(id,n);
  earned+=BigInt(n.earned);paid+=BigInt(n.paid);changes.set(id,structuredClone(n));
  if(n.kind==='witness')index.witness.push(id);if(payable(n))index.payable.push(id);
 }
 for(const ids of Object.values(index))ids.sort();
 const base={parent:null,changes,count:changes.size,earned,paid,size,index,cursor:null};
 return {...structuredClone(header),nodes:fork(base,validate)};
}
export function cloneRewardLedger(r){
 const view=r&&views.get(r.nodes);if(!view)return structuredClone(r);
 const {nodes,...header}=r;return {...structuredClone(header),nodes:fork(snapshot(nodes),view.validate)};
}
export function rewardRegistryTotals(nodes){
 if(!views.has(nodes))return null;const v=snapshot(nodes);
 return {count:v.count,earned:v.earned,paid:v.paid,size:v.size};
}
export function rewardRegistryIds(nodes,kind){
 const ids=rewardRegistryIterator(nodes,kind);return ids===null?null:[...ids];
}
export function rewardRegistryIterator(nodes,kind,after=null){
 if(!views.has(nodes))return null;assert(['witness','payable'].includes(kind));
 if(after!==null)hex(after);
 const v=snapshot(nodes),seen=new Set(),ids=[];
 let p=v;for(;p.parent;p=p.parent)for(const [id,n]of p.changes){if(seen.has(id))continue;seen.add(id);if((after===null||id>after)&&(kind==='witness'?n.kind==='witness':payable(n)))ids.push(id);}
 ids.sort();const base=p.ids?p.ids(kind,{after}):p.index[kind].filter(id=>after===null||id>after);
 return (function*(){let i=0;for(const id of base){if(seen.has(id))continue;while(i<ids.length&&ids[i]<id)yield ids[i++];yield id;}while(i<ids.length)yield ids[i++];})();
}
// Only the authenticated storage adapter creates this capability. Plain wire
// objects still take the full validation path in indexedRewardLedger.
export function storedRewardLedger(header,totals,read,ids,validate,cursor=null){
 assert.deepEqual(header.nodes,{});const cache=new Map();
 const base={parent:null,changes:new Map(),...totals,ids,cursor,read:id=>{
  if(!cache.has(id)){const n=read(id);if(n!==undefined)validate(id,n);cache.set(id,structuredClone(n));}return cache.get(id);
 }};
 return {...structuredClone(header),nodes:fork(base,validate)};
}
export function rewardPayoutCursor(nodes){const v=views.get(nodes);assert(v,'private payout queue required');return v.cursor;}
export function advanceRewardPayout(nodes,id){hex(id);const v=views.get(nodes);assert(v,'private payout queue required');v.cursor=id;}
export function rewardPayoutQueue(nodes){
 if(!views.has(nodes))return null;const after=rewardPayoutCursor(nodes);
 // Freeze both ranges before payment mutations. Seek skips prior subtrees;
 // wrapping visits each candidate at most once in this block.
 const tail=rewardRegistryIterator(nodes,'payable',after),head=after===null?null:rewardRegistryIterator(nodes,'payable');
 return (function*(){yield* tail;if(head)for(const id of head){if(id>after)break;yield id;}})();
}
export function rewardRegistryChanges(nodes){
 const v=snapshot(nodes),changes=new Map();let p=v;
 for(;p;p=p.parent)for(const [id,n]of p.changes)if(!changes.has(id))changes.set(id,structuredClone(n));
 return changes;
}
export function materializeRewardLedger(r){
 if(!r||!views.has(r.nodes))return r;
 const v=snapshot(r.nodes),nodes={},seen=new Set();
 for(let p=v;p;p=p.parent){for(const [id,n]of p.changes){if(seen.has(id))continue;seen.add(id);nodes[id]=structuredClone(n);}if(p.ids)for(const id of p.ids('all'))if(!seen.has(id))nodes[id]=structuredClone(p.read(id));}
 return {...r,nodes};
}
export function rewardLedgerBytes(r){
 const totals=r&&rewardRegistryTotals(r.nodes);if(!totals)return bytes(r);
 return bytes({...r,nodes:{}})-2+totals.size;
}
