// Candidate staking records for the existing authenticated SQLite transaction.
// Not an independent database, wallet action, or production activation path.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer,publicKey,verify} from '../crypto.mjs';
import {consensusAddress,validateConsensusContext} from '../consensus-context.mjs';
import {protectionEvent} from '../protection-reserve.mjs';
import {consentedVotingHold} from '../worker-collateral.mjs';
import {lockedSupport} from '../support-accounting.mjs';
import {V3_BALLOT} from '../bonded-schedule-v3.mjs';
import {posVotingAuthority} from './pos-authority-transition.mjs';
import {spendPolicy} from '../spend-protection.mjs';
import {validateSlashingPolicy,newSigningInfo,auditSigningInfo,signingObservation,evidenceInfraction,unjailSigningInfo,admitSigningInfo,bondReleaseAllowed} from './pos-slashing.mjs';

export const POS_HEAD='pos/head';
const addr=x=>{assert(typeof x==='string'&&/^[a-f0-9]{40}$/.test(x));return x;};
export const signingKey=a=>'pos/signing/'+addr(a);
const bondKey=id=>'pos/bonds/'+hex(id);
const disciplineKey=id=>'pos/discipline/'+hex(id);
const eventKey=(a,n)=>'pos/events/'+addr(a)+'/'+integer(n,1);
const wordKey=(a,n)=>'pos/missed/'+addr(a)+'/'+integer(n);
const amount=x=>{assert(typeof x==='string'&&/^(0|[1-9][0-9]*)$/.test(x));const n=BigInt(x);assert(n<1n<<64n);return n;};

export function preparePosRecords(tx,policy,{activation}){
 assert(!tx.get(POS_HEAD),'slashing already prepared');validateSlashingPolicy(policy);if(activation!==null)integer(activation,1);
 tx.set(POS_HEAD,{policy:structuredClone(policy),activation,count:0,lastHeight:0,lastDigest:null,collected:'0'});
}

export function bindConsensusBond(tx,s,consent,{height,time,network=s.network}){
 exact(consent,['body','validatorSignature','workerSignature','ownerSignature']);const b=consent.body,h=tx.get(POS_HEAD);
 assert(h,'slashing policy required');exact(b,['domain','network','configHash','node','validator','owner','bond','policyHash','notBefore','expires']);
 assert.equal(b.domain,'DUEBYTE_CONSENSUS_BOND_V1');assert.equal(b.network,network);assert.equal(b.configHash,s.configHash);assert.equal(b.policyHash,hash(h.policy));
 integer(height,1);integer(time,1);integer(b.notBefore,1);integer(b.expires,b.notBefore+1);assert(b.expires-b.notBefore<=600&&time>=b.notBefore&&time<b.expires,'bond consent window');
 hex(b.node);publicKey(b.validator);publicKey(b.owner);const node=s.money.nodes[b.node],funding=s.workerFunding?.accounts[b.node];
 assert(node&&funding,'registered funded worker required');assert.equal(b.owner,funding.owner,'collateral owner consent');
 assert(verify(b,consent.validatorSignature,b.validator),'validator consent');assert(verify(b,consent.workerSignature,node.key),'worker consent');assert(verify(b,consent.ownerSignature,b.owner),'owner consent');
 const address=consensusAddress(b.validator);assert(!tx.get(signingKey(address))&&!tx.get(bondKey(b.node)),'consensus bond already bound');
 assert(amount(b.bond)>0n,'positive consensus collateral');
 assert(amount(node.stake)>=amount(node.consensusHeld)+amount(node.taskHeld),'collateral coverage');assert(h.count<256,'bonded signer admission bound');
 const previousHold=node.consensusHeld;
 if(h.policy.ballot===V3_BALLOT){
  const protection=spendPolicy(s,b.owner);
  assert(!protection?.enabled&&!protection?.pending,'separate protected-wallet collateral approval required');
  const rules=s.authority?.bondedAdmission;
  if(rules){
   assert(rules.version===3&&rules.ballot===V3_BALLOT,'unrecognized bonded admission rule');
   assert(amount(b.bond)>=amount(rules.minimumMicro),'bond below the effective minimum');
  }
  node.consensusHeld=consentedVotingHold(s,b.node,b.bond);
  const history=tx.get(disciplineKey(b.node))??{awaitingReturn:false,lastReturn:null};
  assert(b.notBefore>(history.lastConsentAt??0),'Retired or superseded bond consent');
  history.lastConsentAt=b.notBefore;tx.set(disciplineKey(b.node),history);
 }else assert(amount(b.bond)<=amount(node.consensusHeld),'reserved consensus collateral');
 const signing=newSigningInfo(b.validator,{height:Math.max(height,h.activation??height),time,bond:b.bond});
 tx.set(signingKey(address),{node:b.node,owner:b.owner,consent:hash(consent),signing});tx.set(bondKey(b.node),h.policy.ballot===V3_BALLOT?{address,previousHold}:{address});h.count++;tx.set(POS_HEAD,h);
 return address;
}

// Changes are indexed by the validator's monotonic penalty sequence. Historical
// stake lookup is logarithmic, not a scan over blocks, wallets or all penalties.
export function historicalConsensusBond(get,row,height){
 integer(height,1);const i=row.signing;assert(height>=i.bondedHeight,'stake predates bonding');
 let low=1,high=i.sequence,found=null;
 while(low<=high){const middle=Math.floor((low+high)/2),r=get(eventKey(i.address,middle));assert(r,'missing historical slash');assert.equal(r.sequence,middle);
  if(r.height<height){found=r;low=middle+1;}else high=middle-1;
 }
 return found?.remaining??i.initialBond;
}

function persistFine(tx,s,row,event,blockHeight){
 const i=row.signing,node=s.money.nodes[row.node],n=amount(event.value);assert(node,'bonded worker missing');
 assert(amount(node.consensusHeld)>=amount(i.bond)+n,'consensus bond was released');
 assert(amount(node.stake)-n>=amount(node.consensusHeld)-n+amount(node.taskHeld),'payment collateral must remain covered');
 const key=eventKey(i.address,i.sequence);assert(!tx.get(key),'slash sequence already paid');
 node.stake=String(amount(node.stake)-n);node.consensusHeld=String(amount(node.consensusHeld)-n);
 const l=s.money.liability;assert(l?.protection,'existing protection reserve required');l.pool=String(amount(l.pool)+n);l.protection.collected=String(amount(l.protection.collected)+n);
 const h=tx.get(POS_HEAD);h.collected=String(amount(h.collected)+n);tx.set(POS_HEAD,h);
 const record={...event,height:blockHeight,observedHeight:event.height,sequence:i.sequence,node:row.node,remaining:i.bond};tx.set(key,record);
 protectionEvent(s.money,{type:'POS_SLASH_V1',...record});
}

export function applyPosContext(tx,s,context,{height,time,lastValidators,scheduleJail}){
 const head=tx.get(POS_HEAD);assert(head,'slashing policy not prepared');integer(height,1);integer(time,1);validateConsensusContext(context);
 assert.equal(typeof scheduleJail,'function','atomic consensus exclusion callback required');
 const digest=hash({height,time,context,lastValidators});
 if(height===head.lastHeight){assert.equal(digest,head.lastDigest,'conflicting slashing replay');return {duplicate:true,jailed:[]};}
 assert(head.activation!==null,'slashing has not been activated');
 if(height<head.activation)return {duplicate:false,jailed:[]};
 assert(head.lastHeight===0?height===head.activation:height===head.lastHeight+1,'consecutive slashing height');
 validateSlashingPolicy(head.policy);
 const expected=lastValidators.map(v=>({address:consensusAddress(v.key),power:v.power})).sort((a,b)=>a.address<b.address?-1:1);
 assert.deepEqual(context.votes.map(({address,power})=>({address,power})),expected,'last commit membership mismatch');
 // Only admitted historical consensus keys can be liable. This bounds record
 // reads by the authority archive, not the size of unrecognized evidence.
 const known=s.authority?new Set(posVotingAuthority(s.authority).usedKeys.map(consensusAddress)):null;
 const rows=new Map(),jailed=new Set(),getRow=address=>{if(known&&!known.has(address))return undefined;if(!rows.has(address))rows.set(address,tx.get(signingKey(address)));return rows.get(address);};
 // Evidence first: tombstoned keys cannot also receive a downtime fine in this block.
 for(const e of context.misbehavior){const row=getRow(e.address);if(!row)continue;
  const r=evidenceInfraction(row.signing,head.policy,e,{height,time,activation:head.activation,bondAt:h=>historicalConsensusBond(tx.get,row,h)});
  if(r.fine){persistFine(tx,s,row,r.fine,height);jailed.add(row.signing.key);}
 }
 for(const v of context.votes){const row=getRow(v.address);assert(row,'active validator needs a consented bond');
  // The context describes H-1, not the block currently being executed.
  if(height-1<row.signing.startHeight)continue;
  const epoch=row.signing.sequence,voteAddress=v.address,bitmap={get(word){const value=tx.get(wordKey(voteAddress,word));return value?.epoch===epoch?value.bits:'0';},set(word,bits){tx.set(wordKey(voteAddress,word),{epoch,bits});}};
  const discipline=head.policy.ballot===V3_BALLOT?tx.get(disciplineKey(row.node)):null;
  const r=signingObservation(row.signing,head.policy,{height,time,flag:v.flag},bitmap,discipline);
  if(r.reset&&discipline)tx.set(disciplineKey(row.node),discipline);
  if(r.fine){persistFine(tx,s,row,r.fine,height);jailed.add(row.signing.key);}
 }
 for(const [address,row]of rows)if(row){auditSigningInfo(row.signing,head.policy);tx.set(signingKey(address),row);}
 // The callback must update the same transaction's authoritative validator
 // schedule. An error rolls back penalties, bitmaps and reserve credits together.
 const removed=[...jailed].sort();if(removed.length)scheduleJail(removed);
 const next=tx.get(POS_HEAD);next.lastHeight=height;next.lastDigest=digest;tx.set(POS_HEAD,next);return {duplicate:false,jailed:removed};
}

export function markConsensusRemoval(tx,key,{height,time}){
 const a=consensusAddress(key),r=tx.get(signingKey(a));assert(r,'known consensus bond');integer(height,r.signing.startHeight);integer(time,1);
 assert.equal(r.signing.removedHeight,null,'already removed');r.signing.removedHeight=height;r.signing.removedTime=time;tx.set(signingKey(a),r);
}

export function unjailConsensusRecord(tx,key,{height,time,author}){
 const a=consensusAddress(key),r=tx.get(signingKey(a)),h=tx.get(POS_HEAD);assert(r&&h);assert.equal(author,key,'validator must request unjail');
 assert.equal(tx.get(bondKey(r.node))?.address,a,'released consensus bond cannot be re-admitted');
 unjailSigningInfo(r.signing,h.policy,{height,time});tx.set(signingKey(a),r);
}

export function assertConsensusAdmission(get,s,key){
 const a=consensusAddress(key),r=get(signingKey(a));assert(r,'consented consensus bond required');
 assert.equal(get(bondKey(r.node))?.address,a,'released consensus bond cannot be re-admitted');
 assert(!r.signing.jailed&&!r.signing.tombstoned&&amount(r.signing.bond)>0n,'jailed or tombstoned consensus signer');
 assertConsensusBondHeld(get,s,r.node);return r;
}
export function markConsensusAdmission(tx,s,key,{height,time}){
 const committed=tx.get(signingKey(consensusAddress(key)));
 if(committed?.signing.jailed){
  // A valid admission committed at H-2 cannot be retracted after Comet has
  // scheduled it. Evidence at H-1 instead schedules removal at H+1. Account
  // for that one already-committed height without unjailing or resetting it.
  const pending=posVotingAuthority(s.authority).pending;
  assert(pending?.kind==='DUEBYTE_POS_EXCLUSION_V1'&&pending.activation===height+1&&pending.excluded.includes(key)&&!pending.validators.some(v=>v.key===key),'jailed admission needs committed immediate exclusion');
  assert.equal(tx.get(bondKey(committed.node))?.address,committed.signing.address);assertConsensusBondHeld(tx.get,s,committed.node);
  integer(height,1);integer(time,1);assert(committed.signing.removedHeight!==null&&height>committed.signing.removedHeight&&time>=committed.signing.removedTime);
  committed.signing.removedHeight=null;committed.signing.removedTime=null;tx.set(signingKey(consensusAddress(key)),committed);return;
 }
 const r=assertConsensusAdmission(tx.get,s,key),h=tx.get(POS_HEAD);
 if(h.policy.ballot===V3_BALLOT){
  const discipline=tx.get(disciplineKey(r.node));assert(discipline);
  if(discipline.awaitingReturn)tx.set(disciplineKey(r.node),{...discipline,awaitingReturn:false,lastReturn:time});
 }
 // Voluntary removal/readmission need not increment the penalty sequence.
 // Clear its bounded bitmap so old misses cannot contaminate the new window.
 for(let n=0;n<Math.ceil(h.policy.signedBlocksWindow/64);n++){const k=wordKey(r.signing.address,n);if(tx.get(k))tx.delete(k);}
 admitSigningInfo(r.signing,h.policy,{height,time});tx.set(signingKey(consensusAddress(key)),r);
}

export function assertConsensusBondHeld(get,s,nodeId){
 const bond=get(bondKey(nodeId));if(!bond)return;const row=get(signingKey(bond.address));assert(row);const node=s.money.nodes[nodeId];
 assert(node&&amount(node.consensusHeld)>=amount(row.signing.bond),'consensus bond cannot be withdrawn or reassigned');
 assert(amount(node.stake)>=amount(node.consensusHeld)+amount(node.taskHeld),'pending payment coverage');
 if(s.authority?.posSlashing&&Object.hasOwn(s.authority.posSlashing,'voting')){
  const f=s.workerFunding?.accounts[nodeId],held=amount(row.signing.bond);
  assert(f&&f.owner===row.owner&&held<=amount(f.depositedMicro)-amount(f.withdrawnMicro),'owner bond coverage');
  assert(held+amount(f.initialStakeMicro)+lockedSupport(s,nodeId)+amount(node.taskHeld)<=amount(node.stake),'owner bond cannot be replaced by support or task collateral');
 }
}

export function releaseConsensusBond(tx,s,key,{height,time,author}){
 const a=consensusAddress(key),row=tx.get(signingKey(a)),h=tx.get(POS_HEAD);assert(row&&h);assert.equal(author,row.owner,'collateral owner');
 const p=s.authority?.posSlashing,v=h.policy.ballot===V3_BALLOT?posVotingAuthority(s.authority):null;
 const neverScheduled=!!v&&!v.usedKeys.includes(key)&&row.signing.observations===0&&row.signing.sequence===0&&row.signing.removedHeight===null;
 assert(neverScheduled||bondReleaseAllowed(row.signing,h.policy,{height,time}),'evidence liability period remains');
 const b=tx.get(bondKey(row.node));assert.equal(b?.address,a,'bond already released');assertConsensusBondHeld(tx.get,s,row.node);tx.delete(bondKey(row.node));
 if(p?.admissions)p.admissions.entries=p.admissions.entries.filter(entry=>entry.key!==key);
 if(neverScheduled)tx.delete(signingKey(a));
 // Release only the remaining consensus hold. This does not transfer funds;
 // the existing collateral withdrawal rules still govern any later withdrawal.
 const node=s.money.nodes[row.node];let remaining=amount(node.consensusHeld)-amount(row.signing.bond);
 if(neverScheduled&&b.previousHold!==undefined&&remaining<amount(b.previousHold))remaining=amount(b.previousHold);
 node.consensusHeld=String(remaining);
 integer(h.count,1);h.count--;tx.set(POS_HEAD,h);
 // Tombstones and historical deductions remain permanent after hold release.
 return row.signing.bond;
}
