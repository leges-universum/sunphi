// CometBFT applies FinalizeBlock(H) validator updates at H+2. The update is
// relative to the already scheduled H+1 set, not necessarily the current set.
// Pure planning only: the caller MUST persist this together with each penalty
// and pass the resulting updates through the authoritative ABCI block path.
import assert from 'node:assert/strict';
import {integer,publicKey} from '../crypto.mjs';
import {validatorSet} from '../validator-authority.mjs';

const set=members=>{
 const result=validatorSet(members,{minimum:1});
 assert.equal(result.version,2,'slashing requires explicit variable authority');
 return result;
};

export function planConsensusExclusion({height,current,scheduled=null,jailed}){
 integer(height,1);set(current);
 assert(Array.isArray(jailed)&&jailed.length<=256,'bounded excluded signer list');
 const excluded=new Set();for(const key of jailed){publicKey(key);excluded.add(key);}
 if(scheduled){
  integer(scheduled.activation,1);
  assert.equal(scheduled.activation,height+1,'existing change must be the already committed H+1 set');
  set(scheduled.validators);
 }
 const before=scheduled?.validators??current;
 const after=before.filter(v=>!excluded.has(v.key));
 if(after.length===before.length)return null;
 assert(after.length>0,'cannot install an empty CometBFT validator set');
 const previous=set(before),next=set(after);
 const updates=before.filter(v=>excluded.has(v.key)).map(v=>({key:v.key,power:0})).sort((a,b)=>a.key<b.key?-1:1);
 return {activation:integer(height+2,1),previousSetHash:previous.hash,nextSetHash:next.hash,validators:structuredClone(after),updates};
}
