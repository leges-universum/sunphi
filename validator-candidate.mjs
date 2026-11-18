// Run with the Node runtime shipped in the Server release.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

const [command, stateArg, expectedKey] = process.argv.slice(2);
assert(['status', 'run'].includes(command), 'Use status STATE or run STATE PUBLIC_KEY');
const root = fs.realpathSync(path.dirname(path.dirname(process.execPath)));
const state = fs.realpathSync(stateArg);
const modules = path.join(root, 'sunphi-network-next/checkpoint-trial');
const load = name => import(pathToFileURL(path.join(modules, name + '.mjs')));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const {loadRelease} = await load('update-core');
const release = loadRelease(root);
assert.equal(release.version, '0.3.107');
assert.equal(release.edition, 'server');
const {homeLaunchProfile} = await load('consumer-launch-profile');
const {consumerNodeHome, assertConsumerStopped} = await load('consumer-home');
const {consumerTransportArgs, validateConsumerProfile} = await load('consumer-profile');
const {acquireStateAccess} = await load('state-access');
const {rpc} = await load('client');
const {profile, pin} = homeLaunchProfile(root, state);
validateConsumerProfile(profile, pin);
assert.equal(read(path.join(state, 'installation.json')).profileHash, pin);
const home = consumerNodeHome(state);
const comet = path.join(root, 'sunphi-network-next/.local/bft-runtime/bin/cometbft');
const publicKey = JSON.parse(execFileSync(comet, ['show-validator', '--home', home], {encoding:'utf8'})).value;
assert.equal(Buffer.from(publicKey, 'base64').length, 32);
const key = Buffer.from(publicKey, 'base64').toString('base64url');
const peer = execFileSync(comet, ['show-node-id', '--home', home], {encoding:'utf8'}).trim();
const local = 'http://127.0.0.1:' + (profile.basePort + 1);

if (command === 'status') {
  const {node_info: node, validator_info: validator, sync_info: sync} = await rpc(local, 'status');
  assert.equal(node.id, peer);
  assert.equal(node.network, profile.config.chainId);
  assert.equal(validator.pub_key.value, publicKey);
  const age = Date.now() - Date.parse(sync.latest_block_time);
  assert(!sync.catching_up && age >= -30000 && age < 180000, 'Wait for a fresh synchronized block');
  // Choose a common committed height even when the local node is a block ahead.
  const urls = [local, ...profile.rpcServers];
  const tips = await Promise.all(urls.map(url => rpc(url, 'status')));
  const height = Math.min(...tips.map(t => Number(t.sync_info.latest_block_height))) - 1;
  assert(height > 0 && height >= Number(sync.latest_block_height) - 12, 'Peers disagree on chain progress');
  const commits = await Promise.all(urls.map(url => rpc(url, 'commit', {height:String(height)})));
  const {header, commit} = commits[0].signed_header;
  for (const c of commits) {
    assert.equal(c.canonical, true);
    assert.equal(c.signed_header.header.chain_id, node.network);
    assert.equal(Number(c.signed_header.header.height), height);
    assert.equal(c.signed_header.commit.block_id.hash, commit.block_id.hash);
    assert.equal(c.signed_header.header.app_hash, header.app_hash);
  }
  console.log(JSON.stringify({network:node.network, version:release.version, peerId:peer,
    validatorKey:key, validatorAddress:validator.address, votingPower:validator.voting_power,
    height, blockHash:commit.block_id.hash, appHash:header.app_hash,
    oldestLocalCometBlock:sync.earliest_block_height, agreeingEndpoints:urls.length}, null, 2));
} else {
  assert.equal(expectedKey, key, 'Provide the exact public validatorKey from the status command');
  const unlock = acquireStateAccess(state);
  const children = new Set();
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    for (const child of children) child.kill('SIGTERM');
  };
  const start = (exe, args) => new Promise(resolve => {
    const child = spawn(exe, args, {stdio:['ignore','inherit','inherit']});
    children.add(child);
    child.once('error', () => {});
    child.once('close', code => { children.delete(child); resolve(code); });
  });
  const tunnel = async host => {
    while (!controller.signal.aborted) {
      await start('ssh', consumerTransportArgs(host, state));
      if (!controller.signal.aborted) await delay(5000, undefined, {signal:controller.signal}).catch(() => {});
    }
  };
  let links = [];
  try {
    assertConsumerStopped(home);
    assert(fs.existsSync(path.join(home, 'application-indexed.sqlite')), 'Complete archive setup before handover');
    assert.equal(read(path.join(home, 'app-config.json')).chainId, profile.config.chainId);
    const pins = profile.hosts.map(h => '[' + h.ip + ']:' + h.port + ' ' + h.pin).join('\n') + '\n';
    assert.equal(fs.readFileSync(path.join(state, 'known_hosts'), 'utf8'), pins);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    links = profile.hosts.map(tunnel);
    const result = await start(process.execPath, [path.join(modules, 'operator.mjs'), 'run', home]);
    if (!controller.signal.aborted) throw Error('Node supervisor exited with status ' + result);
  } finally {
    stop();
    await Promise.all(links);
    unlock();
  }
}
