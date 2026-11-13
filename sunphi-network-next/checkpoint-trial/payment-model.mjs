// Backward-compatible payment interpreter. The archived V1 model is unchanged.
// Scheduled actions require the separately quorum-approved protocol capability.
import assert from 'node:assert/strict';
import {hash, publicKey, sign, verify} from './crypto.mjs';
import {UTC_OBLIGATIONS,UTC_WINDOWS,utcIntent,paymentClock} from './obligation-clock.mjs';
import {auditLiability,liabilityReserve,liabilityTerminal,effectiveWorkGroup,founderWorker} from './payment-liability.mjs';
import {paymentFee,checkTariff,auditPaymentTariff,guardPaymentTariff} from './payment-tariff.mjs';
export {hash};
export const DOMAIN='DUEBYTE_TRANSITION_MODEL_V1';
export const SCHEDULE_DOMAIN='DUEBYTE_SCHEDULED_PAYMENT_V1';
export const PROGRAM_FEE_DOMAIN='DUEBYTE_PROGRAM_TERMINAL_FEE_V1';
export const CENTURY_WARMUP_DOMAIN='DUEBYTE_CENTURY_WARMUP_PAYMENT_V1';
export const centuryWarmup=i=>i?.domain===CENTURY_WARMUP_DOMAIN;
export const terminalProgramFee=i=>i?.domain===PROGRAM_FEE_DOMAIN;
export const scheduled=i=>i?.domain===SCHEDULE_DOMAIN;
export const MAX=(1n<<64n)-1n;
export function amount(x){assert(typeof x==='string'&&/^(0|[1-9][0-9]*)$/.test(x),'decimal amount');const n=BigInt(x);assert(n<=MAX,'amount overflow');return n;}
export function count(x){assert(Number.isSafeInteger(x)&&x>=0,'counter');return x;}
export function exact(x,fields){assert(x&&typeof x==='object'&&!Array.isArray(x),'object');assert.deepEqual(Object.keys(x).sort(),[...fields].sort(),'exact fields');}
export const ID=x=>{assert(typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),'identifier');return x;};
export const oid=(pid,role)=>hash({domain:DOMAIN+'/OUTPUT',pid,role});
export const policy={domain:DOMAIN,network:'duebyte-isolated-model',maxInputs:8,maxParts:32,copies:3,maxLifetime:100,maxAdvance:10800,delay:86400,feeDen:'1000000',feeRate:'30000'};
export const policyId=hash(policy);
Object.freeze(policy);
export function feeFor(n,schedule=null,parts=1){amount(n);if(schedule)return paymentFee(schedule,n,parts);return (amount(n)*BigInt(policy.feeRate)+BigInt(policy.feeDen)-1n)/BigInt(policy.feeDen);}
// Preserve the existing one-token release ceiling, bounded by the quoted fee.
export function releaseFeeFor(n,scale='1',schedule=null){assert(['1','1000000'].includes(scale));if(schedule){checkTariff(schedule);assert.equal(scale,'1000000');return (BigInt(schedule.baseMicro)+9n)/10n;}const fee=feeFor(n),ceiling=BigInt(scale);return fee<ceiling?fee:ceiling;}
const sum=xs=>xs.reduce((a,b)=>a+amount(b),0n);
export function audit(s){
  exact(s,['domain','policy','height','epoch','time','supply','outputs','requests','nodes','fees',...(s.paymentTariff?['paymentTariff']:[]),...(s.liability?['liability']:[]),...(s.unitScale?['unitScale','precisionHeight']:[])]);
  auditPaymentTariff(s);
  if(s.unitScale){assert.equal(s.unitScale,'1000000');count(s.precisionHeight);assert(s.precisionHeight>0);}
  assert.equal(s.domain,DOMAIN);assert.equal(s.policy,policyId);count(s.height);count(s.epoch);count(s.time);
  let total=amount(s.fees);const liabilities=new Map();
  for(const [id,o] of Object.entries(s.outputs)){ID(id);exact(o,['owner','value','unlock']);publicKey(o.owner);total+=amount(o.value);count(o.unlock);}
  for(const [id,r] of Object.entries(s.requests)){
    ID(id);exact(r,['intent','digest','status','escrow','terminalHeight',...(scheduled(r.intent)?['executeAt']:[])]);validateIntentShape(r.intent);assert.equal(r.intent.pid,id);assert.equal(r.digest,hash(r.intent));
    assert((scheduled(r.intent)?['RESERVED','SCHEDULED','SETTLED','EXPIRED','CANCELLED']:['RESERVED','SETTLED','EXPIRED']).includes(r.status));if(scheduled(r.intent)){count(r.executeAt);if(r.status==='SCHEDULED')assert(r.executeAt>0);}total+=amount(r.escrow);count(r.terminalHeight);
    if(r.status==='RESERVED'){
      assert.equal(r.intent.unitScale??'1',s.unitScale??'1','reserved payment denomination');
      assert.equal(r.terminalHeight,0);assert(amount(r.escrow)>=amount(r.intent.value)+amount(r.intent.fee));
      for(const p of r.intent.parts)for(const n of p.nodes)liabilities.set(n,(liabilities.get(n)??0n)+amount(p.value));
    }else if(r.status==='SCHEDULED'){assert.equal(r.intent.unitScale??'1',s.unitScale??'1','scheduled payment denomination');assert.equal(r.terminalHeight,0);assert(amount(r.escrow)>=amount(r.intent.value)+amount(r.intent.fee));}else{assert.equal(r.escrow,'0');assert(r.terminalHeight>0&&r.terminalHeight<=s.height);}
  }
  total+=auditLiability(s,liabilities);
  for(const [id,n]of Object.entries(s.nodes)){
    ID(id);exact(n,['key','operator','stake','consensusHeld','taskHeld','tier']);publicKey(n.key);ID(n.operator);
    assert(amount(n.consensusHeld)+amount(n.taskHeld)<=amount(n.stake),'personal coverage');
    assert.equal(amount(n.taskHeld),liabilities.get(id)??0n,'task liabilities');amount(n.tier);total+=amount(n.stake);liabilities.delete(id);
  }
  assert.equal(liabilities.size,0,'unknown worker');assert.equal(total,amount(s.supply),'conservation');return true;
}
export function validateIntentShape(i){
  exact(i,['domain','policy','network','pid','sender','recipient','inputs','value','fee','abortFee','epoch','lastReserve','deadline','delay','parts',...(scheduled(i)?['sendDelay']:[]),...(i.feeSchedule?['feeSchedule']:[]),...(i.unitScale?['unitScale']:[]),...(Object.hasOwn(i,'timeBasis')?['timeBasis']:[])]);
  if(Object.hasOwn(i,'timeBasis'))assert.equal(i.timeBasis,UTC_OBLIGATIONS,'supported payment clock');
  if(i.unitScale)assert.equal(i.unitScale,'1000000');
  if(i.feeSchedule){checkTariff(i.feeSchedule);assert.equal(i.unitScale,'1000000');assert(!terminalProgramFee(i),'terminal programme fee has its own rule');}
  if(i.unitScale&&!terminalProgramFee(i)&&!centuryWarmup(i))assert.equal(amount(i.abortFee),releaseFeeFor(i.value,i.unitScale,i.feeSchedule),'fractional release fee');
  if(centuryWarmup(i)){assert.equal(i.unitScale,'1000000');assert.equal(i.abortFee,'0');assert.equal(i.delay,0);}
  assert.equal(i.domain,scheduled(i)?SCHEDULE_DOMAIN:terminalProgramFee(i)?PROGRAM_FEE_DOMAIN:centuryWarmup(i)?CENTURY_WARMUP_DOMAIN:DOMAIN+'/INTENT');if(scheduled(i))assert.equal(i.sendDelay,86400);assert.equal(i.policy,policyId);assert.equal(i.network,policy.network);ID(i.pid);publicKey(i.sender);publicKey(i.recipient);
  assert(Array.isArray(i.inputs)&&i.inputs.length>0&&i.inputs.length<=policy.maxInputs);i.inputs.forEach(ID);assert.equal(new Set(i.inputs).size,i.inputs.length);
  if(terminalProgramFee(i)){assert.equal(i.value,'0');assert.equal(i.fee,'1');assert.equal(i.abortFee,'0');assert.equal(i.delay,0);}else{assert(amount(i.value)>0n);assert.equal(amount(i.fee),feeFor(i.value,i.feeSchedule,i.parts?.length));}assert(amount(i.abortFee)<=amount(i.fee),'abort fee limit');
  count(i.epoch);count(i.lastReserve);count(i.deadline);assert(i.lastReserve<i.deadline&&i.deadline-i.lastReserve<=(utcIntent(i)?UTC_WINDOWS.maxLifetimeSeconds:policy.maxLifetime));
  assert([0,policy.delay].includes(i.delay));assert(Array.isArray(i.parts)&&i.parts.length>0&&i.parts.length<=policy.maxParts);
  for(const p of i.parts){exact(p,['value','nodes']);assert(amount(p.value)>0n);assert.equal(p.nodes.length,policy.copies);p.nodes.forEach(ID);assert.equal(new Set(p.nodes).size,policy.copies);}
  assert.equal(sum(i.parts.map(p=>p.value)),terminalProgramFee(i)?1n:amount(i.value),'plan total');
}
export function authorize(intent,key){return {intent,signature:sign(intent,key)};}
export function receiptBody(r,index,node){return {domain:DOMAIN+'/WORK',policy:policyId,request:r.digest,index,node};}
export function receiptsFor(s,pid,keys){const r=s.requests[pid];return r.intent.parts.flatMap((p,index)=>p.nodes.map(node=>({index,node,signature:sign(receiptBody(r,index,node),keys[node])})));}
function verifyReceipts(s,r,receipts){
  assert(Array.isArray(receipts)&&receipts.length===r.intent.parts.length*policy.copies,'all work receipts');const seen=new Set();
  for(const v of receipts){exact(v,['index','node','signature']);count(v.index);ID(v.node);assert(r.intent.parts[v.index]?.nodes.includes(v.node),'assigned worker');
    const key=v.index+':'+v.node;assert(!seen.has(key),'duplicate work');seen.add(key);assert(verify(receiptBody(r,v.index,v.node),v.signature,s.nodes[v.node].key),'work signature');}
}
export function root(s){audit(s);return hash(s);}
// This models an ALREADY ORDERED consensus transition. Caller time/epoch values
// are NOT a certificate. Production admission remains unavailable in this package.
export function transition(base,event){return interpret(base,event,false);}
// Internal consensus entry point. Public RPC never accepts this action. The
// network-reserves interpreter must first reproduce and bind the entire plan.
export function reserveProgramPayment(base,intent,time){return interpret(base,{parent:root(base),epoch:base.epoch,time,action:{type:'RESERVE',signed:{intent,signature:null}}},true);}
function interpret(base,event,program){
  audit(base);exact(event,['parent','epoch','time','action']);assert.equal(event.parent,root(base),'parent');assert.equal(event.epoch,base.epoch,'epoch');
  count(event.time);assert(event.time>=base.time&&event.time-base.time<=policy.maxAdvance,'model time bounds');
  const a=event.action;assert(a&&typeof a.type==='string');
  const s=structuredClone(base),h=count(base.height+1);s.height=h;s.time=event.time;
  if(executePaymentAction(s,a,{program}))return {state:base,duplicate:true};
  audit(s);return {state:s,duplicate:false};
}
// Internal mutation kernel shared with the isolated indexed interpreter. The
// caller must validate its authenticated parent, clock, invariants and atomicity.
// This is not a network admission or standalone authorization entry point.
export function executePaymentAction(s,a,{program=false}={}){
  const h=s.height;
  const output=(id,owner,value,unlock=0)=>{assert(!Object.hasOwn(s.outputs,id),'output collision');assert(value>=0n&&value<=MAX);s.outputs[id]={owner,value:String(value),unlock};};
  if(a.type==='RESERVE'){
    exact(a,['type','signed']);exact(a.signed,['intent','signature']);const i=a.signed.intent;validateIntentShape(i);
    if(program)assert.equal(a.signed.signature,null);else{assert(!terminalProgramFee(i)&&!centuryWarmup(i),'program-only payment');assert(verify(i,a.signed.signature,i.sender),'owner signature');}
    if(Object.hasOwn(s.requests,i.pid)){assert.equal(s.requests[i.pid].digest,hash(i),'pid content conflict');return true;}
    if(!terminalProgramFee(i))guardPaymentTariff(s,i);
    assert.equal(i.unitScale??'1',s.unitScale??'1','payment denomination mismatch');
    assert.equal(i.epoch,s.epoch,'intent epoch');assert(paymentClock(s,i)<=i.lastReserve,'reservation admission expired');assert(paymentClock(s,i)<i.deadline);
    let value=0n;for(const id of i.inputs){const o=s.outputs[id];assert(o&&o.owner===i.sender,'missing/foreign input');assert(s.time>=o.unlock,'protected output');value+=amount(o.value);delete s.outputs[id];}
    assert(value<=MAX&&value>=amount(i.value)+amount(i.fee),'input amount');
    for(const p of i.parts){const operators=new Set();for(const id of p.nodes){const n=s.nodes[id];assert(n,'unknown worker');const group=effectiveWorkGroup(s,id);assert(!operators.has(group)||founderWorker(s,id),'operator separation');operators.add(group);
      assert(amount(n.consensusHeld)>0n&&amount(p.value)<=amount(n.tier),'worker tier');const held=amount(n.taskHeld)+amount(p.value);assert(held+amount(n.consensusHeld)<=amount(n.stake),'personal coverage');n.taskHeld=String(held);}}
    s.requests[i.pid]={intent:structuredClone(i),digest:hash(i),status:'RESERVED',escrow:String(value),terminalHeight:0,...(scheduled(i)?{executeAt:0}:{})};
    liabilityReserve(s,i.pid);
  }else if(a.type==='FINALIZE'||a.type==='EXPIRE'||a.type==='CANCEL'){
    exact(a,a.type==='FINALIZE'?['type','pid','request','receipts']:['type','pid','request']);ID(a.pid);ID(a.request);const r=s.requests[a.pid];assert(r,'unknown request');assert.equal(a.request,r.digest,'request binding');
    const target=a.type==='FINALIZE'?(scheduled(r.intent)?'SCHEDULED':'SETTLED'):a.type==='CANCEL'?'CANCELLED':'EXPIRED';
    if(r.status===target)return true;assert(a.type==='CANCEL'?scheduled(r.intent)&&['RESERVED','SCHEDULED'].includes(r.status):r.status==='RESERVED','opposite terminal outcome');const held=r.status==='RESERVED';
    const i=r.intent,V=amount(r.escrow);
    if(a.type==='FINALIZE'){
      assert(paymentClock(s,i)<=i.deadline,'final deadline');verifyReceipts(s,r,a.receipts);const unlock=count(s.time+i.delay);
      if(scheduled(i)){r.executeAt=count(s.time+i.sendDelay);}else{output(oid(a.pid,'recipient'),i.recipient,amount(i.value),unlock);output(oid(a.pid,'change'),i.sender,V-amount(i.value)-amount(i.fee));s.fees=String(amount(s.fees)+amount(i.fee));}
    }else{
      if(a.type==='CANCEL')assert(r.executeAt===0||s.time<r.executeAt,'cancellation window closed');else assert(paymentClock(s,i)>i.deadline,'expiry not due');output(oid(a.pid,'refund'),i.sender,V-amount(i.abortFee));s.fees=String(amount(s.fees)+amount(i.abortFee));
    }
    if(held&&!liabilityTerminal(s,a.pid,target))for(const p of i.parts)for(const id of p.nodes){const n=s.nodes[id];n.taskHeld=String(amount(n.taskHeld)-amount(p.value));}
    if(!held&&s.liability?.policy.version===4)liabilityTerminal(s,a.pid,target);
    r.status=target;if(target!=='SCHEDULED'){r.escrow='0';r.terminalHeight=h;}
  }else if(a.type==='TICK'){exact(a,['type']);}
  else if(a.type==='MODEL_HANDOVER'){exact(a,['type','nextEpoch']);assert.equal(a.nextEpoch,s.epoch+1);s.epoch=a.nextEpoch;}
  else assert.fail('unsupported transition; HOLD and mint need separately qualified rules');
  return false;
}

// Called once at the actual committed block time, never at synthetic catch-up ticks.
export function releaseDue(base){
 audit(base);const due=Object.entries(base.requests).filter(([,r])=>r.status==='SCHEDULED'&&r.executeAt<=base.time);if(!due.length)return base;
 const s=structuredClone(base);for(const [pid] of due.sort(([a],[b])=>a.localeCompare(b)))executeScheduledRelease(s,pid);audit(s);return s;
}
// Internal mutation kernel; caller authenticates state and commits atomically.
export function executeScheduledRelease(s,pid){
  const r=s.requests[pid];assert(r&&r.status==='SCHEDULED'&&r.executeAt<=s.time,'scheduled release not due');const i=r.intent;
  for(const role of ['recipient','change'])assert(!Object.hasOwn(s.outputs,oid(pid,role)),'output collision');
  s.outputs[oid(pid,'recipient')]={owner:i.recipient,value:i.value,unlock:count(s.time+i.delay)};
  s.outputs[oid(pid,'change')]={owner:i.sender,value:String(amount(r.escrow)-amount(i.value)-amount(i.fee)),unlock:0};
  s.fees=String(amount(s.fees)+amount(i.fee));r.status='SETTLED';r.escrow='0';r.terminalHeight=s.height;
  if(s.liability?.policy.version===4)liabilityTerminal(s,pid,'SETTLED');
}
