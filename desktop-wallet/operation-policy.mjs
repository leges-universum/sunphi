import {digest, addressOf} from '../wallet/crypto.mjs';

export const POLICY_VERSION = 'sunphi-2.2-local-policy-v1';
const CORE = ['identity', 'product', 'territory', 'authority', 'quantity', 'route', 'confirmation'];
export function initialisePolicy(s, at) {
  s.holderId = 'demo-holder-' + digest({initialKey: s.holder});
  s.policy = {version: POLICY_VERSION, production: false,
    mandatory_core: CORE.map(id => ({id, version: 1, enabled: true})),
    product_policy: {version: 1, enabled: true}, territorial_policy: {version: 1, enabled: true, territory: 'LOCAL_DEMONSTRATION'},
    supported_operations: ['own-product', 'recipient-transfer']};
  s.identityBinding = {holder_id: s.holderId, wallet_address: addressOf(s.holder), verification_ref: 'local-fixture-' + s.holderId,
    attribute_scope: s.positions.map(p => p.id), institution_ids: [...new Set(s.positions.map(p => p.institutionId))],
    valid_from: at, valid_until: at + 365 * 86400000, revoked: false, verified_legal_identity: false};
}
export function configurationHash(s) {
  return digest({policy: s.policy ?? null, identity: s.identityBinding ?? null,
    products: s.positions.map(p => ({id:p.id, institutionId:p.institutionId, programmeId:p.programmeId,
      instrumentId:p.instrumentId, seriesId:p.seriesId, termsVersion:p.termsVersion, token:p.token,
      rateBps:p.incomeAccrual?.rateBps ?? null, rateVersion:p.incomeAccrual?.rateVersion ?? null})), routes:s.routes});
}
export function policyReasons(s, position, now) {
  const reasons = [], p = s.policy, b = s.identityBinding;
  if (!p || p.version !== POLICY_VERSION || p.production !== false ||
      !Array.isArray(p.mandatory_core) || p.mandatory_core.length !== CORE.length ||
      CORE.some(id => p.mandatory_core.filter(m => m.id === id && m.enabled === true && m.version === 1).length !== 1) ||
      p.product_policy?.enabled !== true || p.product_policy?.version !== 1 ||
      p.territorial_policy?.enabled !== true || p.territorial_policy?.version !== 1 ||
      p.territorial_policy?.territory !== 'LOCAL_DEMONSTRATION') reasons.push('POLICY_UNAVAILABLE');
  if (!b || b.holder_id !== s.holderId || b.wallet_address !== addressOf(s.holder) || !b.verification_ref ||
      b.revoked !== false || !Number.isSafeInteger(b.valid_from) || !Number.isSafeInteger(b.valid_until) ||
      b.valid_from > now || b.valid_until <= now || !Array.isArray(b.attribute_scope) || !Array.isArray(b.institution_ids) ||
      !position || !b.attribute_scope.includes(position.id) || !b.institution_ids.includes(position.institutionId)) reasons.push('HOLDER_NOT_ELIGIBLE');
  if (!position || !['Vi','Pi','Go','Bl','Gr'].includes(position.profile)) reasons.push('PRODUCT_NOT_TRANSFERABLE');
  if (position && (!position.seriesId || position.interfaceProfile !== 'SUNPHI_LOCAL_NATIVE')) reasons.push('INTERFACE_NOT_QUALIFIED');
  return reasons;
}
const messages = {
  POLICY_UNAVAILABLE: 'Required product or participation checks are unavailable. Contact the servicing institution; existing rights remain recorded.',
  HOLDER_NOT_ELIGIBLE: 'The holder verification is missing, expired, revoked or outside this product’s scope. Ask the servicing institution to review eligibility.',
  PRODUCT_NOT_TRANSFERABLE: 'This product cannot be used for this transfer. Choose an eligible asset.',
  INTERFACE_NOT_QUALIFIED: 'This asset interface is not qualified for execution. No external ERC or settlement connection is enabled.',
  OPERATION_NOT_SUPPORTED: 'This operation is not enabled by the admitted product rules.',
  ROUTE_UNAVAILABLE: 'This direction is unavailable. Select an available receiving product.',
  INSUFFICIENT_AVAILABLE: 'Insufficient available tokens. Reserved, frozen and pending amounts cannot be spent.',
  INVALID_QUANTITY: 'Enter a positive, exactly representable token quantity.',
  RECOVERY_PENDING: 'An earlier operation requires attention. Check its original status in History.'
};
export function precheckOperation(s, {sourceId, destinationId, routeId, operation='own-product', quantityMinor}, now, recipient) {
  const source = s.positions.find(p => p.id === sourceId), destState = recipient || s;
  const destination = destState.positions.find(p => p.id === destinationId);
  const reasons = policyReasons(s, source, now);
  if (destination) reasons.push(...policyReasons(destState, destination, now));
  if (!s.policy?.supported_operations?.includes(operation)) reasons.push('OPERATION_NOT_SUPPORTED');
  if (s.transactions.some(t => t.state === 'RECOVERY_REQUIRED')) reasons.push('RECOVERY_PENDING');
  if (operation === 'own-product' && !s.routes.some(r => r.id === routeId && r.status === 'ACTIVE' && r.source === sourceId && r.destination === destinationId)) reasons.push('ROUTE_UNAVAILABLE');
  if (quantityMinor !== undefined && (typeof quantityMinor !== 'string' || !/^[1-9]\d*$/.test(quantityMinor) || BigInt(quantityMinor) > 10n**24n)) reasons.push('INVALID_QUANTITY');
  else if (source && (BigInt(source.available) <= 0n || (quantityMinor !== undefined && BigInt(quantityMinor) > BigInt(source.available)))) reasons.push('INSUFFICIENT_AVAILABLE');
  const codes = [...new Set(reasons)];
  return {permitted_actions: codes.length ? [] : [operation], maximum_quantity:source?.available ?? '0', reason_codes:codes,
    user_next_steps:codes.map(code => messages[code]), checked_at:now, valid_until:Math.min(now+120000, s.identityBinding?.valid_until ?? now, destState.identityBinding?.valid_until ?? now),
    configuration_hash:configurationHash(s), state_version:s.sequence,
    recipient_configuration_hash:recipient ? configurationHash(recipient) : null, recipient_state_version:recipient?.sequence ?? null,
    required_confirmations:[...new Set(['operator', source?.institutionId, destination?.institutionId].filter(Boolean))],
    production:false, reservation:false, finality:false};
}
export function requirePrecheck(result) {
  if (!result.permitted_actions.length) throw Error(result.user_next_steps.join(' '));
  return result;
}
