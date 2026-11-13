// Dedicated, bounded A<->B driver. Constructed disabled; no issuance capability.
// Wallet outboxes persist the signed intent before any broadcast. A separate
// SQLite write lock prevents two processes from preparing concurrent payments.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {hash} from './crypto.mjs';
import {stateHash} from './core.mjs';
import {feeFor,amount} from './payment-model.mjs';
import {balances,outgoingStatus,paymentFee} from './wallet.mjs';
const terminal=new Set(['SETTLED','EXPIRED','CANCELLED','NOT_SUBMITTED']);
export class WarmupWorker{
 constructor({home,wallets,policyHash,enabled=()=>false,now=()=>Math.floor(Date.now()/1000)}){
  assert(wallets.length===2);assert.notEqual(wallets[0].key.publicKey,wallets[1].key.publicKey);assert.equal(hash(wallets[0].client.config),hash(wallets[1].client.config));
  Object.assign(this,{wallets,policyHash,enabled,now});this.busy=false;mkdirSync(home,{recursive:true,mode:0o700});
  this.lock=new DatabaseSync(join(home,'runner-lock.sqlite'));this.lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS lock(id INTEGER PRIMARY KEY)');
  this.db=new DatabaseSync(join(home,'warmup.sqlite'));this.db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS payments(pid TEXT PRIMARY KEY,wallet INTEGER NOT NULL,wireHash TEXT NOT NULL,status TEXT NOT NULL,fee TEXT); CREATE INDEX IF NOT EXISTS pending_by_wallet ON payments(wallet,status); CREATE TABLE IF NOT EXISTS cursors(wallet INTEGER PRIMARY KEY,position INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY,cooldown INTEGER NOT NULL)');
  const identity={config:hash(wallets[0].client.config),wallets:wallets.map(w=>w.key.publicKey),policyHash},old=this.db.prepare('SELECT body FROM identity WHERE id=1').get();
  if(old)assert.deepEqual(JSON.parse(old.body),identity);else this.db.prepare('INSERT INTO identity VALUES(1,?)').run(JSON.stringify(identity));
  this.db.exec('INSERT OR IGNORE INTO control VALUES(1,0); INSERT OR IGNORE INTO cursors VALUES(0,0); INSERT OR IGNORE INTO cursors VALUES(1,0)');
 }
 async cycle(){
  if(this.busy)return{busy:true};this.busy=true;let locked=false;
  try{
   try{this.lock.exec('BEGIN IMMEDIATE');locked=true;}catch(e){if(e.errcode===5)return{busy:true};throw e;}
   const view=await this.wallets[0].view(),s=view.state;
   assert.equal(stateHash(s,this.wallets[0].client.config),view.certificate.appHash);assert.equal(s.height,view.certificate.appHeight);
   const f=s.launchFund;if(!f)return{ready:false,reason:'launch-not-prepared'};
   assert.equal(hash(f.policy),this.policyHash);assert.deepEqual(f.policy.wallets,this.wallets.map(w=>w.key.publicKey));
   const pending=[];let catchingUp=false,completed=null;
   for(let index=0;index<2;index++){
    const w=this.wallets[index];w.recoverPending(view);
    const position=this.db.prepare('SELECT position FROM cursors WHERE wallet=?').get(index).position;
    const fresh=w.db.prepare('SELECT rowid AS position,pid,body FROM outgoing WHERE rowid>? ORDER BY rowid LIMIT 32').all(position);catchingUp ||= fresh.length===32;
    for(const row of fresh){
     const wire=JSON.parse(row.body),i=wire.body.action.signed.intent;
     assert.equal(i.sender,w.key.publicKey);assert.equal(i.recipient,this.wallets[1-index].key.publicKey,'unexpected program recipient in durable outbox');
     const digest=hash(wire),old=this.db.prepare('SELECT * FROM payments WHERE pid=?').get(row.pid);
     if(old)assert.equal(old.wireHash,digest);
     else this.db.prepare("INSERT INTO payments VALUES(?,?,?,'QUEUED',NULL)").run(row.pid,index,digest);
     this.db.prepare('UPDATE cursors SET position=? WHERE wallet=?').run(row.position,index);
    }
    const unresolved=this.db.prepare("SELECT * FROM payments WHERE wallet=? AND status='QUEUED' LIMIT 2").all(index);
    for(const row of unresolved){
     const saved=w.db.prepare('SELECT body FROM outgoing WHERE pid=?').get(row.pid);assert(saved,'durable wallet intent is missing');
     const wire=JSON.parse(saved.body);assert.equal(hash(wire),row.wireHash);const i=wire.body.action.signed.intent;
     const status=outgoingStatus(s,i);
     if(terminal.has(status)){
      this.db.prepare('UPDATE payments SET status=?,fee=? WHERE pid=?').run(status,paymentFee(i,status),row.pid);
      completed={pid:row.pid,status};
      if(status!=='SETTLED')this.db.prepare('UPDATE control SET cooldown=? WHERE id=1').run(this.now()+Math.max(60,f.policy.intervalSeconds));
     }else pending.push({index,pid:row.pid,status,admitted:Boolean(s.money.requests[row.pid])});
    }
   }
   if(catchingUp)return{waiting:true,reason:'bounded-outbox-recovery'};
   // Report a newly observed terminal result before preparing another transfer.
   // This gives the controller a deterministic stop/ramp decision boundary.
   if(completed&&!pending.length)return{completed};
   assert(pending.length<=1,'multiple unfinished program outboxes; operator reconciliation required');
   if(pending.length){
    const p=pending[0];if(p.status==='HISTORY_UNAVAILABLE')return{paused:true,reason:'history-required',pid:p.pid};
    // A local pause must drain admitted money, but must never admit a new draft.
    if(!p.admitted&&(!this.enabled()||f.mode!=='ACTIVE'||s.money.time>=f.endTime))return{paused:true,pid:p.pid,reason:'unadmitted-draft-held'};
    return{pid:p.pid,...await this.wallets[p.index].resume(p.pid)};
   }
   if(!this.enabled()||f.mode!=='ACTIVE'||!f.issued)return{ready:true,paused:true};
   if(s.money.time>=f.endTime||amount(f.spentFees)>=amount(f.policy.feeBudget))return{ready:true,complete:true};
   if(this.now()-s.money.time>60)return{paused:true,reason:'stale-consensus'};
   if(s.money.time<f.nextAt||this.now()<this.db.prepare('SELECT cooldown FROM control WHERE id=1').get().cooldown)return{waiting:true};
   if(Object.values(s.money.requests).some(r=>['RESERVED','SCHEDULED'].includes(r.status)))return{waiting:true,reason:'user-payments-first'};
   const last=this.db.prepare('SELECT wallet FROM payments ORDER BY rowid DESC LIMIT 1').get(),index=last?1-last.wallet:0,w=this.wallets[index],value=f.policy.maxPayment,fee=feeFor(value),day=Math.floor(s.money.time/86400);
   if(amount(f.spentFees)+fee>amount(f.policy.feeBudget))return{complete:true,reason:'remaining-fee-budget'};
   if((f.day===day?amount(f.dayFees):0n)+fee>amount(f.policy.dailyFeeBudget))return{waiting:true,reason:'daily-fee-budget'};
   if(amount(balances(s,w.key.publicKey).available)<amount(value)+fee)return{paused:true,reason:'insufficient-program-funds'};
   const prepared=await w.prepare(this.wallets[1-index].key.publicKey,value);
   // A crash here is safe: the next cycle adopts this exact wallet outbox row.
   const wire=JSON.parse(w.db.prepare('SELECT body FROM outgoing WHERE pid=?').get(prepared.pid).body);
   this.db.prepare("INSERT INTO payments VALUES(?,?,?,'QUEUED',NULL)").run(prepared.pid,index,hash(wire));
   return{prepared:prepared.pid,fee:prepared.fee,value};
  }finally{if(locked)this.lock.exec('ROLLBACK');this.busy=false;}
 }
 close(){this.db.close();this.lock.close();}
}
