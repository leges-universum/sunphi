import {MAX_ACTIVE_VALIDATORS} from '../validator-authority.mjs';
import assert from 'node:assert/strict';
import {exact,hash,hex,integer} from '../crypto.mjs';

export const OPEN_VALIDATORS='DUEBYTE_OPEN_VALIDATORS_V1';
export const OPEN_VALIDATOR_POLICY=Object.freeze({
 version:OPEN_VALIDATORS, firstTarget:31, maximumActive:MAX_ACTIVE_VALIDATORS,
 rotation:'OLDEST_ACTIVE_FIRST', programmeYear:2027,
 multiplierHalves:Object.freeze([12,10,8,6,4]), continuingHalves:3,
 baseRateMicro:null, validatorBudgetMicro:null
});

export const openValidatorsActive=calendar=>calendar?.closedFund?.tariff===OPEN_VALIDATORS;

export const CHANGE_VALIDATOR_FACTOR='SCHEDULE_VALIDATOR_WORK_FACTOR_V1';
export const EXPAND_VALIDATOR_SET='EXPAND_OPEN_VALIDATOR_SET_V1';

export function checkExpansion(terms){
 exact(terms,['mandate','previous','target']);hex(terms.mandate);
 integer(terms.previous,OPEN_VALIDATOR_POLICY.firstTarget);integer(terms.target,terms.previous+1);
 assert(terms.target<=MAX_ACTIVE_VALIDATORS,'Active validator ceiling exceeded');
}

export function expandValidatorSet(s,terms,decision){
 checkExpansion(terms);
 const calendar=s.rewards?.calendarService;
 assert(openValidatorsActive(calendar),'Open validator policy is required');
 const fund=calendar.closedFund;
 assert.equal(terms.mandate,fund.mandate);
 assert.equal(terms.previous,fund.expansion?.target??OPEN_VALIDATOR_POLICY.firstTarget,'Active target changed');
 fund.expansion={target:terms.target,decision:hex(decision)};
 return s;
}

export function validatorFactorBps(serviceTime,changes=[]){
 const year=new Date(serviceTime*1000).getUTCFullYear();
 if(!Number.isSafeInteger(serviceTime)||!Number.isInteger(year))throw new RangeError('Invalid service time');
 const index=year-OPEN_VALIDATOR_POLICY.programmeYear;
 if(index<0)return null;
 const approved=changes.findLast(change=>change.year<=year);
 return approved?.factorBps??5000*(OPEN_VALIDATOR_POLICY.multiplierHalves[index]??OPEN_VALIDATOR_POLICY.continuingHalves);
}

export function checkValidatorFactor(year,factorBps){
 integer(year,2032);assert(year<=2126,'Outside the ordinary issuance programme');
 integer(factorBps,1);
}

export function scheduleValidatorFactor(s,terms,decision){
 const calendar=s.rewards?.calendarService;
 assert(openValidatorsActive(calendar),'Open validator policy is required');
 const fund=calendar.closedFund,changes=fund.annualChanges??[];
 exact(terms,['previous','year','factorBps']);checkValidatorFactor(terms.year,terms.factorBps);
 assert.equal(terms.previous,hash({mandate:fund.mandate,changes}),'Validator policy changed');
 assert(Date.UTC(terms.year,0,1)/1000>s.money.time,'Prospective calendar year required');
 // One value per year. A later vote can replace a future value until it takes effect.
 const next=changes.filter(c=>c.year!==terms.year);
 next.push({year:terms.year,factorBps:terms.factorBps,decision:hex(decision)});
 fund.annualChanges=next.sort((a,b)=>a.year-b.year);
 return s;
}
