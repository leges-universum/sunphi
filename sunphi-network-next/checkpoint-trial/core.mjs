// Explicit public-money experimental profile. Old ZK acceptance paths are untouched.
import assert from 'node:assert/strict';
import {auditWorkerFunding} from './worker-collateral.mjs';
import {checkPurchaseConfig,auditNativePurchase} from './research/purchase-native.mjs';
import {checkExchangeConfig,auditNativeExchange} from './research/exchange-native.mjs';
import {UTC_OBLIGATIONS,checkObligationAdmission} from './obligation-clock.mjs';
import {audit,root,transition,receiptBody,policy as modelPolicy,scheduled,releaseDue} from './payment-model.mjs';
import {hash,exact,integer,hex,verify,sign,canonical} from './crypto.mjs';
import {auditMembership} from './validator-membership.mjs';
import {controlActions,validateControl,initialAuthority,activate,applyControl,delayedPaymentsEnabled,resourceLimitsEnabled} from './authority.mjs';
import {checkResourceAdmission,maintainResources} from './resource-limits.mjs';
import {checkRewardClock} from './economic-clock.mjs';
import {REWARD_ACTIONS,applyRewardAction,beginRewards,recordRewardSettlements,auditRewards} from './node-rewards.mjs';
import {PROTECTION_ACTIONS,applySpendPolicy,advanceSpendPolicies,auditSpendPolicies,checkApproval,spendPolicy,protectionEnabled} from './spend-protection.mjs';
import {LAUNCH_ACTIONS,applyLaunchAction,auditLaunchFund,checkLaunchPayment,recordLaunchPayment} from './launch-fund.mjs';
import {RESERVE_ACTIONS,applyReserveAction,auditNetworkReserves,checkReservedPayment,recordReserveSettlement} from './network-reserves.mjs';
import {LIABILITY_ACTIONS,applyLiabilityAction,liabilityAttestation,advanceLiability,auditLiabilityState} from './payment-liability.mjs';
import {reconcileProtection} from './protection-reserve.mjs';
import {PRECISION_ACTION,applyTokenPrecision} from './token-precision.mjs';
import {ECONOMIC_PREPARATION_ACTIONS,applyEconomicPreparation,auditEconomicPreparation,guardPreparedEconomy} from './economic-preparation.mjs';
import {MEMORIAL_ACTIONS,applyMemorialAction,checkMemorialPayment} from './memorial-custody.mjs';
import {CENTURY_WARMUP_ACTIONS,applyCenturyWarmupAction,auditCenturyWarmupState,recordCenturyWarmupSettlement} from './century-warmup.mjs';
import {CENTURY_FEES_ACTION,applyCenturyFees} from './century-fees.mjs';
import {CENTURY_SUBSIDY_ACTION,applyCenturySubsidy,CENTURY_POLICY_ACTIONS,applyCenturyPolicy} from './century-subsidy.mjs';
import {CENTURY_HOME_ACTION,completeCenturyHome} from './century-home.mjs';
import {CENTURY_FUNDS_ACTION,applyCenturyFunds,auditCenturyFunds,checkCenturyFundsPayment} from './century-funds.mjs';
import {CENTURY_ISSUANCE_ACTIONS,applyCenturyIssuance} from './century-issuance.mjs';
import {NATIVE_ACTIONS,applyNativeContract,auditNativeContracts} from './native-contracts.mjs';
export const PROFILE='DUEBYTE_PUBLIC_CHECKPOINT_TRIAL_V1';
const immutableConfigs=new WeakMap();
// Only this factory can memoize validation: it owns and recursively freezes
// a detached copy. Merely freezing an untrusted outer object is insufficient.
export function immutableConfig(config){
 const c=structuredClone(config),digest=validateConfig(c);
 const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}};
 freeze(c);immutableConfigs.set(c,digest);return c;
}
export function validateConfig(c){const cached=immutableConfigs.get(c);if(cached)return cached;exact(c,['profile','chainId','initial','trialOnly',...(c.control?['control']:[]),...(Object.hasOwn(c,'purchaseLab')?['purchaseLab']:[]),...(Object.hasOwn(c,'exchangeLab')?['exchangeLab']:[]),...(Object.hasOwn(c,'obligationClock')?['obligationClock']:[])]);if(Object.hasOwn(c,'purchaseLab')){assert(c.purchaseLab);checkPurchaseConfig(c);}if(Object.hasOwn(c,'exchangeLab')){assert(c.exchangeLab);checkExchangeConfig(c);}if(Object.hasOwn(c,'obligationClock'))assert.equal(c.obligationClock,UTC_OBLIGATIONS);if(c.control)validateControl(c.control);assert.equal(c.profile,PROFILE);assert.equal(c.trialOnly,true);assert(/^duebyte-trial-[a-z0-9-]{1,50}$/.test(c.chainId));audit(c.initial);assert.equal(c.initial.height,0);return hash(c);}
export function origin(c){return {profile:PROFILE,configHash:validateConfig(c),height:0,blockHash:'0'.repeat(64),money:structuredClone(c.initial),...(c.control?{authority:initialAuthority(c.control)}:{})};}
export function auditState(s,c){exact(s,['profile','configHash','height','blockHash','money',...(c.control?['authority']:[]),...(s.rewards?['rewards']:[]),...(s.spendPolicies?['spendPolicies']:[]),...(s.launchFund?['launchFund']:[]),...(s.networkReserves?['networkReserves']:[]),...(s.economicPreparation?['economicPreparation']:[]),...(s.centuryWarmup?['centuryWarmup']:[]),...(s.centuryFees?['centuryFees']:[]),...(s.centurySubsidy?['centurySubsidy']:[]),...(s.centuryFunds?['centuryFunds']:[]),...(s.nativeContracts?['nativeContracts']:[]),...(s.workerFunding?['workerFunding']:[]),...(s.purchaseBook?['purchaseBook']:[]),...(s.exchangeBook?['exchangeBook']:[])]);assert.equal(s.profile,PROFILE);assert.equal(s.configHash,validateConfig(c));integer(s.height);hex(s.blockHash);if(c.control)auditMembership(s.authority,c,s.height);audit(s.money);auditNativePurchase(s,c);auditNativeExchange(s,c);for(const r of Object.values(s.money.requests))checkObligationAdmission(c,r.intent);if(s.money.liability)assert.equal(s.money.liability.policy.version>=2,c.obligationClock===UTC_OBLIGATIONS,'liability genesis clock');if(s.authority?.nodeRewards)checkRewardClock(c,s.authority.nodeRewards.coefficients);if(s.rewards){checkRewardClock(c,s.rewards.coefficients);if(s.rewards.scheduled)checkRewardClock(c,s.rewards.scheduled.coefficients);}if(s.centuryWarmup)assert.equal(s.centuryWarmup.timeBasis,c.obligationClock,'warmup genesis clock');auditRewards(s);auditSpendPolicies(s);auditLaunchFund(s);auditNetworkReserves(s);auditLiabilityState(s);auditEconomicPreparation(s);auditCenturyFunds(s);auditCenturyWarmupState(s);auditNativeContracts(s);auditWorkerFunding(s);if(s.workerFunding)for(const id of Object.keys(s.workerFunding.accounts))assert(s.money.nodes[id],'funding for missing worker');if(Object.values(s.money.requests).some(r=>scheduled(r.intent)))assert(delayedPaymentsEnabled(s),'scheduled state before activation');return true;}
export function stateHash(s,c){auditState(s,c);assert(Buffer.byteLength(canonical(s))<=1048576,'trial snapshot limit');return hash(s);}
export function envelope(config,action,key){const body={domain:PROFILE+'/TX',configHash:validateConfig(config),action,author:key.publicKey};return {body,signature:sign(body,key.privateKey)};}
export function parseTx(bytes,c){assert(bytes.length>0&&bytes.length<=65536,'tx size');const t=JSON.parse(bytes.toString('utf8'));exact(t,['body','signature']);exact(t.body,['domain','configHash','action','author']);assert.equal(t.body.domain,PROFILE+'/TX');assert.equal(t.body.configHash,validateConfig(c));assert(verify(t.body,t.signature,t.body.author),'tx signature');assert(['RESERVE','SCHEDULE_PAYMENT_V1','CANCEL_SCHEDULED_PAYMENT_V1','FINALIZE','EXPIRE',...(c.control?[...controlActions(c),...ECONOMIC_PREPARATION_ACTIONS,...MEMORIAL_ACTIONS,...REWARD_ACTIONS,...PROTECTION_ACTIONS,...LAUNCH_ACTIONS,...RESERVE_ACTIONS,...LIABILITY_ACTIONS]:[])].includes(t.body.action.type),'public action');
 assert(t.body.action.type!=='PREPARE_ECONOMY_V4','public action');
 if(c.obligationClock)assert(['RESERVE','SCHEDULE_PAYMENT_V1','CANCEL_SCHEDULED_PAYMENT_V1','FINALIZE','EXPIRE',...controlActions(c),'PREPARE_NETWORK_RESERVES_V1','ENABLE_NODE_REWARDS_V1','SET_REWARD_COEFFICIENTS_V1','ALLOW_REWARD_NODES_V1','REGISTER_REWARD_NODE_V1','BIND_REWARD_WALLETS_V1','SET_REWARD_MANAGEMENT_V1',...LIABILITY_ACTIONS,...PROTECTION_ACTIONS].includes(t.body.action.type),'UTC economic controller not qualified');
 if(['RESERVE','SCHEDULE_PAYMENT_V1'].includes(t.body.action.type)){assert.equal(t.body.author,t.body.action.signed.intent.sender,'reserve author');checkObligationAdmission(c,t.body.action.signed.intent);}return t;
}
export function applyTx(s,bytes,c,time){const t=parseTx(bytes,c);let action=t.body.action;
 guardPreparedEconomy(s,action.type);
 if(ECONOMIC_PREPARATION_ACTIONS.includes(action.type)){const out=applyEconomicPreparation(s,action,c);stateHash(out,c);return out;}
 if(MEMORIAL_ACTIONS.includes(action.type)){const out=applyMemorialAction(s,action,t.body.author);stateHash(out,c);return out;}
 if(NATIVE_ACTIONS.includes(action.type)){const out=applyNativeContract(s,action,t.body.author);stateHash(out,c);return out;}
 if(action.type===PRECISION_ACTION){const out=applyTokenPrecision(s,action,c);stateHash(out,c);return out;}
 if(action.type===CENTURY_FEES_ACTION){const out=applyCenturyFees(s,action,c);stateHash(out,c);return out;}
 if(action.type===CENTURY_SUBSIDY_ACTION){const out=applyCenturySubsidy(s,action,c);stateHash(out,c);return out;}
 if(CENTURY_POLICY_ACTIONS.includes(action.type)){const out=applyCenturyPolicy(s,action,c);stateHash(out,c);return out;}
 if(action.type===CENTURY_HOME_ACTION){const out=completeCenturyHome(s,action,t.body.author);stateHash(out,c);return out;}
 if(action.type===CENTURY_FUNDS_ACTION){const out=applyCenturyFunds(s,action,c);stateHash(out,c);return out;}
 if(CENTURY_ISSUANCE_ACTIONS.includes(action.type)){const out=applyCenturyIssuance(s,action,c,t.body.author);stateHash(out,c);return out;}
 if(CENTURY_WARMUP_ACTIONS.includes(action.type)){const out=applyCenturyWarmupAction(s,action);stateHash(out,c);return out;}
 if(LIABILITY_ACTIONS.includes(action.type)){const out=applyLiabilityAction(s,action,c,t.body.author);stateHash(out,c);assert(Buffer.byteLength(canonical(out))<1048576-65536,'liability transition capacity');return out;}
 if(RESERVE_ACTIONS.includes(action.type)){const out=reconcileProtection(applyReserveAction(s,action,t.body.author,c));stateHash(out,c);assert(Buffer.byteLength(canonical(out))<1048576-196608,'reserve transition capacity');return out;}
 if(LAUNCH_ACTIONS.includes(action.type)){const out=applyLaunchAction(s,action,c);stateHash(out,c);assert(Buffer.byteLength(canonical(out))<1048576-196608,'launch transition capacity');return out;}
 if(PROTECTION_ACTIONS.includes(action.type)){const out=applySpendPolicy(s,action,t.body.author);stateHash(out,c);assert(Buffer.byteLength(canonical(out))<1048576-196608,'spend policy capacity');return out;}
 if(REWARD_ACTIONS.includes(action.type)){const out=applyRewardAction(s,action,t.body.author,c);stateHash(out,c);assert(Buffer.byteLength(canonical(out))<1048576-131072,'reward transition capacity');return out;}
 if(['RESERVE','SCHEDULE_PAYMENT_V1'].includes(action.type)){
  if(!Object.hasOwn(s.money.requests,action.signed.intent.pid))assert.equal(action.signed.intent.unitScale??'1',s.money.unitScale??'1','payment denomination mismatch; prepare a new payment');
  checkLaunchPayment(s,action.signed.intent);
  checkReservedPayment(s,action.signed.intent);
  checkMemorialPayment(s,action.signed.intent);
  checkCenturyFundsPayment(s,action.signed.intent);
  if(!Object.hasOwn(s.money.requests,action.signed.intent.pid))checkApproval(s,action.signed.intent,action.approval);
  if(Object.hasOwn(action,'approval')){const {approval,...rest}=action;action=rest;}
 }
 if(action.type==='SCHEDULE_PAYMENT_V1'){assert(delayedPaymentsEnabled(s),'delayed payments not activated');assert(scheduled(action.signed?.intent),'scheduled intent required');action={...action,type:'RESERVE'};}
 else if(action.type==='RESERVE')assert(!scheduled(action.signed?.intent),'use scheduled payment action');
 if(action.type==='CANCEL_SCHEDULED_PAYMENT_V1'){assert(delayedPaymentsEnabled(s),'delayed payments not activated');const r=s.money.requests[action.pid];assert(r&&scheduled(r.intent),'unknown scheduled payment');assert.equal(t.body.author,r.intent.sender,'only sender can cancel');action={...action,type:'CANCEL'};}
 if(controlActions(c).includes(action.type)){const out={...s,authority:applyControl(s.authority,action,{config:c,height:s.height,time})};stateHash(out,c);assert(Buffer.byteLength(canonical(out))<1048576-(s.rewards?196608:32768),'control transition capacity');return out;}
 if(action.type==='RESERVE'&&resourceLimitsEnabled(s)&&!Object.hasOwn(s.money.requests,action.signed.intent.pid))checkResourceAdmission(s.money,action.signed.intent,s.configHash,{protectedPayment:protectionEnabled(s)&&spendPolicy(s,action.signed.intent.sender)?.enabled===true});
 if(action.type==='RESERVE'&&!Object.hasOwn(s.money.requests,action.signed.intent.pid)){const live=Object.values(s.money.requests).filter(r=>['RESERVED','SCHEDULED'].includes(r.status)).length;assert(Buffer.byteLength(canonical(s))+bytes.length+1024*(live+1)<1048576-(s.rewards?196608:32768),'trial capacity: preserve space for every terminal outcome');}
 if(action.type==='FINALIZE')action=verifiedFinalization(s.money,action,{profile:PROFILE,configHash:validateConfig(c),replayCommitted:s.authority?.version===2});
 const e={parent:root(s.money),epoch:s.money.epoch,time,action};const out=transition(s.money,e);if(action.type==='RESERVE'&&out.state.liability){const records=Object.values(out.state.liability.records);const headroom=records.reduce((n,r)=>n+2048+r.assignments.length*1200,0);assert(Buffer.byteLength(canonical({...s,money:out.state}))+headroom<1048576-196608,'liability admission headroom');}return recordCenturyWarmupSettlement(recordReserveSettlement(recordLaunchPayment(recordRewardSettlements({...s,money:out.state},s.money),s.money),s.money));}
export function block(base,c,{height,blockHash,time,txs},filter=false){integer(height,1);assert.equal(height,base.height+1,'height');hex(blockHash);integer(time,1);assert(time>=base.money.time,'block time');
 // Advance long-offline time in bounded model steps, but never beyond consensus time.
 let money=base.money;assert(time-money.time<=31*86400,'trial offline bound');
 while(time-money.time>modelPolicy.maxAdvance)money=transition(money,{parent:root(money),epoch:money.epoch,time:money.time+modelPolicy.maxAdvance,action:{type:'TICK'}}).state;
 money=transition(money,{parent:root(money),epoch:money.epoch,time,action:{type:'TICK'}}).state;
 let s=advanceSpendPolicies(beginRewards(base,{...base,height,blockHash,money,...(base.authority?{authority:activate(base.authority,height)}:{})}));
 s=recordCenturyWarmupSettlement(advanceLiability(s));
 if(delayedPaymentsEnabled(s)){const before=s.money;s=recordRewardSettlements({...s,money:releaseDue(s.money)},before);}
 if(resourceLimitsEnabled(s))s={...s,money:maintainResources(s.money)};
 // Resource maintenance can expire a programme payment without an EXPIRE tx.
 // Commit its controller release in the same block as the monetary refund.
 s=recordCenturyWarmupSettlement(s);
 const accepted=[],codes=[];assert(txs.length<=64,'block tx count');let size=0;
 for(const bytes of txs){size+=bytes.length;assert(size<=1048576,'block bytes');try{s=applyTx(s,bytes,c,time);accepted.push(bytes);codes.push(0);}catch(e){if(!filter)throw e;codes.push(1);}}
 stateHash(s,c);return {state:s,accepted,codes};
}
export function workReceipt(state,pid,index,node,key){const r=state.money.requests[pid];assert(r?.status==='RESERVED','no live work');assert(r.intent.parts[index]?.nodes.includes(node),'unassigned');assert.equal(state.money.nodes[node].key,key.publicKey);const signature=sign(receiptBody(r,index,node),key.privateKey);return {index,node,signature,profileSignature:sign({domain:PROFILE+'/WORK',configHash:state.configHash,request:r.digest,index,node,signature},key.privateKey),...(state.money.liability?.records[pid]?{attestation:liabilityAttestation(state.money,pid,index,node,key).signature}:{})};}
import {verifiedFinalization} from './payment-finalization.mjs';
