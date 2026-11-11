// Mandatory production-daemon coordination. Credentials cannot override policy.
import assert from 'node:assert/strict';
import {exact,hash} from '../crypto.mjs';
import {remoteCoordinator} from './exchange-coordinator-service.mjs';
export async function connectSigningCoordinator(profile,secrets){
 const policy=profile.backendConfig?.coordinator,credentials=secrets.backendSecrets?.coordinator;
 assert(policy&&credentials,'independent coordinator configuration required');
 exact(policy,['url','serverFingerprint','timeoutMs']);exact(credentials,['key','cert','ca']);
 for(const field of ['key','cert','ca'])assert(typeof credentials[field]==='string'&&credentials[field].length>0&&credentials[field].length<=16384);
 const channel=remoteCoordinator({...policy,...credentials});
 assert.equal(await channel.scope(),hash(profile.config),'coordinator network policy mismatch');
 // Read-only authenticated reachability check before loading the key backend.
 const probe=hash(['DUEBYTE_SIGNER_COORDINATOR_PROBE',hash(profile.config)]);
 assert.equal(await channel.get({order:probe,purpose:'FUNDING',attempt:0,request:probe}),null,'reserved coordinator probe');
 return channel;
}
