import { SUPPLY_CAP, primaryQuote } from '../src/issuance-policy.mjs';

// Serial, in-memory reference ledger. NOT a payment verifier, custody wallet or
// distributed mint. Caller-supplied settlement/receipt IDs are trusted lab inputs.
// Production requires authenticated adapters, durable atomic storage, finality,
// custody controls and reconciliation. No keys, network transactions or real tokens.
export class IssuanceModel {
  #orders = new Map();
  #payments = new Map();
  #receipts = new Map();
  #issued = 0n;
  #committed = 0n;
  #reserveCents = 0n;
  #platformCents = 0n;
  #rewardCents = 0n;

  get snapshot() {
    return Object.freeze({ issued: this.#issued, committedCapacity: this.#committed,
      remainingCapacity: SUPPLY_CAP - this.#issued - this.#committed,
      reserveAcquisitionCents: this.#reserveCents, platformFeeCents: this.#platformCents, rewardFundingCents: this.#rewardCents });
  }
  #order(id) {
    const order = this.#orders.get(id);
    if (!order) throw Error('Unknown order');
    return order;
  }
  order(id) { return structuredClone(this.#order(id)); }

  create({ id, buyer, quantity }) {
    if (typeof id !== 'string' || !id || typeof buyer !== 'string' || !buyer) throw Error('Order and buyer required');
    const quote = primaryQuote(quantity);
    const old = this.#orders.get(id);
    if (old) {
      if (old.buyer !== buyer || old.quote.quantity !== quantity) throw Error('Conflicting order replay');
      return this.order(id);
    }
    if (this.#issued + this.#committed + quantity > SUPPLY_CAP) throw Error('Issuance cap exceeded');
    this.#orders.set(id, { id, buyer, quote, state: 'awaiting_payment', reserveCents: 0n, paymentId: null, lots: [], issuedRange: null });
    this.#committed += quantity;
    return this.order(id);
  }
  settlePayment({ id, paymentId, cents }) {
    const order = this.#order(id);
    if (typeof paymentId !== 'string' || !paymentId || typeof cents !== 'bigint' || cents !== order.quote.buyerCents) throw Error('Exact settled buyer payment required');
    if (order.paymentId === paymentId) return this.order(id);
    if (order.state !== 'awaiting_payment' || this.#payments.has(paymentId)) throw Error('Payment unavailable or already allocated');
    this.#payments.set(paymentId, id);
    order.paymentId = paymentId;
    order.state = 'awaiting_reserve';
    return this.order(id);
  }
  acquireReserve({ id, receiptId, asset, network, reserveAddress, units, decimals, principalCents }) {
    const order = this.#order(id);
    if (typeof receiptId !== 'string' || !receiptId || typeof reserveAddress !== 'string' || !reserveAddress ||
        !((asset === 'BTC' && network === 'Bitcoin' && decimals === 8) || (asset === 'USDC' && network === 'Ethereum' && decimals === 6)) ||
        typeof units !== 'bigint' || units <= 0n || typeof principalCents !== 'bigint' || principalCents <= 0n) throw Error('Valid settled reserve lot required');
    const lot = { id, receiptId, asset, network, reserveAddress, units, decimals, principalCents };
    const old = this.#receipts.get(receiptId);
    if (old) {
      if (Object.keys(lot).some(key => lot[key] !== old[key])) throw Error('Reserve receipt already used or changed');
      return this.order(id);
    }
    if (order.state !== 'awaiting_reserve' || order.reserveCents + principalCents > order.quote.reserveCents) throw Error('Invalid reserve allocation');
    this.#receipts.set(receiptId, lot);
    order.lots.push(lot);
    order.reserveCents += principalCents;
    return this.order(id);
  }
  issue(id) {
    const order = this.#order(id);
    if (order.state === 'issued') return this.order(id);
    if (order.state !== 'awaiting_reserve' || order.reserveCents !== order.quote.reserveCents) throw Error('Settled payment and full reserve acquisition required');
    // Enforce the research cost allocation. Authenticity and lack of encumbrances
    // are trusted input assumptions here, not properties this model can verify.
    const usdc = order.lots.filter(lot => lot.asset === 'USDC').reduce((sum, lot) => sum + lot.principalCents, 0n);
    if (usdc * 10n !== order.reserveCents * 9n) throw Error('Initial allocation must be 90% USDC / 10% BTC');
    if (this.#issued + order.quote.quantity > SUPPLY_CAP) throw Error('Issuance cap exceeded');
    order.issuedRange = { first: this.#issued + 1n, last: this.#issued + order.quote.quantity, owner: order.buyer };
    this.#issued += order.quote.quantity;
    this.#committed -= order.quote.quantity;
    this.#reserveCents += order.reserveCents;
    this.#platformCents += order.quote.platformCents;
    this.#rewardCents += order.quote.rewardCents;
    order.state = 'issued';
    return this.order(id);
  }
  cancelUnpaid(id) {
    const order = this.#order(id);
    if (order.state === 'cancelled') return this.order(id);
    if (order.state !== 'awaiting_payment') throw Error('Paid orders require a separate verified refund/reconciliation process');
    order.state = 'cancelled';
    this.#committed -= order.quote.quantity;
    return this.order(id);
  }
}
