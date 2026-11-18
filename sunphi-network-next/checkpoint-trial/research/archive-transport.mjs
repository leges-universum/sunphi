// Content-addressed archive transport for BOTH clean installation and recovery.
// The independently authenticated snapshot contains the catalogue. Transport
// endpoints supply bytes only; they cannot authorize history or change roots.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {sqlitePath} from '../sqlite-path.mjs';
import {exact,hex,integer,hash,canonical} from '../crypto.mjs';
import {fileHash,segmentDirectory,segmentPath,openSegment,MAX_SEGMENT_BYTES,JOURNAL_TABLE} from './journal-segment.mjs';
import {encodeJournalText,MAX_COMPRESSED_JOURNAL_BYTES} from './journal-codec.mjs';
import {archiveStaging} from './archive-staging.mjs';
export const ARCHIVE_READ='DUEBYTE_ARCHIVE_OBJECT_V1',ARCHIVE_CHUNK=256*1024;
export const ARCHIVE_ROW='DUEBYTE_ARCHIVE_ROW_V1';
export function validateArchiveEntry(e){
 assert(e&&typeof e==='object'&&!Array.isArray(e));exact({...e},['first','last','hash','bytes','parent','root','previous','digest']);
 integer(e.first,1);integer(e.last,e.first);integer(e.bytes,1);assert(e.bytes<=MAX_SEGMENT_BYTES);
 assert(e.last-e.first<4096,'archive range row limit');
 for(const k of ['hash','parent','root','previous','digest'])hex(e[k]);return e;
}
export function archiveChunk(store,q){
 if(q?.operation===ARCHIVE_ROW){
  exact(q,['operation','sequence','offset']);integer(q.sequence,1);integer(q.offset);assert(q.offset%ARCHIVE_CHUNK===0);
  const row=store.journal.get(q.sequence);assert(row,'archive row unavailable');const data=Buffer.from(row.body);assert(q.offset<data.length);
  return {sequence:q.sequence,parent:row.parent,root:row.root,digest:row.digest,bytes:data.length,offset:q.offset,data:data.subarray(q.offset,q.offset+ARCHIVE_CHUNK).toString('base64')};
 }
 exact(q,['operation','hash','offset']);assert.equal(q.operation,ARCHIVE_READ);hex(q.hash);integer(q.offset);assert(q.offset%ARCHIVE_CHUNK===0);
 assert(store.journal.hasSegments(),'archive unavailable');
 const e=store.db.prepare('SELECT * FROM journal_segments WHERE hash=?').get(q.hash);assert(e,'unknown archive object');validateArchiveEntry(e);assert(q.offset<e.bytes);
 // Read only a bounded range. The consumer checks the whole immutable object
 // against the authenticated catalogue before opening SQLite or publishing it.
 const file=segmentPath(path.resolve(store.file),e),s=fs.lstatSync(file);assert(s.isFile()&&!s.isSymbolicLink()&&s.size===e.bytes);
 const fd=fs.openSync(file,'r'),b=Buffer.alloc(Math.min(ARCHIVE_CHUNK,e.bytes-q.offset));try{assert.equal(fs.readSync(fd,b,0,b.length,q.offset),b.length);}finally{fs.closeSync(fd);}
 return {hash:e.hash,offset:q.offset,bytes:e.bytes,data:b.toString('base64')};
}
function syncDir(dir){if(process.platform==='win32')return;const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function ensureDirectory(dir){if(!fs.existsSync(dir)){fs.mkdirSync(dir,{mode:0o700});syncDir(path.dirname(dir));}const s=fs.lstatSync(dir);assert(s.isDirectory()&&!s.isSymbolicLink(),'archive directory type');}
// Only an uninstalled receiver owns this cache. Preserve a bounded number of
// damaged objects for diagnosis, then fetch the independently committed bytes.
// Never rename an active node's history or follow a symlink during repair.
function quarantineCache(file,target){
 assert(!fs.existsSync(target),'active archive requires offline repair');
 const s=fs.lstatSync(file);assert(s.isFile()&&!s.isSymbolicLink()&&s.size<=MAX_SEGMENT_BYTES,'unsafe archive cache object retained');
 const directory=segmentDirectory(path.resolve(target)),quarantine=path.join(directory,'.quarantine');ensureDirectory(quarantine);
 const dir=fs.opendirSync(quarantine);let count=0;try{while(dir.readSync()){assert(++count<2,'archive quarantine full; damaged files retained');}}finally{dir.closeSync();}
 const destination=path.join(quarantine,path.basename(file,'.sqlite')+'-'+randomUUID()+'.sqlite');
 fs.renameSync(file,destination);syncDir(quarantine);syncDir(directory);
}
export function validateArchiveSources(sources){
 assert(Array.isArray(sources)&&sources.length>=2&&sources.length<=8,'at least two configured archive sources required');
 for(const source of sources){const u=new URL(source);assert(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash,'use configured authenticated SSH routes');}
 assert.equal(new Set(sources).size,sources.length);return sources;
}
// Older configured nodes already have authenticated state-sync routes in their
// local Comet configuration. Reuse those exact routes without rewriting settings
// or taking addresses from a snapshot publisher.
export function configuredArchiveSources(home){
 const settings=path.join(home,'run-settings.json');
 if(fs.existsSync(settings)){const saved=JSON.parse(fs.readFileSync(settings));if(saved.archiveSources!==undefined)return validateArchiveSources(saved.archiveSources);}
 const file=path.join(home,'config/config.toml');if(!fs.existsSync(file))return [];
 const text=fs.readFileSync(file,'utf8');assert(text.length<=1024*1024,'local Comet config size');
 const sections=[...text.matchAll(/^\[statesync\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)];if(!sections.length)return [];assert.equal(sections.length,1,'ambiguous state-sync configuration');
 const fields=[...sections[0][1].matchAll(/^rpc_servers\s*=\s*"([^"\r\n]*)"\s*(?:#.*)?$/gm)];if(!fields.length)return [];assert.equal(fields.length,1,'ambiguous RPC routes');if(!fields[0][1])return [];
 return validateArchiveSources(fields[0][1].split(',').map(s=>s.trim()));
}
async function requestArchive(source,request){
 const r=await fetch(source,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'abci_query',params:{path:'/work',data:Buffer.from(JSON.stringify(request)).toString('hex')}}),signal:AbortSignal.timeout(10000)});
 assert(r.ok,'archive HTTP failure');let size=0;const parts=[];for await(const b of r.body){size+=b.length;assert(size<=600000,'archive transport response limit');parts.push(b);}
 const reply=JSON.parse(Buffer.concat(parts));assert(!reply.error&&!reply.result.response.code,'archive RPC failure');return JSON.parse(Buffer.from(reply.result.response.value,'base64'));
}
export const fetchArchiveChunk=(source,hash,offset)=>requestArchive(source,{operation:ARCHIVE_READ,hash,offset});
const fetchArchiveRow=(source,sequence,offset)=>requestArchive(source,{operation:ARCHIVE_ROW,sequence,offset});
function checkRange(actual,expected){for(const k of ['first','last','parent','root','previous','digest'])assert.equal(actual[k],expected[k],'archive logical range');}
// A peer need not have chosen the publisher's SQLite files or segment boundaries.
// Reconstruct the exact canonical event range and verify its committed chain;
// physical compression/file hashes may differ, authenticated state may not.
async function rebuildArchive(entry,target,options){let failure;for(const source of options.sources){try{return await rebuildArchiveFromSource(entry,target,{...options,sources:[source]});}catch(e){failure=e;options.signal?.throwIfAborted();}}throw failure;}
async function rebuildArchiveFromSource(entry,target,{sources,onProgress,signal,fetchRow=fetchArchiveRow}){
 const directory=segmentDirectory(path.resolve(target)),temporary=path.join(archiveStaging(directory),'.rebuild-'+randomUUID()+'.sqlite');let db;
 try{fs.closeSync(fs.openSync(temporary,'wx',0o600));db=new DatabaseSync(sqlitePath(temporary));db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; '+JOURNAL_TABLE+'; BEGIN IMMEDIATE');
  const put=db.prepare('INSERT INTO journal VALUES(?,?,?,?,?)');let parent=entry.parent,previous=entry.previous,downloaded=0;
  for(let sequence=entry.first;sequence<=entry.last;sequence++){
   let accepted=null,lastError;
   for(const source of sources){try{
    let row=null,total=0;const parts=[];
    do{signal?.throwIfAborted();const reply=await fetchRow(source,sequence,total);exact(reply,['sequence','parent','root','digest','bytes','offset','data']);assert.equal(reply.sequence,sequence);assert.equal(reply.offset,total);integer(reply.bytes,1);assert(reply.bytes<=MAX_COMPRESSED_JOURNAL_BYTES);for(const k of ['parent','root','digest'])hex(reply[k]);
     if(row)for(const k of ['parent','root','digest','bytes'])assert.equal(reply[k],row[k]);else row=reply;
     assert(typeof reply.data==='string'&&reply.data.length<=Math.ceil(ARCHIVE_CHUNK/3)*4);const b=Buffer.from(reply.data,'base64');assert.equal(b.toString('base64'),reply.data);assert.equal(b.length,Math.min(ARCHIVE_CHUNK,row.bytes-total));parts.push(b);total+=b.length;downloaded+=b.length;onProgress({sequence,downloaded,offset:total});
    }while(total<row.bytes);
    const text=Buffer.concat(parts,total).toString('utf8'),body=JSON.parse(text);assert.equal(canonical(body),text,'canonical archive bytes');assert.equal(hash(body),row.digest);assert.equal(body.sequence,sequence);assert.equal(body.parent,parent);assert.equal(row.parent,parent);assert.equal(body.previousJournal,previous);assert.equal(body.root,row.root);
    if(sequence===entry.last){assert.equal(row.root,entry.root);assert.equal(row.digest,entry.digest,'archive range commitment');}
    accepted={...row,text};break;
   }catch(e){lastError=e;signal?.throwIfAborted();}}
   if(!accepted)throw lastError;put.run(sequence,accepted.parent,accepted.root,encodeJournalText(accepted.text),accepted.digest);parent=accepted.root;previous=accepted.digest;
  }
  db.exec('COMMIT');db.close();db=null;const fd=fs.openSync(temporary,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const result={...entry,hash:fileHash(temporary),bytes:fs.statSync(temporary).size};validateArchiveEntry(result);
  const destination=segmentPath(path.resolve(target),result);try{fs.linkSync(temporary,destination);}catch(e){if(e.code!=='EEXIST')throw e;assert.equal(fileHash(destination),result.hash);}syncDir(directory);const verified=openSegment(path.resolve(target),result);verified.close();return result;
 }finally{db?.close();for(const suffix of ['', '-journal'])if(fs.existsSync(temporary+suffix))fs.unlinkSync(temporary+suffix);}
}
// Cache is rooted at the final DB name and survives newer snapshot offers. An
// interrupted bootstrap never publishes that DB until ALL objects and the
// canonical history audit succeed. Each verified object is reused without copy.
export async function receiveArchiveObjects(catalogueFile,target,{sources,fetchChunk=fetchArchiveChunk,fetchRow,onProgress=()=>{},signal,archiveAudit=null}={}){
 assert(!fs.existsSync(target),'archive receiver cannot replace active history');
 validateArchiveSources(sources);const directory=segmentDirectory(path.resolve(target));ensureDirectory(directory);
 const db=new DatabaseSync(sqlitePath(catalogueFile));let count=0,downloaded=0,last=0,root=null,digest=null;
 try{db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL');
  for(const entry of db.prepare('SELECT * FROM journal_segments ORDER BY first').iterate()){
   signal?.throwIfAborted();validateArchiveEntry(entry);assert.equal(entry.first,last+1,'archive catalogue gap');if(last){assert.equal(entry.parent,root);assert.equal(entry.previous,digest);}last=entry.last;root=entry.root;digest=entry.digest;
   const reference=path.join(directory,'.reference-'+entry.hash+'.json');let actual=entry;
   if(fs.existsSync(reference)){const s=fs.lstatSync(reference);assert(s.isFile()&&!s.isSymbolicLink()&&s.size<2048);actual=JSON.parse(fs.readFileSync(reference));validateArchiveEntry(actual);checkRange(actual,entry);}
   let destination=segmentPath(path.resolve(target),actual),reusable=false;
   if(fs.existsSync(destination)){try{if(archiveAudit)archiveAudit.verify(actual);else{const verified=openSegment(path.resolve(target),actual);verified.close();}reusable=true;}catch{quarantineCache(destination,target);}}
   if(!reusable){
    // A durable reference can outlive its cached file (for example an interrupted
    // cache restore). Physical downloads always use the publisher's identity;
    // never put those bytes under the missing reconstructed object's filename.
    actual=entry;destination=segmentPath(path.resolve(target),entry);
    const space=fs.statfsSync(directory);assert(space.bavail*space.bsize>entry.bytes+256*1024*1024,'archive download disk headroom');let completed=false,lastError;
    // On corruption retry the complete object from another source. Combining
    // unverified ranges from hostile sources must never publish bad history.
    for(const source of sources){
     const temporary=path.join(archiveStaging(directory),'.download-'+randomUUID()+'.pending');let fd;
     try{fd=fs.openSync(temporary,'wx',0o600);
      for(let offset=0;offset<entry.bytes;offset+=ARCHIVE_CHUNK){signal?.throwIfAborted();const reply=await fetchChunk(source,entry.hash,offset);exact(reply,['hash','offset','bytes','data']);assert.equal(reply.hash,entry.hash);assert.equal(reply.offset,offset);assert.equal(reply.bytes,entry.bytes);assert(typeof reply.data==='string'&&reply.data.length<=Math.ceil(ARCHIVE_CHUNK/3)*4);const b=Buffer.from(reply.data,'base64');assert.equal(b.toString('base64'),reply.data);assert.equal(b.length,Math.min(ARCHIVE_CHUNK,entry.bytes-offset));assert.equal(fs.writeSync(fd,b),b.length);downloaded+=b.length;onProgress({objects:count,downloaded,offset:offset+b.length});}
      fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;assert.equal(fileHash(temporary),entry.hash,'archive download checksum');fs.linkSync(temporary,destination);syncDir(directory);completed=true;
     }catch(e){lastError=e;}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
     if(completed)break;signal?.throwIfAborted();
    }
    if(!completed){actual=await rebuildArchive(entry,target,{sources,onProgress:p=>onProgress({objects:count,...p}),signal,fetchRow});const pending=path.join(archiveStaging(directory),path.basename(reference,'.json')+'.'+randomUUID()+'.pending'),fd=fs.openSync(pending,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(actual));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(pending,reference);syncDir(directory);}
    else if(fs.existsSync(reference)){fs.unlinkSync(reference);syncDir(directory);}
    if(archiveAudit)archiveAudit.verify(actual);else{const verified=openSegment(path.resolve(target),actual);verified.close();}
   }
   if(actual.hash!==entry.hash||actual.bytes!==entry.bytes)db.prepare('UPDATE journal_segments SET hash=?,bytes=? WHERE first=?').run(actual.hash,actual.bytes,entry.first);
   count++;onProgress({objects:count,downloaded,reused:reusable});
  }
  return {objects:count,downloaded,through:last};
 }finally{db.close();}
}
// A temporary audit DB shares immutable files through hard links. The final
// cache is already durable; a crash before DB publication leaves reusable data.
export function linkArchiveForAudit(catalogueFile,target,archiveAudit=null){
 const directory=segmentDirectory(path.resolve(catalogueFile));ensureDirectory(directory);const db=new DatabaseSync(sqlitePath(catalogueFile));
 try{db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL');for(const entry of db.prepare('SELECT * FROM journal_segments ORDER BY first').iterate()){
  validateArchiveEntry(entry);let actual=entry;const reference=path.join(segmentDirectory(path.resolve(target)),'.reference-'+entry.hash+'.json');
  if(fs.existsSync(reference)){const s=fs.lstatSync(reference);assert(s.isFile()&&!s.isSymbolicLink()&&s.size<2048);actual=JSON.parse(fs.readFileSync(reference));validateArchiveEntry(actual);checkRange(actual,entry);}
  const from=segmentPath(path.resolve(target),actual),to=segmentPath(path.resolve(catalogueFile),actual);if(archiveAudit)archiveAudit.link(actual,to);else{const verified=openSegment(path.resolve(target),actual);verified.close();fs.linkSync(from,to);}
  if(actual.hash!==entry.hash||actual.bytes!==entry.bytes)db.prepare('UPDATE journal_segments SET hash=?,bytes=? WHERE first=?').run(actual.hash,actual.bytes,entry.first);
 }}finally{db.close();}syncDir(directory);
}
export function removeAuditLinks(catalogueFile,archiveAudit=null){const directory=segmentDirectory(path.resolve(catalogueFile));if(!fs.existsSync(directory))return;assert(!fs.lstatSync(directory).isSymbolicLink());const db=archiveAudit?new DatabaseSync(sqlitePath(catalogueFile),{readOnly:true}):null,dir=fs.opendirSync(directory);try{for(let e;(e=dir.readSync());){const name=e.name;assert(/^[a-f0-9]{64}\.sqlite$/.test(name));const file=path.join(directory,name);assert(fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink());const entry=db?.prepare('SELECT * FROM journal_segments WHERE hash=?').get(name.slice(0,-7));if(entry)archiveAudit.unlink(entry,file);else fs.unlinkSync(file);}}finally{dir.closeSync();db?.close();}fs.rmdirSync(directory);}
export function syncPublishedState(target){syncDir(path.dirname(path.resolve(target)));}
