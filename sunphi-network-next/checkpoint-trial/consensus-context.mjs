// Normalized CometBFT 0.38 ABCI metadata. This is not a wallet transaction.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {exact,integer,publicKey} from './crypto.mjs';
// Comet's admitted evidence bytes contain at least one 20-byte address for
// every expanded ABCI fault. Keep headroom for LightClientAttack expansion.
export const MAX_CONSENSUS_FAULTS=65536;
export const CONSENSUS_EVENT_BYTES=12*1024*1024;
export const PRIVATE_APPLICATION_BYTES=14*1024*1024;
export const COMET_EVIDENCE_LIMITS=Object.freeze({evidenceMaxAgeBlocks:100000,evidenceMaxAgeSeconds:172800});
export const blockEventBytes=request=>Object.hasOwn(request,'consensus')?CONSENSUS_EVENT_BYTES:2*1024*1024;
export function consensusAddress(key){publicKey(key);return createHash('sha256').update(Buffer.from(key,'base64url')).digest('hex').slice(0,40);}
const address=x=>{assert(typeof x==='string'&&/^[a-f0-9]{40}$/.test(x),'consensus address');return x;};
export function validateConsensusContext(c){
 exact(c,['round','votes','misbehavior']);integer(c.round);assert(c.round<=2147483647);
 assert(Array.isArray(c.votes)&&c.votes.length<=256);assert(Array.isArray(c.misbehavior)&&c.misbehavior.length<=MAX_CONSENSUS_FAULTS);
 let previous='';for(const v of c.votes){exact(v,['address','power','flag']);address(v.address);assert(v.address>previous,'canonical unique votes');previous=v.address;integer(v.power,1);assert(v.power<=1000000);assert([1,2,3].includes(v.flag),'ABCI block ID flag');}
 for(const e of c.misbehavior){exact(e,['type','address','power','height','time','totalPower']);assert([1,2].includes(e.type));address(e.address);integer(e.power,1);assert(e.power<=1000000);integer(e.height,1);integer(e.time,1);integer(e.totalPower,e.power);assert(e.totalPower<=256000000);}
 assert.deepEqual(c.misbehavior,[...c.misbehavior].sort((a,b)=>a.height-b.height||(a.address<b.address?-1:a.address>b.address?1:0)||a.type-b.type||a.time-b.time||a.power-b.power||a.totalPower-b.totalPower),'canonical evidence order');
 return c;
}
