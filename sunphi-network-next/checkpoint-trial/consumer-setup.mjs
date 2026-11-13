// Non-voting consumer setup, separate from validator/attester ceremonies.
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,openSync,closeSync,fsyncSync,copyFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join,resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {hash} from './crypto.mjs';
import {verifyCheckpoint} from './checkpoint.mjs';
import {configure} from './operator.mjs';
import {validateConsumerProfile,consumerConnections} from './consumer-profile.mjs';
import {prepareRewardIdentity} from './reward-identity.mjs';
import {refreshConsumerBootstrap} from './consumer-bootstrap.mjs';
import {consumerNodeHome,assertConsumerStopped} from './consumer-home.mjs';
import {requireConsumerIndexedCheckpoint} from './consumer-indexed.mjs';
import {verifyConsumerSchemaPredecessor} from './consumer-schema.mjs';
const read=f=>JSON.parse(readFileSync(f));
const write=(f,x)=>writeFileSync(f,JSON.stringify(x,null,2),{flag:'wx',mode:0o600});
function checkBinding(state,p,expectedHash){
 const b=read(join(state,'installation.json'));assert.equal(b.network,p.config.chainId,'installation network');
 if(b.profileHash===expectedHash){
  if(p.schemaUpgrade){assert.equal(b.nodeDirectory,'node-schema-v15');assert.equal(b.transitionHash,hash(p.schemaUpgrade.certificate));}
  else if(p.fresh){assert.equal(b.nodeDirectory,'node-fresh-v1');assert.equal(b.manifestHash,p.fresh.manifestHash);}
  else if(p.indexed){assert.equal(b.nodeDirectory,'node-indexed-v6');assert.equal(b.transitionHash,hash(p.indexed.certificate));}
  else assert.equal(b.nodeDirectory??'node','node','indexed installation cannot downgrade');
  return false;
 }
 if(p.schemaUpgrade){
  assert.equal(b.profileHash,p.schemaUpgrade.previousProfileHash,'schema predecessor profile');assert.equal(b.nodeDirectory,'node-fresh-v1');assert.equal(b.manifestHash,p.schemaUpgrade.previousManifestHash);assert(!b.transitionHash);
  assertConsumerStopped(join(state,'node-fresh-v1'));return true;
 }
 assert(p.indexed&&b.profileHash===p.indexed.previousProfileHash&&!b.transitionHash&&(b.nodeDirectory??'node')==='node','existing installation belongs to another network profile');
 assertConsumerStopped(join(state,'node'));return true;
}
function checkSavedNode(node,p){
 assert.equal(hash(read(join(node,'config/genesis.json'))),p.policy.genesisHash,'retained node genesis differs');
 assert.equal(hash(read(join(node,'app-config.json'))),hash(p.config));
 assert.equal(hash(read(join(node,'trust-policy.json'))),hash(p.policy));
 assert(!p.genesis.validators.some(v=>v.pub_key.value===read(join(node,'config/priv_validator_key.json')).pub_key.value),'consumer must be non-voting');
 assert.equal(read(join(node,'run-settings.json')).isValidator,false);
}
function checkSavedWallet(wallet,p){
 assert.equal(hash(read(join(wallet,'genesis.json'))),p.policy.genesisHash);
 assert.equal(hash(read(join(wallet,'app-config.json'))),hash(p.config));
 assert.equal(hash(read(join(wallet,'trust-policy.json'))),hash(p.policy));
 assert.equal(hash(read(join(wallet,'connections.json'))),hash(consumerConnections(p)));
}
const bindingFor=(p,expectedHash)=>({version:1,profileHash:expectedHash,network:p.config.chainId,...(p.schemaUpgrade?{nodeDirectory:'node-schema-v15',transitionHash:hash(p.schemaUpgrade.certificate)}:p.fresh?{nodeDirectory:'node-fresh-v1',manifestHash:p.fresh.manifestHash}:p.indexed?{nodeDirectory:'node-indexed-v6',transitionHash:hash(p.indexed.certificate)}:{})});
function commitBinding(file,value){
 const next=file+'.'+randomUUID()+'.pending',fd=openSync(next,'wx',0o600);
 try{writeFileSync(fd,JSON.stringify(value,null,2));fsyncSync(fd);}finally{closeSync(fd);}renameSync(next,file);
 if(process.platform!=='win32'){const directory=openSync(dirname(file),'r');try{fsyncSync(directory);}finally{closeSync(directory);}}
}
function pinnedFile(file,value){if(existsSync(file))assert.equal(hash(read(file)),hash(value),'retained indexed settings conflict');else commitBinding(file,value);}
export function consumerIdentity(state,p,expectedHash){
 validateConsumerProfile(p,expectedHash);state=resolve(state);mkdirSync(state,{recursive:true,mode:0o700});
 const binding=join(state,'installation.json');
 if(existsSync(binding))checkBinding(state,p,expectedHash);
 else {assert(!['node','node-indexed-v6','node-fresh-v1','node-schema-v15','wallet'].some(n=>existsSync(join(state,n))),'unbound existing state must not be adopted');write(binding,bindingFor(p,expectedHash));}
 const key=join(state,'transport-key'),exe='ssh-keygen'+(process.platform==='win32'?'.exe':'');
 if(!existsSync(key)){assert(!existsSync(key+'.pub'),'incomplete device identity');const r=spawnSync(exe,['-q','-t','ed25519','-N','','-C','duebyte-device','-f',key],{windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(r.status,0,'OpenSSH Client is required');}
 const result=spawnSync(exe,['-y','-f',key],{windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(result.status,0,'cannot read retained device identity');
 const publicKey=result.stdout.trim().split(/\s+/).slice(0,2).join(' '),device=join(state,'device.json');
 assert(/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(publicKey));
 if(existsSync(device))assert.equal(read(device).publicKey,publicKey,'device key changed');else write(device,{id:hash({publicKey}),publicKey});
 writeFileSync(join(state,'known_hosts'),p.hosts.map(h=>`[${h.ip}]:${h.port} ${h.pin}`).join('\n')+'\n',{mode:0o600});return read(device);
}
export function prepareConsumer(state,p,expectedHash,checkpoint,indexedEvidence=null){
 validateConsumerProfile(p,expectedHash);const switching=checkBinding(state,p,expectedHash);
 verifyCheckpoint(checkpoint,p.policy);
 const node=join(state,p.schemaUpgrade?'node-schema-v15':p.fresh?'node-fresh-v1':p.indexed?'node-indexed-v6':'node'),wallet=join(state,'wallet');
 const predecessor=p.schemaUpgrade?join(state,'node-fresh-v1'):p.indexed?join(state,'node'):null;
 if(p.schemaUpgrade){
  requireConsumerIndexedCheckpoint(p,checkpoint,indexedEvidence);assertConsumerStopped(node);
  assert(!existsSync(join(state,'node'))&&!existsSync(join(state,'node-indexed-v6')),'unexpected predecessor home');
  if(existsSync(predecessor)){assertConsumerStopped(predecessor);checkSavedNode(predecessor,p);verifyConsumerSchemaPredecessor(p.config,read(join(predecessor,'fresh-activation.json')),p.schemaUpgrade);}
  if(existsSync(join(wallet,'indexed-wallet.json'))){const saved=read(join(wallet,'indexed-wallet.json')).bounded;if(saved.fresh)verifyConsumerSchemaPredecessor(p.config,saved.fresh,p.schemaUpgrade);else assert.equal(hash(saved),hash({url:p.schemaUpgrade.url,schemaUpgrade:{certificate:p.schemaUpgrade.certificate,trustedBoundary:p.schemaUpgrade.trustedBoundary}}),'retained wallet schema authority differs');}
 }
 if(p.fresh){requireConsumerIndexedCheckpoint(p,checkpoint,indexedEvidence);assertConsumerStopped(node);assert(!existsSync(join(state,'node'))&&!existsSync(join(state,'node-indexed-v6')),'fresh installation cannot adopt old homes');}
 if(p.indexed){
  requireConsumerIndexedCheckpoint(p,checkpoint,indexedEvidence);assertConsumerStopped(node);
  if(existsSync(join(state,'node'))){assertConsumerStopped(join(state,'node'));checkSavedNode(join(state,'node'),p);}
 }
 if(existsSync(node)){
  checkSavedNode(node,p);
  if(predecessor&&existsSync(join(predecessor,'config/node_key.json')))assert.equal(hash(read(join(node,'config/node_key.json'))),hash(read(join(predecessor,'config/node_key.json'))),'retained peer identity differs');
 }
 if(existsSync(wallet))checkSavedWallet(wallet,p);
 // Commit the one-way profile binding before exposing indexed wallet settings.
 // A restart finishes missing files; an old release rejects the new fingerprint.
 if(switching)commitBinding(join(state,'installation.json'),bindingFor(p,expectedHash));
 assert.equal(consumerNodeHome(state),node);
 if(!existsSync(node)){
  // An interrupted staging directory is preserved. No keys or journals are reset.
  const pending=p.indexed||p.schemaUpgrade?node+'-preparing-'+randomUUID():join(state,'node-preparing');assert(!existsSync(pending),'interrupted node preparation requires inspection; saved files retained');
  const bin=resolve(import.meta.dirname,'../.local/bft-runtime/bin/cometbft'+(process.platform==='win32'?'.exe':''));
  const r=spawnSync(bin,['init','--home',pending],{windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(r.status,0,'node initialization');
  const key=read(join(pending,'config/priv_validator_key.json'));assert(!p.genesis.validators.some(v=>v.pub_key.value===key.pub_key.value),'consumer must be non-voting');
  // Keep the admitted P2P identity, never the validator signing key/high-water.
  // The original home is stopped and retained; only one home may run this peer.
  if(predecessor&&existsSync(join(predecessor,'config/node_key.json')))copyFileSync(join(predecessor,'config/node_key.json'),join(pending,'config/node_key.json'));
  const profile=join(pending,'bootstrap');mkdirSync(profile);
  for(const [name,data] of Object.entries({'genesis.json':p.genesis,'app-config.json':p.config,'trust-policy.json':p.policy,'checkpoint.json':checkpoint,'operators-public.json':p.peers.map(x=>({peerId:x.id,endpoint:`127.0.0.1:${x.port}`}))}))write(join(profile,name),data);
  configure(pending,profile,hash(p.policy),{basePort:p.basePort,listen:'127.0.0.1',stateSync:true,rpcServers:p.rpcServers,...(p.fresh?{fresh:p.fresh}:p.schemaUpgrade?{schemaUpgrade:p.schemaUpgrade}:{})});
  const toml=join(pending,'config/config.toml');let text=readFileSync(toml,'utf8');for(const [k,v] of Object.entries({addr_book_strict:'false',allow_duplicate_ip:'true',max_num_inbound_peers:'0',pprof_laddr:'""'}))text=text.replace(new RegExp('^'+k+' = .*$','m'),k+' = '+v);writeFileSync(toml,text);
  renameSync(pending,node);
 }
 if(!existsSync(wallet)){
  const pending=p.indexed?join(state,'wallet-preparing-'+randomUUID()):join(state,'wallet-preparing');assert(!existsSync(pending),'interrupted wallet preparation requires inspection; saved files retained');mkdirSync(pending,{mode:0o700});
  for(const [name,data] of Object.entries({'genesis.json':p.genesis,'app-config.json':p.config,'trust-policy.json':p.policy,'checkpoint.json':checkpoint,'connections.json':consumerConnections(p)}))write(join(pending,name),data);
  renameSync(pending,wallet);
 }
 if(p.indexed){
  const {readPort,certificate,source,url}=p.indexed;
  pinnedFile(join(node,'indexed-activation.json'),{readPort,certificate,source});
  pinnedFile(join(wallet,'indexed-wallet.json'),{bounded:{url,certificate,source}});
 }
 if(p.fresh){const {manifest,manifestHash,readPort,url}=p.fresh;pinnedFile(join(node,'fresh-activation.json'),{manifest,manifestHash,readPort,bootstrap:true});pinnedFile(join(wallet,'indexed-wallet.json'),{bounded:{url,fresh:{manifest,manifestHash}}});}
 if(p.schemaUpgrade){
  const {certificate,trustedBoundary,readPort,url}=p.schemaUpgrade;
  pinnedFile(join(node,'indexed-schema-activation.json'),{certificate,trustedBoundary,readPort,bootstrap:true});
  const file=join(wallet,'indexed-wallet.json'),value={bounded:{url,schemaUpgrade:{certificate,trustedBoundary}}};
  if(existsSync(file)&&read(file).bounded?.fresh)commitBinding(file,value);else pinnedFile(file,value);
 }
 const rewards=prepareRewardIdentity(state,p.config);assert.equal(rewards.configHash,hash(p.config));
 refreshConsumerBootstrap(node,p.config,p.policy,checkpoint);
 return {node,wallet,trustHash:hash(p.policy)};
}
