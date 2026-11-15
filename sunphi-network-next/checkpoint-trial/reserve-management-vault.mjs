// Offline custody. Never enroll, broadcast, mint or reuse a payment-wallet key.
import assert from 'node:assert/strict';
import {keys,hash,sign} from './crypto.mjs';
import {seal,unseal} from './vault.mjs';
import {validateRecovery,recoveryBody,developmentManager} from './reserve-recovery.mjs';
export function createReserveManagement(config,passwords){
 assert(Array.isArray(passwords)&&passwords.length===4&&new Set(passwords).size===4,'four distinct backup passwords');
 const roles=['manager','recovery-1','recovery-2','recovery-3'];
 const backups=roles.map((role,i)=>{const key=keys(),vault=seal(key,passwords[i]);assert.deepEqual(unseal(vault,passwords[i]),key);return {format:'DueByte reserve management backup v1',network:config.chainId,configHash:hash(config),role,publicKey:key.publicKey,vault};});
 const recovery=validateRecovery({keys:backups.slice(1).map(b=>b.publicKey).sort(),threshold:2,delaySeconds:48*3600});
 return {format:'DueByte reserve management custody v1',network:config.chainId,configHash:hash(config),manager:backups[0].publicKey,recovery,backups};
}
export function restoreReserveManagement(backup,config,password,expectedPublicKey){
 assert.equal(backup.format,'DueByte reserve management backup v1');assert.equal(backup.network,config.chainId);assert.equal(backup.configHash,hash(config));assert.equal(backup.publicKey,expectedPublicKey);
 assert(['manager','recovery-1','recovery-2','recovery-3'].includes(backup.role));const k=unseal(backup.vault,password);assert.equal(k.publicKey,expectedPublicKey);return k;
}
export function prepareRecoveryRequest({state,manager,recoveryKeys,authorizingKeys,expiresAt}){
 const r=state.networkReserves;assert(r?.development.access);assert.notEqual(manager.publicKey,developmentManager(r));
 const recovery=validateRecovery({keys:recoveryKeys.map(k=>k.publicKey).sort(),threshold:2,delaySeconds:r.development.access.recovery.delaySeconds});
 const body=recoveryBody(state,'SCHEDULE_DEVELOPMENT_RECOVERY_V1',{sequence:r.development.access.sequence+1,manager:manager.publicKey,recovery,expiresAt});
 const proofs=ks=>ks.map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)}));
 return {type:'SCHEDULE_DEVELOPMENT_RECOVERY_V1',body,approvals:proofs(authorizingKeys),newConsent:sign(body,manager.privateKey),newRecoveryConsents:proofs(recoveryKeys)};
}
