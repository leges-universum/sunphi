// Quorum-authorised, finite public-checkpoint verification jobs. This proves
// signed completion, not independent physical hardware or storage availability.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,verify} from './crypto.mjs';
import {amount} from './payment-model.mjs';
import {quorum} from './authority.mjs';
import {createWorkBudget,assignWork,finishWork,expireWork,auditWorkBudget,assignmentId} from './reward-work-budget.mjs';
export const FUNDED_ACTIONS=['OPEN_REWARD_WORK_V1','CLOSE_REWARD_WORK_V1','ASSIGN_REWARD_WORK_V1','COMPLETE_REWARD_WORK_V1'];
const DOMAIN='DUEBYTE_FUNDED_WORK_V1';
const total=x=>Object.values(x).reduce((n,v)=>n+BigInt(v),0n);
export const reservedWorkFees=r=>r.fundedWork&&!r.fundedWork.closed?BigInt(r.fundedWork.book.feeBudget)-BigInt(r.fundedWork.book.paidFees):0n;
export const unissuedWorkBudget=r=>r.fundedWork&&!r.fundedWork.closed?amount(r.fundedWork.book.policy.homeEmissionBudget)+amount(r.fundedWork.book.policy.serverEmissionBudget)-total(r.fundedWork.book.minted):0n;
function certificate(s,a,c,fields){
 exact(a,['type','certificate']);const cert=a.certificate;exact(cert,['body','approvals']);const b=cert.body;
 exact(b,['domain','network','configHash','generation','notBefore','expires',...fields]);assert.equal(b.domain,DOMAIN+'/'+a.type);assert.equal(b.network,c.chainId);assert.equal(b.configHash,hash(c));assert.equal(b.generation,s.authority.generation);
 integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.expires-b.notBefore<=100&&s.height>=b.notBefore&&s.height<=b.expires,'funded work inclusion window');quorum(b,cert.approvals,s.authority.validators,7);return b;
}
export function applyFundedWork(base,action,author,c){
 const s=structuredClone(base),r=s.rewards;assert(r?.coefficients.calendar,'calendar required for funded work');assert.equal(r.coefficients.alphaPPM,0,'legacy emission must be off');assert.equal(r.coefficients.workMeasure,'payment_value_v2','normalised work required');
 if(action.type==='OPEN_REWARD_WORK_V1'){
  const b=certificate(s,action,c,['policy','feeBudget','owners']),old=r.fundedWork;
  assert(b.policy.startTime>=s.money.time,'work period starts in the past');assert(b.policy.endTime-b.policy.startTime<=86400,'bounded assignment period');
  assert.equal(b.policy.version,old?old.book.policy.version+1:1);
  if(old){assert(s.money.time>old.book.policy.endTime,'previous funded period still open');assert(b.policy.startTime>=old.book.policy.endTime,'overlapping emission budgets');assert(!Object.values(old.book.jobs).some(j=>j.status==='assigned'),'unfinished prior assignments');r.period.fees=String(BigInt(r.period.fees)+reservedWorkFees(r));}
  assert(amount(b.feeBudget)<=amount(r.period.fees),'only collected unallocated fees fund jobs');
  for(const [id,group] of Object.entries(b.owners)){assert(r.nodes[id],'unknown reward account');if(s.money.nodes[id])assert.equal(group,s.money.nodes[id].operator,'worker owner group mismatch');}
  const budget=amount(b.policy.homeEmissionBudget)+amount(b.policy.serverEmissionBudget);
  assert(amount(r.minted)+budget<=amount(r.coefficients.lifetimeMintLimit),'lifetime assignment reservation');
  const book=createWorkBudget({configHash:s.configHash,calendar:r.coefficients.calendar,policy:b.policy,feeBudget:b.feeBudget,supply:s.money.supply,owners:b.owners});
  r.period.fees=String(amount(r.period.fees)-amount(b.feeBudget));
  r.fundedWork={book,history:hash({previous:old?.history??null,closed:old?.book??null}),targets:{},closed:false,seen:[...(old?.seen??[])]};
 }else if(action.type==='CLOSE_REWARD_WORK_V1'){
  const b=certificate(s,action,c,['version']),f=r.fundedWork;assert(f);assert.equal(b.version,f.book.policy.version);if(f.closed)return base;
  assert(s.money.time>f.book.policy.endTime,'funded period still open');assert(!Object.values(f.book.jobs).some(j=>j.status==='assigned'));
  r.period.fees=String(BigInt(r.period.fees)+reservedWorkFees(r));f.closed=true;f.history=hash({previous:f.history,closed:f.book});
 }else if(action.type==='ASSIGN_REWARD_WORK_V1'){
  const b=certificate(s,action,c,['request','target']),f=r.fundedWork;assert(f&&!f.closed,'no open funded work period');
  const q=b.request;assert.equal(q.units,1,'one unique verification per assignment');assert(q.replica<3,'bounded verification replicas');
  assert(['checkpoint','payment'].includes(q.kind),'unsupported verification class');
  const n=r.nodes[q.node];assert(n,'unknown verifier');
  if(q.kind==='checkpoint'){
   exact(b.target,['height','stateHash']);assert.deepEqual(b.target,r.period.anchor,'current assigned checkpoint');assert.equal(q.demand,hash(b.target),'checkpoint demand');
   assert.equal(f.book.policy.tariffs[q.kind]?.segment,'home');assert.equal(n.kind,'witness');
  }else{
   exact(b.target,['pid','digest','terminalHeight']);const payment=s.money.requests[b.target.pid];assert(payment?.status==='SETTLED','only settled payment verification');
   assert.deepEqual(b.target,{pid:payment.intent.pid,digest:payment.digest,terminalHeight:payment.terminalHeight});assert.equal(q.demand,b.target.pid);assert.equal(f.book.policy.tariffs[q.kind]?.segment,'server');assert.equal(n.kind,'worker');
  }
  const id=assignmentId(s.configHash,q.kind,q.demand,q.replica);
  assert(!f.seen.includes(id)||Object.hasOwn(f.book.jobs,id),'verification already assigned in an earlier period');
  if(!f.seen.includes(id)){assert(f.seen.length<512,'trial verification history capacity');f.seen.push(id);f.seen.sort();}
  // A node cannot earn multiple replica slots for the same verification target.
  assert(!Object.entries(f.book.jobs).some(([key,j])=>key!==id&&j.request.kind===q.kind&&j.request.demand===q.demand&&j.request.node===q.node),'duplicate verifier for demand');
  f.book=assignWork(f.book,q,s.money.time);if(f.targets[id])assert.deepEqual(f.targets[id],b.target);else f.targets[id]=b.target;
 }else{
  assert.equal(action.type,'COMPLETE_REWARD_WORK_V1');exact(action,['type','body','signature']);const b=action.body;exact(b,['domain','configHash','assignment','result']);
  assert.equal(b.domain,DOMAIN+'/COMPLETE');assert.equal(b.configHash,s.configHash);hex(b.assignment);const f=r.fundedWork,j=f?.book.jobs[b.assignment];assert(j,'unknown funded assignment');
  const n=r.nodes[j.request.node];assert.equal(author,n.key);assert(verify(b,action.signature,n.key),'verifier signature');assert.equal(b.result,hash(f.targets[b.assignment]),'assigned verification result');
  if(j.status==='accepted'){assert.equal(j.proof,b.result);return base;}
  const next=finishWork(f.book,b.assignment,b.result,s.money.time),emission=BigInt(j.emission),fee=BigInt(j.fee);
  n.earned=String(amount(n.earned)+fee+emission);r.minted=String(amount(r.minted)+emission);s.money.supply=String(amount(s.money.supply)+emission);s.money.fees=String(amount(s.money.fees)+emission);f.book=next;
 }
 auditFundedWork(s);return s;
}
export function advanceFundedWork(s){
 const f=s.rewards?.fundedWork;if(!f)return s;
 for(const [id,j] of Object.entries(f.book.jobs))if(j.status==='assigned'&&s.money.time>j.request.deadline)f.book=expireWork(f.book,id,s.money.time);
 return s;
}
export function auditFundedWork(s){
 const r=s.rewards,f=r?.fundedWork;if(!f)return;
 exact(f,['book','history','targets','closed','seen']);assert(Array.isArray(f.seen)&&f.seen.length<=512&&new Set(f.seen).size===f.seen.length);for(const id of f.seen)hex(id);assert(typeof f.closed==='boolean');if(f.closed)assert(!Object.values(f.book.jobs).some(j=>j.status==='assigned'));hex(f.history);auditWorkBudget(f.book);assert.equal(f.book.configHash,s.configHash);assert.deepEqual(f.book.calendar,r.coefficients.calendar);
 assert.equal(r.coefficients.alphaPPM,0);assert.equal(r.coefficients.workMeasure,'payment_value_v2');
 if(r.scheduled){assert.equal(r.scheduled.coefficients.alphaPPM,0,'cannot restart legacy emission');assert(amount(r.minted)+unissuedWorkBudget(r)<=amount(r.scheduled.coefficients.lifetimeMintLimit),'scheduled cap must cover funded work');}
 assert(amount(r.minted)+unissuedWorkBudget(r)<=amount(r.coefficients.lifetimeMintLimit));
 assert(amount(s.money.supply)+total(f.book.reservedEmission)<=amount(f.book.calendar.supplyCap));
 for(const [id,j]of Object.entries(f.book.jobs)){assert(f.seen.includes(id));assert(r.nodes[j.request.node]);assert(f.targets[id]);if(j.status==='accepted')assert.equal(j.proof,hash(f.targets[id]));}
}
