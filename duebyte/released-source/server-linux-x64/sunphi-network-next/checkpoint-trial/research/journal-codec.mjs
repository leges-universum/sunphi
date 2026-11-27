// Physical encoding only: the decoded canonical journal and its digest do not change.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateRawSync,inflateRawSync} from 'node:zlib';
import {hash,exact} from '../crypto.mjs';
export const JOURNAL_ENCODING='DUEBYTE_JOURNAL_DEFLATE_V1';
export const MAX_COMPRESSED_JOURNAL_BYTES=16*1024*1024;
// Reader release first; enable writing only in a later, rollback-compatible release.
export const WRITE_COMPRESSED_JOURNAL=false;
const digest=b=>createHash('sha256').update(b).digest('hex');
function envelope(text){
 assert.equal(typeof text,'string','journal text required');
 // Legacy rows (including unusually large schema bridges) retain their format.
 if(!text.startsWith('{"encoding":'))return null;
 assert(Buffer.byteLength(text)<=MAX_COMPRESSED_JOURNAL_BYTES,'compressed journal envelope limit');
 const e=JSON.parse(text);exact(e,['encoding','bytes','sha256','data']);assert.equal(e.encoding,JOURNAL_ENCODING,'unknown journal encoding');
 assert(Number.isSafeInteger(e.bytes)&&e.bytes>=1&&e.bytes<=MAX_COMPRESSED_JOURNAL_BYTES,'journal expansion limit');
 assert(typeof e.sha256==='string'&&/^[a-f0-9]{64}$/.test(e.sha256));assert(typeof e.data==='string'&&e.data.length<=MAX_COMPRESSED_JOURNAL_BYTES);
 return e;
}
export function decodeJournalText(text){
 const e=envelope(text);if(!e)return text;
 const packed=Buffer.from(e.data,'base64');assert.equal(packed.toString('base64'),e.data,'canonical compressed bytes');
 const decoded=inflateRawSync(packed,{maxOutputLength:e.bytes,info:true});
 assert.equal(decoded.engine.bytesWritten,packed.length,'trailing compressed bytes');
 const bytes=decoded.buffer;assert.equal(bytes.length,e.bytes,'journal decoded length');assert.equal(digest(bytes),e.sha256,'journal byte checksum');
 const raw=bytes.toString('utf8');assert(Buffer.from(raw).equals(bytes),'invalid journal UTF-8');
 assert(!raw.startsWith('{"encoding":'),'nested journal encoding');return raw;
}
export function journalDecodedBytes(text){const e=envelope(text);return e?.bytes??Buffer.byteLength(text);}
export function decodeJournal(text){return JSON.parse(decodeJournalText(text));}
export function encodeJournalText(text){
 assert.equal(typeof text,'string');const bytes=Buffer.from(text);
 if(bytes.length<1024||bytes.length>MAX_COMPRESSED_JOURNAL_BYTES||text.startsWith('{"encoding":'))return text;
 const data=deflateRawSync(bytes,{level:6}).toString('base64');
 const encoded=JSON.stringify({encoding:JOURNAL_ENCODING,bytes:bytes.length,sha256:digest(bytes),data});
 return Buffer.byteLength(encoded)<bytes.length?encoded:text;
}
// Short, restartable transactions. No rows are removed and no root/digest is rewritten.
export function compactJournalBatch(db,{after=0,rows=64,bytes=16*1024*1024,beforeCommit=()=>{}}={}){
 assert(Number.isSafeInteger(after)&&after>=0);assert(Number.isSafeInteger(rows)&&rows>=1&&rows<=256);assert(Number.isSafeInteger(bytes)&&bytes>=1&&bytes<=MAX_COMPRESSED_JOURNAL_BYTES);
 db.exec('BEGIN IMMEDIATE');
 try{
  const before=db.prepare('SELECT * FROM meta WHERE id=1').get();let cursor=after,count=0,changed=0,sourceBytes=0,storedBytes=0,skippedLarge=0;
  const next=db.prepare('SELECT sequence,length(CAST(body AS BLOB)) AS bytes FROM journal WHERE sequence>? ORDER BY sequence LIMIT 1');
  const read=db.prepare('SELECT * FROM journal WHERE sequence=?'),update=db.prepare('UPDATE journal SET body=? WHERE sequence=? AND digest=?');
  while(count<rows){const n=next.get(cursor);if(!n)break;
   // An oversized historical row stays exactly as it is. Background maintenance
   // must not exceed its byte budget even for its first row or inflate a large
   // existing envelope merely to discover that it cannot process it this turn.
   if(n.bytes>bytes){cursor=n.sequence;count++;skippedLarge++;continue;}
   if(count&&sourceBytes+n.bytes>bytes)break;
   const row=read.get(n.sequence),e=envelope(row.body),rawBytes=e?.bytes??n.bytes;
   if(rawBytes>bytes){cursor=n.sequence;count++;skippedLarge++;continue;}
   if(sourceBytes+rawBytes>bytes)break;
   const raw=decodeJournalText(row.body),body=JSON.parse(raw);
   assert.equal(hash(body),row.digest,'journal digest before compaction');assert.equal(body.sequence,row.sequence);assert.equal(body.parent,row.parent);assert.equal(body.root,row.root);
   // Already encoded rows are verified, but need no repeated compression work.
   const encoded=e?row.body:encodeJournalText(raw);if(!e)assert.equal(decodeJournalText(encoded),raw,'lossless journal compaction');
   if(encoded!==row.body){assert.equal(update.run(encoded,row.sequence,row.digest).changes,1);changed++;}
   sourceBytes+=rawBytes;storedBytes+=Buffer.byteLength(encoded);cursor=n.sequence;count++;
  }
  assert.deepEqual(db.prepare('SELECT * FROM meta WHERE id=1').get(),before,'compaction changed authenticated head');
  beforeCommit();db.exec('COMMIT');return {after:cursor,rows:count,changed,sourceBytes,storedBytes,skippedLarge};
 }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
}
