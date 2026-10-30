import { canonical } from './protocol.mjs';
// Caller verifies proofs before this atomic commit. A process death either
// preserves the old state or both new proof and label; labels confer no trust.
export function commitReceipt(db,txid,receipt,status,crash=()=>{}){
 db.exec('BEGIN IMMEDIATE');try{
  db.prepare('INSERT OR REPLACE INTO wallet_receipts VALUES(?,?)').run(txid,canonical(receipt));
  db.prepare('UPDATE wallet_submissions SET status=? WHERE txid=?').run(status,txid);
  if(['confirmed','conflicted','expired'].includes(status))db.prepare('DELETE FROM wallet_reservations WHERE txid=?').run(txid);
  crash('beforeCommit');db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 crash('afterCommit');
}
