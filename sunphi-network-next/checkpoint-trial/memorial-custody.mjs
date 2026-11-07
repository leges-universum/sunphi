// Unissued memorial custody. Succession changes management, never balances.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,publicKey,verify} from './crypto.mjs';
import {memorialAware,memorialPolicy} from './economic-policy-v3.mjs';
import {memorialContractPaid} from './native-contracts.mjs';
export const MEMORIAL_ACTIONS = ['PUBLISH_MEMORIAL_SUCCESSION_V1','CANCEL_MEMORIAL_SUCCESSION_V1','EXECUTE_MEMORIAL_SUCCESSION_V1'];
export function initialMemorialCustody(manager) {
  publicKey(manager);
  return {manager,epoch:0,sequence:0,issued:false,balanceMicro:'0',transferred:false,
    pending:null,last:null,history:hash({domain:'DUEBYTE_MEMORIAL_CUSTODY_V1',manager})};
}
function validateDecision(d,s) {
  exact(d,['body','signature','successorConsent','manager']);publicKey(d.manager);
  const b=d.body;
  exact(b,['domain','configHash','planHash','managerEpoch','sequence','successor','effectiveAt','expiresAt','publicDecision','reference']);
  assert.equal(b.domain,'DUEBYTE_MEMORIAL_SUCCESSION_V1');assert.equal(b.configHash,s.configHash);
  assert.equal(b.planHash,s.economicPreparation.planHash);integer(b.managerEpoch);integer(b.sequence,1);
  publicKey(b.successor);assert.notEqual(b.successor,d.manager);hex(b.reference);
  assert.notEqual(b.successor,memorialPolicy(s.configHash).account,'program account cannot manage itself');
  integer(b.effectiveAt,1);integer(b.expiresAt,b.effectiveAt);
  assert(b.expiresAt<=8000000000000,'UTC limit');
  assert(typeof b.publicDecision==='string'&&b.publicDecision.trim().length>0&&b.publicDecision.length<=512&&!/[\u0000-\u001f]/.test(b.publicDecision),'public succession decision');
  assert(verify(b,d.signature,d.manager),'authenticated public decision');
  assert(verify(b,d.successorConsent,b.successor),'successor possession and consent');
}
export function auditMemorialCustody(s) {
  const e=s.economicPreparation,m=e?.memorial;
  if(!memorialAware(e?.plan.version)){assert(!m);return;}
  exact(m,['manager','epoch','sequence','issued','balanceMicro','transferred','pending','last','history']);
  publicKey(m.manager);integer(m.epoch);integer(m.sequence);hex(m.history);
  const issued=Boolean(s.centuryFunds?.execution),paid=memorialContractPaid(s),allocation=issued?BigInt(e.plan.memorialMicro):0n;assert(paid<=allocation);assert.equal(m.issued,issued);assert.equal(m.balanceMicro,String(allocation-paid));assert.equal(m.transferred,paid>0n);
  const account=memorialPolicy(s.configHash).account;assert.notEqual(m.manager,account);
  const held=Object.values(s.money.outputs).filter(o=>o.owner===account).reduce((n,o)=>n+BigInt(o.value),0n);
  assert.equal(held,BigInt(m.balanceMicro),'memorial custody reconciliation');
  assert(!Object.values(s.money.requests).some(q=>q.intent.sender===account||q.intent.recipient===account),'memorial rejects ordinary payment history');
  if(m.pending){validateDecision(m.pending,s);assert.equal(m.pending.manager,m.manager);
    assert.equal(m.pending.body.managerEpoch,m.epoch);assert.equal(m.pending.body.sequence,m.sequence);}
  if(m.last){exact(m.last,['decision','status','at']);validateDecision(m.last.decision,s);
    assert(['CANCELLED','EXECUTED'].includes(m.last.status));integer(m.last.at);
    assert(m.last.at<=s.money.time);assert(m.last.decision.body.sequence<=m.sequence);
    if(m.last.status==='EXECUTED'){assert.equal(m.last.decision.body.managerEpoch+1,m.epoch);
      assert.equal(m.last.decision.body.successor,m.manager);assert(m.last.at>=m.last.decision.body.effectiveAt&&m.last.at<=m.last.decision.body.expiresAt);}}
}
export function checkMemorialPayment(s,intent) {
  const account=memorialPolicy(s.configHash).account;
  assert(intent.sender!==account&&intent.recipient!==account,'memorial rejects ordinary transfers');
}
export function applyMemorialAction(base,a,author) {
  assert(memorialAware(base.economicPreparation?.plan.version),'memorial preparation required');
  auditMemorialCustody(base);
  const s=structuredClone(base),m=s.economicPreparation.memorial,now=s.money.time;
  if(a.type==='PUBLISH_MEMORIAL_SUCCESSION_V1'){
    exact(a,['type','body','signature','successorConsent']);assert.equal(author,m.manager,'current memorial manager');
    const d={body:a.body,signature:a.signature,successorConsent:a.successorConsent,manager:author};validateDecision(d,s);
    assert.equal(a.body.managerEpoch,m.epoch,'management epoch');
    if(m.pending&&hash(m.pending)===hash(d))return base;
    assert(!m.pending,'cancel the prior public decision first');assert.equal(a.body.sequence,m.sequence+1,'succession sequence');
    assert(a.body.effectiveAt>=now&&a.body.expiresAt>=now,'decision inclusion window');
    m.sequence=a.body.sequence;m.pending=structuredClone(d);
  }else{
    assert(MEMORIAL_ACTIONS.includes(a.type));exact(a,['type','managementEpoch','sequence','decisionHash']);hex(a.decisionHash);
    if(a.type==='EXECUTE_MEMORIAL_SUCCESSION_V1'&&!m.pending&&m.last?.status==='EXECUTED'&&m.last.decision.body.sequence===a.sequence&&hash(m.last.decision)===a.decisionHash&&m.last.decision.body.managerEpoch===a.managementEpoch)return base;
    assert.equal(a.managementEpoch,m.epoch,'management epoch');
    const p=m.pending;assert(p&&p.body.sequence===a.sequence&&hash(p)===a.decisionHash,'public decision match');
    if(a.type==='CANCEL_MEMORIAL_SUCCESSION_V1')assert.equal(author,m.manager,'current memorial manager');
    else{assert(now>=p.body.effectiveAt&&now<=p.body.expiresAt,'succession execution window');m.manager=p.body.successor;m.epoch++;}
    m.last={decision:p,status:a.type==='CANCEL_MEMORIAL_SUCCESSION_V1'?'CANCELLED':'EXECUTED',at:now};m.pending=null;
  }
  m.history=hash({previous:m.history,action:a,at:now});auditMemorialCustody(s);return s;
}
