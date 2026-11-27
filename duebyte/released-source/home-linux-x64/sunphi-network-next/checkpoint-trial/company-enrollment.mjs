import assert from 'node:assert/strict';
import {exact,hash,hex,integer,publicKey,verify} from './crypto.mjs';
import {checkAssertionBody,publicReviewRows} from './company-verifiers.mjs';

export const COMPANY_POLICY='SET_CORPORATE_REGISTRAR_V1';
export const REGISTER_COMPANY='REGISTER_CORPORATE_ACCOUNT_V1';
export const APPOINT_COMPANY='APPOINT_CORPORATE_REPRESENTATIVE_V1';
export const REVOKE_COMPANY='REVOKE_CORPORATE_REPRESENTATIVE_V1';
export const companyOperations=[REGISTER_COMPANY,APPOINT_COMPANY,REVOKE_COMPANY];
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function checkRegistrarTerms(t){
 exact(t,['previous','institution','key']);
 if(t.previous!==null)hex(t.previous);
 assert(uuid.test(t.institution));
 if(t.key!==null)publicKey(t.key);
}
export function setRegistrar(s,terms,decision){
 checkRegistrarTerms(terms);hex(decision);
 assert.equal(terms.previous,s.companyRegistry?.decision??null,'Registrar decision changed.');
 return {...s,companyRegistry:{decision,institution:terms.institution,key:terms.key,accounts:s.companyRegistry?.accounts??{}}};
}
export function accountConfig(s,c){
 return s.companyRegistry?{...c,companyAccounts:{...c.companyAccounts,...s.companyRegistry.accounts}}:c;
}
export function auditCompanyRegistry(s){
 const r=s.companyRegistry;if(!r)return;
 exact(r,['decision','institution','key','accounts']);hex(r.decision);
 checkRegistrarTerms({previous:null,institution:r.institution,key:r.key});
 const subjects=new Set();
 assert(Object.getPrototypeOf(r.accounts)===Object.prototype&&Object.keys(r.accounts).length<=64);
 for(const [address,account] of Object.entries(r.accounts)){
  publicKey(address);exact(account,['companyHash','issuer','decision','registrationProof','authorityProof']);publicKey(account.issuer);
  for(const digest of [account.companyHash,account.decision,account.registrationProof,account.authorityProof])hex(digest);
  assert(!subjects.has(account.companyHash)&&s.companyMandates?.[address],'Each registered company needs a unique account and a mandate revision.');
  subjects.add(account.companyHash);
 }
}
export function validateBinding(b,now){
 exact(b,['type','configHash','decision','account','companyHash','revision','holder','limitMicro','expires','issued','registrationProof','authorityProof']);
 assert([REGISTER_COMPANY,APPOINT_COMPANY].includes(b.type));publicKey(b.account);publicKey(b.holder);
 for(const v of [b.configHash,b.decision,b.companyHash,b.registrationProof,b.authorityProof])hex(v);
 integer(b.revision,1);integer(b.issued,1);integer(b.expires,b.issued+1);
 assert(b.issued<=now&&now-b.issued<=300&&b.expires>now,'Refresh the legal authorization.');
 assert(typeof b.limitMicro==='string'&&/^[1-9][0-9]{0,18}$/.test(b.limitMicro));
}

// The registrar signs only after the current manual reviews and their disclosure
// authorization have been read. Only their digests are delivered to consensus.
export function verifyBindingReviews(body,record,institution,key,now){
 validateBinding(body,now);
 assert.equal(hash(record.subject),body.companyHash);
 const rows=publicReviewRows(record,record.subject,now);
 for(const [scope,digest] of [['company_registration',body.registrationProof],['representative_authority',body.authorityProof]]){
  const row=rows.find(r=>r.scope===scope&&r.issuerId===institution&&hash(r.packet)===digest);
  assert(row?.status==='confirmed'&&row.profession==='legal'&&row.packet.key===key&&row.expires>=body.expires,'Current legal review required for '+scope+'.');
  const entry=record.entries.find(e=>e.packet===row.packet);
  assert.equal(entry.issuer.evidence_source,'legal_review');
  const signingKey=entry.issuer.keys.find(k=>k.public_key===key);
  assert(!signingKey.valid_until||signingKey.valid_until>=body.expires,'Registrar key expires before the mandate.');
  checkAssertionBody(row.packet.body);
 }
}

export function applyCompanyRegistration(s,a,author,activeRequests){
 const registry=s.companyRegistry;
 assert(registry,'Corporate registration requires an adopted registrar decision.');
 if(a.type===REVOKE_COMPANY){
  exact(a,['type','account','revision']);publicKey(a.account);integer(a.revision,1);
  const prior=s.companyMandates?.[a.account];
  assert(Object.hasOwn(registry.accounts,a.account)&&prior?.active&&a.revision===prior.revision+1,'Refresh the active mandate.');
  assert(author===a.account||author===registry.key,'Account or legal registrar signature required.');
  return {...s,companyMandates:{...s.companyMandates,[a.account]:{...prior,revision:a.revision,active:false}}};
 }
 exact(a,['type','body','registrarSignature']);const b=a.body;
 validateBinding(b,s.money.time);
 assert.equal(b.type,a.type);assert.equal(b.configHash,s.configHash);assert.equal(b.decision,registry.decision);
 assert.equal(author,b.account,'Corporate wallet consent required.');
 assert(registry.key&&b.account!==registry.key&&b.holder!==registry.key&&verify(b,a.registrarSignature,registry.key),'Legal registrar signature required.');
 const old=registry.accounts[b.account];
 if(a.type===REGISTER_COMPANY){
  assert(!old&&Object.keys(registry.accounts).length<64,'Account already registered or pilot capacity reached.');
  assert(!Object.values(registry.accounts).some(r=>r.companyHash===b.companyHash),'Company already registered.');
  assert(!Object.keys(activeRequests).some(id=>s.money.requests[id].intent.sender===b.account),'Settle pending outgoing payments before registration.');
 }else assert(old?.companyHash===b.companyHash,'Registered corporate account required.');
 assert.equal(b.revision,(s.companyMandates?.[b.account]?.revision??0)+1,'Refresh mandate revision.');
 const registration={companyHash:b.companyHash,issuer:registry.key,decision:b.decision,registrationProof:b.registrationProof,authorityProof:b.authorityProof};
 const mandate={revision:b.revision,active:true,holder:b.holder,limitMicro:b.limitMicro,expires:b.expires};
 return {...s,companyRegistry:{...registry,accounts:{...registry.accounts,[b.account]:registration}},companyMandates:{...s.companyMandates,[b.account]:mandate}};
}
