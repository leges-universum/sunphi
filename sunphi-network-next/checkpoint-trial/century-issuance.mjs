// Closed-admission release candidate. Only committed, expressly certified actions
// issue funds; previews and manifests never do. All amounts are integer micro-units.
import assert from 'node:assert/strict';
import {controllerContext,copyControllerState,ownedOutputs} from './controller-context.mjs';
import {exact,hash,hex,integer,publicKey,verify} from './crypto.mjs';
import {amount} from './payment-model.mjs';
import {quorum} from './authority.mjs';
import {developmentManager} from './reserve-recovery.mjs';
import {datedCumulative} from './economic-policy-v2.mjs';
import {ECONOMIC_POLICY_VERSION_V4} from './economic-policy-v3.mjs';
import {initialCenturyWarmup} from './century-warmup.mjs';
import {reserveAddresses} from './network-reserves.mjs';
import {memorialContractPaid} from './native-contracts.mjs';
export const ISSUE_CENTURY='ISSUE_CENTURY_FUNDS_V1',START_CENTURY='START_CENTURY_WARMUP_V1';
export const CENTURY_ISSUANCE_ACTIONS=[ISSUE_CENTURY,START_CENTURY,'RELEASE_CENTURY_FOUNDER_V1','QUEUE_CENTURY_DEVELOPMENT_V1','CANCEL_CENTURY_DEVELOPMENT_V1','EXECUTE_CENTURY_DEVELOPMENT_V1'];
export const centuryIssued=s=>amount(s.centuryFunds?.execution?.issuedMicro??'0');
export const centuryOrdinaryIssued=s=>s.centuryFunds?.execution?centuryIssued(s)-amount(s.economicPreparation.plan.memorialMicro):0n;
const sum=xs=>xs.reduce((n,v)=>n+amount(v),0n);
const outputId=(s,kind)=>hash({domain:ISSUE_CENTURY,configHash:s.configHash,planHash:s.economicPreparation.planHash,kind});
const balance=(s,kind)=>amount(s.money.outputs[outputId(s,kind)]?.value??'0');
function write(s,kind,owner,value){s.money.outputs[outputId(s,kind)]={owner,value:String(value),unlock:0};}
function custody(s){const a=s.networkReserves.development.access;assert(a&&!a.pending,'stable current reserve custody required');return a;}
function certificate(s,a,c,fields){
 exact(a,['type','certificate','founderConsent']);exact(a.certificate,['body','approvals']);const b=a.certificate.body;
 exact(b,['domain','network','configHash','generation','notBefore','expires','planHash','manifestHash','managementEpoch',...fields]);
 assert.equal(b.domain,a.type);assert.equal(b.network,c.chainId);assert.equal(b.configHash,s.configHash);assert.equal(b.generation,s.authority.generation);
 assert.equal(b.planHash,s.economicPreparation.planHash);assert.equal(b.manifestHash,s.centuryFunds.manifestHash);
 integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.expires-b.notBefore<=100&&s.height>=b.notBefore&&s.height<=b.expires,'fund execution inclusion window');
 quorum(b,a.certificate.approvals,s.authority.validators,7);const manager=custody(s);assert.equal(b.managementEpoch,manager.epoch);
 assert(verify(b,a.founderConsent,manager.manager),'current founder fund execution consent');return b;
}
function recipient(s,key){
 publicKey(key);const m=s.centuryFunds.manifest;
 assert(![m.development.account,m.founder.account,m.memorial.account,...m.warmup.accounts,...reserveAddresses(s.configHash)].includes(key),'ordinary recipient required');
}
export function centuryVested(s,kind){
 assert(['development','founder'].includes(kind));const x=s.centuryFunds?.execution;assert(x,'funds unissued');
 return amount(datedCumulative({start:x.start,at:s.money.time,kind}));
}
function transfer(s,kind,to,value,sequence){
 recipient(s,to);assert(value>0n&&value<=balance(s,kind),'available fund balance');
 const id=hash({domain:ISSUE_CENTURY+'/RELEASE',configHash:s.configHash,kind,sequence});assert(!s.money.outputs[id],'release already exists');
 write(s,kind,s.centuryFunds.manifest[kind].account,balance(s,kind)-value);s.money.outputs[id]={owner:to,value:String(value),unlock:0};
}
export function applyCenturyIssuance(base,a,c,author){
 assert.equal(base.economicPreparation?.plan.version,ECONOMIC_POLICY_VERSION_V4,'current approved memorial plan required');
 assert(base.centuryFunds&&base.centuryFees&&base.rewards,'prepared funds and accounting required');assert.equal(base.money.unitScale,'1000000');
 const s=copyControllerState(base,['centuryFunds','economicPreparation']),f=s.centuryFunds,m=f.manifest;let x=f.execution;
 if(a.type===ISSUE_CENTURY){
  const b=certificate(s,a,c,['supplyBefore']);
  if(x){assert.equal(x.certificateHash,hash(a.certificate),'conflicting issuance replay');return base;}
  assert.equal(b.supplyBefore,s.money.supply);const access=custody(s);
  assert.deepEqual(m.management,{manager:access.manager,epoch:access.epoch,recovery:access.recovery},'refresh fund custody first');
  assert(!s.centuryWarmup&&!s.centurySubsidy,'launch precedes work programmes');assert(!s.economicPreparation.memorial.issued);
  const accounts=[...m.warmup.accounts,m.development.account,m.founder.account,m.memorial.account];
  for(const owner of accounts)assert.equal(ownedOutputs(s.money,owner).length,0,'fund custody must be empty');
  if(!controllerContext(s))assert(!Object.values(s.money.requests).some(r=>accounts.includes(r.intent.sender)||accounts.includes(r.intent.recipient)),'fund custody history must be empty');
  const total=sum([m.warmup.totalMicro,m.development.totalMicro,m.founder.totalMicro,m.memorial.totalMicro]);
  assert(amount(s.money.supply)+total<=amount(s.economicPreparation.plan.capMicro));
  const half=amount(m.warmup.totalMicro)/2n;write(s,'warmup-a',m.warmup.accounts[0],half);write(s,'warmup-b',m.warmup.accounts[1],amount(m.warmup.totalMicro)-half);
  for(const kind of ['development','founder','memorial'])write(s,kind,m[kind].account,amount(m[kind].totalMicro));
  s.money.supply=String(amount(s.money.supply)+total);
  f.execution=x={certificateHash:hash(a.certificate),issuedHeight:s.height,issuedMicro:String(total),start:s.money.time,warmupStart:null,warmupCertificateHash:null,founderReleasedMicro:'0',developmentSpentMicro:'0',sequence:0,pending:null,last:null,day:0,daySpentMicro:'0',history:hash(a)};
  s.economicPreparation.memorial.issued=true;s.economicPreparation.memorial.balanceMicro=m.memorial.totalMicro;
 }else{
  assert(x,'funds unissued');
  if(a.type===START_CENTURY){
   const b=certificate(s,a,c,['settings']);
   if(x.warmupStart!==null){assert.equal(x.warmupCertificateHash,hash(a.certificate));return base;}
   exact(b.settings,['controllerPolicy','maxPaymentMicro',...(c.obligationClock?['timeBasis','ttlSeconds']:['ttlBlocks'])]);if(c.obligationClock)assert.equal(b.settings.timeBasis,c.obligationClock);
   s.centuryWarmup=initialCenturyWarmup(s,{start:s.money.time,...b.settings});x.warmupStart=s.money.time;x.warmupCertificateHash=hash(a.certificate);
  }else if(a.type==='RELEASE_CENTURY_FOUNDER_V1'){
   exact(a,['type','manifestHash','cumulativeMicro']);assert.equal(a.manifestHash,f.manifestHash);
   const target=amount(a.cumulativeMicro),old=amount(x.founderReleasedMicro);assert(target<=centuryVested(s,'founder'),'founder tranche still locked');
   if(target<=old)return base;
   assert.equal(target,centuryVested(s,'founder'),'release the complete vested tranche');
   transfer(s,'founder',m.founder.recipient,target-old,a.cumulativeMicro);x.founderReleasedMicro=a.cumulativeMicro;
  }else if(a.type==='QUEUE_CENTURY_DEVELOPMENT_V1'){
   exact(a,['type','managementEpoch','sequence','recipient','valueMicro','purpose','reference']);const access=custody(s);
   assert.equal(author,access.manager);assert.equal(a.managementEpoch,access.epoch);assert.equal(a.sequence,x.sequence+1);assert(!x.pending,'cancel prior instruction first');
   recipient(s,a.recipient);hex(a.reference);assert(typeof a.purpose==='string'&&a.purpose.trim().length>0&&a.purpose.length<=512&&!/[\u0000-\u001f]/.test(a.purpose));
   const v=amount(a.valueMicro),controls=s.networkReserves.development.controls;
   assert(v>0n&&v<=centuryVested(s,'development')-amount(x.developmentSpentMicro),'development tranche still locked');assert(v<=amount(controls.transferLimit));
   x.sequence=a.sequence;x.pending={...a,controlsHash:hash(controls),executeAt:s.money.time+controls.delaySeconds,expiresAt:s.money.time+controls.delaySeconds+controls.executionWindowSeconds};
  }else{
   assert(['CANCEL_CENTURY_DEVELOPMENT_V1','EXECUTE_CENTURY_DEVELOPMENT_V1'].includes(a.type));exact(a,['type','sequence','instructionHash']);hex(a.instructionHash);
   if(!x.pending&&x.last?.sequence===a.sequence&&x.last.instructionHash===a.instructionHash&&x.last.status===(a.type.startsWith('EXECUTE')?'PAID':'CANCELLED'))return base;
   const p=x.pending;assert(p&&p.sequence===a.sequence&&hash(p)===a.instructionHash);const access=custody(s);
   if(a.type.startsWith('CANCEL'))assert.equal(author,access.manager);
   else{
    assert.equal(p.managementEpoch,access.epoch,'stale development instruction');assert(s.money.time>=p.executeAt&&s.money.time<=p.expiresAt,'development execution window');
    const controls=s.networkReserves.development.controls;assert.equal(hash(controls),p.controlsHash,'development controls changed');
    const v=amount(p.valueMicro),day=Math.floor(s.money.time/86400),used=day===x.day?amount(x.daySpentMicro):0n;
    assert(v<=centuryVested(s,'development')-amount(x.developmentSpentMicro)&&used+v<=amount(controls.dailyLimit));
    transfer(s,'development',p.recipient,v,p.sequence);x.developmentSpentMicro=String(amount(x.developmentSpentMicro)+v);x.day=day;x.daySpentMicro=String(used+v);
   }
   x.last={sequence:p.sequence,instructionHash:a.instructionHash,status:a.type.startsWith('EXECUTE')?'PAID':'CANCELLED',at:s.money.time,recipient:p.recipient,valueMicro:p.valueMicro,purpose:p.purpose,reference:p.reference};x.pending=null;
  }
  x.history=hash({previous:x.history,action:a,at:s.money.time});
 }
 auditCenturyIssuance(s);return s;
}
export function auditCenturyIssuance(s){
 const f=s.centuryFunds,x=f?.execution;if(!x)return;const m=f.manifest,e=s.economicPreparation;
 assert.equal(e.plan.version,ECONOMIC_POLICY_VERSION_V4);assert.equal(s.money.unitScale,'1000000');
 exact(x,['certificateHash','issuedHeight','issuedMicro','start','warmupStart','warmupCertificateHash','founderReleasedMicro','developmentSpentMicro','sequence','pending','last','day','daySpentMicro','history']);
 hex(x.certificateHash);hex(x.history);integer(x.issuedHeight,1);assert(x.issuedHeight<=s.height);integer(x.start,1);assert(x.start<=s.money.time);
 assert.equal(centuryIssued(s),sum([m.warmup.totalMicro,m.development.totalMicro,m.founder.totalMicro,m.memorial.totalMicro]));
 assert.equal(amount(s.money.supply),amount(e.plan.existingSupplyMicro)+centuryIssued(s)+amount(s.centurySubsidy?.totalMintedMicro??'0'),'all century issuance reconciled');
 assert(amount(s.money.supply)<=amount(e.plan.capMicro));
 for(const kind of ['development','founder','memorial']){
  const spent=kind==='development'?amount(x.developmentSpentMicro):kind==='founder'?amount(x.founderReleasedMicro):memorialContractPaid(s);
  const outputs=ownedOutputs(s.money,m[kind].account);
  // Legacy maintenance may prune the zero custody output only after the entire
  // allocation is accounted for as released. The indexed journal retains it.
  if(outputs.length===0){assert.equal(spent,amount(m[kind].totalMicro),'missing unspent custody');assert(!s.money.outputs[outputId(s,kind)],'foreign custody output');}
  else{assert.equal(outputs.length,1);assert.equal(outputs[0][0],outputId(s,kind));assert.equal(outputs[0][1].unlock,0);}
  assert.equal(balance(s,kind)+spent,amount(m[kind].totalMicro));if(kind!=='memorial')assert(spent<=centuryVested(s,kind));
 }
 if(x.warmupStart===null){assert.equal(x.warmupCertificateHash,null);assert(!s.centuryWarmup);assert.equal(balance(s,'warmup-a')+balance(s,'warmup-b'),amount(m.warmup.totalMicro));}
 else{integer(x.warmupStart,x.start);assert(x.warmupStart<=s.money.time);hex(x.warmupCertificateHash);assert.equal(s.centuryWarmup?.controller.start,x.warmupStart);assert.equal(s.centuryWarmup.fundedMicro,m.warmup.totalMicro);}
 integer(x.sequence);integer(x.day);amount(x.daySpentMicro);
 if(x.pending){const p=x.pending;exact(p,['type','managementEpoch','sequence','recipient','valueMicro','purpose','reference','controlsHash','executeAt','expiresAt']);assert.equal(p.type,'QUEUE_CENTURY_DEVELOPMENT_V1');assert.equal(p.sequence,x.sequence);integer(p.managementEpoch);recipient(s,p.recipient);amount(p.valueMicro);hex(p.reference);hex(p.controlsHash);integer(p.executeAt);integer(p.expiresAt,p.executeAt);}
 if(x.last){exact(x.last,['sequence','instructionHash','status','at','recipient','valueMicro','purpose','reference']);integer(x.last.sequence,1);assert(x.last.sequence<=x.sequence);hex(x.last.instructionHash);assert(['PAID','CANCELLED'].includes(x.last.status));integer(x.last.at);assert(x.last.at<=s.money.time);recipient(s,x.last.recipient);amount(x.last.valueMicro);hex(x.last.reference);}
}
