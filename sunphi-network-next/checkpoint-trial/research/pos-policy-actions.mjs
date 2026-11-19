// Explicit, consented staking lifecycle using the existing validator governance
// and authenticated record transaction. Preparation alone cannot turn on fines.
import assert from 'node:assert/strict';
import {exact,hash,integer,hex} from '../crypto.mjs';
import {consensusAddress,COMET_EVIDENCE_LIMITS} from '../consensus-context.mjs';
import {validatorQuorum} from '../validator-authority.mjs';
import {STANDARD_SLASHING,validateSlashingPolicy,auditSigningInfo} from './pos-slashing.mjs';
import {POS_HEAD,signingKey,preparePosRecords,bindConsensusBond,assertConsensusBondHeld,releaseConsensusBond,unjailConsensusRecord,assertConsensusAdmission} from './bounded-pos-records.mjs';

export const PREPARE_POS='PREPARE_POS_SLASHING_V1',BIND_POS='BIND_CONSENSUS_BOND_V1',ENABLE_POS='ENABLE_POS_SLASHING_V1',RELEASE_POS='RELEASE_CONSENSUS_BOND_V1';
export const UNJAIL_POS='UNJAIL_CONSENSUS_VALIDATOR_V1';
export const POS_ACTIONS=[PREPARE_POS,BIND_POS,ENABLE_POS,RELEASE_POS,UNJAIL_POS];
const DOMAIN='DUEBYTE_POS_POLICY_V1';
function certificate(s,a,c,fields){
 exact(a,['type','certificate']);exact(a.certificate,['body','approvals']);const b=a.certificate.body;
 exact(b,['domain','network','configHash','generation','notBefore','expires',...fields]);
 assert.equal(b.domain,DOMAIN+'/'+a.type);assert.equal(b.network,c.chainId);assert.equal(b.configHash,s.configHash);assert.equal(b.generation,s.authority.generation);
 integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.expires-b.notBefore<=100&&s.height>=b.notBefore&&s.height<=b.expires,'PoS certificate inclusion window');
 validatorQuorum(b,a.certificate.approvals,s.authority.validators);return b;
}
export function auditPosPolicy(get,s,{observedHeight=s.height}={}){
 const h=get(POS_HEAD),p=s.authority?.posSlashing;
 if(!p){assert(!h,'orphan PoS policy');return;}
 exact(p,['version','policyHash','activation']);assert.equal(p.version,1);hex(p.policyHash);assert(h,'missing PoS records');validateSlashingPolicy(h.policy);
 assert.equal(p.policyHash,hash(h.policy));assert.equal(p.activation,h.activation);
 if(p.activation===null){assert.equal(h.lastHeight,0);return;}
 integer(p.activation,1);
 assert.equal(h.lastHeight,observedHeight>=p.activation?observedHeight:0,'missing consensus observations');
 for(const v of [...s.authority.validators,...(s.authority.pending?.validators??[]),...(s.authority.posNext?.validators??[])]){const r=get(signingKey(consensusAddress(v.key)));assert(r,'unbonded consensus validator');assertConsensusBondHeld(get,s,r.node);}
}
export function posPolicyAction(s,a,c,tx,author){
 assert.equal(s.authority?.version,2,'PoS requires committed variable authority');
 if(a.type===PREPARE_POS){
  assert(!s.authority.rotatingSeat,'rotating-seat pilot in progress');
  const b=certificate(s,a,c,['policy']);assert(!s.authority.posSlashing);validateSlashingPolicy(b.policy);
  // Use the selected standard parameters, not a discretionary economic model.
  for(const [key,value]of Object.entries(STANDARD_SLASHING))assert.equal(b.policy[key],value,'standard slashing parameter');
  for(const [key,value]of Object.entries(COMET_EVIDENCE_LIMITS))assert.equal(b.policy[key],value,'Comet evidence retention parameter');
  preparePosRecords(tx,b.policy,{activation:null});s.authority.posSlashing={version:1,policyHash:hash(b.policy),activation:null};return s;
 }
 assert(s.authority.posSlashing,'PoS policy not prepared');
 if(a.type===BIND_POS){exact(a,['type','consent']);bindConsensusBond(tx,s,a.consent,{height:s.height,time:s.money.time,network:c.chainId});return s;}
 if(a.type===ENABLE_POS){
  const b=certificate(s,a,c,['policyHash','activation']),h=tx.get(POS_HEAD);assert.equal(h.activation,null,'PoS already enabled');assert.equal(b.policyHash,hash(h.policy));
  integer(b.activation,b.expires+2);assert(b.activation<=b.expires+10000);assert(!s.authority.pending&&!s.authority.posNext,'membership change pending');
  for(const v of s.authority.validators){const key=signingKey(consensusAddress(v.key)),r=tx.get(key);assert(r,'every active validator must consent and retain a bond');assertConsensusBondHeld(tx.get,s,r.node);
   const i=r.signing;assert(!i.jailed&&!i.tombstoned&&i.removedHeight===null&&i.sequence===0);i.startHeight=b.activation;i.lastHeight=b.activation-1;auditSigningInfo(i,h.policy);tx.set(key,r);
  }
  h.activation=b.activation;tx.set(POS_HEAD,h);s.authority.posSlashing.activation=b.activation;return s;
 }
 exact(a,['type','validator']);assert([RELEASE_POS,UNJAIL_POS].includes(a.type));
 assert(![...s.authority.validators,...(s.authority.pending?.validators??[]),...(s.authority.posNext?.validators??[])].some(v=>v.key===a.validator),'active or scheduled consensus bond');
 if(a.type===UNJAIL_POS){unjailConsensusRecord(tx,a.validator,{height:s.height,time:s.money.time,author});return s;}
 releaseConsensusBond(tx,s,a.validator,{height:s.height,time:s.money.time,author});return s;
}
// Only the indexed execution path can authorize reuse of a retained, unjailed
// signing key. The existing quorum, readiness and possession proofs still apply.
export function posReadmissionKeys(get,s,action){
 if(action.type!=='CHANGE_VALIDATORS_V2'||!s.authority.posSlashing?.activation)return [];
 const current=new Set(s.authority.validators.map(v=>v.key)),reusable=[];
 for(const v of action.certificate.body.next)if(!current.has(v.key)){
  const row=assertConsensusAdmission(get,s,v.key);
  if(s.authority.usedKeys.includes(v.key)){assert(row.signing.removedHeight!==null,'retired consensus state required');reusable.push(v.key);}
 }
 return reusable;
}
