// Exact, non-compounding HOLDER_PERIOD accounting for the declared Pi fixture.
// No rates are inferred for securities, receivables or other product families.
const YEAR_MS = 365n * 24n * 60n * 60n * 1000n;
const DENOMINATOR = YEAR_MS * 10000n;
const unsigned = value => typeof value === 'string' && /^\d+$/.test(value);
export function initialiseIncome(position, holderId, at) {
  if (position.profile !== 'Pi' || position.incomeAccrual) return;
  position.incomeAccrual = {
    model: 'HOLDER_PERIOD', holderId, currency: position.denomination,
    precision: position.precision, rateBps: position.institutionId === 'a' ? 300 : 200,
    rateVersion: 'demo-simple-act365-v1', basis: 'ACT/365 milliseconds; simple interest',
    startedAt: at, checkpointAt: at, remainder: '0', denominator: DENOMINATOR.toString(),
    journal: [], historicalAccrual: 'Not reconstructed; accrual starts at this migration checkpoint'
  };
}
export function validateIncome(position) {
  const a = position.incomeAccrual;
  if (!a) return;
  if (position.profile !== 'Pi' || a.model !== 'HOLDER_PERIOD' || !a.holderId ||
      a.currency !== position.denomination || a.precision !== position.precision ||
      !Number.isSafeInteger(a.rateBps) || a.rateBps < 0 || a.rateBps > 10000 ||
      a.rateVersion !== 'demo-simple-act365-v1' || !Number.isSafeInteger(a.checkpointAt) ||
      !Number.isSafeInteger(a.startedAt) || a.startedAt < 0 || a.checkpointAt < a.startedAt ||
      a.denominator !== DENOMINATOR.toString() || !unsigned(a.remainder) ||
      BigInt(a.remainder) >= DENOMINATOR || !unsigned(position.income) || !Array.isArray(a.journal)) {
    throw Error('Invalid holder-period income record');
  }
}
export function accrueIncome(position, at, eventId) {
  const a = position.incomeAccrual;
  if (!a) return;
  validateIncome(position);
  if (!Number.isSafeInteger(at) || at < a.checkpointAt) throw Error('Income clock moved backwards; institutional reconciliation is required');
  if (eventId && a.journal.some(e => e.eventId === eventId)) return;
  // Reserved principal remains with the sender until final confirmation. Incoming
  // pending principal earns nothing for the recipient. Freezing does not stop income.
  const principal = ['available', 'reserved', 'frozen'].reduce((n, field) => {
    const v = position[field] ?? '0';
    if (!unsigned(v)) throw Error('Invalid income principal');
    return n + BigInt(v);
  }, 0n);
  const numerator = principal * BigInt(a.rateBps) * BigInt(at - a.checkpointAt) + BigInt(a.remainder);
  const earned = numerator / DENOMINATOR;
  const entry = {eventId, from: a.checkpointAt, to: at, principalMinor: principal.toString(), rateVersion: a.rateVersion,
    rateBps: a.rateBps, earnedMinor: earned.toString(), openingRemainder: a.remainder, closingRemainder: (numerator % DENOMINATOR).toString()};
  position.income = (BigInt(position.income) + earned).toString();
  a.remainder = entry.closingRemainder; a.checkpointAt = at;
  if (eventId) a.journal.push(entry);
}
export function projectIncome(position, at) {
  const copy = structuredClone(position); accrueIncome(copy, at); return copy;
}
// Accrued income is not transferable principal and must not invalidate an otherwise
// unchanged signed proposal merely because time passed since its presentation.
export function principalTerms(position) {
  const {income, incomeAccrual, ...terms} = position;
  return {...terms, incomePolicy: incomeAccrual ? {
    model: incomeAccrual.model, holderId: incomeAccrual.holderId, currency: incomeAccrual.currency,
    precision: incomeAccrual.precision, rateBps: incomeAccrual.rateBps, rateVersion: incomeAccrual.rateVersion
  } : null};
}
