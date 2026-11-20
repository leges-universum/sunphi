// Only the private ABCI path supplies this metadata. Wallet actions never supply
// votes or a jail list. Journal replay retains exactly the committed context.
import assert from 'node:assert/strict';
import {hash} from '../crypto.mjs';
import {consensusAddress} from '../consensus-context.mjs';
import {applyPosContext,markConsensusRemoval,markConsensusAdmission,signingKey} from './bounded-pos-records.mjs';
import {schedulePosExclusion,posVotingAuthority,INITIAL_BONDED_SET,normalizedVotingSet,normalizedUpdates} from './pos-authority-transition.mjs';
import {advanceBondQueue} from './bonded-queue.mjs';

export function posContextMode(s){const activation=s.authority?.posSlashing?.activation;return activation?{version:1,activation}:null;}
export function applyPosBlock(tx,s,request,lastValidators){
 const mode=posContextMode(s),active=mode&&request.height>=mode.activation;
 const p=s.authority?.posSlashing;
 if(mode&&p?.voting&&request.height===mode.activation-2){
  const roster=p.voting;assert(!roster.pending&&!roster.posNext);
  const updates=normalizedUpdates(roster.validators);
  if(updates.length)roster.pending={kind:INITIAL_BONDED_SET,activation:mode.activation,validators:normalizedVotingSet(roster.validators),updates,certificate:p.transitionHash};
 }
 if(!active){assert(!Object.hasOwn(request,'consensus'),'unexpected consensus context before activation');return;}
 assert(request.consensus,'authenticated Comet consensus context required');
 const voters=posVotingAuthority(s.authority).validators;
 const current=new Set(voters.map(v=>v.key));
 for(const v of lastValidators)if(!current.has(v.key)&&tx.get(signingKey(consensusAddress(v.key))))markConsensusRemoval(tx,v.key,{height:request.height,time:request.time});
 const previous=new Set(lastValidators.map(v=>v.key));
 for(const v of voters)if(!previous.has(v.key))markConsensusAdmission(tx,s,v.key,{height:request.height,time:request.time});
 applyPosContext(tx,s,request.consensus,{height:request.height,time:request.time,lastValidators,scheduleJail:keys=>{
  s.authority=schedulePosExclusion(s.authority,{height:request.height,keys,contextHash:hash({height:request.height,blockHash:request.blockHash,context:request.consensus})});
 }});
 advanceBondQueue(tx,s,tx.get('meta/network').blockHash);
}
