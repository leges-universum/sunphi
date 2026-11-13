// Fresh checkpoint signatures remain separate from consensus root verification.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,resolve,sep,basename} from 'node:path';
import {hash,integer} from '../crypto.mjs';
import {CHECKPOINT,verifyBody,checkpointPolicy} from '../checkpoint.mjs';
import {checkPolicyState} from '../checkpoint-state.mjs';
import {AuthenticatedRecordStore} from './authenticated-record-store.mjs';
import {queryBounded} from './bounded-query.mjs';
import {exportIndexedSnapshot,validateManifest,checkIndexedCheckpoint,snapshotOffer,readChunk} from './indexed-snapshot.mjs';
import {packIndexedSnapshot} from './indexed-snapshot-pack.mjs';
const read=p=>JSON.parse(fs.readFileSync(p));
function atomic(file,value){const temp=file+'.'+process.pid+'.pending';fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600});fs.renameSync(temp,file);}
export function indexedBlock(app,height){
 integer(height,1);assert(height>app.terms.sourceHeight&&height<=app.blocks.header.height,'indexed committed height required');
 const offset=app.terms.kind==='fresh-genesis'?0:app.terms.kind==='indexed-schema-upgrade'?app.terms.sourceHeight+1:1;
 const row=app.handler.store.db.prepare('SELECT * FROM journal WHERE sequence=?').get(height-app.terms.sourceHeight+offset);assert(row,'committed journal missing');const body=JSON.parse(row.body);assert.equal(hash(body),row.digest);assert.equal(body.event.height,height);assert.equal(body.event.filter,false);assert.equal(body.root,row.root);return {height,root:row.root,blockHash:body.event.blockHash};
}
export function observeIndexedCheckpoint(app,body,manifest){
 validateManifest(manifest);assert.equal(manifest.configHash,hash(app.handler.config));assert.equal(body.snapshotHash,hash(manifest));assert.equal(body.appHeight,manifest.height);assert.equal(body.appHash,manifest.root);assert.equal(body.height,body.appHeight+1);
 assert.equal(indexedBlock(app,body.appHeight).root,body.appHash);assert.equal(indexedBlock(app,body.height).blockHash,body.blockHash);
}
export function indexedCheckpointBody(app,manifest,policy,{previous=null,sequence,now=Math.floor(Date.now()/1000),renewals=[]}={}){
 const effective=checkpointPolicy({renewals},policy,hash(app.handler.config)),height=manifest.height+1;
 const body={domain:CHECKPOINT,policyHash:hash(effective),network:effective.network,genesisHash:effective.genesisHash,sequence:sequence??(previous?.body.sequence??0)+1,height,blockHash:indexedBlock(app,height).blockHash,appHeight:manifest.height,appHash:manifest.root,snapshotHash:hash(manifest),previous:previous?hash(previous.body):null,issuedAt:now,expiresAt:Math.min(now+effective.maxAge,effective.notAfter)};
 observeIndexedCheckpoint(app,body,manifest);verifyBody(body,effective,{previous,allowGap:true,now});return body;
}
export async function signIndexedCheckpoint({app,book,body,manifest,renewals=[],verifyConsensus}){
 assert.equal(typeof verifyConsensus,'function','independent consensus verification required');observeIndexedCheckpoint(app,body,manifest);
 const v=await verifyConsensus(body);assert.equal(v.height,body.height);assert.equal(v.blockHash,body.blockHash);assert.equal(v.appHash,body.appHash);
 // Current policy must match the candidate; a policy change during preparation
 // requires a fresh round, never a signature under an unobserved renewal.
 assert.equal(hash(app.blocks.header.authority?.renewals??[]),hash(renewals),'independent policy observation');
 return book.record(body,{renewals,linked:true});
}
export class IndexedCheckpointRepository{
 constructor(home,app,policy){this.home=resolve(home);this.app=app;this.policy=policy;this.base=join(this.home,'indexed-snapshots');fs.mkdirSync(this.base,{recursive:true});this.file=join(this.home,'indexed-checkpoint.json');this.preparedFile=join(this.home,'indexed-prepared.json');this.busy=false;this.readers=new Map();}
 get current(){return fs.existsSync(this.file)?read(this.file):null;}
 retained(){return fs.readdirSync(this.base,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^snapshot-\d+-\d+$/.test(e.name)).map(e=>join(this.base,e.name));}
 protected(directory){return this.current?.directory===directory||(this.readers.get(directory)??0)>0;}
 async compactRetained(){
  for(const directory of this.retained()){
   const file=join(directory,'state.sqlite'),manifestFile=join(directory,'manifest.json'),levelsFile=join(directory,'levels.json');
   if(this.protected(directory)||!fs.existsSync(file)||!fs.existsSync(manifestFile)||!fs.existsSync(levelsFile))continue;
   // A prepared candidate must stay readable until checkpoint installation.
   if(fs.existsSync(this.preparedFile)&&read(this.preparedFile).directory===directory)continue;
   assert(resolve(directory).startsWith(this.base+sep)&&!fs.lstatSync(directory).isSymbolicLink(),'generated snapshot directory required');assert(fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink());
   const manifest=read(manifestFile),packed=await packIndexedSnapshot(file,manifest,read(levelsFile));assert(packed.verified);
   if(this.protected(directory)||(fs.existsSync(this.preparedFile)&&read(this.preparedFile).directory===directory))continue;
   assert.equal(hash(read(manifestFile)),hash(manifest));assert(resolve(file)===join(resolve(directory),'state.sqlite'));
   // Only the redundant generated transport copy is removed, after every packed
   // chunk has passed the original signed Merkle proof. Live and source DBs stay.
   fs.unlinkSync(file);
  }
 }
 prune(){
  const effective=checkpointPolicy({renewals:this.app.blocks.header.authority?.renewals??[]},this.policy,hash(this.app.handler.config)),now=Math.floor(Date.now()/1000),grace=Math.ceil(effective.maxAge/5),age=effective.maxAge+grace;
  for(const dir of this.retained()){
   if(this.protected(dir))continue;
   const created=Number(basename(dir).split('-')[1])/1000,recordFile=join(dir,'checkpoint.json');if(now-created<=age||(fs.existsSync(recordFile)&&read(recordFile).document.body.expiresAt+grace>=now))continue;
   // Read-only SQLite access can leave WAL/SHM companions in a generated copy.
   // Expired, unleased transport copies may retire these along with the snapshot.
   if(fs.lstatSync(dir).isSymbolicLink())continue;
   const names=fs.readdirSync(dir),allowed=new Set(['state.sqlite','state.sqlite-wal','state.sqlite-shm','state.pack','manifest.json','levels.json','checkpoint.json']);
   if(names.some(n=>(!allowed.has(n)&&!/^state\.pack\.[a-f0-9-]{36}\.pending$/.test(n))||!fs.lstatSync(join(dir,n)).isFile()||fs.lstatSync(join(dir,n)).isSymbolicLink()))continue;
   assert(resolve(dir).startsWith(this.base+sep));for(const n of names)fs.unlinkSync(join(dir,n));fs.rmdirSync(dir);
  }
 }
 package(record){const dir=resolve(record.directory);assert(dir.startsWith(this.base+sep),'snapshot package outside home');const manifest=read(join(dir,'manifest.json'));assert.equal(hash(manifest),hash(record.manifest));const rawFile=join(dir,'state.sqlite');return {directory:dir,manifest,rawFile,file:fs.existsSync(rawFile)?rawFile:join(dir,'state.pack'),levels:read(join(dir,'levels.json'))};}
 async prepare(){assert(!this.busy,'snapshot preparation in progress');assert(!this.app.blocks.pending,'cannot snapshot a pending block');assert(this.app.blocks.header.height>this.app.terms.sourceHeight);this.busy=true;
  try{this.prune();assert(this.retained().length<8,'snapshot retention full; wait for older checkpoints to expire');await this.compactRetained();const directory=join(this.base,'snapshot-'+Date.now()+'-'+process.pid),p=await exportIndexedSnapshot(this.app.handler,directory);atomic(this.preparedFile,{directory,manifest:p.manifest});return {manifest:p.manifest};}finally{this.busy=false;}
 }
 install(document,manifest){
  const previous=this.current?.document??(fs.existsSync(join(this.home,'checkpoint.json'))?read(join(this.home,'checkpoint.json')):null);
  checkIndexedCheckpoint(document,manifest,this.policy,this.app.handler.config,{previous});observeIndexedCheckpoint(this.app,document.body,manifest);
  const candidate=fs.existsSync(this.preparedFile)?read(this.preparedFile):null;let directory=null;
  if(candidate&&hash(candidate.manifest)===hash(manifest)){
   const p=this.package(candidate),reader=AuthenticatedRecordStore.readOnly(p.rawFile,manifest.root);
   try{const network=queryBounded({store:reader,root:manifest.root},{type:'wallet-meta',id:null},manifest.root).result.data.network;checkPolicyState(document,network,this.app.handler.config,this.policy);}finally{reader.close();}directory=p.directory;
  }else assert.equal(hash(document.renewals??[]),hash(this.app.blocks.header.authority?.renewals??[]),'local policy changed since checkpoint');
  const record={document,manifest,directory};if(directory)atomic(join(directory,'checkpoint.json'),record);atomic(this.file,record);return {installed:document.body.sequence};
 }
 publication(){const r=this.current;if(!r)return null;checkIndexedCheckpoint(r.document,r.manifest,this.policy,this.app.handler.config);return r.document;}
 readRoot(root){
  const r=this.current;assert(r?.directory&&r.manifest.root===root,'published checkpoint root unavailable');
  this.publication();const p=this.package(r),reader=AuthenticatedRecordStore.readOnly(p.rawFile,root),close=reader.close.bind(reader);let closed=false;
  this.readers.set(p.directory,(this.readers.get(p.directory)??0)+1);reader.close=()=>{if(closed)return;close();closed=true;const count=this.readers.get(p.directory)-1;if(count)this.readers.set(p.directory,count);else this.readers.delete(p.directory);};return reader;
 }
 list(){try{const r=this.current;if(!r?.directory)return {snapshots:[]};
  // CometBFT StateProvider verifies H+1 (application root) and H+2
  // (next validator set) before accepting a snapshot at H. Advertising
  // earlier can make a joining node reject an otherwise valid snapshot.
  if(this.app.blocks.header.height<r.manifest.height+2)return {snapshots:[]};
  this.publication();this.package(r);return {snapshots:[snapshotOffer(r.document,r.manifest)]};}catch{return {snapshots:[]};}}
 load(q){let r=this.current;if(r?.manifest.height!==q.height){r=this.retained().map(dir=>join(dir,'checkpoint.json')).filter(file=>fs.existsSync(file)).map(read).find(record=>record.manifest.height===q.height);}assert(r?.directory,'snapshot not retained');checkIndexedCheckpoint(r.document,r.manifest,this.policy,this.app.handler.config);const p=this.package(r),chunk=readChunk(p.file,r.manifest,p.levels,q.index);return {chunk:Buffer.from(JSON.stringify(chunk)).toString('base64')};}
}
