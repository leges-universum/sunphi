// Pure, deterministic proposal planner. It neither signs certificates nor mints.
// Independent signers must recompute a proposal from their own certified state.
import assert from'node:assert/strict';
import{hash,hex,integer}from'./crypto.mjs';
import{assignmentId,assignWork}from'./reward-work-budget.mjs';
import{periodAllowance,DUBYT_SUPPLY_CAP}from'./emission-calendar.mjs';
import{AVAILABILITY_SERVICE}from'./funded-reward-work.mjs';
import{CENTURY_SUBSIDY_ACTION,centuryOwnerSnapshot}from'./century-subsidy.mjs';
import{anniversary}from'./economic-policy-v2.mjs';
import{ECONOMIC_POLICY_VERSION_V4}from'./economic-policy-v3.mjs';
export const STARTER_TARIFFS=Object.freeze({
 edition:1,periodSeconds:3600,noticeSeconds:120,deadlineSeconds:180,
 checkpointIntervalSeconds:300,maxInFlightPerNode:2,
 nodeEmissionCap:'12',groupEmissionCap:'24',homeEmissionBudget:'36',serverEmissionBudget:'36',maxAssignments:128,
 tariffs:{checkpoint:{segment:'home',fee:'0',emission:'1'},payment:{segment:'server',fee:'0',emission:'1'}}
});
export function rewardOwners(state,known){
 const owners={},registry=state.rewards?.fundedWork?.ownerRegistry?.nodes??{};
 for(const [id,n]of Object.entries(state.rewards.nodes).sort(([a],[b])=>a.localeCompare(b))){
  const group=known[id]??registry[id]??null;if(group!==null)hex(group);
  if(n.kind==='worker')assert(group!==null,'Known server owner group required before scheduling');
  if(registry[id])assert.equal(group,registry[id],'Cannot forget a known owner');owners[id]=group;
 }
 return owners;
}
export function nextCenturyRewardProposal(state,{noticeSeconds=120}={}){
 const book=state.centurySubsidy,access=state.networkReserves?.development?.access;
 // Continue only an already authorized clock and tariff. Initial issuance,
 // pilot exit and the first tariff require their separate explicit procedures.
 if(!state.centuryFees||!state.rewards||!book||book.pending||state.centuryFunds?.zeroStage||access?.pending)return null;
 if(state.economicPreparation?.plan.version!==ECONOMIC_POLICY_VERSION_V4||state.economicPreparation.planHash!==book.planHash||state.centuryFunds?.execution?.start!==book.start)return null;
 integer(noticeSeconds,1);assert(noticeSeconds<=300,'bounded subsidy notice');
 assert.equal(state.money.unitScale,'1000000');
 const now=state.money.time,from=Math.max(now+noticeSeconds,book.cursor,state.centuryFunds.support?.to??0),change=book.policyControl?.pending;
 if(from-now>300)return null;
 const due=change&&from>=change.effectiveFrom,policy=due?change.policy:book.policy;
 if(due&&(now<change.effectiveFrom||!access||access.epoch!==change.managementEpoch))return null;
 // Do not infer admission from a partial registry or silently rescale tariffs.
 if(!policy.admission){if(!Array.isArray(policy.workers)||!policy.workers.length)return null;
 assert(policy.workers.length<=128&&new Set(policy.workers).size===policy.workers.length,'legacy paid roster bound');}
 const to=from+policy.intervalSeconds;
 if(to>anniversary(book.start,100)||change&&!due&&to>change.effectiveFrom)return null;
 return{type:CENTURY_SUBSIDY_ACTION,requiresFounderConsent:true,fields:{planHash:book.planHash,sequence:book.sequence+1,start:book.start,from,to,policy:structuredClone(policy),ownersHash:hash(centuryOwnerSnapshot(state,policy))}};
}
export function nextRewardProposal(state,{knownOwners={},settings=STARTER_TARIFFS}={}){
 if(state.centuryFees)return nextCenturyRewardProposal(state,{noticeSeconds:settings.noticeSeconds});
 const r=state.rewards;if(!r?.coefficients.calendar)return null;
 assert.equal(r.coefficients.alphaPPM,0);assert.equal(r.coefficients.workMeasure,'payment_value_v2');
 integer(settings.periodSeconds,60);assert(settings.periodSeconds<=86400);integer(settings.noticeSeconds,1);integer(settings.deadlineSeconds,1);integer(settings.checkpointIntervalSeconds,1);integer(settings.maxInFlightPerNode,1);
 const now=state.money.time,f=r.fundedWork;
 const availability=settings.serviceContract===AVAILABILITY_SERVICE;
 assert(!settings.serviceContract||availability,'unsupported reward service contract');
 assert(!f?.serviceContract||availability,'cannot downgrade availability scheduler');
 if(availability){assert.equal(settings.serverEmissionBudget,'0');assert.deepEqual(Object.keys(settings.tariffs),['checkpoint']);assert(settings.checkpointIntervalSeconds>=300);assert(settings.deadlineSeconds<=180);}
 if(!f||now>f.book.policy.endTime){
  if(f&&Object.values(f.book.jobs).some(j=>j.status==='assigned'))return null;
  const startTime=now+settings.noticeSeconds,endTime=Math.min(startTime+settings.periodSeconds,r.coefficients.calendar.endTime);
  if(endTime<=startTime)return null;
  const available=[periodAllowance(r.coefficients.calendar,startTime,endTime),BigInt(r.coefficients.lifetimeMintLimit)-BigInt(r.minted),DUBYT_SUPPLY_CAP-BigInt(state.money.supply)].reduce((a,b)=>a<b?a:b);
  let home=BigInt(settings.homeEmissionBudget),server=BigInt(settings.serverEmissionBudget);const wanted=home+server;
  if(wanted>available){home=available*home/wanted;server=available-home;}if(home+server===0n)return null;
  const policy={version:(f?.book.policy.version??0)+1,startTime,endTime,nodeEmissionCap:settings.nodeEmissionCap,groupEmissionCap:settings.groupEmissionCap,homeEmissionBudget:String(home),serverEmissionBudget:String(server),maxAssignments:settings.maxAssignments,tariffs:structuredClone(settings.tariffs)};
  if(availability&&Object.values(r.period.work).some(w=>BigInt(w.witness)>0n))return null;
  return{type:availability?'OPEN_REWARD_WORK_V3':'OPEN_REWARD_WORK_V2',fields:{policy,feeBudget:'0',owners:rewardOwners(state,knownOwners)}};
 }
 if(f.closed||!f.targetFloor||now<f.book.policy.startTime||now+2>=f.book.policy.endTime)return null;
 const jobs=Object.values(f.book.jobs),candidates=[];
 const anchor=r.period.anchor,demand=hash(anchor),otherCheckpoint=jobs.filter(j=>j.request.kind==='checkpoint'&&j.request.demand!==demand);
 const sameTarget=jobs.some(j=>j.request.kind==='checkpoint'&&j.request.demand===demand);
 if(anchor.height>=f.targetFloor.checkpoint&&(!availability||sameTarget||f.lastServiceAt===null||now-f.lastServiceAt>=settings.checkpointIntervalSeconds)&&(!otherCheckpoint.length||now-Math.max(...otherCheckpoint.map(j=>j.createdAt))>=settings.checkpointIntervalSeconds))candidates.push({kind:'checkpoint',demand,target:anchor});
 if(!availability)for(const p of Object.values(state.money.requests).filter(p=>p.status==='SETTLED'&&p.terminalHeight>=f.targetFloor.payment).sort((a,b)=>a.terminalHeight-b.terminalHeight||a.intent.pid.localeCompare(b.intent.pid)))candidates.push({kind:'payment',demand:p.intent.pid,target:{pid:p.intent.pid,digest:p.digest,terminalHeight:p.terminalHeight}});
 // Fair opportunity within each class; faster completion frees the next slot.
 // Subsidy is linear in accepted unique work until node/owner caps; raw hardware
 // claims, OS names and the number of registered copies never increase a tariff.
 for(const target of candidates)for(let replica=0;replica<3;replica++){
  const id=assignmentId(state.configHash,target.kind,target.demand,replica);if(f.book.jobs[id])continue;
  const kind=target.kind==='checkpoint'?'witness':'worker';
  const nodes=Object.keys(f.book.owners).filter(id=>r.nodes[id]?.kind===kind&&jobs.filter(j=>j.request.node===id&&j.status==='assigned').length<settings.maxInFlightPerNode&&!jobs.some(j=>j.request.node===id&&j.request.kind===target.kind&&j.request.demand===target.demand));
  nodes.sort((a,b)=>{const aa=BigInt(f.book.nodeUsed[a]??'0'),bb=BigInt(f.book.nodeUsed[b]??'0');return aa===bb?a.localeCompare(b):aa<bb?-1:1;});
  for(const node of nodes){const request={kind:target.kind,demand:target.demand,replica,node,units:1,deadline:Math.min(now+settings.deadlineSeconds,f.book.policy.endTime-1)};
   try{assignWork(f.book,request,now);}catch{continue;}
   return{type:'ASSIGN_REWARD_WORK_V1',fields:{request,target:target.target}};
  }
 }
 return null;
}
