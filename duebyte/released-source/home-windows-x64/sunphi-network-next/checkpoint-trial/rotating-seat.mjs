import assert from 'node:assert/strict';
import {exact,hash,integer,publicKey,verify} from './crypto.mjs';
import {validatorQuorum,validatorSet} from './validator-authority.mjs';

export const OPEN_SEAT='OPEN_ROTATING_SEAT_V1';
export const JOIN_SEAT='JOIN_ROTATING_SEAT_V1';
export const SEAT_DOMAIN='DUEBYTE_ROTATING_SEAT_V1';
export const possessionBody=(policy,epoch,voter,worker)=>({domain:SEAT_DOMAIN+'/JOIN',policy,epoch,voter,worker});

// A finite pilot with a bounded FIFO. Entries are live for two periods.
// The current holder can rejoin only after leaving the seat.
export function applySeat(s,action,author,chainId){
 const a=s.authority;
 assert(a?.version===2 && !a.posSlashing && !a.archiveVoting && !a.posNext && !a.pending,'incompatible authority');
 if(action.type===OPEN_SEAT){
  exact(action,['type','body','approvals']);
  const b=action.body;
  exact(b,['domain','network','configHash','generation','notBefore','expires','start','period','rounds']);
  assert.equal(b.domain,SEAT_DOMAIN);assert.equal(b.network,chainId);assert.equal(b.configHash,s.configHash);
  assert.equal(b.generation,a.generation);assert(!a.rotatingSeat,'pilot already running');
  integer(b.notBefore,1);integer(b.expires,b.notBefore);integer(b.start,b.expires+2);
  assert(b.expires-b.notBefore<=100 && s.height>=b.notBefore && s.height<=b.expires && b.start<=b.expires+10000);
  integer(b.period,8);integer(b.rounds,1);assert(b.period<=2000 && b.rounds<=32);
  integer(b.start+b.period*b.rounds+2);
  const {total}=validatorSet(a.validators);
  assert(a.validators.length<256 && total>3n && (total+1n)*2n/3n+1n<=total,'insufficient headroom');
  validatorQuorum(b,action.approvals,a.validators);
  a.rotatingSeat={policy:structuredClone(b),id:hash(b),queue:[],holder:null,change:null};
  return s;
 }
 assert.equal(action.type,JOIN_SEAT);
 exact(action,['type','policy','epoch','voter','possession']);
 const seat=a.rotatingSeat;
 assert(seat && action.policy===seat.id,'inactive policy');
 const {start,period,rounds}=seat.policy;
 const epoch=Math.floor((s.height-start)/period);
 assert(epoch>=0 && epoch<rounds && action.epoch===epoch,'registration closed');
 // The next selection must have at least one full term remaining.
 assert(s.height<start+(rounds-1)*period,'last term');
 publicKey(action.voter); publicKey(author);
 assert(action.voter!==author && !a.usedKeys.includes(action.voter) && !a.usedKeys.includes(author),'reserved or shared signing key');
 assert(seat.queue.length<32 && seat.holder!==action.voter && !seat.queue.some(row=>row.key===action.voter),'already admitted or queue full');
 assert(verify(possessionBody(seat.id,epoch,action.voter,author),action.possession,action.voter),'candidate possession');
 seat.queue.push({key:action.voter,epoch});
 return s;
}

export function advanceSeat(a,height){
 const seat=a?.rotatingSeat;
 if(!seat)return;
 const {start,period,rounds}=seat.policy;
 const end=start+period*rounds;
 if(height===end+2){delete a.rotatingSeat;return;}
 if(height<start || height>end || (height-start)%period!==0)return;
 const epoch=(height-start)/period;
 seat.queue=seat.queue.filter(row=>row.epoch>=epoch-2);
 const next=height===end?null:seat.queue.shift()?.key??null;
 const old=seat.holder;
 seat.change={height,updates:[]};
 if(old)seat.change.updates.push({key:old,power:0});
 if(next)seat.change.updates.push({key:next,power:1});
 seat.holder=next;
}

export function seatUpdates(a,height){
 const change=a?.rotatingSeat?.change;
 return change?.height===height?change.updates:[];
}
