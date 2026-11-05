// Consensus changes are dormant until a signed RESOURCE_FEATURE activation.
import assert from 'node:assert/strict';
import {hash} from './crypto.mjs';
import {root,transition,audit} from './payment-model.mjs';
import {RESOURCE_FEATURE} from './authority.mjs';
export const RESOURCE_LIMITS=Object.freeze({retainedTerminal:32,activeTotal:32,activeSender:8,admissionWindow:24});
export function resourcePaymentId(intent,configHash){const {pid,...body}=intent;return hash({domain:RESOURCE_FEATURE+'/INTENT',configHash,intent:body});}
export function checkResourceAdmission(money,intent,configHash,{protectedPayment=false}={}){
 assert.equal(intent.pid,resourcePaymentId(intent,configHash),'resource payment identifier');
 assert(BigInt(intent.abortFee)>=1n,'nonzero resource release fee required');
 // Only consensus-verified, opt-in second signatures may use a human review
 // window. The default and all unprotected transactions retain the old bound.
 assert(intent.lastReserve<=money.height+(protectedPayment?600:RESOURCE_LIMITS.admissionWindow),'bounded admission window');
 const active=Object.values(money.requests).filter(r=>['RESERVED','SCHEDULED'].includes(r.status));
 assert(active.length<RESOURCE_LIMITS.activeTotal,'active request capacity');
 assert(active.filter(r=>r.intent.sender===intent.sender).length<RESOURCE_LIMITS.activeSender,'sender request capacity');
}
export function maintainResources(base){
 let money=base;
 // Previously admitted records retain their signed fee and exact deadline.
 // Expiry needs no online wallet and releases worker liabilities and escrow.
 const expired=Object.entries(base.requests).filter(([,r])=>r.status==='RESERVED'&&base.height+1>r.intent.deadline).sort(([a],[b])=>a<b?-1:a>b?1:0);
 for(const [pid,r]of expired)money=transition(money,{parent:root(money),epoch:money.epoch,time:money.time,action:{type:'EXPIRE',pid,request:r.digest}}).state;
 const terminal=Object.entries(money.requests).filter(([,r])=>['EXPIRED','SETTLED','CANCELLED'].includes(r.status)).sort(([a,x],[b,y])=>y.terminalHeight-x.terminalHeight||(a<b?-1:a>b?1:0));
 const remove=terminal.slice(RESOURCE_LIMITS.retainedTerminal).filter(([,r])=>money.height>r.intent.lastReserve);
 const zero=Object.entries(money.outputs).filter(([,o])=>o.value==='0');
 if(remove.length||zero.length){money=structuredClone(money);for(const [pid]of remove)delete money.requests[pid];for(const [id]of zero)delete money.outputs[id];audit(money);}
 return money;
}
