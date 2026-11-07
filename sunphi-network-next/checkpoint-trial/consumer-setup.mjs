// Non-voting consumer setup, separate from validator/attester ceremonies.
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {hash} from './crypto.mjs';
import {verifyCheckpoint} from './checkpoint.mjs';
import {configure} from './operator.mjs';
import {validateConsumerProfile} from './consumer-profile.mjs';
import {prepareRewardIdentity} from './reward-identity.mjs';
import {refreshConsumerBootstrap} from './consumer-bootstrap.mjs';
const read=f=>JSON.parse(readFileSync(f));
const write=(f,x)=>writeFileSync(f,JSON.stringify(x,null,2),{flag:'wx',mode:0o600});
export function consumerIdentity(state,p,expectedHash){
 validateConsumerProfile(p,expectedHash);state=resolve(state);mkdirSync(state,{recursive:true,mode:0o700});
 const binding=join(state,'installation.json');
 if(existsSync(binding))assert.equal(read(binding).profileHash,expectedHash,'existing installation belongs to another network profile');
 else {assert(!existsSync(join(state,'node'))&&!existsSync(join(state,'wallet')),'unbound existing state must not be adopted');write(binding,{version:1,profileHash:expectedHash,network:p.config.chainId});}
 const key=join(state,'transport-key'),exe='ssh-keygen'+(process.platform==='win32'?'.exe':'');
 if(!existsSync(key)){assert(!existsSync(key+'.pub'),'incomplete device identity');const r=spawnSync(exe,['-q','-t','ed25519','-N','','-C','duebyte-device','-f',key],{windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(r.status,0,'OpenSSH Client is required');}
 const result=spawnSync(exe,['-y','-f',key],{windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(result.status,0,'cannot read retained device identity');
 const publicKey=result.stdout.trim().split(/\s+/).slice(0,2).join(' '),device=join(state,'device.json');
 assert(/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(publicKey));
 if(existsSync(device))assert.equal(read(device).publicKey,publicKey,'device key changed');else write(device,{id:hash({publicKey}),publicKey});
 writeFileSync(join(state,'known_hosts'),p.hosts.map(h=>`[${h.ip}]:${h.port} ${h.pin}`).join('\n')+'\n',{mode:0o600});return read(device);
}
export function prepareConsumer(state,p,expectedHash,checkpoint){
 validateConsumerProfile(p,expectedHash);assert.equal(read(join(state,'installation.json')).profileHash,expectedHash);
 verifyCheckpoint(checkpoint,p.policy);
 const node=join(state,'node'),wallet=join(state,'wallet');
 if(!existsSync(node)){
  // An interrupted staging directory is preserved. No keys or journals are reset.
  const pending=join(state,'node-preparing');assert(!existsSync(pending),'interrupted node preparation requires inspection; saved files retained');
  const bin=resolve(import.meta.dirname,'../.local/bft-runtime/bin/cometbft'+(process.platform==='win32'?'.exe':''));
  const r=spawnSync(bin,['init','--home',pending],{windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(r.status,0,'node initialization');
  const key=read(join(pending,'config/priv_validator_key.json'));assert(!p.genesis.validators.some(v=>v.pub_key.value===key.pub_key.value),'consumer must be non-voting');
  const profile=join(pending,'bootstrap');mkdirSync(profile);
  for(const [name,data] of Object.entries({'genesis.json':p.genesis,'app-config.json':p.config,'trust-policy.json':p.policy,'checkpoint.json':checkpoint,'operators-public.json':p.peers.map(x=>({peerId:x.id,endpoint:`127.0.0.1:${x.port}`}))}))write(join(profile,name),data);
  configure(pending,profile,hash(p.policy),{basePort:p.basePort,listen:'127.0.0.1',stateSync:true,rpcServers:p.rpcServers});
  const toml=join(pending,'config/config.toml');let text=readFileSync(toml,'utf8');for(const [k,v] of Object.entries({addr_book_strict:'false',allow_duplicate_ip:'true',max_num_inbound_peers:'0',pprof_laddr:'""'}))text=text.replace(new RegExp('^'+k+' = .*$','m'),k+' = '+v);writeFileSync(toml,text);
  renameSync(pending,node);
 }else{
  assert.equal(hash(read(join(node,'config/genesis.json'))),p.policy.genesisHash,'retained node genesis differs');
  assert.equal(hash(read(join(node,'app-config.json'))),hash(p.config));
  assert.equal(hash(read(join(node,'trust-policy.json'))),hash(p.policy));
  assert(!p.genesis.validators.some(v=>v.pub_key.value===read(join(node,'config/priv_validator_key.json')).pub_key.value),'consumer must be non-voting');
  assert.equal(read(join(node,'run-settings.json')).isValidator,false);
 }
 if(!existsSync(wallet)){
  const pending=join(state,'wallet-preparing');assert(!existsSync(pending),'interrupted wallet preparation requires inspection; saved files retained');mkdirSync(pending,{mode:0o700});
  for(const [name,data] of Object.entries({'genesis.json':p.genesis,'app-config.json':p.config,'trust-policy.json':p.policy,'checkpoint.json':checkpoint,'connections.json':{rpc:p.rpcServers[0],workers:p.workers}}))write(join(pending,name),data);
  renameSync(pending,wallet);
 }else{assert.equal(hash(read(join(wallet,'genesis.json'))),p.policy.genesisHash);assert.equal(hash(read(join(wallet,'trust-policy.json'))),hash(p.policy));assert.equal(hash(read(join(wallet,'connections.json'))),hash({rpc:p.rpcServers[0],workers:p.workers}));}
 const rewards=prepareRewardIdentity(state,p.config);assert.equal(rewards.configHash,hash(p.config));
 refreshConsumerBootstrap(node,p.config,p.policy,checkpoint);
 return {node,wallet,trustHash:hash(p.policy)};
}
