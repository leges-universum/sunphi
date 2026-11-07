import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createPrivateKey,createPublicKey} from 'node:crypto';
import {keys,hash,sign,verify} from './crypto.mjs';
import {REWARDS,rewardNodeId,walletConsent} from './node-rewards.mjs';

export function prepareRewardIdentity(home,config){
 const file=join(home,'reward-identity.json');
 if(!existsSync(file))writeFileSync(file,JSON.stringify({version:1,network:config.chainId,configHash:hash(config),work:keys(),management:keys()}),{flag:'wx',mode:0o600,flush:true});
 const identity=readRewardIdentity(home,config.chainId);assert.equal(identity.configHash,hash(config),'retained reward network');return identity;
}
export function readRewardIdentity(home,network){
 const file=join(home,'reward-identity.json');if(!existsSync(file))return null;
 const r=JSON.parse(readFileSync(file,'utf8'));assert.equal(r.version,1);assert.equal(r.network,network);assert(verify({domain:REWARDS},sign({domain:REWARDS},r.work.privateKey),r.work.publicKey),'retained work identity');assert(verify({domain:REWARDS},sign({domain:REWARDS},r.management.privateKey),r.management.publicKey),'retained payout authority');
 return {...r,node:rewardNodeId(r.configHash,r.work.publicKey)};
}
export const walletRewardIdentity=(walletHome,network)=>readRewardIdentity(dirname(walletHome),network);
export function validRewardConsent(identity,wallet,consent){
 try{return !!identity&&consent?.node===identity.node&&consent.wallet===wallet&&verify(walletConsent(identity.configHash,identity.node,wallet),consent.signature,wallet);}catch{return false;}
}
export function rewardWalletConsent(walletHome,network,key){const identity=walletRewardIdentity(walletHome,network);return identity?{node:identity.node,wallet:key.publicKey,signature:sign(walletConsent(identity.configHash,identity.node,key.publicKey),key.privateKey)}:null;}
export function registrationAction(home,identity){
 // CometBFT's existing peer identity authorizes enrollment only. A separate key controls payouts.
 const raw=JSON.parse(readFileSync(join(home,'node/config/node_key.json'),'utf8')).priv_key;assert.equal(raw.type,'tendermint/PrivKeyEd25519');const bytes=Buffer.from(raw.value,'base64');assert.equal(bytes.length,64);
 const privateKey=Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),bytes.subarray(0,32)]).toString('base64url');
 const key=createPrivateKey({key:Buffer.from(privateKey,'base64url'),format:'der',type:'pkcs8'}),publicKey=createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32).toString('base64url');assert.equal(publicKey,bytes.subarray(32).toString('base64url'));
 const body={domain:REWARDS+'/REGISTER',configHash:identity.configHash,identity:publicKey,work:identity.work.publicKey,management:identity.management.publicKey};
 return {type:'REGISTER_REWARD_NODE_V1',body,identitySignature:sign(body,privateKey),workSignature:sign(body,identity.work.privateKey),managementSignature:sign(body,identity.management.privateKey)};
}
