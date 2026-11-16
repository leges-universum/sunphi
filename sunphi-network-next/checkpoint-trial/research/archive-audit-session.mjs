// A bounded-memory validation cache for ONE running bootstrap worker. Disk rows
// carry a MAC under an ephemeral process key: saved/progress data cannot grant
// verification authority, and a restart must validate every retained object.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {canonical,hash} from '../crypto.mjs';
import {sqlitePath} from '../sqlite-path.mjs';
import {openSegment,segmentPath} from './journal-segment.mjs';
import {decodeJournal} from './journal-codec.mjs';
import {verifyRetainedRow} from './journal-startup.mjs';
const sessions=new WeakSet();
export const isArchiveAuditSession=value=>sessions.has(value);
function stamp(file){const s=fs.lstatSync(file,{bigint:true});assert(s.isFile()&&!s.isSymbolicLink());return Object.fromEntries(['dev','ino','size','mtimeNs','ctimeNs','nlink'].map(k=>[k,String(s[k])]));}
export class ArchiveAuditSession{
 constructor(target,terms,{directory,onProgress=()=>{}}){
  this.target=path.resolve(target);this.terms=structuredClone({genesisRoot:terms.genesisRoot,bridge:terms.bridge??null});this.scope=hash(this.terms);this.onProgress=onProgress;this.key=randomBytes(32);
  this.file=path.join(directory,'archive-validation-'+randomUUID()+'.sqlite');fs.closeSync(fs.openSync(this.file,'wx',0o600));this.db=new DatabaseSync(sqlitePath(this.file));
  this.db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2048; CREATE TABLE verified(hash TEXT PRIMARY KEY,body TEXT NOT NULL,mac TEXT NOT NULL)');sessions.add(this);
 }
 mac(body){return createHmac('sha256',this.key).update(body).digest('hex');}
 saved(entry){const r=this.db.prepare('SELECT body,mac FROM verified WHERE hash=?').get(entry.hash);if(!r||this.mac(r.body)!==r.mac)return null;const value=JSON.parse(r.body);if(value.scope!==this.scope||canonical(value.entry)!==canonical({...entry}))return null;return value;}
 reusable(entry){const saved=this.saved(entry);return !!saved&&canonical(saved.stamp)===canonical(stamp(segmentPath(this.target,entry)));}
 remember(entry){const body=canonical({scope:this.scope,entry:{...entry},stamp:stamp(segmentPath(this.target,entry))});this.db.prepare('INSERT OR REPLACE INTO verified VALUES(?,?,?)').run(entry.hash,body,this.mac(body));}
 verify(entry,terms=this.terms){
  assert.equal(hash({genesisRoot:terms.genesisRoot,bridge:terms.bridge??null}),this.scope,'archive audit authority differs');
  if(this.reusable(entry)){this.onProgress({verifiedThrough:entry.last,reused:true});return;}
  const file=segmentPath(this.target,entry),before=stamp(file),db=openSegment(this.target,entry);let sequence=entry.first-1,parent=entry.parent,previous=entry.previous;
  try{for(const row of db.prepare('SELECT * FROM journal ORDER BY sequence').iterate()){
   assert(Buffer.byteLength(row.body)<=16*1024*1024,'archive row byte budget');
   verifyRetainedRow(row,decodeJournal(row.body),{parent,previous,sequence:++sequence,bridge:terms.bridge});parent=row.root;previous=row.digest;
   this.onProgress({verifiedThrough:sequence,reused:false});
  }assert.equal(sequence,entry.last);assert.equal(parent,entry.root);assert.equal(previous,entry.digest);assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');}
  finally{db.close();}
  assert.deepEqual(stamp(file),before,'archive changed during audit');this.remember(entry);
 }
 // Only our own hard-link operations may update inode link-count/ctime in a
 // verified receipt. Any other metadata change invalidates it and forces audit.
 link(entry,to){this.verify(entry);const from=segmentPath(this.target,entry),before=stamp(from);fs.linkSync(from,to);this.afterLink(entry,before);}
 unlink(entry,file){const valid=this.reusable(entry),before=valid?stamp(segmentPath(this.target,entry)):null;fs.unlinkSync(file);if(valid)this.afterLink(entry,before);}
 afterLink(entry,before){const after=stamp(segmentPath(this.target,entry));for(const k of ['dev','ino','size','mtimeNs'])assert.equal(after[k],before[k],'archive changed during link operation');this.remember(entry);}
 close(){sessions.delete(this);this.db.close();this.key.fill(0);fs.unlinkSync(this.file);}
}
