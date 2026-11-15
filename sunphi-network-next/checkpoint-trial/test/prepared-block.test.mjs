import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';
import {utcEconomicFixture} from './helpers/utc-economic-fixture.mjs';import {hash} from '../crypto.mjs';
import {BoundedNetworkInterpreter} from '../research/bounded-network-interpreter.mjs';import {BoundedBlockStore} from '../research/bounded-block-store.mjs';
function fixture(){const x=utcEconomicFixture({payments:2,manySenders:true,liability:{expanded:true}}),dir=fs.mkdtempSync(join(tmpdir(),'duebyte-prepared-proof-')),file=join(dir,'state.sqlite'),h=BoundedNetworkInterpreter.create(file,x.s,x.c,hash(x.s)),b=new BoundedBlockStore(h),p=x.payment(x.s,0);
 const reserve={height:x.s.height+1,blockHash:hash('reserve'),time:x.s.money.time+2,txs:[Buffer.from(JSON.stringify(x.reserve(p)))]};h.commitBlock(reserve,h.root);const state=h.snapshotForAudit(),q={height:state.height+1,blockHash:hash('proof'),time:state.money.time+2,txs:[Buffer.from(JSON.stringify(x.wire(x.fault(state,p))))]};
 return {...x,dir,file,h,b,state,q,close(){if(!this.closed)b.close();}};
}

test('strict preview, Finalize and prepared Commit execute once and match an independent journal',()=>{const r=fixture();try{
 const pin=r.h.root,meta={...r.h.store.meta},raw=r.h.commitBlock.bind(r.h);let calls=0;r.h.commitBlock=(...args)=>{calls++;return raw(...args);};
 const first=r.b.preview(r.q);assert.equal(r.h.root,pin);first.root=hash('mutated result');const predicted=r.b.finalize(r.q);assert.notEqual(predicted.root,first.root);assert.deepEqual({...r.h.store.meta},meta);
 // A later unrelated preview cannot replace the already finalized private plan.
 r.b.preview({...r.q,blockHash:hash('other proposal')});assert.equal(calls,2);
 const independent=BoundedNetworkInterpreter.create(join(r.dir,'reference.sqlite'),r.s,r.c,hash(r.s));try{
  for(const row of r.h.store.db.prepare('SELECT body FROM journal ORDER BY sequence').iterate()){const e=JSON.parse(row.body).event;independent.commitBlock({height:e.height,blockHash:e.blockHash,time:e.time,txs:e.txs.map(t=>Buffer.from(t,'base64'))},independent.root,{filter:e.filter});}
  independent.commitBlock(r.q,independent.root);const expected=independent.snapshotForAudit();r.q.txs[0].fill(0);predicted.codes[0]=99;r.b.commit();
  assert.equal(calls,2);assert.equal(r.h.root,independent.root);assert.equal(r.h.store.meta.journalHash,independent.store.meta.journalHash);assert.deepEqual(r.h.snapshotForAudit(),expected);assert(r.b.commit().duplicate);
 }finally{independent.close();}
}finally{r.close();}});

test('changed request fields and filtered rejection cannot reuse a strict candidate',()=>{const r=fixture();try{
 const pin=r.h.root,good=r.b.preview(r.q),bad={...r.q,txs:[Buffer.from('{bad')]};r.b.preview(bad,{filter:true});assert.throws(()=>r.b.finalize(bad));assert.equal(r.h.root,pin);
 assert.notEqual(r.b.preview({...r.q,time:r.q.time+1}).root,good.root);assert.notEqual(r.b.preview({...r.q,blockHash:hash('altered')}).root,good.root);
 assert.throws(()=>r.b.preview({...r.q,unexpected:true}));const selected=r.b.finalize(r.q);assert.equal(selected.root,good.root);r.b.commit();assert.equal(r.h.root,good.root);
}finally{r.close();}});

test('candidate copying enforces transaction count and byte budgets before execution',()=>{const r=fixture();try{
 const pin=r.h.root;r.h.commitBlock=()=>{throw Error('must not execute oversized input');};
 for(const txs of [Array(65).fill(Buffer.from('x')),[Buffer.alloc(0)],[Buffer.alloc(65537)],Array(17).fill(Buffer.alloc(65536))])assert.throws(()=>r.b.preview({...r.q,txs}),e=>!e.message.includes('must not execute'));
 assert.equal(r.h.root,pin);
}finally{r.close();}});

test('stale finalized root or journal sequence cannot apply the prepared write set',()=>{
 for(const change of ['root','journal']){const r=fixture();try{
  r.b.finalize(r.q);if(change==='root')r.h.commitBlock({...r.q,txs:[],blockHash:hash('competing')},r.h.root);else r.h.store.db.exec('UPDATE meta SET sequence=sequence+1 WHERE id=1');
  const pin=r.h.root,meta={...r.h.store.meta};assert.throws(()=>r.b.commit(),/stale/);assert.equal(r.h.root,pin);assert.deepEqual({...r.h.store.meta},meta);
 }finally{r.close();}}
});

test('prepared Commit authenticates stored opening values and never repairs corruption silently',()=>{for(const target of ['written','read-only']){const r=fixture();try{
 r.b.finalize(r.q);const pin=r.h.root,key=target==='written'?'meta/blockHead':'requests/'+Object.keys(r.state.money.requests)[0];r.h.store.db.prepare('UPDATE nodes SET value=? WHERE key=?').run('{}',key);
 assert.throws(()=>r.b.commit(),/corruption|mismatch/);assert.equal(r.h.root,pin);assert.equal(r.h.store.db.prepare('SELECT value FROM nodes WHERE key=?').get(key).value,'{}');
}finally{r.close();}}});

test('prepared Commit interruption retries once with the exact validated root',()=>{const r=fixture();try{
 const pin=r.h.root,meta={...r.h.store.meta},result=r.b.finalize(r.q);assert.throws(()=>r.b.commit({beforeCommit:()=>{throw Error('power-loss');}}),/power-loss/);assert.equal(r.h.root,pin);assert.deepEqual({...r.h.store.meta},meta);assert.deepEqual(r.h.snapshotForAudit(),r.state);
 r.b.commit();assert.equal(r.h.root,result.root);assert(r.b.commit().duplicate);assert.equal(r.h.store.meta.sequence,meta.sequence+1);
}finally{r.close();}});

test('process loss during prepared Commit restores the old root and revalidates the proposal',()=>{const r=fixture();try{
 const pin=r.h.root,data=join(r.dir,'public-replay.json');fs.writeFileSync(data,JSON.stringify({file:r.file,config:r.c,root:pin,request:{...r.q,txs:r.q.txs.map(b=>b.toString('base64'))}}));r.b.close();r.closed=true;
 const interpreter=new URL('../research/bounded-network-interpreter.mjs',import.meta.url).href,blocks=new URL('../research/bounded-block-store.mjs',import.meta.url).href,script=`import fs from 'node:fs';import {BoundedNetworkInterpreter} from ${JSON.stringify(interpreter)};import {BoundedBlockStore} from ${JSON.stringify(blocks)};const x=JSON.parse(fs.readFileSync(process.argv[1]));x.request.txs=x.request.txs.map(b=>Buffer.from(b,'base64'));const h=BoundedNetworkInterpreter.open(x.file,x.config,x.root),b=new BoundedBlockStore(h);b.finalize(x.request);b.commit({beforeCommit:()=>process.exit(77)});`;
 assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',script,data],{stdio:'pipe',windowsHide:true}),e=>e.status===77);
 const h=BoundedNetworkInterpreter.open(r.file,r.c,pin),b=new BoundedBlockStore(h);try{assert.deepEqual(h.snapshotForAudit(),r.state);const result=b.finalize(r.q);b.commit();assert.equal(h.root,result.root);assert(b.commit().duplicate);}finally{b.close();}
}finally{r.close();}});
