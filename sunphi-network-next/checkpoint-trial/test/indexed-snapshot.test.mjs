import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setup} from './payment-liability.test.mjs';
import {keys,hash,sign,canonical} from '../crypto.mjs';
import {DatabaseSync} from 'node:sqlite';
import {envelope} from '../core.mjs';
import {CONTROL,policyFields} from '../authority.mjs';
import {CHECKPOINT,attest,verifyCheckpoint} from '../checkpoint.mjs';
import {verifyPublisherAnchor} from '../checkpoint-coordinator.mjs';
import {publisherStep} from '../checkpoint-failover.mjs';
import {AttesterBook} from '../checkpoint-operator.mjs';
import {Store} from '../store.mjs';
import {migrateBoundedArchive,verifyBoundedArchive} from '../research/bounded-archive-migration.mjs';
import {prepareBoundedRootTransition,indexedTrustAnchor} from '../research/bounded-root-transition.mjs';
import {openBoundedApplication} from '../research/bounded-application.mjs';
import {exportIndexedSnapshot,finishSnapshotExport,validateManifest,HISTORY_SNAPSHOT_FORMAT,verifyChunk,readChunk,snapshotOffer,acceptIndexedSnapshot,IndexedSnapshotReceiver} from '../research/indexed-snapshot.mjs';
import {IndexedCheckpointRepository,indexedCheckpointBody,signIndexedCheckpoint} from '../research/indexed-checkpoint.mjs';
import {packIndexedSnapshot} from '../research/indexed-snapshot-pack.mjs';
import {PACK_HEADER,PACK_ENTRY,packHeader,readPackedBytes} from '../research/snapshot-pack-codec.mjs';
import {deflateRawSync} from 'node:zlib';
import {compactJournalBatch} from '../research/journal-codec.mjs';
import {decodeJournal} from '../research/journal-codec.mjs';

export function snapshotFixture(extra=0){
 const x=setup(),members=Array.from({length:4},keys),config=structuredClone(x.c),now=Math.floor(Date.now()/1000);
 config.control.policy.members=members.map((k,i)=>({key:k.publicKey,group:hash(i)}));config.control.policy.notAfter=now+86400;
 for(let n=0;n<extra;n++)config.initial.outputs[hash(['snapshot owner',n])]={owner:x.f.alice.publicKey,value:'1',unlock:0};config.initial.supply=String(BigInt(config.initial.supply)+BigInt(extra));
 const genesis={chain_id:config.chainId,app_state:config},policy={domain:CHECKPOINT+'/POLICY',network:config.chainId,genesisHash:hash(genesis),...config.control.policy};
 const home=fs.mkdtempSync(join(tmpdir(),'duebyte-snapshot-')),old=new Store(join(home,'application.sqlite'),config);
 for(let h=1;h<=2;h++){old.finalize({height:h,time:1000,blockHash:hash(['source',h]),txs:[]});old.commit();}const source=structuredClone(old.state);old.close();
 const file=join(home,'application-indexed.sqlite'),m=migrateBoundedArchive(join(home,'application.sqlite'),file,config,hash(source)),body=prepareBoundedRootTransition(source,config,m,hash(source)),certificate={body,approvals:x.approvals(body)};m.close();const app=openBoundedApplication(file,source,config,certificate);
 const advance=()=>{const height=app.blocks.header.height+1;app.blocks.finalize({height,time:1000,blockHash:hash(['indexed',height]),txs:[]});app.blocks.commit();};advance();
 const document=(manifest,over={})=>{const body={...indexedCheckpointBody(app,manifest,policy),...over};return {body,signatures:members.slice(0,3).map(k=>attest(body,k))};};
 return {home,file,app,config,genesis,source,certificate,policy,members,advance,document};
}

test('history-bound snapshots reject rehashed archives at attesters and before receiver publication',async()=>{
 const f=snapshotFixture();try{
  const p=await exportIndexedSnapshot(f.app.handler,join(f.home,'history-bound'),{historyBound:true});assert.equal(p.manifest.format,HISTORY_SNAPSHOT_FORMAT);f.advance();const document=f.document(p.manifest);
  assert.equal(acceptIndexedSnapshot({snapshot:snapshotOffer(document,p.manifest),appHash:p.manifest.root},null,f.policy,f.config,0).manifest.journalHash,p.manifest.journalHash);
  const target=join(f.home,'verified-history.sqlite'),receiver=new IndexedSnapshotReceiver({directory:join(f.home,'verified-incoming'),target,metadata:{document,manifest:p.manifest},policy:f.policy,config:f.config,source:f.source,certificate:f.certificate});for(let i=0;i<p.manifest.chunks;i++)receiver.receive(readChunk(p.file,p.manifest,p.levels,i));await receiver.installAsync();assert(fs.existsSync(target));
  const directory=join(f.home,'rehashed');fs.mkdirSync(directory);const file=join(directory,'state.sqlite');fs.copyFileSync(p.file,file);const db=new DatabaseSync(file);try{const row=db.prepare('SELECT * FROM journal ORDER BY sequence DESC LIMIT 1').get(),body=decodeJournal(row.body);body.event.forgedAuditMarker=true;const digest=hash(body);db.exec('BEGIN IMMEDIATE');db.prepare('UPDATE journal SET body=?,digest=? WHERE sequence=?').run(canonical(body),digest,row.sequence);db.prepare('UPDATE meta SET journalHash=? WHERE id=1').run(digest);db.exec('COMMIT');}finally{db.close();}
  const bad=finishSnapshotExport({directory,root:p.manifest.root,height:p.manifest.height,configHash:p.manifest.configHash,historyBound:true});assert.notEqual(bad.manifest.journalHash,p.manifest.journalHash);
  assert.throws(()=>indexedCheckpointBody(f.app,bad.manifest,f.policy),/independent history commitment/);
  // Even a self-consistent transport re-signed by synthetic fixture keys must
  // not claim the old authenticated history head for altered archive bytes.
  const manifest={...bad.manifest,journalHash:p.manifest.journalHash},body={...document.body,snapshotHash:hash(manifest)},forged={body,signatures:f.members.slice(0,3).map(k=>attest(body,k))},destination=join(f.home,'must-not-publish.sqlite');
  const rejected=new IndexedSnapshotReceiver({directory:join(f.home,'bad-incoming'),target:destination,metadata:{document:forged,manifest},policy:f.policy,config:f.config,source:f.source,certificate:f.certificate});for(let i=0;i<manifest.chunks;i++)rejected.receive(readChunk(bad.file,manifest,bad.levels,i));await assert.rejects(()=>rejected.installAsync(),/history commitment/);assert(!fs.existsSync(destination));
  const missing={...p.manifest};delete missing.journalHash;assert.throws(()=>validateManifest(missing));assert.throws(()=>acceptIndexedSnapshot({snapshot:{...snapshotOffer(document,p.manifest),format:4},appHash:p.manifest.root},null,f.policy,f.config,0),/format binding/);
 }finally{f.app.close();}
});

test('failed publication retries reuse a candidate instead of consuming retention slots',async()=>{
 const f=snapshotFixture(),repo=new IndexedCheckpointRepository(f.home,f.app,f.policy);try{const first=await repo.prepare();for(let i=0;i<12;i++){f.advance();assert.deepEqual(await repo.prepare(),first);}assert.equal(repo.retained().length,1);const restarted=new IndexedCheckpointRepository(f.home,f.app,f.policy);assert.deepEqual(await restarted.prepare(),first);const document=f.document(first.manifest);restarted.install(document,first.manifest);assert.equal(restarted.publication().body.appHash,first.manifest.root);}finally{f.app.close();}
});
test('adopting a foreign checkpoint retains locally signed service and survives restart',async()=>{
 const f=snapshotFixture(),repo=new IndexedCheckpointRepository(f.home,f.app,f.policy);try{
  const own=await repo.prepare();f.advance();const previous=f.document(own.manifest);repo.install(previous,own.manifest);f.advance();
  const foreign=await exportIndexedSnapshot(f.app.handler,join(f.home,'foreign-package'));f.advance();const body=indexedCheckpointBody(f.app,foreign.manifest,f.policy,{previous}),document={body,signatures:f.members.slice(0,3).map(k=>attest(body,k))};repo.install(document,foreign.manifest);
  assert.equal(repo.current.directory,null);assert.deepEqual(repo.publication(),previous);await repo.compactRetained();
  const restarted=new IndexedCheckpointRepository(f.home,f.app,f.policy);assert.deepEqual(restarted.publication(),previous);assert.equal(restarted.list().snapshots[0].height,own.manifest.height);const reader=restarted.readRoot(own.manifest.root);try{assert.equal(reader.proof('meta/blockHead',own.manifest.root).value.height,own.manifest.height);}finally{reader.close();}
 }finally{f.app.close();}
});
test('compressed journal snapshot restores full history and continues with the same state root',async()=>{
 const f=snapshotFixture();try{
  f.app.handler.store.compressJournal=true;for(let i=0;i<12;i++)f.advance();compactJournalBatch(f.app.handler.store.db);
  const state=f.app.handler.snapshotForAudit(),p=await exportIndexedSnapshot(f.app.handler,join(f.home,'compressed-package'));f.advance();const document=f.document(p.manifest),target=join(f.home,'compressed-restored.sqlite'),receiver=new IndexedSnapshotReceiver({directory:join(f.home,'compressed-incoming'),target,metadata:{document,manifest:p.manifest},policy:f.policy,config:f.config,source:f.source,certificate:f.certificate});
  for(let i=0;i<p.manifest.chunks;i++)receiver.receive(readChunk(p.file,p.manifest,p.levels,i));await receiver.installAsync();const restored=openBoundedApplication(target,f.source,f.config,f.certificate);try{assert.deepEqual(restored.handler.snapshotForAudit(),state);assert.equal(restored.handler.root,p.manifest.root);const height=restored.blocks.header.height+1;restored.blocks.finalize({height,time:1000,blockHash:hash(['indexed',height]),txs:[]});restored.blocks.commit();assert.equal(restored.handler.root,f.app.handler.root);}finally{restored.close();}
 }finally{f.app.close();}
});

test('long multilingual paths support snapshot export, worker restore and later commits',async()=>{
 const f=snapshotFixture(),base=fs.mkdtempSync(join(tmpdir(),'duebyte-long-path-'));
 // Exercise Windows extended-length paths without language-specific source text.
 const segment='project-\u4e2d\u6587-\u0627\u0644\u0639\u0631\u0628\u064a\u0629-\u0422\u0435\u0441\u0442-';
 // Stay below SQLite's Unix VFS byte-path limit while crossing Windows MAX_PATH.
 const directory=join(base,segment,...Array.from({length:6},(_,i)=>'branch-'+i+'-'+'x'.repeat(36)));
 fs.mkdirSync(directory,{recursive:true});assert(directory.length>300);
 try{
  const expected=f.app.handler.snapshotForAudit(),p=await exportIndexedSnapshot(f.app.handler,join(directory,'export'));
  f.advance();const document=f.document(p.manifest),target=join(directory,'restored.sqlite');
  const receiver=new IndexedSnapshotReceiver({directory:join(directory,'incoming'),target,metadata:{document,manifest:p.manifest},policy:f.policy,config:f.config,source:f.source,certificate:f.certificate});
  for(let i=0;i<p.manifest.chunks;i++)receiver.receive(readChunk(p.file,p.manifest,p.levels,i));
  await receiver.installAsync();const restored=openBoundedApplication(target,f.source,f.config,f.certificate);
  try{
   assert.deepEqual(restored.handler.snapshotForAudit(),expected);assert.equal(verifyBoundedArchive(restored.handler).count,3);
   restored.blocks.finalize({height:restored.blocks.header.height+1,time:1000,blockHash:hash('long-path-next'),txs:[]});restored.blocks.commit();
   const next=await exportIndexedSnapshot(restored.handler,join(directory,'export-after-commit'));assert.notEqual(next.manifest.root,p.manifest.root);
  }finally{restored.close();}
 }finally{f.app.close();}
});

test('multi-chunk snapshot pins state during commits and resumes with exact root, history and balances',async()=>{
 const f=snapshotFixture(1800),targetHome=fs.mkdtempSync(join(tmpdir(),'duebyte-import-')),target=join(targetHome,'installed.sqlite'),before=f.app.handler.snapshotForAudit(),root=f.app.handler.root;
 try{
  const pending=exportIndexedSnapshot(f.app.handler,join(f.home,'package'));f.advance();const p=await pending;assert.equal(p.manifest.root,root);assert(p.manifest.chunks>1);
  const document=f.document(p.manifest),sn=snapshotOffer(document,p.manifest),metadata=acceptIndexedSnapshot({snapshot:sn,appHash:root},null,f.policy,f.config,0),args={directory:join(targetHome,'incoming'),target,metadata,policy:f.policy,config:f.config,source:f.source,certificate:f.certificate};
  let receiver=new IndexedSnapshotReceiver(args);receiver.receive(readChunk(p.file,p.manifest,p.levels,0));assert(!fs.existsSync(target));assert.throws(()=>receiver.install(),/incomplete/);
  receiver=new IndexedSnapshotReceiver(args);receiver.receive(readChunk(p.file,p.manifest,p.levels,0));
  for(let i=p.manifest.chunks-1;i>0;i--)receiver.receive(readChunk(p.file,p.manifest,p.levels,i));assert(receiver.complete());
  assert.throws(()=>receiver.install({beforePublish:()=>{throw Error('power loss');}}),/power loss/);assert(!fs.existsSync(target));assert(!fs.readdirSync(receiver.directory).some(n=>n.startsWith('assembled-')));receiver.install();
  const restored=openBoundedApplication(target,f.source,f.config,f.certificate);try{assert.equal(restored.handler.root,root);assert.deepEqual(restored.handler.snapshotForAudit(),before);assert.equal(verifyBoundedArchive(restored.handler).count,3);}finally{restored.close();}
  assert.throws(()=>receiver.install(),/existing state/);assert.throws(()=>new IndexedSnapshotReceiver(args),/existing state/);
 }finally{f.app.close();}
});

test('tampered chunks, wrong index, minority, stale checkpoint, wrong light root and existing state fail closed',async()=>{
 const f=snapshotFixture();try{
  const p=await exportIndexedSnapshot(f.app.handler,join(f.home,'package'));f.advance();const d=f.document(p.manifest),sn=snapshotOffer(d,p.manifest),offer={snapshot:sn,appHash:p.manifest.root};
  assert.throws(()=>acceptIndexedSnapshot(offer,null,f.policy,f.config,1),/existing state/);
  assert.throws(()=>acceptIndexedSnapshot({...offer,appHash:hash('wrong')},null,f.policy,f.config,0),/light-client/);
  const minority=structuredClone(d);minority.signatures.pop();assert.throws(()=>acceptIndexedSnapshot({snapshot:snapshotOffer(minority,p.manifest),appHash:p.manifest.root},null,f.policy,f.config,0),/quorum/);
  const now=Math.floor(Date.now()/1000),expired=f.document(p.manifest,{issuedAt:now-10,expiresAt:now-1});assert.throws(()=>acceptIndexedSnapshot({snapshot:snapshotOffer(expired,p.manifest),appHash:p.manifest.root},null,f.policy,f.config,0),/expired/);
  const c=readChunk(p.file,p.manifest,p.levels,0),bad=structuredClone(c),bytes=Buffer.from(bad.data,'base64');bytes[100]^=1;bad.data=bytes.toString('base64');assert.throws(()=>verifyChunk(p.manifest,bad),/proof|edge/);assert.throws(()=>verifyChunk(p.manifest,{...c,index:p.manifest.chunks}));
  assert.equal(indexedTrustAnchor(d,f.certificate.body,[expired],f.policy,f.config),null);assert.throws(()=>indexedTrustAnchor(expired,f.certificate.body,[],f.policy,f.config),/expired/);
 }finally{f.app.close();}
});

test('checkpoint publication requires own committed ancestry and persistent independent signer observations',async()=>{
 const f=snapshotFixture(),repo=new IndexedCheckpointRepository(f.home,f.app,f.policy);try{
  const {manifest}=await repo.prepare();assert.throws(()=>indexedCheckpointBody(f.app,manifest,f.policy),/committed height/);f.advance();const document=f.document(manifest);
  const book=new AttesterBook(join(f.home,'attester.sqlite'),f.policy,f.members[0]);try{
   await assert.rejects(()=>signIndexedCheckpoint({app:f.app,book,body:document.body,manifest,verifyConsensus:async()=>({height:document.body.height,blockHash:document.body.blockHash,appHash:hash('wrong')})}));
   const verified=async b=>({height:b.height,blockHash:b.blockHash,appHash:b.appHash});const signed=await signIndexedCheckpoint({app:f.app,book,body:document.body,manifest,verifyConsensus:verified});assert.deepEqual(signed,document.signatures[0]);
   await assert.rejects(()=>signIndexedCheckpoint({app:f.app,book,body:{...document.body,expiresAt:document.body.expiresAt-1},manifest,verifyConsensus:verified}),/equivocation/);
  }finally{book.close();}
  repo.install(document,manifest);assert.equal(repo.list().snapshots.length,0);f.advance();assert.equal(repo.list().snapshots.length,1);const restarted=new IndexedCheckpointRepository(f.home,f.app,f.policy);assert.deepEqual(restarted.publication(),document);assert(restarted.load({height:manifest.height,index:0}).chunk);
  assert.throws(()=>repo.install(f.document(manifest,{blockHash:hash('fork')}),manifest));
 }finally{f.app.close();}
});

test('even signed transport cannot introduce extra SQLite schema into an authenticated root',async()=>{
 const f=snapshotFixture();try{
  f.app.handler.store.db.exec('CREATE TABLE rogue(value TEXT)');const p=await exportIndexedSnapshot(f.app.handler,join(f.home,'package'));f.advance();const document=f.document(p.manifest),receiver=new IndexedSnapshotReceiver({directory:join(f.home,'incoming'),target:join(f.home,'must-not-exist.sqlite'),metadata:{document,manifest:p.manifest},policy:f.policy,config:f.config,source:f.source,certificate:f.certificate});
  for(let i=0;i<p.manifest.chunks;i++)receiver.receive(readChunk(p.file,p.manifest,p.levels,i));assert.throws(()=>receiver.install());assert(!fs.existsSync(receiver.target));
 }finally{f.app.close();}
});

test('new checkpoint retains in-flight snapshot and bounded retention refuses unbounded copies',async()=>{
 const f=snapshotFixture(),repo=new IndexedCheckpointRepository(f.home,f.app,f.policy);try{
  const first=await repo.prepare();f.advance();const previous=f.document(first.manifest);repo.install(previous,first.manifest);const oldChunk=repo.load({height:first.manifest.height,index:0});
  const next=await repo.prepare();f.advance();const body=indexedCheckpointBody(f.app,next.manifest,f.policy,{previous}),document={body,signatures:f.members.slice(0,3).map(k=>attest(body,k))};repo.install(document,next.manifest);
  assert.equal(repo.list().snapshots.length,0);f.advance();assert.equal(repo.list().snapshots[0].height,next.manifest.height);assert.deepEqual(repo.load({height:first.manifest.height,index:0}),oldChunk);
  const restarted=new IndexedCheckpointRepository(f.home,f.app,f.policy);assert.deepEqual(restarted.load({height:first.manifest.height,index:0}),oldChunk);
  let latest=document;for(let i=repo.retained().length;i<8;i++){f.advance();const p=await repo.prepare();f.advance();const body=indexedCheckpointBody(f.app,p.manifest,f.policy,{previous:latest});latest={body,signatures:f.members.slice(0,3).map(k=>attest(body,k))};repo.install(latest,p.manifest);}await assert.rejects(()=>repo.prepare(),/retention full/);assert.equal(repo.retained().length,8);
  // Only expired generated transport copies are removable; source archives stay.
  const expired=join(repo.base,'snapshot-1-123');fs.mkdirSync(expired);for(const name of ['state.sqlite','state.sqlite-wal','state.sqlite-shm'])fs.writeFileSync(join(expired,name),'old copy');fs.writeFileSync(join(expired,'state.pack.01234567-0123-0123-0123-012345678901.pending'),'interrupted packing');repo.readers.set(expired,1);repo.prune();assert(fs.existsSync(expired),'active lease retains SQLite companions');repo.readers.delete(expired);repo.prune();assert(!fs.existsSync(expired));assert(fs.existsSync(join(f.home,'application.sqlite')));assert.deepEqual(repo.load({height:first.manifest.height,index:0}),oldChunk);
 }finally{f.app.close();}
});

test('expired publisher anchor can request a fresh quorum without accepting stale client data',async()=>{
 const f=snapshotFixture(),originalFetch=globalThis.fetch;
 try{
  const p=await exportIndexedSnapshot(f.app.handler,join(f.home,'expiry-package'));f.advance();const now=Math.floor(Date.now()/1000),document=f.document(p.manifest,{issuedAt:now-120,expiresAt:now-60});
  assert.throws(()=>verifyCheckpoint(document,f.policy),/expired/);
  verifyPublisherAnchor(document,f.policy);
  const tampered=structuredClone(document);tampered.body.appHash=hash('tamper');assert.throws(()=>verifyPublisherAnchor(tampered,f.policy),/signature/);
  const minority=structuredClone(document);minority.signatures.pop();assert.throws(()=>verifyPublisherAnchor(minority,f.policy),/quorum/);
  const future=f.document(p.manifest,{issuedAt:now+120,expiresAt:now+180});assert.throws(()=>verifyPublisherAnchor(future,f.policy),/future/);
  for(const [name,data] of Object.entries({'trust-policy.json':f.policy,'app-config.json':f.config,'checkpoint.json':document,'indexed-checkpoint-operator.json':{applicationUrl:'http://127.0.0.1:1',applicationHome:f.home}}))fs.writeFileSync(join(f.home,name),JSON.stringify(data));
  globalThis.fetch=async()=>new Response(JSON.stringify({record:{document}}));
  for(const role of ['primary','standby']){
   let calls=0;const result=await publisherStep({profile:f.home,settings:{rpc:'http://127.0.0.1:1'},client:{},role,publish:async()=>{calls++;return {height:document.body.height+1};}});
   assert(result.published);assert.equal(calls,1);
  }
  assert.throws(()=>acceptIndexedSnapshot({snapshot:snapshotOffer(document,p.manifest),appHash:p.manifest.root},null,f.policy,f.config,0),/expired/);
 }finally{globalThis.fetch=originalFetch;f.app.close();}
});

test('snapshot retention uses the committed renewed lifetime while retaining unexpired published transfers',async()=>{
 const f=snapshotFixture(),repo=new IndexedCheckpointRepository(f.home,f.app,f.policy);try{
  const p=await repo.prepare();f.advance();const document=f.document(p.manifest);repo.install(document,p.manifest);
  const fields=policyFields(f.policy),next={...fields,version:2,maxAge:120,notAfter:fields.notAfter+86400},body={domain:CONTROL+'/POLICY',network:f.config.chainId,configHash:hash(f.config),previous:hash(fields),next,notBefore:900,expires:fields.notAfter-1};
  const signatures=f.members.slice(0,3).map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)})),certificate={body,oldSignatures:signatures,newSignatures:signatures};
  f.app.blocks.finalize({height:f.app.blocks.header.height+1,time:1001,blockHash:hash('renew-retention'),txs:[Buffer.from(JSON.stringify(envelope(f.config,{type:'RENEW_POLICY',certificate},f.members[0])))]});f.app.blocks.commit();
  const unpublished=join(repo.base,'snapshot-'+(Date.now()-300000)+'-123');fs.mkdirSync(unpublished);fs.writeFileSync(join(unpublished,'state.sqlite'),'unpublished expired transport');
  repo.prune();assert(!fs.existsSync(unpublished));assert(repo.load({height:p.manifest.height,index:0}).chunk,'unexpired old-policy transfer is retained');assert(fs.existsSync(join(f.home,'application.sqlite')));
 }finally{f.app.close();}
});

test('standby renews its own availability even when a foreign publisher keeps the adopted checkpoint fresh',async()=>{
 const f=snapshotFixture(),originalFetch=globalThis.fetch;try{
  const p=await exportIndexedSnapshot(f.app.handler,join(f.home,'availability-package'));f.advance();const document=f.document(p.manifest),now=Date.now();
  for(const [name,data]of Object.entries({'trust-policy.json':f.policy,'app-config.json':f.config,'checkpoint.json':document,'indexed-checkpoint-operator.json':{applicationUrl:'http://127.0.0.1:1',applicationHome:f.home}}))fs.writeFileSync(join(f.home,name),JSON.stringify(data));
  let served=null,calls=0;globalThis.fetch=async()=>new Response(JSON.stringify({record:{document},served}));const args={profile:f.home,settings:{rpc:'http://127.0.0.1:1'},client:{},role:'standby',now,publish:async()=>{calls++;return {height:document.body.height};}};
  assert.equal((await publisherStep({...args,startedAt:now})).published,false);
  assert.equal((await publisherStep({...args,startedAt:now-24*3600000})).published,true);assert.equal(calls,1);
  served=document;assert.equal((await publisherStep({...args,startedAt:now-24*3600000})).published,false);
  served=structuredClone(document);served.signatures.pop();await assert.rejects(()=>publisherStep({...args,startedAt:now-24*3600000}),/quorum/);
 }finally{globalThis.fetch=originalFetch;f.app.close();}
});

test('sixteen simulated hours of checkpoint rotation stay bounded across repository restarts',async()=>{
 const f=snapshotFixture(),realNow=Date.now;let clock=realNow(),repo=new IndexedCheckpointRepository(f.home,f.app,f.policy),previous=null,prunes=0,lastCount=0;
 try{
  Date.now=()=>clock;
  for(let cycle=0;cycle<80;cycle++){
   f.advance();const p=await repo.prepare();f.advance();
   const body=indexedCheckpointBody(f.app,p.manifest,f.policy,{previous}),document={body,signatures:f.members.slice(0,3).map(k=>attest(body,k))};repo.install(document,p.manifest);
   // The same read-only access that left WAL/SHM files in production.
   const reader=repo.readRoot(p.manifest.root);reader.close();
   assert.equal(repo.list().snapshots.length,0);f.advance();assert.equal(repo.list().snapshots[0].height,p.manifest.height);
   assert(repo.load({height:p.manifest.height,index:0}).chunk);
   const count=repo.retained().length;assert(count<=8);if(cycle>7&&count<=lastCount)prunes++;
   previous=document;lastCount=count;
   if(cycle%7===0)repo=new IndexedCheckpointRepository(f.home,f.app,f.policy);
   clock+=Math.ceil(f.policy.maxAge*1000/5)+15000;
  }
  assert(prunes>60,'old copies must retire repeatedly, not just once');
  assert(fs.existsSync(f.file));assert.equal(f.app.handler.snapshotForAudit().money.supply,f.config.initial.supply);
 }finally{Date.now=realNow;f.app.close();}
});

test('packed retained snapshots preserve reader leases and restore through the unchanged signed transport',async()=>{
 const f=snapshotFixture(1800),repo=new IndexedCheckpointRepository(f.home,f.app,f.policy);let reader;
 try{
  const state=f.app.handler.snapshotForAudit(),first=await repo.prepare();f.advance();const document=f.document(first.manifest);repo.install(document,first.manifest);
  const record=repo.current,raw=repo.package(record).rawFile,original=repo.load({height:first.manifest.height,index:0});reader=repo.readRoot(first.manifest.root);
  const next=await repo.prepare();f.advance();const body=indexedCheckpointBody(f.app,next.manifest,f.policy,{previous:document});repo.install({body,signatures:f.members.slice(0,3).map(k=>attest(body,k))},next.manifest);
  await repo.compactRetained();assert(fs.existsSync(raw),'active reader protects raw snapshot');assert.equal(reader.proof('meta/blockHead',first.manifest.root).value.height,first.manifest.height);
  reader.close();reader=null;await repo.compactRetained();assert(!fs.existsSync(raw));assert(repo.package(record).file.endsWith('.pack'));assert.deepEqual(repo.load({height:first.manifest.height,index:0}),original);
  const restarted=new IndexedCheckpointRepository(f.home,f.app,f.policy),target=join(f.home,'packed-restored.sqlite'),receiver=new IndexedSnapshotReceiver({directory:join(f.home,'packed-incoming'),target,metadata:{document,manifest:first.manifest},policy:f.policy,config:f.config,source:f.source,certificate:f.certificate});
  for(let index=first.manifest.chunks-1;index>=0;index--)receiver.receive(JSON.parse(Buffer.from(restarted.load({height:first.manifest.height,index}).chunk,'base64')));
  await receiver.installAsync();const restored=openBoundedApplication(target,f.source,f.config,f.certificate);try{assert.deepEqual(restored.handler.snapshotForAudit(),state);assert.equal(verifyBoundedArchive(restored.handler).count,3);}finally{restored.close();}
  const current=repo.package(repo.current);assert(fs.existsSync(current.rawFile),'current checkpoint serves proofs without decompression');
 }finally{reader?.close();f.app.close();}
});

test('corrupted completed pack cannot replace the original; a completed pack resumes after interruption',async()=>{
 const f=snapshotFixture(),repo=new IndexedCheckpointRepository(f.home,f.app,f.policy);try{
  const first=await repo.prepare();f.advance();const document=f.document(first.manifest);repo.install(document,first.manifest);const record=repo.current,p=repo.package(record);
  const packed=await packIndexedSnapshot(p.rawFile,p.manifest,p.levels);assert(fs.existsSync(p.rawFile));assert.deepEqual(await packIndexedSnapshot(p.rawFile,p.manifest,p.levels),packed);
  const bytes=fs.readFileSync(packed.file);bytes[bytes.length-1]^=255;fs.writeFileSync(packed.file,bytes);
  const next=await repo.prepare();f.advance();const body=indexedCheckpointBody(f.app,next.manifest,f.policy,{previous:document});repo.install({body,signatures:f.members.slice(0,3).map(k=>attest(body,k))},next.manifest);
  await assert.rejects(()=>repo.compactRetained());assert(fs.existsSync(p.rawFile),'no deletion on failed verification');assert(fs.existsSync(f.file));
 }finally{f.app.close();}
});

test('packed decoding bounds expansion and rejects altered manifest, truncation and offsets',async()=>{
 const f=snapshotFixture();try{
  const p=await exportIndexedSnapshot(f.app.handler,join(f.home,'package')),packed=await packIndexedSnapshot(p.file,p.manifest,p.levels),original=fs.readFileSync(packed.file);
  assert.throws(()=>readPackedBytes(packed.file,{...p.manifest,root:hash('wrong')},0),/manifest mismatch/);
  fs.writeFileSync(packed.file,original.subarray(0,PACK_HEADER+1));assert.throws(()=>readPackedBytes(packed.file,p.manifest,0),/truncated/);
  const wrong=Buffer.from(original);wrong.writeBigUInt64LE(0n,PACK_HEADER);fs.writeFileSync(packed.file,wrong);assert.throws(()=>readPackedBytes(packed.file,p.manifest,0),/offset/);
  const compressed=deflateRawSync(Buffer.alloc(p.manifest.chunkSize*2)),header=packHeader(p.manifest),table=Buffer.alloc(p.manifest.chunks*PACK_ENTRY);table.writeBigUInt64LE(BigInt(header.length+table.length));table.writeUInt32LE(compressed.length,8);fs.writeFileSync(packed.file,Buffer.concat([header,table,compressed]));assert.throws(()=>readPackedBytes(packed.file,p.manifest,0),/larger|length|size/i);
  assert(fs.existsSync(p.file));
 }finally{f.app.close();}
});
