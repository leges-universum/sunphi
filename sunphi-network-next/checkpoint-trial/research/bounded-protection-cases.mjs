// Payment-anchored loss ceilings in the existing authenticated record store.
// A quorum certifies the factual assessment; arithmetic is enforced by consensus.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,publicKey,verify} from '../crypto.mjs';
import {validatorQuorum} from '../authority.mjs';
import {developmentManager} from '../reserve-recovery.mjs';
import {protectionAuthority,protectionEvent} from '../protection-reserve.mjs';
export const ENABLE_CASES='ENABLE_PROTECTION_CASES_V2';
export const CERTIFY_LOSS='CERTIFY_PROTECTION_LOSS_V2';
export const CASE_ACTIONS=[ENABLE_CASES,CERTIFY_LOSS];
export const CASE_HEAD='protection-cases/head';
export const caseKey=pid=>'protection-cases/payment/'+hex(pid);
const amount=x=>{assert(typeof x==='string'&&/^(0|[1-9][0-9]*)$/.test(x));const n=BigInt(x);assert(n<1n<<64n);return n;};
const empty=pid=>({pid,automatic:'0',paid:'0',assessment:null});
// The current payment kernel returns unspent principal and delivers settled
// principal. Its objectively retained loss ceiling is the sender's charged fee.
// Other incident types need a qualified loss source, not a freely chosen UUID.
const lossCeiling=request=>amount(request.status==='SETTLED'?request.intent.fee:request.intent.abortFee);
export const caseRemaining=r=>r?.assessment?amount(r.assessment.grossLoss)-amount(r.assessment.recovered)-amount(r.automatic)-amount(r.paid)-amount(r.assurancePaid??'0'):0n;
export function recordAssuranceRecovery(s,tx,pid,value){
 const r=tx.get(caseKey(pid));assert(value>0n&&value<=caseRemaining(r),'verified loss already recovered');
 const pending=s.money.liability.protection.pending;
 if(pending?.lossPayment===pid)assert(caseRemaining(r)-value>=amount(pending.value),'compensation already reserved');
 r.assurancePaid=String(amount(r.assurancePaid??'0')+value);save(tx,r);
}
export const isProtectionCaseRecord=k=>k===CASE_HEAD||/^protection-cases\/payment\/[a-f0-9]{64}$/.test(k);
function save(tx,r){const h=tx.get(CASE_HEAD),old=tx.get(caseKey(r.pid));assert(h,'case ledger required');if(!old)h.count=integer(h.count+1,1);h.automatic=String(amount(h.automatic)+amount(r.automatic)-amount(old?.automatic??'0'));h.paid=String(amount(h.paid)+amount(r.paid)-amount(old?.paid??'0'));tx.set(caseKey(r.pid),r);tx.set(CASE_HEAD,h);}
function certificate(s,a,c){
 exact(a,['type','certificate','managerConsent']);exact(a.certificate,['body','approvals']);const b=a.certificate.body,r=protectionAuthority(s);
 assert.equal(b.domain,a.type);assert.equal(b.configHash,hash(c));assert.equal(b.configHash,s.configHash);assert.equal(b.network,c.chainId);assert.equal(b.generation,s.authority.generation);assert(!s.authority.pending);
 assert.equal(b.managementEpoch,r.development.access.epoch);assert(!r.development.access.pending);
 integer(b.notBefore,1);integer(b.expires,b.notBefore+1);assert(b.expires-b.notBefore<=600&&s.money.time>=b.notBefore&&s.money.time<b.expires,'case certificate inclusion window');
 validatorQuorum(b,a.certificate.approvals,s.authority.validators);assert(verify(b,a.managerConsent,developmentManager(r)),'case management consent');return b;
}
export function protectionCaseAction(s,a,c,tx){
 const b=certificate(s,a,c),p=s.money.liability.protection;
 const common=['domain','configHash','network','generation','managementEpoch','notBefore','expires'];
 if(a.type===ENABLE_CASES){
  exact(b,common);assert(!p.casePolicy&&!tx.get(CASE_HEAD),'case policy already enabled');assert(!p.pending,'settle or cancel pending legacy order');
  // Never forget earlier payouts, even if outputs were spent or recent events pruned.
  assert.equal(p.compensated,'0','prior automatic compensation requires an audited migration');assert.equal(p.exceptional,'0','prior exceptional payments require an audited migration');
  p.casePolicy={version:2,certificateHash:hash(b),enabledHeight:s.height};tx.set(CASE_HEAD,{...p.casePolicy,count:0,automatic:'0',paid:'0'});
  protectionEvent(s.money,{type:ENABLE_CASES,...p.casePolicy});return s;
 }
 assert.equal(a.type,CERTIFY_LOSS);assert(p.casePolicy,'case policy not enabled');
 exact(b,[...common,'pid','recipient','grossLoss','recovered','evidence','revision']);hex(b.pid);publicKey(b.recipient);hex(b.evidence);integer(b.revision,1);
 const request=s.money.requests[b.pid];assert(request&&['EXPIRED','CANCELLED','SETTLED'].includes(request.status),'retained terminal payment required');assert(!s.money.liability.records[b.pid],'finish automatic compensation first');
 const i=request.intent;assert.equal(i.pid,b.pid);assert.equal(b.recipient,i.sender,'claimant must be the charged sender');
 // A certificate is not permission to include speculative losses or unrelated costs.
 const ceiling=lossCeiling(request);
 assert(amount(b.grossLoss)>0n&&amount(b.grossLoss)<=ceiling,'payment exposure ceiling');
 const r=tx.get(caseKey(b.pid))??empty(b.pid),old=r.assessment;
 assert.equal(b.revision,(old?.revision??0)+1,'assessment revision');
 if(old){assert.equal(b.recipient,old.recipient,'immutable compensation recipient');assert.equal(b.grossLoss,old.grossLoss,'immutable assessed loss');assert(amount(b.recovered)>=amount(old.recovered),'recovery cannot decrease');}
 if(amount(r.automatic)>0n)assert.equal(b.recipient,i.sender,'automatic compensation claimant');
 r.assessment={recipient:b.recipient,grossLoss:b.grossLoss,recovered:b.recovered,evidence:b.evidence,revision:b.revision,certificateHash:hash(b)};
 const remaining=caseRemaining(r);assert(remaining>=0n,'previous compensation exceeds remaining loss');
 if(p.pending?.lossPayment===b.pid)assert(remaining>=amount(p.pending.value),'recovery conflicts with pending compensation');
 save(tx,r);protectionEvent(s.money,{type:CERTIFY_LOSS,pid:b.pid,...r.assessment});return s;
}
export function protectionCaseContext(tx){return {
 resolved(m,record,paid){if(!m.liability.protection.casePolicy||paid===0n)return;const r=tx.get(caseKey(record.pid));assert(!r,'automatic compensation already recorded');save(tx,{...empty(record.pid),automatic:String(paid)});},
 check(s,q){assert(s.money.liability.protection.casePolicy,'case policy required');hex(q.lossPayment);const r=tx.get(caseKey(q.lossPayment));assert(r?.assessment,'certified loss required');assert.equal(q.recipient,r.assessment.recipient,'compensation recipient');assert(amount(q.value)<=caseRemaining(r),'uncompensated loss exceeded');return r;},
 paid(s,q){const r=this.check(s,q);r.paid=String(amount(r.paid)+amount(q.value));save(tx,r);}
};}
export function auditProtectionCaseBinding(get,s){const p=s.money.liability?.protection,h=get(CASE_HEAD);if(!p?.casePolicy){assert(!h,'orphan case policy');return;}assert(h,'missing case ledger');for(const k of ['version','certificateHash','enabledHeight'])assert.equal(h[k],p.casePolicy[k]);assert.equal(h.automatic,p.compensated);assert.equal(h.paid,p.exceptional);}
export function auditProtectionCases(records,s){
 auditProtectionCaseBinding(k=>records.get(k),s);const h=records.get(CASE_HEAD),rows=[...records].filter(([k])=>k.startsWith('protection-cases/')&&k!==CASE_HEAD);if(!h){assert.equal(rows.length,0);return;}
 exact(h,['version','certificateHash','enabledHeight','count','automatic','paid']);integer(h.count);assert.equal(rows.length,h.count);let automatic=0n,paid=0n;
 for(const [k,r]of rows){exact(r,['pid','automatic','paid','assessment',...(r.assurancePaid===undefined?[]:['assurancePaid'])]);assert.equal(k,caseKey(r.pid));const request=s.money.requests[r.pid];assert(request&&['EXPIRED','CANCELLED','SETTLED'].includes(request.status));automatic+=amount(r.automatic);paid+=amount(r.paid);
  if(amount(r.automatic)){assert.equal(request.status,'EXPIRED');assert(amount(r.automatic)<=amount(request.intent.abortFee));}
  if(r.assessment){const a=r.assessment;exact(a,['recipient','grossLoss','recovered','evidence','revision','certificateHash']);publicKey(a.recipient);hex(a.evidence);hex(a.certificateHash);integer(a.revision,1);assert.equal(a.recipient,request.intent.sender);assert(amount(a.grossLoss)>0n&&amount(a.grossLoss)<=lossCeiling(request));assert(caseRemaining(r)>=0n);}
  else assert.equal(r.paid,'0');
 }
 assert.equal(String(automatic),h.automatic);assert.equal(String(paid),h.paid);
 const q=s.money.liability.protection.pending;if(q){assert(q.lossPayment);protectionCaseContext({get:k=>records.get(k)}).check(s,q);}
}
