// Offline restore/audit path. Never scan historical penalties on every block.
// The caller supplies a complete authenticated snapshot, not an unverified SQL dump.
import assert from 'node:assert/strict';
import {consensusAddress} from '../consensus-context.mjs';
import {exact,hash,hex,integer,publicKey} from '../crypto.mjs';
import {POS_HEAD,signingKey,assertConsensusBondHeld} from './bounded-pos-records.mjs';
import {validateSlashingPolicy,auditSigningInfo} from './pos-slashing.mjs';
import {ordinaryIssued} from './issued-voting-minimum.mjs';
import {V3_BALLOT,NOTICE_SECONDS,nextMinimum,ordinaryIssueTarget} from '../bonded-schedule-v3.mjs';

const amount=x=>{assert(typeof x==='string'&&/^(0|[1-9][0-9]*)$/.test(x));const n=BigInt(x);assert(n<1n<<64n);return n;};
export const isPosRecord=k=>k===POS_HEAD||/^pos\/(signing\/[a-f0-9]{40}|(?:discipline|bonds)\/[a-f0-9]{64}|(?:events|increases)\/[a-f0-9]{40}\/[1-9][0-9]*|missed\/[a-f0-9]{40}\/(0|[1-9][0-9]*))$/.test(k);

export function auditPosRecords(records,s){
 const rows=[...records].filter(([k])=>k.startsWith('pos/')),head=records.get(POS_HEAD);
 if(!head){assert.equal(rows.length,0,'orphan slashing records');return;}
 exact(head,['policy','activation','count','lastHeight','lastDigest','collected']);validateSlashingPolicy(head.policy);
 if(head.activation!==null)integer(head.activation,1);integer(head.count);assert(head.count<=256);integer(head.lastHeight);
 if(head.activation===null)assert.equal(head.lastHeight,0,'observations before activation');
 if(head.lastHeight===0)assert.equal(head.lastDigest,null);else{assert(head.lastHeight>=head.activation);hex(head.lastDigest);}
 const signers=new Map(),events=new Map(),increases=new Map(),words=new Map(),bonds=new Map();
 for(const [k,v]of rows){assert(isPosRecord(k),'unexpected slashing record');if(k===POS_HEAD)continue;
  const [,kind,id,n]=k.split('/');
  if(kind==='signing')signers.set(id,v);
  else if(kind==='discipline'){
   assert.equal(head.policy.ballot,V3_BALLOT);exact(v,['awaitingReturn','lastReturn',...(Object.hasOwn(v,'lastConsentAt')?['lastConsentAt']:[])]);
   if(Object.hasOwn(v,'lastConsentAt'))integer(v.lastConsentAt,1);
   assert.equal(typeof v.awaitingReturn,'boolean');if(v.lastReturn!==null)integer(v.lastReturn,1);
  }else if(kind==='bonds'){exact(v,['address',...(Object.hasOwn(v,'previousHold')?['previousHold']:[])]);if(Object.hasOwn(v,'previousHold')){assert.equal(head.policy.ballot,V3_BALLOT);amount(v.previousHold);}assert(!bonds.has(v.address),'duplicate consensus bond');bonds.set(v.address,id);}
  else {const target=kind==='events'?events:kind==='increases'?increases:words;if(!target.has(id))target.set(id,new Map());target.get(id).set(integer(Number(n)),v);}
 }
 const schedule=s.authority?.bondedAdmission;
 if(schedule?.boundary!==undefined){
  assert.equal(schedule.version,3);assert.equal(schedule.ballot,V3_BALLOT);integer(schedule.boundary,s.money.time+1);
  assert.equal(schedule.ordinaryIssuedMicro,ordinaryIssued(s));
  const micro=amount(schedule.minimumMicro),current=Number(micro/1000000n),target=ordinaryIssueTarget(schedule.ordinaryIssuedMicro);
  assert(micro%1000000n===0n&&current>=100&&current<=target);
  assert([null,'QUORUM_NOT_READY','ROSTER_CHANGING'].includes(schedule.deferred));
  if(schedule.next){
   const n=schedule.next;integer(n.announcedAt,1);assert(n.announcedAt<=s.money.time);assert.equal(n.effectiveAt,schedule.boundary);
   assert.equal(n.effectiveAt-n.announcedAt,NOTICE_SECONDS);
   const next=amount(n.minimumMicro);assert(next%1000000n===0n&&next>micro&&next<=BigInt(nextMinimum(current,target))*1000000n);
  }
  const roster=s.authority.posSlashing.voting.validators;
  assert.deepEqual(schedule.activeValidators,roster.map(({key,power})=>{
   const row=signers.get(consensusAddress(key));assert.equal(bonds.get(row.signing.address),row.node);
   assert.deepEqual(s.workerFunding.accounts[row.node].votingBond,{validator:key,heldMicro:row.signing.bond});
   return {key,power,node:row.node};
  }));
 }
 let total=0n;
 for(const [address,row]of signers){
  exact(row,['node','owner','consent','signing',...(row.increases!==undefined?['originalBond','increases']:[])]);hex(row.node);publicKey(row.owner);hex(row.consent);
  const i=row.signing;assert.equal(signingKey(address),signingKey(i.address));auditSigningInfo(i,head.policy);
  if(head.policy.ballot===V3_BALLOT)assert(records.has('pos/discipline/'+row.node));
  const bound=bonds.get(address);if(bound!==undefined){assert.equal(bound,row.node);assertConsensusBondHeld(k=>records.get(k),s,row.node);assert.equal(s.workerFunding?.accounts[row.node]?.owner,row.owner,'bond owner changed');}
  else assert(i.removedHeight!==null,'active signing state without a bond');
  const history=events.get(address)??new Map();assert.equal(history.size,i.sequence,'missing penalty history');
  const deposits=increases.get(address)??new Map();assert.equal(deposits.size,row.increases??0);
  let prior=0n,at=0;
  for(let n=1;n<=deposits.size;n++){const d=deposits.get(n);exact(d,['height','total']);integer(d.height,Math.max(i.bondedHeight,at));assert(d.height<=head.lastHeight);at=d.height;assert(amount(d.total)>prior);prior=amount(d.total);}
  assert.equal(amount(row.originalBond??i.initialBond)+prior,amount(i.initialBond));
  let cursor=1,credited=0n;
  let remaining=amount(row.originalBond??i.initialBond),sum=0n,lastHeight=0,lastTime=0,tombstone=false;
  for(let n=1;n<=i.sequence;n++){
   const e=history.get(n);assert(e,'penalty sequence gap');
   exact(e,['id','address','reason','height','time','reference','value','observedHeight','sequence','node','remaining']);
   assert.equal(e.sequence,n);assert.equal(e.address,address);assert.equal(e.node,row.node);hex(e.reference);
   assert.equal(e.id,hash({domain:'DUEBYTE_POS_SLASH_V1',address,sequence:n}));
   integer(e.height,Math.max(head.activation,lastHeight));assert(e.height<=head.lastHeight);integer(e.time,Math.max(1,lastTime));integer(e.observedHeight,1);assert(e.observedHeight<=e.height);
   assert(['DOWNTIME','DOUBLE_SIGN','LIGHT_CLIENT_ATTACK'].includes(e.reason));assert(!tombstone,'penalty after permanent tombstone');
   while(cursor<=deposits.size&&deposits.get(cursor).height<e.height){const t=amount(deposits.get(cursor++).total);remaining+=t-credited;credited=t;}
   tombstone=e.reason!=='DOWNTIME';const value=amount(e.value);assert(value<=remaining);remaining-=value;sum+=value;assert.equal(e.remaining,String(remaining));lastHeight=e.height;lastTime=e.time;
  }
  assert.equal(String(remaining+prior-credited),i.bond);assert.equal(String(sum),i.slashed);assert.equal(tombstone,i.tombstoned);total+=sum;
  let missed=0;
  for(const [n,w]of words.get(address)??[]){
   exact(w,['epoch','bits']);integer(w.epoch);assert(w.epoch<=i.sequence);assert(n<Math.ceil(head.policy.signedBlocksWindow/64),'bitmap outside window');
   assert(typeof w.bits==='string'&&/^(0|[1-9a-f][0-9a-f]{0,15})$/.test(w.bits));let bits=BigInt('0x'+w.bits);
   const valid=Math.min(64,head.policy.signedBlocksWindow-n*64);assert(bits<(1n<<BigInt(valid)),'unused bitmap bits');
   if(w.epoch===i.sequence){while(bits){bits&=bits-1n;missed++;}}
  }
  if(!i.jailed)assert.equal(missed,i.missed,'missed participation count');
 }
 for(const group of [events,increases,words,bonds])for(const id of group.keys())assert(signers.has(id),'orphan signer record');
 assert.equal(bonds.size,head.count);assert.equal(String(total),head.collected);
 assert(amount(s.money.liability.protection.collected)>=total,'slashing reserve collection missing');
 return {signers:signers.size,bonds:bonds.size,collected:String(total)};
}
