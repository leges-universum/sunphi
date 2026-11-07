// Candidate integration of the five-year controller with the monetary interpreter.
// No public activation, funding or mint. Core commits this book alongside money
// in one consensus transition; it is never a side database.
import assert from 'node:assert/strict';
import {hash,exact,integer,hex} from './crypto.mjs';
import {UNIT,WARMUP} from './ecosystem-century-model.mjs';
import {memorialAware,centuryWarmupAccounts} from './economic-policy-v3.mjs';
import {initialWarmupController,certifiedWarmupInterval,settleWarmupInterval,anniversary,datedAllowance,ECONOMIC_POLICY_VERSION} from './economic-policy-v2.mjs';
import {amount,audit,feeFor,policy,policyId,reserveProgramPayment,CENTURY_WARMUP_DOMAIN,PROGRAM_FEE_DOMAIN} from './payment-model.mjs';
import {eligibleLiabilityWorker,effectiveWorkGroup,founderWorker} from './payment-liability.mjs';
const min=(...values)=>values.reduce((a,b)=>a<b?a:b);
const active=q=>q&&['RESERVED','SCHEDULED'].includes(q.status);
const funds=(money,accounts)=>Object.values(money.outputs).filter(o=>accounts.includes(o.owner)).reduce((n,o)=>n+amount(o.value),0n);
export function initialCenturyWarmup(state,{start,controllerPolicy,maxPaymentMicro,ttlBlocks}) {
 assert.equal(state.money.unitScale,String(UNIT),'fractional migration required');
 const e=state.economicPreparation;assert(memorialAware(e?.plan.version));
 assert.equal(e.planHash,hash(e.plan));assert.equal(e.plan.warmupMicro,String(WARMUP));
 integer(start,1);exact(controllerPolicy,['maximumRiseMicroPerSecond','operationalRateMicroPerSecond']);
 assert(amount(controllerPolicy.maximumRiseMicroPerSecond)>0n&&amount(controllerPolicy.operationalRateMicroPerSecond)>0n);
 assert(amount(maxPaymentMicro)>0n);integer(ttlBlocks,4);assert(ttlBlocks<=policy.maxLifetime);
 const accounts=centuryWarmupAccounts(state.configHash),funded=funds(state.money,accounts);
 assert(funded>0n&&funded<=WARMUP,'already-funded programme required; this function never issues');
 assert(!Object.values(state.money.requests).some(q=>active(q)&&(accounts.includes(q.intent.sender)||accounts.includes(q.intent.recipient))),'unadopted programme obligation');
 const book={version:'DUEBYTE_CENTURY_WARMUP_EXECUTOR_V1',configHash:state.configHash,planHash:e.planHash,
  accounts,fundedMicro:String(funded),controller:initialWarmupController(start,state.height),
  controllerPolicy:structuredClone(controllerPolicy),maxPaymentMicro,ttlBlocks,nextWallet:0,intervalAnchor:null,pending:null,last:null};
 auditCenturyWarmup(book,state.money);return book;
}
export function auditCenturyWarmup(book,money) {
 exact(book,['version','configHash','planHash','accounts','fundedMicro','controller','controllerPolicy','maxPaymentMicro','ttlBlocks','nextWallet','intervalAnchor','pending','last']);
 assert.equal(book.version,'DUEBYTE_CENTURY_WARMUP_EXECUTOR_V1');hex(book.configHash);hex(book.planHash);
 exact(book.controllerPolicy,['maximumRiseMicroPerSecond','operationalRateMicroPerSecond']);
 assert(amount(book.controllerPolicy.maximumRiseMicroPerSecond)>0n&&amount(book.controllerPolicy.operationalRateMicroPerSecond)>0n);
 assert(amount(book.maxPaymentMicro)>0n);integer(book.ttlBlocks,4);assert(book.ttlBlocks<=policy.maxLifetime);
 audit(money);assert.equal(money.unitScale,String(UNIT));assert.deepEqual(book.accounts,centuryWarmupAccounts(book.configHash));
 assert(amount(book.fundedMicro)>0n&&amount(book.fundedMicro)<=WARMUP);
 const c=book.controller;exact(c,['version','start','cursor','sequence','lastMeasurementHeight','spentMicro','reservedMicro','previousRateMicroPerSecond','pending','lastSettlement']);
 if(book.intervalAnchor){exact(book.intervalAnchor,['moneyHeight','epoch']);integer(book.intervalAnchor.moneyHeight);integer(book.intervalAnchor.epoch);assert(book.intervalAnchor.moneyHeight<=money.height);}
 if(c.pending)assert(book.intervalAnchor,'missing interval payment anchor');
 assert.equal(c.version,ECONOMIC_POLICY_VERSION);integer(c.start,1);integer(c.cursor,c.start);integer(c.sequence);integer(c.lastMeasurementHeight);
 assert(amount(c.previousRateMicroPerSecond)<=amount(book.controllerPolicy.operationalRateMicroPerSecond));
 if(c.pending){const p=c.pending;exact(p,['sequence','from','to','budgetMicro']);assert.equal(p.sequence,c.sequence);integer(p.from,c.start);integer(p.to,p.from+1);assert(p.to-p.from<=86400);assert.equal(p.to,c.cursor);
  assert(amount(p.budgetMicro)<=amount(datedAllowance({start:c.start,from:p.from,to:p.to,kind:'warmup'})));
  assert(amount(p.budgetMicro)<=amount(c.previousRateMicroPerSecond)*BigInt(p.to-p.from));
 }
 if(c.lastSettlement){exact(c.lastSettlement,['sequence','actualFeeMicro']);integer(c.lastSettlement.sequence,1);assert(c.lastSettlement.sequence<=c.sequence);amount(c.lastSettlement.actualFeeMicro);}
 if(book.last){exact(book.last,['pid','intentHash','sequence','status','feeMicro','terminalHeight','externalDemandMicro']);hex(book.last.pid);hex(book.last.intentHash);integer(book.last.sequence,1);integer(book.last.terminalHeight,1);assert(['SETTLED','EXPIRED'].includes(book.last.status));assert.equal(book.last.externalDemandMicro,'0');amount(book.last.feeMicro);}
 let custody=funds(money,book.accounts);
 if(book.pending)exact(book.pending,['pid','intentHash','sequence']);
 if(book.pending){const q=money.requests[book.pending.pid];assert(q,'missing programme payment');assert.equal(hash(q.intent),book.pending.intentHash);assert(book.accounts.includes(q.intent.sender)&&book.accounts.includes(q.intent.recipient));
  assert(active(q),'settle terminal programme payment before auditing');custody+=amount(q.escrow);
  assert(c.pending&&c.pending.sequence===book.pending.sequence);assert(amount(q.intent.fee)<=amount(c.reservedMicro));
 }
 assert.equal(custody+amount(c.spentMicro),amount(book.fundedMicro),'warmup funds conserved');
 assert.equal(c.reservedMicro,c.pending?.budgetMicro??'0');
 assert(amount(c.spentMicro)+amount(c.reservedMicro)<=WARMUP);
 assert([0,1].includes(book.nextWallet));return true;
}
export function openCenturyWarmupInterval(book,state,certificate) {
 auditCenturyWarmup(book,state.money);assert.equal(state.configHash,book.configHash);assert.equal(state.economicPreparation?.planHash,book.planHash);
 assert(!book.pending,'payment still pending');const b=certificate.body;
 assert(state.money.time>=b.from&&state.money.time<b.to,'capacity interval is not current');
 assert(b.from<anniversary(book.controller.start,5),'five-year warmup horizon ended');
 const controller=certifiedWarmupInterval(book.controller,certificate,{configHash:state.configHash,
  generation:state.authority.generation,height:state.height,validators:state.authority.validators,controllerPolicy:book.controllerPolicy});
 return {...structuredClone(book),controller,intervalAnchor:{moneyHeight:state.money.height,epoch:state.money.epoch}};
}
export function centuryWarmupPlan(book,money) {
 auditCenturyWarmup(book,money);const c=book.controller,p=c.pending;
 if(!p||book.pending||money.time<p.from||money.time>=p.to||money.time>=anniversary(c.start,5)||!amount(c.reservedMicro))return null;
 const anchor=book.intervalAnchor;if(money.epoch!==anchor.epoch||money.height>anchor.moneyHeight+book.ttlBlocks-1)return null;
 if(Object.values(money.requests).some(active))return null;
 let index=book.nextWallet;
 if(!funds(money,[book.accounts[index]]))index=1-index;
 const entries=Object.entries(money.outputs).filter(([,o])=>o.owner===book.accounts[index]&&o.unlock<=money.time&&amount(o.value)>0n).sort(([a],[b])=>a<b?-1:1).slice(0,policy.maxInputs);
 const available=entries.reduce((n,[,o])=>n+amount(o.value),0n);if(!available)return null;
 const allowance=min(amount(c.reservedMicro),amount(book.fundedMicro)-amount(c.spentMicro));
 // Select only workers with committed collateral and consent. Numeric capacity
 // is bounded by their actual free cover, not a claimed machine benchmark.
 const candidates=Object.keys(money.nodes).filter(id=>eligibleLiabilityWorker(money,id)).map(id=>{
  const n=money.nodes[id],free=amount(n.stake)-amount(n.consensusHeld)-amount(n.taskHeld);
  return {id,limit:amount(n.consensusHeld)>0n?min(free,amount(n.tier)):0n,order:hash({sequence:p.sequence,node:id})};
 }).filter(n=>n.limit>0n).sort((a,b)=>a.limit>b.limit?-1:a.limit<b.limit?1:a.order<b.order?-1:1);
 const groups=new Set(),chosen=[];
 for(const n of candidates){const g=effectiveWorkGroup(money,n.id);if(groups.has(g)&&!founderWorker(money,n.id))continue;groups.add(g);chosen.push(n);if(chosen.length===policy.copies)break;}
 if(chosen.length!==policy.copies)return null;
 const terminal=available===1n;let value=0n;
 if(!terminal){let lo=1n,hi=min(available,amount(book.maxPaymentMicro),...chosen.map(n=>n.limit));
  while(lo<=hi){const mid=(lo+hi)/2n,fee=feeFor(String(mid));if(mid+fee<=available&&fee<=allowance){value=mid;lo=mid+1n;}else hi=mid-1n;}if(!value)return null;
 }
 const pid=hash({domain:CENTURY_WARMUP_DOMAIN,configHash:book.configHash,planHash:book.planHash,sequence:p.sequence});
 return {domain:terminal?PROGRAM_FEE_DOMAIN:CENTURY_WARMUP_DOMAIN,policy:policyId,network:policy.network,pid,
  sender:book.accounts[index],recipient:book.accounts[1-index],inputs:entries.map(([id])=>id),value:String(value),
  fee:terminal?'1':String(feeFor(String(value))),abortFee:'0',unitScale:String(UNIT),epoch:anchor.epoch,
  lastReserve:anchor.moneyHeight+book.ttlBlocks-1,deadline:anchor.moneyHeight+book.ttlBlocks,delay:0,parts:[{value:terminal?'1':String(value),nodes:chosen.map(n=>n.id)}]};
}
export function reserveCenturyWarmup(book,money,expectedIntentHash) {
 const intent=centuryWarmupPlan(book,money);assert(intent,'no eligible programme payment');assert.equal(hash(intent),expectedIntentHash,'programme plan changed');
 const next=structuredClone(book),result=reserveProgramPayment(money,intent,money.time).state;
 next.pending={pid:intent.pid,intentHash:hash(intent),sequence:next.controller.pending.sequence};
 auditCenturyWarmup(next,result);assert.equal(result.supply,money.supply);
 return {book:next,money:result,intent};
}
export function settleCenturyWarmup(book,money) {
 if(!book.pending){auditCenturyWarmup(book,money);return book;}
 const q=money.requests[book.pending.pid];assert(q&&hash(q.intent)===book.pending.intentHash,'programme outcome binding');
 if(active(q)){auditCenturyWarmup(book,money);return book;}
 assert(['SETTLED','EXPIRED'].includes(q.status));
 const next=structuredClone(book),fee=q.status==='SETTLED'?q.intent.fee:q.intent.abortFee;
 next.controller=settleWarmupInterval(next.controller,next.pending.sequence,fee);
 next.last={...next.pending,status:q.status,feeMicro:fee,terminalHeight:q.terminalHeight,externalDemandMicro:'0'};
 next.nextWallet=1-next.accounts.indexOf(q.intent.sender);next.pending=null;
 auditCenturyWarmup(next,money);return next;
}
export function closeUnusedCenturyInterval(book,money) {
 auditCenturyWarmup(book,money);assert(!book.pending&&book.controller.pending,'no unused interval');
 assert(money.time>=book.controller.pending.to,'interval still open');
 return {...structuredClone(book),controller:settleWarmupInterval(book.controller,book.controller.pending.sequence,'0')};
}
export const CENTURY_WARMUP_ACTIONS=['CERTIFY_CENTURY_WARMUP_INTERVAL_V1','RUN_CENTURY_WARMUP_V1','CLOSE_CENTURY_WARMUP_INTERVAL_V1'];
export function auditCenturyWarmupState(state) {
 const book=state.centuryWarmup;if(!book)return;
 assert.equal(book.configHash,state.configHash);assert.equal(book.planHash,state.economicPreparation?.planHash);
 assert(memorialAware(state.economicPreparation.plan.version));
 assert(book.controller.lastMeasurementHeight<=state.height,'future controller observation');
 auditCenturyWarmup(book,state.money);
}
export function applyCenturyWarmupAction(state,action) {
 auditCenturyWarmupState(state);assert(state.centuryWarmup,'century warmup not funded/activated');
 const next=structuredClone(state),book=state.centuryWarmup;
 if(action.type==='CERTIFY_CENTURY_WARMUP_INTERVAL_V1'){
  exact(action,['type','certificate']);next.centuryWarmup=openCenturyWarmupInterval(book,state,action.certificate);
 }else if(action.type==='RUN_CENTURY_WARMUP_V1'){
  exact(action,['type','sequence','intentHash']);assert.equal(action.sequence,book.controller.pending?.sequence,'stale programme sequence');
  const r=reserveCenturyWarmup(book,state.money,action.intentHash);next.money=r.money;next.centuryWarmup=r.book;
 }else{
  assert.equal(action.type,'CLOSE_CENTURY_WARMUP_INTERVAL_V1');exact(action,['type','sequence']);assert.equal(action.sequence,book.controller.pending?.sequence,'stale programme sequence');
  next.centuryWarmup=closeUnusedCenturyInterval(book,state.money);
 }
 auditCenturyWarmupState(next);return next;
}
export function recordCenturyWarmupSettlement(state) {
 if(!state.centuryWarmup)return state;
 const book=settleCenturyWarmup(state.centuryWarmup,state.money);
 return book===state.centuryWarmup?state:{...state,centuryWarmup:book};
}
