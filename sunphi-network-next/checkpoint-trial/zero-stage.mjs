// Prospective bounded pilot. Preparation neither issues tokens nor starts clocks.
import assert from 'node:assert/strict';
import {activePaymentTariff} from './payment-tariff.mjs';
import {exact,hash,hex,integer,verify} from './crypto.mjs';
import {amount,CENTURY_WARMUP_DOMAIN} from './payment-model.mjs';
import {validatorQuorum} from './authority.mjs';
import {developmentManager} from './reserve-recovery.mjs';
import {copyControllerState,controllerContext} from './controller-context.mjs';
import {liabilityEnabled,eligibleLiabilityWorker,effectiveWorkGroup} from './payment-liability.mjs';
import {zeroStageProposal,zeroStageSlot,terminalPilot} from './research/zero-stage-plan.mjs';
import {SUPPORT_DOMAIN} from './support-accounting.mjs';
import {ISSUE_FOUNDER_ADVANCE,FOUNDER_ADVANCE_MICRO,PERSONAL_COLLATERAL_MICRO} from './founder-advance-policy.mjs';
export const PREPARE_ZERO_STAGE='PREPARE_ZERO_STAGE_V1';
export function zeroStageConsent(body,node){
 const worker=body.workers.find(w=>w.node===node);assert(worker,'pilot worker');
 return {domain:'DUEBYTE_ZERO_STAGE_WORKER_CONSENT_V1',network:body.network,configHash:body.configHash,
  termsHash:hash(body),policyHash:body.liabilityPolicyHash,...worker};
}
function proposal(b){return zeroStageProposal({configHash:b.configHash,root:b.observedRoot,height:b.observedHeight,workers:b.workers,settings:b.settings});}
function terms(b){
 exact(b,['domain','network','configHash','generation','notBefore','expires','manifestHash','managementEpoch','observedRoot','observedHeight','liabilityPolicyHash','startsAt','workers','settings']);
 assert.equal(b.domain,PREPARE_ZERO_STAGE);hex(b.configHash);hex(b.manifestHash);hex(b.liabilityPolicyHash);integer(b.generation);integer(b.managementEpoch);
 integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.expires-b.notBefore<=100);integer(b.startsAt,1);
 const p=proposal(b);assert(b.settings.spacingSeconds>=(terminalPilot(b.settings)?20:600),'pilot spacing floor');if(!terminalPilot(b.settings))assert(amount(b.settings.paymentMicro)<=50000n,'pilot payment ceiling');
 integer(b.startsAt+b.settings.durationSeconds,1);return p.body;
}
function current(s,b,{coverage=false}={}){
 const m=s.money,l=m.liability;
 assert.equal(hash(activePaymentTariff(m)),hash(b.settings.feeSchedule),'pilot tariff changed');assert(liabilityEnabled(m)&&l.policy.version===(terminalPilot(b.settings)?4:3),'expanded UTC liability required');
 assert.equal(hash(l.policy),b.liabilityPolicyHash,'pilot liability policy changed');
 assert.equal(l.policy.challengeSeconds,b.settings.challengeSeconds);assert.equal(l.policy.maxOpen,b.settings.maxOpen);assert.equal(l.policy.maxAssignments,b.settings.maxAssignments);
 const p=proposal(b).body;
 for(const w of b.workers){const n=m.nodes[w.node],r=s.rewards?.nodes[w.node];
  assert(n?.key===w.key&&effectiveWorkGroup(m,w.node)===w.operator,'pilot worker identity changed');
  assert(r?.kind==='worker'&&r.key===w.key,'pilot reward worker');
  assert.deepEqual(r.payouts,[{wallet:w.recipient,weight:1}],'pilot payout binding changed');
  assert(eligibleLiabilityWorker(m,w.node)&&l.consents[w.node],'pilot liability consent required');
  if(coverage){assert(amount(n.stake)>=amount(p.worstCaseWorkerMicro),'pilot collateral below coverage');
   assert(amount(n.consensusHeld)>=amount(b.settings.consensusReserveMicro),'pilot consensus reserve');
   assert(amount(n.stake)-amount(n.consensusHeld)-amount(n.taskHeld)>=amount(b.settings.paymentMicro),'pilot free collateral');
   assert(amount(n.tier)>=amount(b.settings.paymentMicro),'pilot worker tier');
  }
 }
 return p;
}
// A pilot grant has a pre-signed capacity mandate. It may activate only an
// unfunded, idle worker; it never changes CometBFT validator voting power.
export function activatePilotSupport(s,node,grant){
 const z=s.centuryFunds?.zeroStage;if(!z)return;
 const b=z.body,p=current(s,b),n=s.money.nodes[node];
 assert(b.workers.some(w=>w.node===node),'pilot support worker');
 if(terminalPilot(b.settings)){
  const owned=s.workerFunding?.accounts[node];
  if(!grant||grant.returned||grant.returnAfter!==null||!owned||owned.release||
   owned.owner!==s.centuryFunds.manifest.founder.recipient||
   amount(owned.depositedMicro)-amount(owned.withdrawnMicro??'0')<amount(PERSONAL_COLLATERAL_MICRO)||
   amount(n.stake)<100000000n)return;
  if(n.tier!=='0'||n.taskHeld!=='0'||n.consensusHeld!=='0')return;
  assert.equal(grant.lockedMicro,'10000000');
  n.consensusHeld=b.settings.consensusReserveMicro;n.tier=b.settings.paymentMicro;return;
 }
 assert.equal(n.consensusHeld,'0','pilot activation requires idle reserve');
 assert.equal(n.taskHeld,'0','pilot activation requires idle tasks');
 assert.equal(n.tier,'0','pilot activation requires disabled capacity');
 assert.equal(n.stake,grant.lockedMicro,'pilot activation requires support-only stake');
 assert(amount(grant.lockedMicro)>=amount(p.worstCaseWorkerMicro),'pilot grant below coverage');
 n.consensusHeld=b.settings.consensusReserveMicro;n.tier=b.settings.paymentMicro;
}
export function releasePilotSupportReserve(s,node,grant){
 const z=s.centuryFunds?.zeroStage;if(!z||grant?.returned)return;
 assert(z.body.workers.some(w=>w.node===node),'pilot support worker');
 const n=s.money.nodes[node];
 assert(grant&&grant.returnAfter!==null&&s.money.time>=grant.returnAfter,'pilot support cooldown');
 assert.equal(n.tier,'0','pilot worker must be drained');assert.equal(n.taskHeld,'0','pilot outstanding tasks');
 assert(!Object.values(s.money.liability?.records??{}).some(r=>r.assignments.some(x=>x.node===node)),'pilot unresolved liability');
 assert.equal(n.consensusHeld,z.body.settings.consensusReserveMicro,'pilot reserve changed');
 n.consensusHeld='0';
}
export function prepareZeroStage(base,a,c){
 exact(a,['type','certificate','founderConsent','workerConsents']);assert.equal(a.type,PREPARE_ZERO_STAGE);exact(a.certificate,['body','approvals']);
 const b=a.certificate.body;terms(b);assert.equal(b.network,c.chainId);assert.equal(b.configHash,base.configHash);assert.equal(b.generation,base.authority.generation);
 const access=base.networkReserves?.development.access;assert(access&&!access.pending);assert.equal(b.managementEpoch,access.epoch);assert.equal(b.manifestHash,base.centuryFunds?.manifestHash);
 assert(base.height>=b.notBefore&&base.height<=b.expires,'pilot inclusion window');
 validatorQuorum(b,a.certificate.approvals,base.authority.validators);assert(verify(b,a.founderConsent,developmentManager(base.networkReserves)),'pilot founder consent');
 assert(Array.isArray(a.workerConsents)&&a.workerConsents.length===b.workers.length,'all pilot worker consents required');
 const seen=new Set();for(const row of a.workerConsents){exact(row,['node','signature']);assert(!seen.has(row.node),'duplicate pilot consent');seen.add(row.node);
  const consent=zeroStageConsent(b,row.node);assert(verify(consent,row.signature,consent.key),'pilot worker consent signature');}
 const certificateHash=hash(a);if(base.centuryFunds.zeroStage){assert.equal(base.centuryFunds.zeroStage.certificateHash,certificateHash,'pilot admission immutable');return base;}
 assert(!base.centuryFunds.execution&&!base.centuryFunds.support&&!base.centurySubsidy&&!base.centuryWarmup,'pilot precedes funding');
 assert(b.startsAt>=base.money.time&&b.startsAt-base.money.time<=86400,'prospective pilot UTC start');
 const context=controllerContext(base);if(context){assert.equal(b.observedRoot,context.parentRoot,'pilot review root');assert.equal(b.observedHeight,context.parentHeight,'pilot review height');}
 else{assert(b.observedHeight<=base.height&&base.height-b.observedHeight<=1,'pilot review height');}
 current(base,b);const s=copyControllerState(base,['centuryFunds']);
 s.centuryFunds.zeroStage={body:structuredClone(b),certificateHash,admittedHeight:s.height,attempts:0,chargedFeeMicro:'0',lastAttemptAt:null};
 auditZeroStage(s);return s;
}
export function auditZeroStage(s){
 const z=s.centuryFunds?.zeroStage;if(!z)return;
 exact(z,['body','certificateHash','admittedHeight','attempts','chargedFeeMicro','lastAttemptAt']);const p=terms(z.body);
 assert.equal(z.body.configHash,s.configHash);assert.equal(z.body.manifestHash,s.centuryFunds.manifestHash);hex(z.certificateHash);integer(z.admittedHeight,1);assert(z.admittedHeight<=s.height);
 integer(z.attempts);assert(z.attempts<=p.maximumPayments);assert.equal(amount(z.chargedFeeMicro),BigInt(z.attempts)*amount(p.feePerPaymentMicro));assert(amount(z.chargedFeeMicro)<=amount(p.maximumFeesMicro));
 if(z.attempts){integer(z.lastAttemptAt,z.body.startsAt);assert(z.lastAttemptAt<s.money.time+1&&z.lastAttemptAt<z.body.startsAt+z.body.settings.durationSeconds);}else assert.equal(z.lastAttemptAt,null);
 assert(!s.centurySubsidy,'pilot does not authorize additional subsidy');
 if(s.centuryFunds.execution)assert.equal(s.centuryFunds.execution.partialWarmupMicro,z.body.settings.warmupTrancheMicro,'pilot cannot expand issuance');
}
export function guardZeroStageAction(s,a){
 const z=s.centuryFunds?.zeroStage;if(!z)return;const b=z.body,p=proposal(b).body;
 if(a.type===ISSUE_FOUNDER_ADVANCE){assert(terminalPilot(b.settings),'pilot has no founder advance mandate');assert.equal(a.certificate.body.trancheMicro,FOUNDER_ADVANCE_MICRO);}
 assert(!['ISSUE_CENTURY_FUNDS_V1','OPEN_CENTURY_SUBSIDY_V1','PREPARE_CENTURY_FUNDS_V1'].includes(a.type),'pilot requires separate post-pilot authorization');
 if([ISSUE_FOUNDER_ADVANCE,'ISSUE_CENTURY_WARMUP_TRANCHE_V1','START_CENTURY_WARMUP_V1','OPEN_COLLATERAL_SUPPORT_V1','CLAIM_COLLATERAL_SUPPORT_V1','CERTIFY_CENTURY_WARMUP_INTERVAL_V1','RUN_CENTURY_WARMUP_V1'].includes(a.type)){
  assert(s.money.time>=b.startsAt&&s.money.time<b.startsAt+b.settings.durationSeconds,'pilot UTC window');current(s,b);
 }
 if(a.type==='ISSUE_CENTURY_WARMUP_TRANCHE_V1')assert.equal(a.certificate.body.trancheMicro,b.settings.warmupTrancheMicro,'pilot tranche');
 if(a.type==='START_CENTURY_WARMUP_V1'){const q=a.certificate.body.settings;assert.equal(q.maxPaymentMicro,b.settings.paymentMicro,'pilot payment');assert.equal(q.ttlSeconds,b.settings.ttlSeconds,'pilot TTL');assert.equal(q.controllerPolicy.intervalSeconds,b.settings.spacingSeconds,'pilot interval');}
 if(a.type==='OPEN_COLLATERAL_SUPPORT_V1'){const q=a.certificate.body;
  assert.equal(q.allocationMicro,p.supportMicro,'pilot support allocation');assert.equal(q.perNodeCapMicro,'10000000','pilot support per node');
  assert.deepEqual([...q.bootstrapNodes].sort(),b.workers.map(w=>w.node).sort(),'pilot support roster');
  const owner=hash({domain:SUPPORT_DOMAIN+'/OWNER',owner:b.workers[0].operator});assert.deepEqual(q.ownerCaps,{[owner]:p.supportMicro},'pilot support owner cap');
 }
 if(a.type==='CLAIM_COLLATERAL_SUPPORT_V1')assert(b.workers.some(w=>w.node===a.body.node),'pilot support claimant');
 if(a.type==='CERTIFY_CENTURY_WARMUP_INTERVAL_V1'){const q=a.certificate.body;assert(q.from>=b.startsAt&&q.to<=b.startsAt+b.settings.durationSeconds,'pilot interval boundary');}
}
export function recordZeroStageAttempt(s,intent){
 const z=s.centuryFunds?.zeroStage;if(!z)return;const b=z.body,p=current(s,b,{coverage:true}),now=s.money.time;
 assert(now>=b.startsAt&&now<b.startsAt+b.settings.durationSeconds,'pilot UTC window');
 const phase=zeroStageSlot(b.settings,now-b.startsAt);
 if(z.lastAttemptAt!==null){
  assert(now-z.lastAttemptAt>=phase.spacingSeconds,'pilot minimum spacing');
  const previous=zeroStageSlot(b.settings,z.lastAttemptAt-b.startsAt);
  assert(previous.from!==phase.from||previous.slot!==phase.slot,'pilot slot already used');
 }
 assert(z.attempts<p.maximumPayments,'pilot attempt ceiling');
 assert.equal(intent.domain,CENTURY_WARMUP_DOMAIN,'pilot requires covered payment');assert.equal(intent.value,b.settings.paymentMicro,'pilot exact amount');assert.equal(intent.fee,p.feePerPaymentMicro,'pilot exact fee');
 assert.equal(intent.abortFee,'0');assert(intent.deadline-now<=b.settings.ttlSeconds,'pilot TTL');
 assert(intent.parts.length===1&&intent.parts[0].nodes.length===3&&new Set(intent.parts[0].nodes).size===3,'pilot assignment shape');
 assert(intent.parts[0].nodes.every(id=>b.workers.some(w=>w.node===id)),'pilot selected worker');
 assert(amount(z.chargedFeeMicro)+amount(intent.fee)<=amount(p.maximumFeesMicro),'pilot fee ceiling');
 z.attempts++;z.chargedFeeMicro=String(amount(z.chargedFeeMicro)+amount(intent.fee));z.lastAttemptAt=now;
}
