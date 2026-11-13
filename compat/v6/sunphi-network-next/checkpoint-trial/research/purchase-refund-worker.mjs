// Durable isolated refund outbox. Signer/decoder/broadcaster are explicit adapters.
// Never stores private keys. An ambiguous broadcast reuses the persisted raw tx.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {hash,hex,exact} from '../crypto.mjs';
import {sqlitePath} from '../sqlite-path.mjs';
import {purchasePolicy} from './purchase-contract.mjs';
export class RefundOutbox{
 constructor(file){this.db=new DatabaseSync(sqlitePath(file));this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS refunds(id TEXT PRIMARY KEY,intent TEXT NOT NULL,raw TEXT NOT NULL,txid TEXT NOT NULL,status TEXT NOT NULL); CREATE TABLE IF NOT EXISTS recovery(id INTEGER PRIMARY KEY,config TEXT NOT NULL,restricted INTEGER NOT NULL);');this.busy=false;}
 async execute({configHash,order,adapter,policy}){
  assert(!this.busy,'refund outbox busy');this.busy=true;
  try{return await this.executeOne({configHash,order,adapter,policy});}finally{this.busy=false;}
 }
 async executeOne({configHash,order,adapter,policy}){
  purchasePolicy(policy);assert.equal(order.offer.policyHash,hash(policy),'refund policy pin');
  hex(configHash);assert(order.refundIntent&&['PAYMENT_REVIEW','LATE_PAYMENT_REVIEW','REFUNDED'].includes(order.status),'committed refund intent required');
  let recovery=this.db.prepare('SELECT * FROM recovery WHERE id=1').get();
  if(recovery)assert.equal(recovery.config,configHash,'refund outbox network pin');
  else{this.db.prepare('INSERT INTO recovery VALUES(1,?,0)').run(configHash);recovery={restricted:0};}
  const intent=order.refundIntent,scope={configHash,orderId:hash(order.offer),intent},id=hash(scope),digest=hash(intent);
  assert.deepEqual(order.received.map(x=>x.event).sort(),intent.refunds,'new deposit requires manual refund reconciliation');
  let row=this.db.prepare('SELECT * FROM refunds WHERE id=?').get(id);
  if(order.status==='REFUNDED'){assert(row,'unknown completed refund');return {txid:row.txid,status:'CONFIRMED'};}
  assert(order.received.every(x=>x.confirmations>=policy.routes[order.offer.route].confirmations),'deposit confirmations lost; refund paused');
  if(!row){
   assert(!recovery.restricted,'Recovered outbox: unknown refund requires reconciliation; signing is disabled.');
   const prepared=await adapter.prepare(scope);exact(prepared,['raw','txid']);hex(prepared.txid);assert(typeof prepared.raw==='string'&&/^(?:[a-f0-9]{2})+$/.test(prepared.raw)&&prepared.raw.length<=524288,'bounded signed transaction');
   // Decoder must independently inspect actual signed bytes, not trust a quote.
   const decoded=await adapter.inspect(prepared.raw);assert.equal(decoded.txid,prepared.txid);assert.equal(decoded.destination,intent.destination);assert.equal(decoded.amountAtomic,intent.amountAtomic);assert.equal(decoded.network,order.offer.route==='BTC'?'bitcoin-regtest':'ethereum-local');assert.equal(decoded.asset,order.offer.route==='BTC'?'native':'test-usdc');
   if(order.offer.route==='USDC')assert.equal(decoded.source,order.offer.destination,'USDC refund signer must control deposit account');
   this.db.prepare('INSERT OR IGNORE INTO refunds VALUES (?,?,?,?,?)').run(id,digest,prepared.raw,prepared.txid,'PREPARED');
   row=this.db.prepare('SELECT * FROM refunds WHERE id=?').get(id);
  }
  assert.equal(row.intent,digest);
  // Revalidate persisted bytes and the chain even after restart, before known().
  if(adapter.bind)adapter.bind(scope);
  const decoded=await adapter.inspect(row.raw);assert.equal(decoded.txid,row.txid);assert.equal(decoded.destination,intent.destination);assert.equal(decoded.amountAtomic,intent.amountAtomic);assert.equal(decoded.network,order.offer.route==='BTC'?'bitcoin-regtest':'ethereum-local');assert.equal(decoded.asset,order.offer.route==='BTC'?'native':'test-usdc');
  if(order.offer.route==='USDC')assert.equal(decoded.source,order.offer.destination,'USDC refund signer must control deposit account');
  if(await adapter.known(row.txid)){this.db.prepare('UPDATE refunds SET status=? WHERE id=?').run('BROADCAST',id);return {txid:row.txid,status:'BROADCAST'};}
  const sent=await adapter.broadcast(row.raw);assert.equal(sent,row.txid,'broadcast transaction mismatch');
  this.db.prepare('UPDATE refunds SET status=? WHERE id=?').run('BROADCAST',id);return {txid:row.txid,status:'BROADCAST'};
 }
 snapshot(configHash){
  assert(!this.busy,'pause the executor before backup');hex(configHash);
  const pin=this.db.prepare('SELECT config FROM recovery WHERE id=1').get();if(pin)assert.equal(pin.config,configHash);
  return {domain:'DUEBYTE_REFUND_OUTBOX_BACKUP_V1',configHash,rows:this.db.prepare('SELECT * FROM refunds ORDER BY id').all().map(r=>({...r}))};
 }
 restore(snapshot,configHash){
  assert(!this.busy);exact(snapshot,['domain','configHash','rows']);assert.equal(snapshot.domain,'DUEBYTE_REFUND_OUTBOX_BACKUP_V1');hex(configHash);assert.equal(snapshot.configHash,configHash);
  assert(Array.isArray(snapshot.rows)&&snapshot.rows.length<=64);const ids=new Set();
  for(const row of snapshot.rows){exact(row,['id','intent','raw','txid','status']);hex(row.id);hex(row.intent);hex(row.txid);assert(!ids.has(row.id));ids.add(row.id);assert(['PREPARED','BROADCAST'].includes(row.status));assert(typeof row.raw==='string'&&/^(?:[a-f0-9]{2})+$/.test(row.raw)&&row.raw.length<=524288);}
  assert.equal(this.db.prepare('SELECT count(*) AS n FROM refunds').get().n,0,'restore requires an empty outbox');assert(!this.db.prepare('SELECT * FROM recovery').get(),'restore requires a fresh outbox');
  this.db.exec('BEGIN IMMEDIATE');try{
   for(const r of snapshot.rows)this.db.prepare('INSERT INTO refunds VALUES(?,?,?,?,?)').run(r.id,r.intent,r.raw,r.txid,r.status);
   // A backup may predate a broadcast. Never sign an absent record after restore.
   this.db.prepare('INSERT INTO recovery VALUES(1,?,1)').run(configHash);this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 close(){this.db.close();}
}
