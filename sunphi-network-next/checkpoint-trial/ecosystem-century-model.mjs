// Offline economic proposal only. No live ledger, signing, minting or networking.
// Monetary values are exact micro-DUBYT. Calendar uses mean Gregorian years
// for comparisons only; a dated consensus calendar is still a launch decision.
export const UNIT = 1000000n;
export const YEAR = 31556952;
const token = n => BigInt(n) * UNIT;
export const CAP = token(10000000000);
export const WARMUP = token(10000000);
export const DEVELOPMENT = token(100000000);
export const FOUNDER = token(10000000);
export const DECADES = Object.freeze([
  2000000000, 1600000000, 1400000000, 1200000000, 1000000000,
  800000000, 700000000, 550000000, 450000000, 300000000
].map(token));
function valid(ok, message) { if (!ok) throw new Error(message); }
function time(t) { valid(Number.isSafeInteger(t) && t >= 0, 'Nonnegative integer time required'); }
function amount(n) { valid(typeof n === 'bigint' && n >= 0n, 'Nonnegative exact amount required'); }
export function allocation(existing = token(2000)) {
  amount(existing);
  const fixed = WARMUP + DEVELOPMENT + FOUNDER;
  valid(existing + fixed <= DECADES[0] * 6n / 10n, 'First-decade early budget exceeded');
  return { cap: CAP, existing, warmup: WARMUP, development: DEVELOPMENT,
    founder: FOUNDER, fixed, regular: CAP - existing - fixed };
}
export function annualRegularCeilings(existing = token(2000)) {
  const a = allocation(existing), result = [];
  DECADES.forEach((budget, decade) => {
    const early = budget * 6n / 10n - (decade === 0 ? a.fixed + existing : 0n);
    for (let k = 0n; k < 8n; k++) {
      // Difference of cumulative fractions preserves every micro-unit.
      result.push(early * (k + 1n) / 8n - early * k / 8n);
    }
    result.push(budget / 5n, budget / 5n);
  });
  return result;
}
export function cumulativeRegular(seconds, existing) {
  time(seconds);
  const annual = annualRegularCeilings(existing);
  const complete = Math.min(100, Math.floor(seconds / YEAR));
  let sum = annual.slice(0, complete).reduce((a, b) => a + b, 0n);
  if (complete < 100) sum += annual[complete] * BigInt(seconds % YEAR) / BigInt(YEAR);
  return sum;
}
export function regularAllowance(start, end, existing) {
  time(start); time(end); valid(end >= start, 'Invalid time interval');
  return cumulativeRegular(end, existing) - cumulativeRegular(start, existing);
}
// C(t) = 10M * (17*t - t*t) / 60, t in years, bounded at five years.
// The rate declines continuously; C(2)=5M and C(5)=10M.
export function cumulativeWarmup(seconds) {
  time(seconds);
  const y = BigInt(YEAR), t = BigInt(Math.min(seconds, 5 * YEAR));
  return WARMUP * t * (17n * y - t) / (60n * y * y);
}
export function warmupAllowance(start, end) {
  time(start); time(end); valid(end >= start, 'Invalid time interval');
  return cumulativeWarmup(end) - cumulativeWarmup(start);
}
export function warmupFeeLimit({ start, end, remaining, certifiedFeeCapacity, healthy }) {
  amount(remaining); amount(certifiedFeeCapacity);
  valid(remaining <= WARMUP, 'Warmup remaining exceeds original allocation');
  valid(typeof healthy === 'boolean', 'Explicit health state required');
  const calendar = warmupAllowance(start, end);
  if (!healthy) return 0n;
  return [calendar, remaining, certifiedFeeCapacity].reduce((a, b) => a < b ? a : b);
}
// Allocation/mint at launch is separate from access. First unlock at anniversary1.
export function vested(seconds, kind) {
  time(seconds);
  valid(kind === 'development' || kind === 'founder', 'Unknown vesting reserve');
  const budget = kind === 'development' ? DEVELOPMENT : FOUNDER;
  return budget * BigInt(Math.min(10, Math.floor(seconds / YEAR))) / 10n;
}
export const tokens = n => Number(n) / Number(UNIT); // Presentation only.
