// Approved project rules. This module does not issue a network asset or move money.
export const SUPPLY_CAP = 100_000_000n;
export const INITIAL_PRICE_CENTS = 100n;
// Research allocation only; not an approved legal reserve portfolio or live custody setup.
export const RESERVE_PLAN = Object.freeze([
  Object.freeze({ asset: 'USDC', network: 'Ethereum', weightBps: 9000, address: null }),
  Object.freeze({ asset: 'BTC', network: 'Bitcoin', weightBps: 1000, address: null }),
]);

export function primaryQuote(quantity) {
  if (typeof quantity !== 'bigint' || quantity <= 0n || quantity > SUPPLY_CAP) throw new RangeError('Use 1 to 100,000,000 whole tokens for this initial-sale model.');
  const reserveCents = quantity * INITIAL_PRICE_CENTS;
  const platformCents = quantity;
  const rewardCents = quantity;
  return Object.freeze({ quantity, reserveCents, platformCents, rewardCents, buyerCents: reserveCents + platformCents + rewardCents });
}

// Scenario only: initial fully purchased basket, no costs/liabilities, no later issuance.
export function reserveStress({ issued, usdcChange, btcChange }) {
  if (!Number.isSafeInteger(issued) || issued <= 0 || issued > Number(SUPPLY_CAP) ||
      ![usdcChange, btcChange].every(v => Number.isFinite(v) && v >= -100 && v <= 1000)) throw new RangeError('Use a positive issued supply and price changes from −100% to +1,000%.');
  const initialUsd = issued;
  const usdcUsd = initialUsd * 0.9 * (1 + usdcChange / 100);
  const btcUsd = initialUsd * 0.1 * (1 + btcChange / 100);
  const reserveUsd = usdcUsd + btcUsd;
  return { initialUsd, usdcUsd, btcUsd, reserveUsd, backingPerTokenUsd: reserveUsd / issued, coveragePercent: 100 * reserveUsd / initialUsd };
}
