import { sign, verify } from 'node:crypto';
import { canonical, digest, exact, publicKey, decode64 } from '../wallet/crypto.mjs';

export const RELEASE_POLICY = 'bank-first-terminal-sandbox-v1';
const DOMAIN = 'sunphi-irrevocable-release-instruction-sandbox-v1';
export function signReleaseInstruction(command, context, config, intentId, sourceKey, preparedAt = context.checkedAt) {
  const payload = { domain: DOMAIN, policy: RELEASE_POLICY, instanceId: config.instanceId,
    sourceId: config.casesPolicy.sourceId, bankId: config.casesPolicy.bankId, intentId,
    commandHash: digest({ command, context }), preparedAt };
  return { payload, signature: sign(null, Buffer.from(canonical(payload)), sourceKey).toString('base64') };
}
export function verifyReleaseInstruction(command, context, config, now) {
  const { release, ...base } = context;
  exact(release, ['payload', 'signature']);
  const p = release.payload;
  exact(p, ['domain', 'policy', 'instanceId', 'sourceId', 'bankId', 'intentId', 'commandHash', 'preparedAt']);
  if (config.releasePolicy !== RELEASE_POLICY || base.terms.finalityPolicy !== RELEASE_POLICY || p.domain !== DOMAIN || p.policy !== RELEASE_POLICY ||
      p.instanceId !== config.instanceId || p.sourceId !== config.casesPolicy.sourceId || p.bankId !== config.casesPolicy.bankId ||
      !/^[a-zA-Z0-9_.:-]{1,96}$/.test(p.intentId) || !Number.isSafeInteger(p.preparedAt) || p.preparedAt < base.checkedAt ||
      p.preparedAt < base.export.payload.issuedAt || p.preparedAt >= base.export.payload.expiresAt ||
      p.commandHash !== digest({ command, context: base }) ||
      !Number.isSafeInteger(now) || now < p.preparedAt ||
      !verify(null, Buffer.from(canonical(p)), publicKey(config.casesPolicy.sourceKey), decode64(release.signature, 64)))
    throw Error('Invalid durable release instruction');
  return p;
}
