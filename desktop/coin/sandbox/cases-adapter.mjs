import { sign, verify } from 'node:crypto';
import { canonical, digest, exact, publicKey, decode64 } from '../wallet/crypto.mjs';
import { exportCaseRecord, validateTerms } from './cases-contract.mjs';
import { verifyReleaseInstruction } from './release-certificate.mjs';

export const EXPORT_DOMAIN = 'sunphi-cases-export-sandbox-v1';
export const termsReference = terms => { validateTerms(terms); return `cases:${digest(terms)}`; };

// Call only inside the trusted, scoped Cases exporter. Key remains at the source.
export function signCaseExport({ projection, grant, terms, instanceId, sourceId, now }, sourceKey) {
  const record = exportCaseRecord(projection, grant, terms, now);
  const payload = { domain: EXPORT_DOMAIN, instanceId, sourceId, bankId: terms.bankId,
    issuedAt: now, expiresAt: Math.min(now + 60000, Date.parse(grant.expiresAt)), termsRef: termsReference(terms), record };
  return { payload, signature: sign(null, Buffer.from(canonical(payload)), sourceKey).toString('base64') };
}

export function verifyCaseExport(sealed, config, now) {
  exact(sealed, ['payload', 'signature']);
  const p = sealed.payload, policy = config.casesPolicy;
  exact(p, ['domain', 'instanceId', 'sourceId', 'bankId', 'issuedAt', 'expiresAt', 'termsRef', 'record']);
  if (p.domain !== EXPORT_DOMAIN || p.instanceId !== config.instanceId || p.sourceId !== policy.sourceId || p.bankId !== policy.bankId)
    throw Error('Wrong Cases export identity or audience');
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt) ||
      p.issuedAt < 0 || p.issuedAt > now || p.expiresAt <= now || p.expiresAt <= p.issuedAt ||
      p.expiresAt - p.issuedAt > policy.maxAgeMs || now - p.issuedAt > policy.maxAgeMs)
    throw Error('Expired or future Cases export');
  if (!verify(null, Buffer.from(canonical(p)), publicKey(policy.sourceKey), decode64(sealed.signature, 64))) throw Error('Invalid Cases export signature');
  return p;
}

// Bank-signed envelope context binds the exact export and immutable agreed terms.
export function verifyCasesSettlement(envelope, config, state, { currentExport, now, historical = false } = {}) {
  const context = envelope.context;
  exact(context, config.releasePolicy ? ['terms', 'export', 'checkedAt', 'release'] : ['terms', 'export', 'checkedAt']);
  validateTerms(context.terms);
  if (!Number.isSafeInteger(context.checkedAt) || context.checkedAt < 0 || (!historical && !config.releasePolicy && context.checkedAt !== now)) throw Error('Bank check time mismatch');
  if (config.releasePolicy) verifyReleaseInstruction(envelope.command, context, config, historical ? context.release?.payload?.preparedAt : now);
  const p = verifyCaseExport(context.export, config, context.checkedAt);
  if (p.termsRef !== termsReference(context.terms) || p.record.caseId !== context.terms.caseId || context.terms.bankId !== config.casesPolicy.bankId)
    throw Error('Export terms mismatch');
  const transfer = state.transfers[envelope.command.data.transferId];
  const contract = state.contracts[transfer?.contractId];
  const terms = context.terms;
  if (!contract || contract.caseRef !== p.termsRef || contract.amount !== terms.amount || contract.owner !== terms.owner ||
      contract.recipient !== terms.recipient || state.currency !== terms.currency ||
      canonical(contract.conditions) !== canonical(terms.conditions.map(({ id, actor, label }) => ({ id, actor, label }))))
    throw Error('Reservation does not bind these Cases terms');
  if (!Array.isArray(p.record.conditions) || p.record.conditions.length !== terms.conditions.length ||
      new Set(p.record.conditions.map(c => c.conditionId)).size !== terms.conditions.length ||
      terms.conditions.some(c => {
        const record = p.record.conditions.find(r => r.conditionId === c.id);
        return !record || record.stageId !== c.stageId || transfer.evidence[c.id]?.reference !== `cases:${digest(record)}`;
      })) throw Error('Ledger evidence review does not bind this exported version');
  if (!historical && !config.releasePolicy) {
    if (typeof currentExport !== 'function') throw Error('Current Cases source required; settlement paused');
    // Synchronous only in this local fixture. A real distributed commit needs an
    // issuer-approved finality/amendment protocol, not a network GET + local commit.
    const current = verifyCaseExport(currentExport(structuredClone(terms), now), config, now);
    if (current.termsRef !== p.termsRef || canonical(current.record) !== canonical(p.record)) throw Error('Cases evidence or access changed; obtain a new bank decision');
  }
  return p;
}
