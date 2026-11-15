import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setup} from './payment-liability.test.mjs';
import {hash} from '../crypto.mjs';
import {block} from '../core.mjs';
import {BoundedNetworkInterpreter} from '../research/bounded-network-interpreter.mjs';
import {BoundedBlockStore} from '../research/bounded-block-store.mjs';
import {BoundedApplication,openBoundedApplication} from '../research/bounded-application.mjs';
import {Store} from '../store.mjs';
import {migrateBoundedArchive,verifyBoundedArchive} from '../research/bounded-archive-migration.mjs';
import {prepareBoundedRootTransition} from '../research/bounded-root-transition.mjs';
import {BoundedReadLeases} from '../research/bounded-read-leases.mjs';
import {createBoundedApi} from '../research/bounded-api.mjs';
import {boundedHttpQuery,loadBoundedWalletView} from '../research/bounded-wallet-view.mjs';
import {queryBounded,verifyBoundedQuery} from '../research/bounded-query.mjs';
import {walletAnalytics} from '../research/bounded-wallet-presentation.mjs';
import {balances} from '../wallet.mjs';

function rig(extra=0){
 const x=setup(),state=structuredClone(x.s);
 for(let i=0;i<extra;i++)state.money.outputs[hash(['pages',i])]={owner:x.f.alice.publicKey,value:'1',unlock:0};
 state.money.supply=String(BigInt(state.money.supply)+BigInt(extra));
 const file=join(mkdtempSync(join(tmpdir(),'duebyte-commit-pages-')),'index.sqlite'),handler=BoundedNetworkInterpreter.create(file,state,x.c,hash(state)),blocks=new BoundedBlockStore(handler);
 const request=(txs=[])=>({height:blocks.header.height+1,blockHash:hash(['block',blocks.header.height+1]),time:state.money.time,txs:txs.map(w=>Buffer.from(JSON.stringify(w)))});
 return {x,state,file,handler,blocks,request};
}

test('Finalize rolls back all changes; Commit persists the identical root exactly once',()=>{
 const r=rig(),{handler:h,blocks:b}=r,root=b.root,meta={...h.store.meta},i=r.x.intent(r.state),q=r.request([r.x.reserve(i)]);
 try{
  const predicted=b.finalize(q);assert.notEqual(predicted.root,root);assert.equal(b.root,root);assert.deepEqual({...h.store.meta},meta);assert.deepEqual(h.snapshotForAudit(),r.state);
  predicted.root='0'.repeat(64);assert.notEqual(b.finalize(q).root,predicted.root);assert.throws(()=>b.finalize({...q,txs:[]}),/conflict/);
  assert.throws(()=>b.commit({beforeCommit:()=>{throw Error('power loss');}}),/power loss/);assert.equal(b.root,root);assert.deepEqual({...h.store.meta},meta);
  const expected=block(r.state,r.x.c,q).state;b.commit();assert.deepEqual(h.snapshotForAudit(),expected);const committed=b.root;
  assert.equal(b.finalize(q).root,committed);assert(b.commit().duplicate);assert.equal(h.store.meta.sequence,meta.sequence+1);
  assert.throws(()=>b.finalize({...q,txs:[]}),/conflicting/);
 }finally{b.close();}
});

test('restart before and after Commit replays only the uncommitted block',()=>{
 const r=rig(),root=r.blocks.root,q=r.request();r.blocks.finalize(q);r.blocks.close();
 let h=BoundedNetworkInterpreter.open(r.file,r.x.c,root),b=new BoundedBlockStore(h);assert.equal(b.header.height,r.state.height);const candidate=b.finalize(q).root;b.commit();b.close();
 h=BoundedNetworkInterpreter.open(r.file,r.x.c,candidate);b=new BoundedBlockStore(h);
 try{assert.equal(b.finalize(q).root,candidate);assert(b.commit().duplicate);assert.equal(h.store.meta.sequence,1);}finally{b.close();}
});

test('ABCI Info keeps source root until Commit and candidate methods never persist',()=>{
 const r=rig(),a=new BoundedApplication(r.handler,{sourceHeight:r.state.height,sourceRoot:hash(r.state)}),q=r.request(),wire={height:q.height,time:q.time,hash:Buffer.from(q.blockHash,'hex').toString('base64'),txs:[]};
 try{
  const before=a.dispatch({method:'info'});assert.equal(before.hash,Buffer.from(hash(r.state),'hex').toString('base64'));
  assert.deepEqual(a.dispatch({...wire,method:'prepare'}),{txs:[]});assert.deepEqual(a.dispatch({...wire,method:'process'}),{accept:true});
  assert.equal(a.dispatch({...wire,method:'check',txs:[Buffer.from('invalid').toString('base64')]}).code,1);assert.equal(r.handler.store.meta.sequence,0);
  const candidate=a.dispatch({...wire,method:'finalize'});assert.deepEqual(a.dispatch({method:'info'}),before);a.dispatch({method:'commit'});assert.equal(a.dispatch({method:'info'}).hash,candidate.hash);
  assert.throws(()=>a.dispatch({method:'snapshot'}),/forbidden/);assert.throws(()=>a.dispatch({method:'offerSnapshot'}),/forbidden/);
 }finally{a.close();}
});

test('read leases keep proofs stable across commits, expire, reject wrong roots and bound capacity',()=>{
 const r=rig(),h=r.handler;let clock=0;const leases=new BoundedReadLeases(h,{clock:()=>clock,ttl:1000,retained:2,maxLeases:2}),root=h.root,l=leases.acquire(root),q={type:'wallet-meta',id:null};
 try{
  for(let n=0;n<5;n++){r.blocks.finalize(r.request());r.blocks.commit();}
  const response=queryBounded(leases.resolve(l.token,root),q,root);assert.equal(verifyBoundedQuery(response,q,root,hash(r.x.c)).height,r.state.height);
  assert.throws(()=>leases.resolve(l.token,h.root),/wrong root/);assert.throws(()=>queryBounded(h,q,root),/stale/);
  const other=leases.acquire(h.root);assert.throws(()=>leases.acquire(h.root),/capacity/);leases.release(other.token);
  clock=1001;assert.throws(()=>leases.resolve(l.token,root),/expired/);assert.throws(()=>leases.acquire(root),/unavailable/);
  assert(leases.roots.size<=2);
 }finally{leases.close();r.blocks.close();}
});

test('proof pages complete while writer advances on every request; UI does not invent network totals',async()=>{
 const r=rig(80),server=createBoundedApi(r.handler);await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 const url='http://127.0.0.1:'+server.address().port,root=r.handler.root,height=r.state.height,query=boundedHttpQuery(url);let pages=0;
 try{
  const result=await query.withLease(root,pinned=>loadBoundedWalletView(async(q,pin)=>{r.blocks.finalize(r.request());r.blocks.commit();pages++;return pinned(q,pin);},{root,height,configHash:hash(r.x.c),owner:r.x.f.alice.publicKey}));
  assert(pages>=6);assert.equal(result.state.height,height);assert.deepEqual(balances(result.state,r.x.f.alice.publicKey),balances(r.state,r.x.f.alice.publicKey));
  const a=walletAnalytics({state:result.state,certificate:{height:height+1,blockHash:hash('header')},checkpointId:hash('checkpoint')});assert.equal(a.scope,'owner');assert.equal(a.volume,null);assert.equal(a.settled,null);assert.equal(a.supply,r.state.money.supply);
  assert.equal((await fetch(url+'/v1/read-lease?root='+r.handler.root,{method:'POST',headers:{Origin:'https://evil.invalid'}})).status,403);
  await assert.rejects(()=>query.withLease(root,async()=>{throw Error('consumer failed');}),/consumer failed/);
 }finally{await new Promise(ok=>server.close(ok));r.blocks.close();}
});

test('WAL pressure invalidates slow reads rather than blocking commits indefinitely',()=>{
 const r=rig(),leases=new BoundedReadLeases(r.handler,{walLimit:1024}),root=r.handler.root,l=leases.acquire(root);
 try{r.blocks.finalize(r.request());r.blocks.commit();assert.throws(()=>leases.resolve(l.token,root),/expired/);assert.equal(r.blocks.header.height,r.state.height+1);const fresh=leases.acquire(r.handler.root);assert(leases.resolve(fresh.token,fresh.root));}finally{leases.close();r.blocks.close();}
});

test('signed migration opens ABCI, restarts after Commit, preserves archive and rejects forged authority',()=>{
 const x=setup(),dir=mkdtempSync(join(tmpdir(),'duebyte-activation-')),source=join(dir,'source.sqlite'),file=join(dir,'indexed.sqlite'),legacy=new Store(source,x.c);
 for(let height=1;height<=3;height++){legacy.finalize({height,blockHash:hash(['legacy',height]),time:1000,txs:[]});legacy.commit();}
 const state=structuredClone(legacy.state),sourceRoot=hash(state);legacy.close();const bytes=hash(readFileSync(source).toString('base64'));
 const migrated=migrateBoundedArchive(source,file,x.c,sourceRoot),body=prepareBoundedRootTransition(state,x.c,migrated,sourceRoot),certificate={body,approvals:x.approvals(body)};migrated.close();
 assert.throws(()=>openBoundedApplication(file,state,x.c,{body,approvals:certificate.approvals.slice(0,6)}));
 let a=openBoundedApplication(file,state,x.c,certificate);const request={method:'finalize',height:4,time:1000,hash:Buffer.from(hash('indexed block'),'hex').toString('base64'),txs:[]};
 const finalized=a.dispatch(request);a.dispatch({method:'commit'});a.close();
 a=openBoundedApplication(file,state,x.c,certificate);
 try{assert.equal(a.dispatch({method:'info'}).hash,finalized.hash);assert.equal(a.dispatch(request).hash,finalized.hash);assert.equal(verifyBoundedArchive(a.handler).count,4);assert.equal(hash(readFileSync(source).toString('base64')),bytes);assert.equal(a.handler.snapshotForAudit().money.supply,state.money.supply);}finally{a.close();}
});
