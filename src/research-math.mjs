export function logFragmentFailure(n, k, q) {
  if (!Number.isInteger(n) || n < 1 || n > 10000 || !Number.isInteger(k) || k < 1 || k > n || !Number.isFinite(q) || q < 0 || q > 1) {
    throw new RangeError('Use integer 1 ≤ k ≤ n ≤ 10,000 and 0 ≤ q ≤ 1.');
  }
  if (q === 0) return 0;
  if (q === 1) return -Infinity;
  let term = n * Math.log1p(-q);
  let total = -Infinity;
  for (let i = 0; i < k; i += 1) {
    const hi = Math.max(total, term);
    total = hi + Math.log1p(Math.exp(Math.min(total, term) - hi));
    term += Math.log(n - i) - Math.log(i + 1) + Math.log(q) - Math.log1p(-q);
  }
  return Math.min(0, total);
}

export function fragmentFailureLabel(logP) {
  if (logP === -Infinity) return '0 under the q = 100% assumption';
  if (logP === 0) return '≈ 1 (rounded to displayed precision)';
  if (logP < Math.log(Number.MIN_VALUE)) return `10^(${(logP / Math.LN10).toFixed(2)})`;
  return Math.exp(logP).toExponential(5);
}

export function reconstructionThreshold(holders) {
  if (!Number.isInteger(holders) || holders < 1 || holders > 1000000) throw new RangeError('Use 1 to 1,000,000 holders.');
  return Math.ceil(holders / 100);
}

export function attackEconomics(probability, gain, cost) {
  if (![probability, gain, cost].every(Number.isFinite) || probability < 0 || probability > 1 || gain <= 0 || cost < 0) throw new RangeError('Invalid economic assumptions.');
  return { expectedPayoff: probability * gain - cost, breakEvenProbability: cost / gain };
}
