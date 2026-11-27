import assert from 'node:assert/strict';
import {DAY,START} from './calendar-node-emission-policy.mjs';
import {validatorFactorBps} from './open-validator-policy.mjs';
import {consensusAddress} from '../consensus-context.mjs';
import {signingKey} from './bounded-pos-records.mjs';

export const FUND_VALIDATOR_WORK='FUND_VALIDATOR_WORK_V1';
export const VALIDATOR_RATE=Object.freeze({base30DaysMicro:'890000000',budgetBps:100,effectiveFrom:START,
 eligible:'ACTIVE_BONDED_SERVERS_AT_UTC_DAY_OPEN',proof:'ACCEPTED_BASELINE_SERVICE_INTERVAL',
 funding:'NET_UTC_DAY_ISSUANCE',shortfall:'EQUAL_DAILY_LIMIT_PER_ASSIGNED_SERVER',rounding:'FLOOR_PER_NODE_PER_DAY'});

// Freeze the assignment and per-node limit before accepting the first proof.
export function validatorPayroll(s,get,day,issuance){
 const fund=s.rewards?.calendarService?.closedFund;
 const bonded=s.authority.posSlashing;
 if(!fund?.workRate||day<fund.workRate.effectiveFrom||!bonded?.activation||s.height<bonded.activation)return null;
 const nodes=new Set();
 for(const member of bonded.voting?.validators??[]){
  const record=get(signingKey(consensusAddress(member.key)));
  if(record&&!record.signing.jailed&&!record.signing.tombstoned&&BigInt(record.signing.bond)>=BigInt(s.authority.bondedAdmission?.minimumMicro??'100000000')&&s.rewards.nodes[record.node]?.kind==='worker')nodes.add(record.node);
 }
 if(!nodes.size)return null;
 const factorBps=validatorFactorBps(day,fund.annualChanges);
 const nominal=BigInt(VALIDATOR_RATE.base30DaysMicro)*BigInt(factorBps)/300000n;
 const cap=BigInt(issuance)*BigInt(VALIDATOR_RATE.budgetBps)/10000n/BigInt(nodes.size);
 const daily=cap<nominal?cap:nominal;
 if(daily*3600n<BigInt(DAY))return null;
 return {funding:'DAY_ISSUANCE',budgetMicro:String(daily*BigInt(nodes.size)),worker:0,witness:0,jobs:0,
  nodes:[...nodes].sort(),dailyMicro:String(daily),factorBps,decision:fund.workRate.decision};
}

export function validatorEarned(payroll,intervals,seconds){
 assert(Number.isSafeInteger(intervals)&&intervals>=0&&Number.isSafeInteger(seconds)&&seconds>0&&intervals*seconds<=DAY);
 return BigInt(payroll.dailyMicro)*BigInt(intervals*seconds)/BigInt(DAY);
}
