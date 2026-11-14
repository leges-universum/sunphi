// Two durable fault domains, not quorum election or automatic failover.
// The designated witness is authoritative for recovery ONLY if it has not
// itself been lost/rolled back. Never promote an offline backup of the witness.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {randomBytes} from 'node:crypto';import {hash,hex,exact,integer} from '../crypto.mjs';
import {SigningCoordinator} from './exchange-signing-coordinator.mjs';
import {ExchangeRecovery} from './exchange-recovery.mjs';
import {validateCoordinatorSnapshot} from './exchange-coordinator-backup.mjs';
import {validateAdmissions,admissionReceipt} from './exchange-coordinator-capacity.mjs';

export function pairedCoordinator(primary,witness,scope){
 return replicatedCoordinator([primary,witness],scope);
}
// All three must be online. This is synchronous durability, not majority
// election. The recovery authority must survive outside both working domains.
export function recoveryProtectedCoordinator(primary,witness,recovery,scope){
 return replicatedCoordinator([primary,witness,recovery],scope);
}
function replicatedCoordinator(channels,scope){
 assert.equal(new Set(channels).size,channels.length,'distinct coordinator channels required');hex(scope);
 const permits=new Map();
 async function matching(challenge=randomBytes(32).toString('hex')){
  hex(challenge);const replies=[];
  for(const c of channels){
   const r=await c.checkpoint(challenge);exact(r,['domain','scope','challenge','epoch','snapshotHash','records','uncertain']);
   assert.equal(r.domain,'DUEBYTE_COORDINATOR_LIVE_CHECKPOINT_V1');assert.equal(r.scope,scope);assert.equal(r.challenge,challenge);
   hex(r.snapshotHash);integer(r.epoch,1);integer(r.records);integer(r.uncertain);assert(r.records<=4096&&r.uncertain<=r.records);replies.push(r);
  }
  for(const reply of replies.slice(1)){
   assert.equal(replies[0].snapshotHash,reply.snapshotHash,'coordinator journals diverged');
   assert.equal(replies[0].records,reply.records);assert.equal(replies[0].uncertain,reply.uncertain);
  }
  return replies[0];
 }
 return Object.freeze({
  checkpoint:matching,
  async admit(order){
   hex(order);assert.equal(permits.size,0,'paired signing already pending');
   await matching();const receipt=admissionReceipt(order);
   for(const c of [...channels].reverse())assert.deepEqual(await c.admit(order),receipt,'admission receipt mismatch');
   await matching();return receipt;
  },
  async get(intent){
   intent=structuredClone(intent);const before=await matching(),a=await channels[0].get(intent);
   for(const c of channels.slice(1))assert.deepEqual(a,await c.get(intent),'coordinator intent mismatch');
   const after=await matching();assert.equal(before.snapshotHash,after.snapshotHash,'coordinator journal advanced');return structuredClone(a);
  },
  async reserve(intent,plan){
   intent=structuredClone(intent);plan=structuredClone(plan);assert.equal(permits.size,0,'paired signing already pending');
   const c=await matching();assert.equal(c.uncertain,0,'uncertain external signing');
   // Witness-first is mandatory. A failed second write remains PREPARING;
   // neither timeout nor restart grants permission to sign again.
   const reservations=[];
   for(const channel of [...channels].reverse())reservations.push({channel,...await channel.reserve(intent,plan)});
   const permit=randomBytes(32).toString('hex');
   permits.set(permit,{intent,reservations});return {permit};
  },
  async commit(intent,permit,result){
   intent=structuredClone(intent);result=structuredClone(result);const r=permits.get(permit);assert(r,'paired reservation capability');assert.deepEqual(r.intent,intent);
   try{
    for(const {channel,permit:grant} of r.reservations)assert.deepEqual(await channel.commit(intent,grant,result),result);
    await matching();return structuredClone(result);
   }finally{permits.delete(permit);}
  }
 });
}

function syncDirectory(dir){if(process.platform==='win32')return;const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export function recoverCoordinatorFromWitness({witness,config,key,directory}){
 assert(witness instanceof SigningCoordinator&&witness.continuityProtected(),'live enrolled witness required');
 assert.equal(witness.continuityRole(),'witness','designated witness required');
 assert.equal(witness.scope,hash(config),'foreign witness');assert(Buffer.isBuffer(key)&&key.length===32);
 assert(path.isAbsolute(directory));const st=fs.lstatSync(directory);assert(st.isDirectory()&&!st.isSymbolicLink());
 // This revocation is durable and applies to remote clients too. Do it before
 // exporting anything. Failure below leaves old clients fenced, not enabled.
 const witnessCapability=witness.rotateContinuity(),snapshot=witness.recoverySnapshot();
 const counts=validateCoordinatorSnapshot(snapshot,hash(config));assert.equal(counts.uncertain,0,'uncertain witness signature; manual reconciliation required');
 const {file,capability:primaryCapability}=rebuildInventory(snapshot,config,key,directory,'primary');
 return {file,primaryCapability,witnessCapability,report:{scope:snapshot.scope,snapshotHash:hash(snapshot),...counts,mode:'LIVE_WITNESS_REBUILD',requiresUnrolledBackWitness:true}};
}

// Supervisor only: never accept an offline snapshot as a live authority.
// This handles loss of BOTH working journals, not loss of every durable copy.
export function recoverCoordinatorPair({recovery,config,primaryKey,witnessKey,directory}){
 assert(recovery instanceof SigningCoordinator&&recovery.continuityProtected(),'live enrolled recovery authority required');
 assert.equal(recovery.continuityRole(),'recovery','designated recovery authority required');
 assert.equal(recovery.scope,hash(config),'foreign recovery authority');
 for(const key of [primaryKey,witnessKey])assert(Buffer.isBuffer(key)&&key.length===32);
 assert(!primaryKey.equals(witnessKey),'distinct inventory keys required');
 assert(path.isAbsolute(directory));const st=fs.lstatSync(directory);assert(st.isDirectory()&&!st.isSymbolicLink());
 // Revoke old signer profiles before building either destination. If any step
 // fails the new grant is not returned and old profiles remain fenced.
 const recoveryCapability=recovery.rotateContinuity(),snapshot=recovery.recoverySnapshot();
 const counts=validateCoordinatorSnapshot(snapshot,hash(config));
 assert.equal(counts.uncertain,0,'uncertain recovery signature; manual reconciliation required');
 const primary=rebuildInventory(snapshot,config,primaryKey,directory,'primary');
 const witness=rebuildInventory(snapshot,config,witnessKey,directory,'witness');
 return {primary,witness,recoveryCapability,report:{scope:snapshot.scope,snapshotHash:hash(snapshot),...counts,
  mode:'LIVE_RECOVERY_PAIR_REBUILD',requiresUnrolledBackRecovery:true}};
}

function rebuildInventory(snapshot,config,key,directory,role){
 const admissions=validateAdmissions(snapshot.admissions??[...new Set(snapshot.records.map(r=>r.intent.order))].sort(),snapshot.records);
 const dir=fs.mkdtempSync(path.join(directory,'coordinator-recovered-'));fs.chmodSync(dir,0o700);syncDirectory(directory);
 const file=path.join(dir,'inventory.sqlite'),pending=file+'.recovery-pending';
 const fd=fs.openSync(pending,'wx',0o600);try{fs.writeFileSync(fd,'Recovery incomplete. Do not activate.\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory(dir);
 // A unique destination and a persistent incomplete marker prevent a crash
 // from turning a partially constructed inventory into an empty authority.
 const fresh=new SigningCoordinator(file,{config,key,create:true});let capability;
 try{capability=fresh.rotateContinuity(role);}finally{fresh.close();}
 const store=new ExchangeRecovery(file,{config,key});
 try{
  const db=store.db;db.exec('BEGIN IMMEDIATE');try{
   assert.equal(db.prepare('SELECT count(*) AS n FROM external_intents').get().n,0);
   for(const record of snapshot.records){const {id,...r}=record;r.permit=randomBytes(32).toString('hex');db.prepare('INSERT INTO external_intents VALUES(?,?,?)').run(id,r.status,store.seal('external/'+id,r));}
   for(const r of snapshot.resources)db.prepare('INSERT INTO external_resources VALUES(?,?)').run(r.resource,r.intent);
   for(const r of snapshot.terminals)db.prepare('INSERT INTO external_terminal VALUES(?,?)').run(r.order_id,r.purpose);
   for(const order of admissions)db.prepare('INSERT INTO external_admissions VALUES(?)').run(order);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
 }finally{store.close();}
 const inventory=fs.openSync(file,'r+');try{fs.fsyncSync(inventory);}finally{fs.closeSync(inventory);}syncDirectory(dir);
 fs.unlinkSync(pending);syncDirectory(dir);
 // Capabilities go only to the local trusted supervisor, never a report or
 // signer backup. Offline backups cannot call this recovery operation.
 return {file,capability};
}
