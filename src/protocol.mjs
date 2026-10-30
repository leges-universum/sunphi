import { createHash } from 'node:crypto';
import { Field, Poseidon } from 'o1js';
import { Statement, Outputs, DOMAIN, LAB_NETWORK, MAX_NOTE } from './circuit.mjs';

export const VERSION = 'sunphi-native-isolated/0.1';
export const VK_SHA256 = '07fef2096df76be65f6649e249b3ee0158cc7f4fc1f1d8a18f7a986ba9f9dfff';
export function canonical(x) {
  if (x === null || typeof x === 'boolean' || typeof x === 'string') return JSON.stringify(x);
  if (typeof x === 'number' && Number.isSafeInteger(x)) return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype)
    return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
  throw new Error('noncanonical value');
}
export const digest = x => createHash('sha256').update(typeof x === 'string' ? x : canonical(x)).digest('hex');
export function exact(x, keys) {
  if (!x || typeof x !== 'object' || Array.isArray(x) ||
      Object.keys(x).sort().join('|') !== [...keys].sort().join('|')) throw new Error('unknown or missing fields');
}
export function fieldString(x) {
  if (typeof x !== 'string' || !/^(0|[1-9][0-9]{0,76})$/.test(x) || BigInt(x) >= Field.ORDER)
    throw new Error('noncanonical field');
  return x;
}
export function parseWire(wire) {
  exact(wire, ['version', 'proof']);
  if (wire.version !== VERSION) throw new Error('unsupported protocol');
  exact(wire.proof, ['publicInput', 'publicOutput', 'maxProofsVerified', 'proof']);
  const p = wire.proof;
  for (const [key, length] of [['publicInput',Statement.sizeInFields()], ['publicOutput',Outputs.sizeInFields()]]) {
    if (!Array.isArray(p[key]) || p[key].length !== length) throw new Error('invalid field count');
    p[key].forEach(fieldString);
  }
  if (p.maxProofsVerified !== 0 || typeof p.proof !== 'string' || p.proof.length < 100 || p.proof.length > 100000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(p.proof)) throw new Error('invalid proof encoding');
  if (Buffer.byteLength(canonical(wire)) > 131072) throw new Error('oversized transaction');
  const s = Statement.fromFields(p.publicInput.map(Field));
  const o = Outputs.fromFields(p.publicOutput.map(Field));
  const nums = ['kind','epoch','expiry'];
  for (const name of nums) if (s[name].value.toBigInt() > 0xffffffffn) throw new Error('integer range');
  if (!s.network.equals(LAB_NETWORK).toBoolean()) throw new Error('wrong network');
  if (s.kind.toBigint() > 1n || s.fee.toBigInt() > MAX_NOTE) throw new Error('invalid operation');
  if (!['0','1'].includes(p.publicInput[4])) throw new Error('invalid bool');
  const txid = digest({ version: VERSION, publicInput:p.publicInput, publicOutput:p.publicOutput });
  const ids = [0,1].map(i => Poseidon.hash([DOMAIN.add(2), Field(BigInt('0x'+txid) % Field.ORDER), Field(i)]).toString());
  return { s, o, txid, ids, wire };
}
export function makeWire(proof) { return { version: VERSION, proof }; }
