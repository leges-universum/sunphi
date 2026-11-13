// Independent coordinator: never copy this inventory/credential with a signer.
// Fences cooperative signer clones, NOT stolen raw keys or a cloned coordinator.
// No timeout takeover, release or remote activation/import API.
import assert from 'node:assert/strict';import fs from 'node:fs';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {hash,hex,exact,integer} from '../crypto.mjs';
import {ExchangeRecovery} from './exchange-recovery.mjs';
export function signingIntent(scope,{order,purpose,attempt,request}){
 hex(scope);hex(order);hex(request);integer(attempt);assert(attempt<=3);assert(['FUNDING','PAYOUT','REFUND','CANCELLED'].includes(purpose));
 return hash([scope,order,purpose,attempt]);
}
function signed(s){exact(s,['raw','transaction']);hex(s.transaction);assert(typeof s.raw==='string'&&/^(?:[a-f0-9]{2})+$/.test(s.raw)&&s.raw.length<=200000);}
export class SigningCoordinator {
 #store;#token;#epoch;
 constructor(file,{config,key,create=false}){
  assert(file!==':memory:');assert.equal(typeof create,'boolean');assert(create?!fs.existsSync(file):fs.existsSync(file),'explicit independent coordinator inventory required');
  if(!create)assert(!fs.existsSync(file+'.recovery-pending'),'unfinished coordinator recovery');
  this.#store=new ExchangeRecovery(file,{config,key});this.scope=hash(config);
  try{
   const db=this.#store.db;assert(!this.#store.restored);assert.equal(db.prepare('SELECT count(*) AS n FROM exchange_recovery_jobs').get().n,0);
   if(!create)assert(db.prepare("SELECT name FROM sqlite_master WHERE name='external_intents'").get(),'coordinator identity missing');
   if(create)assert(!db.prepare("SELECT name FROM sqlite_master WHERE name='signer_epoch'").get());
   db.exec('CREATE TABLE IF NOT EXISTS coordinator_epoch(id INTEGER PRIMARY KEY,epoch INTEGER NOT NULL); INSERT OR IGNORE INTO coordinator_epoch VALUES(1,0); CREATE TABLE IF NOT EXISTS external_intents(id TEXT PRIMARY KEY,status TEXT NOT NULL,record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS external_resources(resource TEXT PRIMARY KEY,intent TEXT NOT NULL); CREATE TABLE IF NOT EXISTS external_terminal(order_id TEXT PRIMARY KEY,purpose TEXT NOT NULL);');
   db.exec('CREATE TABLE IF NOT EXISTS coordinator_continuity(id INTEGER PRIMARY KEY,cap_hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS coordinator_continuity_role(id INTEGER PRIMARY KEY,role TEXT NOT NULL);');
   this.activate();
  }catch(e){this.#store.close();throw e;}
 }
 // Supervisor-only capability, kept out of signer backup. Rotation does not
 // discard reservations or make uncertain signatures safe to repeat.
 activate(){const db=this.#store.db;this.#epoch=db.prepare('SELECT epoch FROM coordinator_epoch WHERE id=1').get().epoch+1;integer(this.#epoch,1);db.prepare('UPDATE coordinator_epoch SET epoch=? WHERE id=1').run(this.#epoch);this.#token?.fill(0);this.#token=randomBytes(32);return {epoch:this.#epoch,token:this.#token.toString('hex')};}
 continuityProtected(){return Boolean(this.#store.db.prepare('SELECT cap_hash FROM coordinator_continuity WHERE id=1').get());}
 continuityRole(){return this.#store.db.prepare('SELECT role FROM coordinator_continuity_role WHERE id=1').get()?.role;}
 // Supervisor-only durable fencing. A surviving witness must be enrolled
 // before its first reservation. TLS reconnection cannot recover an old grant.
 rotateContinuity(role=this.continuityRole()){
  assert(['primary','witness','recovery'].includes(role),'explicit continuity role required');
  const db=this.#store.db;if(!this.continuityProtected())assert.equal(db.prepare('SELECT count(*) AS n FROM external_intents').get().n,0,'nonempty unpaired coordinator');
  else assert.equal(role,this.continuityRole(),'continuity role is immutable');
  const capability=randomBytes(32).toString('hex');db.exec('BEGIN IMMEDIATE');try{
   db.prepare('INSERT OR REPLACE INTO coordinator_continuity VALUES(1,?)').run(hash(capability));
   db.prepare('INSERT OR IGNORE INTO coordinator_continuity_role VALUES(1,?)').run(role);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}return capability;
 }
 #auth(s,continuity){exact(s,['epoch','token']);assert.equal(s.epoch,this.#epoch,'retired coordinator session');hex(s.token);assert(timingSafeEqual(Buffer.from(s.token,'hex'),this.#token),'coordinator capability');
  const gate=this.#store.db.prepare('SELECT cap_hash FROM coordinator_continuity WHERE id=1').get();
  if(gate){assert(['primary','witness','recovery'].includes(this.continuityRole()),'continuity role missing');hex(continuity);assert.equal(hash(continuity),gate.cap_hash,'retired continuity capability');}else assert.equal(continuity,undefined,'coordinator not continuity enrolled');
 }
 #read(id){const row=this.#store.db.prepare('SELECT * FROM external_intents WHERE id=?').get(id);if(!row)return null;const value=this.#store.open('external/'+id,row.record);assert.equal(value.status,row.status);return value;}
 get(session,intent,continuity){this.#auth(session,continuity);exact(intent,['order','purpose','attempt','request']);const id=signingIntent(this.scope,intent),r=this.#read(id);if(r){assert.deepEqual(r.intent,intent,'changed immutable intent');delete r.permit;}return r;}
 reserve(session,intent,plan,continuity){
  this.#auth(session,continuity);exact(intent,['order','purpose','attempt','request']);const id=signingIntent(this.scope,intent);assert(!this.#read(id),'intent already reserved');
  assert(plan&&Array.isArray(plan.resources)&&plan.resources.length>0&&plan.resources.length<=64);assert(JSON.stringify(plan).length<=220000);
  assert.equal(new Set(plan.resources).size,plan.resources.length);for(const r of plan.resources)assert(typeof r==='string'&&/^[a-zA-Z0-9:/._-]{1,256}$/.test(r));
  const db=this.#store.db;
  // Any unknown signing result stops new signing across all purposes/accounts.
  assert(!db.prepare("SELECT id FROM external_intents WHERE status='PREPARING'").get(),'uncertain external signing');
  assert(db.prepare('SELECT count(*) AS n FROM external_intents').get().n<4096,'coordinator inventory capacity');
  const r={intent:structuredClone(intent),plan:structuredClone(plan),status:'PREPARING',permit:randomBytes(32).toString('hex')};
  db.exec('BEGIN IMMEDIATE');try{
   if(intent.purpose==='FUNDING')assert(!db.prepare('SELECT purpose FROM external_terminal WHERE order_id=?').get(intent.order),'terminal action already reserved');
   if(['PAYOUT','REFUND','CANCELLED'].includes(intent.purpose)){
    const t=db.prepare('SELECT purpose FROM external_terminal WHERE order_id=?').get(intent.order);assert(!t||t.purpose===intent.purpose,'conflicting terminal action');
    if(!t)db.prepare('INSERT INTO external_terminal VALUES(?,?)').run(intent.order,intent.purpose);
   }
   for(const resource of plan.resources)db.prepare('INSERT INTO external_resources VALUES(?,?)').run(hash([this.scope,resource]),id);
   db.prepare('INSERT INTO external_intents VALUES(?,?,?)').run(id,r.status,this.#store.seal('external/'+id,r));db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {permit:r.permit};
 }
 commit(session,intent,permit,result,continuity){
  this.#auth(session,continuity);exact(intent,['order','purpose','attempt','request']);hex(permit);signed(result);const id=signingIntent(this.scope,intent),r=this.#read(id);assert(r&&r.permit===permit,'reservation capability');assert.deepEqual(r.intent,intent);
  if(r.status==='SIGNED'){assert.deepEqual(r.signed,result,'changed signed bytes');return r.signed;}
  assert.equal(r.status,'PREPARING');r.status='SIGNED';r.signed=structuredClone(result);
  this.#store.db.prepare('UPDATE external_intents SET status=?,record=? WHERE id=?').run(r.status,this.#store.seal('external/'+id,r),id);
  return structuredClone(result);
 }
 status(){return this.#store.db.prepare('SELECT id,status FROM external_intents ORDER BY id').all().map(r=>({...r}));}
 // Authenticated online comparison only. A nonce defeats cached replies, not
 // rollback of this independent authority itself. No permits or raw bytes.
 checkpoint(session,challenge,continuity){
  this.#auth(session,continuity);hex(challenge);const snapshot=this.recoverySnapshot();
  return {domain:'DUEBYTE_COORDINATOR_LIVE_CHECKPOINT_V1',scope:this.scope,challenge,epoch:this.#epoch,
   snapshotHash:hash(snapshot),records:snapshot.records.length,uncertain:snapshot.records.filter(r=>r.status==='PREPARING').length};
 }
 // Supervisor-only logical export. Never expose this over the signer service.
 // Reservation permits and session capabilities are deliberately excluded.
 recoverySnapshot(){
  const db=this.#store.db;db.exec('BEGIN');try{
   const records=db.prepare('SELECT id FROM external_intents ORDER BY id').all().map(({id})=>{const r=this.#read(id);delete r.permit;return {id,...r};});
   const resources=db.prepare('SELECT resource,intent FROM external_resources ORDER BY resource').all().map(r=>({...r}));
   const terminals=db.prepare('SELECT order_id,purpose FROM external_terminal ORDER BY order_id').all().map(r=>({...r}));
   db.exec('COMMIT');return {domain:'DUEBYTE_COORDINATOR_SNAPSHOT_V1',scope:this.scope,records,resources,terminals};
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 close(){this.#store.close();this.#token.fill(0);}
}
export function coordinatorChannel(coordinator,session,continuity){return Object.fromEntries(['get','reserve','commit','checkpoint'].map(name=>[name,(...args)=>coordinator[name](session,...args,continuity)]));}
// Reused by funding, payout and recovery adapters. The trusted adapter must
// authorize terms and independently inspect exact signed nonce/inputs/outputs.
export async function coordinatedExternalSigning(channel,intent,backend){
 intent=structuredClone(intent);const old=await channel.get(intent);
 if(old){assert.equal(old.status,'SIGNED','uncertain external signing');await backend.inspect(old.signed,old.plan);return structuredClone(old.signed);}
 await backend.authorize();const plan=structuredClone(await backend.plan());
 const {permit}=await channel.reserve(intent,plan);
 const result=structuredClone(await backend.sign(structuredClone(plan)));signed(result);await backend.inspect(result,plan);
 // Never expose raw bytes until the independent durable commit succeeds.
 return await channel.commit(intent,permit,result);
}
