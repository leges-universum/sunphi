import assert from 'node:assert/strict';
import {SUPPORT_ACTIONS,applyWorkerSupport} from '../worker-support.mjs';
import {supportIssued,guardSupportPayment} from '../support-accounting.mjs';
import {exact,hash,verify} from '../crypto.mjs';
import {PROFILE,parseTx} from '../core.mjs';
import {amount,centuryWarmup,terminalProgramFee} from '../payment-model.mjs';
import {centuryWarmupAccounts,memorialPolicy} from '../economic-policy-v3.mjs';
import {ECONOMIC_PREPARATION_ACTIONS,applyEconomicPreparation,auditEconomicPreparation} from '../economic-preparation.mjs';
import {CENTURY_FEES_ACTION,applyCenturyFees} from '../century-fees.mjs';
import {CENTURY_FUNDS_ACTION,applyCenturyFunds,auditCenturyFunds,centuryRestrictedAccounts,checkCenturyFundsPayment} from '../century-funds.mjs';
import {CENTURY_ISSUANCE_ACTIONS,applyCenturyIssuance,centuryIssued} from '../century-issuance.mjs';
import {CENTURY_SUBSIDY_ACTION,CENTURY_POLICY_ACTIONS,applyCenturySubsidy,applyCenturyPolicy} from '../century-subsidy.mjs';
import {CENTURY_HOME_ACTION,INDEXED_HOME_ACTION,completeCenturyHome} from '../century-home.mjs';
import {CENTURY_WARMUP_ACTIONS,applyCenturyWarmupAction,auditCenturyWarmupState} from '../century-warmup.mjs';
import {MEMORIAL_ACTIONS,applyMemorialAction,checkMemorialPayment} from '../memorial-custody.mjs';
import {NATIVE_ACTIONS,applyNativeContract,auditNativeContracts} from '../native-contracts.mjs';
import {PREPARE_WORKERS} from './bounded-worker-preparation.mjs';
import {INITIAL_PRECISION} from './bounded-initial-precision.mjs';
import {COLLATERAL_ACTIONS,auditWorkerFunding} from '../worker-collateral.mjs';
import {NODE_LINK_ACTION} from '../node-wallet-link.mjs';
export const CENTURY_ACTIONS=[...SUPPORT_ACTIONS,...ECONOMIC_PREPARATION_ACTIONS,CENTURY_FEES_ACTION,CENTURY_FUNDS_ACTION,...CENTURY_ISSUANCE_ACTIONS,CENTURY_SUBSIDY_ACTION,...CENTURY_POLICY_ACTIONS,CENTURY_HOME_ACTION,INDEXED_HOME_ACTION,...CENTURY_WARMUP_ACTIONS,...MEMORIAL_ACTIONS,...NATIVE_ACTIONS];
export function parseBoundedTx(bytes,c){
 assert(bytes.length>0&&bytes.length<=65536);const t=JSON.parse(bytes.toString('utf8'));
 if(![PREPARE_WORKERS,INITIAL_PRECISION,NODE_LINK_ACTION,...COLLATERAL_ACTIONS].includes(t?.body?.action?.type)&&!CENTURY_ACTIONS.includes(t?.body?.action?.type))return parseTx(bytes,c);
 // Century clocks are committed UTC; legacy funded controllers stay outside this route.
 // Issuance still requires the separate isolatedIssuance gate in the interpreter.
 exact(t,['body','signature']);exact(t.body,['domain','configHash','action','author']);assert(c.control);assert.equal(t.body.domain,PROFILE+'/TX');assert.equal(t.body.configHash,hash(c));assert(verify(t.body,t.signature,t.body.author),'tx signature');return t;
}
export function centuryAction(s,a,author,c){
 if(SUPPORT_ACTIONS.includes(a.type))return applyWorkerSupport(s,a,author,c);
 if(NATIVE_ACTIONS.includes(a.type))return applyNativeContract(s,a,author);
 if(ECONOMIC_PREPARATION_ACTIONS.includes(a.type))return applyEconomicPreparation(s,a,c);
 if(a.type===CENTURY_FEES_ACTION)return applyCenturyFees(s,a,c);
 if(a.type===CENTURY_FUNDS_ACTION)return applyCenturyFunds(s,a,c);
 if(CENTURY_ISSUANCE_ACTIONS.includes(a.type))return applyCenturyIssuance(s,a,c,author);
 if(a.type===CENTURY_SUBSIDY_ACTION)return applyCenturySubsidy(s,a,c);
 if(CENTURY_POLICY_ACTIONS.includes(a.type))return applyCenturyPolicy(s,a,c);
 if([CENTURY_HOME_ACTION,INDEXED_HOME_ACTION].includes(a.type))return completeCenturyHome(s,a,author);
 if(CENTURY_WARMUP_ACTIONS.includes(a.type))return applyCenturyWarmupAction(s,a);
 if(MEMORIAL_ACTIONS.includes(a.type))return applyMemorialAction(s,a,author);
 assert.fail('unsupported century action');
}
export const issuedTotal=s=>centuryIssued(s)+amount(s.centurySubsidy?.totalMintedMicro??'0')+supportIssued(s);
export function auditControllers(s){auditEconomicPreparation(s);auditCenturyFunds(s);auditCenturyWarmupState(s);auditNativeContracts(s);auditWorkerFunding(s);}
export function guardCustodyRequest(s,i){
 guardSupportPayment(s,i);
 checkCenturyFundsPayment(s,i);checkMemorialPayment(s,i);const warmup=centuryWarmupAccounts(s.configHash);
 if(warmup.includes(i.sender)||warmup.includes(i.recipient))assert((centuryWarmup(i)||terminalProgramFee(i))&&warmup.includes(i.sender)&&warmup.includes(i.recipient),'programme custody rejects ordinary history');
}
export function emptyCustody(configHash){return Object.fromEntries([...centuryRestrictedAccounts(configHash),memorialPolicy(configHash).account,...centuryWarmupAccounts(configHash)].map(a=>[a,[]]));}
export function indexedCustodyOutput(configHash,o){return o&&(amount(o.value)>0n||!centuryWarmupAccounts(configHash).includes(o.owner));}
export function custodyIndex(s){const out=emptyCustody(s.configHash),warmup=centuryWarmupAccounts(s.configHash);for(const [id,o]of Object.entries(s.money.outputs)){if(warmup.includes(o.owner)&&!s.centuryFunds?.execution&&!s.centuryWarmup)assert.fail('unadopted programme custody');if(Object.hasOwn(out,o.owner)&&indexedCustodyOutput(s.configHash,o))out[o.owner].push(id);}for(const ids of Object.values(out)){ids.sort();assert(ids.length<=64,'bounded programme output index');}for(const r of Object.values(s.money.requests)){guardCustodyRequest(s,r.intent);if(warmup.includes(r.intent.sender)||warmup.includes(r.intent.recipient))assert(s.centuryWarmup,'unadopted programme history');}return out;}
export function executionContext(s,book,money,rules,touched,parentRoot,parentHeight){
 const owned=owner=>{assert(Object.hasOwn(book.custody,owner),'only programme custody can be enumerated');const ids=new Set(book.custody[owner]);for(const [key,r]of touched)if(r.bucket==='outputs'&&(r.before?.owner===owner||r.value?.owner===owner))ids.add(key.slice(8));return [...ids].sort().map(id=>[id,money.outputs[id]]).filter(([,o])=>o?.owner===owner&&indexedCustodyOutput(s.configHash,o));};
 return {workerIds:book.workerIds,parentRoot,parentHeight,owned,activeRequests:()=>{const ids=new Set(Object.keys(rules.active));for(const [key,r]of touched)if(r.bucket==='requests')ids.add(key.slice(9));return [...ids].map(id=>money.requests[id]).filter(r=>r&&['RESERVED','SCHEDULED'].includes(r.status));}};
}
export function updateCustody(s,book,touched){for(const [key,r]of touched){if(r.bucket==='requests'&&r.value)guardCustodyRequest(s,r.value.intent);if(r.bucket==='outputs'){for(const owner of new Set([r.before?.owner,r.value?.owner]))if(Object.hasOwn(book.custody,owner)){const ids=new Set(book.custody[owner]);ids.delete(key.slice(8));if(r.value?.owner===owner&&indexedCustodyOutput(s.configHash,r.value))ids.add(key.slice(8));assert(ids.size<=64,'bounded programme output index');book.custody[owner]=[...ids].sort();}}}}
