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

// Scenario arithmetic only. A settlement ledger must use integer monetary units.
export function nodeRewardScenario(volume, totalNodeHours, walletHours, operatingCost = 0) {
  if (![volume, totalNodeHours, walletHours, operatingCost].every(Number.isFinite) ||
      volume < 0 || totalNodeHours < 0 || walletHours < 0 || walletHours > totalNodeHours || operatingCost < 0) {
    throw new RangeError('Use non-negative values; wallet hours cannot exceed total eligible node-hours.');
  }
  const pool = volume * 0.01;
  const share = totalNodeHours > 0 ? walletHours / totalNodeHours : 0;
  const reward = pool * share;
  const breakEvenVolume = share > 0 ? operatingCost / (0.01 * share) : null;
  return { seller: volume * 0.98, platform: pool, pool, share, reward,
    unallocatedPool: totalNodeHours === 0 ? pool : 0,
    netReward: reward - operatingCost, breakEvenVolume };
}

export function fundedTokenQuantity(funding, acquisitionPrice) {
  if (!Number.isFinite(funding) || funding < 0 || !Number.isFinite(acquisitionPrice) || acquisitionPrice <= 0) {
    throw new RangeError('Funding must be non-negative and the acquisition price must be positive.');
  }
  const quantity = funding / acquisitionPrice;
  if (!Number.isFinite(quantity)) throw new RangeError('These assumptions exceed the calculator range.');
  return quantity;
}
