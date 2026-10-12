import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

export const NETWORK = 'sunphi-lab-v1';
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const HEX = /^[0-9a-f]{64}$/;
export const ADDRESS = /^sunphi_lab1_[0-9a-f]{64}$/;
export function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw Error('Invalid record fields');
}
export function canonical(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (value.length > 100000 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw Error('Invalid string');
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)) return String(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  throw Error('Unsupported canonical value');
}
export function decode64(value, size) {
  if (typeof value !== 'string' || value.length > 100000) throw Error('Invalid encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (size !== undefined && bytes.length !== size)) throw Error('Invalid encoding');
  return bytes;
}
export function publicKey(encoded) {
  const bytes = decode64(encoded, 44);
  const key = createPublicKey({key: bytes, format: 'der', type: 'spki'});
  if (key.asymmetricKeyType !== 'ed25519' || !key.export({format:'der',type:'spki'}).equals(bytes)) throw Error('Expected Ed25519 public key');
  return key;
}
export function identity(key) {
  const pub = createPublicKey(key).export({format:'der',type:'spki'}).toString('base64');
  return { publicKey: pub, address: addressOf(pub) };
}
export function addressOf(pub) {
  publicKey(pub);
  return 'sunphi_lab1_' + digest({domain: NETWORK + '/address', publicKey: pub});
}
export function newKey() { return generateKeyPairSync('ed25519').privateKey; }
export function importSecret(bytes) {
  const key = createPrivateKey({key: bytes, format:'der', type:'pkcs8'});
  if (key.asymmetricKeyType !== 'ed25519') throw Error('Expected Ed25519 key');
  return key;
}
export function signRecord(key, payload) {
  if (payload.network !== NETWORK || !['reservation','receipt'].includes(payload.kind)) throw Error('Unsupported signing domain');
  return {...identity(key), payload: structuredClone(payload),
    signature: sign(null, Buffer.from(canonical(payload)), key).toString('base64')};
}
export function verifyRecord(record) {
  try {
    exact(record, ['publicKey','address','payload','signature']);
    return record.address === addressOf(record.publicKey) &&
      record.payload.network === NETWORK &&
      verify(null, Buffer.from(canonical(record.payload)), publicKey(record.publicKey), decode64(record.signature,64));
  } catch { return false; }
}
