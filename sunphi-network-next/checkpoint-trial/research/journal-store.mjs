// One read boundary for canonical history. The active writer remains the same
// SQLite transaction as authenticated state; physical codecs do not change it.
import assert from 'node:assert/strict';
import {decodeJournalText,journalDecodedBytes,MAX_COMPRESSED_JOURNAL_BYTES} from './journal-codec.mjs';
import path from 'node:path';
import {openSegment} from './journal-segment.mjs';
const integer=(n,min=0)=>assert(Number.isSafeInteger(n)&&n>=min,'journal sequence/budget');
export class JournalStore {
 constructor(db,{file=null}={}){this.db=db;this.file=file?path.resolve(file):null;this.opened=new Map();}
 hasSegments(){return !!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='journal_segments'").get();}
 *segments({from=1,to=Number.MAX_SAFE_INTEGER}={}){
  if(!this.hasSegments())return;integer(from,1);integer(to);
  const start=this.db.prepare('SELECT first FROM journal_segments WHERE first<=? ORDER BY first DESC LIMIT 1').get(from)?.first??from;
  yield* this.db.prepare('SELECT * FROM journal_segments WHERE first>=? AND first<=? AND last>=? ORDER BY first').iterate(start,to,from);
 }
 segment(entry){
  assert(this.file,'archive path missing');let db=this.opened.get(entry.hash);
  if(db){this.opened.delete(entry.hash);this.opened.set(entry.hash,db);return db;}
  while(this.opened.size>=2){const [key,old]=this.opened.entries().next().value;old.close();this.opened.delete(key);}
  db=openSegment(this.file,entry);this.opened.set(entry.hash,db);return db;
 }
 database(sequence){if(this.hasSegments()){const entry=this.db.prepare('SELECT * FROM journal_segments WHERE first<=? ORDER BY first DESC LIMIT 1').get(sequence);if(entry&&entry.last>=sequence)return this.segment(entry);}return this.db;}
 head(){const row=this.db.prepare('SELECT sequence,parent,root,digest FROM journal ORDER BY sequence DESC LIMIT 1').get();if(row)return row;const entry=this.hasSegments()?this.db.prepare('SELECT * FROM journal_segments ORDER BY first DESC LIMIT 1').get():null;return entry?this.header(entry.last):null;}
 header(sequence){integer(sequence,1);return this.database(sequence).prepare('SELECT sequence,parent,root,digest FROM journal WHERE sequence=?').get(sequence)??null;}
 *headers({from=1,to=this.head()?.sequence??0}={}){
  integer(from,1);integer(to);if(to<from)return;
  let last=from-1;
  for(const entry of this.segments({from,to}))for(const row of this.segment(entry).prepare('SELECT sequence,parent,root,digest FROM journal WHERE sequence>=? AND sequence<=? ORDER BY sequence').iterate(from,to)){assert(row.sequence>last,'overlapping archive');last=row.sequence;yield row;}
  for(const row of this.db.prepare('SELECT sequence,parent,root,digest FROM journal WHERE sequence>=? AND sequence<=? ORDER BY sequence').iterate(from,to)){assert(row.sequence>last,'archive/hot overlap');last=row.sequence;yield row;}
 }
 get(sequence,{bytes=MAX_COMPRESSED_JOURNAL_BYTES,offlineLegacy=false}={}){
  integer(sequence,1);integer(bytes,1);assert(bytes<=MAX_COMPRESSED_JOURNAL_BYTES);assert.equal(typeof offlineLegacy,'boolean');
  const db=this.database(sequence),size=db.prepare('SELECT length(CAST(body AS BLOB)) bytes FROM journal WHERE sequence=?').get(sequence);
  if(!size)return null;
  // Ordinary readers reject before allocating an oversized physical row. Only
  // explicit offline migration/audit may inspect a historic population bridge.
  assert(offlineLegacy||size.bytes<=bytes,'journal row exceeds byte budget');
  const row=db.prepare('SELECT * FROM journal WHERE sequence=?').get(sequence);
  const decodedBytes=journalDecodedBytes(row.body);
  assert(decodedBytes<=bytes||(offlineLegacy&&!row.body.startsWith('{"encoding":')),'journal row exceeds decoded byte budget');
  const text=decodeJournalText(row.body);
  return {...row,body:text};
 }
 // Offline audit/migration is streaming: no array of the entire archive. A
 // caller can cancel between rows and selects the legacy-bridge exception.
 *scan({from=1,to=this.head()?.sequence??0,offlineLegacy=false,signal}={}){
  for(const h of this.headers({from,to})){signal?.throwIfAborted();const row=this.get(h.sequence,{offlineLegacy});assert(row,'journal disappeared');yield row;}
 }
 // Online/background callers receive bounded pages, pinned to an explicit end.
 // An over-budget first row fails rather than silently skipping any history.
 page({after=0,through,rows=64,bytes=2*1024*1024,milliseconds=25,signal}={}){
  integer(after);integer(through);integer(rows,1);assert(rows<=256);integer(bytes,1);assert(bytes<=MAX_COMPRESSED_JOURNAL_BYTES);
  assert(Number.isFinite(milliseconds)&&milliseconds>0&&milliseconds<=1000);
  assert(through<=(this.head()?.sequence??0),'journal page end is unavailable');
  const started=performance.now(),items=[];let used=0,cursor=after;
  for(const h of this.headers({from:after+1,to:through})){
   signal?.throwIfAborted();if(items.length>=rows||(items.length&&performance.now()-started>=milliseconds))break;
   assert.equal(h.sequence,cursor+1,'journal gap');
   let row;try{row=this.get(h.sequence,{bytes:bytes-used});}catch(e){if(items.length&&/byte budget/.test(e.message))break;throw e;}
   assert(row,'journal disappeared');used+=Buffer.byteLength(row.body);items.push(row);cursor=h.sequence;
   if(used===bytes)break;
  }
  return {items,after:cursor,bytes:used,complete:cursor>=through};
 }
 close(){for(const db of this.opened.values())db.close();this.opened.clear();}
}
