import assert from 'node:assert/strict';
import {exact, hash, hex, integer, publicKey, verify} from './crypto.mjs';
import {COMET_EVIDENCE_LIMITS} from './consensus-context.mjs';
import {STANDARD_SLASHING,BONDED_SLASHING} from './research/pos-slashing.mjs';

export const bondPolicy = Object.freeze({...STANDARD_SLASHING, ...COMET_EVIDENCE_LIMITS});
export const bondedAdmissionPolicy = Object.freeze({...BONDED_SLASHING, ...COMET_EVIDENCE_LIMITS});
export function bondPolicyForHash(digest) {
 const policy=[bondPolicy,bondedAdmissionPolicy].find(candidate=>hash(candidate)===digest);
 assert(policy,'Unrecognized penalty terms.');
 return policy;
}
export function validateBondTemplate(t) {
 exact(t, ['network','configHash','node','validator','workerKey','owner','bond','policyHash']);
 assert(typeof t.network === 'string' && t.network.length > 0 && t.network.length <= 128);
 hex(t.configHash); hex(t.node);
 for(const key of [t.validator,t.workerKey,t.owner]) publicKey(key);
 assert(typeof t.bond === 'string' && /^[1-9][0-9]{0,19}$/.test(t.bond) && BigInt(t.bond)<(1n<<64n),'Invalid bond amount.');
 const policy=bondPolicyForHash(t.policyHash);
 if(policy===bondedAdmissionPolicy)assert(BigInt(t.bond)>=100000000n,'Bond below the initial 100 DUBYT minimum.');
}
export function bondBody(t,notBefore,expires) {
 validateBondTemplate(t); integer(notBefore,1); integer(expires,notBefore+1);
 assert(expires-notBefore<=600,'Bond request exceeds ten minutes.');
 const {workerKey,...terms}=t;
 return {domain:'DUEBYTE_CONSENSUS_BOND_V1',...terms,notBefore,expires};
}
export function checkBondRequest(packet,time,roles) {
 exact(packet,['template','body',...roles.map(role=>role+'Signature')]);
 const {template:t,body:b}=packet;
 assert.deepEqual(b,bondBody(t,b.notBefore,b.expires),'Bond terms differ from the request.');
 integer(time,1);
 assert(time>=b.notBefore && time<b.expires,'Bond request expired or not yet valid. Review a fresh request.');
 for(const role of roles) assert(verify(b,packet[role+'Signature'],role==='worker'?t.workerKey:t[role]),'Invalid '+role+' signature.');
}
