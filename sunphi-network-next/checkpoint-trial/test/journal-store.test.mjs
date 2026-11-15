import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {JournalStore} from '../research/journal-store.mjs';
import {encodeJournalText,MAX_COMPRESSED_JOURNAL_BYTES} from '../research/journal-codec.mjs';
function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE journal(sequence INTEGER PRIMARY KEY,parent TEXT,root TEXT,body TEXT,digest TEXT)');return {db,reader:new JournalStore(db),put:(n,body)=>db.prepare('INSERT INTO journal VALUES(?,?,?,?,?)').run(n,'parent'+n,'root'+n,body,'digest'+n)};}
test('journal reader returns identical canonical text for mixed rows and pages exactly once',t=>{
 const {reader,put}=fixture(t),texts=Array.from({length:15},(_,i)=>JSON.stringify({i,data:'history '.repeat(200)}));
 texts.forEach((s,i)=>put(i+1,i%2?encodeJournalText(s):s));
 assert.equal(reader.head().sequence,15);assert.equal(reader.header(1).root,'root1');assert.equal(reader.get(16),null);
 let after=0,all=[];while(after<15){const p=reader.page({after,through:15,rows:4,bytes:4000});assert(p.items.length>0&&p.items.length<=4);assert(p.bytes<=4000);all.push(...p.items.map(r=>r.body));after=p.after;assert.equal(p.complete,after===15);}
 assert.deepEqual(all,texts);assert.deepEqual([...reader.scan()].map(r=>r.body),texts);
});
test('journal page rejects first oversized decoded row without skipping or inflating it',t=>{
 const {reader,put,db}=fixture(t);put(1,encodeJournalText(JSON.stringify({data:'x'.repeat(10000)})));
 assert.throws(()=>reader.page({through:1,bytes:1000}),/decoded byte budget/);
 const e=JSON.parse(db.prepare('SELECT body FROM journal').get().body);e.data='corrupt';db.prepare('UPDATE journal SET body=?').run(JSON.stringify(e));
 assert.throws(()=>reader.page({through:1,bytes:1000}),/decoded byte budget/);
 assert.throws(()=>reader.get(1));
});
test('journal header reads avoid large bridge body; only explicit offline scan accepts legacy bridge',t=>{
 const {reader,put}=fixture(t),body=JSON.stringify({bridge:'x'.repeat(MAX_COMPRESSED_JOURNAL_BYTES)});put(1,body);
 assert.equal(reader.header(1).sequence,1);assert.equal([...reader.headers()].length,1);
 assert.throws(()=>reader.get(1),/byte budget/);assert.equal(reader.get(1,{offlineLegacy:true}).body,body);
});
test('journal pages detect gaps and scans honor cancellation before reading bodies',t=>{
 const {reader,put}=fixture(t);put(1,'{}');put(3,'{}');assert.throws(()=>reader.page({through:3}),/journal gap/);
 assert.throws(()=>reader.page({after:3,through:4}),/end is unavailable/);
 const controller=new AbortController();controller.abort(Error('audit cancelled'));
 assert.throws(()=>[...reader.scan({signal:controller.signal})],/audit cancelled/);
 assert.throws(()=>reader.page({through:3,signal:controller.signal}),/audit cancelled/);
});
