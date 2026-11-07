import test from 'node:test';
import assert from 'node:assert/strict';
import { UNIT, YEAR, CAP, WARMUP, DEVELOPMENT, FOUNDER, DECADES, allocation,
  annualRegularCeilings, cumulativeRegular, regularAllowance, cumulativeWarmup,
  warmupAllowance, warmupFeeLimit, vested } from '../ecosystem-century-model.mjs';
const sum = a => a.reduce((x, y) => x + y, 0n);
test('all funds and existing supply fit within the cap exactly', () => {
  const a = allocation();
  assert.equal(a.regular, 9879998000n * UNIT);
  assert.equal(a.regular + a.existing + a.fixed, CAP);
  assert.equal(sum(DECADES), CAP);
  assert.equal(sum(annualRegularCeilings()), a.regular);
});
test('first-decade total includes funds; exactly 40% reserved for final two years', () => {
  const a = allocation(), years = annualRegularCeilings();
  for (let d = 0; d < 10; d++) {
    const fixed = d === 0 ? a.fixed + a.existing : 0n;
    assert.equal(sum(years.slice(d * 10, d * 10 + 10)) + fixed, DECADES[d]);
    assert.equal(sum(years.slice(d * 10 + 8, d * 10 + 10)), DECADES[d] * 4n / 10n);
  }
  assert.equal(years[0], 134999750n * UNIT);
  assert.equal(years[8], 400000000n * UNIT);
});
test('fractional existing balances retained; allocations rounded without loss', () => {
  const existing = 2000n * UNIT + 1n, years = annualRegularCeilings(existing);
  assert.equal(sum(years) + allocation(existing).fixed + existing, CAP);
  assert.equal(cumulativeRegular(100 * YEAR, existing), allocation(existing).regular);
});
test('regular horizon and interval additivity preserve exact amounts', () => {
  assert.equal(cumulativeRegular(0), 0n);
  assert.equal(cumulativeRegular(101 * YEAR), allocation().regular);
  for (let i = 0; i < 100; i++) {
    const a = i * YEAR, b = a + 12345, c = (i + 1) * YEAR;
    assert.equal(regularAllowance(a, b) + regularAllowance(b, c), regularAllowance(a, c));
    assert.ok(cumulativeRegular(c) >= cumulativeRegular(b));
  }
});
test('warmup spends half in two years and all budget in five, never more', () => {
  assert.equal(cumulativeWarmup(0), 0n);
  assert.equal(cumulativeWarmup(2 * YEAR), WARMUP / 2n);
  assert.equal(cumulativeWarmup(5 * YEAR), WARMUP);
  assert.equal(cumulativeWarmup(100 * YEAR), WARMUP);
  const annual = Array.from({ length: 5 }, (_, i) => warmupAllowance(i * YEAR, (i + 1) * YEAR));
  assert.equal(sum(annual), WARMUP);
  for (let i = 1; i < 5; i++) assert.ok(annual[i] < annual[i - 1]);
  assert.equal(warmupAllowance(5 * YEAR, 6 * YEAR), 0n);
});
test('warmup budget is continuous and partition independent at year two', () => {
  const a = 2 * YEAR - 1, b = 2 * YEAR, c = b + 1;
  assert.equal(warmupAllowance(a, b) + warmupAllowance(b, c), warmupAllowance(a, c));
  assert.ok(warmupAllowance(a, b) - warmupAllowance(b, c) <= 1n);
});
test('no recovery burst, health failure payout or spending beyond capacity and balance', () => {
  const args = { start: YEAR, end: YEAR + 86400, remaining: WARMUP,
    certifiedFeeCapacity: WARMUP, healthy: true };
  const day = warmupAllowance(args.start, args.end);
  assert.equal(warmupFeeLimit(args), day);
  assert.equal(warmupFeeLimit({ ...args, healthy: false }), 0n);
  assert.equal(warmupFeeLimit({ ...args, certifiedFeeCapacity: 7n }), 7n);
  assert.equal(warmupFeeLimit({ ...args, remaining: 3n }), 3n);
  assert.equal(warmupFeeLimit({ ...args, start: 5 * YEAR, end: 6 * YEAR }), 0n);
});
test('vesting unlocks at anniversaries without creating additional supply', () => {
  for (const [kind, total] of [['development', DEVELOPMENT], ['founder', FOUNDER]]) {
    assert.equal(vested(YEAR - 1, kind), 0n);
    assert.equal(vested(YEAR, kind), total / 10n);
    assert.equal(vested(5 * YEAR, kind), total / 2n);
    assert.equal(vested(10 * YEAR, kind), total);
    assert.equal(vested(100 * YEAR, kind), total);
  }
});
test('reject invalid dates, amounts and reserve selectors', () => {
  assert.throws(() => allocation(-1n));
  assert.throws(() => allocation(CAP));
  assert.throws(() => cumulativeWarmup(-1));
  assert.throws(() => cumulativeRegular(0.5));
  assert.throws(() => warmupAllowance(YEAR, 0));
  assert.throws(() => vested(0, 'other'));
  assert.throws(() => warmupFeeLimit({ start: 0, end: YEAR, remaining: WARMUP + 1n,
    certifiedFeeCapacity: 1n, healthy: true }));
});
