import {sign,verify} from 'node:crypto';
import {canonical,exact,identity,publicKey,decode64} from '../wallet/crypto.mjs';
import {issuerBinding} from './consent.mjs';
export function sealKeyChallenge(payload,sourceKey){
 if(identity(sourceKey).publicKey!==payload.issuer.sourceKey)throw Error('SOURCE_KEY_MISMATCH');
 return {payload,signature:sign(null,Buffer.from(canonical(payload)),sourceKey).toString('base64')};
}
export function inspectKeyChallenge(pkg,trust,now=Date.now()){
 exact(trust,['format','issuer']);exact(pkg,['payload','signature']);const p=pkg.payload;
 exact(p,['domain','action','challengeId','caseId','actorId','role','publicKey','issuer','epoch','issuedAt','expiresAt']);
 if(trust.format!=='sunphi-consent-trust-v1'||canonical(p.issuer)!==canonical(trust.issuer)||
  p.domain!=='sunphi-key-challenge-sandbox-v1'||p.action!=='verify-preassigned-key'||
  !['bank','buyer','seller'].includes(p.role)||typeof p.actorId!=='string'||!p.actorId||p.actorId.length>120||
  ['challengeId','caseId','epoch'].some(k=>!(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/).test(p[k]))||
  !Number.isSafeInteger(now)||!Number.isSafeInteger(p.issuedAt)||!Number.isSafeInteger(p.expiresAt)||
  p.issuedAt>now||p.expiresAt<=now||p.expiresAt-p.issuedAt>600000)throw Error('INVALID_KEY_CHALLENGE');
 publicKey(p.publicKey);
 if(!verify(null,Buffer.from(canonical(p)),publicKey(trust.issuer.sourceKey),decode64(pkg.signature,64)))throw Error('UNTRUSTED_KEY_CHALLENGE');
 return p;
}
export function signKeyChallenge(pkg,trust,actorId,key,now=Date.now()){
 const p=inspectKeyChallenge(pkg,trust,now);
 if(p.actorId!==actorId||p.publicKey!==identity(key).publicKey)throw Error('PREASSIGNED_KEY_REQUIRED');
 const payload={domain:'sunphi-key-proof-sandbox-v1',challenge:pkg};
 return {payload,signature:sign(null,Buffer.from(canonical(payload)),key).toString('base64')};
}
export function verifyKeyProof(proof,trust,now=Date.now()){
 exact(proof,['payload','signature']);exact(proof.payload,['domain','challenge']);
 if(proof.payload.domain!=='sunphi-key-proof-sandbox-v1')throw Error('INVALID_KEY_PROOF');
 const p=inspectKeyChallenge(proof.payload.challenge,trust,now);
 if(!verify(null,Buffer.from(canonical(proof.payload)),publicKey(p.publicKey),decode64(proof.signature,64)))throw Error('INVALID_KEY_PROOF');
 return p;
}
export function createKeyEnrollmentService({rpc,config,principal,sourceKey,now=Date.now}){
 const binding=issuerBinding(config,principal),trust={format:'sunphi-consent-trust-v1',issuer:binding};
 if(principal.bankId!==binding.bankId||identity(sourceKey).publicKey!==binding.sourceKey)throw Error('SOURCE_CONFIGURATION_MISMATCH');
 const args=(actor,caseId)=>{
  if(actor?.instanceId!==config.instanceId||typeof actor.userId!=='string'||!actor.userId)throw Error('SESSION_REQUIRED');
  return {p_actor:principal.userId,p_instance:config.instanceId,p_case:caseId,p_binding:binding,p_user:actor.userId};
 };
 return {
  async status(actor,caseId){return rpc('get_case_key_status_v1',args(actor,caseId));},
  async begin(actor,caseId){
   const p=await rpc('begin_case_key_enrollment_v1',args(actor,caseId));
   const pkg=sealKeyChallenge(p,sourceKey);inspectKeyChallenge(pkg,trust,now());
   if(p.actorId!==actor.userId||p.caseId!==caseId)throw Error('KEY_CHALLENGE_IDENTITY_MISMATCH');return pkg;
  },
  async finish(actor,caseId,proof){
   const a=args(actor,caseId),p=verifyKeyProof(proof,trust,now());
   if(p.actorId!==actor.userId||p.caseId!==caseId)throw Error('KEY_CHALLENGE_IDENTITY_MISMATCH');
   return rpc('finish_case_key_enrollment_v1',{...a,p_challenge:p.challengeId,p_proof_text:canonical(proof)});
  }
 };
}
