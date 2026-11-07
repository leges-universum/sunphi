// Explicit public-money experimental profile. Old ZK acceptance paths are untouched.
import assert from 'node:assert/strict';
import {audit,root,transition,receiptBody,policy as modelPolicy,scheduled,releaseDue} from './payment-model.mjs';
import {hash,exact,integer,hex,verify,sign,canonical} from './crypto.mjs';
import {validateControl,initialAuthority,activate,applyControl,delayedPaymentsEnabled,resourceLimitsEnabled} from './authority.mjs';
import {checkResourceAdmission,maintainResources} from './resource-limits.mjs';
import {REWARD_ACTIONS,applyRewardAction,beginRewards,recordRewardSettlements,auditRewards} from './node-rewards.mjs';
import {PROTECTION_ACTIONS,applySpendPolicy,advanceSpendPolicies,auditSpendPolicies,checkApproval,spendPolicy,protectionEnabled} from './spend-protection.mjs';
import {LAUNCH_ACTIONS,applyLaunchAction,auditLaunchFund,checkLaunchPayment,recordLaunchPayment} from './launch-fund.mjs';
import {RESERVE_ACTIONS,applyReserveAction,auditNetworkReserves,checkReservedPayment,recordReserveSettlement} from './network-reserves.mjs';
import {LIABILITY_ACTIONS,applyLiabilityAction,liabilityAttestation,checkLiabilityReceipt,advanceLiability,auditLiabilityState} from './payment-liability.mjs';
import {reconcileProtection} from './protection-reserve.mjs';
export const PROFILE='DUEBYTE_PUBLIC_CHECKPOINT_TRIAL_V1';
export function validateConfig(c){exact(c,['profile','chainId','initial','trialOnly',...(c.control?['control']:[])]);if(c.control)validateControl(c.control);assert.equal(c.profile,PROFILE);assert.equal(c.trialOnly,true);assert(/^duebyte-trial-[a-z0-9-]{1,50}$/.test(c.chainId));audit(c.initial);assert.equal(c.initial.height,0);return hash(c);}
export function origin(c){return {profile:PROFILE,configHash:validateConfig(c),height:0,blockHash:'0'.repeat(64),money:structuredClone(c.initial),...(c.control?{authority:initialAuthority(c.control)}:{})};}
export function stateHash(s,c){exact(s,['profile','configHash','height','blockHash','money',...(c.control?['authority']:[]),...(s.rewards?['rewards']:[]),...(s.spendPolicies?['spendPolicies']:[]),...(s.launchFund?['launchFund']:[]),...(s.networkReserves?['networkReserves']:[])]);assert.equal(s.profile,PROFILE);assert.equal(s.configHash,validateConfig(c));integer(s.height);hex(s.blockHash);audit(s.money);auditRewards(s);auditSpendPolicies(s);auditLaunchFund(s);auditNetworkReserves(s);auditLiabilityState(s);if(Object.values(s.money.requests).some(r=>scheduled(r.intent)))assert(delayedPaymentsEnabled(s),'scheduled state before activation');assert(Buffer.byteLength(canonical(s))<=1048576,'trial snapshot limit');return hash(s);}
export function envelope(config,action,key){const body={domain:PROFILE+'/TX',configHash:validateConfig(config),action,author:key.publicKey};return {body,signature:sign(body,key.privateKey)};}
export function parseTx(bytes,c){assert(bytes.length>0&&bytes.length<=65536,'tx size');const t=JSON.parse(bytes.toString('utf8'));exact(t,['body','signature']);exact(t.body,['domain','configHash','action','author']);assert.equal(t.body.domain,PROFILE+'/TX');assert.equal(t.body.configHash,validateConfig(c));assert(verify(t.body,t.signature,t.body.author),'tx signature');assert(['RESERVE','SCHEDULE_PAYMENT_V1','CANCEL_SCHEDULED_PAYMENT_V1','FINALIZE','EXPIRE',...(c.control?['ROTATE_VALIDATOR','RENEW_POLICY','ENABLE_DELAYED_PAYMENTS','ENABLE_RESOURCE_LIMITS','ENABLE_SPEND_PROTECTION_V1',...REWARD_ACTIONS,...PROTECTION_ACTIONS,...LAUNCH_ACTIONS,...RESERVE_ACTIONS,...LIABILITY_ACTIONS]:[])].includes(t.body.action.type),'public action');
 if(['RESERVE','SCHEDULE_PAYMENT_V1'].includes(t.body.action.type))assert.equal(t.body.author,t.body.action.signed.intent.sender,'reserve author');return t;
}
export function applyTx(s,bytes,c,time){const t=parseTx(bytes,c);let action=t.body.action;
 if(LIABILITY_ACTIONS.includes(action.type)){const out=applyLiabilityAction(s,action,c,t.body.author);stateHash(out,c);assert(Buffer.byteLength(canonical(out))<1048576-65536,'liability transition capacity');return out;}
 if(RESERVE_ACTIONS.includes(action.type)){const out=reconcileProtection(applyReserveAction(s,action,t.body.author,c));stateHash(out,c);assert(Buffer.byteLength(canonical(out))<1048576-196608,'reserve transition capacity');return out;}
 if(LAUNCH_ACTIONS.includes(action.type)){const out=applyLaunchAction(s,action,c);stateHash(out,c);assert(Buffer.byteLength(canonical(out))<1048576-196608,'launch transition capacity');return out;}
 if(PROTECTION_ACTIONS.includes(action.type)){const out=applySpendPolicy(s,action,t.body.author);stateHash(out,c);assert(Buffer.byteLength(canonical(out))<1048576-196608,'spend policy capacity');return out;}
 if(REWARD_ACTIONS.includes(action.type)){const out=applyRewardAction(s,action,t.body.author,c);stateHash(out,c);assert(Buffer.byteLength(canonical(out))<1048576-131072,'reward transition capacity');return out;}
 if(['RESERVE','SCHEDULE_PAYMENT_V1'].includes(action.type)){
  checkLaunchPayment(s,action.signed.intent);
  checkReservedPayment(s,action.signed.intent);
  if(!Object.hasOwn(s.money.requests,action.signed.intent.pid))checkApproval(s,action.signed.intent,action.approval);
  if(Object.hasOwn(action,'approval')){const {approval,...rest}=action;action=rest;}
 }
 if(action.type==='SCHEDULE_PAYMENT_V1'){assert(delayedPaymentsEnabled(s),'delayed payments not activated');assert(scheduled(action.signed?.intent),'scheduled intent required');action={...action,type:'RESERVE'};}
 else if(action.type==='RESERVE')assert(!scheduled(action.signed?.intent),'use scheduled payment action');
 if(action.type==='CANCEL_SCHEDULED_PAYMENT_V1'){assert(delayedPaymentsEnabled(s),'delayed payments not activated');const r=s.money.requests[action.pid];assert(r&&scheduled(r.intent),'unknown scheduled payment');assert.equal(t.body.author,r.intent.sender,'only sender can cancel');action={...action,type:'CANCEL'};}
 if(['ROTATE_VALIDATOR','RENEW_POLICY','ENABLE_DELAYED_PAYMENTS','ENABLE_RESOURCE_LIMITS','ENABLE_SPEND_PROTECTION_V1'].includes(action.type)){const out={...s,authority:applyControl(s.authority,action,{config:c,height:s.height,time})};stateHash(out,c);assert(Buffer.byteLength(canonical(out))<1048576-(s.rewards?196608:32768),'control transition capacity');return out;}
 if(action.type==='RESERVE'&&resourceLimitsEnabled(s)&&!Object.hasOwn(s.money.requests,action.signed.intent.pid))checkResourceAdmission(s.money,action.signed.intent,s.configHash,{protectedPayment:protectionEnabled(s)&&spendPolicy(s,action.signed.intent.sender)?.enabled===true});
 if(action.type==='RESERVE'&&!Object.hasOwn(s.money.requests,action.signed.intent.pid)){const live=Object.values(s.money.requests).filter(r=>['RESERVED','SCHEDULED'].includes(r.status)).length;assert(Buffer.byteLength(canonical(s))+bytes.length+1024*(live+1)<1048576-(s.rewards?196608:32768),'trial capacity: preserve space for every terminal outcome');}
 if(action.type==='FINALIZE'){
  assert(Array.isArray(action.receipts)&&action.receipts.length<=modelPolicy.maxParts*modelPolicy.copies);
  action={...action,receipts:action.receipts.map(r=>{exact(r,['index','node','signature','profileSignature',...(r.attestation?['attestation']:[])]);checkLiabilityReceipt(s.money,action.pid,r.index,r.node,r.attestation);const body={domain:PROFILE+'/WORK',configHash:validateConfig(c),request:action.request,index:r.index,node:r.node,signature:r.signature};assert(verify(body,r.profileSignature,s.money.nodes[r.node]?.key),'network-bound work signature');return {index:r.index,node:r.node,signature:r.signature};})};
 }
 const e={parent:root(s.money),epoch:s.money.epoch,time,action};const out=transition(s.money,e);if(action.type==='RESERVE'&&out.state.liability){const records=Object.values(out.state.liability.records);const headroom=records.reduce((n,r)=>n+2048+r.assignments.length*1200,0);assert(Buffer.byteLength(canonical({...s,money:out.state}))+headroom<1048576-196608,'liability admission headroom');}return recordReserveSettlement(recordLaunchPayment(recordRewardSettlements({...s,money:out.state},s.money),s.money),s.money);}
export function block(base,c,{height,blockHash,time,txs},filter=false){integer(height,1);assert.equal(height,base.height+1,'height');hex(blockHash);integer(time,1);assert(time>=base.money.time,'block time');
 // Advance long-offline time in bounded model steps, but never beyond consensus time.
 let money=base.money;assert(time-money.time<=31*86400,'trial offline bound');
 while(time-money.time>modelPolicy.maxAdvance)money=transition(money,{parent:root(money),epoch:money.epoch,time:money.time+modelPolicy.maxAdvance,action:{type:'TICK'}}).state;
 money=transition(money,{parent:root(money),epoch:money.epoch,time,action:{type:'TICK'}}).state;
 let s=advanceSpendPolicies(beginRewards(base,{...base,height,blockHash,money,...(base.authority?{authority:activate(base.authority,height)}:{})}));
 s=advanceLiability(s);
 if(delayedPaymentsEnabled(s)){const before=s.money;s=recordRewardSettlements({...s,money:releaseDue(s.money)},before);}
 if(resourceLimitsEnabled(s))s={...s,money:maintainResources(s.money)};
 const accepted=[],codes=[];assert(txs.length<=64,'block tx count');let size=0;
 for(const bytes of txs){size+=bytes.length;assert(size<=1048576,'block bytes');try{s=applyTx(s,bytes,c,time);accepted.push(bytes);codes.push(0);}catch(e){if(!filter)throw e;codes.push(1);}}
 stateHash(s,c);return {state:s,accepted,codes};
}
export function workReceipt(state,pid,index,node,key){const r=state.money.requests[pid];assert(r?.status==='RESERVED','no live work');assert(r.intent.parts[index]?.nodes.includes(node),'unassigned');assert.equal(state.money.nodes[node].key,key.publicKey);const signature=sign(receiptBody(r,index,node),key.privateKey);return {index,node,signature,profileSignature:sign({domain:PROFILE+'/WORK',configHash:state.configHash,request:r.digest,index,node,signature},key.privateKey),...(state.money.liability?.records[pid]?{attestation:liabilityAttestation(state.money,pid,index,node,key).signature}:{})};}
