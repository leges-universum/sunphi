// Mandatory production-daemon coordination. Credentials cannot override policy.
import assert from 'node:assert/strict';
import {exact,hash,hex} from '../crypto.mjs';
import {remoteCoordinator} from './exchange-coordinator-service.mjs';
import {pairedCoordinator,recoveryProtectedCoordinator} from './exchange-coordinator-continuity.mjs';
export async function connectSigningCoordinator(profile,secrets){
 const policy=profile.backendConfig?.coordinator,credentials=secrets.backendSecrets?.coordinator;
 assert(policy&&credentials,'independent coordinator configuration required');
 if(Object.hasOwn(policy,'primary')){
  const roles=Object.hasOwn(policy,'recovery')?['primary','witness','recovery']:['primary','witness'];
  exact(policy,roles);exact(credentials,roles);
  assert.equal(new Set(roles.map(r=>policy[r]?.url)).size,roles.length,'distinct witness endpoint required');
  assert.equal(new Set(roles.map(r=>policy[r]?.serverFingerprint)).size,roles.length,'distinct witness identity required');
  assert.equal(new Set(roles.map(r=>credentials[r]?.continuity)).size,roles.length,'distinct continuity grants required');
  const channels=[];
  for(const role of roles){
   const p=policy[role],c=credentials[role];exact(p,['url','serverFingerprint','timeoutMs']);exact(c,['key','cert','ca','continuity']);hex(c.continuity);
   for(const field of ['key','cert','ca'])assert(typeof c[field]==='string'&&c[field].length>0&&c[field].length<=16384);
   const channel=remoteCoordinator({...p,...c});assert.equal(await channel.scope(),hash(profile.config),'coordinator network policy mismatch');channels.push(channel);
  }
  const pair=roles.length===3?recoveryProtectedCoordinator(...channels,hash(profile.config)):pairedCoordinator(...channels,hash(profile.config));
  await pair.checkpoint();return pair;
 }
 exact(policy,['url','serverFingerprint','timeoutMs']);exact(credentials,['key','cert','ca']);
 for(const field of ['key','cert','ca'])assert(typeof credentials[field]==='string'&&credentials[field].length>0&&credentials[field].length<=16384);
 const channel=remoteCoordinator({...policy,...credentials});
 assert.equal(await channel.scope(),hash(profile.config),'coordinator network policy mismatch');
 // Read-only authenticated reachability check before loading the key backend.
 const probe=hash(['DUEBYTE_SIGNER_COORDINATOR_PROBE',hash(profile.config)]);
 assert.equal(await channel.get({order:probe,purpose:'FUNDING',attempt:0,request:probe}),null,'reserved coordinator probe');
 return channel;
}
