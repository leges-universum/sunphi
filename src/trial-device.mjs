// Public trust is bundled; transport keys originate on each device. No validator keys are distributed.
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {digest} from './protocol.mjs';
import {validateNodeLaunch} from './node-launch-policy.mjs';
export const trialBase=34400;
export function requestId(publicKey){return createHash('sha256').update(publicKey).digest('hex');}
export function validateRequest(r,trust){
 if(r?.version!==1||r.chain!==trust.chain||r.genesis!==trust.genesis||!/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(r.publicKey??'')||r.id!==requestId(r.publicKey))throw Error('Invalid device request');
 const b=Buffer.from(r.publicKey.split(' ')[1],'base64');if(b.length!==51||b.readUInt32BE(0)!==11||b.subarray(4,15).toString()!=='ssh-ed25519'||b.readUInt32BE(15)!==32)throw Error('Invalid Ed25519 key');
 return r;
}
export function loadTrust(root){
 const t=JSON.parse(readFileSync(join(root,'profile/trial.json'))),g=JSON.parse(readFileSync(join(root,'profile/genesis.json')));
 if(t.version!==1||t.chain!=='sunphi-lab-wan-20261030-a'||g.chain_id!==t.chain||digest(g)!==t.genesis||t.hosts.length!==3)throw Error('Trial trust mismatch');
 for(const h of t.hosts){if(!/^\d+\.\d+\.\d+\.\d+$/.test(h.ip)||!/^ssh-ed25519 [A-Za-z0-9+/]{68}(?: .*)?$/.test(h.pin)||h.user!=='sunphitest')throw Error('Pinned transport configuration');}
 return t;
}
export function deviceRequest(root,state){
 const trust=loadTrust(root);mkdirSync(state,{recursive:true,mode:0o700});const key=join(state,'transport-key'),pub=key+'.pub';
 if(!existsSync(key)){if(existsSync(pub))throw Error('Incomplete transport identity; retain files and contact the operator');execFileSync('ssh-keygen'+(process.platform==='win32'?'.exe':''),['-q','-t','ed25519','-N','','-C','sunphi-trial-device','-f',key],{stdio:'pipe',windowsHide:true});}
 // Derive the public key from the retained private key, detecting mismatched copies.
 const publicKey=execFileSync('ssh-keygen'+(process.platform==='win32'?'.exe':''),['-y','-f',key],{encoding:'utf8',stdio:'pipe',windowsHide:true}).trim().split(/\s+/).slice(0,2).join(' ');
 const r=validateRequest({version:1,chain:trust.chain,genesis:trust.genesis,publicKey,id:requestId(publicKey)},trust);
 if(existsSync(join(state,'device.json'))&&JSON.parse(readFileSync(join(state,'device.json'))).id!==r.id)throw Error('Retained device identity changed');
 if(!existsSync(join(state,'device.json')))writeFileSync(join(state,'device.json'),JSON.stringify(r,null,2),{flag:'wx',mode:0o600});
 writeFileSync(join(state,'known_hosts'),trust.hosts.map(h=>h.ip+' '+h.pin).join('\n')+'\n',{mode:0o600});return r;
}
export function prepareFollower(root,state){
 const trust=loadTrust(root),home=join(state,'follower'),ext=process.platform==='win32'?'.exe':'';
 if(existsSync(home)){
  const g=JSON.parse(readFileSync(join(home,'config/genesis.json')));if(digest(g)!==trust.genesis)throw Error('Existing follower belongs to another chain');
  const k=JSON.parse(readFileSync(join(home,'config/priv_validator_key.json')));if(g.validators.some(v=>v.pub_key.value===k.pub_key.value))throw Error('Refusing a voting identity in a download client');
  validateNodeLaunch(JSON.parse(readFileSync(join(home,'app-config.json'))),readFileSync(join(home,'config/config.toml'),'utf8'),trialBase);return home;
 }
 execFileSync(join(root,'runtime/bin/cometbft'+ext),['init','--home',home],{stdio:'pipe',windowsHide:true});
 const g=JSON.parse(readFileSync(join(root,'profile/genesis.json')));
 copyFileSync(join(root,'profile/genesis.json'),join(home,'config/genesis.json'));copyFileSync(join(root,'profile/verification-key.json'),join(home,'verification-key.json'));
 writeFileSync(join(home,'app-config.json'),JSON.stringify(g.app_state),{flag:'wx'});
 let toml=readFileSync(join(home,'config/config.toml'),'utf8');
 for(const [a,b] of [['tcp://127.0.0.1:26658',`tcp://127.0.0.1:${trialBase+2}`],['tcp://127.0.0.1:26657',`tcp://127.0.0.1:${trialBase+1}`],['tcp://0.0.0.0:26656',`tcp://127.0.0.1:${trialBase}`]])toml=toml.replace(a,b);
 for(const [k,v] of Object.entries({persistent_peers:JSON.stringify(trust.hosts.map(h=>h.peer+'@127.0.0.1:'+h.p2p).join(',')),addr_book_strict:'false',allow_duplicate_ip:'true',pex:'false',timeout_commit:'"10s"',log_level:'"error"',max_num_outbound_peers:'3',max_num_inbound_peers:'0',pprof_laddr:'""'}))toml=toml.replace(new RegExp('^'+k+' = .*$','m'),k+' = '+v);
 validateNodeLaunch(g.app_state,toml,trialBase);writeFileSync(join(home,'config/config.toml'),toml);return home;
}
export function transportArgs(trust,index,state){const h=trust.hosts[index],pins=join(state,'known_hosts').replaceAll('\\','/');if(/["\r\n]/.test(pins))throw Error('Unsupported identity path');return ['-F',process.platform==='win32'?'none':'/dev/null','-N','-T','-i',join(state,'transport-key'),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile="'+pins+'"','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3','-o','ConnectTimeout=10',...h.forwards.flatMap(([local,remote])=>['-L',`127.0.0.1:${local}:127.0.0.1:${remote}`]),h.user+'@'+h.ip];}
