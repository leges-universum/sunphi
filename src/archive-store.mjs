import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { digest,exact } from './protocol.mjs';
import { isHash } from './epoch-seal.mjs';
export const byteHash=b=>createHash('sha256').update(b).digest('hex');
export function packageArchive(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>16*1024*1024)throw new Error('archive size');
 const chunks=[];for(let i=0;i<bytes.length;i+=65536)chunks.push(bytes.subarray(i,i+65536));
 const manifest={version:1,bytes:bytes.length,contentHash:byteHash(bytes),chunks:chunks.map(byteHash)};
 return {manifest,root:digest(manifest),chunks};
}
export function checkManifest(m,root){
 exact(m,['version','bytes','contentHash','chunks']);
 if(m.version!==1||!Number.isInteger(m.bytes)||m.bytes<1||m.bytes>16*1024*1024||!isHash(m.contentHash)||!Array.isArray(m.chunks)||m.chunks.length!==Math.ceil(m.bytes/65536)||m.chunks.some(x=>!isHash(x))||digest(m)!==root)throw new Error('invalid archive manifest');
}
export function assembleArchive(m,root,chunks){
 checkManifest(m,root);if(!Array.isArray(chunks)||chunks.length!==m.chunks.length)throw new Error('missing archive chunks');
 chunks.forEach((b,i)=>{if(!Buffer.isBuffer(b)||b.length!==(i===chunks.length-1?m.bytes-i*65536:65536)||byteHash(b)!==m.chunks[i])throw new Error('corrupted archive chunk');});
 const bytes=Buffer.concat(chunks);if(byteHash(bytes)!==m.contentHash)throw new Error('archive content mismatch');return bytes;
}
export class ArchiveStore{
 #db;
 constructor(path){mkdirSync(dirname(path),{recursive:true});this.#db=new DatabaseSync(path);this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS chunks(hash TEXT PRIMARY KEY,data BLOB NOT NULL); CREATE TABLE IF NOT EXISTS manifests(root TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS evidence(data_root TEXT NOT NULL,proof_root TEXT NOT NULL,PRIMARY KEY(data_root,proof_root));');}
 // Service verifies the proof and its canonical identity before registering.
 proofs(root){if(!isHash(root))throw new Error('archive identity');return this.#db.prepare('SELECT proof_root FROM evidence WHERE data_root=? ORDER BY proof_root').all(root).map(x=>x.proof_root);}
 put(m,root,chunks,dataRoot=null){assembleArchive(m,root,chunks);this.#db.exec('BEGIN IMMEDIATE');try{
  if(dataRoot!==null){const roots=this.proofs(dataRoot);if(!roots.includes(root)&&roots.length>=2)throw new Error('proof variant bound');}
  for(let i=0;i<chunks.length;i++){
   const old=this.#db.prepare('SELECT data FROM chunks WHERE hash=?').get(m.chunks[i]);
   if(old&&byteHash(old.data)!==m.chunks[i])throw new Error('stored chunk corruption; repair required');
   this.#db.prepare('INSERT OR IGNORE INTO chunks VALUES(?,?)').run(m.chunks[i],chunks[i]);
  }
  this.#db.prepare('INSERT OR IGNORE INTO manifests VALUES(?,?)').run(root,JSON.stringify(m));
  if(dataRoot!==null)this.#db.prepare('INSERT OR IGNORE INTO evidence VALUES(?,?)').run(dataRoot,root);
  this.#db.exec('COMMIT');
 }catch(e){this.#db.exec('ROLLBACK');throw e;}return {stored:true,root,bytes:m.bytes};}
 manifest(root){if(!isHash(root))throw new Error('archive identity');const row=this.#db.prepare('SELECT body FROM manifests WHERE root=?').get(root);if(!row)throw new Error('archive unavailable');const m=JSON.parse(row.body);checkManifest(m,root);return m;}
 chunk(hash){if(!isHash(hash))throw new Error('chunk identity');const row=this.#db.prepare('SELECT data FROM chunks WHERE hash=?').get(hash);if(!row||byteHash(row.data)!==hash)throw new Error('chunk missing or corrupt');return Buffer.from(row.data);}
 repair(hash,bytes){if(!isHash(hash)||!Buffer.isBuffer(bytes)||bytes.length>65536||byteHash(bytes)!==hash)throw new Error('invalid repair bytes');this.#db.prepare('INSERT OR REPLACE INTO chunks VALUES(?,?)').run(hash,bytes);}
 statistics(){return {chunkBytes:this.#db.prepare('SELECT COALESCE(SUM(length(data)),0) AS n FROM chunks').get().n,manifests:this.#db.prepare('SELECT COUNT(*) AS n FROM manifests').get().n,proofMappings:this.#db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n};}
 close(){this.#db.close();}
}
