import assert from 'node:assert/strict';
import {createCipheriv,createDecipheriv,hkdfSync,randomBytes} from 'node:crypto';
import {exact,hash,hex} from './crypto.mjs';

export function receiptNote(key,pin,id,value){
 const secret=hkdfSync('sha256',Buffer.from(key.privateKey),Buffer.from(pin),'DueByte private payment details v1',32);
 if(typeof value==='string'){
  const b=Buffer.from(value,'base64'),dec=createDecipheriv('aes-256-gcm',secret,b.subarray(0,12));
  dec.setAAD(Buffer.from(id));dec.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([dec.update(b.subarray(28)),dec.final()]));
 }
 const iv=randomBytes(12),enc=createCipheriv('aes-256-gcm',secret,iv);enc.setAAD(Buffer.from(id));
 const bytes=Buffer.concat([enc.update(JSON.stringify(value)),enc.final()]);return Buffer.concat([iv,enc.getAuthTag(),bytes]).toString('base64');
}

export function storeReceiptNotes(db,pin,notes){
 db.exec('CREATE TABLE IF NOT EXISTS backed_receipt_notes(pin TEXT NOT NULL,id TEXT NOT NULL,note TEXT NOT NULL,PRIMARY KEY(pin,id))');
 const insert=db.prepare('INSERT OR IGNORE INTO backed_receipt_notes VALUES(?,?,?)');
 db.exec('BEGIN IMMEDIATE');
 try{for(const {id,note} of notes)insert.run(pin,id,note);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
}

export function savedReceiptNotes(db,pin){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='backed_receipt_notes'").get())return [];
 return db.prepare('SELECT id,note FROM backed_receipt_notes WHERE pin=? ORDER BY id').all(pin).map(r=>({...r}));
}

export function validateReceiptNotes(archive,key,configHash){
 exact(archive,['configHash','notes']);assert.equal(archive.configHash,configHash,'Receipt notes belong to another network configuration.');
 const pin=hash({config:configHash,owner:key.publicKey}),seen=new Set();
 assert(Array.isArray(archive.notes)&&archive.notes.length<=4096);
 for(const row of archive.notes){
  exact(row,['id','note']);hex(row.id);assert(!seen.has(row.id));seen.add(row.id);
  assert(typeof row.note==='string'&&row.note.length<=4096);
  const note=receiptNote(key,pin,row.id,row.note);exact(note,['purpose','contract','salt']);hex(note.salt);
  assert([note.purpose,note.contract].every(v=>typeof v==='string'&&v.length<=160));
 }
 return pin;
}
