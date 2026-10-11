import test from 'node:test';
import assert from 'node:assert/strict';
import { logFragmentFailure, fragmentFailureLabel, reconstructionThreshold, attackEconomics } from './research-math.mjs';

test('binomial tail agrees with exhaustive independent failure states', () => {
  for (let n = 1; n <= 8; n++) for (let k = 1; k <= n; k++) for (const q of [0.1, 0.5, 0.8]) {
    let reference = 0;
    for (let mask = 0; mask < 2 ** n; mask++) {
      const successes = mask.toString(2).replaceAll('0', '').length;
      if (successes < k) reference += q ** successes * (1 - q) ** (n - successes);
    }
    assert.ok(Math.abs(Math.exp(logFragmentFailure(n, k, q)) - reference) < 1e-12);
  }
});

test('full-copy example and exact availability boundaries', () => {
  assert.ok(Math.abs(Math.exp(logFragmentFailure(5, 1, 0.8)) - 0.00032) < 1e-15);
  assert.equal(logFragmentFailure(5, 1, 0), 0);
  assert.equal(logFragmentFailure(5, 5, 1), -Infinity);
  assert.ok(Math.abs(Math.exp(logFragmentFailure(3, 2, 0.5)) - 0.5) < 1e-14);
});

test('very small probability is represented without claiming exact zero', () => {
  const logP = logFragmentFailure(1000, 1, 0.9);
  assert.ok(Math.abs(logP - 1000 * Math.log(0.1)) < 1e-10);
  assert.match(fragmentFailureLabel(logP), /^10\^\(/);
});

test('invalid input is rejected and any-1% boundaries are preserved', () => {
  for (const args of [[0, 1, .8], [10, 11, .8], [5, 1, NaN], [10001, 1, .5], [5, 1.5, .5]]) assert.throws(() => logFragmentFailure(...args));
  assert.equal(reconstructionThreshold(100), 1);
  assert.equal(reconstructionThreshold(101), 2);
  assert.equal(reconstructionThreshold(1000000), 10000);
});

test('economic break-even is a sensitivity result, including impossible thresholds', () => {
  assert.deepEqual(attackEconomics(.01, 100000, 1000), { expectedPayoff: 0, breakEvenProbability: .01 });
  assert.equal(attackEconomics(1, 1000, 2000).breakEvenProbability, 2);
  assert.throws(() => attackEconomics(.5, 0, 1));
});
