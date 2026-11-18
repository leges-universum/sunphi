// Authenticated chunk transport. SQLite is opened only after complete validation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import {sqlitePath} from '../sqlite-path.mjs';
import {snapshotWorkerTask} from './snapshot-worker-task.mjs';
import {randomUUID} from 'node:crypto';
import {hash,hex,exact,integer} from '../crypto.mjs';
import {verifyCheckpoint} from '../checkpoint.mjs';
import {checkPolicyState} from '../checkpoint-state.mjs';
import {openBoundedApplication} from './bounded-application.mjs';
import {openFreshApplication,freshRootTerms} from './fresh-application.mjs';
import {openIndexedSchemaApplication,verifyIndexedSchemaUpgrade} from './indexed-schema-upgrade.mjs';
import {readPackedBytes} from './snapshot-pack-codec.mjs';
import {SEGMENT_TABLE} from './journal-segment.mjs';
import {receiveArchiveObjects,linkArchiveForAudit,removeAuditLinks,syncPublishedState} from './archive-transport.mjs';
export const SNAPSHOT_FORMAT=4,CHUNK_SIZE=524288,MAX_SNAPSHOT_BYTES=64*1024**3;
export const HISTORY_SNAPSHOT_FORMAT=5,WRITE_HISTORY_BOUND_SNAPSHOTS=false;
export const ARCHIVE_SNAPSHOT_FORMAT=6;
const DOMAIN='DUEBYTE_INDEXED_SNAPSHOT_V1',leaf=(i,b)=>hash({domain:DOMAIN+'/CHUNK',index:i,data:b.toString('base64')}),pair=(a,b)=>hash({domain:DOMAIN+'/PAIR',left:a,right:b});
function diskSpace(directory,bytes){const s=fs.statfsSync(directory);assert(s.bavail*s.bsize>=bytes+256*1024**2,'insufficient disk space for safe snapshot staging');}
export function validateManifest(m){
 const history=[HISTORY_SNAPSHOT_FORMAT,ARCHIVE_SNAPSHOT_FORMAT].includes(m?.format);exact(m,['domain','format','configHash','height','root','bytes','chunkSize','chunks','chunksRoot',...(history?['journalSequence','journalHash']:[])]);assert.equal(m.domain,m.format===ARCHIVE_SNAPSHOT_FORMAT?'DUEBYTE_INDEXED_SNAPSHOT_V3':history?'DUEBYTE_INDEXED_SNAPSHOT_V2':DOMAIN);assert([SNAPSHOT_FORMAT,HISTORY_SNAPSHOT_FORMAT,ARCHIVE_SNAPSHOT_FORMAT].includes(m.format));if(history){integer(m.journalSequence,1);hex(m.journalHash);}hex(m.configHash);hex(m.root);hex(m.chunksRoot);integer(m.height,1);integer(m.bytes,1);assert(m.bytes<=MAX_SNAPSHOT_BYTES);assert.equal(m.chunkSize,CHUNK_SIZE);assert.equal(m.chunks,Math.ceil(m.bytes/CHUNK_SIZE));return m;
}
export function chunkProof(levels,index){const proof=[];for(let n=index,l=0;l<levels.length-1;l++,n=Math.floor(n/2))proof.push(levels[l][n^1]??levels[l][n]);return proof;}
export function verifyChunk(m,c){
 validateManifest(m);exact(c,['index','data','proof']);integer(c.index);assert(c.index<m.chunks);assert(typeof c.data==='string'&&c.data.length<=Math.ceil(CHUNK_SIZE/3)*4);const bytes=Buffer.from(c.data,'base64');assert.equal(bytes.toString('base64'),c.data);assert.equal(bytes.length,Math.min(CHUNK_SIZE,m.bytes-c.index*CHUNK_SIZE));
 assert(Array.isArray(c.proof));assert.equal(c.proof.length,Math.ceil(Math.log2(m.chunks)));let digest=leaf(c.index,bytes),index=c.index,count=m.chunks;
 for(const sibling of c.proof){hex(sibling);if(index%2===0&&index+1===count)assert.equal(sibling,digest,'duplicated Merkle edge');digest=index%2?pair(sibling,digest):pair(digest,sibling);index=Math.floor(index/2);count=Math.ceil(count/2);}
 assert.equal(digest,m.chunksRoot,'snapshot chunk proof');return bytes;
}
export function readChunk(file,m,levels,index){validateManifest(m);integer(index);assert(index<m.chunks);let data;if(file.endsWith('.pack'))data=readPackedBytes(file,m,index);else{const fd=fs.openSync(file,'r');data=Buffer.alloc(Math.min(CHUNK_SIZE,m.bytes-index*CHUNK_SIZE));try{assert.equal(fs.readSync(fd,data,0,data.length,index*CHUNK_SIZE),data.length);}finally{fs.closeSync(fd);}}const c={index,data:data.toString('base64'),proof:chunkProof(levels,index)};verifyChunk(m,c);return c;}
export async function exportIndexedSnapshot(handler,directory,{historyBound=WRITE_HISTORY_BOUND_SNAPSHOTS}={}){
 assert.equal(typeof historyBound,'boolean');
 const archive=handler.store.journal.hasSegments();if(archive)historyBound=true;
 const pages=handler.store.db.prepare('PRAGMA page_count').get().page_count,pageSize=handler.store.db.prepare('PRAGMA page_size').get().page_size;assert(pages*pageSize<=MAX_SNAPSHOT_BYTES);diskSpace(join(directory,'..'),Math.ceil(pages*pageSize*1.1));
 fs.mkdirSync(directory,{recursive:false});const root=handler.root,snapshot=handler.store.readSnapshot(root),file=join(directory,'state.sqlite');let height;
 try{height=snapshot.proof('meta/blockHead',root).value.height;await backup(snapshot.db,sqlitePath(file));}finally{snapshot.close();}
 // Only the generated copy enters this worker. The live writer and its read
 // lease are already released; VACUUM and hashing cannot block consensus JS.
 return snapshotWorkerTask(new URL('./snapshot-export-worker.mjs',import.meta.url),{directory,root,height,configHash:hash(handler.config),historyBound,archive});
}
export function finishSnapshotExport({directory,root,height,configHash,historyBound=false,archive=false}){
 assert(!archive||historyBound,'archive requires independent history commitment');
 const file=join(directory,'state.sqlite'),db=new DatabaseSync(sqlitePath(file));let journal;try{
  db.exec('PRAGMA synchronous=FULL');assert.equal(db.prepare('SELECT rootHash FROM meta WHERE id=1').get().rootHash,root);
  const before=db.prepare('SELECT * FROM meta WHERE id=1').get(),free=db.prepare('PRAGMA freelist_count').get().freelist_count,page=db.prepare('PRAGMA page_size').get().page_size,count=db.prepare('PRAGMA page_count').get().page_count,s=fs.statfsSync(directory);
  journal={journalSequence:before.sequence,journalHash:before.journalHash};
  // Skip optional physical reclamation if staging headroom is insufficient.
  // The complete signed history remains present in either representation.
  if(free>64&&s.bavail*s.bsize>(count-free)*page*1.1+256*1024**2){db.exec('VACUUM');assert.deepEqual(db.prepare('SELECT * FROM meta WHERE id=1').get(),before);}
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 }finally{db.close();}
 const bytes=fs.statSync(file).size;assert(bytes>0&&bytes<=MAX_SNAPSHOT_BYTES);const leaves=[],fd=fs.openSync(file,'r');try{for(let offset=0;offset<bytes;offset+=CHUNK_SIZE){const data=Buffer.alloc(Math.min(CHUNK_SIZE,bytes-offset));assert.equal(fs.readSync(fd,data,0,data.length,offset),data.length);leaves.push(leaf(leaves.length,data));}}finally{fs.closeSync(fd);}
 const levels=[leaves];while(levels.at(-1).length>1){const last=levels.at(-1),next=[];for(let i=0;i<last.length;i+=2)next.push(pair(last[i],last[i+1]??last[i]));levels.push(next);}
 const manifest={domain:archive?'DUEBYTE_INDEXED_SNAPSHOT_V3':historyBound?'DUEBYTE_INDEXED_SNAPSHOT_V2':DOMAIN,format:archive?ARCHIVE_SNAPSHOT_FORMAT:historyBound?HISTORY_SNAPSHOT_FORMAT:SNAPSHOT_FORMAT,configHash,height,root,bytes,chunkSize:CHUNK_SIZE,chunks:leaves.length,chunksRoot:levels.at(-1)[0],...(historyBound?journal:{})};validateManifest(manifest);
 fs.writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest),{flag:'wx'});fs.writeFileSync(join(directory,'levels.json'),JSON.stringify(levels),{flag:'wx'});return {manifest,levels,file};
}
export function checkIndexedCheckpoint(document,manifest,policy,config,{previous=null,now}={}){
 validateManifest(manifest);verifyCheckpoint(document,policy,{previous,allowGap:true,configHash:hash(config),...(now?{now}:{})});assert.equal(manifest.configHash,hash(config));assert.equal(document.body.appHeight,manifest.height);assert.equal(document.body.appHash,manifest.root);assert.equal(document.body.snapshotHash,hash(manifest));return document;
}
export function snapshotOffer(document,manifest){validateManifest(manifest);return {height:manifest.height,format:manifest.format,chunks:manifest.chunks,hash:Buffer.from(hash(manifest),'hex').toString('base64'),metadata:Buffer.from(JSON.stringify({document,manifest})).toString('base64')};}
export function acceptIndexedSnapshot(q,previous,policy,config,currentHeight){
 assert.equal(currentHeight,0,'bootstrap must not replace existing state');const sn=q.snapshot;assert([SNAPSHOT_FORMAT,HISTORY_SNAPSHOT_FORMAT,ARCHIVE_SNAPSHOT_FORMAT].includes(sn?.format));assert(typeof sn.metadata==='string'&&sn.metadata.length<=131072);const metadata=JSON.parse(Buffer.from(sn.metadata,'base64'));exact(metadata,['document','manifest']);const {document,manifest}=metadata;assert.equal(sn.format,manifest.format,'snapshot format binding');
 checkIndexedCheckpoint(document,manifest,policy,config,{previous});assert.equal(q.appHash,manifest.root,'light-client root');assert.equal(Number(sn.height),manifest.height);assert.equal(sn.chunks,manifest.chunks);assert.equal(Buffer.from(sn.hash,'base64').toString('hex'),hash(manifest));return metadata;
}
function checkSchema(file,{fresh=false,archive=false}={}){
 const db=new DatabaseSync(sqlitePath(file),{readOnly:true});try{
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
  const expected={nodes:['key','value','valueHash','left','leftHash','right','rightHash','digest'],meta:['id','rootKey','rootHash','sequence','journalHash'],journal:['sequence','parent','root','body','digest'],blocks:['height','body','root']};
  if(fresh)delete expected.blocks;
  if(archive)expected.journal_segments=['first','last','hash','bytes','parent','root','previous','digest'];
  const entries=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();assert.deepEqual(entries.map(x=>x.name),Object.keys(expected).sort());
  const definitions={nodes:'CREATE TABLE nodes(key TEXT PRIMARY KEY,value TEXT NOT NULL,valueHash TEXT NOT NULL,left TEXT,leftHash TEXT NOT NULL,right TEXT,rightHash TEXT NOT NULL,digest TEXT NOT NULL)',meta:'CREATE TABLE meta(id INTEGER PRIMARY KEY CHECK(id=1),rootKey TEXT,rootHash TEXT NOT NULL,sequence INTEGER NOT NULL,journalHash TEXT NOT NULL)',journal:'CREATE TABLE journal(sequence INTEGER PRIMARY KEY,parent TEXT NOT NULL,root TEXT NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL)',blocks:'CREATE TABLE blocks(height INTEGER PRIMARY KEY,body TEXT NOT NULL,root TEXT NOT NULL)'};
  if(archive)definitions.journal_segments=SEGMENT_TABLE;
  for(const e of entries)assert.equal(e.sql.replace(/\s/g,'').toLowerCase(),definitions[e.name].replace(/\s/g,'').toLowerCase(),'unexpected SQLite schema definition');
  for(const e of entries){assert.equal(e.type,'table');assert(/^CREATE TABLE /i.test(e.sql));assert(!/VIRTUAL|GENERATED|REFERENCES|CHECK\s*\(.*SELECT/is.test(e.sql));assert.deepEqual(db.prepare('PRAGMA table_info('+e.name+')').all().map(x=>x.name),expected[e.name]);}
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
 }finally{db.close();}
}
export class IndexedSnapshotReceiver{
 constructor({directory,target,metadata,policy,config,source,certificate,fresh=null,schemaUpgrade=null,previous=null,archiveSources=[]}){
  if(schemaUpgrade){exact(schemaUpgrade,['certificate','trustedBoundary']);assert(!fresh&&!source&&!certificate,'schema upgrade requires a single state authority');verifyIndexedSchemaUpgrade(schemaUpgrade.certificate,config,schemaUpgrade.trustedBoundary);assert(metadata.manifest.height>schemaUpgrade.certificate.body.sourceHeight,'snapshot must contain a post-upgrade block');}
  if(fresh){assert(!source&&!certificate,'fresh bootstrap cannot import migration state');freshRootTerms(config,fresh);}
  assert(!fs.existsSync(target),'existing state must not be overwritten');checkIndexedCheckpoint(metadata.document,metadata.manifest,policy,config,{previous});Object.assign(this,{target,metadata,policy,config,source,certificate,fresh,schemaUpgrade,previous,archiveSources});
  this.directory=join(directory,hash(metadata.manifest));fs.mkdirSync(this.directory,{recursive:true});
 }
 receive(chunk){checkIndexedCheckpoint(this.metadata.document,this.metadata.manifest,this.policy,this.config,{previous:this.previous});verifyChunk(this.metadata.manifest,chunk);const file=join(this.directory,String(chunk.index)+'.json');if(fs.existsSync(file)){assert.deepEqual(JSON.parse(fs.readFileSync(file)),chunk,'conflicting duplicate chunk');return;}const temp=file+'.pending';diskSpace(this.directory,this.metadata.manifest.bytes+CHUNK_SIZE*2);fs.writeFileSync(temp,JSON.stringify(chunk),{mode:0o600});fs.renameSync(temp,file);}
 complete(){for(let i=0;i<this.metadata.manifest.chunks;i++)if(!fs.existsSync(join(this.directory,i+'.json')))return false;return true;}
 async installAsync({beforePublish=()=>{}}={}){
  assert(this.complete(),'incomplete snapshot');beforePublish();
  const {target,metadata,policy,config,source,certificate,fresh,schemaUpgrade,previous,archiveSources}=this;
  return snapshotWorkerTask(new URL('./indexed-snapshot-worker.mjs',import.meta.url),{directory:join(this.directory,'..'),target,metadata,policy,config,source,certificate,fresh,schemaUpgrade,previous,archiveSources});
 }
 assemble(temp){
  assert(this.complete(),'incomplete snapshot');const fd=fs.openSync(temp,'wx',0o600);
  try{for(let i=0;i<this.metadata.manifest.chunks;i++){const bytes=verifyChunk(this.metadata.manifest,JSON.parse(fs.readFileSync(join(this.directory,i+'.json'))));assert.equal(fs.writeSync(fd,bytes),bytes.length,'incomplete disk write');}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  checkSchema(temp,{fresh:!!(this.fresh||this.schemaUpgrade),archive:this.metadata.manifest.format===ARCHIVE_SNAPSHOT_FORMAT});
 }
 async installWithArchives(options={}){
  if(this.metadata.manifest.format!==ARCHIVE_SNAPSHOT_FORMAT)return this.install(options);
  const temp=join(this.directory,'catalogue-'+randomUUID()+'.sqlite');
  try{this.assemble(temp);await receiveArchiveObjects(temp,this.target,{sources:this.archiveSources,...options});return this.install(options);}
  finally{for(const suffix of ['', '-wal', '-shm'])if(fs.existsSync(temp+suffix))fs.unlinkSync(temp+suffix);}
 }
 install({beforePublish=()=>{},archiveAudit=null}={}){
  assert(this.complete(),'incomplete snapshot');assert(!fs.existsSync(this.target),'existing state must not be overwritten');checkIndexedCheckpoint(this.metadata.document,this.metadata.manifest,this.policy,this.config,{previous:this.previous});
  diskSpace(this.directory,this.metadata.manifest.bytes*2);
  const temp=join(this.directory,'assembled-'+randomUUID()+'.sqlite');
  try{this.assemble(temp);if(this.metadata.manifest.format===ARCHIVE_SNAPSHOT_FORMAT)linkArchiveForAudit(temp,this.target,archiveAudit);
  const app=this.schemaUpgrade?openIndexedSchemaApplication(temp,this.config,this.schemaUpgrade.certificate,this.schemaUpgrade.trustedBoundary,{auditJournal:true,archiveAudit}):this.fresh?openFreshApplication(temp,this.config,this.fresh,{auditJournal:true,archiveAudit}):openBoundedApplication(temp,this.source,this.config,this.certificate);
  try{assert.equal(app.handler.root,this.metadata.manifest.root);assert.equal(app.blocks.header.height,this.metadata.manifest.height);if([HISTORY_SNAPSHOT_FORMAT,ARCHIVE_SNAPSHOT_FORMAT].includes(this.metadata.manifest.format)){assert.equal(app.handler.store.meta.sequence,this.metadata.manifest.journalSequence,'snapshot history sequence');assert.equal(app.handler.store.meta.journalHash,this.metadata.manifest.journalHash,'snapshot history commitment');}app.handler.store.scanAuthenticated(()=>{});checkPolicyState(this.metadata.document,app.blocks.header,this.config,this.policy);}finally{app.close();}
  checkIndexedCheckpoint(this.metadata.document,this.metadata.manifest,this.policy,this.config,{previous:this.previous});beforePublish();assert(!fs.existsSync(this.target),'existing state must not be overwritten');
  // Hard-link publication is atomic and fails if a target appeared concurrently.
  fs.linkSync(temp,this.target);syncPublishedState(this.target);return {height:this.metadata.manifest.height,root:this.metadata.manifest.root};
  }finally{removeAuditLinks(temp,archiveAudit);for(const suffix of ['', '-wal', '-shm']){const file=temp+suffix;if(fs.existsSync(file))fs.unlinkSync(file);}}
 }
}
