// Explicit, consented staking lifecycle using the existing validator governance
// and authenticated record transaction. Preparation alone cannot turn on fines.
import assert from 'node:assert/strict';
import {exact,hash,integer,hex} from '../crypto.mjs';
import {consensusAddress,COMET_EVIDENCE_LIMITS} from '../consensus-context.mjs';
import {validatorQuorum,validatorSet} from '../validator-authority.mjs';
import {posVotingAuthority,auditPosAuthority,normalizedVotingSet} from './pos-authority-transition.mjs';
import {STANDARD_SLASHING,BONDED_SLASHING,validateSlashingPolicy,auditSigningInfo} from './pos-slashing.mjs';
import {POS_HEAD,signingKey,preparePosRecords,bindConsensusBond,assertConsensusBondHeld,releaseConsensusBond,unjailConsensusRecord,assertConsensusAdmission} from './bounded-pos-records.mjs';
import {JOIN_BONDED,LEAVE_QUEUE,updateBondApplication,auditBondQueue,initialBondQueue} from './bonded-queue.mjs';

function bondedNetwork(chainId,configHash){
 return chainId==='duebyte-trial-bonded-v3-lab'||
  (chainId==='duebyte-trial-fresh-20261109-v45'&&configHash==='5a6af5048049049bee003078f845ccea883140f291897f950007c5ba113a807c');
}
export const PREPARE_POS='PREPARE_POS_SLASHING_V1',BIND_POS='BIND_CONSENSUS_BOND_V1',ENABLE_POS='ENABLE_POS_SLASHING_V1',RELEASE_POS='RELEASE_CONSENSUS_BOND_V1';
export const UNJAIL_POS='UNJAIL_CONSENSUS_VALIDATOR_V1';
export const POS_ACTIONS=[PREPARE_POS,BIND_POS,ENABLE_POS,RELEASE_POS,UNJAIL_POS,JOIN_BONDED,LEAVE_QUEUE];
const DOMAIN='DUEBYTE_POS_POLICY_V1';
export function bondedReadyBody(body,next){
 return {domain:'DUEBYTE_BONDED_CUTOVER_READY_V3',configHash:body.configHash,generation:body.generation,
  activationProposal:hash(body),nextSetHash:validatorSet(next).hash};
}
function certificate(s,a,c,fields,ready=false){
 exact(a,['type','certificate']);exact(a.certificate,['body','approvals',...(ready?['readiness']:[])]);const b=a.certificate.body;
 exact(b,['domain','network','configHash','generation','notBefore','expires',...fields]);
 assert.equal(b.domain,DOMAIN+'/'+a.type);assert.equal(b.network,c.chainId);assert.equal(b.configHash,s.configHash);assert.equal(b.generation,s.authority.generation);
 integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.expires-b.notBefore<=100&&s.height>=b.notBefore&&s.height<=b.expires,'PoS certificate inclusion window');
 validatorQuorum(b,a.certificate.approvals,s.authority.validators);return b;
}
export function auditPosPolicy(get,s,{observedHeight=s.height}={}){
 const h=get(POS_HEAD),p=s.authority?.posSlashing;
 if(!p){assert(!h,'orphan PoS policy');return;}
 assert(h,'missing PoS records');validateSlashingPolicy(h.policy);
 const separate=h.policy.ballot===BONDED_SLASHING.ballot;
 exact(p,['version','policyHash','activation',...(separate?['voting',...(p.activation===null?[]:['admissions','transitionHash'])]:[])]);assert.equal(p.version,1);hex(p.policyHash);
 if(separate&&p.activation!==null)hex(p.transitionHash);
 if(separate&&p.activation!==null)auditBondQueue(p.admissions);
 const voters=posVotingAuthority(s.authority);
 if(separate&&p.activation!==null){
  exact(voters,['version','generation','validators','usedKeys','pending',...(voters.posNext?['posNext']:[])]);
  auditPosAuthority(voters,s.height);
 }else if(separate)assert.equal(p.voting,null,'Voting roster is selected at cutover');
 assert.equal(p.policyHash,hash(h.policy));assert.equal(p.activation,h.activation);
 if(p.activation===null){assert.equal(h.lastHeight,0);return;}
 integer(p.activation,1);
 assert.equal(h.lastHeight,observedHeight>=p.activation?observedHeight:0,'missing consensus observations');
 for(const v of [...voters.validators,...(voters.pending?.validators??[]),...(voters.posNext?.validators??[])]){const r=get(signingKey(consensusAddress(v.key)));assert(r,'unbonded consensus validator');assertConsensusBondHeld(get,s,r.node);}
}
export function posPolicyAction(s,a,c,tx,author){
 assert.equal(s.authority?.version,2,'PoS requires committed variable authority');
 if(a.type===PREPARE_POS){
  assert(!s.authority.rotatingSeat,'rotating-seat pilot in progress');
  assert(!s.authority.archiveVoting,'active archive ballot policy');
  const b=certificate(s,a,c,['policy']);assert(!s.authority.posSlashing);validateSlashingPolicy(b.policy);
  // Use the selected standard parameters, not a discretionary economic model.
  const profile=b.policy.ballot===BONDED_SLASHING.ballot?BONDED_SLASHING:STANDARD_SLASHING;
  if(profile===BONDED_SLASHING)assert(bondedNetwork(c.chainId,s.configHash),'Unknown bonded admission network');
  for(const [key,value]of Object.entries(profile))assert.equal(b.policy[key],value,'slashing parameter');
  for(const [key,value]of Object.entries(COMET_EVIDENCE_LIMITS))assert.equal(b.policy[key],value,'Comet evidence retention parameter');
  preparePosRecords(tx,b.policy,{activation:null});s.authority.posSlashing={version:1,policyHash:hash(b.policy),activation:null};
  if(profile===BONDED_SLASHING){
   assert(!s.authority.pending&&!s.authority.posNext,'membership change pending');
   s.authority.posSlashing.voting=null;
  }
  return s;
 }
 assert(s.authority.posSlashing,'PoS policy not prepared');
 if(a.type===JOIN_BONDED||a.type===LEAVE_QUEUE){updateBondApplication(s,a,tx,author);return s;}
 if(a.type===BIND_POS){exact(a,['type','consent']);bindConsensusBond(tx,s,a.consent,{height:s.height,time:s.money.time,network:c.chainId});return s;}
 if(a.type===ENABLE_POS){
  const equalVotes=Object.hasOwn(s.authority.posSlashing,'voting');
  const b=certificate(s,a,c,['policyHash','activation'],equalVotes),h=tx.get(POS_HEAD);assert.equal(h.activation,null,'PoS already enabled');assert.equal(b.policyHash,hash(h.policy));
  if(equalVotes){
   assert(bondedNetwork(c.chainId,s.configHash),'Unknown bonded admission network');
   assert(!s.authority.rotatingSeat&&!s.authority.archiveVoting,'Wait for the current voting programme to end');
   const {generation,validators,usedKeys}=s.authority;
   s.authority.posSlashing.voting=structuredClone({version:2,generation,validators,usedKeys,pending:null});
   const next=normalizedVotingSet(validators);
   validatorQuorum(bondedReadyBody(b,next),a.certificate.readiness,next);
   // Finalize H-2 must still be in the future when this action is included.
   integer(b.activation,s.height+3);s.authority.posSlashing.transitionHash=hash(a.certificate);
  }
  integer(b.activation,b.expires+2);assert(b.activation<=b.expires+10000);assert(!s.authority.pending&&!s.authority.posNext,'membership change pending');
  for(const v of s.authority.validators){const key=signingKey(consensusAddress(v.key)),r=tx.get(key);assert(r,'every active validator must consent and retain a bond');assertConsensusBondHeld(tx.get,s,r.node);
   const i=r.signing;
   if(equalVotes)assert(BigInt(i.bond)>=BigInt(s.authority.bondedAdmission?.minimumMicro??'100000000'),'Every incumbent must meet the same effective bond minimum as a new validator');
   assert(!i.jailed&&!i.tombstoned&&i.removedHeight===null&&i.sequence===0);i.startHeight=b.activation;i.lastHeight=b.activation-1;auditSigningInfo(i,h.policy);tx.set(key,r);
  }
  h.activation=b.activation;tx.set(POS_HEAD,h);s.authority.posSlashing.activation=b.activation;
  if(s.authority.posSlashing.voting)s.authority.posSlashing.admissions=initialBondQueue();
  return s;
 }
 exact(a,['type','validator']);assert([RELEASE_POS,UNJAIL_POS].includes(a.type));
 const voters=posVotingAuthority(s.authority);
 assert(![...voters.validators,...(voters.pending?.validators??[]),...(voters.posNext?.validators??[])].some(v=>v.key===a.validator),'active or scheduled consensus bond');
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
