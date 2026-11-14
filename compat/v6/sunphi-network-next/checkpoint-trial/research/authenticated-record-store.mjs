// Candidate storage only. No RPC, consensus activation or issuance entry point.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {sqlitePath} from '../sqlite-path.mjs';
import {hash,canonical,hex} from '../crypto.mjs';
import {RECORD_DOMAIN as DOMAIN,EMPTY,recordKey as keyCheck,recordSeal as seal,verifyRecordProof} from './record-proof.mjs';
export {EMPTY,verifyRecordProof} from './record-proof.mjs';
const priority=key=>hash({domain:DOMAIN+'/PRIORITY',key});
const before=(a,b)=>a.priority<b.priority||a.priority===b.priority&&a.key<b.key;
const valueText=v=>{const text=canonical(v);assert(Buffer.byteLength(text)<=65536,'record size');return text;};
const edge=n=>n?{key:n.key,hash:n.digest}:{key:null,hash:EMPTY};
function checkNode(n,expected){assert(n,'missing authenticated node');assert.equal(n.digest,expected,'authenticated path mismatch');assert.equal(n.valueHash,hash(JSON.parse(n.value)),'record corruption');assert.equal(seal(n),expected,'tree corruption');assert((n.left===null)===(n.leftHash===EMPTY));assert((n.right===null)===(n.rightHash===EMPTY));return n;}
export class AuthenticatedRecordStore{
 static create(file,entries,{progress}={}){
  fs.closeSync(fs.openSync(file,'wx',0o600));const db=new DatabaseSync(sqlitePath(file));let root;
  try{db.exec('PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; CREATE TABLE nodes(key TEXT PRIMARY KEY,value TEXT NOT NULL,valueHash TEXT NOT NULL,left TEXT,leftHash TEXT NOT NULL,right TEXT,rightHash TEXT NOT NULL,digest TEXT NOT NULL); CREATE TABLE meta(id INTEGER PRIMARY KEY CHECK(id=1),rootKey TEXT,rootHash TEXT NOT NULL,sequence INTEGER NOT NULL,journalHash TEXT NOT NULL); CREATE TABLE journal(sequence INTEGER PRIMARY KEY,parent TEXT NOT NULL,root TEXT NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL); BEGIN IMMEDIATE;');
   // Sorted input and a Cartesian stack build the deterministic treap in O(n).
   const stack=[],put=db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?)');let previous=null,count=0;
   const write=n=>{n.digest=seal(n);put.run(n.key,n.value,n.valueHash,n.left,n.leftHash,n.right,n.rightHash,n.digest);};
   for(const [key,value] of entries){keyCheck(key);assert(previous===null||key>previous,'strictly sorted unique import');previous=key;const text=valueText(value),n={key,value:text,valueHash:hash(value),left:null,leftHash:EMPTY,right:null,rightHash:EMPTY,priority:priority(key)};let last=null;
    while(stack.length&&before(n,stack.at(-1))){const done=stack.pop();if(last){done.right=last.key;done.rightHash=last.digest;}write(done);last=done;}
    if(last){n.left=last.key;n.leftHash=last.digest;}stack.push(n);count++;if(count%100000===0)progress?.(count);
   }
   let last=null;while(stack.length){const done=stack.pop();if(last){done.right=last.key;done.rightHash=last.digest;}write(done);last=done;}root=edge(last);
   db.prepare('INSERT INTO meta VALUES(1,?,?,0,?)').run(root.key,root.hash,EMPTY);db.exec('COMMIT');
  }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}finally{db.close();}
  return new AuthenticatedRecordStore(file,root.hash);
 }
 constructor(file,expectedRoot){hex(expectedRoot);this.file=file;this.commitObservers=new Set();this.db=new DatabaseSync(sqlitePath(file));try{this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');this.getNode=this.db.prepare('SELECT * FROM nodes WHERE key=?');this.putNode=this.db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,valueHash=excluded.valueHash,left=excluded.left,leftHash=excluded.leftHash,right=excluded.right,rightHash=excluded.rightHash,digest=excluded.digest');const m=this.meta;assert.equal(m.rootHash,expectedRoot,'source root pin');if(m.rootKey!==null)this._read({key:m.rootKey,hash:m.rootHash});else assert.equal(m.rootHash,EMPTY);}catch(e){this.db.close();throw e;}}
 get meta(){return this.db.prepare('SELECT * FROM meta WHERE id=1').get();}
 get root(){return this.meta.rootHash;}
 readRecords(expectedRoot,callback){
  assert(!this.cache&&!this.snapshotMode,'nested authenticated read');hex(expectedRoot);
  this.db.exec('BEGIN');this.cache=new Map();this.cacheBytes=0;
  try{const m=this.meta;assert.equal(m.rootHash,expectedRoot,'stale read root');
   const result=callback({get:key=>{keyCheck(key);return this._find({key:m.rootKey,hash:m.rootHash},key);}});
   assert(!result?.then,'synchronous read required');this.db.exec('COMMIT');return result;
  }catch(e){this.db.exec('ROLLBACK');throw e;}finally{this.cache=null;}
 }
 onCommit(observe){this.commitObservers.add(observe);return ()=>this.commitObservers.delete(observe);}
 readSnapshot(expectedRoot){
  assert(!this.snapshotMode,'nested snapshot');return AuthenticatedRecordStore.readOnly(this.file,expectedRoot);
 }
 static readOnly(file,expectedRoot){
  hex(expectedRoot);const reader=Object.create(AuthenticatedRecordStore.prototype);reader.snapshotMode=true;reader.db=new DatabaseSync(sqlitePath(file),{readOnly:true});
  try{reader.db.exec('PRAGMA query_only=ON; BEGIN;');reader.getNode=reader.db.prepare('SELECT * FROM nodes WHERE key=?');assert.equal(reader.root,expectedRoot,'snapshot root advanced');return reader;}catch(e){reader.db.close();throw e;}
 }
 // Full offline integrity walk, never part of the payment hot path. A flat SQL
 // enumeration alone would miss broken edges and unreachable extra records.
 scanAuthenticated(visit){const m=this.meta,stack=[{ref:{key:m.rootKey,hash:m.rootHash},low:null,high:null,depth:0,parent:null}];let count=0;while(stack.length){const item=stack.pop();if(item.ref.key===null){assert.equal(item.ref.hash,EMPTY);continue;}assert(item.depth<128,'tree depth bound');const n=this._read(item.ref);assert(item.low===null||n.key>item.low,'tree ordering');assert(item.high===null||n.key<item.high,'tree ordering');if(item.parent)assert(before(item.parent,n),'tree priority');visit(n.key,JSON.parse(n.value));count++;stack.push({ref:this._child(n,'right'),low:n.key,high:item.high,depth:item.depth+1,parent:n},{ref:this._child(n,'left'),low:item.low,high:n.key,depth:item.depth+1,parent:n});}assert.equal(count,this.db.prepare('SELECT count(*) n FROM nodes').get().n,'unreachable index records');return count;}
 _cache(n){if(!this.cache)return;const id=n.key+':'+n.digest,bytes=n.value.length*2+1024;if(this.cache.has(id))return;
  // Large atomic batches create many obsolete path versions. Evict the least
  // recently used entry instead of permanently filling the transaction cache.
  while(this.cache.size>=1024||this.cacheBytes+bytes>8*1024*1024){const key=this.cache.keys().next().value,old=this.cache.get(key);this.cache.delete(key);this.cacheBytes-=old.value.length*2+1024;}
  this.cache.set(id,{...n});this.cacheBytes+=bytes;
 }
 _read(ref){if(ref.key===null){assert.equal(ref.hash,EMPTY);return null;}this.reads=(this.reads??0)+1;const id=ref.key+':'+ref.hash,cached=this.cache?.get(id);if(cached){this.cache.delete(id);this.cache.set(id,cached);return {...cached};}this.databaseReads=(this.databaseReads??0)+1;const n=checkNode(this.getNode.get(ref.key),ref.hash);n.priority=priority(n.key);this._cache(n);return n;}
 _child(n,side){return {key:n[side],hash:n[side+'Hash']};}
 _write(n){n.digest=seal(n);this.putNode.run(n.key,n.value,n.valueHash,n.left,n.leftHash,n.right,n.rightHash,n.digest);n.priority??=priority(n.key);this._cache(n);return edge(n);}
 _setChild(n,side,ref){n[side]=ref.key;n[side+'Hash']=ref.hash;}
 _find(ref,key,path){for(let depth=0;ref.key!==null;depth++){assert(depth<128,'tree depth bound');const n=this._read(ref);path?.push({key:n.key,valueHash:n.valueHash,left:n.left,leftHash:n.leftHash,right:n.right,rightHash:n.rightHash});if(key===n.key)return JSON.parse(n.value);ref=this._child(n,key<n.key?'left':'right');}assert.equal(ref.hash,EMPTY);return undefined;}
 proof(key,expectedRoot){keyCheck(key);if(!this.snapshotMode)this.db.exec('BEGIN');this.cache=new Map();this.cacheBytes=0;try{const m=this.meta;assert.equal(m.rootHash,expectedRoot,'stale proof root');const path=[],value=this._find({key:m.rootKey,hash:m.rootHash},key,path),proof={key,found:value!==undefined,path,...(value===undefined?{}:{value})};verifyRecordProof(proof,expectedRoot);if(!this.snapshotMode)this.db.exec('COMMIT');return proof;}catch(e){if(!this.snapshotMode)this.db.exec('ROLLBACK');throw e;}finally{this.cache=null;}}
 _merge(a,b,depth=0){assert(depth<128,'tree depth bound');if(a.key===null)return b;if(b.key===null)return a;const x=this._read(a),y=this._read(b);if(before(x,y)){this._setChild(x,'right',this._merge(this._child(x,'right'),b,depth+1));return this._write(x);}this._setChild(y,'left',this._merge(a,this._child(y,'left'),depth+1));return this._write(y);}
 _change(ref,key,value,depth=0){assert(depth<128,'tree depth bound');let n=this._read(ref);if(!n){assert(value!==undefined,'delete absent record');const text=valueText(value);return this._write({key,value:text,valueHash:hash(value),left:null,leftHash:EMPTY,right:null,rightHash:EMPTY});}
  if(n.key===key){if(value===undefined){const out=this._merge(this._child(n,'left'),this._child(n,'right'));this.db.prepare('DELETE FROM nodes WHERE key=?').run(key);return out;}n.value=valueText(value);n.valueHash=hash(value);return this._write(n);}
  const side=key<n.key?'left':'right',other=side==='left'?'right':'left',child=this._change(this._child(n,side),key,value,depth+1);this._setChild(n,side,child);
  const c=this._read(child);if(c&&before(c,n)){this._setChild(n,side,this._child(c,other));this._setChild(c,other,this._write(n));return this._write(c);}return this._write(n);
 }
 transact(expectedRoot,event,callback,{beforeCommit,dryRun=false,recordLimit=256,eventLimit=65536}={}){
  assert(Number.isSafeInteger(recordLimit)&&recordLimit>=1&&recordLimit<=8192,'transaction record limit');
  assert(Number.isSafeInteger(eventLimit)&&eventLimit>=1&&eventLimit<=2*1024*1024,'transaction event limit');
  hex(expectedRoot);assert(Buffer.byteLength(canonical(event))<=eventLimit,'event size');this.db.exec('BEGIN IMMEDIATE');this.reads=0;this.databaseReads=0;this.cache=new Map();this.cacheBytes=0;try{const m=this.meta;assert.equal(m.rootHash,expectedRoot,'stale writer');let ref={key:m.rootKey,hash:m.rootHash};const touched=new Map();
   const touch=key=>{if(!touched.has(key)){assert(touched.size<recordLimit,'transaction record bound');touched.set(key,this._find(ref,key));}};
   const api={get:key=>{keyCheck(key);return this._find(ref,key);},set:(key,value)=>{keyCheck(key);valueText(value);touch(key);ref=this._change(ref,key,value);},delete:key=>{keyCheck(key);touch(key);ref=this._change(ref,key,undefined);}};
   const value=callback(api);assert(!value?.then,'synchronous transaction callback required');
   if(!touched.size){this.db.exec(dryRun?'ROLLBACK':'COMMIT');return {root:m.rootHash,sequence:m.sequence,value,reads:this.reads,databaseReads:this.databaseReads,changed:0};}
   const version=value=>value===undefined?{present:false}:{present:true,value};
   const changes=[...touched].sort(([a],[b])=>a<b?-1:1).map(([key,before])=>({key,before:version(before),after:version(this._find(ref,key))}));
   const sequence=m.sequence+1,body={domain:DOMAIN+'/JOURNAL',sequence,parent:m.rootHash,root:ref.hash,previousJournal:m.journalHash,event,changes},digest=hash(body);
   this.db.prepare('INSERT INTO journal VALUES(?,?,?,?,?)').run(sequence,m.rootHash,ref.hash,canonical(body),digest);this.db.prepare('UPDATE meta SET rootKey=?,rootHash=?,sequence=?,journalHash=? WHERE id=1').run(ref.key,ref.hash,sequence,digest);beforeCommit?.();this.db.exec(dryRun?'ROLLBACK':'COMMIT');if(!dryRun)for(const observe of this.commitObservers)try{observe();}catch{}return {root:ref.hash,sequence,value,reads:this.reads,databaseReads:this.databaseReads,changed:changes.length};
  }catch(e){this.db.exec('ROLLBACK');throw e;}finally{this.cache=null;}
 }
 close(){this.db.close();}
}
