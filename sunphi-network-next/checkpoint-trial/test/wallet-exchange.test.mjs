import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
import {exchangeFixture} from './helpers/exchange-native-fixture.mjs';import {hash,verify} from '../crypto.mjs';import {envelope} from '../core.mjs';
import {WalletExchange,exchangeLabTransport} from '../wallet-exchange.mjs';import {EXCHANGE_ACTION} from '../research/exchange-native.mjs';
import {BoundedNetworkInterpreter} from '../research/bounded-network-interpreter.mjs';import {queryBounded} from '../research/bounded-query.mjs';import {loadBoundedWalletView} from '../research/bounded-wallet-view.mjs';
import {createServer} from 'node:http';import {ExchangeLabService} from '../research/exchange-lab-service.mjs';
import {resolutionFixture} from './helpers/exchange-resolution-fixture.mjs';
import {randomBytes} from 'node:crypto';
import {SigningCoordinator,coordinatorChannel} from '../research/exchange-signing-coordinator.mjs';
import {MAX_ADMITTED_ORDERS} from '../research/exchange-coordinator-capacity.mjs';
function rig(factory=exchangeFixture){const f=factory();fs.mkdirSync('F:/DueByteWork/wallet-exchange-tests',{recursive:true});const dir=fs.mkdtempSync('F:/DueByteWork/wallet-exchange-tests/run-'),db=BoundedNetworkInterpreter.create(dir+'/state',f.s,f.c,hash(f.s));let now=1000,flow,fail=false,sends=0;
 const step=txs=>db.commitBlock({height:db.networkHeader().height+1,time:now,blockHash:hash([db.networkHeader().height+1,now]),txs:txs.map(x=>Buffer.from(JSON.stringify(x)))},db.root);
 const w={key:f.user,client:{config:f.c},db:new DatabaseSync(dir+'/wallet'),async view(){const h=db.networkHeader().height,{state}=await loadBoundedWalletView(async(req,root)=>queryBounded(db,req,root),{root:db.root,height:h,configHash:hash(f.c),owner:f.user.publicKey,allowIsolated:true});return {state,certificate:{height:h+1,appHeight:h,appHash:db.root}};},async broadcast(wire){sends++;step([wire]);if(fail)throw Error('reply lost');return {admitted:true};}};
 const request=async m=>{assert(verify(m.body,m.signature,f.user.publicKey));if(m.body.action==='accept'){const command=m.body.payload;step([envelope(f.c,{type:EXCHANGE_ACTION,command,inputs:[f.inputs.provider]},f.provider)]);if(fail)throw Error('reply lost');return {untrustedStatus:'CLAIMED'};}throw Error('unexpected route');};
 const reopen=()=>{flow?.close();flow=new WalletExchange(w,{clock:()=>now,request});};reopen();
 return {...f,w,db,step,get flow(){return flow;},get sends(){return sends;},set time(n){now=n;},set fail(v){fail=v;},reopen,close(){flow.close();w.db.close();db.close();}};
}
const offer=o=>({quote:o.q,providerSignature:o.lock.providerSignature});
for(const direction of ['BUY_DUBYT','SELL_DUBYT'])for(const asset of ['BTC','USDC'])for(const outcome of ['PAYOUT','REFUND','CANCELLED'])test(direction+' '+asset+' armed wallet survives outage and shows verified '+outcome,async()=>{
 const r=rig(resolutionFixture);try{
  const o=r.order(direction,asset),review=await r.flow.review(offer(o));await r.flow.confirm({id:review.review});r.step([JSON.parse(r.wire(o.arm))]);r.time=5000;r.step([]);r.reopen();
  const pending=(await r.flow.status()).orders[0];assert.equal(pending.status,'LOCKED');assert(pending.awaitingOutcome);assert(!pending.canRefund);const sent=r.sends;
  await assert.rejects(r.flow.refund({id:o.id}),/verified external outcome/);assert.equal(r.sends,sent);
  r.step([JSON.parse(r.wire(o.resolve(outcome,5000)))]);r.reopen();const finished=(await r.flow.status()).orders[0];assert.equal(finished.status,outcome==='PAYOUT'?'CLAIMED':'REFUNDED');assert(finished.verified);assert(!finished.awaitingOutcome);assert(!finished.canRefund);assert.equal(r.db.snapshotForAudit().money.supply,'200000000');
 }finally{r.close();}
});
for(const direction of ['BUY_DUBYT','SELL_DUBYT'])test(direction+' local review, consensus status and durable ambiguous-response recovery',async()=>{const r=rig();try{const o=r.order(direction,'USDC'),review=await r.flow.review(offer(o));assert.equal(review.dubyt,'10.000001');assert.equal(review.external,'0.123456');assert.equal(r.db.snapshotForAudit().money.fees,'0');r.fail=true;await assert.rejects(r.flow.confirm({id:review.review}),/reply lost/);r.reopen();const s=await r.flow.status();assert.equal(s.orders[0].status,'LOCKED');assert(s.orders[0].verified);const before=r.db.root;await r.flow.resume({id:o.id});assert.equal(r.db.root,before);assert.equal(r.db.snapshotForAudit().money.fees,'1000');await assert.rejects(r.flow.review(offer(r.order(direction))));r.time=1020;r.step([JSON.parse(r.wire(o.claim()))]);assert.equal((await r.flow.status()).orders[0].status,'CLAIMED');assert.equal(r.db.snapshotForAudit().money.supply,'200000000');}finally{r.close();}});
test('expiry refund, repeat submission and same journal after reopening',async()=>{const r=rig();try{const o=r.order('SELL_DUBYT'),q=await r.flow.review(offer(o));const ack=await r.flow.confirm({id:q.review});assert.equal(ack.status,'SUBMITTED');assert(!ack.verified);await assert.rejects(r.flow.refund({id:o.id}));r.time=o.q.dubytUntil;r.step([]);assert((await r.flow.status()).orders[0].canRefund);const ack2=await r.flow.refund({id:o.id});assert(!ack2.verified);r.reopen();assert.equal((await r.flow.status()).orders[0].status,'REFUNDED');await assert.rejects(r.flow.refund({id:o.id}));assert.equal(r.db.snapshotForAudit().money.fees,'1000');}finally{r.close();}});
test('tampering, changed wallet, stale review and stale state never sign or broadcast',async()=>{const r=rig();try{const o=r.order('SELL_DUBYT'),bad=offer(o);bad.quote={...o.q,externalAtomic:'1'};await assert.rejects(r.flow.review(bad));const q=await r.flow.review(offer(o));r.time=1121;await assert.rejects(r.flow.confirm({id:q.review}),/expired/);assert.equal(r.sends,0);await assert.rejects(r.flow.review(offer(o)),/Fresh/);r.time=1000;const valid=r.w.view;r.w.view=async()=>{const v=await valid();v.state.money.fees='123';return v;};await assert.rejects(r.flow.review(offer(o)),/modified/);r.w.view=valid;r.flow.close();await assert.rejects(r.flow.status(),/locked/);assert.equal(r.sends,0);}finally{r.close();}});
test('quote response cannot change user-selected terms; loopback and chain pins enforced',async()=>{const r=rig();try{const o=r.order('SELL_DUBYT','USDC');r.flow.request=async()=>offer(o);await assert.rejects(r.flow.quote({direction:'SELL_DUBYT',asset:'USDC',amount:'99',address:o.q.externalRecipient}));for(const url of ['https://example.com/','http://localhost/','http://127.0.0.1/private','http://user@127.0.0.1/'])assert.throws(()=>exchangeLabTransport({url,configHash:hash(r.c)},r.c));assert.throws(()=>exchangeLabTransport({url:'http://127.0.0.1:1234/',configHash:hash('wrong')},r.c));}finally{r.close();}});
test('unfunded expired request does not permanently block the next exchange',async()=>{const r=rig();try{const o=r.order('BUY_DUBYT');r.flow.request=async()=>{throw Error('offline');};const q=await r.flow.review(offer(o));await assert.rejects(r.flow.confirm({id:q.review}));r.time=o.q.quoteUntil+1;r.step([]);assert.equal((await r.flow.status()).orders[0].status,'EXPIRED_UNFUNDED');assert.equal((await r.flow.resume({id:o.id})).status,'EXPIRED_UNFUNDED');assert((await r.flow.review(offer(r.order('SELL_DUBYT','BTC',o.q.quoteUntil+1)))).review);}finally{r.close();}});
test('signed loopback API, local provider wallet, user wallet and consensus complete both directions',async()=>{
 for(const direction of ['BUY_DUBYT','SELL_DUBYT'])for(const asset of ['BTC','USDC']){
  const r=rig(),providerDb=new DatabaseSync(':memory:');let offered;
  const provider={key:r.provider,client:{config:r.c},db:providerDb,async view(){const height=r.db.networkHeader().height,{state}=await loadBoundedWalletView(async(q,root)=>queryBounded(r.db,q,root),{root:r.db.root,height,configHash:hash(r.c),owner:r.provider.publicKey,allowIsolated:true});return {state,certificate:{height:height+1,appHeight:height,appHash:r.db.root}};},async broadcast(wire){r.step([wire]);return {admitted:true};}};
  const service=new ExchangeLabService(provider,{clock:()=>r.db.snapshotForAudit().money.time,createQuote:async(owner,request,time)=>{offered=r.order(request.direction,request.asset,time);return offered.q;}});
  const server=createServer(async(req,res)=>{try{assert.equal(req.method,'POST');let size=0,chunks=[];for await(const part of req){size+=part.length;assert(size<16384);chunks.push(part);}const result=await service.handle(JSON.parse(Buffer.concat(chunks)));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));}catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}));}});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));try{
   r.flow.request=exchangeLabTransport({configHash:hash(r.c),url:'http://127.0.0.1:'+server.address().port+'/'},r.c);
   const sample=r.order(direction,asset),review=await r.flow.quote({direction,asset,amount:'10.000001',address:sample.q[direction==='BUY_DUBYT'?'externalRefund':'externalRecipient']});await r.flow.confirm({id:review.review});assert.equal((await r.flow.status()).orders[0].status,'LOCKED');r.time=1020;r.step([JSON.parse(r.wire(offered.claim()))]);assert.equal((await r.flow.status()).orders[0].status,'CLAIMED');
   const bad=await fetch('http://127.0.0.1:'+server.address().port+'/',{method:'POST',body:JSON.stringify({body:{},signature:'forged'})});assert.equal(bad.status,400);assert.equal(r.db.snapshotForAudit().money.supply,'200000000');
  }finally{service.close();server.closeAllConnections();await new Promise(ok=>server.close(ok));providerDb.close();r.close();}
 }
});

for(const direction of ['BUY_DUBYT','SELL_DUBYT'])test(direction+' V2 API exposes only journal-admitted offers at the capacity boundary',async()=>{
 const r=rig(resolutionFixture),providerDb=new DatabaseSync(':memory:');
 const dir=fs.mkdtempSync('F:/DueByteWork/wallet-exchange-tests/capacity-'),key=randomBytes(32);
 const coordinator=new SigningCoordinator(dir+'/journal.sqlite',{config:r.c,key,create:true}),channel=coordinatorChannel(coordinator,coordinator.activate());
 let offered=r.order(direction,'USDC');const admitted=offered;
 const provider={key:r.provider,client:{config:r.c},db:providerDb,async view(){const height=r.db.networkHeader().height,{state}=await loadBoundedWalletView(async(q,root)=>queryBounded(r.db,q,root),{root:r.db.root,height,configHash:hash(r.c),owner:r.provider.publicKey,allowIsolated:true});return {state,certificate:{height:height+1,appHeight:height,appHash:r.db.root}};},async broadcast(wire){r.step([wire]);return {admitted:true};}};
 const service=new ExchangeLabService(provider,{clock:()=>1000,createQuote:async()=>offered.q,admitOrder:order=>channel.admit(order)});
 r.flow.request=m=>service.handle(m);
 const request=()=>({direction,asset:'USDC',amount:'10.000001',address:offered.q[direction==='BUY_DUBYT'?'externalRefund':'externalRecipient']});
 try{
  await channel.admit(admitted.id);for(let i=1;i<MAX_ADMITTED_ORDERS;i++)await channel.admit(hash(['full relay',i]));
  offered=r.order(direction,'USDC');const before=r.db.root;
  await assert.rejects(r.flow.quote(request()),/admission capacity/);
  assert.equal(providerDb.prepare('SELECT count(*) AS n FROM exchange_lab_offers').get().n,0);assert.equal(r.db.root,before);
  offered=admitted;const review=await r.flow.quote(request());await r.flow.confirm({id:review.review});
  assert.equal((await r.flow.status()).orders[0].status,'LOCKED');
  assert.equal(coordinator.recoverySnapshot().admissions.length,MAX_ADMITTED_ORDERS);
 }finally{service.close();providerDb.close();coordinator.close();key.fill(0);r.close();}
});
