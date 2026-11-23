import assert from 'node:assert/strict';
import {exact, hash, hex, integer, verify} from '../crypto.mjs';
import {validatorQuorum, validatorSet} from '../validator-authority.mjs';
import {developmentManager} from '../reserve-recovery.mjs';
import {ordinarySealTerms} from './ordinary-curve-seal.mjs';
import {START} from './calendar-node-emission-policy.mjs';
import {SMOOTH_EMISSION} from './smooth-emission.mjs';

import {OPERATOR_TARIFF,tariffBudget} from './operator-tariff.mjs';
import {OPEN_VALIDATOR_POLICY,OPEN_VALIDATORS,checkValidatorFactor} from './open-validator-policy.mjs';
export const LEGACY_TARIFF_RESERVE = 'PREPARE_TARIFF_NETWORK_RESERVE_V2';
export const PREPARE_CLOSED_RESERVE = 'PREPARE_OPEN_VALIDATOR_RESERVE_V3';

import {FUND_VALIDATOR_WORK,VALIDATOR_RATE} from './validator-payroll.mjs';
export const reserveMandateDomain=domain=>domain===PREPARE_CLOSED_RESERVE||domain===FUND_VALIDATOR_WORK;

// A closed book accounts for the existing service custody. Its balance cannot
// also be booked as spendable liquidity, even on days with no operator claims.
export function closedReserveTerms(s, network, domain=PREPARE_CLOSED_RESERVE) {
 if(domain===FUND_VALIDATOR_WORK){
  const fund=s.rewards?.calendarService?.closedFund;
  assert(fund?.version===PREPARE_CLOSED_RESERVE&&!fund.workRate,'A confirmed open-validator mandate with an unset tariff is required');
  assert(s.money.time<START&&!s.authority.pending&&!s.networkReserves.development.access.pending,'Stable pre-launch authority required');
  return {...ordinarySealTerms(s,network),domain,registryHash:validatorSet(s.authority.validators).hash,
   mandate:fund.mandate,programmeStart:START,operatorPayments:{...VALIDATOR_RATE}};
 }
 assert([PREPARE_CLOSED_RESERVE,LEGACY_TARIFF_RESERVE].includes(domain));
 const calendar = s.rewards?.calendarService;
 assert(calendar && !calendar.reserve && !calendar.closedFund, 'A fresh reserve mandate is required.');
 assert.equal(s.centuryFees.ordinaryCurve, SMOOTH_EMISSION);
 assert(!s.centuryFunds.mainProgramme.activation && s.money.time < START, 'Pre-launch mandate only.');
 assert.equal(calendar.nextMintDay, START);
 for (const field of ['mintedMicro', 'creditedMicro', 'heldMicro']) assert.equal(calendar[field], '0');
 assert(!s.authority.pending && !s.networkReserves.development.access.pending, 'Authority change pending.');
 const baseline = ordinarySealTerms(s, network);
 return {...baseline, domain,
  registryHash: validatorSet(s.authority.validators).hash,
  programmeStart: START, source: 'ACTUAL_NET_ORDINARY_SERVICE_ISSUANCE',
  operatorPayments: domain===PREPARE_CLOSED_RESERVE?{...OPEN_VALIDATOR_POLICY}:{...OPERATOR_TARIFF,dailyLimitMicro:String(tariffBudget)}, purchases: 'CLOSED', securedLoans: 'CLOSED',
  settlementAssets: [], saleLimitMicro: '0', loanLimitMicro: '0'};
}

export function prepareClosedReserve(s, action, config) {
 exact(action, ['type', 'certificate', 'managerConsent']);
 assert([PREPARE_CLOSED_RESERVE,LEGACY_TARIFF_RESERVE,FUND_VALIDATOR_WORK].includes(action.type));
 exact(action.certificate, ['body', 'approvals']);
 const {body, approvals} = action.certificate;
 assert.equal(hash(config), s.configHash);
 assert(!config.exchangeLab && !config.purchaseLab, 'Incompatible settlement profile.');
 assert.deepEqual(body, {...closedReserveTerms(s, config.chainId, action.type), notBefore: body.notBefore, expires: body.expires});
 integer(body.notBefore, 1);
 integer(body.expires, body.notBefore + 1);
 assert(body.expires <= START && body.expires - body.notBefore <= 7 * 86400);
 assert(body.notBefore <= s.money.time && s.money.time < body.expires, 'Reserve mandate outside its signing window.');
 assert(verify(body, action.managerConsent, developmentManager(s.networkReserves)), 'Management consent required.');
 validatorQuorum(body, approvals, s.authority.validators);
 if(action.type===FUND_VALIDATOR_WORK){
  const cal=s.rewards.calendarService;
  const workRate={...VALIDATOR_RATE,decision:hash(body),height:s.height};
  return {...s,rewards:{...s.rewards,calendarService:{...cal,closedFund:{...cal.closedFund,workRate}}}};
 }
 const closedFund = {version: action.type, mandate: hash(body), height: s.height,
  tariff:body.operatorPayments.version,committedMicro:'0'};
 return {...s, rewards: {...s.rewards, calendarService: {...s.rewards.calendarService, closedFund}}};
}

export function auditClosedReserve(calendar) {
 const record = calendar.closedFund;
 if(record.version==='PREPARE_CLOSED_NETWORK_RESERVE_V1')exact(record,['version','mandate','height']);
 else{
  const amended=record.version===PREPARE_CLOSED_RESERVE&&Object.hasOwn(record,'annualChanges');
  const expanded=record.version===PREPARE_CLOSED_RESERVE&&Object.hasOwn(record,'expansion');
  exact(record,['version','mandate','height','tariff','committedMicro',...(amended?['annualChanges']:[]),...(expanded?['expansion']:[]),...(record.workRate?['workRate']:[])]);
  if(record.version===PREPARE_CLOSED_RESERVE){
   assert.equal(record.tariff,OPEN_VALIDATORS);
   if(record.workRate){
    const {decision,height,...terms}=record.workRate;
    hex(decision);integer(height,record.height);assert.deepEqual(terms,VALIDATOR_RATE);
   }else assert.equal(record.committedMicro,'0');
   if(!record.workRate)assert.equal(calendar.creditedMicro,'0');
   if(expanded){
    exact(record.expansion,['target','decision']);hex(record.expansion.decision);
    integer(record.expansion.target,OPEN_VALIDATOR_POLICY.firstTarget+1);assert(record.expansion.target<=OPEN_VALIDATOR_POLICY.maximumActive);
   }
   if(amended){
    assert(Array.isArray(record.annualChanges)&&record.annualChanges.length>0&&record.annualChanges.length<=95);
    let previous=2031;
    for(const c of record.annualChanges){
     exact(c,['year','factorBps','decision']);checkValidatorFactor(c.year,c.factorBps);hex(c.decision);
     assert(c.year>previous);previous=c.year;
    }
   }
  }else{
   assert.equal(record.version,LEGACY_TARIFF_RESERVE);assert.equal(record.tariff,OPERATOR_TARIFF.version);
  }
  assert(typeof record.committedMicro==='string'&&/^(0|[1-9][0-9]*)$/.test(record.committedMicro));
  assert(BigInt(record.committedMicro)<=BigInt(calendar.heldMicro),'Unfunded work commitment.');
 }
 hex(record.mandate);
 integer(record.height, 1);
 assert(!calendar.reserve, 'Conflicting reserve programmes.');
}
