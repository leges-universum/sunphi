// Consensus custody adapter. Admission remains behind the closed issuance gate.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,verify} from './crypto.mjs';import {amount,MAX} from './payment-model.mjs';
import {quorum} from './authority.mjs';import {developmentManager} from './reserve-recovery.mjs';
import {effectiveWorkGroup} from './payment-liability.mjs';import {datedAllowance} from './economic-policy-v2.mjs';
import {copyControllerState} from './controller-context.mjs';
import {supportAccount,supportOutput,supportIssued,lockedSupport,SUPPORT_DOMAIN} from './support-accounting.mjs';
import {createSupportBook,auditSupportBook,claimSupport,queueSupportReturn,returnSupport,reconcileSupportPenalty} from './research/locked-collateral-support.mjs';
export const OPEN_SUPPORT='OPEN_COLLATERAL_SUPPORT_V1',CLAIM_SUPPORT='CLAIM_COLLATERAL_SUPPORT_V1',QUEUE_SUPPORT='QUEUE_COLLATERAL_SUPPORT_RETURN_V1',RETURN_SUPPORT='RETURN_COLLATERAL_SUPPORT_V1';
export const SUPPORT_ACTIONS=[OPEN_SUPPORT,CLAIM_SUPPORT,QUEUE_SUPPORT,RETURN_SUPPORT];
const group=(s,id)=>hash({domain:SUPPORT_DOMAIN+'/OWNER',owner:effectiveWorkGroup(s.money,id)});
export const supportOwnerGroup=group;
function pool(s,value){assert(value>=0n&&value<=MAX);s.money.outputs[supportOutput(s.configHash)]={owner:supportAccount(s.configHash),value:String(value),unlock:0};}
export function auditWorkerSupport(s){
 const f=s.centuryFunds?.support;if(!f)return;exact(f,['certificateHash','from','to','book']);hex(f.certificateHash);auditSupportBook(f.book);
 assert.equal(f.book.configHash,s.configHash);assert.equal(f.book.start,s.centuryFunds.execution.warmupStart);integer(f.from,s.centuryFunds.execution.start);integer(f.to,f.from+1);assert(f.to<=s.money.time&&f.to-f.from<=86400);
 assert(supportIssued(s)<=amount(datedAllowance({start:s.centuryFunds.execution.start,from:f.from,to:f.to,existingSupplyMicro:s.economicPreparation.plan.existingSupplyMicro,kind:'regular'})));
 assert(supportIssued(s)<=amount(s.economicPreparation.plan.regularMicro));
 const o=s.money.outputs[supportOutput(s.configHash)];assert(o&&o.owner===supportAccount(s.configHash)&&o.unlock===0);assert.equal(o.value,f.book.poolMicro);
 for(const [id,g]of Object.entries(f.book.grants)){const n=s.money.nodes[id];assert(n,'supported worker retained');assert(amount(n.stake)>=amount(g.lockedMicro),'support loss must be reconciled');}
}
export function applyWorkerSupport(base,a,author,c){
 assert(SUPPORT_ACTIONS.includes(a.type));assert.equal(base.money.unitScale,'1000000');assert(base.centuryFees&&base.rewards&&base.centuryFunds?.execution?.warmupStart,'authorized warmup clock required');
 if(a.type===OPEN_SUPPORT){
  exact(a,['type','certificate','founderConsent']);exact(a.certificate,['body','approvals']);const b=a.certificate.body;
  exact(b,['domain','network','configHash','generation','notBefore','expires','planHash','managementEpoch','supplyBefore','from','to','allocationMicro','perNodeCapMicro','ownerCaps','matchPPM','bootstrapNodes']);
  assert.equal(b.domain,a.type);assert.equal(b.network,c.chainId);assert.equal(b.configHash,base.configHash);assert.equal(b.generation,base.authority.generation);assert.equal(b.planHash,base.economicPreparation.planHash);
  const access=base.networkReserves.development.access;assert(access&&!access.pending);assert.equal(b.managementEpoch,access.epoch);integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.expires-b.notBefore<=100&&base.height>=b.notBefore&&base.height<=b.expires);
  quorum(b,a.certificate.approvals,base.authority.validators,7);assert(verify(b,a.founderConsent,developmentManager(base.networkReserves)),'founder support consent');
  if(base.centuryFunds.support){assert.equal(base.centuryFunds.support.certificateHash,hash(a.certificate),'support allocation already admitted');return base;}
  assert(!base.centurySubsidy,'allocate support before first regular subsidy interval');assert.equal(b.supplyBefore,base.money.supply);
  const x=base.centuryFunds.execution,e=base.economicPreparation.plan;integer(b.from,x.start);integer(b.to,b.from+1);assert(b.to<=base.money.time&&b.to-b.from<=86400);
  const v=amount(b.allocationMicro);assert(v>0n&&v<=amount(e.regularMicro));assert(v<=amount(datedAllowance({start:x.start,from:b.from,to:b.to,existingSupplyMicro:e.existingSupplyMicro,kind:'regular'})),'shared regular allowance');
  assert(!base.money.outputs[supportOutput(base.configHash)],'support pool collision');
  const book=createSupportBook({configHash:base.configHash,warmupStart:x.warmupStart,allocationReference:hash(a.certificate),allocationMicro:b.allocationMicro,perNodeCapMicro:b.perNodeCapMicro,ownerCaps:b.ownerCaps,matchPPM:b.matchPPM,bootstrapNodes:b.bootstrapNodes});assert(base.money.time<book.end,'five-year support window');
  for(const id of b.bootstrapNodes){assert(base.rewards.nodes[id]?.kind==='worker'&&base.money.nodes[id]);assert(Object.hasOwn(b.ownerCaps,group(base,id)),'bootstrap owner not admitted');}
  const s=copyControllerState(base,['centuryFunds']);s.centuryFunds.support={certificateHash:hash(a.certificate),from:b.from,to:b.to,book};pool(s,v);s.money.supply=String(amount(s.money.supply)+v);assert(amount(s.money.supply)<=MAX);auditWorkerSupport(s);return s;
 }
 assert(base.centuryFunds.support,'support pool unissued');const s=copyControllerState(base,['centuryFunds']);let f=s.centuryFunds.support;
 if(a.type===RETURN_SUPPORT){
  exact(a,['type','node']);hex(a.node);const n=s.money.nodes[a.node];assert(n);const liabilities=Object.values(s.money.liability?.records??{}).filter(r=>r.assignments.some(x=>x.node===a.node)).length;
  const r=returnSupport(f.book,{node:a.node,at:s.money.time,tier:n.tier,heldMicro:String(amount(n.consensusHeld)+amount(n.taskHeld)),unresolvedLiabilities:liabilities,stakeMicro:n.stake});f.book=r.book;n.stake=String(amount(n.stake)-amount(r.stakeDebitMicro));pool(s,amount(f.book.poolMicro));
 }else{
  exact(a,['type','body','managementSignature','workerSignature']);const b=a.body;exact(b,['domain','configHash','node','issuedAt','expires']);assert.equal(b.domain,a.type);assert.equal(b.configHash,s.configHash);hex(b.node);
  const n=s.money.nodes[b.node],r=s.rewards.nodes[b.node];assert(n&&r?.kind==='worker','registered reward worker required');assert.equal(author,r.management);assert(verify(b,a.managementSignature,r.management)&&verify(b,a.workerSignature,n.key),'worker and management consents');integer(b.issuedAt,1);integer(b.expires,b.issuedAt+1);assert(b.expires-b.issuedAt<=600&&b.issuedAt<=s.money.time&&s.money.time<b.expires,'support UTC consent');
  if(a.type===CLAIM_SUPPORT){
   assert(s.money.time<f.book.end,'five-year support window');assert(!s.workerFunding?.accounts[b.node]?.release,'owned release pending');
   const prior=f.book.grants[b.node];if(prior){assert.equal(prior.claimHash,hash({configHash:s.configHash,node:b.node,ownerGroup:group(s,b.node),ownCollateralMicro:'0',at:b.issuedAt}),'one-time support');return base;}
   const owned=s.workerFunding?.accounts[b.node],free=amount(n.stake)>amount(n.consensusHeld)+amount(n.taskHeld)?amount(n.stake)-amount(n.consensusHeld)-amount(n.taskHeld):0n,paid=owned?amount(owned.depositedMicro)-amount(owned.withdrawnMicro??'0'):0n;
   const q={configHash:s.configHash,node:b.node,ownerGroup:group(s,b.node),ownCollateralMicro:String(free<paid?free:paid),at:b.issuedAt};const claimed=claimSupport(f.book,q);f.book=claimed.book;
   // Replay is bound to the signed claim, not mutable own-capital observations.
   f.book.grants[b.node].claimHash=hash({...q,ownCollateralMicro:'0'});n.stake=String(amount(n.stake)+amount(claimed.stakeCreditMicro));assert(amount(n.stake)<=MAX);pool(s,amount(f.book.poolMicro));
  }else{const q=queueSupportReturn(f.book,{node:b.node,at:s.money.time,challengeSeconds:s.money.liability?.policy.challengeSeconds??0});f.book=q.book;n.tier='0';}
 }
 auditWorkerSupport(s);return s;
}
// Proven penalties and every other committed stake change run in the same frame.
export function reconcileWorkerSupport(s,touched){
 const f=s.centuryFunds?.support;if(!f)return;
 for(const [key,r]of touched)if(r.bucket==='nodes'&&r.value){const id=key.slice(6),g=f.book.grants[id];if(g&&!g.returned&&amount(r.value.stake)<amount(g.lockedMicro))f.book=reconcileSupportPenalty(f.book,{node:id,stakeAfterMicro:r.value.stake,reference:hash({domain:SUPPORT_DOMAIN+'/STAKE_CHANGE',height:s.height,node:id,stake:r.value.stake})}).book;}
}
