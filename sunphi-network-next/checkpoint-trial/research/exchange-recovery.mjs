// Isolated V2 recovery. Durable encrypted outbox; private keys stay in adapters.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {hash,hex,exact,integer,verify} from '../crypto.mjs';
import {sqlitePath} from '../sqlite-path.mjs';
import {checkExchangeConfig} from './exchange-native.mjs';
import {checkExchangeQuote,exchangeAcceptance} from './exchange-escrow.mjs';
import {EXCHANGE_V2,checkExchangeArm,verifyExchangeResolution} from './exchange-resolution.mjs';
const DOMAIN='DUEBYTE_EXCHANGE_RECOVERY_V2',MAX=300000;
export class ExchangeRecovery {
 constructor(file,{config,key}){
  checkExchangeConfig(config);assert.equal(config.exchangeLab.policy.domain,EXCHANGE_V2);
  assert(Buffer.isBuffer(key)&&key.length===32);this.key=Buffer.from(key);this.config=structuredClone(config);this.pin=hash(config);this.busy=false;
  if(file!==':memory:'&&fs.existsSync(file))assert(fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink());
  try{this.db=new DatabaseSync(sqlitePath(file));
  // Retain the SQLite file lock across asynchronous external calls. A second
  // executor must not prepare a competing nonce/UTXO from the same journal.
  // This fences one journal, not copied files or different accounts/hosts.
  this.db.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS exchange_recovery_meta(id INTEGER PRIMARY KEY,pin TEXT NOT NULL,seal TEXT NOT NULL); CREATE TABLE IF NOT EXISTS exchange_recovery_jobs(id TEXT PRIMARY KEY,packet TEXT NOT NULL,outbox TEXT,status TEXT NOT NULL);');
  if(!this.db.prepare('PRAGMA table_info(exchange_recovery_jobs)').all().some(c=>c.name==='receipt'))this.db.exec('ALTER TABLE exchange_recovery_jobs ADD COLUMN receipt TEXT');
  this.db.exec('CREATE TABLE IF NOT EXISTS exchange_recovery_retired(id TEXT NOT NULL,attempt INTEGER NOT NULL,packet TEXT NOT NULL,PRIMARY KEY(id,attempt))');
  const meta=this.db.prepare('SELECT * FROM exchange_recovery_meta WHERE id=1').get();
  if(meta){assert.equal(meta.pin,this.pin,'recovery network pin');const m=this.open('meta',meta.seal);assert.equal(m.domain,DOMAIN);assert(m.mode===undefined||m.mode==='RESTORED');this.restored=m.mode==='RESTORED';}else{this.restored=false;this.db.prepare('INSERT INTO exchange_recovery_meta VALUES(1,?,?)').run(this.pin,this.seal('meta',{domain:DOMAIN}));}}catch(e){this.db?.close();this.key.fill(0);throw e;}
 }
 seal(id,value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(DOMAIN+this.pin+id));const raw=Buffer.from(JSON.stringify(value));assert(raw.length<=MAX);try{const data=Buffer.concat([cipher.update(raw),cipher.final()]);return JSON.stringify({iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),data:data.toString('base64')});}finally{raw.fill(0);}}
 open(id,encrypted){assert(typeof encrypted==='string'&&encrypted.length<MAX*2);const b=JSON.parse(encrypted);exact(b,['iv','tag','data']);assert(/^[a-f0-9]{24}$/.test(b.iv)&&/^[a-f0-9]{32}$/.test(b.tag));const d=createDecipheriv('aes-256-gcm',this.key,Buffer.from(b.iv,'hex'));d.setAAD(Buffer.from(DOMAIN+this.pin+id));d.setAuthTag(Buffer.from(b.tag,'hex'));let raw;try{raw=Buffer.concat([d.update(Buffer.from(b.data,'base64')),d.final()]);assert(raw.length<=MAX);return JSON.parse(raw);}finally{raw?.fill(0);}}
 validate(packet){exact(packet,['quote','providerSignature','userSignature','arm','recoveryKind']);const p=this.config.exchangeLab.policy,q=packet.quote;checkExchangeQuote(p,q,q.createdAt);assert(verify(q,packet.providerSignature,p.provider));assert(verify(exchangeAcceptance(q),packet.userSignature,q.user));checkExchangeArm(q,packet.arm);assert(['OBSERVE','REFUND','CANCELLED'].includes(packet.recoveryKind));return hash(q);}
 enqueue(packet){assert(!this.busy);const id=this.validate(packet),prior=this.db.prepare('SELECT packet FROM exchange_recovery_jobs WHERE id=?').get(id);if(prior)assert.deepEqual(this.open(id,prior.packet),packet,'immutable recovery job');else{assert(this.db.prepare('SELECT count(*) AS n FROM exchange_recovery_jobs').get().n<32);this.db.prepare('INSERT INTO exchange_recovery_jobs(id,packet,status) VALUES(?,?,?)').run(id,this.seal(id,packet),'WAITING');}return id;}
 status(){return this.db.prepare('SELECT id,status FROM exchange_recovery_jobs ORDER BY id').all().map(r=>({...r}));}
 // A consistent logical snapshot: the portable envelope supplies encryption.
 // Never log the returned plaintext or copy a live SQLite file directly.
 snapshot(){assert(!this.busy);this.db.exec('BEGIN');try{
  const jobs=this.db.prepare('SELECT * FROM exchange_recovery_jobs ORDER BY id').all().map(r=>({id:r.id,packet:this.open(r.id,r.packet),outbox:r.outbox?this.open(r.id+'/outbox',r.outbox):null,receipt:r.receipt?this.open(r.id+'/receipt',r.receipt):null,retired:this.db.prepare('SELECT * FROM exchange_recovery_retired WHERE id=? ORDER BY attempt').all(r.id).map(t=>({attempt:t.attempt,value:this.open(r.id+'/retired/'+t.attempt,t.packet)}))}));
  this.db.exec('COMMIT');return {domain:DOMAIN+'/SNAPSHOT',pin:this.pin,jobs};
 }catch(e){this.db.exec('ROLLBACK');throw e;}}
 restoreSnapshot(s){assert(!this.busy);exact(s,['domain','pin','jobs']);assert.equal(s.domain,DOMAIN+'/SNAPSHOT');assert.equal(s.pin,this.pin);assert(Array.isArray(s.jobs)&&s.jobs.length<=32);assert.equal(this.db.prepare('SELECT count(*) AS n FROM exchange_recovery_jobs').get().n,0,'restore requires an empty destination');
  const ids=new Set(),signed=v=>{exact(v,['raw','transaction']);hex(v.transaction);assert(typeof v.raw==='string'&&/^(?:[a-f0-9]{2})+$/.test(v.raw)&&v.raw.length<=200000);};
  for(const r of s.jobs){exact(r,['id','packet','outbox','receipt','retired']);assert.equal(r.id,this.validate(r.packet));assert(!ids.has(r.id));ids.add(r.id);if(r.outbox)signed(r.outbox);else assert.equal(r.outbox,null);
   if(r.receipt)verifyExchangeResolution(this.config.exchangeLab.policy,r.packet.quote,r.packet.arm.plan,r.receipt,r.receipt.body.observedAt);else assert.equal(r.receipt,null);
   assert(Array.isArray(r.retired)&&r.retired.length<=3);for(const [i,t] of r.retired.entries()){exact(t,['attempt','value']);assert.equal(t.attempt,i+1);exact(t.value,['saved','failed']);signed(t.value.saved);exact(t.value.failed,['transaction','block']);assert.equal(t.value.failed.transaction,t.value.saved.transaction);hex(t.value.failed.block);}
  }
  this.db.exec('BEGIN IMMEDIATE');try{
   for(const r of s.jobs){this.db.prepare('INSERT INTO exchange_recovery_jobs(id,packet,outbox,receipt,status) VALUES(?,?,?,NULL,?)').run(r.id,this.seal(r.id,r.packet),r.outbox?this.seal(r.id+'/outbox',r.outbox):null,'RECONCILIATION_REQUIRED');for(const t of r.retired)this.db.prepare('INSERT INTO exchange_recovery_retired VALUES(?,?,?)').run(r.id,t.attempt,this.seal(r.id+'/retired/'+t.attempt,t.value));}
   // An old backup cannot prove that no newer signature/nonce/job ever existed.
   // Preserve this restriction across restart and subsequent backups. There is
   // deliberately no automatic promotion back to a signing executor.
   this.db.prepare('UPDATE exchange_recovery_meta SET seal=? WHERE id=1').run(this.seal('meta',{domain:DOMAIN,mode:'RESTORED'}));this.db.exec('COMMIT');this.restored=true;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 async tick(adapter){assert(!this.busy,'recovery busy');this.busy=true;const result=[];
  try{for(const row of this.db.prepare('SELECT * FROM exchange_recovery_jobs ORDER BY id').all()){
   try{const packet=this.open(row.id,row.packet);assert.equal(this.validate(packet),row.id);
    // Adapter must supply consensus-verified state, never a UI cache.
    const view=await adapter.native(row.id);assert.equal(view.configHash,this.pin);integer(view.now,packet.quote.createdAt);const order=view.order;assert(order);assert.deepEqual(order.quote,packet.quote);assert.deepEqual(order.plan,packet.arm.plan);
    if(order.status!=='LOCKED'){assert(['CLAIMED','REFUNDED'].includes(order.status));hex(order.resolution);this.mark(row.id,'COMPLETE');result.push({id:row.id,status:'COMPLETE'});continue;}
    // Even COMPLETE is reconciled: a rolled-back journal cannot authorize funds.
    let receipt=row.receipt&&this.open(row.id+'/receipt',row.receipt);
    if(receipt&&receipt.body.expiresAt<view.now)receipt=null;
    if(!receipt){
    let external=await adapter.discover(packet);
    if(!external&&packet.recoveryKind!=='OBSERVE'&&view.now>=packet.quote.externalUntil){
     let saved=row.outbox&&this.open(row.id+'/outbox',row.outbox);
     if(this.restored&&!saved){this.mark(row.id,'RECONCILIATION_REQUIRED');result.push({id:row.id,status:'RECONCILIATION_REQUIRED'});continue;}
     if(saved&&packet.quote.asset==='USDC'&&adapter.failed){
      const failed=await adapter.failed(packet,saved);
      if(failed){exact(failed,['transaction','block']);assert.equal(failed.transaction,saved.transaction);hex(failed.block);
       if(this.restored){this.mark(row.id,'RECONCILIATION_REQUIRED');result.push({id:row.id,status:'RECONCILIATION_REQUIRED'});continue;}
       const count=this.db.prepare('SELECT count(*) AS n FROM exchange_recovery_retired WHERE id=?').get(row.id).n;
       if(count>=3){this.mark(row.id,'REVIEW_REQUIRED');result.push({id:row.id,status:'REVIEW_REQUIRED'});continue;}
       // The adapter must prove canonical final REVERT, never infer it from
       // absence or timeout. Retain the old signed bytes before a fresh nonce.
       this.db.exec('BEGIN IMMEDIATE');try{
        assert.equal(this.db.prepare('SELECT outbox FROM exchange_recovery_jobs WHERE id=?').get(row.id).outbox,row.outbox);
        this.db.prepare('INSERT INTO exchange_recovery_retired VALUES(?,?,?)').run(row.id,count+1,this.seal(row.id+'/retired/'+(count+1),{saved,failed}));
        this.db.prepare('UPDATE exchange_recovery_jobs SET outbox=NULL,receipt=NULL,status=? WHERE id=?').run('WAITING',row.id);this.db.exec('COMMIT');
       }catch(e){this.db.exec('ROLLBACK');throw e;}
       result.push({id:row.id,status:'WAITING'});continue;
      }
     }
     if(!saved){const attempt=this.db.prepare('SELECT count(*) AS n FROM exchange_recovery_retired WHERE id=?').get(row.id).n;saved=await adapter.prepare(packet,{attempt});exact(saved,['raw','transaction']);hex(saved.transaction);assert(typeof saved.raw==='string'&&/^(?:[a-f0-9]{2})+$/.test(saved.raw)&&saved.raw.length<=200000);await adapter.inspect(packet,saved);
      this.db.prepare('UPDATE exchange_recovery_jobs SET outbox=? WHERE id=? AND outbox IS NULL').run(this.seal(row.id+'/outbox',saved),row.id);
      saved=this.open(row.id+'/outbox',this.db.prepare('SELECT outbox FROM exchange_recovery_jobs WHERE id=?').get(row.id).outbox);
     }
     // Inspect persisted bytes again after restart. Never invent a new nonce/tx.
     await adapter.inspect(packet,saved);this.mark(row.id,'EXTERNAL_PENDING');
     assert.equal(await adapter.broadcast(packet,saved),saved.transaction,'external broadcast identity');external=await adapter.discover(packet);
    }
    if(!external){this.mark(row.id,'WAITING');result.push({id:row.id,status:'WAITING'});continue;}
    receipt=await adapter.attest(packet,external);
    verifyExchangeResolution(this.config.exchangeLab.policy,packet.quote,packet.arm.plan,receipt,receipt.body.observedAt);
    assert(receipt.body.observedAt<=view.now+300,'observer clock beyond recovery window');
    // Persist a valid observation while the next consensus block catches up.
    // Refetching on every cycle would keep moving the observation time forward.
    this.db.prepare('UPDATE exchange_recovery_jobs SET receipt=? WHERE id=?').run(this.seal(row.id+'/receipt',receipt),row.id);
    }
    const current=await adapter.native(row.id);assert.equal(current.configHash,this.pin);integer(current.now,view.now);
    if(current.now<receipt.body.observedAt){this.mark(row.id,'AWAITING_CONSENSUS');result.push({id:row.id,status:'AWAITING_CONSENSUS'});continue;}
    verifyExchangeResolution(this.config.exchangeLab.policy,packet.quote,packet.arm.plan,receipt,current.now);
    // Submission success is not finality; COMPLETE requires the next verified read.
    this.mark(row.id,'RESOLUTION_PENDING');await adapter.submit({type:'RESOLVE',id:row.id,receipt});result.push({id:row.id,status:'RESOLUTION_PENDING'});
   }catch{this.mark(row.id,'RETRY');result.push({id:row.id,status:'RETRY'});}
  }return result;}finally{this.busy=false;}
 }
 mark(id,status){this.db.prepare('UPDATE exchange_recovery_jobs SET status=? WHERE id=?').run(status,id);}
 async run(adapter,{signal,intervalMs=1000,onCycle=()=>{}}={}){assert(signal&&intervalMs>=100&&intervalMs<=60000);while(!signal.aborted){onCycle(await this.tick(adapter));if(signal.aborted)break;await new Promise(resolve=>{const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();},timer=setTimeout(finish,intervalMs);signal.addEventListener('abort',finish,{once:true});});}}
 close(){assert(!this.busy);this.db.close();this.key.fill(0);}
}
