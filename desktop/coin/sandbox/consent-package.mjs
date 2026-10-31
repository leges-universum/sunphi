// Portable public signing package. Trust must be installed separately from the
// package: a proposal must never nominate its own trusted source key.
import {sign,verify} from 'node:crypto';
import {canonical,digest,exact,identity,publicKey,decode64} from '../wallet/crypto.mjs';
import {consentStatement,signConsent,verifyConsents} from './consent.mjs';
const DOMAIN='sunphi-consent-proposal-sandbox-v1';
export function sealConsentProposal(proposal,sourceKey){
 const {statement,...snapshot}=proposal;
 if(identity(sourceKey).publicKey!==snapshot.issuer.sourceKey)throw Error('SOURCE_KEY_MISMATCH');
 const payload={domain:DOMAIN,snapshot,statement};
 return {payload,signature:sign(null,Buffer.from(canonical(payload)),sourceKey).toString('base64')};
}
export function verifyConsentProposal(pkg,trust,now=Date.now()){
 exact(trust,['format','issuer']);
 if(trust.format!=='sunphi-consent-trust-v1')throw Error('INVALID_TRUST');
 exact(pkg,['payload','signature']);const p=pkg.payload;
 exact(p,['domain','snapshot','statement']);
 exact(p.snapshot,['terms','grant','version','parties','issuer']);
 if(p.domain!==DOMAIN||canonical(p.snapshot.issuer)!==canonical(trust.issuer)||
   !verify(null,Buffer.from(canonical(p)),publicKey(trust.issuer.sourceKey),decode64(pkg.signature,64)))throw Error('UNTRUSTED_PROPOSAL');
 const s=p.statement;
 if(!Number.isSafeInteger(now)||!Number.isSafeInteger(s?.issuedAt)||s.issuedAt>now||s.expiresAt<=now||
   canonical(consentStatement(p.snapshot,s.issuedAt))!==canonical(s))throw Error('INVALID_OR_EXPIRED_PROPOSAL');
 return p;
}
export function signConsentProposal(pkg,trust,actorId,key,now=Date.now()){
 const p=verifyConsentProposal(pkg,trust,now),party=p.snapshot.parties.find(x=>x.actorId===actorId);
 if(!party||party.publicKey!==identity(key).publicKey)throw Error('REGISTERED_PARTY_KEY_REQUIRED');
 return {format:'sunphi-consent-approval-file-v1',proposalHash:digest(p),approval:signConsent(p.statement,party,key)};
}
export function assembleConsents(pkg,trust,files,now=Date.now()){
 const p=verifyConsentProposal(pkg,trust,now);
 if(files.length!==3)throw Error('THREE_APPROVALS_REQUIRED');
 const approvals=files.map(file=>{exact(file,['format','proposalHash','approval']);
   if(file.format!=='sunphi-consent-approval-file-v1'||file.proposalHash!==digest(p))throw Error('PROPOSAL_FILE_MISMATCH');
   return file.approval;
 }).sort((a,b)=>a.payload.role.localeCompare(b.payload.role,'en'));
 const bundle={statement:p.statement,approvals};verifyConsents(bundle,p.snapshot,now);return bundle;
}
