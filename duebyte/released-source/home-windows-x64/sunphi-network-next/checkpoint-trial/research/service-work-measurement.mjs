// Shared evidence verifier, intended for the existing indexed consensus path.
// The trusted challenge/eligibility/key are supplied by committed state, NEVER
// taken from the node's response. No emission or monetary side effects here.
// This measures timely authenticated record service. It is NOT a claim to prove
// continuous uptime, independent hardware, every archive byte or physical owners.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,canonical,verify} from '../crypto.mjs';
import {verifyRecordProof,recordKey} from './record-proof.mjs';
import {DAY} from './calendar-node-emission-policy.mjs';
export const SERVICE_WORK='DUEBYTE_AUTHENTICATED_SERVICE_WORK_V1';
const units=v=>{assert(typeof v==='string'&&/^[1-9][0-9]{0,17}$/.test(v),'positive bounded normalized units');return BigInt(v);};

export function validateServiceProfile(p){
 exact(p,['version','intervalSeconds','responseSeconds','workerUnits','witnessUnits','workerWeight','witnessWeight']);
 assert.equal(p.version,SERVICE_WORK);integer(p.intervalSeconds,300);assert(p.intervalSeconds<=DAY&&DAY%p.intervalSeconds===0,'fixed intervals dividing UTC day');
 integer(p.responseSeconds,5);assert(p.responseSeconds<=180&&p.responseSeconds<p.intervalSeconds);
 units(p.workerUnits);units(p.witnessUnits);for(const k of ['workerWeight','witnessWeight']){integer(p[k],1);assert(p[k]<=1000000);}
 return p;
}

export function serviceChallenge({configHash,profile,node,kind,intervalStart,openedAt,anchorHeight,anchorRoot,key,valueHash}){
 hex(configHash);hex(node);hex(anchorRoot);hex(valueHash);validateServiceProfile(profile);recordKey(key);
 assert(['worker','witness'].includes(kind));integer(intervalStart,1);assert.equal(intervalStart%profile.intervalSeconds,0);
 integer(openedAt,intervalStart);assert(openedAt<intervalStart+profile.intervalSeconds-profile.responseSeconds,'no backdated service challenge');integer(anchorHeight,1);
 return {domain:SERVICE_WORK,configHash,profileHash:hash(profile),node,kind,intervalStart,openedAt,deadline:openedAt+profile.responseSeconds,anchorHeight,anchorRoot,key,valueHash};
}

export function serviceResponseBody(challenge,proof){
 return {domain:SERVICE_WORK+'/RESPONSE',configHash:challenge.configHash,node:challenge.node,challengeHash:hash(challenge),proofHash:hash(proof)};
}

export function verifyServiceResponse({challenge,profile,publicKey,eligible,response,acceptedAt}){
 validateServiceProfile(profile);assert.equal(challenge.domain,SERVICE_WORK);assert.equal(challenge.profileHash,hash(profile));
 exact(challenge,['domain','configHash','profileHash','node','kind','intervalStart','openedAt','deadline','anchorHeight','anchorRoot','key','valueHash']);
 assert.deepEqual(challenge,serviceChallenge({...challenge,profile}));assert.equal(eligible,true,'paid-service admission at assigned interval required');
 integer(acceptedAt,challenge.openedAt);assert(acceptedAt<=challenge.deadline,'service response expired');
 exact(response,['body','signature','proof']);assert(Buffer.byteLength(canonical(response))<=60000,'bounded service response');
 assert.deepEqual(response.body,serviceResponseBody(challenge,response.proof),'node/root/interval challenge binding');
 assert(verify(response.body,response.signature,publicKey),'work key signature');
 assert.equal(response.proof.key,challenge.key);assert.equal(response.proof.found,true);verifyRecordProof(response.proof,challenge.anchorRoot);
 assert.equal(hash(response.proof.value),challenge.valueHash,'assigned record');
 const raw=units(challenge.kind==='worker'?profile.workerUnits:profile.witnessUnits),weight=BigInt(challenge.kind==='worker'?profile.workerWeight:profile.witnessWeight);
 return {domain:SERVICE_WORK+'/ACCEPTED',configHash:challenge.configHash,profileHash:challenge.profileHash,node:challenge.node,kind:challenge.kind,
  day:Math.floor(challenge.intervalStart/DAY)*DAY,intervalStart:challenge.intervalStart,challengeHash:hash(challenge),responseHash:hash(response),rawUnits:String(raw),weightedUnits:String(raw*weight),acceptedAt};
}

// Same key for a node/interval regardless of retried challenge or transport.
// Exact receipt replay is a no-op; contradictory receipts cannot buy more work.
export function acceptServiceResponse(tx,input){
 const {intervalStart,node}=input.challenge;integer(intervalStart,1);hex(node);
 const key='service-work/accepted/'+intervalStart+'/'+node,old=tx.get(key);
 // A retry after timeout may acknowledge already accepted work, but may not
 // introduce a new late response or change historical acceptance time.
 if(old)integer(input.acceptedAt,old.acceptedAt);
 const result=verifyServiceResponse(old?{...input,acceptedAt:old.acceptedAt}:input);
 if(old){assert.equal(old.challengeHash,result.challengeHash,'service interval already accepted');assert.equal(old.responseHash,result.responseHash,'conflicting service response');return {duplicate:true,receipt:old};}
 tx.set(key,result);return {duplicate:false,receipt:result};
}
