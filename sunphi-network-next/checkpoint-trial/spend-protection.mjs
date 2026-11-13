// Opt-in, consensus-enforced approval. Messenger is transport, never a spend key.
import assert from 'node:assert/strict';
import {hash,exact,integer,publicKey,verify} from './crypto.mjs';
export const PROTECTION='DUEBYTE_SPEND_PROTECTION_V1';
export const PROTECTION_ACTIONS=['SET_SPEND_POLICY_V1','RECOVER_SPEND_POLICY_V1','CANCEL_SPEND_RECOVERY_V1'];
export const protectionEnabled=s=>!!s.authority?.spendProtection&&s.height>=s.authority.spendProtection.activation;
export const spendPolicy=(s,wallet)=>s.spendPolicies?.[wallet]??null;
function fields(p){
 exact(p,['version','enabled','approver','recovery','recoveryDelay']);integer(p.version,1);assert(typeof p.enabled==='boolean');publicKey(p.approver);publicKey(p.recovery);
 integer(p.recoveryDelay,86400);assert(p.recoveryDelay<=30*86400,'recovery delay limit');assert.notEqual(p.approver,p.recovery,'independent recovery key');
}
const policyFields=p=>({version:p.version,enabled:p.enabled,approver:p.approver,recovery:p.recovery,recoveryDelay:p.recoveryDelay});
export function approvalBody(s,intent,expires){
 const p=spendPolicy(s,intent.sender);assert(p?.enabled,'protected wallet required');
 return {domain:PROTECTION+'/PAYMENT',configHash:s.configHash,wallet:intent.sender,policyVersion:p.version,intentHash:hash(intent),issuedAt:s.money.time,expires};
}
export function checkApproval(s,intent,approval){
 const p=spendPolicy(s,intent.sender);if(!p?.enabled){assert(!approval,'unexpected payment approval');return;}
 assert(protectionEnabled(s),'spend protection not active');exact(approval,['body','signature']);const b=approval.body;
 exact(b,['domain','configHash','wallet','policyVersion','intentHash','issuedAt','expires']);
 assert.equal(b.domain,PROTECTION+'/PAYMENT');assert.equal(b.configHash,s.configHash);assert.equal(b.wallet,intent.sender);assert.equal(b.policyVersion,p.version,'approval policy changed');assert.equal(b.intentHash,hash(intent),'approved payment changed');
 integer(b.issuedAt);integer(b.expires,b.issuedAt+1);assert(b.expires-b.issuedAt<=900&&b.issuedAt<=s.money.time&&s.money.time<b.expires,'approval expired or future');
 assert(verify(b,approval.signature,p.approver),'payment approval signature');
}
export function applySpendPolicy(base,action,author,{hasOutput=wallet=>Object.values(base.money.outputs).some(o=>o.owner===wallet&&BigInt(o.value)>0n)}={}){
 assert(protectionEnabled(base),'spend protection not activated');exact(action,['type','body','signatures']);
 const b=action.body,common=['domain','configHash','wallet','version','issuedAt','expires'];
 exact(b,action.type==='CANCEL_SPEND_RECOVERY_V1'?common:[...common,'policy']);
 assert.equal(b.domain,PROTECTION+'/'+action.type);assert.equal(b.configHash,base.configHash);publicKey(b.wallet);assert.equal(author,b.wallet,'wallet authority');
 integer(b.version,1);integer(b.issuedAt);integer(b.expires,b.issuedAt+1);assert(b.expires-b.issuedAt<=900&&b.issuedAt<=base.money.time&&base.money.time<b.expires,'policy request expired or future');
 const old=spendPolicy(base,b.wallet);assert.equal(b.version,(old?.version??0)+1,'policy version');
 const sig=action.signatures;exact(sig,['wallet','current','approver','recovery']);assert(verify(b,sig.wallet,b.wallet),'wallet policy signature');
 const s={...base,spendPolicies:{...base.spendPolicies}};
 if(action.type==='CANCEL_SPEND_RECOVERY_V1'){
  assert(old?.pending,'no recovery pending');assert.equal(sig.approver,null);assert.equal(sig.recovery,null);assert(verify(b,sig.current,old.approver),'current approval required');
  s.spendPolicies[b.wallet]={...old,version:b.version,pending:null};return s;
 }
 fields(b.policy);assert.equal(b.policy.version,b.version);assert(![b.policy.approver,b.policy.recovery].includes(b.wallet),'separate approval and recovery keys');
 assert(verify(b,sig.approver,b.policy.approver),'new approver possession');
 // Reusing an established recovery key needs no new signature from the offline
 // backup. Changing the key still requires proof of possession of the new key.
 if(old?.recovery===b.policy.recovery&&sig.recovery===null){}
 else assert(verify(b,sig.recovery,b.policy.recovery),'new recovery possession');
 if(action.type==='RECOVER_SPEND_POLICY_V1'){
  assert(old&&!old.pending,'recovery unavailable');assert(verify(b,sig.current,old.recovery),'recovery signature');
  s.spendPolicies[b.wallet]={...old,pending:{activateAt:integer(base.money.time+old.recoveryDelay,1),policy:structuredClone(b.policy)}};
 }else{
  assert.equal(action.type,'SET_SPEND_POLICY_V1');assert(!old?.pending,'cancel pending recovery first');
  if(old)assert(verify(b,sig.current,old.approver),'current approval required');
  else {assert.equal(sig.current,null);assert(b.policy.enabled,'first policy must enable protection');assert(Object.keys(s.spendPolicies).length<128,'trial protected-wallet capacity');assert(hasOutput(b.wallet),'funded wallet required');}
  s.spendPolicies[b.wallet]={...structuredClone(b.policy),pending:null};
 }
 auditSpendPolicies(s);return s;
}
export function advanceSpendPolicies(s){
 if(!s.spendPolicies)return s;const due=Object.entries(s.spendPolicies).filter(([,p])=>p.pending&&p.pending.activateAt<=s.money.time);if(!due.length)return s;
 const out={...s,spendPolicies:{...s.spendPolicies}};for(const [wallet,p]of due)out.spendPolicies[wallet]={...p.pending.policy,pending:null};return out;
}
export function auditSpendPolicies(s){
 if(!s.spendPolicies)return;assert(protectionEnabled(s),'protected state before activation');assert(Object.keys(s.spendPolicies).length<=128);
 for(const [wallet,p]of Object.entries(s.spendPolicies)){publicKey(wallet);exact(p,['version','enabled','approver','recovery','recoveryDelay','pending']);fields(policyFields(p));assert(![p.approver,p.recovery].includes(wallet));
  if(p.pending){exact(p.pending,['activateAt','policy']);integer(p.pending.activateAt,s.money.time+1);fields(p.pending.policy);assert.equal(p.pending.policy.version,p.version+1);assert(![p.pending.policy.approver,p.pending.policy.recovery].includes(wallet));}
 }
}
