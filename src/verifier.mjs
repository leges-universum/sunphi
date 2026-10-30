import { readFileSync } from 'node:fs';
import { verify } from 'o1js';
import { digest, parseWire, VK_SHA256 } from './protocol.mjs';

export function loadPinnedKey(path) {
  const key = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof key.data !== 'string' || digest(key.data) !== VK_SHA256) throw new Error('untrusted verification key');
  return key.data;
}
export async function verifyWire(wire, key) {
  if (digest(key) !== VK_SHA256) throw new Error('untrusted verification key');
  const parsed = parseWire(wire);
  let valid = false;
  try { valid = await verify(wire.proof, key); } catch { /* fail closed */ }
  if (!valid) throw new Error('invalid ZK proof');
  return parsed;
}
