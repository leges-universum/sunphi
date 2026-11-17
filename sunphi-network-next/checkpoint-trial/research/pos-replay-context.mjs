// Reconstruct ABCI metadata from a committed Comet block and its H-1 validator
// set. The caller MUST verify the resulting application root against the next
// authenticated header. This helper is not an evidence submission endpoint.
import assert from 'node:assert/strict';
import {validateConsensusContext} from '../consensus-context.mjs';
const number=x=>{const n=Number(x);assert(Number.isSafeInteger(n)&&n>=0);return n;};
const address=x=>{assert(typeof x==='string'&&/^[a-fA-F0-9]{40}$/.test(x));return x.toLowerCase();};
const seconds=x=>{const n=Math.floor(Date.parse(x)/1000);assert(Number.isSafeInteger(n)&&n>0);return n;};
export function consensusContextFromBlock(block,validators){
 const c=block.last_commit;assert(c&&Array.isArray(c.signatures)&&Array.isArray(validators));
 assert.equal(number(c.height),number(block.header.height)-1);assert.equal(c.signatures.length,validators.length);
 const votes=validators.map((v,n)=>{
  const sig=c.signatures[n],a=address(v.address),flag=number(sig.block_id_flag);
  if(flag!==1)assert.equal(address(sig.validator_address),a,'commit validator order');
  return {address:a,power:number(v.voting_power),flag};
 }).sort((a,b)=>a.address<b.address?-1:a.address>b.address?1:0),misbehavior=[];
 for(const e of block.evidence?.evidence??[]){
  const b=e.value;assert(b);
  if(e.type==='tendermint/DuplicateVoteEvidence')misbehavior.push({type:1,address:address(b.vote_a.validator_address),power:number(b.validator_power),height:number(b.vote_a.height),time:seconds(b.timestamp),totalPower:number(b.total_voting_power)});
  else if(e.type==='tendermint/LightClientAttackEvidence')for(const v of b.byzantine_validators??[])misbehavior.push({type:2,address:address(v.address),power:number(v.voting_power),height:number(b.common_height),time:seconds(b.timestamp),totalPower:number(b.total_voting_power)});
  else throw Error('unsupported Comet evidence type');
 }
 misbehavior.sort((a,b)=>a.height-b.height||(a.address<b.address?-1:a.address>b.address?1:0)||a.type-b.type||a.time-b.time||a.power-b.power||a.totalPower-b.totalPower);
 return validateConsensusContext({round:number(c.round),votes,misbehavior});
}
