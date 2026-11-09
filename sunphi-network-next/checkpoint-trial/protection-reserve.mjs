// Separate protocol balance. No spending key, mint, or discretionary slashing.
import assert from 'node:assert/strict';
import {hash,exact,integer,publicKey,hex} from './crypto.mjs';
import {managerGuard,developmentManager} from './reserve-recovery.mjs';
export const PROTECTION_RESERVE='DUEBYTE_PROTECTION_RESERVE_V1';
export const PROTECTION_RESERVE_ACTIONS=['QUEUE_PROTECTION_PAYMENT_V1','CANCEL_PROTECTION_PAYMENT_V1','EXECUTE_PROTECTION_PAYMENT_V1'];
const amount=x=>{assert(typeof x==='string'&&/^(0|[1-9][0-9]*)$/.test(x));const n=BigInt(x);assert(n<1n<<64n);return n;};
export const initialProtection=()=>({collected:'0',compensated:'0',exceptional:'0',sequence:0,pending:null,events:0,history:hash(PROTECTION_RESERVE),recent:[]});
export function protectionEvent(m,event){const p=m.liability.protection;const entry={...event,number:++p.events,height:m.liability.height};p.history=hash({previous:p.history,event:entry});p.recent.push(entry);if(p.recent.length>32)p.recent.shift();}
export function protectionAuthority(s){const r=s.networkReserves;assert(r?.development.access,'founder recovery policy required');assert.equal(r.policy.development.manager,s.money.liability.policy.founderKey,'founder authority binding');return r;}
export function reconcileProtection(s){if(!s.money.liability)return s;const p=s.money.liability.protection.pending;if(!p)return s;const r=protectionAuthority(s),access=r.development.access;
 const reason=access.pending||access.epoch!==p.managementEpoch||developmentManager(r)!==p.manager?'ACCESS_CHANGED':s.money.time>p.expiresAt?'EXPIRED':null;
 if(reason){protectionEvent(s.money,{type:'EXCEPTION_CANCELLED',sequence:p.sequence,reason});s.money.liability.protection.pending=null;}return s;
}
export function applyProtectionAction(s,a,author){const l=s.money.liability,p=l.protection,r=protectionAuthority(s);reconcileProtection(s);
 if(a.type==='QUEUE_PROTECTION_PAYMENT_V1'){
  exact(a,['type','managementEpoch','sequence','recipient','value','purpose','reference','validUntil']);managerGuard(r,a,author);assert(!p.pending,'one pending protection payment');assert.equal(a.sequence,p.sequence+1);integer(a.sequence,1);publicKey(a.recipient);hex(a.reference);assert(typeof a.purpose==='string'&&a.purpose.trim().length>=8&&a.purpose.length<=512,'public purpose required');integer(a.validUntil,s.money.time);assert(a.validUntil<=s.money.time+86400,'bounded founder instruction');assert(amount(a.value)>0n&&amount(a.value)<=amount(l.pool),'insufficient protection reserve');
  const executeAt=s.money.time+l.policy.exceptionDelaySeconds;integer(executeAt,1);const expiresAt=executeAt+86400;integer(expiresAt,1);
  p.sequence=a.sequence;p.pending={sequence:a.sequence,recipient:a.recipient,value:a.value,purpose:a.purpose,reference:a.reference,manager:author,managementEpoch:a.managementEpoch,executeAt,expiresAt};protectionEvent(s.money,{type:'EXCEPTION_QUEUED',...p.pending});
 }else if(a.type==='CANCEL_PROTECTION_PAYMENT_V1'){
  exact(a,['type','managementEpoch','sequence']);managerGuard(r,a,author);assert(p.pending&&p.pending.sequence===a.sequence,'pending protection payment');protectionEvent(s.money,{type:'EXCEPTION_CANCELLED',sequence:a.sequence,reason:'FOUNDER_CANCELLED'});p.pending=null;
 }else{
  exact(a,['type','sequence']);assert.equal(a.type,'EXECUTE_PROTECTION_PAYMENT_V1');const q=p.pending;assert(q&&q.sequence===a.sequence,'pending protection payment');assert(s.money.time>=q.executeAt&&s.money.time<=q.expiresAt,'protection execution window');assert(amount(l.pool)>=amount(q.value),'protection balance');
  const id=hash({domain:PROTECTION_RESERVE+'/EXCEPTION',configHash:s.configHash,sequence:q.sequence});assert(!s.money.outputs[id],'protection replay');s.money.outputs[id]={owner:q.recipient,value:q.value,unlock:0};l.pool=String(amount(l.pool)-amount(q.value));p.exceptional=String(amount(p.exceptional)+amount(q.value));protectionEvent(s.money,{type:'EXCEPTION_PAID',...q,output:id});p.pending=null;
 }return s;
}
export function auditProtection(m){const l=m.liability,p=l.protection;exact(p,['collected','compensated','exceptional','sequence','pending','events','history','recent']);assert.equal(amount(p.collected)-amount(p.compensated)-amount(p.exceptional),amount(l.pool),'protection conservation');integer(p.sequence);integer(p.events);hex(p.history);assert(Array.isArray(p.recent)&&p.recent.length===Math.min(32,p.events));for(let i=0;i<p.recent.length;i++){assert.equal(p.recent[i].number,p.events-p.recent.length+i+1);integer(p.recent[i].height,1);}
 if(p.pending){const q=p.pending;exact(q,['sequence','recipient','value','purpose','reference','manager','managementEpoch','executeAt','expiresAt']);assert.equal(q.sequence,p.sequence);publicKey(q.recipient);publicKey(q.manager);hex(q.reference);integer(q.managementEpoch);integer(q.executeAt,1);assert.equal(q.expiresAt,q.executeAt+86400);assert(amount(q.value)>0n&&amount(q.value)<=amount(l.pool));assert(typeof q.purpose==='string'&&q.purpose.trim().length>=8&&q.purpose.length<=512);}
}
export function protectionSummary(s){const l=s.money.liability;if(!l)return null;const r=protectionAuthority(s);return {name:'DueByte Protection Reserve',account:hash({domain:PROTECTION_RESERVE,configHash:s.configHash}),balance:l.pool,collected:l.protection.collected,automaticCompensation:l.protection.compensated,exceptionalPaid:l.protection.exceptional,manager:developmentManager(r),authorityExpiresAt:null,pending:l.protection.pending,delaySeconds:l.policy.exceptionDelaySeconds,events:l.protection.events,history:l.protection.history,recent:l.protection.recent,mintAllowed:false,guaranteedFullCompensation:false};}
