// Approved pre-issuance policy. Pure deterministic planner; never signs or mints.
// Existing ledger amounts are explicitly converted for the plan, never rewritten.
import assert from 'node:assert/strict';
import { hash, exact } from './crypto.mjs';
import { quorum } from './authority.mjs';
import {controllerContext} from './controller-context.mjs';
import { UNIT, CAP, WARMUP, DEVELOPMENT, FOUNDER, DECADES,
  allocation, annualRegularCeilings } from './ecosystem-century-model.mjs';
export const ECONOMIC_POLICY_VERSION = 'DUEBYTE_ECONOMY_10B_CENTURY_V2';
const min = (...xs) => xs.reduce((a, b) => a < b ? a : b);
const amount = n => { assert(typeof n === 'string' && /^(0|[1-9][0-9]*)$/.test(n), 'canonical amount'); return BigInt(n); };
const time = n => assert(Number.isSafeInteger(n) && n >= 0 && n <= 8000000000000, 'UTC integer seconds');
export function anniversary(start, years) {
  time(start); assert(Number.isInteger(years) && years >= 0 && years <= 100);
  const d = new Date(start * 1000), month = d.getUTCMonth();
  d.setUTCFullYear(d.getUTCFullYear() + years);
  if (d.getUTCMonth() !== month) d.setUTCDate(0);
  const result = d.getTime() / 1000; time(result); return result;
}
export function makeEconomicPlan(state) {
  assert(state && !state.rewards && !state.authority?.nodeRewards, 'reward activation must remain off');
  assert(!state.launchFund, 'legacy launch requires separate migration');
  const r = state.networkReserves;
  assert(r && !r.issued && r.warmup.mode === 'PAUSED' && r.development.mode === 'PAUSED', 'unissued paused reserves');
  assert(!r.warmup.pending && !r.development.pending, 'pending reserve operation');
  const scale = state.money.unitScale ?? '1';
  assert(scale === '1' || scale === String(UNIT), 'unsupported denomination');
  const existing = amount(state.money.supply) * (UNIT / BigInt(scale));
  const a = allocation(existing);
  return {
    version: ECONOMIC_POLICY_VERSION, networkConfigHash: state.configHash,
    observedHeight: controllerContext(state)?.parentHeight??state.height, observedStateHash: controllerContext(state)?.parentRoot??hash(state), decimals: 6,
    existingSupplyMicro: String(existing), capMicro: String(CAP), regularMicro: String(a.regular),
    warmupMicro: String(WARMUP), developmentMicro: String(DEVELOPMENT), founderMicro: String(FOUNDER),
    decadeMicro: DECADES.map(String), annualRegularMicro: annualRegularCeilings(existing).map(String),
    emissionStart: null, warmupStart: null, issuanceEnabled: false, warmupEnabled: false,
    firstVestingAnniversary: 1, vestingYears: 10, warmupYears: 5,
    renewalEvidenceRequired: true, unusedOrdinary: 'UNISSUED_NO_CATCHUP',
    unusedWarmup: 'LOCKED_AFTER_YEAR_FIVE', preservedBalances: true,
    status: 'PREPARED_REQUIRES_PROTOCOL_MIGRATION_AND_EXPLICIT_ACTIVATION'
  };
}
function phase(start, at, horizon) {
  time(start); time(at);
  if (at <= start) return { year: 0, numerator: 0n, denominator: 1n };
  for (let year = 0; year < horizon; year++) {
    const left = anniversary(start, year), right = anniversary(start, year + 1);
    if (at < right) return { year, numerator: BigInt(at - left), denominator: BigInt(right - left) };
  }
  return { year: horizon, numerator: 0n, denominator: 1n };
}
export function datedCumulative({ start, at, existingSupplyMicro, kind }) {
  assert(['regular', 'renewal', 'warmup', 'development', 'founder'].includes(kind), 'calendar kind');
  const horizon = kind === 'warmup' ? 5 : ['development', 'founder'].includes(kind) ? 10 : 100;
  const p = phase(start, at, horizon);
  if (kind === 'warmup') {
    const t = BigInt(p.year) * p.denominator + p.numerator, d = p.denominator;
    return String(WARMUP * t * (17n * d - t) / (60n * d * d));
  }
  if (kind === 'development' || kind === 'founder') {
    return String((kind === 'development' ? DEVELOPMENT : FOUNDER) * BigInt(p.year) / 10n);
  }
  const annual = annualRegularCeilings(amount(existingSupplyMicro));
  const series = kind === 'renewal' ? annual.map((_, i) => i % 10 >= 8 ? DECADES[Math.floor(i / 10)] / 8n : 0n) : annual;
  let total = series.slice(0, p.year).reduce((a, b) => a + b, 0n);
  if (p.year < horizon) total += series[p.year] * p.numerator / p.denominator;
  return String(total);
}
export function datedAllowance({ start, from, to, existingSupplyMicro, kind }) {
  time(from); time(to); assert(to >= from, 'interval order');
  return String(BigInt(datedCumulative({ start, at: to, existingSupplyMicro, kind })) -
    BigInt(datedCumulative({ start, at: from, existingSupplyMicro, kind })));
}
// Already-paid fees reduce the subsidy gap. Renewal and ordinary work are disjoint
// accounting categories; callers must supply independently accepted service claims.
export function emissionBudget({ calendar, supplyMicro, futureFixedReservedMicro,
  lifetimeRemainingMicro, operationalCapMicro, ordinaryCostMicro, ordinaryFeesMicro,
  renewalCostMicro, renewalFeesMicro, renewalQualified }) {
  const total = amount(datedAllowance({ ...calendar, kind: 'regular' }));
  const renewal = amount(datedAllowance({ ...calendar, kind: 'renewal' }));
  const ordinary = total - renewal;
  const gap = (cost, fees) => { const c = amount(cost), f = amount(fees); return c > f ? c - f : 0n; };
  assert(typeof renewalQualified === 'boolean');
  const normal = min(ordinary, gap(ordinaryCostMicro, ordinaryFeesMicro));
  const upgrade = renewalQualified ? min(renewal, gap(renewalCostMicro, renewalFeesMicro)) : 0n;
  const remaining = CAP - amount(supplyMicro) - amount(futureFixedReservedMicro);
  assert(remaining >= 0n, 'overcommitted lifetime cap');
  return { maximumMicro: String(min(normal + upgrade, remaining,
    amount(lifetimeRemainingMicro), amount(operationalCapMicro))),
    ordinaryCeilingMicro: String(ordinary), renewalCeilingMicro: String(renewal),
    calendarCeilingMicro: String(total), issuanceEnabled: false };
}
// A consumption cursor is needed even while rehearsing: replaying an interval
// must not multiply its budget. This state is separate from the production ledger.
export function initialWarmupController(start, observedHeight) {
  time(start); assert(Number.isSafeInteger(observedHeight) && observedHeight >= 0);
  return { version: ECONOMIC_POLICY_VERSION, start, cursor: start, sequence: 0,
    lastMeasurementHeight: observedHeight, spentMicro: '0', reservedMicro: '0',
    previousRateMicroPerSecond: '0', pending: null, lastSettlement: null };
}
export function planWarmupInterval(base, input) {
  const { from, to, observedHeight, observedAt, sequence, healthy, capacityRateMicroPerSecond,
    maximumRiseMicroPerSecond, operationalRateMicroPerSecond } = input;
  time(from); time(to); time(observedAt);
  assert((input.allowSkippedIntervals===true?from>=base.cursor:from===base.cursor) && to > from && to - from <= 86400, 'contiguous bounded interval');
  assert(sequence === base.sequence + 1 && !base.pending, 'sequence or unsettled interval');
  assert(Number.isSafeInteger(observedHeight) && observedHeight > base.lastMeasurementHeight, 'new certified observation required');
  assert(observedAt <= from && from - observedAt <= 300, 'stale or future observation');
  assert(typeof healthy === 'boolean');
  const capacity = amount(capacityRateMicroPerSecond), cap = amount(operationalRateMicroPerSecond);
  const rate = healthy ? min(capacity, cap, amount(base.previousRateMicroPerSecond) + amount(maximumRiseMicroPerSecond)) : 0n;
  const calendar = amount(datedAllowance({ start: base.start, from, to, kind: 'warmup' }));
  const remaining = WARMUP - amount(base.spentMicro) - amount(base.reservedMicro);
  assert(remaining >= 0n);
  const budget = min(calendar, remaining, rate * BigInt(to - from));
  const next = structuredClone(base);
  Object.assign(next, { cursor: to, sequence, lastMeasurementHeight: observedHeight,
    previousRateMicroPerSecond: String(rate), reservedMicro: String(budget),
    pending: { sequence, from, to, budgetMicro: String(budget) } });
  return next;
}
export function settleWarmupInterval(base, sequence, actualFeeMicro) {
  const spent = amount(actualFeeMicro);
  if (!base.pending && base.lastSettlement?.sequence === sequence) {
    assert.equal(base.lastSettlement.actualFeeMicro, actualFeeMicro, 'conflicting replay'); return base;
  }
  assert(base.pending?.sequence === sequence && spent <= amount(base.pending.budgetMicro), 'unreserved fee spending');
  const next = structuredClone(base);
  next.spentMicro = String(amount(base.spentMicro) + spent); next.reservedMicro = '0';
  next.pending = null; next.lastSettlement = { sequence, actualFeeMicro };
  return next;
}
// Bridge for certified measurements. Quorum authenticates the agreed observation;
// it does not by itself prove CPU work. The measurement service must be qualified.
export function certifiedWarmupInterval(base, certificate, context) {
  exact(certificate,['body','approvals']);const b=certificate.body;
  exact(b,['domain','configHash','generation','start','from','to','observedHeight',
    'observedAt','sequence','healthy','capacityRateMicroPerSecond','controllerPolicyHash']);
  assert.equal(b.domain,'DUEBYTE_WARMUP_CAPACITY_V2');
  assert.equal(b.configHash,context.configHash);assert.equal(b.generation,context.generation);
  assert.equal(b.start,base.start);assert.equal(b.controllerPolicyHash,hash(context.controllerPolicy));
  assert(Number.isSafeInteger(context.height)&&b.observedHeight<=context.height,'future measurement height');
  quorum(b,certificate.approvals,context.validators,7);
  exact(context.controllerPolicy,['maximumRiseMicroPerSecond','operationalRateMicroPerSecond',...(context.allowSkippedIntervals===true?['intervalSeconds']:[])]);
  if(context.allowSkippedIntervals===true)assert.equal(b.to-b.from,context.controllerPolicy.intervalSeconds,'fixed UTC capacity interval');
  return planWarmupInterval(base,{from:b.from,to:b.to,observedHeight:b.observedHeight,
    observedAt:b.observedAt,sequence:b.sequence,healthy:b.healthy,
    capacityRateMicroPerSecond:b.capacityRateMicroPerSecond,...context.controllerPolicy,allowSkippedIntervals:context.allowSkippedIntervals===true});
}
