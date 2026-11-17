import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {publicServer} from '../public-rpc.mjs';
import {Wallet} from '../wallet.mjs';
import {collectWorkReceipts,WalletWorkError} from '../wallet-work.mjs';
import {fragmentedFixture,inputRig} from './helpers/payment-input-fixture.mjs';
import {hash,keys} from '../crypto.mjs';
import {workReceipt} from '../core.mjs';
import {loadBoundedWalletView} from '../research/bounded-wallet-view.mjs';
import {queryBounded} from '../research/bounded-query.mjs';

test('empty Home routes: allowlisted gateway, proved worker keys, restart and exactly one settlement',async()=>{
 const x=fragmentedFixture(),r=inputRig(x);r.enable();const ids=Object.keys(r.state.money.nodes),ports=Object.fromEntries(ids.map((n,i)=>[n,22001+i*10]));
 let mutate=null,active=0,peak=0,calls=0;
 const gateway=publicServer({kind:'rpc',target:22001,workers:ports},{upstream:async(url,options)=>{
  active++;peak=Math.max(peak,active);try{calls++;await new Promise(ok=>setTimeout(ok,5));const q=JSON.parse(options.body),data=JSON.parse(Buffer.from(q.params.data,'hex'));assert.deepEqual(Object.keys(data).sort(),['index','pid']);
   const node=ids.find(n=>url==='http://127.0.0.1:'+ports[n]+'/');assert(node);let receipt=workReceipt(r.state,data.pid,data.index,node,x.key(node));if(mutate)receipt=mutate(receipt);
   return Response.json({jsonrpc:'2.0',id:q.id,result:{response:{code:0,value:Buffer.from(JSON.stringify(receipt)).toString('base64')}}});
  }finally{active--;}
 }});await new Promise(ok=>gateway.listen(0,'127.0.0.1',ok));
 const url='http://127.0.0.1:'+gateway.address().port,home=join(r.directory,'wallet');fs.mkdirSync(home);const observed=[];
 const client={config:x.c,bounded:true,sync:async(_d,_u,o)=>({...await loadBoundedWalletView((q,root)=>{observed.push(q);return queryBounded(r.db,q,root);},{root:r.db.root,height:r.state.height,configHash:hash(x.c),...o}),certificate:{appHash:r.db.root,appHeight:r.state.height}})};
 const options={client,key:x.f.alice,home,url,routes:{},checkpoint:{}};let wallet=new Wallet(options);
 try{
  const quote=await wallet.quote('3','1000000'),p=await wallet.prepareTokens({recipient:x.f.bob.publicKey,value:'3',...Object.fromEntries(['unitScale','fee','abortFee','feeSchedule','partsCount'].filter(k=>quote[k]!==undefined).map(k=>[k,quote[k]]))});assert.equal(calls,0,'probes do not call workers');
  const wire=JSON.parse(wallet.db.prepare('select body from outgoing where pid=?').get(p.pid).body);r.step([wire]);wallet.close();r.reopen();wallet=new Wallet(options);
  const {state}=await wallet.view(),assigned=[...new Set(state.money.requests[p.pid].intent.parts.flatMap(p=>p.nodes))];for(const n of assigned)assert.equal(state.money.nodes[n].key,r.state.money.nodes[n].key);
  const request={state,pid:p.pid,routes:{},gateway:url,configHash:hash(x.c)};
  for(const change of [v=>({...v,node:hash('wrong node')}),v=>({...v,signature:keys().publicKey}),v=>({...v,profileSignature:keys().publicKey})]){mutate=change;await assert.rejects(collectWorkReceipts(request),WalletWorkError);assert.equal(r.state.money.requests[p.pid].status,'RESERVED');}
  mutate=null;wallet.broadcast=async w=>{r.step([w]);return {admitted:true};};assert.equal((await wallet.resume(p.pid)).status,'SETTLEMENT_SUBMITTED');assert.equal(r.state.money.requests[p.pid].status,'SETTLED');assert.equal((await wallet.resume(p.pid)).status,'SETTLED');assert.equal(r.state.money.supply,x.s.money.supply);assert(peak<=4);r.reopen();
 }finally{wallet.close();r.close();gateway.closeAllConnections();await new Promise(ok=>gateway.close(ok));}
});

test('gateway rejects unknown workers and injected destinations before preparation',async()=>{
 const node='a'.repeat(64),pid='b'.repeat(64);let calls=0;const server=publicServer({kind:'rpc',target:22001,workers:{[node]:22011}},{upstream:async()=>{calls++;return Response.json({});}});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 const url='http://127.0.0.1:'+server.address().port,send=data=>fetch(url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'abci_query',params:{path:'/work',data:Buffer.from(JSON.stringify(data)).toString('hex')}})});
 try{for(const data of [{node:'c'.repeat(64)},{node,pid,index:32},{node,pid,index:-1},{node,pid,index:0,target:80},{node,pid,index:0,url:'http://external.invalid'},{node,pid:'invalid',index:0}])assert((await send(data)).status>=400);assert.equal(calls,0);
  const x=fragmentedFixture(),r=inputRig(x);r.enable();const home=join(r.directory,'wallet');fs.mkdirSync(home);const w=new Wallet({client:{config:x.c,sync:async()=>({state:r.state})},key:x.f.alice,home,routes:{},url});try{await assert.rejects(w.prepare(x.f.bob.publicKey,'3000000'),e=>e.paymentOutcome==='not_created'&&/routes/.test(e.message));assert.equal(w.db.prepare('select count(*) n from outgoing').get().n,0);}finally{w.close();r.close();}
 }finally{server.closeAllConnections();await new Promise(ok=>server.close(ok));}
 assert.throws(()=>publicServer({kind:'rpc',target:22001,workers:{[node]:'http://evil.invalid'}}),/policy/);
});
