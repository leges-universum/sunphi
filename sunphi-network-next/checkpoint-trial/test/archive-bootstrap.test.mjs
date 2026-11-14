import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {snapshotFixture} from './indexed-snapshot.test.mjs';
import {archiveJournalPrefix} from '../research/journal-segment.mjs';
import {archiveChunk,fetchArchiveChunk} from '../research/archive-transport.mjs';
import {ARCHIVE_SNAPSHOT_FORMAT,exportIndexedSnapshot,readChunk,IndexedSnapshotReceiver,acceptIndexedSnapshot,snapshotOffer} from '../research/indexed-snapshot.mjs';
import {openBoundedApplication} from '../research/bounded-application.mjs';
import {indexedCheckpointBody} from '../research/indexed-checkpoint.mjs';
import {attest} from '../checkpoint.mjs';
const linux={skip:process.platform!=='linux',timeout:180000};
async function source(store,{corrupt=false}={}){
 const calls=[];const server=http.createServer(async(req,res)=>{try{let text='';for await(const b of req){text+=b;assert(text.length<4096);}const message=JSON.parse(text);assert.equal(message.method,'abci_query');assert.equal(message.params.path,'/work');const q=JSON.parse(Buffer.from(message.params.data,'hex'));calls.push(q.hash);const chunk=archiveChunk(store,q);if(corrupt){const b=Buffer.from(chunk.data,'base64');b[0]^=1;chunk.data=b.toString('base64');}res.end(JSON.stringify({result:{response:{code:0,value:Buffer.from(JSON.stringify(chunk)).toString('base64')}}}));}catch{res.end(JSON.stringify({result:{response:{code:1}}}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));return {url:'http://127.0.0.1:'+server.address().port,calls,close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
async function prepared(){const f=snapshotFixture();for(let i=0;i<90;i++)f.advance();const rows=[...f.app.handler.store.journal.scan({offlineLegacy:true})],state=f.app.handler.snapshotForAudit();archiveJournalPrefix(f.app.handler.store,{through:26,rows:13});archiveJournalPrefix(f.app.handler.store,{through:26,rows:13});const p=await exportIndexedSnapshot(f.app.handler,join(f.home,'archive-package'));assert.equal(p.manifest.format,ARCHIVE_SNAPSHOT_FORMAT);assert(!fs.existsSync(p.file+'.history'),'snapshot does not copy full history objects');f.advance();const document=f.document(p.manifest);return {...f,p,rows,state,document};}
function receiver(f,name,sources){const target=join(f.home,name+'.sqlite'),metadata=acceptIndexedSnapshot({snapshot:snapshotOffer(f.document,f.p.manifest),appHash:f.p.manifest.root},null,f.policy,f.config,0),args={directory:join(f.home,name+'-incoming'),target,metadata,policy:f.policy,config:f.config,source:f.source,certificate:f.certificate,archiveSources:sources};const r=new IndexedSnapshotReceiver(args);for(let i=0;i<f.p.manifest.chunks;i++)r.receive(readChunk(f.p.file,f.p.manifest,f.p.levels,i));return {r,args,target};}
function verifyInstalled(f,target){const app=openBoundedApplication(target,f.source,f.config,f.certificate);try{assert.deepEqual(app.handler.snapshotForAudit(),f.state);assert.deepEqual([...app.handler.store.journal.scan({offlineLegacy:true})],f.rows);const height=app.blocks.header.height+1;app.blocks.finalize({height,time:1000,blockHash:f.app.blocks.header.blockHash,txs:[]});app.blocks.commit();assert.equal(app.handler.root,f.app.handler.root,'new node continues at identical root');}finally{app.close();}}
test('archive bootstrap: clean Linux installation downloads full history with corrupt-source failover and continues',linux,async()=>{
 const f=await prepared();let bad,good;try{bad=await source(f.app.handler.store,{corrupt:true});good=await source(f.app.handler.store);const {r,target}=receiver(f,'clean',[bad.url,good.url]);await r.installAsync();assert(good.calls.length>=2);assert(bad.calls.length>=2);verifyInstalled(f,target);assert.throws(()=>new IndexedSnapshotReceiver({...r,directory:f.home}),/existing state/);}finally{await bad?.close();await good?.close();f.app.close();}
});
test('archive bootstrap: interrupted new installation reuses verified objects and publishes only after complete audit',linux,async()=>{
 const f=await prepared();let first,second;try{first=await source(f.app.handler.store);second=await source(f.app.handler.store);const {r,args,target}=receiver(f,'resume',[first.url,second.url]),controller=new AbortController();await assert.rejects(()=>r.installWithArchives({signal:controller.signal,onProgress:p=>{if(p.objects===1)controller.abort(Error('simulated connection loss'));}}),/connection loss/);assert(!fs.existsSync(target));const fetched=first.calls[0];assert.equal(first.calls.filter(h=>h===fetched).length,1);const resumed=new IndexedSnapshotReceiver(args);await resumed.installAsync();assert.equal(first.calls.filter(h=>h===fetched).length,1,'verified object reused after reopen');verifyInstalled(f,target);}finally{await first?.close();await second?.close();f.app.close();}
});
test('archive bootstrap: unavailable or corrupt archives never publish a partial new node',linux,async()=>{
 const f=await prepared();let first,second;try{first=await source(f.app.handler.store,{corrupt:true});second=await source(f.app.handler.store,{corrupt:true});const {r,target}=receiver(f,'reject',[first.url,second.url]);await assert.rejects(()=>r.installAsync());assert(!fs.existsSync(target));assert.deepEqual([...f.app.handler.store.journal.scan({to:f.rows.length,offlineLegacy:true})],f.rows);}finally{await first?.close();await second?.close();f.app.close();}
});
test('archive bootstrap: independent archive with different segment boundaries restores canonical history without original publisher',linux,async()=>{
 const f=await prepared();let peer,first,second;try{
  const file=join(f.home,'independent.sqlite');fs.copyFileSync(f.p.file,file,fs.constants.COPYFILE_EXCL);const db=new DatabaseSync(file);try{db.exec('BEGIN IMMEDIATE; DROP TABLE journal_segments');const put=db.prepare('INSERT OR REPLACE INTO journal VALUES(?,?,?,?,?)');for(const r of f.rows)put.run(r.sequence,r.parent,r.root,r.body,r.digest);db.exec('COMMIT');}finally{db.close();}
  peer=openBoundedApplication(file,f.source,f.config,f.certificate);while((peer.handler.store.db.prepare('SELECT min(sequence) n FROM journal').get().n??27)<=26)archiveJournalPrefix(peer.handler.store,{through:26,rows:7});
  assert.equal([...peer.handler.store.journal.segments()].length,4);first=await source(peer.handler.store,{corrupt:true});second=await source(peer.handler.store);const {r,target}=receiver(f,'independent-restored',[first.url,second.url]);await r.installAsync();verifyInstalled(f,target);assert(second.calls.some(x=>x===undefined),'canonical row fallback used');
 }finally{await first?.close();await second?.close();peer?.close();f.app.close();}
});

test('archive bootstrap: missing reconstructed cache object resumes using publisher without stale reference',linux,async()=>{
 const f=await prepared();let first,second;try{
  first=await source(f.app.handler.store);second=await source(f.app.handler.store);
  const {r,args,target}=receiver(f,'missing-cache',[first.url,second.url]),controller=new AbortController();
  // Force canonical reconstruction during the first attempt, then lose its file
  // while retaining the reference, as can happen during a partial cache restore.
  await assert.rejects(()=>r.installWithArchives({fetchChunk:async()=>{throw Error('publisher object unavailable');},signal:controller.signal,onProgress:p=>{if(p.objects===1)controller.abort(Error('interrupted'));}}),/interrupted/);
  const directory=target+'.history',name=fs.readdirSync(directory).find(n=>n.startsWith('.reference-')),reference=join(directory,name),entry=JSON.parse(fs.readFileSync(reference));
  fs.unlinkSync(join(directory,entry.hash+'.sqlite'));assert(fs.existsSync(reference));
  const resumed=new IndexedSnapshotReceiver(args);await resumed.installWithArchives({fetchChunk:fetchArchiveChunk});
  assert(!fs.existsSync(reference),'publisher object replaces stale reconstruction reference');verifyInstalled(f,target);
 }finally{await first?.close();await second?.close();f.app.close();}
});

test('archive bootstrap: newer authenticated snapshot reuses completed archive prefix after interrupted installation',linux,async()=>{
 const f=await prepared();let first,second;try{
  first=await source(f.app.handler.store);second=await source(f.app.handler.store);const {r,args,target}=receiver(f,'newer-offer',[first.url,second.url]),controller=new AbortController();
  await assert.rejects(()=>r.installWithArchives({signal:controller.signal,onProgress:p=>{if(p.objects===1)controller.abort(Error('interrupted'));}}),/interrupted/);const fetched=first.calls[0];
  for(let n=0;n<4;n++)f.advance();const rows=[...f.app.handler.store.journal.scan()],state=f.app.handler.snapshotForAudit(),p=await exportIndexedSnapshot(f.app.handler,join(f.home,'newer-archive-package'));f.advance();
  const body=indexedCheckpointBody(f.app,p.manifest,f.policy,{previous:f.document}),document={body,signatures:f.members.slice(0,3).map(k=>attest(body,k))},resumed=new IndexedSnapshotReceiver({...args,metadata:{document,manifest:p.manifest},previous:f.document});
  for(let i=0;i<p.manifest.chunks;i++)resumed.receive(readChunk(p.file,p.manifest,p.levels,i));await resumed.installAsync();assert.equal(first.calls.filter(h=>h===fetched).length,1,'new offer keeps completed immutable objects');verifyInstalled({...f,rows,state},target);
 }finally{await first?.close();await second?.close();f.app.close();}
});

test('archive bootstrap: corrupted completed cache is retained and repaired from independent sources',linux,async()=>{
 const f=await prepared();let first,second;try{
  first=await source(f.app.handler.store);second=await source(f.app.handler.store);
  const {r,args,target}=receiver(f,'corrupt-cache',[first.url,second.url]),controller=new AbortController();
  await assert.rejects(()=>r.installWithArchives({signal:controller.signal,onProgress:p=>{if(p.objects===1)controller.abort(Error('interrupted'));}}),/interrupted/);
  const directory=target+'.history',name=fs.readdirSync(directory).find(n=>/^[a-f0-9]{64}\.sqlite$/.test(n)),file=join(directory,name),fd=fs.openSync(file,'r+');
  try{fs.writeSync(fd,Buffer.from('bad'),0,3,200);}finally{fs.closeSync(fd);}
  const damaged=fs.readFileSync(file),before=first.calls.length;const resumed=new IndexedSnapshotReceiver(args);await resumed.installAsync();
  assert(first.calls.length>before,'corrupt cache fetched again');const retained=fs.readdirSync(join(directory,'.quarantine'));assert.equal(retained.length,1);assert.deepEqual(fs.readFileSync(join(directory,'.quarantine',retained[0])),damaged);
  verifyInstalled(f,target);
 }finally{await first?.close();await second?.close();f.app.close();}
});

test('archive bootstrap: cache repair rejects symlinks and bounds retained diagnostic objects',linux,async()=>{
 const f=await prepared();let first,second;try{
  first=await source(f.app.handler.store);second=await source(f.app.handler.store);const {r,args,target}=receiver(f,'bounded-repair',[first.url,second.url]);
  for(let attempt=0;attempt<3;attempt++){
   const controller=new AbortController();await assert.rejects(()=>new IndexedSnapshotReceiver(args).installWithArchives({signal:controller.signal,onProgress:p=>{if(p.objects===1)controller.abort(Error('interrupted'));}}),/interrupted/);
   const file=join(target+'.history',fs.readdirSync(target+'.history').find(n=>/^[a-f0-9]{64}\.sqlite$/.test(n)));fs.writeFileSync(file,'damaged');
  }
  await assert.rejects(()=>r.installWithArchives(),/quarantine full/);assert(!fs.existsSync(target));assert.equal(fs.readdirSync(join(target+'.history','.quarantine')).length,2);
  const other=receiver(f,'symlink-repair',[first.url,second.url]),entry=[...f.app.handler.store.journal.segments()][0],dir=other.target+'.history';fs.mkdirSync(dir);fs.symlinkSync(f.p.file,join(dir,entry.hash+'.sqlite'));
  await assert.rejects(()=>other.r.installWithArchives(),/unsafe archive cache/);assert(!fs.existsSync(other.target));assert(fs.lstatSync(join(dir,entry.hash+'.sqlite')).isSymbolicLink());
 }finally{await first?.close();await second?.close();f.app.close();}
});

for(const point of ['archive-fsync','state-publication'])test('archive bootstrap: '+point+' failure never publishes a partial installation and retry preserves history',linux,async()=>{
 const f=await prepared();let first,second;const originalSync=fs.fsyncSync,originalLink=fs.linkSync;try{
  first=await source(f.app.handler.store);second=await source(f.app.handler.store);const {r,args,target}=receiver(f,'io-'+point,[first.url,second.url]);let failures=0;
  const fail=()=>{failures++;throw Object.assign(Error('injected installation disk failure'),{code:point==='state-publication'?'ENOSPC':'EIO'});};
  fs.fsyncSync=fd=>{if(point==='archive-fsync'&&fs.readlinkSync('/proc/self/fd/'+fd).startsWith(target+'.history/.staging/'))fail();return originalSync(fd);};
  fs.linkSync=(from,to)=>{if(point==='state-publication'&&to===target)fail();return originalLink(from,to);};
  try{await assert.rejects(()=>r.installWithArchives(),/injected installation disk failure/);}finally{fs.fsyncSync=originalSync;fs.linkSync=originalLink;}
  assert(failures>0);assert(!fs.existsSync(target),'failed installation has no active state');const calls=first.calls.length;await new IndexedSnapshotReceiver(args).installAsync();verifyInstalled(f,target);
  if(point==='state-publication')assert.equal(first.calls.length,calls,'durable archive retained across failed state publication');
 }finally{fs.fsyncSync=originalSync;fs.linkSync=originalLink;await first?.close();await second?.close();f.app.close();}
});
