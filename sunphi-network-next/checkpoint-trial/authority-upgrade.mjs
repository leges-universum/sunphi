// In-chain schema upgrade for the existing fixed-ten authority. No genesis,
// signing key, voting power, monetary balance or issuance clock is replaced.
import assert from 'node:assert/strict';
import {exact,hash,integer} from './crypto.mjs';
import {validatorSet,validatorQuorum} from './validator-authority.mjs';

export const UPGRADE_AUTHORITY='UPGRADE_VALIDATOR_AUTHORITY_V2';
export const AUTHORITY_UPGRADE='DUEBYTE_VALIDATOR_AUTHORITY_UPGRADE_V2';
const verified=new Map();
export const upgradedMembers=members=>{
 assert.equal(validatorSet(members).version,1,'upgrade requires legacy authority');
 return members.map(v=>({...v,power:10}));
};

function verifyRecord(record,config){
 exact(record,['version','height','previousValidators','certificate']);assert.equal(record.version,1);integer(record.height,1);
 assert(config.control&&config.control.version===undefined,'upgrade belongs to legacy genesis');
 const c=record.certificate;exact(c,['body','approvals']);const b=c.body;
 exact(b,['domain','network','configHash','generation','previousSetHash','nextSetHash','notBefore','expires']);
 assert.equal(b.domain,AUTHORITY_UPGRADE);assert.equal(b.network,config.chainId);assert.equal(b.configHash,hash(config));integer(b.generation);
 integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.expires-b.notBefore<=100&&record.height>=b.notBefore&&record.height<=b.expires,'upgrade inclusion window');
 const next=upgradedMembers(record.previousValidators);
 assert.equal(b.previousSetHash,validatorSet(record.previousValidators).hash);assert.equal(b.nextSetHash,validatorSet(next).hash);
 // The cache covers only an immutable, complete signed certificate and its
 // network configuration. Never cache validity of mutable authority state.
 const digest=hash({record,configHash:b.configHash});
 if(!verified.has(digest)){
  validatorQuorum(b,c.approvals,record.previousValidators);
  if(verified.size>=32)verified.delete(verified.keys().next().value);verified.set(digest,true);
 }
 return next;
}

export function auditAuthorityUpgrade(a,config,height){
 assert.equal(a.version,2);assert(a.upgrade,'legacy genesis needs committed authority upgrade');integer(height,1);
 const original=verifyRecord(a.upgrade,config);assert(a.upgrade.height<=height,'future authority upgrade');
 assert(a.generation>a.upgrade.certificate.body.generation,'authority upgrade generation');
 for(const v of original)assert(a.usedKeys.includes(v.key),'upgrade key history missing');
 return true;
}

export function upgradeAuthority(a,action,{config,height}){
 exact(action,['type','certificate']);assert.equal(action.type,UPGRADE_AUTHORITY);integer(height,1);
 assert(a&&a.version===undefined&&!a.upgrade,'authority already upgraded');assert(!a.pending&&!a.posNext,'authority transition pending');
 const record={version:1,height,previousValidators:structuredClone(a.validators),certificate:structuredClone(action.certificate)};
 assert.equal(record.certificate.body.generation,a.generation,'stale authority generation');
 const validators=verifyRecord(record,config),out={...structuredClone(a),version:2,validators,generation:integer(a.generation+1,1),upgrade:record};
 auditAuthorityUpgrade(out,config,height);return out;
}
