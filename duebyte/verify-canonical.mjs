import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Literal signing bytes are independent of the implementation under test.
const vectors = [
  [{ b: 1, a: [true, null, -2] }, '{"a":[true,null,-2],"b":1}'],
  [{ '2': false, '10': true }, '{"10":true,"2":false}'],
  [{ '\uE000': 1, '😀': 2 }, '{"😀":2,"\uE000":1}'],
  [['é', 'e\u0301', '\n', '"', '\\'], '["é","e\u0301","\\n","\\"","\\\\"]'],
  ['\ud800', '"\\ud800"'],
  [[-0, 9007199254740991], '[0,9007199254740991]']
];
const root = process.argv[2];
assert(root, 'usage: node verify-canonical.mjs SERVER_DIR');
const file = 'sunphi-network-next/checkpoint-trial/crypto.mjs';
const manifest = readFileSync(resolve(root,'manifest.json'));
const sha = data => createHash('sha256').update(data).digest('hex');
assert.equal(sha(manifest), '65bd3ae76c98b927a2a04db0f2f9640d2204998b8af4db514f13b2a6bd6b5554');
assert.equal(sha(readFileSync(resolve(root,file))), JSON.parse(manifest).files[file]);
const { canonical, hash } = await import(pathToFileURL(resolve(root,file)).href);
for (const [value,text] of vectors) {
  assert.equal(canonical(value), text);
  assert.equal(hash(value), sha(Buffer.from(text,'utf8')));
}
for (const invalid of [0.1, Infinity, NaN, 9007199254740992, undefined]) {
  assert.throws(() => canonical(invalid));
}
console.log('Verified six canonical encodings and five rejected inputs.');
