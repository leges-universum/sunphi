import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {acquireStateAccess} from '../state-access.mjs';
import {hash,keys,sign} from '../crypto.mjs';
import {CHECKPOINT} from '../checkpoint.mjs';
import {cleanConfig,createFreshChain} from '../research/fresh-chain-preparation.mjs';
import {openFreshApplication} from '../research/fresh-application.mjs';
import {archiveJournalPrefix,segmentPath} from '../research/journal-segment.mjs';
import {ArchiveAuditSession} from '../research/archive-audit-session.mjs';
import {verifyRetainedJournal} from '../research/journal-startup.mjs';
import {preflightArchive} from '../research/archive-preflight.mjs';
import {bootstrapRecoveryAnchor} from '../research/bootstrap-recovery.mjs';
import {ArchivePreparationSession} from '../research/archive-preflight-task.mjs';
import {archiveChunk,ARCHIVE_READ,ARCHIVE_ROW} from '../research/archive-transport.mjs';
import {archiveSnapshotQuery,ARCHIVE_SNAPSHOTS,ARCHIVE_SNAPSHOT_CHUNK} from '../research/archive-snapshot-route.mjs';
import {IndexedCheckpointRepository,indexedCheckpointBody} from '../research/indexed-checkpoint.mjs';
import {IndexedSnapshotReceiver,readChunk} from '../research/indexed-snapshot.mjs';
const linux={skip:process.platform!=='linux',timeout:180000};
async function fixture(t){
 const directory=fs.mkdtempSync(join(tmpdir(),'duebyte-preflight-')),members=Array.from({length:4},keys),validators=Array.from({length:10},keys),now=Math.floor(Date.now()/1000);
 const config=cleanConfig({chainId:'duebyte-trial-preflight-'+now,previousChainId:'isolated',time:now-100,control:{validators:validators.map(k=>({key:k.publicKey,group:hash(k.publicKey)})),policy:{version:1,members:members.map(k=>({key:k.publicKey,group:hash(k.publicKey)})),threshold:3,maxAge:3600,notAfter:now+86400}}});
 const file=join(directory,'source.sqlite'),created=createFreshChain(file,config),fresh={manifest:created.manifest,manifestHash:hash(created.manifest)};created.handler.close();const app=openFreshApplication(file,config,fresh);
 const advance=()=>{const height=app.blocks.header.height+1;app.blocks.finalize({height,time:now-100+height,blockHash:hash(['block',height]),txs:[]});app.blocks.commit();};for(let i=0;i<90;i++)advance();
 archiveJournalPrefix(app.handler.store,{through:26,rows:13});archiveJournalPrefix(app.handler.store,{through:26,rows:13});
 const policy={domain:CHECKPOINT+'/POLICY',network:config.chainId,genesisHash:hash('isolated-genesis'),...config.control.policy},repo=new IndexedCheckpointRepository(directory,app,policy);let document;
 async function publish(expires){const {manifest}=await repo.prepare();advance();advance();const body=indexedCheckpointBody(app,manifest,policy,{previous:document});if(expires)body.expiresAt=expires;document={body,signatures:members.slice(0,3).map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)}))};repo.install(document,manifest);return {document,manifest};}
 await publish();const servers=[];let archiveReads=0,beforeArchive=async()=>{};
 for(let n=0;n<2;n++){const server=createServer(async(req,res)=>{try{let body='';for await(const b of req){body+=b;assert(body.length<4096);}const params=JSON.parse(body).params,q=params.path==='/checkpoint'?null:JSON.parse(Buffer.from(params.data,'hex'));let value;if(!q)value=document;else if([ARCHIVE_READ,ARCHIVE_ROW].includes(q.operation)){archiveReads++;await beforeArchive(q);value=archiveChunk(app.handler.store,q);}else value=archiveSnapshotQuery(repo,q);res.end(JSON.stringify({result:{response:{code:0,value:Buffer.from(JSON.stringify(value)).toString('base64')}}}));}catch{res.end(JSON.stringify({result:{response:{code:1}}}));}});await new Promise(r=>server.listen(0,'127.0.0.1',r));servers.push(server);}
 const home=join(directory,'new-node');fs.mkdirSync(home);fs.mkdirSync(join(home,'config'));fs.writeFileSync(join(home,'run-settings.json'),JSON.stringify({isValidator:false}));fs.writeFileSync(join(home,'checkpoint.json'),JSON.stringify(document));fs.writeFileSync(join(home,'config/config.toml'),'[statesync]\ntrust_height = '+document.body.height+'\ntrust_hash = "'+document.body.blockHash+'"\n');
 const profile={config,policy,fresh,rpcServers:servers.map(s=>'http://127.0.0.1:'+s.address().port)};
 t.after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}app.close();fs.rmSync(directory,{recursive:true,force:true});});
 return {directory,file,home,app,profile,repo,publish,advance,fresh,config,holdArchive:fn=>beforeArchive=fn,get document(){return document;},get reads(){return archiveReads;}};
}
test('archive preflight: session cache authenticates every row and rejects forged or changed validation data',linux,async t=>{
 const f=await fixture(t),events=[],cache=new ArchiveAuditSession(f.file,{genesisRoot:f.fresh.manifest.root},{directory:f.directory,onProgress:p=>events.push(p)}),entries=[...f.app.handler.store.journal.segments()];
 try{for(const e of entries)cache.verify(e);assert.equal(events.filter(p=>!p.reused).length,26);events.length=0;
  verifyRetainedJournal(f.app.handler,{genesisRoot:f.fresh.manifest.root},{full:true,archiveAudit:cache});assert.equal(events.filter(p=>!p.reused).length,0);assert.equal(events.filter(p=>p.reused).length,2);
  cache.db.prepare('UPDATE verified SET mac=?').run('0'.repeat(64));events.length=0;cache.verify(entries[0]);assert.equal(events.filter(p=>!p.reused).length,13,'serialized verification row is not authority');
  assert.throws(()=>verifyRetainedJournal(f.app.handler,{genesisRoot:f.fresh.manifest.root},{full:true,archiveAudit:{verify(){}}}),/live archive/);
  const file=segmentPath(f.file,entries[0]),bytes=fs.readFileSync(file);fs.writeFileSync(file,Buffer.alloc(bytes.length));assert.throws(()=>cache.verify(entries[0]),/checksum/);fs.writeFileSync(file,bytes);
  assert.throws(()=>cache.verify(entries[0],{genesisRoot:hash('wrong authority')}),/authority differs/);
 }finally{cache.close();}
});

test('archive preflight: published-state recovery requires a fresh independent anchor and the exact installed root',linux,async t=>{
 const f=await fixture(t),expired=await f.publish(Math.floor(Date.now()/1000)+2),pending={height:expired.manifest.height,root:expired.manifest.root};
 const options={pending,header:{height:pending.height},root:pending.root,config:f.config,policy:f.profile.policy,previous:expired.document,sources:f.profile.rpcServers};
 await new Promise(r=>setTimeout(r,Math.max(1,expired.document.body.expiresAt*1000-Date.now()+50)));
 await assert.rejects(()=>bootstrapRecoveryAnchor(options));await f.publish();const anchor=await bootstrapRecoveryAnchor(options);assert.equal(anchor.height,pending.height);assert.equal(anchor.hash,Buffer.from(pending.root,'hex').toString('base64'));assert.equal(anchor.anchorHeight,f.document.body.height);
 await assert.rejects(()=>bootstrapRecoveryAnchor({...options,root:hash('changed installed root')}));assert(!fs.existsSync(join(f.home,'application-indexed.sqlite')),'anchor verification cannot publish or replace application state');
});
test('archive preflight: expiry during preparation gets a fresh successor without publishing partial state',linux,async t=>{
 const f=await fixture(t);await f.publish(Math.floor(Date.now()/1000)+2);let replaced=false;
 const result=await preflightArchive(f.home,f.profile,{afterPrepared:async metadata=>{if(replaced)return;replaced=true;assert(!fs.existsSync(join(f.home,'application-indexed.sqlite')));await new Promise(r=>setTimeout(r,Math.max(1,metadata.document.body.expiresAt*1000-Date.now()+50)));await f.publish();}});
 assert(result.prepared&&replaced);assert.equal(result.height,f.document.body.appHeight);assert(!fs.existsSync(join(f.home,'application-indexed.sqlite')));assert(!fs.existsSync(join(f.home,'indexed-bootstrap-pending.json')));assert.equal(JSON.parse(fs.readFileSync(join(f.home,'checkpoint.json'))).body.sequence,f.document.body.sequence);assert.equal(f.reads,2,'immutable prefix survives fresh checkpoint replacement');
});
test('archive preflight: same worker carries validated prefix into full fresh installation and shuts down',linux,async t=>{
 const f=await fixture(t),session=new ArchivePreparationSession(f.home,f.profile),target=join(f.home,'application-indexed.sqlite');
 try{assert((await session.prepare()).prepared);assert(!fs.existsSync(target));const record=f.repo.current,p=f.repo.package(record),receiver=new IndexedSnapshotReceiver({directory:join(f.home,'indexed-incoming'),target,metadata:{document:record.document,manifest:record.manifest},policy:f.profile.policy,config:f.config,fresh:f.fresh,previous:record.document,archiveSources:f.profile.rpcServers});
  for(let i=0;i<p.manifest.chunks;i++)receiver.receive(readChunk(p.file,p.manifest,p.levels,i));const installed=await session.install(receiver);assert.equal(installed.root,p.manifest.root);assert.equal(f.reads,2);const app=openFreshApplication(target,f.config,f.fresh,{auditJournal:true});try{assert.equal(app.blocks.header.height,p.manifest.height);assert.equal([...app.handler.store.journal.scan()].length,p.manifest.height);}finally{app.close();}
 }finally{await session.close();assert.equal(session.state,'closed');}
});

test('archive preflight: interrupted preparation retains objects but revalidates them in a new session',linux,async t=>{
 const f=await fixture(t),abort=new AbortController(),target=join(f.home,'application-indexed.sqlite');
 await assert.rejects(()=>preflightArchive(f.home,f.profile,{signal:abort.signal,onProgress:p=>{if(p.objects===1)abort.abort(Error('interrupted preparation'));}}),/interrupted preparation/);
 assert(!fs.existsSync(target));assert.equal(f.reads,1);let rechecked=0;
 const prepared=await preflightArchive(f.home,f.profile,{onProgress:p=>{if(p.verifiedThrough&&!p.reused)rechecked++;}});
 assert(prepared.prepared);assert.equal(f.reads,2,'previously downloaded object was not downloaded again');assert.equal(rechecked,26,'new process/session performs complete validation again');assert(!fs.existsSync(target));
});

test('archive preflight: stalled worker exits before failure returns and a new worker resumes safely',linux,async t=>{
 const f=await fixture(t);let release;const blocked=new Promise(r=>release=r);f.holdArchive(()=>blocked);
 const session=new ArchivePreparationSession(f.home,f.profile,{idleTimeoutMs:1500});
 try{await assert.rejects(()=>session.prepare(),/stopped making progress/);assert.equal(session.state,'closed');assert.equal(session.pending,null);assert(!fs.existsSync(join(f.home,'application-indexed.sqlite')));}
 finally{release();await session.close();}
 f.holdArchive(async()=>{});const resumed=new ArchivePreparationSession(f.home,f.profile);
 try{assert((await resumed.prepare()).prepared);assert(!fs.existsSync(join(f.home,'application-indexed.sqlite')));}
 finally{await resumed.close();}
});

test('archive preflight: SIGKILL retains downloaded prefix but a replacement process revalidates it',linux,async t=>{
 const f=await fixture(t),entries=[...f.app.handler.store.journal.segments()];let release,arrived;const blocked=new Promise(r=>release=r),waiting=new Promise(r=>arrived=r);f.holdArchive(async q=>{if(q.hash===entries[1].hash){arrived();await blocked;}});
 const code=`import {ArchivePreparationSession} from ${JSON.stringify(new URL('../research/archive-preflight-task.mjs',import.meta.url).href)};import {acquireStateAccess} from ${JSON.stringify(new URL('../state-access.mjs',import.meta.url).href)};const unlock=acquireStateAccess(${JSON.stringify(f.home)});const session=new ArchivePreparationSession(${JSON.stringify(f.home)},${JSON.stringify(f.profile)});await session.prepare();await session.close();unlock();`;
 const script=join(f.directory,'preflight-child.mjs');fs.writeFileSync(script,code);let diagnostics='';const child=spawn(process.execPath,[script],{stdio:['ignore','ignore','pipe']}),exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));child.stderr.on('data',bytes=>{diagnostics=(diagnostics+bytes).slice(-4096);});
 try{await Promise.race([waiting,exited.then(()=>{throw Error('child stopped: '+diagnostics);}),new Promise((_,reject)=>setTimeout(()=>reject(Error('child did not prepare first object: '+diagnostics)),15000).unref())]);child.kill('SIGKILL');assert.equal((await exited).signal,'SIGKILL');assert(fs.existsSync(segmentPath(join(f.home,'application-indexed.sqlite'),entries[0])));assert(!fs.existsSync(join(f.home,'application-indexed.sqlite')));}
 finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}release();}
 f.holdArchive(async()=>{});const unlock=acquireStateAccess(f.home),cache=new ArchivePreparationSession(f.home,f.profile);let audited=0;
 // Ephemeral validation authority is never recovered from the killed worker.
 // A new session must read/authenticate the retained first object again.
 const direct=new ArchiveAuditSession(join(f.home,'application-indexed.sqlite'),{genesisRoot:f.fresh.manifest.root},{directory:f.directory,onProgress:p=>{if(!p.reused)audited++;}});
 try{direct.verify(entries[0]);assert.equal(audited,13);assert((await cache.prepare()).prepared);assert.equal(f.reads,3,'first object reused; only interrupted second object fetched again');}
 finally{direct.close();await cache.close();unlock();}
});
