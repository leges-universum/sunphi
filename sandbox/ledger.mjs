// Deterministic, no-value bank simulator. Actor authentication belongs to the
// signed Node adapter. The browser deliberately simulates all roles locally.
export const DOMAIN = 'sunphi-bank-sandbox-v1';
export const DAY = 86_400_000;
export const YEAR = 365 * DAY;
export const CAP_MINOR = 100_000_000 * 100;
export const ACTORS = Object.freeze(['bank', 'buyer', 'seller', 'supplier', 'carrier', 'insurer']);
const HOLDERS = ['buyer', 'seller', 'supplier'];
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/;
const schemas = {
  issue: ['paymentId', 'lotId', 'owner', 'quantity', 'paidCents'],
  contract: ['contractId', 'caseRef', 'recipient', 'amount', 'conditions'],
  approve: ['contractId'], reserve: ['transferId', 'contractId'],
  transfer: ['transferId', 'recipient', 'amount'], receipt: ['transferId'],
  evidence: ['transferId', 'conditionId', 'reference'],
  review: ['transferId', 'conditionId', 'evidenceId', 'accepted'],
  dispute: ['transferId', 'reason'], resolve: ['transferId', 'reason'],
  settle: ['transferId'], cancel: ['transferId', 'reason'],
  redeem: ['redemptionId', 'amount'], payout: ['redemptionId', 'paymentId'],
  rejectRedemption: ['redemptionId', 'reason'], tick: [],
};
export const canonical = v => {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0)) return String(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && Object.getPrototypeOf(v) === Object.prototype)
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  throw Error('Unsupported record value');
};
function fields(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw Error('Unexpected record fields');
}
function id(value) { if (typeof value !== 'string' || !ID.test(value)) throw Error('Invalid identifier'); }
function text(value) { if (typeof value !== 'string' || !value.trim() || value.length > 500) throw Error('Invalid text'); }
function amount(value) { if (!Number.isSafeInteger(value) || value <= 0 || value > CAP_MINOR) throw Error('Invalid amount'); }
function holder(value) { if (!HOLDERS.includes(value)) throw Error('Unknown wallet'); }
function sum(parts) { return parts.reduce((n, p) => n + p.amount, 0); }
function bank(c) { if (c.actor !== 'bank') throw Error('Bank authority required'); }
function required(map, key) { id(key); if (!Object.hasOwn(map, key)) throw Error('Unknown record'); return map[key]; }
function unique(map, key) { id(key); if (Object.hasOwn(map, key)) throw Error('Identifier already used'); }

export function initialState() {
  return { domain: DOMAIN, mode: 'SIMULATION — NO MONETARY VALUE', currency: 'USD',
    precision: 2, capMode: 'cumulative-lifetime-demo-assumption', rateBps: 500,
    clock: 0, sequence: 0, issued: 0, redeemed: 0, paidOutCents: 0,
    platformCents: 0, rewardFundingCents: 0, receivedCents: 0,
    wallets: Object.fromEntries(HOLDERS.map(a => [a, []])), lots: {},
    contracts: {}, transfers: {}, redemptions: {}, paymentIds: {}, outcomes: {}, journal: [] };
}

function take(s, owner, quantity) {
  amount(quantity); holder(owner);
  if (sum(s.wallets[owner]) < quantity) throw Error('Insufficient available balance');
  let remaining = quantity;
  const result = [];
  for (const part of s.wallets[owner]) {
    const n = Math.min(part.amount, remaining);
    if (n) result.push({ lotId: part.lotId, amount: n });
    part.amount -= n; remaining -= n;
  }
  s.wallets[owner] = s.wallets[owner].filter(p => p.amount);
  return result;
}
function give(s, owner, parts) {
  for (const part of parts) {
    const existing = s.wallets[owner].find(p => p.lotId === part.lotId);
    if (existing) existing.amount += part.amount;
    else s.wallets[owner].push({ ...part });
  }
}
function active(s, transferId) {
  const t = required(s.transfers, transferId);
  if (t.status !== 'reserved') throw Error('Transfer already resolved');
  return t;
}
function accrue(s, at) {
  for (const lot of Object.values(s.lots)) {
    // Keep the exact numerator across events; floor only for display/payout quote.
    lot.interestNumerator = String(BigInt(lot.interestNumerator) +
      BigInt(lot.outstanding) * BigInt(s.rateBps) * BigInt(at - s.clock));
  }
  s.clock = at;
}

export function balances(s, owner) {
  holder(owner);
  return { available: sum(s.wallets[owner]),
    reserved: Object.values(s.transfers).filter(t => t.owner === owner && t.status === 'reserved').reduce((n, t) => n + t.amount, 0),
    redeeming: Object.values(s.redemptions).filter(r => r.owner === owner && r.status === 'pending').reduce((n, r) => n + r.amount, 0),
    incoming: Object.values(s.transfers).filter(t => t.recipient === owner && t.status === 'reserved').reduce((n, t) => n + t.amount, 0),
    interestPrincipal: Object.values(s.lots).filter(l => l.beneficiary === owner).reduce((n, l) => n + l.outstanding, 0),
    interestCents: Number(Object.values(s.lots).filter(l => l.beneficiary === owner).reduce((n, l) => n + BigInt(l.interestNumerator), 0n) / (10_000n * BigInt(YEAR))) };
}

export function assertInvariants(s) {
  const parts = [...Object.values(s.wallets).flat(),
    ...Object.values(s.transfers).filter(t => t.status === 'reserved').flatMap(t => t.parts),
    ...Object.values(s.redemptions).filter(r => r.status === 'pending').flatMap(r => r.parts)];
  const byLot = new Map();
  for (const p of parts) { amount(p.amount); required(s.lots, p.lotId); byLot.set(p.lotId, (byLot.get(p.lotId) || 0) + p.amount); }
  for (const [lotId, lot] of Object.entries(s.lots)) {
    if ((byLot.get(lotId) || 0) !== lot.outstanding || lot.outstanding < 0 || lot.outstanding > lot.issued)
      throw Error('Lot conservation failed');
  }
  if (sum(parts) !== s.issued - s.redeemed || s.issued > CAP_MINOR || s.paidOutCents !== s.redeemed ||
      s.receivedCents !== s.issued + s.platformCents + s.rewardFundingCents)
    throw Error('Financial conservation failed');
  return true;
}

// Pure transaction: validation and invariant failures leave input state untouched.
// Exactly matching command-ID replay returns its original receipt even after time moves.
export function execute(input, c) {
  fields(c, ['domain', 'id', 'actor', 'at', 'type', 'data']);
  if (c.domain !== DOMAIN || !ACTORS.includes(c.actor) || !Object.hasOwn(schemas, c.type)) throw Error('Invalid domain, actor or command');
  id(c.id); fields(c.data, schemas[c.type]);
  const fingerprint = canonical(c);
  if (fingerprint.length > 8000) throw Error('Command too large');
  if (Object.hasOwn(input.outcomes, c.id)) {
    const old = input.outcomes[c.id];
    if (old.fingerprint !== fingerprint) throw Error('Conflicting command replay');
    return { state: input, receipt: structuredClone(old.receipt), replayed: true };
  }
  if (!Number.isSafeInteger(c.at) || c.at < input.clock || c.at > 100 * YEAR) throw Error('Invalid monotonic sandbox time');
  if (c.actor !== 'bank' && c.at !== input.clock) throw Error('Only the simulated bank may advance accounting time');
  const s = structuredClone(input), d = c.data;
  accrue(s, c.at);
  switch (c.type) {
    case 'issue': {
      bank(c); holder(d.owner); unique(s.lots, d.lotId); unique(s.paymentIds, d.paymentId);
      if (!Number.isSafeInteger(d.quantity) || d.quantity <= 0 || d.quantity > 100_000_000 ||
          !Number.isSafeInteger(d.paidCents) || d.paidCents !== d.quantity * 102) throw Error('Exact settled primary payment required');
      const principal = d.quantity * 100;
      if (s.issued + principal > CAP_MINOR) throw Error('Cumulative issuance cap exceeded');
      s.paymentIds[d.paymentId] = c.id;
      s.lots[d.lotId] = { beneficiary: d.owner, issued: principal, outstanding: principal, interestNumerator: '0', issuedAt: c.at };
      give(s, d.owner, [{ lotId: d.lotId, amount: principal }]);
      s.issued += principal; s.receivedCents += d.paidCents;
      s.platformCents += d.quantity; s.rewardFundingCents += d.quantity;
      break;
    }
    case 'contract': {
      holder(c.actor); holder(d.recipient); unique(s.contracts, d.contractId); id(d.caseRef); amount(d.amount);
      if (d.recipient === c.actor || !Array.isArray(d.conditions) || !d.conditions.length || d.conditions.length > 8)
        throw Error('Contract parties and conditions required');
      const seen = new Set();
      for (const condition of d.conditions) {
        fields(condition, ['id', 'actor', 'label']); id(condition.id); text(condition.label);
        if (!['carrier', 'insurer'].includes(condition.actor) || seen.has(condition.id)) throw Error('Invalid evidence authority');
        seen.add(condition.id);
      }
      s.contracts[d.contractId] = { ...structuredClone(d), revision: 1, owner: c.actor, approvals: [c.actor], transferId: null };
      break;
    }
    case 'approve': {
      const contract = required(s.contracts, d.contractId);
      if (![contract.owner, contract.recipient, 'bank'].includes(c.actor) || contract.transferId) throw Error('Approval not allowed');
      if (!contract.approvals.includes(c.actor)) contract.approvals.push(c.actor);
      break;
    }
    case 'reserve':
    case 'transfer': {
      holder(c.actor); unique(s.transfers, d.transferId);
      let recipient, quantity, contractId = null;
      if (c.type === 'reserve') {
        const contract = required(s.contracts, d.contractId);
        if (contract.owner !== c.actor || contract.transferId || ![contract.owner, contract.recipient, 'bank'].every(a => contract.approvals.includes(a)))
          throw Error('Agreed contract required');
        recipient = contract.recipient; quantity = contract.amount; contractId = d.contractId;
        contract.transferId = d.transferId;
      } else { holder(d.recipient); recipient = d.recipient; quantity = d.amount; }
      if (recipient === c.actor) throw Error('Self transfer not supported');
      const parts = take(s, c.actor, quantity);
      s.transfers[d.transferId] = { owner: c.actor, recipient, amount: quantity, parts, contractId,
        revision: 1, status: 'reserved', reservedAt: c.at, receiptId: null, evidence: {}, disputed: false, decision: null };
      break;
    }
    case 'receipt': {
      const t = active(s, d.transferId);
      if (t.recipient !== c.actor || t.receiptId) throw Error('Recipient receipt not allowed');
      t.receiptId = c.id; t.receivedAt = c.at; break;
    }
    case 'evidence': {
      const t = active(s, d.transferId);
      const contract = required(s.contracts, t.contractId);
      const condition = contract.conditions.find(x => x.id === d.conditionId);
      if (!condition || condition.actor !== c.actor) throw Error('Evidence authority mismatch');
      text(d.reference);
      t.evidence[d.conditionId] = { id: c.id, reference: d.reference, at: c.at, accepted: false, reviewer: null };
      break;
    }
    case 'review': {
      bank(c); const t = active(s, d.transferId);
      const evidence = required(t.evidence, d.conditionId);
      if (evidence.id !== d.evidenceId || typeof d.accepted !== 'boolean') throw Error('Exact evidence version required');
      evidence.accepted = d.accepted; evidence.reviewer = c.id; break;
    }
    case 'dispute': {
      const t = active(s, d.transferId); text(d.reason);
      if (![t.owner, t.recipient, 'bank'].includes(c.actor)) throw Error('Dispute authority mismatch');
      t.disputed = true; t.disputeReason = d.reason; break;
    }
    case 'resolve': {
      bank(c); const t = active(s, d.transferId); text(d.reason);
      if (!t.disputed) throw Error('No open dispute');
      t.disputed = false; t.disputeResolution = d.reason; break;
    }
    case 'settle': {
      bank(c); const t = active(s, d.transferId);
      if (!t.receiptId || t.disputed) throw Error('Recipient receipt and resolved disputes required');
      if (t.contractId) {
        const contract = required(s.contracts, t.contractId);
        if (!contract.conditions.every(x => t.evidence[x.id]?.accepted)) throw Error('Bank-reviewed evidence required');
      }
      give(s, t.recipient, t.parts); t.status = 'settled'; t.decision = c.id; t.settledAt = c.at; break;
    }
    case 'cancel': {
      bank(c); const t = active(s, d.transferId); text(d.reason);
      give(s, t.owner, t.parts); t.status = 'cancelled'; t.decision = c.id; t.cancellationReason = d.reason; break;
    }
    case 'redeem': {
      holder(c.actor); unique(s.redemptions, d.redemptionId);
      s.redemptions[d.redemptionId] = { owner: c.actor, amount: d.amount, parts: take(s, c.actor, d.amount), status: 'pending', requestedAt: c.at };
      break;
    }
    case 'payout': {
      bank(c); const r = required(s.redemptions, d.redemptionId); unique(s.paymentIds, d.paymentId);
      if (r.status !== 'pending') throw Error('Redemption already resolved');
      for (const part of r.parts) s.lots[part.lotId].outstanding -= part.amount;
      s.redeemed += r.amount; s.paidOutCents += r.amount; s.paymentIds[d.paymentId] = c.id;
      r.status = 'paid'; r.paymentId = d.paymentId; r.paidAt = c.at; break;
    }
    case 'rejectRedemption': {
      bank(c); const r = required(s.redemptions, d.redemptionId); text(d.reason);
      if (r.status !== 'pending') throw Error('Redemption already resolved');
      give(s, r.owner, r.parts); r.status = 'rejected'; r.reason = d.reason; break;
    }
    case 'tick': bank(c); break;
  }
  assertInvariants(s);
  s.sequence++;
  const receipt = { domain: DOMAIN, commandId: c.id, sequence: s.sequence, type: c.type, at: c.at, status: 'accepted' };
  s.outcomes[c.id] = { fingerprint, receipt };
  s.journal.push({ ...receipt, actor: c.actor });
  return { state: s, receipt: structuredClone(receipt), replayed: false };
}
