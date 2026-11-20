import assert from 'node:assert/strict';
import {exact,hash,hex,integer,publicKey} from '../crypto.mjs';
import {membershipDelta} from '../validator-membership.mjs';
import {consensusAddress} from '../consensus-context.mjs';
import {assertConsensusAdmission,signingKey} from './bounded-pos-records.mjs';

export const JOIN_BONDED='JOIN_BONDED_VALIDATOR_V3',LEAVE_QUEUE='CANCEL_BONDED_APPLICATION_V3';
const day=86400;
export function initialBondQueue(){
 return {entries:[],lastScheduledAt:null,anchor:null};
}
export function auditBondQueue(q){
 exact(q,['entries','lastScheduledAt','anchor']);if(q.lastScheduledAt!==null)integer(q.lastScheduledAt,1);
 if(q.anchor){exact(q.anchor,['height','block']);integer(q.anchor.height,1);hex(q.anchor.block);}
 assert(Array.isArray(q.entries)&&q.entries.length<=256);
 const keys=new Set();let height=0;
 for(const e of q.entries){
  exact(e,['key','node','height','readyUntil']);publicKey(e.key);hex(e.node);integer(e.readyUntil,1);
  integer(e.height,Math.max(1,height));height=e.height;
  assert(!keys.has(e.key));keys.add(e.key);
 }
}
export function updateBondApplication(s,a,tx,author){
 const p=s.authority.posSlashing,q=p.admissions,v=p.voting;
 assert(q&&p.activation!==null&&s.height>=p.activation,'Bonded admission has not opened');
 publicKey(a.validator);
 const idx=q.entries.findIndex(e=>e.key===a.validator);
 if(a.type===LEAVE_QUEUE){
  exact(a,['type','validator']);assert(idx>=0,'No pending application');
  const r=tx.get(signingKey(consensusAddress(a.validator)));assert(r&&(author===r.owner||author===a.validator),'Applicant signature required');
  q.entries.splice(idx,1);return;
 }
 exact(a,['type','validator','anchor']);assert.equal(a.type,JOIN_BONDED);assert.equal(author,a.validator);
 assert(q.anchor&&q.anchor.height>=s.height-32,'Wait for a finalized readiness anchor');assert.deepEqual(a.anchor,q.anchor);
 const r=assertConsensusAdmission(tx.get,s,a.validator);
 assert(BigInt(r.signing.bond)>=BigInt(s.authority.bondedAdmission?.minimumMicro??'100000000'),'Insufficient voting bond');
 for(const set of [v.validators,v.pending?.validators??[],v.posNext?.validators??[]])assert(!set.some(m=>m.key===a.validator),'Already participating or scheduled');
 // Deterministic execution appends in finalized transaction order. Refreshing
 // the readiness attestation does not change the application's position.
 const readyUntil=s.money.time+day;
 if(idx>=0){q.entries[idx].readyUntil=readyUntil;return;}
 assert(q.entries.length<256);q.entries.push({key:a.validator,node:r.node,height:s.height,readyUntil});
}
export function advanceBondQueue(tx,s,previousBlock){
 const p=s.authority?.posSlashing,q=p?.admissions;
 if(!q||s.height<p.activation)return;
 const {height,money}=s,v=p.voting;
 if(!q.anchor||height-q.anchor.height>24)q.anchor={height:height-1,block:hex(previousBlock)};
 // Remove expired claims before assigning a slot. A fresh application can be
 // filed using the same bond. A stalled head cannot create extra admissions.
 q.entries=q.entries.filter(e=>e.readyUntil>=money.time);
 if(!q.entries.length||v.pending||v.posNext||v.validators.length<3||v.validators.length>=20||
    (q.lastScheduledAt!==null&&money.time<q.lastScheduledAt+day))return;
 const minimum=BigInt(s.authority.bondedAdmission?.minimumMicro??'100000000');
 while(q.entries.length){
  const e=q.entries.shift(),r=tx.get(signingKey(consensusAddress(e.key)));
  if(!r||r.node!==e.node||tx.get('pos/bonds/'+e.node)?.address!==r.signing.address||
     r.signing.jailed||r.signing.tombstoned||BigInt(r.signing.bond)<minimum)continue;
  assertConsensusAdmission(tx.get,s,e.key);
  const group=s.authority.validators.find(m=>m.key===e.key)?.group??hash({domain:JOIN_BONDED,node:e.node});
  const validators=[...v.validators,{key:e.key,group,power:1}];
  const updates=membershipDelta(v.validators,validators);
  if(!v.usedKeys.includes(e.key)&&v.usedKeys.length>=2048)continue;
  v.usedKeys=[...new Set([...v.usedKeys,e.key])].sort();
  v.pending={activation:height+2,validators,updates,certificate:hash({domain:JOIN_BONDED,entry:e,height})};
  q.lastScheduledAt=money.time;break;
 }
}
