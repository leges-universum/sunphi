// Optional, prospective ownership credentials. No admission, voting or fee rights.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,publicKey,verify} from '../crypto.mjs';
import {validatorQuorum} from '../authority.mjs';
import {developmentManager} from '../reserve-recovery.mjs';
export const OPERATOR_POLICY='ENABLE_OPERATOR_REWARD_POLICY_V1';
export const OPERATOR_STATUS='SET_OPERATOR_REWARD_STATUS_V1';
export const OPERATOR_ISSUERS='ROTATE_OPERATOR_REWARD_ISSUERS_V1';
export const OPERATOR_LINK='LINK_OPERATOR_REWARD_PROFILE_V1';
export const OPERATOR_ACTIONS=[OPERATOR_POLICY,OPERATOR_STATUS,OPERATOR_ISSUERS,OPERATOR_LINK];
export const OPERATOR_HEAD='operator-rewards/policy';
export const operatorKey=node=>'operator-rewards/status/'+hex(node);
export const operatorLinkKey=node=>'operator-rewards/link/'+hex(node);
const DAY=86400;
export function operatorPolicyAction(s,a,c,tx,author){
 if(a.type===OPERATOR_LINK){
  exact(a,['type','body','signature']);const b=a.body,h=tx.get(OPERATOR_HEAD);assert(h,'operator policy not enabled');
  exact(b,['domain','configHash','node','operator','profileHash','sequence','effectiveFrom','validUntil','automaticLegalUpdates']);
  assert.equal(b.domain,OPERATOR_LINK);assert.equal(b.configHash,s.configHash);hex(b.node);hex(b.operator);hex(b.profileHash);const n=s.rewards?.nodes[b.node];assert(n?.kind==='worker'&&s.money.nodes[b.node],'Linux worker required');assert.equal(author,n.management);assert(verify(b,a.signature,n.management),'node management consent');
  const old=tx.get(operatorLinkKey(b.node));if(old?.lastHash===hash(b))return s;integer(b.sequence,1);assert.equal(b.sequence,(old?.sequence??0)+1);
  integer(b.effectiveFrom,Math.ceil((s.money.time+1)/DAY)*DAY);assert(b.effectiveFrom%DAY===0&&b.effectiveFrom>=h.effectiveFrom&&b.effectiveFrom<=s.money.time+30*DAY);integer(b.validUntil);assert.equal(typeof b.automaticLegalUpdates,'boolean');
  assert(b.validUntil===0||b.validUntil>b.effectiveFrom&&b.validUntil%DAY===0&&b.validUntil<=s.money.time+366*DAY);
  if(old&&old.pending.effectiveFrom>s.money.time){assert.equal(b.validUntil,0,'pending link must take effect first');assert.equal(b.effectiveFrom,old.pending.effectiveFrom);}
  tx.set(operatorLinkKey(b.node),{sequence:b.sequence,lastHash:hash(b),current:old?(old.pending.effectiveFrom>s.money.time?old.current:old.pending):null,pending:b});return s;
 }
 if(a.type===OPERATOR_ISSUERS){
  exact(a,['type','certificate','founderConsent']);exact(a.certificate,['body','approvals']);const b=a.certificate.body,h=tx.get(OPERATOR_HEAD);
  exact(b,['domain','configHash','network','generation','managementEpoch','notBefore','expires','sequence','previousHash','effectiveFrom','issuers']);assert(h,'operator policy not enabled');
  assert.equal(b.domain,OPERATOR_ISSUERS);assert.equal(b.configHash,hash(c));assert.equal(b.configHash,s.configHash);assert.equal(b.network,c.chainId);assert.equal(b.generation,s.authority.generation);assert(!s.authority.pending);
  assert.equal(b.managementEpoch,s.networkReserves.development.access.epoch);assert(!s.networkReserves.development.access.pending);validatorQuorum(b,a.certificate.approvals,s.authority.validators);assert(verify(b,a.founderConsent,developmentManager(s.networkReserves)),'policy management consent');
  if(h.authorityHash===hash(b))return s;
  integer(b.sequence,1);assert.equal(b.sequence,(h.authoritySequence??0)+1);assert.equal(b.previousHash,h.authorityHash??h.certificateHash);
  integer(b.notBefore,1);integer(b.expires,b.notBefore+1);assert(b.expires-b.notBefore<=600&&s.money.time>=b.notBefore&&s.money.time<b.expires,'policy inclusion window');
  integer(b.effectiveFrom,Math.ceil((s.money.time+1)/DAY)*DAY);assert(b.effectiveFrom%DAY===0&&b.effectiveFrom<=s.money.time+30*DAY);assert(!h.pendingAuthority||h.pendingAuthority.effectiveFrom<=s.money.time,'pending authority change');
  assert(Array.isArray(b.issuers)&&b.issuers.length>0&&b.issuers.length<=8&&new Set(b.issuers).size===b.issuers.length);b.issuers.forEach(publicKey);
  tx.set(OPERATOR_HEAD,{...h,issuers:h.pendingAuthority?.issuers??h.issuers,authoritySequence:b.sequence,authorityHash:hash(b),pendingAuthority:{effectiveFrom:b.effectiveFrom,issuers:b.issuers}});return s;
 }
 if(a.type===OPERATOR_POLICY){
  exact(a,['type','certificate','founderConsent']);exact(a.certificate,['body','approvals']);const b=a.certificate.body;
  exact(b,['domain','configHash','network','generation','managementEpoch','notBefore','expires','effectiveFrom','issuers']);
  assert.equal(b.domain,OPERATOR_POLICY);assert.equal(b.configHash,hash(c));assert.equal(b.configHash,s.configHash);assert.equal(b.network,c.chainId);assert.equal(b.generation,s.authority.generation);
  assert(!s.authority.pending);assert.equal(b.managementEpoch,s.networkReserves.development.access.epoch);assert(!s.networkReserves.development.access.pending);
  validatorQuorum(b,a.certificate.approvals,s.authority.validators);assert(verify(b,a.founderConsent,developmentManager(s.networkReserves)),'policy management consent');
  const old=tx.get(OPERATOR_HEAD);if(old){assert.equal(old.certificateHash,hash(b),'operator policy already enabled');return s;}
  integer(b.notBefore,1);integer(b.expires,b.notBefore+1);assert(b.expires-b.notBefore<=600&&s.money.time>=b.notBefore&&s.money.time<b.expires,'policy inclusion window');
  integer(b.effectiveFrom,s.money.time+DAY);assert(b.effectiveFrom%DAY===0,'complete future UTC day');
  assert(Array.isArray(b.issuers)&&b.issuers.length>0&&b.issuers.length<=8&&new Set(b.issuers).size===b.issuers.length);b.issuers.forEach(publicKey);
  tx.set(OPERATOR_HEAD,{version:OPERATOR_POLICY,certificateHash:hash(b),effectiveFrom:b.effectiveFrom,issuers:b.issuers});return s;
 }
 exact(a,['type','credential','issuerSignature','nodeSignature']);assert.equal(a.type,OPERATOR_STATUS);const b=a.credential,h=tx.get(OPERATOR_HEAD);assert(h,'operator policy not enabled');
 exact(b,['domain','configHash','node','operator','profileHash','sequence','effectiveFrom','registeredUntil','legalUntil','reviewedAt','sourceRevision','issuer']);
 assert.equal(b.domain,OPERATOR_STATUS);assert.equal(b.configHash,s.configHash);hex(b.node);hex(b.operator);hex(b.profileHash);publicKey(b.issuer);
 const issuers=h.pendingAuthority&&s.money.time>=h.pendingAuthority.effectiveFrom?h.pendingAuthority.issuers:h.issuers;
 assert(issuers.includes(b.issuer)&&verify(b,a.issuerSignature,b.issuer),'authorized source signature');
 const n=s.rewards?.nodes[b.node];assert(n?.kind==='worker'&&s.money.nodes[b.node],'Linux worker required');
 const old=tx.get(operatorKey(b.node));
 if(old?.lastHash===hash(b)){assert(author===b.issuer||author===n.management,'status author');return s;}
 integer(b.sequence,1);assert.equal(b.sequence,(old?.sequence??0)+1,'status sequence');integer(b.sourceRevision,1);
 // Withdrawals cannot need the operator's cooperation; promotions and changes
 // of identity always require the registered node management key as well.
 const revoke=b.registeredUntil===0&&b.legalUntil===0;
 const reduction=old&&b.operator===old.pending.operator&&b.profileHash===old.pending.profileHash&&b.registeredUntil<=old.pending.registeredUntil&&b.legalUntil<=old.pending.legalUntil&&(b.reviewedAt===0||b.reviewedAt===old.pending.reviewedAt);
 const consent=operatorLinkAt(tx.get,b.node,b.effectiveFrom),automatic=consent&&consent.operator===b.operator&&consent.profileHash===b.profileHash&&consent.validUntil>=b.registeredUntil&&(!b.legalUntil||consent.automaticLegalUpdates);
 assert(author===b.issuer||author===n.management,'status author');
 assert(reduction||automatic||verify(b,a.nodeSignature,n.management),'node management consent');
 integer(b.effectiveFrom,Math.ceil((s.money.time+1)/DAY)*DAY);assert(b.effectiveFrom%DAY===0&&b.effectiveFrom<=s.money.time+30*DAY,'prospective UTC boundary');
 assert(b.effectiveFrom>=h.effectiveFrom);
 if(old){if(old.pending.effectiveFrom>s.money.time){assert(reduction,'pending status must take effect first');assert.equal(b.effectiveFrom,old.pending.effectiveFrom,'withdraw pending status at its original boundary');}else assert(b.effectiveFrom>old.pending.effectiveFrom);if(old.pending.operator===b.operator)assert(b.sourceRevision>old.pending.sourceRevision,'source revision rollback');}
 for(const t of [b.registeredUntil,b.legalUntil,b.reviewedAt])integer(t);
 if(!revoke){assert(b.registeredUntil>b.effectiveFrom&&b.registeredUntil%DAY===0&&b.registeredUntil<=s.money.time+366*DAY,'bounded registration validity');}
 if(b.legalUntil){assert(b.reviewedAt>0&&b.reviewedAt<=s.money.time&&b.legalUntil>b.effectiveFrom&&b.legalUntil%DAY===0&&b.legalUntil<=b.registeredUntil,'legal validity');
  const end=new Date(b.reviewedAt*1000);end.setUTCFullYear(end.getUTCFullYear()+1);assert(b.legalUntil<=Math.floor(end.getTime()/1000),'annual legal renewal required');
 }else assert.equal(b.reviewedAt,0);
 tx.set(operatorKey(b.node),{sequence:b.sequence,lastHash:hash(b),current:old?(old.pending.effectiveFrom>s.money.time?old.current:old.pending):null,pending:b});return s;
}
export function operatorFactor(get,node,day){
 const h=get(OPERATOR_HEAD);if(!h||day<h.effectiveFrom)return 2;
 const r=get(operatorKey(node));if(!r)return 2;const v=day>=r.pending.effectiveFrom?r.pending:r.current;
 if(!v||day<v.effectiveFrom||v.registeredUntil<day+DAY)return 2;
 const link=get(operatorLinkKey(node));if(link&&day>=(link.current?.effectiveFrom??link.pending.effectiveFrom)){const b=operatorLinkAt(get,node,day);if(!b||b.validUntil<day+DAY||b.operator!==v.operator||b.profileHash!==v.profileHash)return 2;if(!b.automaticLegalUpdates)return 3;}
 return v.legalUntil>=day+DAY?4:3;
}
export function operatorPolicyActive(get,day){const h=get(OPERATOR_HEAD);return !!h&&day>=h.effectiveFrom;}
export function operatorLinkAt(get,node,at){const r=get(operatorLinkKey(node));if(!r)return null;const b=at>=r.pending.effectiveFrom?r.pending:r.current;return b&&b.effectiveFrom<=at?b:null;}
export function isOperatorRecord(k){return k===OPERATOR_HEAD||/^operator-rewards\/(status|link)\/[a-f0-9]{64}$/.test(k);}
// Offline structural audit; signature provenance is in the authenticated archive.
export function auditOperatorRewards(records,s){
 const h=records.get(OPERATOR_HEAD),rows=[...records].filter(([k])=>k.startsWith('operator-rewards/'));
 if(!h){assert.equal(rows.length,0,'orphan operator records');return;}
 exact(h,['version','certificateHash','effectiveFrom','issuers',...(h.pendingAuthority?['authoritySequence','authorityHash','pendingAuthority']:[])]);
 assert.equal(h.version,OPERATOR_POLICY);hex(h.certificateHash);integer(h.effectiveFrom,1);assert.equal(h.effectiveFrom%DAY,0);
 const keys=xs=>{assert(Array.isArray(xs)&&xs.length>0&&xs.length<=8&&new Set(xs).size===xs.length);xs.forEach(publicKey);};keys(h.issuers);
 if(h.pendingAuthority){integer(h.authoritySequence,1);hex(h.authorityHash);exact(h.pendingAuthority,['effectiveFrom','issuers']);integer(h.pendingAuthority.effectiveFrom,1);assert.equal(h.pendingAuthority.effectiveFrom%DAY,0);keys(h.pendingAuthority.issuers);}
 for(const [k,r]of rows){if(k===OPERATOR_HEAD)continue;assert(isOperatorRecord(k));const node=k.split('/')[2];assert.equal(s.rewards?.nodes[node]?.kind,'worker');exact(r,['sequence','lastHash','current','pending']);integer(r.sequence,1);hex(r.lastHash);assert.equal(r.lastHash,hash(r.pending));assert.equal(r.sequence,r.pending.sequence);
  if(k.startsWith('operator-rewards/link/')){for(const b of [r.current,r.pending].filter(Boolean)){exact(b,['domain','configHash','node','operator','profileHash','sequence','effectiveFrom','validUntil','automaticLegalUpdates']);assert.equal(b.domain,OPERATOR_LINK);assert.equal(b.configHash,s.configHash);assert.equal(b.node,node);hex(b.operator);hex(b.profileHash);integer(b.sequence,1);integer(b.effectiveFrom,h.effectiveFrom);assert.equal(b.effectiveFrom%DAY,0);integer(b.validUntil);assert.equal(b.validUntil%DAY,0);assert(b.validUntil===0||b.validUntil>b.effectiveFrom);assert.equal(typeof b.automaticLegalUpdates,'boolean');}if(r.current){assert(r.current.sequence<r.sequence);assert(r.current.effectiveFrom<r.pending.effectiveFrom);}continue;}
  for(const b of [r.current,r.pending].filter(Boolean)){exact(b,['domain','configHash','node','operator','profileHash','sequence','effectiveFrom','registeredUntil','legalUntil','reviewedAt','sourceRevision','issuer']);assert.equal(b.domain,OPERATOR_STATUS);assert.equal(b.configHash,s.configHash);assert.equal(b.node,node);hex(b.operator);hex(b.profileHash);publicKey(b.issuer);integer(b.sequence,1);integer(b.sourceRevision,1);integer(b.effectiveFrom,h.effectiveFrom);assert.equal(b.effectiveFrom%DAY,0);
   for(const t of [b.registeredUntil,b.legalUntil,b.reviewedAt])integer(t);assert.equal(b.registeredUntil%DAY,0);assert.equal(b.legalUntil%DAY,0);assert(b.legalUntil<=b.registeredUntil);if(b.registeredUntil)assert(b.registeredUntil>b.effectiveFrom);
   if(b.legalUntil){assert(b.reviewedAt>0&&b.reviewedAt<b.effectiveFrom&&b.legalUntil>b.effectiveFrom);const end=new Date(b.reviewedAt*1000);end.setUTCFullYear(end.getUTCFullYear()+1);assert(b.legalUntil<=Math.floor(end.getTime()/1000));}else assert.equal(b.reviewedAt,0);
  }if(r.current){assert(r.current.sequence<r.sequence);assert(r.current.effectiveFrom<r.pending.effectiveFrom);}
 }
}
