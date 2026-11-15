import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {startJournalMaintenance} from '../research/journal-maintenance.mjs';
import {hash,canonical} from '../crypto.mjs';
import {AuthenticatedRecordStore} from '../research/authenticated-record-store.mjs';
import {encodeJournalText,decodeJournalText,decodeJournal,compactJournalBatch,MAX_COMPRESSED_JOURNAL_BYTES} from '../research/journal-codec.mjs';
const fixture=t=>{const prefix=join(fs.realpathSync(tmpdir()),'duebyte-journal-'),dir=fs.mkdtempSync(prefix),file=join(dir,'history.sqlite'),store=AuthenticatedRecordStore.create(file,[['a',{data:'history '.repeat(2500),n:0}]]);t.after(()=>{try{store.close();}catch{}assert(fs.realpathSync(dir).startsWith(prefix));fs.rmSync(dir,{recursive:true,force:true});});return {dir,file,store};};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('maintenance preserves concurrent commits, pauses behind WAL readers and resumes after restart',async t=>{
 const {store,file}=fixture(t);store.compressJournal=false;for(let n=1;n<=48;n++)store.transact(store.root,{n},tx=>tx.set('a',{data:'history '.repeat(2500),n}));store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 const reader=AuthenticatedRecordStore.readOnly(file,store.root);store.transact(store.root,{n:49},tx=>tx.set('a',{data:'history '.repeat(2500),n:49}));let batches=0,errors=[];
 let stop=startJournalMaintenance(store,{enabled:true,interval:5,walLimit:1024,onProgress:()=>batches++,onError:e=>errors.push(e)});
 try{await sleep(50);assert.equal(batches,0);assert.equal(reader.proof('a',reader.root).value.n,48);}finally{reader.close();stop();}
 const bodies=store.db.prepare('SELECT body FROM journal ORDER BY sequence').all().map(r=>decodeJournalText(r.body));
 let notices=0;store.onCommit(()=>notices++);stop=startJournalMaintenance(store,{enabled:true,interval:5,onProgress:()=>batches++,onError:e=>errors.push(e)});
 try{store.compressJournal=true;store.transact(store.root,{n:50},tx=>tx.set('a',{data:'history '.repeat(2500),n:50}));for(let i=0;i<200&&batches<5;i++)await sleep(5);assert(batches>=5);assert(notices>=4);assert.equal(store.proof('a',store.root).value.n,50);assert.deepEqual(store.db.prepare('SELECT body FROM journal WHERE sequence<=49 ORDER BY sequence').all().map(r=>decodeJournalText(r.body)),bodies);assert.deepEqual(errors,[]);}finally{stop();}
});
test('maintenance stops safely at corrupt history and remains disabled in reader release',async t=>{
 const {store}=fixture(t);store.compressJournal=false;store.transact(store.root,{n:1},tx=>tx.set('a',{data:'history '.repeat(2500),n:1}));const raw=store.db.prepare('SELECT body FROM journal').get().body;
 const disabled=startJournalMaintenance(store,{enabled:false,interval:1});await sleep(20);disabled();assert.equal(store.db.prepare('SELECT body FROM journal').get().body,raw);
 store.db.prepare('UPDATE journal SET body=?').run('{}');const head={...store.meta};let errors=0,batches=0;const stop=startJournalMaintenance(store,{enabled:true,interval:2,onError:()=>errors++,onProgress:()=>batches++});try{await sleep(40);assert.equal(errors,1);assert.equal(batches,0);assert.deepEqual({...store.meta},head);}finally{stop();}
});
test('encoding preserves Unicode canonical bytes and authenticated digest; small and bridge rows remain plain',()=>{
 const text=canonical({changes:[{before:'історія中文🙂'.repeat(500),after:'історія中文🙂'.repeat(500)}]});const encoded=encodeJournalText(text);assert(encoded.length<text.length/2);assert.equal(decodeJournalText(encoded),text);assert.equal(hash(decodeJournal(encoded)),hash(JSON.parse(text)));assert.equal(encodeJournalText('{}'),'{}');
 const large=JSON.stringify({bridge:'x'.repeat(MAX_COMPRESSED_JOURNAL_BYTES)});assert.equal(encodeJournalText(large),large);assert.equal(decodeJournalText(large),large);
});
test('corrupted payload, checksum, length, expansion, trailing data and unknown encoding fail closed',()=>{
 const encoded=encodeJournalText(JSON.stringify({data:'x'.repeat(100000)}));const original=JSON.parse(encoded);
 for(const mutate of [e=>e.sha256='0'.repeat(64),e=>e.bytes++,e=>e.bytes=1,e=>e.bytes=MAX_COMPRESSED_JOURNAL_BYTES+1,e=>e.encoding='UNKNOWN',e=>e.extra=true,e=>e.data+=' ',e=>e.data=Buffer.concat([Buffer.from(e.data,'base64'),Buffer.from([0])]).toString('base64'),e=>e.data=Buffer.from('corrupt').toString('base64')]){const e=structuredClone(original);mutate(e);assert.throws(()=>decodeJournalText(JSON.stringify(e)));}
});
test('mixed-format atomic compaction retains every history row, root, digest and bytes across reopen',t=>{
 const {file,store}=fixture(t);for(let n=1;n<=20;n++){store.compressJournal=n%2===0;store.transact(store.root,{n},tx=>tx.set('a',{data:'history '.repeat(2500),n}));}
 const before=store.db.prepare('SELECT * FROM journal ORDER BY sequence').all().map(r=>({...r,body:decodeJournalText(r.body)})),head={...store.meta};let after=0;
 for(;;){const r=compactJournalBatch(store.db,{after,rows:3});after=r.after;if(!r.rows)break;}
 assert.deepEqual({...store.meta},head);assert.equal(after,20);store.close();const reopened=new AuthenticatedRecordStore(file,head.rootHash);
 try{assert.deepEqual(reopened.db.prepare('SELECT * FROM journal ORDER BY sequence').all().map(r=>({...r,body:decodeJournalText(r.body)})),before);assert.deepEqual({...reopened.meta},head);assert.equal(reopened.db.prepare('PRAGMA quick_check').get().quick_check,'ok');}finally{reopened.close();}
});
test('interrupted compaction rolls back and resumes without partial row replacement',t=>{
 const {store}=fixture(t);for(let n=1;n<=10;n++)store.transact(store.root,{n},tx=>tx.set('a',{data:'history '.repeat(2500),n}));const before=store.db.prepare('SELECT * FROM journal').all();
 assert.throws(()=>compactJournalBatch(store.db,{beforeCommit:()=>{throw Error('simulated interruption');}}),/interruption/);assert.deepEqual(store.db.prepare('SELECT * FROM journal').all(),before);assert.equal(compactJournalBatch(store.db).changed,10);
});
test('maintenance byte budget applies before decoding, including the first large row',t=>{
 const {store}=fixture(t);store.compressJournal=false;
 store.transact(store.root,{n:1},tx=>tx.set('a',{data:'history '.repeat(2500),n:1}));
 store.compressJournal=true;store.transact(store.root,{n:2},tx=>tx.set('a',{data:'history '.repeat(2500),n:2}));
 store.transact(store.root,{n:3},tx=>tx.set('small',{n:3}));
 const before=store.db.prepare('SELECT * FROM journal ORDER BY sequence').all(),head={...store.meta};
 const limited=compactJournalBatch(store.db,{bytes:1024});
 assert.equal(limited.after,3);assert.equal(limited.skippedLarge,2);assert(limited.sourceBytes<=1024);assert.equal(limited.changed,0);
 assert.deepEqual(store.db.prepare('SELECT * FROM journal ORDER BY sequence').all(),before);assert.deepEqual({...store.meta},head);
 const first=compactJournalBatch(store.db,{bytes:50000});assert.equal(first.after,1);assert(first.sourceBytes<=50000);
 const second=compactJournalBatch(store.db,{after:first.after,bytes:50000});assert.equal(second.after,3);assert(second.sourceBytes<=50000);
 assert.deepEqual(store.db.prepare('SELECT * FROM journal ORDER BY sequence').all().map(r=>({...r,body:decodeJournalText(r.body)})),before.map(r=>({...r,body:decodeJournalText(r.body)})));
});
test('compaction rejects corrupt legacy history without changing other rows',t=>{
 const {store}=fixture(t);for(let n=1;n<=4;n++)store.transact(store.root,{n},tx=>tx.set('a',{data:'history '.repeat(2500),n}));store.db.prepare('UPDATE journal SET body=? WHERE sequence=3').run('{}');const before=store.db.prepare('SELECT * FROM journal').all();assert.throws(()=>compactJournalBatch(store.db),/digest/);assert.deepEqual(store.db.prepare('SELECT * FROM journal').all(),before);
});
test('held read snapshot remains valid across physical compaction and subsequent commit',t=>{
 const {store,file}=fixture(t);store.transact(store.root,{n:1},tx=>tx.set('a',{data:'history '.repeat(2500),n:1}));const root=store.root,reader=AuthenticatedRecordStore.readOnly(file,root);try{const body=reader.db.prepare('SELECT body FROM journal WHERE sequence=1').get().body;compactJournalBatch(store.db);store.compressJournal=true;store.transact(root,{n:2},tx=>tx.set('a',{data:'history '.repeat(2500),n:2}));assert.equal(reader.proof('a',root).value.n,1);assert.equal(reader.db.prepare('SELECT body FROM journal WHERE sequence=1').get().body,body);}finally{reader.close();}
});
test('SQLite full transaction preserves the prior authenticated state',t=>{
 const {store}=fixture(t);store.compressJournal=true;const before={...store.meta};const pages=store.db.prepare('PRAGMA page_count').get().page_count;store.db.exec('PRAGMA max_page_count='+pages);
 assert.throws(()=>store.transact(store.root,{n:1},tx=>{for(let i=0;i<100;i++)tx.set('key'+i,{random:hash(i).repeat(800)});}));assert.deepEqual({...store.meta},before);assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
});
for(const phase of ['before','after'])test('process killed '+phase+' compaction commit recovers exact history',async t=>{
 const {store,file}=fixture(t);for(let n=1;n<=10;n++)store.transact(store.root,{n},tx=>tx.set('a',{data:'history '.repeat(2500),n}));const head={...store.meta},before=store.db.prepare('SELECT * FROM journal ORDER BY sequence').all().map(r=>({...r}));store.close();
 const child=spawn(process.execPath,[fileURLToPath(new URL('./journal-crash-child.mjs',import.meta.url)),file,head.rootHash,phase],{windowsHide:true,stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',b=>errors+=b);const closed=new Promise(resolve=>child.once('exit',resolve));
 try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('crash helper timeout: '+errors)),15000);child.stdout.once('data',b=>{clearTimeout(timer);assert.match(b.toString(),/READY/);resolve();});child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(Error('early helper exit: '+errors));});});child.kill('SIGKILL');await closed;}finally{child.kill('SIGKILL');}
 const reopened=new AuthenticatedRecordStore(file,head.rootHash);try{assert.deepEqual({...reopened.meta},head);const rows=reopened.db.prepare('SELECT * FROM journal ORDER BY sequence').all().map(r=>({...r}));assert.deepEqual(rows.map(r=>({...r,body:decodeJournalText(r.body)})),before);assert.equal(rows.some(r=>r.body.startsWith('{"encoding":')),phase==='after');assert.equal(reopened.db.prepare('PRAGMA quick_check').get().quick_check,'ok');}finally{reopened.close();}
});
