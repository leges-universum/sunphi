// Quorum-authorised, finite public-checkpoint verification jobs. This proves
// signed completion, not independent physical hardware or storage availability.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,verify,canonical} from './crypto.mjs';
import {amount} from './payment-model.mjs';
import {validatorQuorum} from './authority.mjs';
import {createWorkBudget,assignWork,finishWork,expireWork,auditWorkBudget,assignmentId} from './reward-work-budget.mjs';
export const FUNDED_ACTIONS=['OPEN_REWARD_WORK_V1','OPEN_REWARD_WORK_V2','OPEN_REWARD_WORK_V3','CLOSE_REWARD_WORK_V1','ASSIGN_REWARD_WORK_V1','COMPLETE_REWARD_WORK_V1','COMPLETE_REWARD_AVAILABILITY_V1'];
const DOMAIN='DUEBYTE_FUNDED_WORK_V1';
export const AVAILABILITY_SERVICE='bounded_key_availability_v1';
// This contract buys timely responses from admitted keys, NOT independent
// history execution, storage, household uniqueness or continuous uptime.
export function availabilityBody(s,id){
 const f=s.rewards?.fundedWork,j=f?.book.jobs[id];assert(f?.serviceContract===AVAILABILITY_SERVICE&&j,'availability assignment required');
 return {domain:DOMAIN+'/AVAILABILITY',configHash:s.configHash,assignment:id,policyHash:j.policyHash,challenge:f.challenges[id],result:hash(f.targets[id])};
}
const total=x=>Object.values(x).reduce((n,v)=>n+BigInt(v),0n);
// Operator IDs are payment-routing identities, not distinct beneficial owners.
// A quorum attests the grouping; it cannot establish anonymous human uniqueness.
// Retain known membership even when a node is omitted from later work periods.
function ownerRegistry(s,old,owners){
 const registry=structuredClone(old?.ownerRegistry??{nodes:{},operators:{}});
 const retain=(snapshot)=>{for(const [id,group] of Object.entries(snapshot)){
  assert(s.rewards.nodes[id],'unknown reward account');hex(id);if(group!==null)hex(group);
  const operator=s.money.nodes[id]?.operator;
  if(operator)assert(group!==null,'server owner group required');
  if(Object.hasOwn(registry.nodes,id))assert.equal(group,registry.nodes[id],'known owner group cannot change');
  if(operator&&Object.hasOwn(registry.operators,operator))assert.equal(group,registry.operators[operator],'operator owner group cannot change');
  if(group!==null){registry.nodes[id]=group;if(operator)registry.operators[operator]=group;}
 }};
 if(old&&!old.ownerRegistry)retain(old.book.owners);
 retain(owners);
 assert(Object.keys(registry.nodes).length<=256&&Object.keys(registry.operators).length<=256,'trial owner registry capacity');
 return registry;
}
export const reservedWorkFees=r=>r.fundedWork&&!r.fundedWork.closed?BigInt(r.fundedWork.book.feeBudget)-BigInt(r.fundedWork.book.paidFees):0n;
export const unissuedWorkBudget=r=>r.fundedWork&&!r.fundedWork.closed?amount(r.fundedWork.book.policy.homeEmissionBudget)+amount(r.fundedWork.book.policy.serverEmissionBudget)-total(r.fundedWork.book.minted):0n;
function certificate(s,a,c,fields){
 exact(a,['type','certificate']);const cert=a.certificate;exact(cert,['body','approvals']);const b=cert.body;
 exact(b,['domain','network','configHash','generation','notBefore','expires',...fields]);assert.equal(b.domain,DOMAIN+'/'+a.type);assert.equal(b.network,c.chainId);assert.equal(b.configHash,hash(c));assert.equal(b.generation,s.authority.generation);
 integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.expires-b.notBefore<=100&&s.height>=b.notBefore&&s.height<=b.expires,'funded work inclusion window');validatorQuorum(b,cert.approvals,s.authority.validators);return b;
}
export function applyFundedWork(base,action,author,c){
 const s=structuredClone(base),r=s.rewards;assert(r?.coefficients.calendar,'calendar required for funded work');assert.equal(r.coefficients.alphaPPM,0,'legacy emission must be off');assert.equal(r.coefficients.workMeasure,'payment_value_v2','normalised work required');
 if(['OPEN_REWARD_WORK_V1','OPEN_REWARD_WORK_V2','OPEN_REWARD_WORK_V3'].includes(action.type)){
  const b=certificate(s,action,c,['policy','feeBudget','owners']),old=r.fundedWork;
  const service=action.type==='OPEN_REWARD_WORK_V3';
  const bounded=action.type!=='OPEN_REWARD_WORK_V1';assert(!old?.targetFloor||bounded,'cannot downgrade bounded work history');
  assert(!old?.serviceContract||service,'cannot downgrade availability service');
  if(service){
   assert.deepEqual(Object.keys(b.policy.tariffs),['checkpoint'],'availability does not pay redundant payment attestations');
   assert.equal(b.policy.tariffs.checkpoint.segment,'home');assert.equal(b.policy.serverEmissionBudget,'0');
   assert(!Object.values(r.period.work).some(w=>BigInt(w.witness)>0n),'settle previously accepted witness work before service transition');
  }
  assert(b.policy.startTime>=s.money.time,'work period starts in the past');assert(b.policy.endTime-b.policy.startTime<=86400,'bounded assignment period');
  assert.equal(b.policy.version,old?old.book.policy.version+1:1);
  if(old){assert(s.money.time>old.book.policy.endTime,'previous funded period still open');assert(b.policy.startTime>=old.book.policy.endTime,'overlapping emission budgets');assert(!Object.values(old.book.jobs).some(j=>j.status==='assigned'),'unfinished prior assignments');r.period.fees=String(BigInt(r.period.fees)+reservedWorkFees(r));}
  assert(amount(b.feeBudget)<=amount(r.period.fees),'only collected unallocated fees fund jobs');
  const registry=ownerRegistry(s,old,b.owners);
  const budget=amount(b.policy.homeEmissionBudget)+amount(b.policy.serverEmissionBudget);
  assert(amount(r.minted)+budget<=amount(r.coefficients.lifetimeMintLimit),'lifetime assignment reservation');
  const book=createWorkBudget({configHash:s.configHash,calendar:r.coefficients.calendar,policy:b.policy,feeBudget:b.feeBudget,supply:s.money.supply,owners:b.owners});
  r.period.fees=String(amount(r.period.fees)-amount(b.feeBudget));
  r.fundedWork={book,history:hash({previous:old?.history??null,closed:old?.book??null}),targets:{},closed:false,seen:bounded?[]:[...(old?.seen??[])],ownerRegistry:registry,...(bounded?{targetFloor:{checkpoint:s.height,payment:s.money.height}}:{}),...(service?{serviceContract:AVAILABILITY_SERVICE,challenges:{},lastServiceAt:old?.lastServiceAt??null}:{})};
 }else if(action.type==='CLOSE_REWARD_WORK_V1'){
  const b=certificate(s,action,c,['version']),f=r.fundedWork;assert(f);assert.equal(b.version,f.book.policy.version);if(f.closed)return base;
  assert(s.money.time>f.book.policy.endTime,'funded period still open');assert(!Object.values(f.book.jobs).some(j=>j.status==='assigned'));
  r.period.fees=String(BigInt(r.period.fees)+reservedWorkFees(r));f.closed=true;f.history=hash({previous:f.history,closed:f.book});
 }else if(action.type==='ASSIGN_REWARD_WORK_V1'){
  const b=certificate(s,action,c,['request','target']),f=r.fundedWork;assert(f&&!f.closed,'no open funded work period');
  const q=b.request;assert.equal(q.units,1,'one unique verification per assignment');assert(q.replica<3,'bounded verification replicas');
  if(f.serviceContract){
   assert.equal(q.kind,'checkpoint','availability service only');
   assert(q.deadline<=s.money.time+180,'bounded availability response window');
   const repeated=Object.values(f.book.jobs).some(j=>j.request.demand===q.demand);
   if(!repeated)assert(f.lastServiceAt===null||s.money.time-f.lastServiceAt>=300,'bounded availability sampling rate');
  }
  assert(['checkpoint','payment'].includes(q.kind),'unsupported verification class');
  const n=r.nodes[q.node];assert(n,'unknown verifier');
  if(q.kind==='checkpoint'){
   exact(b.target,['height','stateHash']);assert.deepEqual(b.target,r.period.anchor,'current assigned checkpoint');assert.equal(q.demand,hash(b.target),'checkpoint demand');
   assert.equal(f.book.policy.tariffs[q.kind]?.segment,'home');assert.equal(n.kind,'witness');
  }else{
   exact(b.target,['pid','digest','terminalHeight']);const payment=s.money.requests[b.target.pid];assert(payment?.status==='SETTLED','only settled payment verification');
   assert.deepEqual(b.target,{pid:payment.intent.pid,digest:payment.digest,terminalHeight:payment.terminalHeight});assert.equal(q.demand,b.target.pid);assert.equal(f.book.policy.tariffs[q.kind]?.segment,'server');assert.equal(n.kind,'worker');
  }
  // V2 admits only targets created at/after this window opened. Earlier
  // targets can never be paid again, so prior job IDs need not grow forever.
  if(f.targetFloor)assert((q.kind==='checkpoint'?b.target.height:b.target.terminalHeight)>=f.targetFloor[q.kind],'target belongs to an earlier work window');
  const id=assignmentId(s.configHash,q.kind,q.demand,q.replica);
  assert(!f.seen.includes(id)||Object.hasOwn(f.book.jobs,id),'verification already assigned in an earlier period');
  if(!f.seen.includes(id)){assert(f.seen.length<512,'trial verification history capacity');f.seen.push(id);f.seen.sort();}
  // A node cannot earn multiple replica slots for the same verification target.
  assert(!Object.entries(f.book.jobs).some(([key,j])=>key!==id&&j.request.kind===q.kind&&j.request.demand===q.demand&&j.request.node===q.node),'duplicate verifier for demand');
  f.book=assignWork(f.book,q,s.money.time);if(f.targets[id])assert.deepEqual(f.targets[id],b.target);else f.targets[id]=b.target;
  if(f.serviceContract&&!f.challenges[id]){f.challenges[id]=hash({domain:DOMAIN+'/CHALLENGE',block:s.blockHash,height:s.height,assignment:id,policyHash:hash(f.book.policy)});f.lastServiceAt=s.money.time;}
 }else{
  assert(['COMPLETE_REWARD_WORK_V1','COMPLETE_REWARD_AVAILABILITY_V1'].includes(action.type));exact(action,['type','body','signature']);const b=action.body;hex(b.assignment);const f=r.fundedWork,j=f?.book.jobs[b.assignment];assert(j,'unknown funded assignment');
  if(f.serviceContract){assert.equal(action.type,'COMPLETE_REWARD_AVAILABILITY_V1','public target signature is not an availability response');assert.deepEqual(b,availabilityBody(s,b.assignment),'availability challenge binding');}
  else {assert.equal(action.type,'COMPLETE_REWARD_WORK_V1');exact(b,['domain','configHash','assignment','result']);assert.equal(b.domain,DOMAIN+'/COMPLETE');assert.equal(b.configHash,s.configHash);}
  const n=r.nodes[j.request.node];assert.equal(author,n.key);assert(verify(b,action.signature,n.key),'verifier signature');assert.equal(b.result,hash(f.targets[b.assignment]),'assigned verification result');
  if(j.status==='accepted'){assert.equal(j.proof,b.result);return base;}
  const next=finishWork(f.book,b.assignment,b.result,s.money.time),emission=BigInt(j.emission),fee=BigInt(j.fee);
  n.earned=String(amount(n.earned)+fee+emission);r.minted=String(amount(r.minted)+emission);s.money.supply=String(amount(s.money.supply)+emission);s.money.fees=String(amount(s.money.fees)+emission);f.book=next;
 }
 auditFundedWork(s);
 if(r.fundedWork.targetFloor)assert(Buffer.byteLength(canonical(s))<=1048576-131072,'funded work state capacity; existing claims retained');
 return s;
}
export function advanceFundedWork(s){
 const f=s.rewards?.fundedWork;if(!f)return s;
 for(const [id,j] of Object.entries(f.book.jobs))if(j.status==='assigned'&&s.money.time>j.request.deadline)f.book=expireWork(f.book,id,s.money.time);
 return s;
}
export function auditFundedWork(s){
 const r=s.rewards,f=r?.fundedWork;if(!f)return;
 exact(f,['book','history','targets','closed','seen',...(f.ownerRegistry?['ownerRegistry']:[]),...(f.targetFloor?['targetFloor']:[]),...(f.serviceContract?['serviceContract','challenges','lastServiceAt']:[])]);assert(Array.isArray(f.seen)&&f.seen.length<=512&&new Set(f.seen).size===f.seen.length);for(const id of f.seen)hex(id);assert(typeof f.closed==='boolean');if(f.closed)assert(!Object.values(f.book.jobs).some(j=>j.status==='assigned'));hex(f.history);auditWorkBudget(f.book);assert.equal(f.book.configHash,s.configHash);assert.deepEqual(f.book.calendar,r.coefficients.calendar);
 if(f.serviceContract){assert.equal(f.serviceContract,AVAILABILITY_SERVICE);assert(f.targetFloor);assert.equal(f.book.policy.serverEmissionBudget,'0');assert.deepEqual(Object.keys(f.book.policy.tariffs),['checkpoint']);assert.deepEqual(Object.keys(f.challenges).sort(),Object.keys(f.book.jobs).sort());Object.values(f.challenges).forEach(hex);if(f.lastServiceAt!==null)integer(f.lastServiceAt,1);for(const j of Object.values(f.book.jobs)){assert.equal(j.request.kind,'checkpoint');assert(j.request.deadline<=j.createdAt+180);}}
 if(f.targetFloor){exact(f.targetFloor,['checkpoint','payment']);integer(f.targetFloor.checkpoint,1);integer(f.targetFloor.payment,1);assert(f.targetFloor.checkpoint<=s.height&&f.targetFloor.payment<=s.money.height);assert.deepEqual([...f.seen].sort(),Object.keys(f.book.jobs).sort());for(const [id,j]of Object.entries(f.book.jobs))assert((j.request.kind==='checkpoint'?f.targets[id].height:f.targets[id].terminalHeight)>=f.targetFloor[j.request.kind],'old target in bounded work ledger');}
 if(f.ownerRegistry){
  exact(f.ownerRegistry,['nodes','operators']);
  for(const entries of Object.values(f.ownerRegistry)){assert(entries&&typeof entries==='object'&&!Array.isArray(entries));assert(Object.keys(entries).length<=256);for(const [id,group] of Object.entries(entries)){hex(id);hex(group);}}
  for(const [id,group] of Object.entries(f.ownerRegistry.nodes)){assert(r.nodes[id]);const op=s.money.nodes[id]?.operator;if(op)assert.equal(f.ownerRegistry.operators[op],group);}
  assert.deepEqual(ownerRegistry(s,f,f.book.owners),f.ownerRegistry);
 }
 assert.equal(r.coefficients.alphaPPM,0);assert.equal(r.coefficients.workMeasure,'payment_value_v2');
 if(r.scheduled){assert.equal(r.scheduled.coefficients.alphaPPM,0,'cannot restart legacy emission');assert(amount(r.minted)+unissuedWorkBudget(r)<=amount(r.scheduled.coefficients.lifetimeMintLimit),'scheduled cap must cover funded work');}
 assert(amount(r.minted)+unissuedWorkBudget(r)<=amount(r.coefficients.lifetimeMintLimit));
 assert(amount(s.money.supply)+total(f.book.reservedEmission)<=amount(f.book.calendar.supplyCap));
 for(const [id,j]of Object.entries(f.book.jobs)){assert(f.seen.includes(id));assert(r.nodes[j.request.node]);assert(f.targets[id]);if(j.status==='accepted')assert.equal(j.proof,hash(f.targets[id]));}
}
