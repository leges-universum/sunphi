// Deterministic primitives for bounded, versioned native templates. No user code.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,publicKey,verify} from './crypto.mjs';
import {quorum} from './authority.mjs';
export const NATIVE_CONTRACTS='DUEBYTE_NATIVE_CONTRACTS_V1';
export const nativeContractId=(configHash,template,version,planHash)=>hash({domain:NATIVE_CONTRACTS,configHash,template,version,planHash});
export function contractAuthority(s){const m=s.economicPreparation.memorial;return {manager:m.manager,epoch:m.epoch,validators:structuredClone(s.authority.validators),generation:s.authority.generation,height:s.height};}
export function verifyContractCertificate(a,s,auth,fields,recipient=false){
 exact(auth,['manager','epoch','validators','generation','height']);publicKey(auth.manager);integer(auth.epoch);integer(auth.generation);integer(auth.height,1);
 assert(auth.height<=s.height&&auth.epoch<=s.economicPreparation.memorial.epoch&&auth.generation<=s.authority.generation,'future contract authority');
 if(auth.epoch===s.economicPreparation.memorial.epoch)assert.equal(auth.manager,s.economicPreparation.memorial.manager,'current contract manager snapshot');
 if(auth.generation===s.authority.generation)assert.deepEqual(auth.validators,s.authority.validators,'current validator snapshot');
 assert(Array.isArray(auth.validators)&&auth.validators.length===10);const keys=new Set(),groups=new Set();
 for(const v of auth.validators){exact(v,['key','group']);publicKey(v.key);hex(v.group);assert(!keys.has(v.key)&&!groups.has(v.group));keys.add(v.key);groups.add(v.group);}
 exact(a,['type','certificate','managerSignature',...(recipient?['recipientSignature']:[])]);exact(a.certificate,['body','approvals']);const b=a.certificate.body;
 exact(b,['domain','configHash','planHash','contractId','generation','managementEpoch','notBefore','expires',...fields]);
 assert.equal(b.domain,NATIVE_CONTRACTS+'/'+a.type);assert.equal(b.configHash,s.configHash);assert.equal(b.planHash,s.economicPreparation.planHash);hex(b.contractId);
 assert.equal(b.generation,auth.generation);assert.equal(b.managementEpoch,auth.epoch);integer(b.notBefore,1);integer(b.expires,b.notBefore);
 assert(b.expires-b.notBefore<=100&&auth.height>=b.notBefore&&auth.height<=b.expires,'contract certificate inclusion window');
 quorum(b,a.certificate.approvals,auth.validators,7);assert(verify(b,a.managerSignature,auth.manager),'contract manager consent');
 if(recipient){publicKey(b.recipient);assert(verify(b,a.recipientSignature,b.recipient),'contract recipient consent');}
 return b;
}
export function contractPublicText(value){assert(typeof value==='string'&&value.trim().length>0&&value.length<=512&&!/[\u0000-\u001f]/.test(value),'bounded public decision');}
