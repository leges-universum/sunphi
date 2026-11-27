// Versioned successor to the indivisible memorial contract. Committee decisions
// are organizational evidence, never a new consensus committee or voting system.
import assert from 'node:assert/strict';
import {copyControllerState} from './controller-context.mjs';
import {exact,hash,hex,integer,publicKey,canonical} from './crypto.mjs';
import {amount} from './payment-model.mjs';
import {reserveAddresses} from './network-reserves.mjs';
import {NATIVE_CONTRACTS,nativeContractId,contractAuthority,verifyContractCertificate,contractPublicText} from './native-contract-kernel.mjs';
export const RESEARCH_ACTIONS=['REGISTER_SATOSHI_RESEARCH_V2','PROPOSE_SATOSHI_RESEARCH_V2','CANCEL_SATOSHI_RESEARCH_V2','EXECUTE_SATOSHI_RESEARCH_V2'];
export const RESEARCH_AWARD_MICRO='1000000000000';
export const researchContractId=s=>nativeContractId(s.configHash,'SATOSHI_RESEARCH',2,s.economicPreparation.planHash);
const oldId=s=>nativeContractId(s.configHash,'SATOSHI_MEMORIAL',1,s.economicPreparation.planHash);
export const researchRecord=s=>s.nativeContracts?.records[researchContractId(s)];
export const researchPaid=s=>amount(researchRecord(s)?.paidMicro??'0');
const registrationFields=['previousContractHash','awardCount','awardMicro','governance','publicDecision','evidenceHash'];
const proposalFields=['sequence','awardNumber','kind','recipient','valueMicro','settlement','evidenceHash','mandateHash','publicDecision'];
const sourceId=s=>hash({domain:'ISSUE_CENTURY_FUNDS_V1',configHash:s.configHash,planHash:s.economicPreparation.planHash,kind:'memorial'});
const outputId=(s,n)=>hash({domain:NATIVE_CONTRACTS+'/RESEARCH_SETTLE',configHash:s.configHash,contractId:researchContractId(s),awardNumber:n});
function commitment(h){hex(h);assert.notEqual(h,'0'.repeat(64),'public evidence commitment required');}
function ordinary(s,key){publicKey(key);const m=s.centuryFunds.manifest;assert(![m.memorial.account,m.development.account,m.founder.account,...m.warmup.accounts,...reserveAddresses(s.configHash)].includes(key),'ordinary recipient required');}
function inspect(s,r,p){
 exact(p,['action','authority','publishedAt','executeAt','expiresAt']);const b=verifyContractCertificate(p.action,s,p.authority,proposalFields,true);
 assert.equal(p.action.type,RESEARCH_ACTIONS[1]);assert.equal(b.contractId,researchContractId(s));integer(b.sequence,1);assert(b.sequence<=r.sequence);
 integer(b.awardNumber,1);assert(b.awardNumber<=10);assert.equal(b.kind,'COMPLETED_RESEARCH');assert.equal(b.valueMicro,RESEARCH_AWARD_MICRO);assert.equal(b.settlement,'DUBYT_DIRECT');
 ordinary(s,b.recipient);commitment(b.evidenceHash);commitment(b.mandateHash);contractPublicText(b.publicDecision);
 integer(p.publishedAt,r.createdAt);assert(p.publishedAt<=s.money.time);assert(p.authority.height>=r.createdHeight);
 assert.equal(p.executeAt,p.publishedAt+r.policy.reviewSeconds);assert.equal(p.expiresAt,p.executeAt+r.policy.executionWindowSeconds);assert(p.expiresAt<=8000000000000);
 return b;
}
export function auditResearchContract(s){
 const r=researchRecord(s);if(!r)return;
 exact(r,['template','version','registration','registrationAuthority','policy','createdAt','createdHeight','sequence','paidMicro','awards','pending','last','history']);
 assert.equal(r.template,'SATOSHI_RESEARCH');assert.equal(r.version,2);integer(r.sequence);assert(r.sequence<=1000000);hex(r.history);
 const old=s.nativeContracts.records[oldId(s)];assert(old&&!old.pending&&old.paidMicro==='0','legacy contract must be unspent and closed');
 const b=verifyContractCertificate(r.registration,s,r.registrationAuthority,registrationFields);
 assert.equal(r.registration.type,RESEARCH_ACTIONS[0]);assert.equal(b.contractId,researchContractId(s));assert.equal(b.previousContractHash,hash(old));
 assert.equal(b.awardCount,10);assert.equal(b.awardMicro,RESEARCH_AWARD_MICRO);assert.equal(b.governance,'ORGANIZATIONAL_COMMITTEE');contractPublicText(b.publicDecision);commitment(b.evidenceHash);
 assert.equal(BigInt(b.awardCount)*amount(b.awardMicro),amount(s.economicPreparation.plan.memorialMicro),'existing allocation only');
 assert.deepEqual(r.policy,old.policy);integer(r.createdAt,old.createdAt);assert(r.createdAt<=s.money.time);assert.equal(r.createdHeight,r.registrationAuthority.height);
 assert(Array.isArray(r.awards)&&r.awards.length<=10);assert.equal(r.paidMicro,String(BigInt(r.awards.length)*amount(RESEARCH_AWARD_MICRO)));
 let previousSequence=0;const decisions=new Set();
 for(const [i,payment]of r.awards.entries()){
  exact(payment,['proposal','at','outputId']);const a=inspect(s,r,payment.proposal);assert.equal(a.awardNumber,i+1);assert(a.sequence>previousSequence);previousSequence=a.sequence;
  assert(!decisions.has(a.mandateHash),'committee decision already paid');decisions.add(a.mandateHash);
  integer(payment.at,payment.proposal.executeAt);assert(payment.at<=payment.proposal.expiresAt&&payment.at<=s.money.time);assert.equal(payment.outputId,outputId(s,i+1));
 }
 if(r.pending){const a=inspect(s,r,r.pending);assert.equal(a.sequence,r.sequence);assert.equal(a.awardNumber,r.awards.length+1);assert(!decisions.has(a.mandateHash),'committee decision already paid');}
 if(r.last){exact(r.last,['proposal','status','at']);const a=inspect(s,r,r.last.proposal);assert(['SETTLED','CANCELLED'].includes(r.last.status));integer(r.last.at,r.last.proposal.publishedAt);assert(r.last.at<=s.money.time);
  assert.equal(a.sequence,r.sequence-(r.pending?1:0),'contiguous research command sequence');
  if(r.last.status==='SETTLED'){const last=r.awards.at(-1);assert(last&&hash(last.proposal)===hash(r.last.proposal)&&last.at===r.last.at);}
  else assert(a.sequence>previousSequence);
 }else{assert.equal(r.sequence,r.pending?1:0);assert.equal(r.awards.length,0);}
 if(r.awards.length)assert(s.economicPreparation.memorial.issued,'research reserve unissued');
 assert(Buffer.byteLength(canonical(r))<=98304,'bounded research award ledger');
}
export function applyResearchContract(base,a,author){
 assert(RESEARCH_ACTIONS.includes(a.type));publicKey(author);auditResearchContract(base);
 const s=copyControllerState(base,['nativeContracts','economicPreparation']),m=s.economicPreparation.memorial,id=researchContractId(s);let r=researchRecord(s);
 if(a.type===RESEARCH_ACTIONS[0]){
  assert(!m.pending,'memorial succession pending');assert.equal(author,m.manager,'current memorial manager');
  if(r){assert.equal(hash(a),hash(r.registration),'research contract already pinned');return base;}
  const old=s.nativeContracts?.records[oldId(s)];assert(old&&!old.pending&&old.paidMicro==='0','cancel pending legacy proposal; paid legacy allocation cannot migrate');
  const authority=contractAuthority(s);verifyContractCertificate(a,s,authority,registrationFields);
  s.nativeContracts.records[id]={template:'SATOSHI_RESEARCH',version:2,registration:structuredClone(a),registrationAuthority:authority,policy:structuredClone(old.policy),createdAt:s.money.time,createdHeight:s.height,sequence:0,paidMicro:'0',awards:[],pending:null,last:null,history:hash(a)};
 }else{
  assert(r,'research contract not registered');
  if(a.type===RESEARCH_ACTIONS[1]){
   assert(!m.pending,'memorial succession pending');assert.equal(author,m.manager,'current memorial manager');
   const authority=contractAuthority(s),b=verifyContractCertificate(a,s,authority,proposalFields,true);
   if(r.pending&&hash(r.pending.action)===hash(a))return base;
   assert(!r.pending,'cancel prior research proposal first');assert.equal(b.sequence,r.sequence+1);assert(r.awards.length<10,'all research awards paid');r.sequence=b.sequence;
   r.pending={action:structuredClone(a),authority,publishedAt:s.money.time,executeAt:s.money.time+r.policy.reviewSeconds,expiresAt:s.money.time+r.policy.reviewSeconds+r.policy.executionWindowSeconds};
  }else{
   exact(a,['type','contractId','sequence','proposalHash']);assert.equal(a.contractId,id);integer(a.sequence,1);hex(a.proposalHash);
   const status=a.type===RESEARCH_ACTIONS[3]?'SETTLED':'CANCELLED';if(status==='CANCELLED')assert.equal(author,m.manager,'current memorial manager');
   if(!r.pending&&r.last?.status===status&&r.last.proposal.action.certificate.body.sequence===a.sequence&&hash(r.last.proposal.action)===a.proposalHash)return base;
   const p=r.pending;assert(p&&p.action.certificate.body.sequence===a.sequence&&hash(p.action)===a.proposalHash,'matching active research proposal');const b=inspect(s,r,p);
   if(status==='SETTLED'){
    assert(!m.pending,'memorial succession pending');assert.equal(p.authority.epoch,m.epoch,'stale management');assert.equal(p.authority.manager,m.manager);assert.equal(p.authority.generation,s.authority.generation,'stale validator approval');
    assert(s.money.time>=p.executeAt&&s.money.time<=p.expiresAt,'research review/execution window');assert(m.issued&&s.centuryFunds?.execution,'research reserve unissued');
    const source=s.money.outputs[sourceId(s)],value=amount(RESEARCH_AWARD_MICRO),remaining=amount(s.economicPreparation.plan.memorialMicro)-researchPaid(s);
    assert(source&&source.owner===s.centuryFunds.manifest.memorial.account&&source.unlock===0&&amount(source.value)===remaining&&remaining>=value,'research custody balance');
    const oid=outputId(s,b.awardNumber);assert(!Object.hasOwn(s.money.outputs,oid),'research output collision');source.value=String(remaining-value);
    s.money.outputs[oid]={owner:b.recipient,value:RESEARCH_AWARD_MICRO,unlock:0};r.paidMicro=String(researchPaid(s)+value);r.awards.push({proposal:p,at:s.money.time,outputId:oid});m.balanceMicro=String(remaining-value);m.transferred=true;
   }
   r.last={proposal:p,status,at:s.money.time};r.pending=null;
  }
  r.history=hash({previous:r.history,action:a,at:s.money.time});
 }
 auditResearchContract(s);assert.equal(s.money.supply,base.money.supply,'research cannot mint');assert.equal(s.money.fees,base.money.fees);return s;
}
