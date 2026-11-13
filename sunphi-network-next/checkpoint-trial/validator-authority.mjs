// Shared authority contract for monetary controllers and historical certificates.
// V1 retains its original wire signatures. V2 is explicit in a new genesis only.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,publicKey,verify} from './crypto.mjs';

export const VALIDATOR_AUTHORITY='DUEBYTE_VALIDATOR_AUTHORITY_V2';
// Admission envelope, not a claim that this many voters have been load-qualified.
export const MAX_ACTIVE_VALIDATORS=256;
export function validatorSet(members){
 assert(Array.isArray(members)&&members.length>0,'validator set');
 const version=Object.hasOwn(members[0],'power')?2:1;
 assert(version===1?members.length===10:members.length>=4&&members.length<=MAX_ACTIVE_VALIDATORS,'validator set size');
 const keys=new Set(),groups=new Set();let total=0n;
 for(const m of members){
  exact(m,version===2?['key','group','power']:['key','group']);publicKey(m.key);hex(m.group);
  assert(!keys.has(m.key),'duplicate validator key');keys.add(m.key);
  if(version===1)assert(!groups.has(m.group),'one validator per legacy control group');
  groups.add(m.group);
  if(version===2){integer(m.power,1);assert(m.power<=1000000,'validator power bound');}
  total+=BigInt(version===2?m.power:10);
 }
 const sorted=[...members].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
 return {version,total,threshold:total*2n/3n+1n,owners:groups.size,hash:hash({domain:VALIDATOR_AUTHORITY,version,members:sorted})};
}
export function validatorApprovalBody(body,members){
 const set=validatorSet(members);
 if(set.version===1)return body;
 hex(body.configHash);integer(body.generation);
 return {domain:VALIDATOR_AUTHORITY,validatorSetHash:set.hash,body};
}
// Verify a partial response before combining independent signing hosts.
// Only validatorQuorum authorizes a certificate; a valid partial is not a quorum.
export function verifyValidatorApprovals(body,signatures,members){
 const set=validatorSet(members),signed=validatorApprovalBody(body,members);
 assert(Array.isArray(signatures)&&signatures.length<=members.length,'validator signatures');
 const byKey=new Map(members.map(m=>[m.key,m])),seen=new Set();let power=0n;
 for(const s of signatures){
  exact(s,['key','signature']);const member=byKey.get(s.key);
  assert(member&&!seen.has(s.key),'unauthorized or duplicate validator signer');
  assert(verify(signed,s.signature,s.key),'validator signature');seen.add(s.key);
  power+=BigInt(set.version===2?member.power:10);
 }
 return {power,total:set.total,threshold:set.threshold};
}
export function validatorQuorum(body,signatures,members){
 const result=verifyValidatorApprovals(body,signatures,members);
 assert(result.power>=result.threshold,'validator quorum');return result;
}
