// Isolated key-holder boundary. Worker journals never contain this authority's
// database key or session capability. Deploy exactly one authority per key set.
// An independent coordinator fences cooperative copies. Stolen raw keys and
// copies of the coordinator itself remain outside this software boundary.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {hash,hex,exact,integer} from '../crypto.mjs';
import {ExchangeRecovery} from './exchange-recovery.mjs';
import {coordinatedExternalSigning} from './exchange-signing-coordinator.mjs';

export class ExchangeSigningAuthority {
 #store; #backend; #token; #epoch; #busy=false; #coordinator;
 constructor(file,{config,key,backend,create=false,coordinator}){
  assert(typeof file==='string'&&file!==':memory:','durable signer inventory required');
  assert.equal(typeof create,'boolean');assert(create?!fs.existsSync(file):fs.existsSync(file),create?'signer provisioning requires a new file':'signer inventory missing; reconciliation required');
  for(const name of ['authorize','plan','sign','inspect'])assert.equal(typeof backend[name],'function');
  if(coordinator)for(const n of ['get','reserve','commit'])assert.equal(typeof coordinator[n],'function');
  this.#coordinator=coordinator;this.#backend=backend;this.#store=new ExchangeRecovery(file,{config,key});
  try{
   assert(!this.#store.restored,'restored worker inventory cannot become a signer');
   assert.equal(this.#store.db.prepare('SELECT count(*) AS n FROM exchange_recovery_jobs').get().n,0,'worker journal is not signer inventory');
   if(!create)assert(this.#store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='signer_epoch'").get(),'signer inventory identity missing');
   this.#store.db.exec('CREATE TABLE IF NOT EXISTS signer_epoch(id INTEGER PRIMARY KEY,value INTEGER NOT NULL); INSERT OR IGNORE INTO signer_epoch VALUES(1,0); CREATE TABLE IF NOT EXISTS signer_intents(id TEXT PRIMARY KEY,job TEXT NOT NULL,attempt INTEGER NOT NULL,status TEXT NOT NULL,record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS signer_resources(resource TEXT PRIMARY KEY,intent TEXT NOT NULL);');
   const db=this.#store.db;
   db.exec('CREATE TABLE IF NOT EXISTS signer_coordination(id INTEGER PRIMARY KEY,required INTEGER NOT NULL);');
   const enrolled=db.prepare('SELECT required FROM signer_coordination WHERE id=1').get();
   assert(!enrolled?.required||coordinator,'independent coordinator required; local fallback forbidden');
   if(coordinator&&!enrolled){
    assert.equal(db.prepare('SELECT count(*) AS n FROM signer_intents').get().n,0,'existing local signing requires reconciliation before coordination');
    db.prepare('INSERT INTO signer_coordination VALUES(1,1)').run();
   }
   this.activate();
  }catch(e){this.#store.close();throw e;}
 }
 // Local administrative capability only. No automatic timeout takeover and no
 // remotely exposed activation method. Restart invalidates every old session.
 activate(){
  assert(!this.#busy,'signer busy');const db=this.#store.db;
  const epoch=db.prepare('SELECT value FROM signer_epoch WHERE id=1').get().value+1;
  integer(epoch,1);db.prepare('UPDATE signer_epoch SET value=? WHERE id=1').run(epoch);
  this.#token?.fill(0);this.#token=randomBytes(32);this.#epoch=epoch;
  return {epoch,token:this.#token.toString('hex')};
 }
 #authenticate(session){
  exact(session,['epoch','token']);assert.equal(session.epoch,this.#epoch,'retired signer session');
  hex(session.token);assert(timingSafeEqual(Buffer.from(session.token,'hex'),this.#token),'invalid signer session');
 }
 async prepare(session,packet,{attempt=0}={}){
  session=structuredClone(session);packet=structuredClone(packet);
  this.#authenticate(session);assert(!this.#busy,'signer busy');integer(attempt);assert(attempt<=3);
  this.#busy=true;
  try{
   const store=this.#store,db=store.db,job=store.validate(packet),request=hash(packet),id=hash([job,attempt]);
   assert(['REFUND','CANCELLED'].includes(packet.recoveryKind),'recovery signing only');
   if(this.#coordinator){
    const intent={order:job,purpose:packet.recoveryKind,attempt,request};
    const result=await coordinatedExternalSigning(this.#coordinator,intent,{
     authorize:async()=>{
      if(attempt){const prior=await this.#coordinator.get({...intent,attempt:attempt-1});assert(prior?.status==='SIGNED');assert.equal(packet.quote.asset,'USDC');assert.equal(typeof this.#backend.failed,'function');const failed=await this.#backend.failed(packet,prior.signed);assert(failed,'canonical finalized revert required');exact(failed,['transaction','block']);assert.equal(failed.transaction,prior.signed.transaction);hex(failed.block);}
      this.#authenticate(session);await this.#backend.authorize(packet);
     },
     plan:()=>this.#backend.plan(packet),
     sign:plan=>{this.#authenticate(session);return this.#backend.sign(packet,plan);},
     inspect:async(s,p)=>{await this.#backend.inspect(packet,s,p);this.#authenticate(session);}
    });
    this.#authenticate(session);return result;
   }
   const old=db.prepare('SELECT * FROM signer_intents WHERE id=?').get(id);
   if(old){
    const record=store.open('signer/'+id,old.record);assert.equal(record.request,request,'changed signing request');
    assert.equal(record.status,old.status);assert.equal(old.status,'SIGNED','uncertain signing requires reconciliation');
    await this.#backend.inspect(packet,record.signed,record.plan);this.#authenticate(session);
    return structuredClone(record.signed);
   }
   // A crash after invoking a signer cannot prove that no signature escaped.
   // Never retry that intent or allocate another nonce while it is uncertain.
   assert(!db.prepare("SELECT id FROM signer_intents WHERE status='PREPARING'").get(),'uncertain signing inventory');
   assert(db.prepare('SELECT count(*) AS n FROM signer_intents').get().n<128,'signer inventory capacity');
   const previous=db.prepare('SELECT * FROM signer_intents WHERE job=? ORDER BY attempt DESC LIMIT 1').get(job);
   if(attempt){
    assert(packet.quote.asset==='USDC'&&previous&&previous.attempt===attempt-1);
    assert.equal(previous.status,'SIGNED');assert.equal(typeof this.#backend.failed,'function');
    const prior=store.open('signer/'+previous.id,previous.record);assert.equal(prior.request,request);
    const failed=await this.#backend.failed(packet,prior.signed);assert(failed,'canonical finalized revert required');
    exact(failed,['transaction','block']);assert.equal(failed.transaction,prior.signed.transaction);hex(failed.block);
   }else assert(!previous,'signing attempt order');
   await this.#backend.authorize(packet);
   const plan=structuredClone(await this.#backend.plan(packet));assert(plan&&Array.isArray(plan.resources)&&plan.resources.length>0&&plan.resources.length<=64);
   assert(JSON.stringify(plan).length<=220000);assert.equal(new Set(plan.resources).size,plan.resources.length);
   for(const resource of plan.resources)assert(typeof resource==='string'&&/^[a-zA-Z0-9:/._-]{1,256}$/.test(resource));
   this.#authenticate(session);const record={request,status:'PREPARING',plan};
   db.exec('BEGIN IMMEDIATE');try{
    for(const resource of plan.resources)db.prepare('INSERT INTO signer_resources VALUES(?,?)').run(hash(resource),id);
    db.prepare('INSERT INTO signer_intents VALUES(?,?,?,?,?)').run(id,job,attempt,'PREPARING',store.seal('signer/'+id,record));db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e;}
   const signed=structuredClone(await this.#backend.sign(packet,structuredClone(plan)));
   exact(signed,['raw','transaction']);hex(signed.transaction);assert(typeof signed.raw==='string'&&/^(?:[a-f0-9]{2})+$/.test(signed.raw)&&signed.raw.length<=200000);
   await this.#backend.inspect(packet,signed,plan);this.#authenticate(session);
   record.status='SIGNED';record.signed=signed;
   db.prepare('UPDATE signer_intents SET status=?,record=? WHERE id=?').run('SIGNED',store.seal('signer/'+id,record),id);
   return structuredClone(signed);
  }finally{this.#busy=false;}
 }
 status(){return this.#store.db.prepare('SELECT job,attempt,status FROM signer_intents ORDER BY job,attempt').all().map(r=>({...r}));}
 close(){assert(!this.#busy);this.#store.close();this.#token.fill(0);}
}

// The caller receives only an RPC-like prepare function, never the backend or
// authority activation method. Production requires authenticated transport.
export function fencedPreparation(authority,session){return (packet,options)=>authority.prepare(session,packet,options);}
