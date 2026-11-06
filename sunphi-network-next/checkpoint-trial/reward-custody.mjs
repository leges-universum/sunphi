// Offline preparation only: outputs signed public wires, never broadcasts.
import assert from 'node:assert/strict';
import {sign,hash,keys} from './crypto.mjs';
import {envelope,stateHash} from './core.mjs';
import {REWARDS,walletConsent} from './node-rewards.mjs';
import {seal,unseal} from './vault.mjs';
export function createCustodyBackup(config,password){
 const key=keys(),vault=seal(key,password),restored=unseal(vault,password);assert.deepEqual(restored,key);
 return{format:'DueByte reward management backup',network:config.chainId,configHash:hash(config),publicKey:key.publicKey,vault};
}
export function restoreCustodyBackup(backup,config,password){
 assert.equal(backup.format,'DueByte reward management backup');assert.equal(backup.network,config.chainId);assert.equal(backup.configHash,hash(config));
 const key=unseal(backup.vault,password);assert.equal(key.publicKey,backup.publicKey);return key;
}
export function prepareManagementChange({config,state,node,currentKey,newKey}){
 stateHash(state,config);const account=state.rewards.nodes[node];assert(account);assert.equal(account.management,currentKey.publicKey);assert.notEqual(account.key,newKey.publicKey);
 const body={domain:REWARDS+'/MANAGEMENT',configHash:hash(config),node,sequence:account.sequence+1,management:newKey.publicKey};
 return envelope(config,{type:'SET_REWARD_MANAGEMENT_V1',body,signature:sign(body,currentKey.privateKey),newSignature:sign(body,newKey.privateKey)},currentKey);
}
export function prepareRewardPayout({config,state,node,managementKey,recipients}){
 stateHash(state,config);const account=state.rewards.nodes[node];assert(account);assert.equal(account.management,managementKey.publicKey);
 assert(recipients.length>=1&&recipients.length<=16);assert(new Set(recipients.map(r=>r.key.publicKey)).size===recipients.length);
 const body={domain:REWARDS+'/BIND',configHash:hash(config),node,sequence:account.sequence+1,payouts:recipients.map(r=>({wallet:r.key.publicKey,weight:r.weight}))};
 return envelope(config,{type:'BIND_REWARD_WALLETS_V1',body,signature:sign(body,managementKey.privateKey),consents:recipients.map(r=>sign(walletConsent(hash(config),node,r.key.publicKey),r.key.privateKey))},managementKey);
}
