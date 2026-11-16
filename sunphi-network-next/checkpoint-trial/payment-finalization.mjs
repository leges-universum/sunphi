// One finalization verifier for reference and indexed block execution.
import assert from 'node:assert/strict';
import {exact,verify} from './crypto.mjs';
import {policy} from './payment-model.mjs';
import {checkLiabilityReceipt} from './payment-liability.mjs';
export function verifiedFinalization(money,action,{profile,configHash,replayCommitted=false}){
 exact(action,['type','pid','request','receipts']);assert.equal(action.type,'FINALIZE');
 assert(Array.isArray(action.receipts)&&action.receipts.length<=policy.maxParts*policy.copies);
 const request=money.requests[action.pid];
 // A committed terminal result, or an already scheduled result, is the replay
 // authority. Its liability assignment may already have been released. This
 // performs no new work, payment or penalty; the payment kernel enforces digest
 // binding and the same terminal outcome again. Never use this for RESERVED.
 if(replayCommitted&&request?.digest===action.request&&['SETTLED','SCHEDULED'].includes(request.status))return {...action,receipts:[]};
 return {...action,receipts:action.receipts.map(r=>{
  exact(r,['index','node','signature','profileSignature',...(r.attestation?['attestation']:[])]);
  checkLiabilityReceipt(money,action.pid,r.index,r.node,r.attestation);
  const body={domain:profile+'/WORK',configHash,request:action.request,index:r.index,node:r.node,signature:r.signature};
  assert(verify(body,r.profileSignature,money.nodes[r.node]?.key),'network-bound work signature');
  return {index:r.index,node:r.node,signature:r.signature};
 })};
}
