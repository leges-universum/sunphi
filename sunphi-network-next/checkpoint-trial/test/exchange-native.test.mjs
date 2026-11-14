import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {exchangeFixture} from './helpers/exchange-native-fixture.mjs';
import {hash,keys} from '../crypto.mjs';import {validateConfig} from '../core.mjs';
import {exchangeOutput} from '../research/exchange-native.mjs';
import {BoundedNetworkInterpreter} from '../research/bounded-network-interpreter.mjs';
import {queryBounded,verifyBoundedQuery} from '../research/bounded-query.mjs';
import {createBoundedApi} from '../research/bounded-api.mjs';
function rig(){const f=exchangeFixture();fs.mkdirSync('F:/DueByteWork/exchange-native-tests',{recursive:true});const dir=fs.mkdtempSync('F:/DueByteWork/exchange-native-tests/run-'),file=path.join(dir,'state.sqlite');let db=BoundedNetworkInterpreter.create(file,f.s,f.c,hash(f.s));return {...f,get db(){return db;},step(txs,time=1000,options={}){return db.commitBlock({height:db.networkHeader().height+1,time,blockHash:hash([db.networkHeader().height+1,time]),txs},db.root,options);},state(){return db.snapshotForAudit();},reopen(){const root=db.root;db.close();db=BoundedNetworkInterpreter.open(file,f.c,root);}};}
test('HTTP exchange proof matches root; stale roots and mutation requests rejected',async()=>{
 const r=rig(),server=createBoundedApi(r.db);try{
  const o=r.order();r.step([r.wire(o.lock,[o.input],o.payer)]);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port,root=r.db.root,url=base+'/v1/exchange-order/'+o.id+'?root='+root;
  const response=await fetch(url);assert.equal(response.status,200);assert.equal(verifyBoundedQuery(await response.json(),{type:'exchange-order',id:o.id},root,hash(r.c)).data.status,'LOCKED');assert.equal((await fetch(url,{method:'POST'})).status,405);
  assert.throws(()=>r.step([r.wire({type:'CLAIM',id:o.id,secret:o.secret})],1020));assert.equal(r.db.root,root);r.step([r.wire(o.claim())],1020);assert.equal((await fetch(url)).status,409);
  const fresh=await fetch(base+'/v1/exchange-order/'+o.id+'?root='+r.db.root);assert.equal(verifyBoundedQuery(await fresh.json(),{type:'exchange-order',id:o.id},r.db.root,hash(r.c)).data.status,'CLAIMED');
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));r.db.close();}
});
for(const direction of ['BUY_DUBYT','SELL_DUBYT'])for(const asset of ['BTC','USDC'])test(direction+' '+asset+' native balances, replay, proofs and restart',()=>{
 const r=rig();try{const o=r.order(direction,asset),tx=r.wire(o.lock,[o.input],o.payer);r.step([tx]);r.step([tx]);r.reopen();
 assert.equal(r.state().money.fees,'1000');assert.equal(r.state().money.outputs[exchangeOutput(hash(r.c),o.id,'escrow')].unlock,Number.MAX_SAFE_INTEGER);
 const claim=r.wire(o.claim(),[],r.user);r.step([claim],1020);r.step([claim],1030);r.reopen();const s=r.state();
 assert.equal(s.money.supply,'200000000');assert.equal(s.money.fees,'1000');assert.equal(s.exchangeBook.total,'0');assert.equal(s.exchangeBook.orders[o.id].status,'CLAIMED');
 assert.deepEqual(s.money.outputs[exchangeOutput(hash(r.c),o.id,'settlement')],{owner:direction==='BUY_DUBYT'?r.user.publicKey:r.provider.publicKey,value:'10000001',unlock:0});
 const request={type:'exchange-order',id:o.id},proof=queryBounded(r.db,request,r.db.root);assert.equal(verifyBoundedQuery(proof,request,r.db.root,hash(r.c)).data.status,'CLAIMED');proof.result.data.status='LOCKED';assert.throws(()=>verifyBoundedQuery(proof,request,r.db.root,hash(r.c)));
 }finally{r.db.close();}
});
test('failed block, double spend and leaked external preimage preserve escrow',()=>{const r=rig();try{const o=r.order('SELL_DUBYT','USDC'),tx=r.wire(o.lock,[o.input],o.payer),root=r.db.root;
 assert.throws(()=>r.step([r.wire(o.lock,[o.input],keys())]));assert.equal(r.db.root,root);
 assert.throws(()=>r.step([tx],1000,{beforeCommit(){throw Error('power loss');}}));r.reopen();assert.equal(r.db.root,root);
 const other=r.order('SELL_DUBYT');assert.throws(()=>r.step([tx,r.wire(other.lock,[o.input],o.payer)]));assert.equal(r.db.root,root);r.step([tx]);const locked=r.db.root;
 assert.throws(()=>r.step([r.wire({type:'CLAIM',id:o.id,secret:o.secret})],1020));assert.equal(r.db.root,locked);
 const bad=o.claim();bad.settlement.signatures[1]=bad.settlement.signatures[0];assert.throws(()=>r.step([r.wire(bad)],1020));assert.equal(r.db.root,locked);
 assert.throws(()=>r.step([r.wire(other.lock,[exchangeOutput(hash(r.c),o.id,'escrow')],o.payer)]));assert.equal(r.db.root,locked);
 }finally{r.db.close();}});
test('UTC expiry returns principal once, preserves fee and rejects late claim',()=>{for(const direction of ['BUY_DUBYT','SELL_DUBYT']){const r=rig();try{const o=r.order(direction);r.step([r.wire(o.lock,[o.input],o.payer)]);const refund=r.wire({type:'REFUND',id:o.id});assert.throws(()=>r.step([refund],o.q.dubytUntil-1));r.step([refund],o.q.dubytUntil);r.reopen();r.step([refund],o.q.dubytUntil+10);assert.throws(()=>r.step([r.wire(o.claim())],o.q.dubytUntil+20));const s=r.state();assert.equal(s.money.outputs[exchangeOutput(hash(r.c),o.id,'settlement')].owner,o.payer.publicKey);assert.equal(s.money.fees,'1000');assert.equal(s.money.supply,'200000000');}finally{r.db.close();}}});
test('mainnet and unpinned exchange configurations rejected',()=>{const f=exchangeFixture();assert.throws(()=>validateConfig({...f.c,chainId:'duebyte-trial-production'}));const c=structuredClone(f.c);c.exchangeLab.policy.routes.USDC.network='base-mainnet';assert.throws(()=>validateConfig(c));});
