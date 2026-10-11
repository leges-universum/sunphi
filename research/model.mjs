// Local reference model only. NOT a distributed protocol or currency.
// A serial in-memory oracle supplies ordering and time. Replacing it with
// secure network finality is an unresolved task, NOT something these tests prove.
export class TokenModel {
  constructor(owner) {
    this.owner = owner;
    this.version = 0;
    this.pending = null;
    this.used = new Set();
    this.now = 0;
  }
  advance(time) {
    if (!Number.isSafeInteger(time) || time < this.now) throw Error('invalid time');
    this.now = time;
  }
  reserve({ id, sender, recipient, version, expires }) {
    if (!id || !recipient || this.used.has(id) || this.pending ||
        sender !== this.owner || version !== this.version ||
        !Number.isSafeInteger(expires) || expires <= this.now) return false;
    this.used.add(id);
    this.pending = { id, sender, recipient, expires };
    this.version++;
    return true;
  }
  credit({ id, recipient, version }) {
    const p = this.pending;
    if (!p || p.id !== id || p.recipient !== recipient ||
        version !== this.version || this.now >= p.expires) return false;
    this.owner = recipient;
    this.pending = null;
    this.version++;
    return true;
  }
  cancel({ id, version }) {
    const p = this.pending;
    if (!p || p.id !== id || version !== this.version || this.now < p.expires) return false;
    this.pending = null;
    this.version++;
    return true;
  }
  spendableBy(owner) {
    return this.pending === null && this.owner === owner;
  }
}

// Nominal subdivision is arithmetic only. It does NOT implement splitting
// a permanent-ID token into independently owned pieces.
export function emissionScenario(supply, decimals = 8) {
  if (typeof supply !== 'bigint' || supply <= 0n ||
      !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw Error('invalid supply');
  return {
    supply: supply.toString(),
    decimals,
    accountingUnits: (supply * 10n ** BigInt(decimals)).toString(),
    theoreticalFullSaleUsdAtOneDollar: supply.toString(),
    // Assumption: each whole token has its own 2048-byte live state,
    // encoded at n/k = 100. Payload only, no overhead or extra replicas.
    hypotheticalEncodedPayloadBytes: (supply * 2048n * 100n).toString(),
  };
}
