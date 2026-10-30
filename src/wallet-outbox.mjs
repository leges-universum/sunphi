import { canonical,parseWire } from './protocol.mjs';
export function inputIds(wire){const p=parseWire(wire);if(p.s.kind.toBigint()!==0n)throw new Error('outbox transfers only');return [p.s.id0.toString(),...(p.s.second.toBoolean()?[p.s.id1.toString()]:[])];}
export function initializeReservations(db){
 db.exec('CREATE TABLE IF NOT EXISTS wallet_reservations(note_id TEXT NOT NULL,txid TEXT NOT NULL,PRIMARY KEY(note_id,txid)); CREATE INDEX IF NOT EXISTS reservation_tx ON wallet_reservations(txid);');
 // Conservatively recover earlier outboxes. A status label never releases funds.
 // Shape/identity validation here does NOT certify a ZK proof or a balance.
 for(const row of db.prepare('SELECT txid,wire FROM wallet_submissions').iterate()){
  const wire=JSON.parse(row.wire);if(parseWire(wire).txid!==row.txid)throw new Error('outbox identity mismatch');
  for(const id of inputIds(wire))db.prepare('INSERT OR IGNORE INTO wallet_reservations VALUES(?,?)').run(id,row.txid);
 }
}
export function reserveSubmission(db,txid,wire,crash=()=>{}){
 if(parseWire(wire).txid!==txid)throw new Error('outbox identity mismatch');const encoded=canonical(wire);
 db.exec('BEGIN IMMEDIATE');try{
  const previous=db.prepare('SELECT wire FROM wallet_submissions WHERE txid=?').get(txid);if(previous&&previous.wire!==encoded)throw new Error('wallet exact retry mismatch');
  for(const id of inputIds(wire)){
   if(db.prepare('SELECT txid FROM wallet_reservations WHERE note_id=? AND txid<>? LIMIT 1').get(id,txid))throw new Error('input reserved by unresolved payment; reconcile before spending');
   db.prepare('INSERT OR IGNORE INTO wallet_reservations VALUES(?,?)').run(id,txid);
  }
  db.prepare("INSERT INTO wallet_submissions VALUES(?,?,1,'unknown') ON CONFLICT(txid) DO UPDATE SET attempts=attempts+1,status='unknown'").run(txid,encoded);
  crash('beforeCommit');db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 crash('afterCommit');
}
