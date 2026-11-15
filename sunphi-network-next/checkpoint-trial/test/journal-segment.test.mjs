import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {AuthenticatedRecordStore} from '../research/authenticated-record-store.mjs';
import {archiveJournalPrefix,segmentPath} from '../research/journal-segment.mjs';
import {startArchiveMaintenance} from '../research/archive-maintenance.mjs';
import {cleanArchiveStaging} from '../research/archive-staging.mjs';
const linux={skip:process.platform!=='linux'};
function fixture(t){const prefix=join(fs.realpathSync(tmpdir()),'duebyte-segments-'),dir=fs.mkdtempSync(prefix),file=join(dir,'state.sqlite');let store=AuthenticatedRecordStore.create(file,[['a',{n:0,data:'history '.repeat(300)}]]);for(let n=1;n<=90;n++)store.transact(store.root,{n},tx=>tx.set('a',{n,data:'history '.repeat(300)}));const head={...store.meta},rows=[...store.journal.scan()];t.after(()=>{try{store.close();}catch{}assert(fs.realpathSync(dir).startsWith(prefix));fs.rmSync(dir,{recursive:true,force:true});});return {file,head,rows,get store(){return store;},reopen(){store.close();store=new AuthenticatedRecordStore(file,head.rootHash);return store;}};}
test('segmented journal retains exact history, current root and bounded read pages across restart',linux,t=>{
 const f=fixture(t);archiveJournalPrefix(f.store,{through:26,rows:16});archiveJournalPrefix(f.store,{through:26,rows:16});
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM journal').get().n,64);assert.equal([...f.store.journal.segments()].length,2);
 f.reopen();assert.deepEqual({...f.store.meta},f.head);assert.deepEqual([...f.store.journal.scan()],f.rows);
 assert.equal(f.store.journal.header(1).root,f.rows[0].root);assert.equal(f.store.journal.head().sequence,90);
 let after=14,items=[];while(after<30){const page=f.store.journal.page({after,through:30,rows:20,bytes:120000});assert(page.after>after);assert(page.bytes<=120000);items.push(...page.items);after=page.after;}assert.deepEqual(items,f.rows.slice(14,30));
 assert.throws(()=>archiveJournalPrefix(f.store,{through:27}),/restart tail/);
});
test('segmented journal preserves an older reader and permits later normal commits',linux,t=>{
 const f=fixture(t),reader=f.store.readSnapshot(f.store.root);try{
  archiveJournalPrefix(f.store,{through:26});assert.deepEqual([...reader.journal.scan()],f.rows);
  f.store.transact(f.store.root,{n:91},tx=>tx.set('a',{n:91}));assert.equal(reader.proof('a',reader.root).value.n,90);assert.equal(f.store.journal.head().sequence,91);
  assert.deepEqual([...f.store.journal.scan({to:90})],f.rows);
 }finally{reader.close();}
});
test('segmented journal background preparation preserves concurrent commits and a bounded hot tail',linux,async t=>{
 const f=fixture(t);let stop;await new Promise((ok,no)=>{const timer=setTimeout(()=>{stop?.();no(Error('archive maintenance timeout'));},15000);stop=startArchiveMaintenance(f.store,{enabled:true,interval:10,rows:16,onError:e=>{clearTimeout(timer);no(e);},onProgress:()=>{stop();clearTimeout(timer);ok();}});
  setTimeout(()=>f.store.transact(f.store.root,{n:91},tx=>tx.set('a',{n:91})),30);
 });
 assert.equal(f.store.journal.head().sequence,91);assert.deepEqual([...f.store.journal.scan({to:90})],f.rows);assert.equal(f.store.db.prepare('SELECT count(*) n FROM journal').get().n,75);assert.equal(f.store.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
});
test('segmented journal fails closed for missing or corrupted archive objects',linux,t=>{
 const f=fixture(t);archiveJournalPrefix(f.store,{through:26});const entry=[...f.store.journal.segments()][0],file=segmentPath(f.file,entry),bytes=fs.readFileSync(file);f.reopen();
 fs.unlinkSync(file);assert.throws(()=>f.store.journal.get(1));fs.writeFileSync(file,bytes);const fd=fs.openSync(file,'r+');try{fs.writeSync(fd,Buffer.from('bad'),0,3,200);}finally{fs.closeSync(fd);}
 assert.throws(()=>f.store.journal.get(1),/checksum/);assert.deepEqual({...f.store.meta},f.head);
});

for(const point of ['file-fsync','object-link','directory-fsync'])test('segmented journal storage failure at '+point+' preserves history and permits retry',linux,t=>{
 const f=fixture(t),originalSync=fs.fsyncSync,originalLink=fs.linkSync;let triggered=false;
 const fail=()=>{triggered=true;throw Object.assign(Error('injected storage failure'),{code:point==='object-link'?'ENOSPC':'EIO'});};
 fs.fsyncSync=fd=>{const name=fs.readlinkSync('/proc/self/fd/'+fd);if(!triggered&&((point==='file-fsync'&&name.includes('/.staging/.pending-'))||(point==='directory-fsync'&&name===f.file+'.history'&&fs.readdirSync(name).some(n=>/^[a-f0-9]{64}\.sqlite$/.test(n)))))fail();return originalSync(fd);};
 fs.linkSync=(from,to)=>{if(!triggered&&point==='object-link'&&to.startsWith(f.file+'.history/'))fail();return originalLink(from,to);};
 try{assert.throws(()=>archiveJournalPrefix(f.store,{through:26}),/injected storage failure/);}finally{fs.fsyncSync=originalSync;fs.linkSync=originalLink;}
 assert(triggered);f.reopen();assert.deepEqual({...f.store.meta},f.head);assert.deepEqual([...f.store.journal.scan()],f.rows);assert.equal(f.store.db.prepare('SELECT count(*) n FROM journal').get().n,90);
 archiveJournalPrefix(f.store,{through:26});f.reopen();assert.deepEqual([...f.store.journal.scan()],f.rows);assert.equal(f.store.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
});
for(const phase of ['file-durable','object-published','catalogue-written','hot-rows-removed','catalogue-committed'])test('segmented journal process loss at '+phase+' restores complete history',linux,async t=>{
 const f=fixture(t);f.store.close();const child=spawn(process.execPath,[fileURLToPath(new URL('./journal-segment-crash-child.mjs',import.meta.url)),f.file,f.head.rootHash,phase],{stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',b=>errors+=b);const closed=new Promise(r=>child.once('exit',r));
 try{await new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error('segment helper timeout: '+errors)),15000);child.stdout.once('data',b=>{clearTimeout(timer);assert.match(b.toString(),/READY/);ok();});child.once('error',e=>{clearTimeout(timer);no(e);});child.once('exit',()=>{clearTimeout(timer);no(Error('early segment helper exit: '+errors));});});child.kill('SIGKILL');await closed;}finally{child.kill('SIGKILL');}
 cleanArchiveStaging(f.file);const store=new AuthenticatedRecordStore(f.file,f.head.rootHash);try{
  assert.deepEqual({...store.meta},f.head);assert.deepEqual([...store.journal.scan()],f.rows);assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
  assert.deepEqual(fs.readdirSync(f.file+'.history/.staging'),[],'abandoned temporary files cleaned; durable objects retained');
  const archived=[...store.journal.segments()].length;assert.equal(archived,phase==='catalogue-committed'?1:0);
  archiveJournalPrefix(store,{through:26});assert.deepEqual([...store.journal.scan()],f.rows);
 }finally{store.close();}
});
