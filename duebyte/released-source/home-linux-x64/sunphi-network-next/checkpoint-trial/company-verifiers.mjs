import assert from 'node:assert/strict';
import {exact,verify,integer} from './crypto.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const kinds=['bank','insurance','logistics','investment','legal'];
const scopes=['company_registration','representative_authority'];
const statuses=['confirmed','inconclusive','revoked'];
const subject=id=>assert(typeof id==='string'&&/^[A-Za-z0-9_-]{10,96}$/.test(id),'Invalid company reference.');
export function verifyIssuer(issuer,packet,time,requireActive,includeCompromised=false){
 const b=packet.body;
 assert(issuer?.id===b.issuer&&kinds.includes(issuer.profession),'Unknown institution.');
 const key=issuer.keys.find(k=>k.public_key===packet.key);
 assert(key&&(includeCompromised||!key.compromised)&&key.valid_from<=b.issued&&(!key.valid_until||b.issued<key.valid_until),'Untrusted issuing key.');
 assert(b.issued<=time&&verify(b,packet.signature,packet.key),'Invalid institutional signature.');
 if(requireActive)assert(issuer.enabled&&(!key.valid_until||time<key.valid_until),'Institution or key no longer active.');
}
export function checkAssertionBody(b){
 exact(b,['domain','issuer','reference','subject','scope','sourceRevision','revision','status','issued','expires']);
 assert(b.domain==='DUEBYTE_COMPANY_ATTESTATION_V1'&&UUID.test(b.reference)&&UUID.test(b.issuer));
 subject(b.subject);assert(scopes.includes(b.scope)&&statuses.includes(b.status));
 integer(b.sourceRevision,1);integer(b.revision,1);integer(b.issued,1);integer(b.expires,b.issued+1);
 return b;
}
export function checkPublicAssertion(packet,issuer,now,requireActive=false){
 exact(packet,['body','key','signature']);const b=checkAssertionBody(packet.body);
 verifyIssuer(issuer,packet,now,requireActive);return b;
}
export function publicReviewRows(record,expected,now){
 assert(record?.subject===expected&&Array.isArray(record.entries)&&record.entries.length<=200);
 integer(record.checkedAt,1);assert(record.checkedAt<=now+5&&now-record.checkedAt<=60,'Refresh verifier status.');
 const seen=new Set();
 return record.entries.map(({issuer,packet,sourceCurrent})=>{
  exact(packet,['body','key','signature']);const b=checkAssertionBody(packet.body);
  verifyIssuer(issuer,packet,now,false,true);assert.equal(b.subject,expected);
  const id=b.issuer+'/'+b.reference;assert(!seen.has(id),'Duplicate public review.');seen.add(id);
  const compromised=issuer.keys.find(k=>k.public_key===packet.key).compromised;
  const status=compromised?'issuer key compromised':b.status==='revoked'?'revoked':!issuer.enabled?'issuer suspended':b.expires<=now?'expired':sourceCurrent!==true?'source requires review':b.status;
  return {issuer:issuer.registered_name,issuerId:issuer.id,profession:issuer.profession,jurisdiction:issuer.jurisdiction,
   scope:b.scope,status,issued:b.issued,expires:b.expires,revision:b.revision,reference:b.reference,packet};
 });
}
