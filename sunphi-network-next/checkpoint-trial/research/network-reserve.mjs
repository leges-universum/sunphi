import assert from 'node:assert/strict';
import {amount} from '../payment-model.mjs';
import {DAY, START, END} from './calendar-node-emission-policy.mjs';
import {hasOperatorTariff,OPERATOR_TARIFF,tariffBudget} from './operator-tariff.mjs';
import {openValidatorsActive} from './open-validator-policy.mjs';

export const RESERVE_TRIAL = 'duebyte-trial-exchange-lab-network-reserve-v1';
export const RESERVE_VERSION = 'DUEBYTE_NETWORK_RESERVE_TEST_V1';
const dailyBudget = 100_000_000n;
const continuity = 1_320_000_000n;
const forwardBudget = 30n * dailyBudget;
const tariffs = {worker: BigInt(OPERATOR_TARIFF.workerDayMicro), witness: BigInt(OPERATOR_TARIFF.witnessDayMicro)};
const slots = {worker: 10, witness: 4};

export function prepareTrialReserve(calendar, config) {
 if (config.trialOnly === true && config.chainId === RESERVE_TRIAL) {
  assert.equal(calendar.mintedMicro, '0');
  calendar.reserve = {version: RESERVE_VERSION, committedMicro: '0', marketInMicro: '0', marketOutMicro: '0'};
  if(config.exchangeLab?.policy.reserve?.credit)calendar.reserve.credit={drawn:'0',repaid:'0',riskHeld:'0'};
  if(calendar.reserve.credit&&config.exchangeLab.policy.reserve.portfolio)Object.assign(calendar.reserve.credit,{capitalFunded:'0',capitalAvailable:'0',capitalUsed:'0',interestWaived:'0'});
 }
}

export function reserveStatement(calendar) {
 if (calendar?.closedFund) {
  return {mode:'CLOSED', preparedHeight:calendar.closedFund.height, issuedMicro:calendar.mintedMicro,
   operatorCreditsMicro:calendar.creditedMicro, balanceMicro:calendar.heldMicro, surplusMicro:'0',
   ...(hasOperatorTariff(calendar)||openValidatorsActive(calendar)?{committedMicro:calendar.closedFund.committedMicro,
    retainedMicro:String(amount(calendar.heldMicro)-amount(calendar.closedFund.committedMicro))}:{})};
 }
 if (!calendar?.reserve) return null;
 assert.equal(calendar.reserve.version, RESERVE_VERSION);
 const held = amount(calendar.heldMicro), committed = amount(calendar.reserve.committedMicro);
 assert(committed <= held, 'unfunded operator commitments');
 const risk=amount(calendar.reserve.credit?.riskHeld??'0')+amount(calendar.reserve.credit?.capitalAvailable??'0');
 assert(committed+risk<=held,'unfunded reserve obligations');
 const target = committed + forwardBudget + continuity + risk;
 return {version: RESERVE_VERSION, issuedMicro: calendar.mintedMicro, operatorCreditsMicro: calendar.creditedMicro,
  marketInMicro: calendar.reserve.marketInMicro, marketOutMicro: calendar.reserve.marketOutMicro,
  balanceMicro: calendar.heldMicro, committedMicro: String(committed), forwardTargetMicro: String(forwardBudget),
  continuityTargetMicro: String(continuity), ...(calendar.reserve.credit?{credit:structuredClone(calendar.reserve.credit)}:{}),surplusMicro: String(held > target ? held - target : 0n)};
}

export function isReserveDay(s, day) {
 const calendar=s.rewards?.calendarService;
 return Boolean(calendar?.reserve||hasOperatorTariff(calendar)||openValidatorsActive(calendar)) && day >= START && day < END;
}

export function openPayroll(calendar,dayIssuance='0') {
 if(openValidatorsActive(calendar))return null; // No funded assignments before a separate rate and budget decision.
 if(hasOperatorTariff(calendar)){
  const fund=calendar.closedFund,free=amount(calendar.heldMicro)-amount(fund.committedMicro);
  const funded=free>=tariffBudget;
  if(!funded&&amount(dayIssuance)<tariffBudget)return null;
  if(funded)fund.committedMicro=String(amount(fund.committedMicro)+tariffBudget);
  return {budgetMicro:String(tariffBudget),funding:funded?'RESERVE':'DAY_ISSUANCE',worker:0,witness:0,jobs:0};
 }
 const uncommitted = amount(calendar.heldMicro) - amount(calendar.reserve.committedMicro)-amount(calendar.reserve.credit?.riskHeld??'0')-amount(calendar.reserve.credit?.capitalAvailable??'0');
 if (uncommitted < continuity + dailyBudget) return null;
 calendar.reserve.committedMicro = String(amount(calendar.reserve.committedMicro) + dailyBudget);
 return {budgetMicro: String(dailyBudget), worker: 0, witness: 0, jobs: 0};
}

export function releasePayroll(calendar, value) {
 const ledger=hasOperatorTariff(calendar)?calendar.closedFund:calendar.reserve;
 const held = amount(ledger.committedMicro);
 assert(value >= 0n && value <= held, 'invalid payroll release');
 ledger.committedMicro = String(held - value);
}

export function tariffMicro(kind, intervals, jobs, intervalSeconds) {
 assert(Object.hasOwn(tariffs, kind) && Number.isSafeInteger(intervals) && intervals >= 0);
 assert(Number.isSafeInteger(jobs) && jobs >= 0 && jobs <= 280);
 assert(Number.isSafeInteger(intervalSeconds) && intervalSeconds > 0 && intervals * intervalSeconds <= DAY);
 return tariffs[kind] * BigInt(intervals * intervalSeconds) / BigInt(DAY) + BigInt(jobs) * 200_000n;
}

// Each accepted service sample qualifies its scheduled interval at the test tariff.
// A settled customer job can pay each distinct participating worker once.
export function reserveWork(payroll, previous, kind, job, intervalSeconds) {
 if (!payroll) return null;
 if (job && (payroll.funding || payroll.jobs >= 280)) return null;
 const intervals = previous?.intervals ?? 0, jobs = previous?.jobs ?? 0;
 const capacity=payroll.funding?(kind==='worker'?OPERATOR_TARIFF.workerSlots:OPERATOR_TARIFF.witnessSlots):slots[kind];
 if (!job && !intervals && payroll[kind] >= capacity) return null;
 const next = {intervals: intervals + Number(!job), jobs: jobs + Number(job)};
 const value = tariffMicro(kind, next.intervals, next.jobs, intervalSeconds);
 if (job) payroll.jobs++;
 else if (!intervals) payroll[kind]++;
 return {...next, units: String(value)};
}
