// Authenticated chunk transport. SQLite is opened only after complete validation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import {sqlitePath} from '../sqlite-path.mjs';
import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {hash,hex,exact,integer} from '../crypto.mjs';
import {verifyCheckpoint} from '../checkpoint.mjs';
import {checkPolicyState} from '../checkpoint-state.mjs';
import {openBoundedApplication} from './bounded-application.mjs';
import {openFreshApplication,freshRootTerms} from './fresh-application.mjs';
import {openIndexedSchemaApplication,verifyIndexedSchemaUpgrade} from './indexed-schema-upgrade.mjs';
import {readPackedBytes} from './snapshot-pack-codec.mjs';
export const SNAPSHOT_FORMAT=4,CHUNK_SIZE=524288,MAX_SNAPSHOT_BYTES=64*1024**3;
const DOMAIN='DUEBYTE_INDEXED_SNAPSHOT_V1',leaf=(i,b)=>hash({domain:DOMAIN+'/CHUNK',index:i,data:b.toString('base64')}),pair=(a,b)=>hash({domain:DOMAIN+'/PAIR',left:a,right:b});
function diskSpace(directory,bytes){const s=fs.statfsSync(directory);assert(s.bavail*s.bsize>=bytes+256*1024**2,'insufficient disk space for safe snapshot staging');}
export function validateManifest(m){
 exact(m,['domain','format','configHash','height','root','bytes','chunkSize','chunks','chunksRoot']);assert.equal(m.domain,DOMAIN);assert.equal(m.format,SNAPSHOT_FORMAT);hex(m.configHash);hex(m.root);hex(m.chunksRoot);integer(m.height,1);integer(m.bytes,1);assert(m.bytes<=MAX_SNAPSHOT_BYTES);assert.equal(m.chunkSize,CHUNK_SIZE);assert.equal(m.chunks,Math.ceil(m.bytes/CHUNK_SIZE));return m;
}
export function chunkProof(levels,index){const proof=[];for(let n=index,l=0;l<levels.length-1;l++,n=Math.floor(n/2))proof.push(levels[l][n^1]??levels[l][n]);return proof;}
export function verifyChunk(m,c){
 validateManifest(m);exact(c,['index','data','proof']);integer(c.index);assert(c.index<m.chunks);assert(typeof c.data==='string'&&c.data.length<=Math.ceil(CHUNK_SIZE/3)*4);const bytes=Buffer.from(c.data,'base64');assert.equal(bytes.toString('base64'),c.data);assert.equal(bytes.length,Math.min(CHUNK_SIZE,m.bytes-c.index*CHUNK_SIZE));
 assert(Array.isArray(c.proof));assert.equal(c.proof.length,Math.ceil(Math.log2(m.chunks)));let digest=leaf(c.index,bytes),index=c.index,count=m.chunks;
 for(const sibling of c.proof){hex(sibling);if(index%2===0&&index+1===count)assert.equal(sibling,digest,'duplicated Merkle edge');digest=index%2?pair(sibling,digest):pair(digest,sibling);index=Math.floor(index/2);count=Math.ceil(count/2);}
 assert.equal(digest,m.chunksRoot,'snapshot chunk proof');return bytes;
}
export function readChunk(file,m,levels,index){validateManifest(m);integer(index);assert(index<m.chunks);let data;if(file.endsWith('.pack'))data=readPackedBytes(file,m,index);else{const fd=fs.openSync(file,'r');data=Buffer.alloc(Math.min(CHUNK_SIZE,m.bytes-index*CHUNK_SIZE));try{assert.equal(fs.readSync(fd,data,0,data.length,index*CHUNK_SIZE),data.length);}finally{fs.closeSync(fd);}}const c={index,data:data.toString('base64'),proof:chunkProof(levels,index)};verifyChunk(m,c);return c;}
export async function exportIndexedSnapshot(handler,directory){
 const pages=handler.store.db.prepare('PRAGMA page_count').get().page_count,pageSize=handler.store.db.prepare('PRAGMA page_size').get().page_size;assert(pages*pageSize<=MAX_SNAPSHOT_BYTES);diskSpace(join(directory,'..'),Math.ceil(pages*pageSize*1.1));
 fs.mkdirSync(directory,{recursive:false});const root=handler.root,snapshot=handler.store.readSnapshot(root),file=join(directory,'state.sqlite');let height;
 try{height=snapshot.proof('meta/blockHead',root).value.height;await backup(snapshot.db,sqlitePath(file));}finally{snapshot.close();}
 const db=new DatabaseSync(sqlitePath(file),{readOnly:true});try{assert.equal(db.prepare('SELECT rootHash FROM meta WHERE id=1').get().rootHash,root);}finally{db.close();}
 const bytes=fs.statSync(file).size;assert(bytes>0&&bytes<=MAX_SNAPSHOT_BYTES);const leaves=[],fd=fs.openSync(file,'r');try{for(let offset=0;offset<bytes;offset+=CHUNK_SIZE){const data=Buffer.alloc(Math.min(CHUNK_SIZE,bytes-offset));assert.equal(fs.readSync(fd,data,0,data.length,offset),data.length);leaves.push(leaf(leaves.length,data));}}finally{fs.closeSync(fd);}
 const levels=[leaves];while(levels.at(-1).length>1){const last=levels.at(-1),next=[];for(let i=0;i<last.length;i+=2)next.push(pair(last[i],last[i+1]??last[i]));levels.push(next);}
 const manifest={domain:DOMAIN,format:SNAPSHOT_FORMAT,configHash:hash(handler.config),height,root,bytes,chunkSize:CHUNK_SIZE,chunks:leaves.length,chunksRoot:levels.at(-1)[0]};validateManifest(manifest);
 fs.writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest),{flag:'wx'});fs.writeFileSync(join(directory,'levels.json'),JSON.stringify(levels),{flag:'wx'});return {manifest,levels,file};
}
export function checkIndexedCheckpoint(document,manifest,policy,config,{previous=null,now}={}){
 validateManifest(manifest);verifyCheckpoint(document,policy,{previous,allowGap:true,configHash:hash(config),...(now?{now}:{})});assert.equal(manifest.configHash,hash(config));assert.equal(document.body.appHeight,manifest.height);assert.equal(document.body.appHash,manifest.root);assert.equal(document.body.snapshotHash,hash(manifest));return document;
}
export function snapshotOffer(document,manifest){return {height:manifest.height,format:SNAPSHOT_FORMAT,chunks:manifest.chunks,hash:Buffer.from(hash(manifest),'hex').toString('base64'),metadata:Buffer.from(JSON.stringify({document,manifest})).toString('base64')};}
export function acceptIndexedSnapshot(q,previous,policy,config,currentHeight){
 assert.equal(currentHeight,0,'bootstrap must not replace existing state');const sn=q.snapshot;assert(sn?.format===SNAPSHOT_FORMAT);assert(typeof sn.metadata==='string'&&sn.metadata.length<=131072);const metadata=JSON.parse(Buffer.from(sn.metadata,'base64'));exact(metadata,['document','manifest']);const {document,manifest}=metadata;
 checkIndexedCheckpoint(document,manifest,policy,config,{previous});assert.equal(q.appHash,manifest.root,'light-client root');assert.equal(Number(sn.height),manifest.height);assert.equal(sn.chunks,manifest.chunks);assert.equal(Buffer.from(sn.hash,'base64').toString('hex'),hash(manifest));return metadata;
}
function checkSchema(file,{fresh=false}={}){
 const db=new DatabaseSync(sqlitePath(file),{readOnly:true});try{
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
  const expected={nodes:['key','value','valueHash','left','leftHash','right','rightHash','digest'],meta:['id','rootKey','rootHash','sequence','journalHash'],journal:['sequence','parent','root','body','digest'],blocks:['height','body','root']};
  if(fresh)delete expected.blocks;
  const entries=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();assert.deepEqual(entries.map(x=>x.name),Object.keys(expected).sort());
  const definitions={nodes:'CREATE TABLE nodes(key TEXT PRIMARY KEY,value TEXT NOT NULL,valueHash TEXT NOT NULL,left TEXT,leftHash TEXT NOT NULL,right TEXT,rightHash TEXT NOT NULL,digest TEXT NOT NULL)',meta:'CREATE TABLE meta(id INTEGER PRIMARY KEY CHECK(id=1),rootKey TEXT,rootHash TEXT NOT NULL,sequence INTEGER NOT NULL,journalHash TEXT NOT NULL)',journal:'CREATE TABLE journal(sequence INTEGER PRIMARY KEY,parent TEXT NOT NULL,root TEXT NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL)',blocks:'CREATE TABLE blocks(height INTEGER PRIMARY KEY,body TEXT NOT NULL,root TEXT NOT NULL)'};
  for(const e of entries)assert.equal(e.sql.replace(/\s/g,'').toLowerCase(),definitions[e.name].replace(/\s/g,'').toLowerCase(),'unexpected SQLite schema definition');
  for(const e of entries){assert.equal(e.type,'table');assert(/^CREATE TABLE /i.test(e.sql));assert(!/VIRTUAL|GENERATED|REFERENCES|CHECK\s*\(.*SELECT/is.test(e.sql));assert.deepEqual(db.prepare('PRAGMA table_info('+e.name+')').all().map(x=>x.name),expected[e.name]);}
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
 }finally{db.close();}
}
export class IndexedSnapshotReceiver{
 constructor({directory,target,metadata,policy,config,source,certificate,fresh=null,schemaUpgrade=null,previous=null}){
  if(schemaUpgrade){exact(schemaUpgrade,['certificate','trustedBoundary']);assert(!fresh&&!source&&!certificate,'schema upgrade requires a single state authority');verifyIndexedSchemaUpgrade(schemaUpgrade.certificate,config,schemaUpgrade.trustedBoundary);assert(metadata.manifest.height>schemaUpgrade.certificate.body.sourceHeight,'snapshot must contain a post-upgrade block');}
  if(fresh){assert(!source&&!certificate,'fresh bootstrap cannot import migration state');freshRootTerms(config,fresh);}
  assert(!fs.existsSync(target),'existing state must not be overwritten');checkIndexedCheckpoint(metadata.document,metadata.manifest,policy,config,{previous});Object.assign(this,{target,metadata,policy,config,source,certificate,fresh,schemaUpgrade,previous});
  this.directory=join(directory,hash(metadata.manifest));fs.mkdirSync(this.directory,{recursive:true});
 }
 receive(chunk){checkIndexedCheckpoint(this.metadata.document,this.metadata.manifest,this.policy,this.config,{previous:this.previous});verifyChunk(this.metadata.manifest,chunk);const file=join(this.directory,String(chunk.index)+'.json');if(fs.existsSync(file)){assert.deepEqual(JSON.parse(fs.readFileSync(file)),chunk,'conflicting duplicate chunk');return;}const temp=file+'.pending';diskSpace(this.directory,this.metadata.manifest.bytes+CHUNK_SIZE*2);fs.writeFileSync(temp,JSON.stringify(chunk),{mode:0o600});fs.renameSync(temp,file);}
 complete(){for(let i=0;i<this.metadata.manifest.chunks;i++)if(!fs.existsSync(join(this.directory,i+'.json')))return false;return true;}
 async installAsync({beforePublish=()=>{}}={}){
  assert(this.complete(),'incomplete snapshot');beforePublish();
  const {target,metadata,policy,config,source,certificate,fresh,schemaUpgrade,previous}=this;
  const worker=new Worker(new URL('./indexed-snapshot-worker.mjs',import.meta.url),{workerData:{directory:join(this.directory,'..'),target,metadata,policy,config,source,certificate,fresh,schemaUpgrade,previous}});
  return new Promise((resolve,reject)=>{let result=null;const timer=setTimeout(()=>{void worker.terminate();reject(Error('snapshot verification timeout'));},14*60*1000);worker.once('message',message=>{result=message;});worker.once('error',e=>{clearTimeout(timer);reject(e);});worker.once('exit',code=>{clearTimeout(timer);if(code===0&&result)resolve(result);else reject(Error('snapshot verification failed'));});});
 }
 install({beforePublish=()=>{}}={}){
  assert(this.complete(),'incomplete snapshot');assert(!fs.existsSync(this.target),'existing state must not be overwritten');checkIndexedCheckpoint(this.metadata.document,this.metadata.manifest,this.policy,this.config,{previous:this.previous});
  diskSpace(this.directory,this.metadata.manifest.bytes*2);
  const temp=join(this.directory,'assembled-'+randomUUID()+'.sqlite');
  try{const fd=fs.openSync(temp,'wx',0o600);
  try{for(let i=0;i<this.metadata.manifest.chunks;i++){const bytes=verifyChunk(this.metadata.manifest,JSON.parse(fs.readFileSync(join(this.directory,i+'.json'))));assert.equal(fs.writeSync(fd,bytes),bytes.length,'incomplete disk write');}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  checkSchema(temp,{fresh:!!(this.fresh||this.schemaUpgrade)});const app=this.schemaUpgrade?openIndexedSchemaApplication(temp,this.config,this.schemaUpgrade.certificate,this.schemaUpgrade.trustedBoundary):this.fresh?openFreshApplication(temp,this.config,this.fresh):openBoundedApplication(temp,this.source,this.config,this.certificate);
  try{assert.equal(app.handler.root,this.metadata.manifest.root);assert.equal(app.blocks.header.height,this.metadata.manifest.height);app.handler.store.scanAuthenticated(()=>{});checkPolicyState(this.metadata.document,app.blocks.header,this.config,this.policy);}finally{app.close();}
  checkIndexedCheckpoint(this.metadata.document,this.metadata.manifest,this.policy,this.config,{previous:this.previous});beforePublish();assert(!fs.existsSync(this.target),'existing state must not be overwritten');
  // Hard-link publication is atomic and fails if a target appeared concurrently.
  fs.linkSync(temp,this.target);return {height:this.metadata.manifest.height,root:this.metadata.manifest.root};
  }finally{for(const suffix of ['', '-wal', '-shm']){const file=temp+suffix;if(fs.existsSync(file))fs.unlinkSync(file);}}
 }
}
