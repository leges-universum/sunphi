// Trusted server protocol; signing helpers are for a party's own signer/test keys.
import {sign,verify} from 'node:crypto';
import {canonical,digest,exact,publicKey,decode64} from '../wallet/crypto.mjs';
import {termsReference} from './cases-adapter.mjs';
import {RELEASE_POLICY} from './release-certificate.mjs';
export function issuerBinding(config,principal){const p=config.casesPolicy;return {instanceId:config.instanceId,actorId:principal.userId,
 bankId:p.bankId,sourceId:p.sourceId,bankKey:config.keys.bank,sourceKey:p.sourceKey,policy:config.releasePolicy,maxAgeMs:p.maxAgeMs};}
export function consentStatement(snapshot,now=Date.now()){
 const {terms,grant,parties,issuer}=snapshot;
 if(terms.owner!=='buyer'||terms.recipient!=='seller'||terms.finalityPolicy!==RELEASE_POLICY||grant.finalityPolicy!==RELEASE_POLICY||
   terms.caseId!==grant.caseId||terms.bankId!==issuer.bankId||snapshot.version!==grant.version||grant.status!=='active')throw Error('CONSENT_TERMS_INVALID');
 if(parties?.length!==3||canonical(parties.map(x=>x.role).sort())!==canonical(['bank','buyer','seller'])||new Set(parties.map(x=>x.actorId)).size!==3)
   throw Error('VERIFIED_PARTIES_REQUIRED');
 parties.forEach(p=>publicKey(p.publicKey));
 const expiresAt=Math.min(now+86400000,Date.parse(grant.expiresAt));
 if(!Number.isSafeInteger(now)||!Number.isSafeInteger(expiresAt)||expiresAt<=now)throw Error('CONSENT_EXPIRED');
 return {domain:'sunphi-case-consent-sandbox-v1',instanceId:issuer.instanceId,bankId:issuer.bankId,caseId:terms.caseId,
   grantId:grant.id,grantVersion:grant.version,termsRef:termsReference(terms),grantHash:digest(grant),partiesHash:digest(parties),issuedAt:now,expiresAt};
}
export function signConsent(statement,party,key){const payload={statement,role:party.role,actorId:party.actorId};
 return {payload,signature:sign(null,Buffer.from(canonical(payload)),key).toString('base64')};}
export function verifyConsents(bundle,snapshot,now=Date.now()){
 exact(bundle,['statement','approvals']);const s=bundle.statement;
 if(!Number.isSafeInteger(s?.issuedAt)||s.issuedAt>now||s.expiresAt<=now||canonical(consentStatement(snapshot,s.issuedAt))!==canonical(s))throw Error('CONSENT_VERSION_OR_TIME_MISMATCH');
 if(!Array.isArray(bundle.approvals)||bundle.approvals.length!==3)throw Error('THREE_APPROVALS_REQUIRED');
 const roles=new Set();for(const proof of bundle.approvals){
   exact(proof,['payload','signature']);exact(proof.payload,['statement','role','actorId']);
   const p=snapshot.parties.find(p=>p.role===proof.payload.role&&p.actorId===proof.payload.actorId);
   if(!p||roles.has(p.role)||canonical(proof.payload.statement)!==canonical(s)||
     !verify(null,Buffer.from(canonical(proof.payload)),publicKey(p.publicKey),decode64(proof.signature,64)))throw Error('INVALID_PARTY_APPROVAL');
   roles.add(p.role);
 }return true;
}
export function createConsentService({rpc,config,principal,now=Date.now}){
 const binding=issuerBinding(config,principal),identity={p_actor:principal.userId,p_instance:config.instanceId,p_binding:binding};
 if(principal.bankId!==binding.bankId)throw Error('SOURCE_NOT_FOUND');
 const load=async caseId=>{const s=await rpc('get_case_consent_proposal_v1',{...identity,p_case:caseId});
   if(canonical(s.issuer)!==canonical(binding))throw Error('SOURCE_CONFIGURATION_MISMATCH');return s;};
 return {async proposal(caseId){const s=await load(caseId);return {...s,statement:consentStatement(s,now())};},
   async activate(caseId,bundle){const s=await load(caseId);verifyConsents(bundle,s,now());
     return rpc('activate_case_consent_v1',{...identity,p_case:caseId,p_expected:s,p_bundle_text:canonical(bundle)});}};
}
