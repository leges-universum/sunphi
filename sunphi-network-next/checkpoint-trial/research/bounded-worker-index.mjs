// Membership is indexed independently from funding and route eligibility.
import assert from 'node:assert/strict';
import {integer,exact,hex} from '../crypto.mjs';
import {changeRadix,radixCount,radixIds} from './bounded-radix-index.mjs';
const namespace='workers/index';
export const WORKER_NONZERO='workers/nonzero';
// Maintained in the same transaction as each worker change. Zero workers need
// no denomination rewrite; absence is the canonical zero aggregate.
const nonzero=n=>!!n&&['stake','consensusHeld','taskHeld','tier'].some(k=>n[k]!==undefined&&n[k]!=='0');
export function nonzeroWorkerCount(get){const record=get(WORKER_NONZERO);if(record===undefined)return 0;exact(record,['count']);integer(record.count,1);return record.count;}
function updateNonzero(tx,delta){if(!delta)return;const count=nonzeroWorkerCount(tx.get)+delta;integer(count);if(count)tx.set(WORKER_NONZERO,{count});else tx.delete(WORKER_NONZERO);}
export const workerCount=get=>radixCount(get,namespace);
export const workerIds=(get,options)=>radixIds(get,namespace,options);
export function workerAt(get,index){integer(index);assert(index<workerCount(get),'worker index range');return [...workerIds(get,{offset:index,limit:1})][0];}
// Legacy controllers that still require a whole roster have an explicit work
// budget. This is not a population cap on the indexed catalog or its readers.
export function boundedWorkerIds(get,limit=1024){integer(limit,1);assert(workerCount(get)<=limit,'controller worker enumeration budget');return [...workerIds(get,{limit})];}
export function workerAccess(get){return {workerCount:workerCount(get),workerAt:index=>workerAt(get,index),workerIds:limit=>boundedWorkerIds(get,limit)};}
export const REWARD_ENROLLMENT='workers/reward-enrollment';
export const REWARD_ENROLLMENT_BATCH=64;
export function enrollmentState(get){const v=get(REWARD_ENROLLMENT);exact(v,['after','complete']);if(v.after!==null)hex(v.after);assert.equal(typeof v.complete,'boolean');return v;}
export function nextRewardWorkers(tx){
 const cursor=enrollmentState(tx.get);if(cursor.complete)return [];
 const page=[...workerIds(tx.get,{after:cursor.after,limit:REWARD_ENROLLMENT_BATCH+1})],ids=page.slice(0,REWARD_ENROLLMENT_BATCH);
 tx.set(REWARD_ENROLLMENT,{after:ids.at(-1)??cursor.after,complete:page.length<=REWARD_ENROLLMENT_BATCH});return ids;
}
export function createWorkerIndex(tx,nodes){let count=0;for(const id of Object.keys(nodes).sort()){changeRadix(tx,namespace,id,true);if(nonzero(nodes[id]))count++;}if(count)tx.set(WORKER_NONZERO,{count});}
export function updateWorkerIndex(tx,touched){let delta=0;for(const [key,r]of touched)if(r.bucket==='nodes'){if(Boolean(r.before)!==Boolean(r.value))changeRadix(tx,namespace,key.slice(6),Boolean(r.value));delta+=Number(nonzero(r.value))-Number(nonzero(r.before));}updateNonzero(tx,delta);}
export function auditWorkerIndex(records,nodes){const expected=new Map(),tx={get:k=>expected.get(k),set:(k,v)=>expected.set(k,v),delete:k=>expected.delete(k)};createWorkerIndex(tx,nodes);const sorted=rows=>[...rows].sort(([a],[b])=>a<b?-1:a>b?1:0);assert.deepEqual(sorted([...records].filter(([k])=>k===WORKER_NONZERO||k.startsWith(namespace+'/'))),sorted(expected),'worker catalog index differs');}
