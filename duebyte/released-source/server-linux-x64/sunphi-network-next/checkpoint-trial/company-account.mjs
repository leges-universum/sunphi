import assert from 'node:assert/strict';
import {exact,hex,integer,publicKey} from './crypto.mjs';

export const COMPANY_MANDATE='SET_COMPANY_PAYMENT_MANDATE_V1';
export function validateCompanyAccounts(config){
 assert(config.trialOnly===true&&config.chainId==='duebyte-trial-company-invoices','Corporate accounts require the company qualification network.');
 const entries=Object.entries(config.companyAccounts);
 assert(entries.length>0&&entries.length<=64);
 for(const [account,registration] of entries){
  publicKey(account);exact(registration,['companyHash','issuer']);hex(registration.companyHash);publicKey(registration.issuer);
  assert.notEqual(account,registration.issuer,'Independent mandate issuer required.');
 }
}
function validateMandate(m){
 exact(m,['revision','holder','active','limitMicro','expires']);
 integer(m.revision,1);publicKey(m.holder);integer(m.expires,1);
 assert(typeof m.active==='boolean'&&typeof m.limitMicro==='string'&&/^[1-9][0-9]{0,18}$/.test(m.limitMicro),'Invalid mandate.');
}
export function auditCompanyMandates(s,config){
 for(const [account,mandate] of Object.entries(s.companyMandates??{})){
  assert(Object.hasOwn(config.companyAccounts??{},account));validateMandate(mandate);
 }
}
export function updateCompanyMandate(s,config,action,author){
 exact(action,['type','account','mandate']);const {account,mandate}=action;
 assert.equal(config.companyAccounts?.[account]?.issuer,author,'Registered company issuer required.');
 validateMandate(mandate);
 assert.equal(mandate.revision,(s.companyMandates?.[account]?.revision??0)+1,'Mandate revision must increase by one.');
 if(mandate.active)assert(mandate.expires>s.money.time,'New mandate already expired.');
 return {...s,companyMandates:{...s.companyMandates,[account]:mandate}};
}
export function checkCompanyPayment(s,config,intent,author){
 if(!Object.hasOwn(config.companyAccounts??{},intent.sender)){
  assert(!Object.hasOwn(intent,'companyRevision'),'Unexpected corporate mandate.');return;
 }
 const registration=s.companyRegistry?.accounts[intent.sender];
 if(registration)assert(registration.decision===s.companyRegistry.decision&&s.companyRegistry.key,'Corporate registrar authorization changed.');
 const mandate=s.companyMandates?.[intent.sender];
 assert(mandate?.active,'Company payment authority is inactive.');
 assert(s.money.time<mandate.expires,'Company payment authority has expired.');
 assert.equal(intent.companyRevision,mandate.revision,'Company mandate revision changed.');
 assert.equal(author,mandate.holder,'Authorized company representative required.');
 assert(intent.unitScale==='1000000'&&!intent.sendDelay,'Company mandate covers immediate native payments only.');
 assert(BigInt(intent.value)+BigInt(intent.fee)<=BigInt(mandate.limitMicro),'Total debit exceeds the company payment limit.');
}
export function checkCompanyAction(s,config,action,author){
 if(['RESERVE','SCHEDULE_PAYMENT_V1'].includes(action.type))checkCompanyPayment(s,config,action.signed.intent,author);
 if(action.type==='FINALIZE'&&config.companyAccounts){
  const request=s.money.requests[action.pid],intent=request?.intent;
  if(request?.status==='RESERVED'&&Object.hasOwn(config.companyAccounts,intent.sender)){
   // The reservation authenticated the representative. A worker may relay finalization.
   checkCompanyPayment(s,config,intent,s.companyMandates?.[intent.sender]?.holder);
  }
 }
}
export function guardCompanyOutput(config,action,before,after){
 if(!before||!Object.hasOwn(config.companyAccounts,before.owner))return;
 if(after&&after.owner===before.owner&&after.value===before.value&&after.unlock===before.unlock)return;
 assert(action?.type==='RESERVE'&&action.signed.intent.sender===before.owner,'Corporate outputs require an authorized native payment.');
}
