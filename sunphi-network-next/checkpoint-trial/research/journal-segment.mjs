// Immutable SQLite segments reuse the exact journal codec and SQL index. The
// catalogue and removal from the active table share ONE state-DB transaction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {sqlitePath} from '../sqlite-path.mjs';
import {hash,hex} from '../crypto.mjs';
import {encodeJournalText,decodeJournalText} from './journal-codec.mjs';
import {archiveStaging} from './archive-staging.mjs';
export const SEGMENT_TABLE='CREATE TABLE journal_segments(first INTEGER PRIMARY KEY,last INTEGER NOT NULL,hash TEXT NOT NULL UNIQUE,bytes INTEGER NOT NULL,parent TEXT NOT NULL,root TEXT NOT NULL,previous TEXT NOT NULL,digest TEXT NOT NULL)';
export const JOURNAL_TABLE='CREATE TABLE journal(sequence INTEGER PRIMARY KEY,parent TEXT NOT NULL,root TEXT NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL)';
export const MAX_SEGMENT_BYTES=128*1024*1024;
export function fileHash(file){const h=createHash('sha256'),fd=fs.openSync(file,'r'),b=Buffer.alloc(1024*1024);try{for(let n;(n=fs.readSync(fd,b))>0;)h.update(b.subarray(0,n));return h.digest('hex');}finally{fs.closeSync(fd);}}
export function segmentDirectory(file){assert(typeof file==='string'&&path.isAbsolute(file));return file+'.history';}
export function segmentPath(file,entry){hex(entry.hash);assert(Number.isSafeInteger(entry.bytes)&&entry.bytes>0&&entry.bytes<=MAX_SEGMENT_BYTES);const directory=segmentDirectory(file);assert(!fs.lstatSync(directory).isSymbolicLink(),'symlink archive directory');return path.join(directory,entry.hash+'.sqlite');}
export function openSegment(file,entry){
 const name=segmentPath(file,entry),s=fs.lstatSync(name);assert(s.isFile()&&!s.isSymbolicLink()&&s.size===entry.bytes,'archive object size/type');assert.equal(fileHash(name),entry.hash,'archive object checksum');
 const db=new DatabaseSync(sqlitePath(name),{readOnly:true});try{
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
  const schema=db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();assert.equal(schema.length,1);assert.equal(schema[0].type,'table');assert.equal(schema[0].name,'journal');assert.equal(schema[0].sql,JOURNAL_TABLE);
  const first=db.prepare('SELECT sequence,parent FROM journal ORDER BY sequence LIMIT 1').get(),last=db.prepare('SELECT sequence,root,digest FROM journal ORDER BY sequence DESC LIMIT 1').get();
  assert.equal(first.sequence,entry.first);assert.equal(first.parent,entry.parent);assert.equal(last.sequence,entry.last);assert.equal(last.root,entry.root);assert.equal(last.digest,entry.digest);
  return db;
 }catch(e){db.close();throw e;}
}
function syncDirectory(directory){
 // Linux archive nodes require directory fsync as well as durable file bytes.
 // Windows does not expose directory fsync through Node; no Windows archival
 // writer is admitted by this module (Home may still read verified objects).
 const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
export function archiveJournalPrefix(store,{through,rows=1024,rawBytes=64*1024*1024,afterPhase=()=>{},prepareOnly=false}={}){
 assert.equal(process.platform,'linux','archive writer requires qualified Linux directory durability');
 assert(Number.isSafeInteger(through)&&through>=0);assert(Number.isSafeInteger(rows)&&rows>=1&&rows<=4096);assert(Number.isSafeInteger(rawBytes)&&rawBytes>0&&rawBytes<=64*1024*1024);
 const db=store.db;assert(!store.snapshotMode&&!store.cache,'archive writer requires idle store');
 const head={...store.meta};assert(through<=head.sequence-64,'retain committed restart tail');
 if(!prepareOnly)db.exec(SEGMENT_TABLE.replace('CREATE TABLE','CREATE TABLE IF NOT EXISTS'));
 const prior=store.journal.hasSegments()?db.prepare('SELECT * FROM journal_segments ORDER BY first DESC LIMIT 1').get():undefined,first=(prior?.last??0)+1;
 if(first>through)return {rows:0,through:prior?.last??0};
 const directory=segmentDirectory(path.resolve(store.file));
 if(!fs.existsSync(directory)){fs.mkdirSync(directory,{mode:0o700});syncDirectory(path.dirname(directory));}
 assert(fs.lstatSync(directory).isDirectory()&&!fs.lstatSync(directory).isSymbolicLink());
 const space=fs.statfsSync(directory);assert(space.bavail*space.bsize>rawBytes+256*1024*1024,'archive staging disk headroom');
 const temporary=path.join(archiveStaging(directory),'.pending-'+randomUUID()+'.sqlite');let segment,entry,published=false;
 try{
  fs.closeSync(fs.openSync(temporary,'wx',0o600));segment=new DatabaseSync(sqlitePath(temporary));segment.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; '+JOURNAL_TABLE+'; BEGIN IMMEDIATE');
  const put=segment.prepare('INSERT INTO journal VALUES(?,?,?,?,?)');let count=0,used=0,previous=prior?.digest,parent=prior?.root;
  for(let sequence=first;sequence<=through&&count<rows;sequence++){
   let row;try{row=store.journal.get(sequence,{bytes:Math.min(16*1024*1024,rawBytes-used)});}catch(e){if(count&&/byte budget/.test(e.message))break;throw e;}
   assert(row,'archive source gap');const body=JSON.parse(row.body);assert.equal(hash(body),row.digest,'archive journal digest');assert.equal(body.sequence,sequence);assert.equal(body.parent,row.parent);assert.equal(body.root,row.root);
   if(count||prior){assert.equal(row.parent,parent,'archive root continuity');assert.equal(body.previousJournal,previous,'archive digest continuity');}
   if(!entry)entry={first,last:sequence,parent:row.parent,root:row.root,previous:body.previousJournal,digest:row.digest};
   put.run(sequence,row.parent,row.root,encodeJournalText(row.body),row.digest);used+=Buffer.byteLength(row.body);count++;entry.last=sequence;entry.root=row.root;entry.digest=row.digest;parent=row.root;previous=row.digest;
   if(used>=rawBytes)break;
  }
  assert(entry);segment.exec('COMMIT');segment.close();segment=null;
  const fd=fs.openSync(temporary,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}afterPhase('file-durable');
  entry.hash=fileHash(temporary);entry.bytes=fs.statSync(temporary).size;assert(entry.bytes<=MAX_SEGMENT_BYTES);
  // Check every canonical row from the durable copy before publishing a pointer.
  segment=new DatabaseSync(sqlitePath(temporary),{readOnly:true});let checked=0;
  for(const row of segment.prepare('SELECT * FROM journal ORDER BY sequence').iterate()){
   const source=store.journal.get(row.sequence);assert.deepEqual({...row,body:decodeJournalText(row.body)},source);checked++;
  }
  assert.equal(checked,entry.last-entry.first+1);assert.equal(segment.prepare('PRAGMA quick_check').get().quick_check,'ok');segment.close();segment=null;
  const destination=segmentPath(path.resolve(store.file),entry);
  try{fs.linkSync(temporary,destination);}catch(e){if(e.code!=='EEXIST')throw e;assert.equal(fileHash(destination),entry.hash);assert(!fs.lstatSync(destination).isSymbolicLink());}
  syncDirectory(directory);published=true;afterPhase('object-published');
  const prepared={entry,prior:prior?{...prior}:null,rows:checked,rawBytes:used};if(prepareOnly)return prepared;
  return commitArchiveSegment(store,prepared,{afterPhase});
 }finally{segment?.close();for(const suffix of ['', '-journal'])if(fs.existsSync(temporary+suffix))fs.unlinkSync(temporary+suffix);
  // Published-but-unreferenced files are harmless orphans after interruption.
  // They remain until a separate verified orphan collector can reclaim them.
  if(published)syncDirectory(directory);
 }
}
// The main writer only verifies the durable object and commits its catalogue
// pointer. Preparation/compression can run on a read-only worker while newer
// blocks commit; the immutable historical prefix is independently rechecked.
export function commitArchiveSegment(store,{entry,prior,rows,rawBytes},{afterPhase=()=>{}}={}){
 const db=store.db,head={...store.meta};assert(!store.cache&&!store.snapshotMode);assert(entry.last<=head.sequence-64);assert.equal(entry.last-entry.first+1,rows);assert(rows>=1&&rows<=4096);
 const verified=openSegment(path.resolve(store.file),entry);verified.close();db.exec(SEGMENT_TABLE.replace('CREATE TABLE','CREATE TABLE IF NOT EXISTS'));
 db.exec('BEGIN IMMEDIATE');try{
  const current=db.prepare('SELECT * FROM journal_segments ORDER BY first DESC LIMIT 1').get();assert.deepEqual(current?{...current}:null,prior,'archive catalogue changed');assert.equal(entry.first,(prior?.last??0)+1);
  if(prior){assert.equal(entry.parent,prior.root);assert.equal(entry.previous,prior.digest);}
  const first=db.prepare('SELECT parent FROM journal WHERE sequence=?').get(entry.first),tail=db.prepare('SELECT root,digest FROM journal WHERE sequence=?').get(entry.last);assert.equal(first?.parent,entry.parent);assert.equal(tail?.root,entry.root);assert.equal(tail?.digest,entry.digest);
  db.prepare('INSERT INTO journal_segments VALUES(?,?,?,?,?,?,?,?)').run(entry.first,entry.last,entry.hash,entry.bytes,entry.parent,entry.root,entry.previous,entry.digest);
  afterPhase('catalogue-written');const removed=db.prepare('DELETE FROM journal WHERE sequence>=? AND sequence<=?').run(entry.first,entry.last);assert.equal(removed.changes,rows);afterPhase('hot-rows-removed');assert.deepEqual({...store.meta},head);db.exec('COMMIT');
 }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
 afterPhase('catalogue-committed');return {rows,through:entry.last,rawBytes,storedBytes:entry.bytes,hash:entry.hash};
}
