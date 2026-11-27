import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, createReadStream, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Historical release inspection. The Home updater additionally checks freshness and rollback.
const catalog = '5097f67384c26f26c9fb49f14d0a43ce275ba336';
const trustedRoot = '520f5d1a74be738371a889529ef25e03d375fde39a9a2e4c6c90eb0cf3d20047';
const [target, packageDir, archive] = process.argv.slice(2);
const choices = ['home-windows-x64', 'home-linux-x64', 'server-linux-x64'];
assert(choices.includes(target) && packageDir && archive,
  'Usage: node duebyte/verify-release.mjs TARGET EXTRACTED_APP_DIRECTORY DOWNLOADED_ARCHIVE');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
async function get(name) {
  const response = await fetch('https://raw.githubusercontent.com/leges-universum/sunphi/' + catalog + '/' + name);
  assert.equal(response.status, 200, name);
  return Buffer.from(await response.arrayBuffer());
}
const rootBytes = await get('metadata/root.json');
assert.equal(hash(rootBytes), trustedRoot, 'trusted release root');
const root = JSON.parse(rootBytes).signed;
const metadata = JSON.parse(await get('metadata/targets.json'));
const role = root.roles.targets;
const signers = new Set();
for (const { keyid, sig } of metadata.signatures) {
  if (!role.keyids.includes(keyid)) continue;
  const key = root.keys[keyid];
  assert.equal(key.scheme, 'ed25519');
  const der = Buffer.from('302a300506032b6570032100' + key.keyval.public, 'hex');
  if (verify(null, Buffer.from(canonical(metadata.signed)), createPublicKey({key:der, format:'der', type:'spki'}), Buffer.from(sig,'hex'))) signers.add(keyid);
}
assert(signers.size >= role.threshold, 'targets signature threshold');
const descriptor = 'storage-v1-' + target + '.json';
const targetBytes = await get('targets/' + descriptor);
assert.equal(hash(targetBytes), metadata.signed.targets[descriptor].hashes.sha256, descriptor);
const info = JSON.parse(targetBytes);
assert.equal(basename(archive), info.artifact);
const digest = createHash('sha256');
for await (const chunk of createReadStream(archive)) digest.update(chunk);
assert.equal(digest.digest('hex'), metadata.signed.targets[info.artifact].hashes.sha256, info.artifact);
const manifest = readFileSync(join(packageDir, 'manifest.json'));
assert.equal(hash(manifest), info.manifestSha256, 'application manifest');
const files = JSON.parse(manifest).files;
const snapshot = fileURLToPath(new URL('./released-source/' + target + '/', import.meta.url));
const inScope = name => /^(?:compat\/[^/]+\/)?(?:sunphi-network-next|sunphi-wander-lab|duebyte-node-installer-20261119|integrations)\//.test(name) && /\.(?:mjs|cjs|js|html|css|py|sh|ps1|go|xml)$/.test(name) && !name.split('/').includes('node_modules');
const expected = Object.keys(files).filter(inScope).sort();
function walk(dir, prefix = '') {
  return readdirSync(dir, {withFileTypes:true}).flatMap(entry => {
    const name = prefix + entry.name;
    return entry.isDirectory() ? walk(join(dir, entry.name), name + '/') : [name];
  });
}
assert.deepEqual(walk(snapshot).sort(), expected, 'review tree inventory');
for (const [name, sha] of Object.entries(files)) {
  assert(!name.includes('\\') && !name.startsWith('/') && !name.split('/').includes('..'), name);
  assert.equal(hash(readFileSync(resolve(packageDir,name))), sha, name);
}
for (const name of expected) assert.equal(hash(readFileSync(join(snapshot,name))), files[name], name);
console.log(info.artifact, 'verified:', signers.size, 'trusted signatures,', Object.keys(files).length, 'application files,', expected.length, 'published source files');

