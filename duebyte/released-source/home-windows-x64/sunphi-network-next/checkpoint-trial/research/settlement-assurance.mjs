// Optional service for a payment already finalized in this ledger.
import assert from 'node:assert/strict';
import {exact, hash, hex, integer, publicKey, verify} from '../crypto.mjs';
import {amount} from '../payment-model.mjs';
import {validatorQuorum} from '../authority.mjs';
import {availableWorkingStake} from '../worker-collateral.mjs';
import {spendPolicy} from '../spend-protection.mjs';
import {checkReservedPayment} from '../network-reserves.mjs';
import {caseKey, caseRemaining, recordAssuranceRecovery} from './bounded-protection-cases.mjs';

export const ENABLE='ENABLE_SETTLEMENT_ASSURANCE_V1', OFFER='SET_SETTLEMENT_OFFER_V1';
export const BOOK='BOOK_SETTLEMENT_ASSURANCE_V1', SIGNED='SUBMIT_SETTLEMENT_ATTESTATION_V1';
export const FAULT='REPORT_FALSE_SETTLEMENT_V1', CLOSE='CLOSE_SETTLEMENT_ASSURANCE_V1';
export const assuranceActions=[ENABLE,OFFER,BOOK,SIGNED,FAULT,CLOSE];
const prefix='settlement-assurance/', head=prefix+'policy';
const offerKey=id=>prefix+'offer/'+hex(id), orderKey=id=>prefix+'order/'+hex(id);
export const escrowedNodePrincipal=(get,node)=>amount(get(offerKey(node))?.escrowMicro??'0');
const turnKey=key=>prefix+'turn/'+hash(key);
const min=(a,b)=>a<b?a:b;
const custody=config=>Buffer.from(hash([ENABLE,config,'escrow']),'hex').toString('base64url');
const escrowId=pid=>hash([BOOK,pid,'escrow']);
export const assuranceRecord=k=>k===head||/^settlement-assurance\/(offer|order|turn)\/[0-9a-f]{64}$/.test(k);
// Called on authenticated records by both quoting and consensus. A prefix
// contains at most 512 funded offers. Pick one server per Ed25519 key.
export function assuranceQuote(s,get,cover){
 const size=amount(cover), policy=get(head);assert(policy&&size>0n,'service disabled or zero cover');
 return selectOffers(policy.nodes.map(id=>offerCapacity(s,get,id)),size);
}
function offerCapacity(s,get,id){
 const o=get(offerKey(id));
 const available=o.used>=o.slots?0n:min(amount(o.limit),availableWorkingStake(s,id));
 return {node:id,operator:o.operator,fee:o.fee,available:String(available),turn:get(turnKey(o.operator)),revision:o.revision};
}
export function assurancePage(s,get,offset){
 const p=get(head);integer(offset);assert(offset%16===0&&offset<512,'invalid offer page');
 return {total:p?.nodes.length??0,rule:p?.rule??null,offers:(p?.nodes??[]).slice(offset,offset+16).map(id=>offerCapacity(s,get,id))};
}
export function selectOffers(rows,size){
 assert(typeof size==='bigint'&&size>0n);
 const candidates=rows.filter(o=>amount(o.available)>=size).map(o=>({...o,band:amount(o.available).toString(2).length}));
 candidates.sort((a,b)=>a.band-b.band||a.turn-b.turn||(a.node<b.node?-1:1));
 const groups=new Set();let upper=0;
 for(const c of candidates){groups.add(c.operator);upper=c.band;if(groups.size===3)break;}
 assert(groups.size>=3,'three distinct funded operator keys required');
 const eligible=candidates.filter(c=>c.band<=upper).sort((a,b)=>a.turn-b.turn||a.band-b.band||(a.node<b.node?-1:1));
 groups.clear();const offers=[];
 for(const c of eligible)if(!groups.has(c.operator)){
  groups.add(c.operator);offers.push({node:c.node,operator:c.operator,fee:c.fee,revision:c.revision});if(offers.length===3)break;
 }
 return offers;
}
function output(m,id,owner,value,unlock=0){
 if(value===0n)return;
 assert(!m.outputs[id],'output collision');m.outputs[id]={owner,value:String(value),unlock};
}
export function settlementStatement(s,order,node){
 const i=order.fact;
 return {domain:SIGNED,configHash:s.configHash,pid:i.pid,order:order.digest,node,recipient:i.recipient,value:i.value,terminalHeight:i.terminalHeight};
}
export function applyAssurance(s,a,author,config,tx,guardCustody){
 const m=s.money, p=tx.get(head), now=m.time;
 if(a.type===ENABLE){
  exact(a,['type','body','approvals']);const b=a.body;
  exact(b,['domain','configHash','generation','notBefore','expires','signSeconds','challengeSeconds']);
  assert(!p&&m.unitScale==='1000000'&&m.liability?.protection.casePolicy,'certified loss ledger required');
  assert.equal(b.domain,ENABLE);assert.equal(b.configHash,s.configHash);assert.equal(b.configHash,hash(config));assert.equal(b.generation,s.authority.generation);
  integer(b.notBefore,1);integer(b.expires,b.notBefore+1);assert(!s.authority.pending&&b.notBefore<=now&&now<b.expires&&b.expires-b.notBefore<=600);
  integer(b.signSeconds,60);integer(b.challengeSeconds,86400);assert(b.signSeconds<=86400&&b.challengeSeconds<=30*86400);
  validatorQuorum(b,a.approvals,s.authority.validators);
  tx.set(head,{rule:b,nodes:[],serial:0});return s;
 }
 assert(p,'settlement assurance not approved');
 if(a.type===OFFER){
  exact(a,['type','body','workerConsent','operatorConsent']);const b=a.body;
  exact(b,['domain','configHash','node','operator','limit','slots','fee','revision']);
  assert.equal(b.domain,OFFER);assert.equal(b.configHash,s.configHash);hex(b.node);publicKey(b.operator);
  const f=s.workerFunding?.accounts[b.node],n=m.nodes[b.node];assert(f&&n&&author===f.owner,'funding owner required');
  assert(verify(b,a.workerConsent,n.key)&&verify(b,a.operatorConsent,b.operator),'worker and operator consent required');
  const old=tx.get(offerKey(b.node));assert.equal(b.revision,integer((old?.revision??0)+1,1));
  assert(!old?.used||old.operator===b.operator,'operator has outstanding assignments');
  amount(b.limit);assert(amount(b.fee)>0n);integer(b.slots);assert(b.slots<=64);
  if(b.slots>0&&!p.nodes.includes(b.node)){
   assert(amount(b.limit)>0n&&availableWorkingStake(s,b.node)>0n,'funded capacity required');assert(p.nodes.length<512,'offer directory full');
   p.nodes.push(b.node);p.nodes.sort();
  }else if(b.slots===0)p.nodes=p.nodes.filter(id=>id!==b.node);
  if(b.slots>0&&tx.get(turnKey(b.operator))==null){p.serial=integer(p.serial+1);tx.set(turnKey(b.operator),p.serial);}
  tx.set(head,p);
  tx.set(offerKey(b.node),{...b,used:old?.used??0,escrowMicro:old?.escrowMicro??'0'});return s;
 }
 hex(a.pid);const key=orderKey(a.pid),order=tx.get(key);
 if(a.type===BOOK){
  exact(a,['type','pid','cover','quote','input','expires']);assert(!order,'payment already booked');
  const r=m.requests[a.pid];assert(r?.status==='SETTLED'&&r.intent.sender===author,'confirmed sender settlement required');
  assert.equal(r.intent.unitScale,m.unitScale,'payment denomination mismatch');
  const cover=amount(a.cover);assert(cover>0n&&cover<=min(amount(r.intent.value),amount(r.intent.fee)),'coverage exceeds provable payment loss');
  integer(a.expires,now+1);assert(a.expires<=now+600,'stale fee consent');
  const offers=assuranceQuote(s,k=>tx.get(k),a.cover);assert.deepEqual(a.quote,offers,'quote changed');
  const fee=offers.reduce((sum,o)=>sum+amount(o.fee),0n), domain={sender:author,recipient:author};
  checkReservedPayment(s,domain);guardCustody(s,domain);
  const guard=spendPolicy(s,author);assert(!guard?.enabled&&!guard?.pending,'protected wallet requires separate approval');
  hex(a.input);const input=m.outputs[a.input];assert(input&&input.owner===author&&input.unlock<=now&&amount(input.value)>=fee,'spendable fee input required');
  assert(author!==custody(s.configHash));amount(String(3n*cover+fee));
  delete m.outputs[a.input];output(m,hash([BOOK,a.pid,'change']),author,amount(input.value)-fee);
  for(const o of offers){
   const n=m.nodes[o.node],f=tx.get(offerKey(o.node));n.stake=String(amount(n.stake)-cover);
   f.used++;f.escrowMicro=String(amount(f.escrowMicro)+cover);tx.set(offerKey(o.node),f);p.serial=integer(p.serial+1);tx.set(turnKey(o.operator),p.serial);
  }
  output(m,escrowId(a.pid),custody(s.configHash),3n*cover+fee,Number.MAX_SAFE_INTEGER);
  const fact={pid:a.pid,value:r.intent.value,recipient:r.intent.recipient,terminalHeight:r.terminalHeight};
  tx.set(key,{fact,buyer:author,offers,cover:a.cover,digest:hash([s.configHash,a,fact]),signBy:integer(now+p.rule.signSeconds),
   closeAt:integer(now+p.rule.signSeconds+p.rule.challengeSeconds),signatures:{},faults:{},closed:false});
  tx.set(head,p);return s;
 }
 assert(order&&!order.closed,'open settlement assignment required');
 if(a.type===SIGNED||a.type===FAULT){
  exact(a,['type','pid','statement','signature']);const b=a.statement;hex(b.node);
  const offer=order.offers.find(o=>o.node===b.node);assert(offer,'unassigned key');
  const expected=settlementStatement(s,order,b.node);exact(b,Object.keys(expected));
  publicKey(b.recipient);amount(b.value);integer(b.terminalHeight,1);
  assert.deepEqual({...b,recipient:expected.recipient,value:expected.value,terminalHeight:expected.terminalHeight},expected,'incorrect signature context');
  assert(verify(b,a.signature,offer.operator),'invalid operator signature');
  if(a.type===SIGNED){assert(now<order.signBy);assert.deepEqual(b,expected);order.signatures[b.node]=a.signature;}
  else{assert(now<order.closeAt);assert.notDeepEqual(b,expected,'accurate settlement');assert(!order.faults[b.node],'fault already recorded');order.faults[b.node]={statement:b,signature:a.signature};}
  tx.set(key,order);return s;
 }
 assert.equal(a.type,CLOSE);exact(a,['type','pid']);assert(now>=order.closeAt,'challenge window open');
 const fee=order.offers.reduce((v,o)=>v+amount(o.fee),0n),cover=amount(order.cover);
 const escrow=m.outputs[escrowId(a.pid)];assert.deepEqual(escrow,{owner:custody(s.configHash),value:String(3n*cover+fee),unlock:Number.MAX_SAFE_INTEGER});
 const faulty=order.offers.filter(o=>order.faults[o.node]), assessment=tx.get(caseKey(a.pid))?.assessment;
 let liable=[];
 let compensation=0n;
 if(faulty.length&&assessment){
  // A later fault cannot invalidate a certified earlier set of evidence.
  for(let mask=1;mask<(1<<faulty.length);mask++){
   const subset=faulty.filter((_,i)=>mask&(1<<i));
   if(assuranceEvidence(order,subset.map(o=>o.node))===assessment.evidence){liable=subset;break;}
  }
  if(assessment.recipient===order.buyer&&liable.length){
   compensation=min(cover,caseRemaining(tx.get(caseKey(a.pid))));
   if(compensation)recordAssuranceRecovery(s,tx,a.pid,compensation);
  }
 }
 const allSigned=Object.keys(order.signatures).length===3&&!faulty.length;
 delete m.outputs[escrowId(a.pid)];
 output(m,hash([CLOSE,a.pid,'buyer']),order.buyer,compensation+(allSigned?0n:fee));
 for(const o of order.offers){
  const index=liable.indexOf(o),count=BigInt(liable.length);
  const loss=index<0?0n:compensation/count+(BigInt(index)<compensation%count?1n:0n);
  const n=m.nodes[o.node],f=tx.get(offerKey(o.node));assert(f.used>0&&amount(f.escrowMicro)>=cover);
  f.used--;f.escrowMicro=String(amount(f.escrowMicro)-cover);tx.set(offerKey(o.node),f);
  n.stake=String(amount(n.stake)+cover-loss);
  if(allSigned)output(m,hash([CLOSE,a.pid,o.node]),s.workerFunding.accounts[o.node].owner,amount(o.fee));
 }
 order.closed=true;order.compensation=String(compensation);order.feesPaid=allSigned?String(fee):'0';tx.set(key,order);return s;
}
export const assuranceEvidence=(o,nodes=Object.keys(o.faults))=>hash({domain:FAULT,order:o.digest,faults:Object.fromEntries(nodes.map(id=>[id,o.faults[id]]))});

export function auditAssurance(records,s){
 const p=records.get(head),used=new Map(),escrow=new Map();
 for(const [k,o] of records){
  if(!assuranceRecord(k))continue;
  assert(p&&p.rule.configHash===s.configHash,'unbound assurance state');
  if(!k.startsWith(prefix+'order/'))continue;
  const pid=o.fact.pid,r=s.money.requests[pid];assert.equal(k,orderKey(pid));assert.equal(r?.status,'SETTLED');
  assert.deepEqual(o.fact,{pid,recipient:r.intent.recipient,value:r.intent.value,terminalHeight:r.terminalHeight});
  assert.equal(o.buyer,r.intent.sender);assert.equal(o.offers.length,3);assert.equal(new Set(o.offers.map(x=>x.operator)).size,3);
  const hold=s.money.outputs[escrowId(pid)],fee=o.offers.reduce((n,x)=>n+amount(x.fee),0n);
  if(o.closed){assert(!hold);assert.equal(o.compensation,records.get(caseKey(pid))?.assurancePaid??'0');}
  else assert.deepEqual(hold,{owner:custody(s.configHash),value:String(3n*amount(o.cover)+fee),unlock:Number.MAX_SAFE_INTEGER});
  for(const row of o.offers){
   if(!o.closed){used.set(row.node,(used.get(row.node)??0)+1);escrow.set(row.node,(escrow.get(row.node)??0n)+amount(o.cover));}
   const statement=settlementStatement(s,o,row.node);
   if(o.signatures[row.node])assert(verify(statement,o.signatures[row.node],row.operator));
   const fault=o.faults[row.node];if(fault){assert(verify(fault.statement,fault.signature,row.operator));assert.notDeepEqual(statement,fault.statement);}
  }
 }
 if(!p)return;
 assert.deepEqual(p.nodes,[...new Set(p.nodes)].sort());assert(p.nodes.length<=512);
 for(const id of p.nodes)assert(records.get(offerKey(id))?.slots>0,'missing offer');
 for(const [k,o] of records)if(k.startsWith(prefix+'offer/')){
  assert.equal(k,offerKey(o.node));assert.equal(o.used,used.get(o.node)??0);used.delete(o.node);
  assert.equal(amount(o.escrowMicro??'0'),escrow.get(o.node)??0n,'escrowed node principal');
 }
 assert(!used.size,'missing operator reservation');
}
