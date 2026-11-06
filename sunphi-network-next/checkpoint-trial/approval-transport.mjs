// Authenticated messenger transports decisions; consensus remains spending authority.
import assert from 'node:assert/strict';
import{randomBytes}from'node:crypto';
import{hash,sign,verify,exact,integer,publicKey,hex}from'./crypto.mjs';
import{validateIntentShape}from'./payment-model.mjs';
import{PROTECTION,spendPolicy,protectionEnabled,approvalBody,checkApproval}from'./spend-protection.mjs';
export const APPROVAL_TRANSPORT='DUEBYTE_SUNPHI_APPROVAL_TRANSPORT_V1';
export function approvalTransportRequest(config,key,kind,payload,now=Math.floor(Date.now()/1000)){
 const body={domain:APPROVAL_TRANSPORT+'/REQUEST',network:config.chainId,configHash:hash(config),wallet:key.publicKey,nonce:randomBytes(32).toString('hex'),kind,payload,issuedAt:now,expires:now+600};return{body,signature:sign(body,key.privateKey)};
}
export function verifyApprovalRequest(packet,state,pins,now=Math.floor(Date.now()/1000)){
 exact(packet,['body','signature']);const b=packet.body;exact(b,['domain','network','configHash','wallet','nonce','kind','payload','issuedAt','expires']);
 assert.equal(b.domain,APPROVAL_TRANSPORT+'/REQUEST');assert.equal(b.network,pins.root.network);assert.equal(b.configHash,pins.configHash);assert.equal(state.configHash,b.configHash);publicKey(b.wallet);hex(b.nonce);
 integer(b.issuedAt,1);integer(b.expires,b.issuedAt+1);assert(b.expires-b.issuedAt<=600&&b.issuedAt<=now+30&&now<b.expires,'approval request expired');assert(verify(b,packet.signature,b.wallet),'wallet request signature');
 assert(protectionEnabled(state),'network approval not activated');const old=spendPolicy(state,b.wallet),p=b.payload;
 assert(!old?.pending,'recovery pending');
 if(b.kind==='payment'){
  exact(p,['intent','approval']);validateIntentShape(p.intent);assert.equal(p.intent.sender,b.wallet);assert(old?.enabled,'wallet protection required');assert(!state.money.requests[p.intent.pid],'payment already submitted');assert(state.money.height<p.intent.lastReserve,'payment admission expired');
  assert.deepEqual(p.approval,{...approvalBody(state,p.intent,p.approval.expires),issuedAt:p.approval.issuedAt});integer(p.approval.issuedAt,1);assert(p.approval.issuedAt<=state.money.time&&p.approval.expires<=b.expires&&p.approval.expires>state.money.time&&p.approval.expires-p.approval.issuedAt<=600,'approval interval');
 }else{
  assert.equal(b.kind,'policy');exact(p,['enabled','version','recoveryDelay']);assert(typeof p.enabled==='boolean');assert.equal(p.version,(old?.version??0)+1);integer(p.recoveryDelay,86400);assert(p.recoveryDelay<=2592000);if(!old)assert(p.enabled,'first policy must enable');
  assert(Object.values(state.money.outputs).some(o=>o.owner===b.wallet&&BigInt(o.value)>0n)||old,'funded wallet required');
 }
 return{id:hash(packet),wallet:b.wallet,network:b.network,expires:b.expires,policy:old?structuredClone(old):null,request:packet};
}
export function verifyApprovalDecision(context,response){
 exact(response,['request','decision','body','signatures']);assert.equal(response.request,context.id);assert(['approve','reject'].includes(response.decision));const q=context.request.body,old=context.policy;
 exact(response.signatures,['approver','current','recovery']);
 if(response.decision==='reject'){
  assert.equal(response.body,null);assert.equal(response.signatures.current,null);assert.equal(response.signatures.recovery,null);
  if(old)assert(verify({domain:APPROVAL_TRANSPORT+'/REJECT',request:context.id},response.signatures.approver,old.approver),'rejection signature');else assert.equal(response.signatures.approver,null);
  return response;
 }
 if(q.kind==='payment'){
  assert.deepEqual(response.body,q.payload.approval);assert.equal(response.signatures.current,null);assert.equal(response.signatures.recovery,null);assert(verify(response.body,response.signatures.approver,old.approver),'payment approval signature');
 }else{
  const b=response.body;exact(b,['domain','configHash','wallet','version','issuedAt','expires','policy']);
  assert.equal(b.domain,PROTECTION+'/SET_SPEND_POLICY_V1');assert.equal(b.configHash,q.configHash);assert.equal(b.wallet,q.wallet);assert.equal(b.version,q.payload.version);assert.equal(b.issuedAt,q.issuedAt);assert.equal(b.expires,q.expires);
  exact(b.policy,['version','enabled','approver','recovery','recoveryDelay']);assert.equal(b.policy.version,b.version);assert.equal(b.policy.enabled,q.payload.enabled);assert.equal(b.policy.recoveryDelay,q.payload.recoveryDelay);publicKey(b.policy.approver);publicKey(b.policy.recovery);assert.notEqual(b.policy.approver,b.policy.recovery);assert(![b.policy.approver,b.policy.recovery].includes(q.wallet));
  if(old){assert.equal(b.policy.approver,old.approver,'key rotation requires recovery workflow');assert.equal(b.policy.recovery,old.recovery);assert(verify(b,response.signatures.current,old.approver),'current approver required');assert.equal(response.signatures.recovery,null);}
  else{assert.equal(response.signatures.current,null);assert(verify(b,response.signatures.recovery,b.policy.recovery),'offline recovery possession');}
  assert(verify(b,response.signatures.approver,b.policy.approver),'device possession');
 }
 return response;
}
export function decisionPaymentApproval(context,response,state){
 verifyApprovalDecision(context,response);assert.equal(context.request.body.kind,'payment');assert.equal(response.decision,'approve');const approval={body:response.body,signature:response.signatures.approver};checkApproval(state,context.request.body.payload.intent,approval);return approval;
}
