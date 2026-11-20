// Read public CometBFT data from the witness's own synchronized local node.
import assert from 'node:assert/strict';
import {createHash, createPublicKey, verify} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const concat = (...parts) => Buffer.concat(parts);
function varint(value) {
  assert(Number.isSafeInteger(value) && value >= 0);
  const bytes = [];
  while (value >= 128) {
    bytes.push(value % 128 + 128);
    value = Math.floor(value / 128);
  }
  return Buffer.from([...bytes, value]);
}
const number = (tag, value) => value ? concat(varint(tag * 8), varint(value)) : Buffer.alloc(0);
const blob = (tag, data) => concat(varint(tag * 8 + 2), varint(data.length), data);
function fixed64(tag, value) {
  if (!value) return Buffer.alloc(0);
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(BigInt(value));
  return concat(varint(tag * 8 + 1), bytes);
}

// CanonicalVote for CometBFT v0.38, preserving the timestamp's nanoseconds.
export function signBytes(commit, sig, chain) {
  const time = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(sig.timestamp);
  assert(time);
  const seconds = Date.parse(time[1] + 'Z') / 1000;
  const nanos = Number((time[2] ?? '').padEnd(9, '0'));
  const parts = commit.block_id.parts;
  const id = concat(blob(1, Buffer.from(commit.block_id.hash, 'hex')),
    blob(2, concat(number(1, parts.total), blob(2, Buffer.from(parts.hash, 'hex')))));
  const vote = concat(number(1, 2), fixed64(2, Number(commit.height)), fixed64(3, commit.round),
    blob(4, id), blob(5, concat(number(1, seconds), number(2, nanos))), blob(6, Buffer.from(chain)));
  return concat(varint(vote.length), vote);
}

export function checkCommit(chain, height, signed, roster, successor) {
  const {header, commit} = signed.signed_header;
  assert(signed.canonical && header.chain_id === chain && successor.chain_id === chain);
  assert.equal(Number(header.height), height);
  assert.equal(Number(commit.height), height);
  assert.equal(Number(successor.height), height + 1);
  assert.equal(successor.last_block_id.hash, commit.block_id.hash);
  assert.equal(Number(roster.block_height), height);
  assert.equal(roster.validators.length, Number(roster.total));
  assert.equal(commit.signatures.length, roster.validators.length);
  const voters = {}, seen = new Set();
  let signedPower = 0n, total = 0n;
  for (const [i, member] of roster.validators.entries()) {
    assert.equal(member.pub_key.type, 'tendermint/PubKeyEd25519');
    const pub = Buffer.from(member.pub_key.value, 'base64');
    assert.equal(pub.length, 32);
    const address = createHash('sha256').update(pub).digest('hex').slice(0, 40).toUpperCase();
    assert.equal(address, member.address);
    assert(!seen.has(address));
    seen.add(address);
    const power = BigInt(member.voting_power);
    assert(power > 0n);
    total += power;
    const sig = commit.signatures[i];
    assert([1, 2, 3].includes(sig.block_id_flag));
    const row = {power: power.toString(), precommit: null};
    voters[address] = row;
    if (sig.block_id_flag !== 2) continue;
    assert.equal(sig.validator_address, address);
    const key = createPublicKey({key: {kty: 'OKP', crv: 'Ed25519', x: pub.toString('base64url')}, format: 'jwk'});
    assert(verify(null, signBytes(commit, sig, chain), key, Buffer.from(sig.signature, 'base64')), 'Invalid precommit');
    row.precommit = sig.signature;
    signedPower += power;
  }
  assert(signedPower * 3n > total * 2n, 'No block quorum');
  return {height, blockHash: commit.block_id.hash, total: String(total), signedPower: String(signedPower), voters};
}

async function readCommit(rpc, chain, height, previousHash) {
  assert(Number.isSafeInteger(height) && height > 0);
  const [signed, roster, next] = await Promise.all([
    rpc('commit', {height: String(height)}),
    rpc('validators', {height: String(height), page: '1', per_page: '100'}),
    rpc('block', {height: String(height + 1)})
  ]);
  if (previousHash !== undefined) assert.equal(signed.signed_header.header.last_block_id.hash, previousHash, 'Broken block sequence');
  return checkCommit(chain, height, signed, roster, next.block.header);
}

// Read a completed pilot once. The two bounds must bracket all guest tenures.
export async function scanPilot(rpc, chain, first, last, address) {
  assert(Number.isSafeInteger(first) && first > 0 && Number.isSafeInteger(last) && last > first && last - first <= 2003,
    'Choose a completed interval of 2 to 2004 blocks');
  assert(/^[0-9A-F]{40}$/.test(address), 'Expected a CometBFT address');
  const before = await readCommit(rpc, chain, first);
  const incumbents = Object.keys(before.voters);
  assert(!before.voters[address] && incumbents.length === 10 && incumbents.every(key => before.voters[key].power === '10'),
    'Start before the pilot with the ten permanent validators');
  let previous = before, firstVote = null, holder = null, signedBlocks = 0;
  const tenures = [];
  for (let height = first + 1; height <= last; height++) {
    const block = await readCommit(rpc, chain, height, previous.blockHash);
    assert(incumbents.every(key => block.voters[key]?.power === before.voters[key].power), 'Permanent roster changed at ' + height);
    const guests = Object.keys(block.voters).filter(key => !before.voters[key]);
    assert(guests.length <= 1 && guests.every(key => block.voters[key].power === '1'), 'Guest weight exceeded at ' + height);
    const next = guests[0] ?? null;
    if (holder !== next) {
      if (holder) tenures.at(-1).firstHeightAbsent = height;
      if (next) tenures.push({address: next, firstHeightPresent: height});
      holder = next;
    }
    if (block.voters[address]?.precommit) {
      firstVote ??= block;
      signedBlocks++;
    }
    previous = block;
  }
  assert.equal(holder, null, 'End after the last guest leaves the roster');
  return {chain, address, before, after: previous, blocksChecked: last - first + 1, tenures,
    signedBlocks, firstVote, outcome: firstVote ? 'guest-signed' : 'no-guest-signature'};
}

export async function witness(rpc, chain, height, trial) {
  const vote = await readCommit(rpc, chain, height);
  if (!trial) return {chain, vote};
  const {before, after, address} = trial;
  assert(before < height && height < after && /^[0-9A-F]{40}$/.test(address));
  const [entry, exit] = await Promise.all([readCommit(rpc, chain, before), readCommit(rpc, chain, after)]);
  assert(!entry.voters[address] && !exit.voters[address], 'Candidate present outside term');
  const guest = vote.voters[address];
  assert(guest && guest.power === '1' && guest.precommit, 'No signed weight-one guest vote');
  const powers = voters => Object.fromEntries(Object.entries(voters).map(([key, row]) => [key, row.power]));
  const incumbentPowers = powers(vote.voters);
  delete incumbentPowers[address];
  assert.deepEqual(incumbentPowers, powers(entry.voters), 'Incumbents changed on entry');
  assert.deepEqual(incumbentPowers, powers(exit.voters), 'Incumbents changed on exit');
  const report = {chain, address, before: entry, vote, after: exit};
  if (trial.from !== undefined) {
    assert(Number.isSafeInteger(trial.from) && before < trial.from && trial.from <= height && height - trial.from <= 2002);
    for (let earlier = trial.from; earlier < height; earlier++) {
      const block = await readCommit(rpc, chain, earlier);
      assert(!block.voters[address]?.precommit, 'An earlier guest signature exists at ' + earlier);
    }
    report.firstCheckedHeight = trial.from;
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const scanning = args[0] === '--scan';
  if (scanning) args.shift();
  assert(scanning ? args.length === 6 : [4, 7, 8].includes(args.length),
    'Use --scan RPC CHAIN BEFORE AFTER GUEST_ADDRESS OUTPUT, or RPC CHAIN VOTE_HEIGHT OUTPUT [BEFORE AFTER GUEST [FIRST_ELIGIBLE_HEIGHT]]');
  const [endpoint, chain] = args;
  const url = new URL(endpoint);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1', 'Use your verified local node or SSH tunnel');
  async function rpc(method, params) {
    const r = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, redirect: 'error',
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}), signal: AbortSignal.timeout(15000)});
    assert(r.ok);
    const data = await r.json();
    assert(!data.error, JSON.stringify(data.error));
    return data.result;
  }
  if (scanning) {
    const [, , start, end, guest, filename] = args;
    const result = await scanPilot(rpc, chain, Number(start), Number(end), guest);
    fs.writeFileSync(filename, JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
    console.log(result.outcome, 'blocks', result.blocksChecked, 'first vote', result.firstVote?.height ?? 'none');
    if (!result.firstVote) process.exitCode = 2;
  } else {
    const [, , height, output, before, after, address, from] = args;
    const report = await witness(rpc, chain, Number(height), address ? {
      before: Number(before), after: Number(after), address, from: from === undefined ? undefined : Number(from)
    } : null);
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
    console.log('Verified block', height, 'signed weight', report.vote.signedPower, '/', report.vote.total);
  }
}
