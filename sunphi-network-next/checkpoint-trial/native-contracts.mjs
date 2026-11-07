// First native template: one indivisible Satoshi allocation. Public admission is closed.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,publicKey,canonical} from './crypto.mjs';
import {amount} from './payment-model.mjs';import {anniversary} from './economic-policy-v2.mjs';
import {ECONOMIC_POLICY_VERSION_V4,memorialPolicy} from './economic-policy-v3.mjs';
import {reserveAddresses} from './network-reserves.mjs';
import {NATIVE_CONTRACTS,nativeContractId,contractAuthority,verifyContractCertificate,contractPublicText} from './native-contract-kernel.mjs';
export {NATIVE_CONTRACTS,nativeContractId} from './native-contract-kernel.mjs';
export const SATOSHI_TEMPLATE='SATOSHI_MEMORIAL';
export const NATIVE_ACTIONS=['REGISTER_NATIVE_CONTRACT_V1','PROPOSE_NATIVE_CONTRACT_V1','CANCEL_NATIVE_CONTRACT_V1','EXECUTE_NATIVE_CONTRACT_V1'];
const templateVersion=1;
export const satoshiContractId=s=>nativeContractId(s.configHash,SATOSHI_TEMPLATE,templateVersion,s.economicPreparation.planHash);
export const memorialContractPaid=s=>s.nativeContracts?amount(s.nativeContracts.records[satoshiContractId(s)]?.paidMicro??'0'):0n;
const registrationFields=['template','version','policy'];
const proposalFields=['sequence','kind','recipient','valueMicro','settlement','evidenceHash','mandateHash','publicDecision'];
const sourceOutput=s=>hash({domain:'ISSUE_CENTURY_FUNDS_V1',configHash:s.configHash,planHash:s.economicPreparation.planHash,kind:'memorial'});
const receiptOutput=(s,id,sequence)=>hash({domain:NATIVE_CONTRACTS+'/SETTLE',configHash:s.configHash,contractId:id,sequence});
function policy(p){exact(p,['reviewSeconds','executionWindowSeconds']);integer(p.reviewSeconds,7*86400);assert(p.reviewSeconds<=365*86400);integer(p.executionWindowSeconds,86400);assert(p.executionWindowSeconds<=90*86400);}
function context(s){assert.equal(s.economicPreparation?.plan.version,ECONOMIC_POLICY_VERSION_V4,'V4 memorial preparation required');assert.equal(s.money.unitScale,'1000000','atomic units required');}
function stableManager(s){const m=s.economicPreparation.memorial;assert(!m.pending,'memorial succession pending');return m;}
function ordinaryRecipient(s,key){
 publicKey(key);const m=s.centuryFunds?.manifest;
 assert(![memorialPolicy(s.configHash).account,...reserveAddresses(s.configHash),...(m?[m.development.account,m.founder.account,...m.warmup.accounts]:[])].includes(key),'ordinary recipient required');
}
function inspectRegistration(s,r){
 const b=verifyContractCertificate(r.registration,s,r.registrationAuthority,registrationFields);
 assert.equal(b.template,SATOSHI_TEMPLATE,'unknown native template');assert.equal(b.version,templateVersion,'unknown template version');policy(b.policy);
 assert.equal(b.contractId,satoshiContractId(s));assert.equal(r.template,b.template);assert.equal(r.version,b.version);assert.deepEqual(r.policy,b.policy);assert.equal(r.policyHash,hash(b.policy));
 assert.equal(r.createdHeight,r.registrationAuthority.height);integer(r.createdAt,1);assert(r.createdAt<=s.money.time);
}
function inspectProposal(s,r,p){
 exact(p,['action','authority','publishedAt','executeAt','expiresAt']);const b=verifyContractCertificate(p.action,s,p.authority,proposalFields,true);
 assert.equal(p.action.type,'PROPOSE_NATIVE_CONTRACT_V1');assert.equal(b.contractId,satoshiContractId(s));integer(b.sequence,1);assert(b.sequence<=r.sequence);
 assert(['BITCOIN_CREATOR_PERSON','BITCOIN_CREATOR_GROUP','CRYPTO_HISTORY_MUSEUM'].includes(b.kind),'eligible beneficiary kind');
 assert.equal(b.valueMicro,s.economicPreparation.plan.memorialMicro,'one complete memorial allocation');assert.equal(b.settlement,'DUBYT_DIRECT','BTC conversion not qualified');ordinaryRecipient(s,b.recipient);
 hex(b.evidenceHash);assert(b.evidenceHash!=='0'.repeat(64),'evidence commitment required');contractPublicText(b.publicDecision);
 if(b.kind==='BITCOIN_CREATOR_GROUP'){hex(b.mandateHash);assert(b.mandateHash!=='0'.repeat(64),'group mandate required');}else assert.equal(b.mandateHash,null);
 integer(p.publishedAt,r.createdAt);assert(p.publishedAt<=s.money.time);assert.equal(p.executeAt,p.publishedAt+r.policy.reviewSeconds);assert.equal(p.expiresAt,p.executeAt+r.policy.executionWindowSeconds);
 assert(p.expiresAt<=8000000000000,'UTC limit');assert(p.authority.height>=r.createdHeight);
 if(b.kind==='CRYPTO_HISTORY_MUSEUM'){const start=s.centuryFunds?.execution?.start;assert(start&&p.publishedAt>=anniversary(start,100),'museum requires the actual 100-year boundary');}
 return b;
}
export function auditNativeContracts(s){
 const book=s.nativeContracts;if(!book)return;context(s);exact(book,['version','records']);assert.equal(book.version,NATIVE_CONTRACTS);exact(book.records,[satoshiContractId(s)]);
 const r=book.records[satoshiContractId(s)];exact(r,['template','version','policy','policyHash','registration','registrationAuthority','createdHeight','createdAt','sequence','paidMicro','pending','last','history']);
 inspectRegistration(s,r);assert.equal(r.registration.type,'REGISTER_NATIVE_CONTRACT_V1');integer(r.sequence);assert(r.sequence<=1000000,'bounded contract sequence');hex(r.history);
 const paid=amount(r.paidMicro);assert(paid===0n||paid===amount(s.economicPreparation.plan.memorialMicro),'single allocation');
 if(r.pending){assert.equal(paid,0n);const b=inspectProposal(s,r,r.pending);assert.equal(b.sequence,r.sequence);}
 if(r.last){exact(r.last,['proposal','status','at','outputId']);const b=inspectProposal(s,r,r.last.proposal);assert(['CANCELLED','SETTLED'].includes(r.last.status));integer(r.last.at,r.last.proposal.publishedAt);assert(r.last.at<=s.money.time);
  if(r.last.status==='SETTLED'){assert.equal(paid,amount(b.valueMicro));assert(!r.pending);assert.equal(b.sequence,r.sequence);assert.equal(r.last.outputId,receiptOutput(s,b.contractId,b.sequence));assert(r.last.at>=r.last.proposal.executeAt&&r.last.at<=r.last.proposal.expiresAt);}
  else{assert.equal(paid,0n);assert.equal(r.last.outputId,null);}
 }else assert.equal(paid,0n);
 if(paid>0n)assert(s.centuryFunds?.execution&&r.last?.status==='SETTLED');
 const m=s.economicPreparation.memorial;assert.equal(m.balanceMicro,String((m.issued?amount(s.economicPreparation.plan.memorialMicro):0n)-paid));assert.equal(m.transferred,paid>0n);
 assert(Buffer.byteLength(canonical(book))<=32768,'native contract storage limit');
}
export function applyNativeContract(base,a,author){
 context(base);auditNativeContracts(base);assert(NATIVE_ACTIONS.includes(a.type),'unknown native action');publicKey(author);
 const s=structuredClone(base),id=satoshiContractId(s),m=s.economicPreparation.memorial;let r=s.nativeContracts?.records[id];
 if(a.type==='REGISTER_NATIVE_CONTRACT_V1'){
  stableManager(s);assert.equal(author,m.manager);const auth=contractAuthority(s),b=verifyContractCertificate(a,s,auth,registrationFields);
  assert.equal(b.template,SATOSHI_TEMPLATE);assert.equal(b.version,templateVersion);assert.equal(b.contractId,id);policy(b.policy);
  if(r){assert.equal(hash(a),hash(r.registration),'contract version already pinned');return base;}
  s.nativeContracts={version:NATIVE_CONTRACTS,records:{[id]:{template:b.template,version:b.version,policy:b.policy,policyHash:hash(b.policy),registration:a,registrationAuthority:auth,createdHeight:s.height,createdAt:s.money.time,sequence:0,paidMicro:'0',pending:null,last:null,history:hash(a)}}};
 }else{
  assert(r,'native contract not registered');
  if(a.type==='PROPOSE_NATIVE_CONTRACT_V1'){
   assert(s.centuryFunds,'prepared fund manifest required');
   stableManager(s);assert.equal(author,m.manager);const auth=contractAuthority(s),b=verifyContractCertificate(a,s,auth,proposalFields,true);
   assert.equal(r.paidMicro,'0','memorial already settled');
   if(r.pending&&hash(r.pending.action)===hash(a))return base;
   assert(!r.pending,'cancel the prior proposal first');assert.equal(b.sequence,r.sequence+1);r.sequence=b.sequence;
   r.pending={action:a,authority:auth,publishedAt:s.money.time,executeAt:s.money.time+r.policy.reviewSeconds,expiresAt:s.money.time+r.policy.reviewSeconds+r.policy.executionWindowSeconds};inspectProposal(s,r,r.pending);
  }else{
   exact(a,['type','contractId','sequence','proposalHash']);assert.equal(a.contractId,id);integer(a.sequence,1);hex(a.proposalHash);
   const status=a.type==='EXECUTE_NATIVE_CONTRACT_V1'?'SETTLED':'CANCELLED';
   if(status==='CANCELLED')assert.equal(author,m.manager,'current memorial manager');
   if(!r.pending&&r.last?.status===status&&r.last.proposal.action.certificate.body.sequence===a.sequence&&hash(r.last.proposal.action)===a.proposalHash)return base;
   const p=r.pending;assert(p&&p.action.certificate.body.sequence===a.sequence&&hash(p.action)===a.proposalHash,'matching active proposal');
   const b=inspectProposal(s,r,p);let outputId=null;
   if(status==='SETTLED'){
    stableManager(s);assert.equal(p.authority.epoch,m.epoch,'stale contract management');assert.equal(p.authority.manager,m.manager);assert.equal(p.authority.generation,s.authority.generation,'stale validator approval');
    assert(s.money.time>=p.executeAt&&s.money.time<=p.expiresAt,'contract review/execution window');assert(s.centuryFunds?.execution&&m.issued,'memorial unissued');assert.equal(r.paidMicro,'0');
    const source=s.money.outputs[sourceOutput(s)],v=amount(b.valueMicro);assert(source&&source.owner===memorialPolicy(s.configHash).account&&source.unlock===0&&amount(source.value)===v,'memorial custody balance');
    outputId=receiptOutput(s,id,b.sequence);assert(!Object.hasOwn(s.money.outputs,outputId),'contract output collision');
    source.value='0';s.money.outputs[outputId]={owner:b.recipient,value:b.valueMicro,unlock:0};r.paidMicro=b.valueMicro;m.balanceMicro='0';m.transferred=true;
   }
   r.last={proposal:p,status,at:s.money.time,outputId};r.pending=null;
  }
  r.history=hash({previous:r.history,action:a,at:s.money.time});
 }
 auditNativeContracts(s);assert.equal(s.money.supply,base.money.supply,'contracts cannot mint');assert.equal(s.money.fees,base.money.fees,'no hidden contract charge');return s;
}
