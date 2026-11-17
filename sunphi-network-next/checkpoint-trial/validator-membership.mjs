// Candidate membership changes are ordered by the same block as payments.
// They never rewrite worker ownership, pending receipts, collateral or balances.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,publicKey,verify} from './crypto.mjs';
import {validatorSet,validatorQuorum,validatorApprovalBody} from './validator-authority.mjs';
export const CHANGE_VALIDATORS='CHANGE_VALIDATORS_V2';
export const MEMBERSHIP='DUEBYTE_VALIDATOR_MEMBERSHIP_V2';
export function membershipDelta(before,after){
 assert.equal(validatorSet(before).version,2);assert.equal(validatorSet(after).version,2);
 const old=new Map(before.map(m=>[m.key,m])),next=new Map(after.map(m=>[m.key,m]));
 let changed=0n;const updates=[];
 for(const key of [...new Set([...old.keys(),...next.keys()])].sort()){
  const a=old.get(key),b=next.get(key);if(a&&b)assert.equal(a.group,b.group,'validator owner is immutable');
  const difference=BigInt(b?.power??0)-BigInt(a?.power??0);
  changed+=difference<0n?-difference:difference;
  if(difference!==0n)updates.push({key,power:b?.power??0});
 }
 assert(updates.length,'empty validator change');
 // Conservative overlap rule. Large replacements must be separate, committed
 // changes; readiness signatures alone are not a synchronization proof.
 assert(changed*3n<=validatorSet(before).total,'validator change exceeds one third of current power');
 return updates;
}
export function changeValidators(a,action,{config,height}){
 assert.equal(config.control?.version,2,'membership requires explicit V2 genesis');assert.equal(a.version,2);
 assert(!a.pending,'validator change pending');exact(action,['type','certificate']);assert.equal(action.type,CHANGE_VALIDATORS);
 const c=action.certificate;exact(c,['body','approvals','readiness','possessions']);const b=c.body;
 exact(b,['domain','network','configHash','generation','previousSetHash','next','notBefore','expires']);
 assert.equal(b.domain,MEMBERSHIP);assert.equal(b.network,config.chainId);assert.equal(b.configHash,hash(config));
 assert.equal(b.generation,a.generation);assert.equal(b.previousSetHash,validatorSet(a.validators).hash);
 integer(b.notBefore,1);integer(b.expires,b.notBefore);integer(height,1);
 assert(b.expires-b.notBefore<=100&&height>=b.notBefore&&height<=b.expires,'membership inclusion window');
 const updates=membershipDelta(a.validators,b.next),current=new Set(a.validators.map(m=>m.key));
 const added=b.next.filter(m=>!current.has(m.key));
 for(const m of added)assert(!a.usedKeys.includes(m.key),'retired/reused validator key');
 validatorQuorum(b,c.approvals,a.validators);validatorQuorum(b,c.readiness,b.next);
 assert(Array.isArray(c.possessions)&&c.possessions.length===added.length,'new validator possession count');
 const expected=new Set(added.map(m=>m.key)),payload=validatorApprovalBody(b,b.next);
 for(const s of c.possessions){exact(s,['key','signature']);assert(expected.delete(s.key),'new validator possession key');assert(verify(payload,s.signature,s.key),'new validator possession');}
 const out=structuredClone(a);out.pending={activation:height+2,validators:structuredClone(b.next),updates,certificate:hash(c)};
 out.usedKeys.push(...added.map(m=>m.key));out.usedKeys.sort();assert(out.usedKeys.length<=2048,'validator key archive capacity');return out;
}
export function auditMembership(a,config,height){
 if(config.control?.version!==2){assert(a?.version===undefined,'unexpected authority version');if(a)assert.equal(validatorSet(a.validators).version,1);return;}
 assert.equal(a.version,2);assert.equal(validatorSet(a.validators).version,2);integer(a.generation);
 assert(Array.isArray(a.usedKeys)&&a.usedKeys.length<=2048);assert.deepEqual(a.usedKeys,[...new Set(a.usedKeys)].sort());
 a.usedKeys.forEach(publicKey);
 for(const m of a.validators)assert(a.usedKeys.includes(m.key),'missing active validator key');
 if(a.pending){const p=a.pending;exact(p,['activation','validators','updates','certificate']);integer(p.activation,1);hex(p.certificate);assert(p.activation>height&&p.activation<=height+2,'pending validator activation');assert.deepEqual(p.updates,membershipDelta(a.validators,p.validators));for(const m of p.validators)assert(a.usedKeys.includes(m.key),'missing pending validator key');}
}
