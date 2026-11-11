// Public installation profile. The publisher pins its digest in the application;
// neither a renderer nor a remote peer may choose the network or SSH destinations.
import assert from 'node:assert/strict';
import {hash,hex,exact} from './crypto.mjs';
import {verifyBoundedTransitionTerms} from './research/bounded-root-transition.mjs';
import {freshRootTerms} from './research/fresh-application.mjs';
import {validateConfig} from './core.mjs';
import {validatePolicy} from './checkpoint.mjs';
const port=p=>assert(Number.isInteger(p)&&p>=1024&&p<=32760,'profile port');
export function validateConsumerProfile(p,expectedHash){
 hex(expectedHash);assert.equal(hash(p),expectedHash,'installation profile fingerprint');
 assert.equal(p.version,1);validateConfig(p.config);validatePolicy(p.policy);
 assert.equal(hash(p.genesis),p.policy.genesisHash);assert.equal(p.genesis.chain_id,p.config.chainId);
 assert.equal(p.policy.network,p.config.chainId);assert.equal(hash(p.genesis.app_state),hash(p.config));
 assert.equal(p.genesis.validators.length,10);assert(p.genesis.validators.every(v=>String(v.power)==='10'));
 port(p.basePort);port(p.walletPort);assert(p.basePort<=32756);
 const used=new Set([p.basePort,p.basePort+1,p.basePort+2,p.basePort+3,p.walletPort]);assert.equal(used.size,5);
 const reserve=n=>{port(n);assert(!used.has(n),'duplicate local port');used.add(n);};
 assert(Array.isArray(p.hosts)&&p.hosts.length>=2&&p.hosts.length<=8);
 const hosts=new Set(),forwardPorts=new Set();
 for(const h of p.hosts){
  assert(/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h.ip)&&h.ip.split('.').every(x=>Number(x)<=255));
  assert(!hosts.has(h.ip),'duplicate server');hosts.add(h.ip);port(h.port);
  assert(/^[a-z][a-z0-9_-]{0,30}$/.test(h.user));
  assert(/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(h.pin),'pinned server key');
  const pin=Buffer.from(h.pin.split(' ')[1],'base64');assert.equal(pin.length,51);assert.equal(pin.readUInt32BE(0),11);assert.equal(pin.subarray(4,15).toString(),'ssh-ed25519');assert.equal(pin.readUInt32BE(15),32);
  assert(Array.isArray(h.forwards)&&h.forwards.length>0&&h.forwards.length<=32);
  for(const [local,remote] of h.forwards){reserve(local);port(remote);forwardPorts.add(local);}
 }
 const loopback=s=>{const u=new URL(s);assert(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.pathname==='/'&&!u.username&&!u.password&&!u.search&&!u.hash,'fixed loopback route');assert(forwardPorts.has(Number(u.port)),'route lacks pinned transport');};
 assert(p.rpcServers.length>=2&&p.rpcServers.length<=8);p.rpcServers.forEach(loopback);assert.equal(new Set(p.rpcServers).size,p.rpcServers.length);
 assert(p.peers.length>=2&&p.peers.length<=10);const peers=new Set();for(const peer of p.peers){assert(/^[a-f0-9]{40}$/.test(peer.id));assert(!peers.has(peer.id));peers.add(peer.id);assert(forwardPorts.has(peer.port));}
 assert.deepEqual(Object.keys(p.workers).sort(),Object.keys(p.config.initial.nodes).sort());Object.values(p.workers).forEach(loopback);
 assert(!(p.indexed&&p.fresh),'ambiguous consumer state authority');
 if(p.fresh){exact(p.fresh,['manifest','manifestHash','readPort','url']);reserve(p.fresh.readPort);loopback(p.fresh.url);freshRootTerms(p.config,p.fresh);}
 if(p.indexed){
  exact(p.indexed,['previousProfileHash','readPort','url','source','certificate']);
  hex(p.indexed.previousProfileHash);assert.notEqual(p.indexed.previousProfileHash,expectedHash);
  reserve(p.indexed.readPort);loopback(p.indexed.url);
  // The independently pinned release profile authenticates this source; peer
  // checkpoints still authenticate the downloaded state and consensus path.
  verifyBoundedTransitionTerms(p.indexed.certificate,p.indexed.source,p.config,hash(p.indexed.source));
 }
 return p;
}
export function consumerTransportArgs(h,home,platform=process.platform){
 const pins=home.replaceAll('\\','/')+'/known_hosts';assert(!/["\r\n]/.test(pins),'unsupported state path');
 return ['-F',platform==='win32'?'none':'/dev/null','-N','-T','-p',String(h.port),'-i',home+'/transport-key','-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile="'+pins+'"','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3','-o','ConnectTimeout=10',...h.forwards.flatMap(([local,remote])=>['-L',`127.0.0.1:${local}:127.0.0.1:${remote}`]),h.user+'@'+h.ip];
}
