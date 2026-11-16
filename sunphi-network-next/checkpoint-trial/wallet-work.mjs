// Transport discovery is not payment authority. Every returned receipt is bound
// to the authenticated request and assigned worker key before submission.
import assert from 'node:assert/strict';
import {exact,verify} from './crypto.mjs';
import {PROFILE} from './core.mjs';
import {policy,receiptBody} from './payment-model.mjs';
import {rpc} from './client.mjs';
export class WalletWorkError extends Error{constructor(message='Waiting for payment confirmations. The original payment will retry automatically; do not send it again.'){super(message);this.name='WalletWorkError';}}
async function boundedMap(rows,fn){const out=new Array(rows.length),deadline=Date.now()+30000;let cursor=0,failure=null;await Promise.all(Array.from({length:Math.min(4,rows.length)},async()=>{while(cursor<rows.length&&!failure){try{assert(Date.now()<deadline,'work collection deadline');const i=cursor++;out[i]=await fn(rows[i]);}catch(e){failure??=e;}}}));if(failure)throw failure;return out;}
const query=async(url,data)=>{const q=await rpc(url,'abci_query',{path:'/work',data:Buffer.from(JSON.stringify(data)).toString('hex')});assert(q?.response&&!q.response.code,'worker unavailable');const bytes=Buffer.from(q.response.value,'base64');assert(bytes.length<=4096,'work response bound');return JSON.parse(bytes);};
export async function ensureWorkRoutes({parts,routes={},gateway}){
 const nodes=[...new Set(parts.flatMap(p=>p.nodes))];assert(nodes.length>0&&nodes.length<=policy.maxParts*policy.copies);
 try{await boundedMap(nodes.filter(n=>!Object.hasOwn(routes,n)),async node=>{const r=await query(gateway,{node});exact(r,['domain','node','available']);assert.equal(r.domain,'DUEBYTE_WORK_ROUTE_V1');assert.equal(r.node,node);assert.equal(r.available,true);});}catch{throw new WalletWorkError('Payment confirmation routes are temporarily unavailable. No payment has been created. Please retry after the connection recovers.');}
}
export async function collectWorkReceipts({state,pid,routes={},gateway,configHash}){
 const request=state.money.requests[pid];assert(request?.status==='RESERVED');
 const assignments=request.intent.parts.flatMap((p,index)=>p.nodes.map(node=>({index,node})));assert(assignments.length>0&&assignments.length<=policy.maxParts*policy.copies);
 try{return await boundedMap(assignments,async({index,node})=>{
  const direct=Object.hasOwn(routes,node),receipt=await query(direct?routes[node]:gateway,{pid,index,...(direct?{}:{node})});
  exact(receipt,['index','node','signature','profileSignature',...(receipt.attestation?['attestation']:[])]);assert.equal(receipt.index,index);assert.equal(receipt.node,node);
  const key=state.money.nodes[node]?.key;assert(key,'assigned worker key unavailable');assert(verify(receiptBody(request,index,node),receipt.signature,key),'work signature');
  assert(verify({domain:PROFILE+'/WORK',configHash,request:request.digest,index,node,signature:receipt.signature},receipt.profileSignature,key),'network-bound work signature');return receipt;
 });}catch{throw new WalletWorkError();}
}
