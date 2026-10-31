import { canonical,digest,exact } from './protocol.mjs';
import { stateIndexes,mapProof } from './map-proof.mjs';
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const summaries=new WeakMap();
// Committed/working snapshots are immutable after construction. Empty consensus
// blocks reuse this identity, avoiding a complete Merkle rebuild every 2 seconds.
export function stateSummary(state){
  if(summaries.has(state))return summaries.get(state);
  const trees=stateIndexes(state),summary=Object.freeze({epoch:state.epoch,supply:state.supply,fees:state.fees,minted:Object.freeze([...state.minted]),notesRoot:trees.notes.root,txsRoot:trees.txs.root});
  summaries.set(state,summary);return summary;
}
export function noteProof(state,id){
  const proof=mapProof(state.notes,stateIndexes(state).notes,id);if(proof.kind!=='present')throw new Error('object not found');return proof.entry;
}
export function verifyPassportEnvelope(p,trustedAppHash){
  exact(p,['height','appHash','preimage','summary','proof']);
  exact(p.preimage,['parent','height','blockHash','state','txs',...(Object.hasOwn(p.preimage,'governance')?['governance']:[]),...(Object.hasOwn(p.preimage,'witnessRoots')?['witnessRoots']:[])]);
  if(Object.hasOwn(p.preimage,'witnessRoots')&&!hex(p.preimage.witnessRoots))throw new Error('witness root state commitment');
  exact(p.summary,['epoch','supply','fees','minted','notesRoot','txsRoot']);
  exact(p.proof,['key','value','index','count','siblings']);
  if(!hex(trustedAppHash)||p.appHash!==trustedAppHash||digest(p.preimage)!==trustedAppHash||p.height!==p.preimage.height||digest(p.summary)!==p.preimage.state)throw new Error('untrusted state envelope');
  const q=p.proof,domain='notes-v1';
  if(!Number.isSafeInteger(q.count)||q.count<1||!Number.isSafeInteger(q.index)||q.index<0||q.index>=q.count||!Array.isArray(q.siblings)||q.siblings.length!==Math.ceil(Math.log2(q.count))||q.siblings.some(x=>!hex(x)))throw new Error('invalid Merkle path');
  if(q.value.id!==q.key)throw new Error('object identity mismatch');
  let hash=digest({domain,key:q.key,value:q.value}),at=q.index,width=q.count;
  for(const sibling of q.siblings){if(at%2===0&&at+1>=width&&sibling!==hash)throw new Error('odd leaf mismatch');hash=at%2?digest({domain,left:sibling,right:hash}):digest({domain,left:hash,right:sibling});at=Math.floor(at/2);width=Math.ceil(width/2);}
  if(digest({domain,count:q.count,root:hash})!==p.summary.notesRoot)throw new Error('invalid object inclusion');
  return {object:q.value,height:p.height,appHash:p.appHash};
}

// Authenticate the exact committee/recovery state BEFORE using it to prepare
// a rotation. The root must already be checked against the signed next header.
export function verifyGovernanceEnvelope(p,trustedAppHash){
  exact(p,['height','appHash','preimage','governance']);
  exact(p.preimage,['parent','height','blockHash','state','txs','governance',...(Object.hasOwn(p.preimage,'witnessRoots')?['witnessRoots']:[])]);
  if(!hex(trustedAppHash)||p.appHash!==trustedAppHash||!Number.isSafeInteger(p.height)||p.height<1||
    p.preimage.height!==p.height||digest(p.preimage)!==trustedAppHash||!p.governance||
    digest(p.governance)!==p.preimage.governance)throw new Error('untrusted governance envelope');
  return structuredClone(p.governance);
}

export function verifyWitnessRootsEnvelope(p,trustedAppHash){
 exact(p,['height','appHash','preimage','witnessRoots']);
 exact(p.preimage,['parent','height','blockHash','state','txs','witnessRoots',...(Object.hasOwn(p.preimage,'governance')?['governance']:[])]);
 if(!hex(trustedAppHash)||p.appHash!==trustedAppHash||!Number.isSafeInteger(p.height)||p.height<1||p.preimage.height!==p.height||digest(p.preimage)!==trustedAppHash||!p.witnessRoots||digest(p.witnessRoots)!==p.preimage.witnessRoots)throw new Error('untrusted witness-root state');
 return structuredClone(p.witnessRoots);
}
