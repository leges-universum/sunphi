// Storage-independent verifier shared with bounded HTTP consumers.
import assert from 'node:assert/strict';
import {hash,hex} from '../crypto.mjs';
export const RECORD_DOMAIN='DUEBYTE_INDEXED_RECORDS_CANDIDATE_V1';
export const EMPTY=hash({domain:RECORD_DOMAIN,empty:true});
export const recordKey=k=>assert(typeof k==='string'&&/^[\x21-\x7e]{1,256}$/.test(k),'record key');
export const recordSeal=n=>hash({domain:RECORD_DOMAIN,key:n.key,valueHash:n.valueHash,left:n.left,leftHash:n.leftHash,right:n.right,rightHash:n.rightHash});
export function verifyRecordProof(proof,expectedRoot){
 hex(expectedRoot);recordKey(proof.key);assert(Array.isArray(proof.path)&&proof.path.length<=128);let expected=expectedRoot,expectedKey,low=null,high=null;
 for(let i=0;i<proof.path.length;i++){const n=proof.path[i];recordKey(n.key);if(expectedKey!==undefined)assert.equal(n.key,expectedKey);assert(low===null||n.key>low);assert(high===null||n.key<high);assert.equal(recordSeal(n),expected,'proof root mismatch');
  if(n.key===proof.key){assert.equal(i,proof.path.length-1);assert.equal(proof.found,true);assert.equal(hash(proof.value),n.valueHash);return true;}
  const left=proof.key<n.key;expected=left?n.leftHash:n.rightHash;expectedKey=left?n.left:n.right;if(left)high=n.key;else low=n.key;
 }
 assert.equal(expected,EMPTY,'incomplete absence proof');assert.equal(proof.found,false);assert(!Object.hasOwn(proof,'value'));return true;
}
