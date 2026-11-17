import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {keys,sign} from '../crypto.mjs';
import {ProviderExchange,providerConsent} from '../exchange-provider.mjs';
import {ChangeNowAdapter,ChangeNowTransport} from '../exchange-changenow.mjs';
import {ExchangeBrokerAPI,exchangeBrokerServer} from '../exchange-broker-api.mjs';
import {WalletBroker,brokerTransport} from '../wallet-broker.mjs';
import {Wallet} from '../wallet.mjs';
import {PROFILE} from '../core.mjs';
import {fixture as moneyFixture} from '../../research/transition-core-20261103/fixture.mjs';
import {changeNowSimulator} from './support/changenow-simulator.mjs';
import {exchangeFixture} from './helpers/exchange-native-fixture.mjs';
const START=1800000000000;
async function fixture(t) {
  let now=START;const clock=()=>now,dir=mkdtempSync(join(tmpdir(),'changenow-contract-')),m=moneyFixture(),owner=m.alice,signer=keys();
  const sim=changeNowSimulator({file:join(dir,'provider.sqlite'),clock,payinAddress:m.bob.publicKey});sim.server.listen(0,'127.0.0.1');await once(sim.server,'listening');
  const routes=['BTC','USDT','USDC','XMR'].flatMap(symbol=>['standard','fixed-rate'].flatMap(flow=>[
    {from:'DUBYT',to:symbol,fromCurrency:'simdubyt',toCurrency:'sim'+symbol.toLowerCase(),fromNetwork:'simduebyte',toNetwork:'sim'+symbol.toLowerCase(),flow,feeSymbol:symbol},
    {from:symbol,to:'DUBYT',fromCurrency:'sim'+symbol.toLowerCase(),toCurrency:'simdubyt',fromNetwork:'sim'+symbol.toLowerCase(),toNetwork:'simduebyte',flow,feeSymbol:'DUBYT'}]));
  const transport=new ChangeNowTransport({environment:'simulation',simulationUrl:`http://127.0.0.1:${sim.server.address().port}/`,credentials:async()=>({environment:'simulation',key:'simulation-only'}),clock});
  const adapter=new ChangeNowAdapter({transport,routes,clock,admit:async c=>c.owner===owner.publicKey&&c.account==='sim-account'});
  let db=new DatabaseSync(join(dir,'commands.sqlite'));const options={adapter,scope:'isolated-swap',storageKey:Buffer.alloc(32,3),signingKey:signer,clock};let engine=new ProviderExchange(db,options);
  const provider={id:'changenow',label:'ChangeNOW simulation',environment:'simulation',engine,binding:async o=>o===owner.publicKey?{account:'sim-account',expiresAt:START+86400000,routes,destinations:[]}:null};
  const apiDB=new DatabaseSync(join(dir,'api.sqlite')),api=new ExchangeBrokerAPI({db:apiDB,scope:'sim-broker',signer,providers:[provider],clock});
  const server=exchangeBrokerServer(api);server.listen(0,'127.0.0.1');await once(server,'listening');
  const profile={url:`http://127.0.0.1:${server.address().port}/exchange/v1`,scope:'sim-broker',key:signer.publicKey,providers:[{id:provider.id,label:provider.label,scope:engine.scope,identity:adapter.identity,reviewKey:signer.publicKey}]};
  const lab=exchangeFixture();const config={profile:PROFILE,chainId:lab.c.chainId,initial:m.state,trialOnly:true,exchangeLab:lab.c.exchangeLab};
  const walletOptions={client:{config,sync:async()=>({state:{money:structuredClone(m.state)}})},key:owner,home:join(dir,'wallet'),routes:Object.fromEntries(Object.keys(m.state.nodes).map(id=>[id,'http://127.0.0.1:1'])),url:'http://127.0.0.1:1',checkpoint:{}};
  mkdirSync(walletOptions.home);let wallet=new Wallet(walletOptions),loseBroker=false,broadcasts=0;
  const request=async msg=>{const r=await brokerTransport(profile,{testLoopback:true})(msg);if(loseBroker&&msg.body.action==='accept')throw Error('lost reply');return r;};
  const walletSetup=()=>{wallet.resume=async pid=>{broadcasts++;throw Error('simulated broadcast reply loss');};return new WalletBroker(wallet,{profile,request,clock});};let client=walletSetup();
  t.after(async()=>{await server.drainExchangeRecovery();await new Promise(r=>server.close(r));wallet.close();db.close();apiDB.close();await sim.close();});
  const requestBody=(symbol='USDT',buy=false,flow='fixed-rate')=>{const r=routes.find(r=>r.from===(buy?symbol:'DUBYT')&&r.to===(buy?'DUBYT':symbol)&&r.flow===flow);return {kind:'swap',from:r.from,to:r.to,amount:'1',fromNetwork:r.fromNetwork,toNetwork:r.toNetwork,flow,address:buy?owner.publicKey:'sim-recipient',extraId:buy?'':'memo-123',refundAddress:buy?'sim-refund':owner.publicKey,refundExtraId:buy?'refund-memo':''};};
  return {sim,adapter,transport,provider,api,profile,owner,signer,options,dir,clock,requestBody,get engine(){return engine;},get client(){return client;},get wallet(){return wallet;},get broadcasts(){return broadcasts;},
    advance:(ms=31000)=>now+=ms,loseBroker:()=>loseBroker=true,
    quote:(q=requestBody())=>client.review({provider:'changenow',request:q,parent:null}),
    status:async()=>{await engine.recover();return (await client.status({provider:'changenow'})).orders[0];},
    restart:()=>{client.close();wallet.close();db.close();db=new DatabaseSync(join(dir,'commands.sqlite'));engine=new ProviderExchange(db,options);provider.engine=engine;wallet=new Wallet(walletOptions);client=walletSetup();}};
}
test('four currencies and both directions share signed swap terms, exact network and refund ownership',async t=>{
  const f=await fixture(t);assert.equal((await f.client.availability()).providers[0].capability,'deposit_swap');
  for(const symbol of ['BTC','USDC','USDT','XMR'])for(const buy of [false,true]){const q=f.requestBody(symbol,buy),v=await f.quote(q);assert.equal(v.review.kind,'swap');assert.equal(v.review.terms.address,q.address);assert.equal(v.review.terms.refundAddress,q.refundAddress);assert.equal(v.review.terms.to.amount,'0.75');}
  for(const q of [{...f.requestBody(),toNetwork:'other'},{...f.requestBody(),refundAddress:keys().publicKey},{...f.requestBody('BTC',true),address:keys().publicKey}])await assert.rejects(()=>f.quote(q));
  assert.equal(f.sim.control.posts,0);
});
test('known order survives wallet/server restart; staged exchange never claims independently verified delivery',async t=>{
  const f=await fixture(t),q=await f.quote(),accepted=await f.client.confirm({id:q.review.id}),id=accepted.result.reference;
  assert.equal(accepted.state,'SWAP_WAITING');assert.equal(accepted.result.canDeposit,false);
  f.restart();f.advance();let v=await f.status();assert.equal(v.result.canDeposit,true);
  for(const [status,state] of [['confirming','SWAP_CONFIRMING'],['exchanging','SWAP_EXCHANGING'],['sending','SWAP_SENDING'],['finished','PROVIDER_COMPLETED']]) {
    f.advance();f.sim.set(id,{status,amountFrom:'1',payinHash:'sim-pay-in',payoutHash:status==='finished'?'sim-pay-out':null,amountTo:status==='finished'?'0.75':null,updatedAt:new Date(f.clock()).toISOString()});v=await f.status();assert.equal(v.state,state);assert.equal(v.result.canDeposit,false);assert.equal(v.progress.delivered,false);
  }
  await f.client.confirm({id:q.review.id});assert.equal(f.sim.control.posts,1);assert.equal(v.result.actualReceive,'0.75');
});
test('lost broker reply recovers known ID; lost provider reply fences unknown creation without a duplicate',async t=>{
  for(const loss of ['broker','provider']){await t.test(loss,async t=>{const f=await fixture(t),q=await f.quote();if(loss==='broker')f.loseBroker();else f.sim.control.lostCreate=true;
    assert.equal((await f.client.confirm({id:q.review.id})).state,'UNKNOWN');f.restart();f.advance();const v=await f.status();assert.equal(v.state,loss==='broker'?'SWAP_WAITING':'ACTION_REQUIRED');
    await f.client.confirm({id:q.review.id});assert.equal(f.sim.control.posts,1);await assert.rejects(()=>f.quote());if(loss==='provider')assert.equal(v.result.canDeposit,false);
  });}
});
test('valid ID in malformed create response is retained and reconciled before showing deposit instructions',async t=>{
  const f=await fixture(t);f.sim.control.badCreate=true;const q=await f.quote(),v=await f.client.confirm({id:q.review.id});assert.equal(v.state,'SWAP_VERIFYING');assert(v.result.reference);f.advance();assert.equal((await f.status()).result.canDeposit,true);assert.equal(f.sim.control.posts,1);
});
test('rate limits persist through restart; response substitution never changes signed payment destination or fixed amount',async t=>{
  const f=await fixture(t),q=await f.quote(),v=await f.client.confirm({id:q.review.id}),id=v.result.reference;f.sim.control.statusCode=429;f.advance();assert.equal((await f.status()).errorCode,'RATE_LIMITED');const n=f.sim.control.gets;f.restart();await f.status();assert.equal(f.sim.control.gets,n);
  f.sim.control.statusCode=0;f.advance(61000);f.sim.set(id,{payoutAddress:'substituted'});assert.equal((await f.status()).errorCode,'RESPONSE_MISMATCH');
  f.sim.set(id,{payoutAddress:'sim-recipient',expectedAmountTo:'0.8'});f.advance();assert.equal((await f.status()).errorCode,'RESPONSE_MISMATCH');
  assert.equal(f.sim.control.posts,1);await assert.rejects(()=>f.client.fundingReview({id:q.review.id,unitScale:'1'}));
});
test('missing deadline and detected deposit disable payment; regressive status cannot ask for a second deposit',async t=>{
  const f=await fixture(t),q=await f.quote(),v=await f.client.confirm({id:q.review.id}),id=v.result.reference;
  f.sim.set(id,{validUntil:null});f.advance();assert.equal((await f.status()).result.canDeposit,false);
  f.sim.set(id,{validUntil:new Date(f.clock()+120000).toISOString(),amountFrom:'0',updatedAt:new Date(f.clock()).toISOString()});f.advance();assert.equal((await f.status()).result.canDeposit,true);
  f.sim.set(id,{status:'confirming',amountFrom:'1',updatedAt:new Date(f.clock()).toISOString()});f.advance();assert.equal((await f.status()).state,'SWAP_CONFIRMING');
  f.sim.set(id,{status:'verifying',updatedAt:new Date(f.clock()).toISOString()});f.advance();assert.equal((await f.status()).state,'SWAP_VERIFYING');
  f.sim.set(id,{status:'waiting',amountFrom:null,updatedAt:new Date(f.clock()).toISOString()});f.advance();assert.equal((await f.status()).result.canDeposit,false);
});
test('related swaps and refund reports need reconciliation, never assert returned wallet balance',async t=>{
  for(const mode of ['related','refund'])await t.test(mode,async t=>{const f=await fixture(t),q=await f.quote(),v=await f.client.confirm({id:q.review.id});f.sim.set(v.result.reference,mode==='related'?{relatedExchangesInfo:['another']}:{status:'refunded',refundHash:'sim-refund',refundAmount:'0.9'});f.advance();const r=await f.status();assert.equal(r.state,mode==='related'?'ACTION_REQUIRED':'REFUND_REPORTED');assert.equal(r.progress.delivered,false);assert.equal(r.result.canDeposit,false);});
});
test('native funding commits outgoing and exchange reference atomically; lost broadcast/reopen/double click keep one payment',async t=>{
  const f=await fixture(t),q=await f.quote();await f.client.confirm({id:q.review.id});f.advance();await f.status();const review=await f.client.fundingReview({id:q.review.id,unitScale:'1'});assert.equal(review.request.value,'1');
  const p=await f.client.fund({id:q.review.id});assert.equal(p.status,'RESULT_PENDING');assert(p.pid);assert.equal(f.wallet.db.prepare('SELECT count(*) n FROM outgoing').get().n,1);assert.equal(f.broadcasts,1);
  f.restart();assert.equal(f.client.cached()[0].fundingPid,p.pid);assert.equal((await f.client.fund({id:q.review.id})).pid,p.pid);assert.equal(f.broadcasts,1);assert.equal(f.wallet.db.prepare('SELECT count(*) n FROM outgoing').get().n,1);
  await assert.rejects(()=>f.client.fundingReview({id:q.review.id,unitScale:'1'}),/already prepared/);
});
test('native atomic callback failure rolls back the outgoing payment, and expired consent prepares nothing',async t=>{
  const f=await fixture(t);await assert.rejects(()=>f.wallet.prepareTokens({recipient:f.owner.publicKey,value:'1',unitScale:'1'},()=>{throw Error('commit failed');}),/commit failed/);assert.equal(f.wallet.db.prepare('SELECT count(*) n FROM outgoing').get().n,0);
  const q=await f.quote();await f.client.confirm({id:q.review.id});f.advance();await f.status();await f.client.fundingReview({id:q.review.id,unitScale:'1'});f.advance();await assert.rejects(()=>f.client.fund({id:q.review.id}),/expired/);assert.equal(f.wallet.db.prepare('SELECT count(*) n FROM outgoing').get().n,0);assert.equal(f.broadcasts,0);
});
test('transport cannot issue live orders, cross-host calls, redirects or use missing/mismatched credentials',async()=>{
  let calls=0;const t=new ChangeNowTransport({credentials:async()=>({environment:'production'}),fetchImpl:async()=>{calls++;throw Error();}});
  await assert.rejects(()=>t.request('POST','/v2/exchange',{}),/not qualified/);await assert.rejects(()=>t.request('GET','https://example.org/v2/exchange/by-id'));await assert.rejects(()=>t.request('GET','/v2/exchange/by-id?id=x'));assert.equal(calls,0);
  assert.throws(()=>new ChangeNowTransport({environment:'simulation',simulationUrl:'https://api.changenow.io/',credentials:async()=>({})}));
});
test('simulation cannot fund from a normal Home, and protected wallet deposits retain approval guard',async t=>{
 const f=await fixture(t),q=await f.quote();await f.client.confirm({id:q.review.id});f.advance();await f.status();
 const lab=f.wallet.client.config.exchangeLab;delete f.wallet.client.config.exchangeLab;
 await assert.rejects(()=>f.client.fundingReview({id:q.review.id,unitScale:'1'}),/isolated/);assert.equal(f.broadcasts,0);f.wallet.client.config.exchangeLab=lab;
 const sync=f.wallet.client.sync;f.wallet.client.sync=async()=>{const v=await sync();v.state.spendPolicies={[f.owner.publicKey]:{enabled:true}};return v;};
 f.wallet.resume=Wallet.prototype.resume.bind(f.wallet);f.wallet.broadcast=async()=>assert.fail('unapproved deposit broadcast');
 await f.client.fundingReview({id:q.review.id,unitScale:'1'});const p=await f.client.fund({id:q.review.id});assert.equal(p.status,'AWAITING_APPROVAL');assert(f.wallet.db.prepare('SELECT pid FROM approval_guard WHERE pid=?').get(p.pid));
});
test('nullable estimates after settlement do not lose payout evidence; fixed-rate discrepancy is explicit',async t=>{
 const f=await fixture(t),q=await f.quote(),a=await f.client.confirm({id:q.review.id});
 f.sim.set(a.result.reference,{status:'finished',expectedAmountFrom:null,expectedAmountTo:null,amountFrom:'1',amountTo:'0.7',payoutHash:'sim-payout'});f.advance();const v=await f.status();assert.equal(v.state,'PROVIDER_COMPLETED');assert(v.result.amountMismatch);assert.equal(v.result.actualReceive,'0.7');assert.equal(v.progress.delivered,false);
});
test('late status response cannot overwrite a newer deposit-confirming state after its poll lease expires',async t=>{
 const f=await fixture(t),q=await f.quote(),a=await f.client.confirm({id:q.review.id}),base=f.adapter.reconcile.bind(f.adapter);let release,started,first=true;
 const wait=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 f.adapter.reconcile=async c=>{const v=await base(c);if(first){first=false;started();await wait;}return v;};
 f.advance(6000);const old=f.engine.recover();await ready;f.advance(6000);f.sim.set(a.result.reference,{status:'confirming',amountFrom:'1',updatedAt:new Date(f.clock()).toISOString()});await f.engine.recover();release();await old;
 const v=f.engine.view(q.review.id,f.owner.publicKey);assert.equal(v.state,'SWAP_CONFIRMING');assert.equal(v.result.canDeposit,false);
});
test('abrupt process exit after provider creation retains UNKNOWN; recovery never sends another POST',async t=>{
 const f=await fixture(t),q=await f.quote(),input={owner:f.owner,signer:f.signer,request:f.requestBody(),routes:f.adapter.routes,review:q.review,dir:f.dir,now:f.clock()};
 writeFileSync(join(f.dir,'dispatch-input.json'),JSON.stringify(input));const script=join(f.dir,'dispatch-crash.mjs');
 const engineUrl=new URL('../exchange-provider.mjs',import.meta.url).href,adapterUrl=new URL('../exchange-changenow.mjs',import.meta.url).href,cryptoUrl=new URL('../crypto.mjs',import.meta.url).href;
 writeFileSync(script,`import {readFileSync,writeFileSync} from 'node:fs';import {DatabaseSync} from 'node:sqlite';import {join} from 'node:path';import {ProviderExchange,providerConsent} from ${JSON.stringify(engineUrl)};import {ChangeNowAdapter} from ${JSON.stringify(adapterUrl)};import {sign} from ${JSON.stringify(cryptoUrl)};const x=JSON.parse(readFileSync(new URL('./dispatch-input.json',import.meta.url)));const adapter=new ChangeNowAdapter({transport:{environment:'simulation',request:async(method,path)=>{if(method!=='POST')throw Error('unexpected call');writeFileSync(join(x.dir,'provider-created.txt'),'one simulated order accepted');process.exit(74);}},admit:async()=>true,routes:x.routes,clock:()=>x.now});const e=new ProviderExchange(new DatabaseSync(join(x.dir,'commands.sqlite')),{adapter,scope:'isolated-swap',storageKey:Buffer.alloc(32,3),signingKey:x.signer,clock:()=>x.now});await e.accept(x.review.id,x.owner.publicKey,sign(providerConsent(x.review),x.owner.privateKey));`);
 const child=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:20000});assert.equal(child.status,74,child.stderr);assert.equal(f.engine.view(q.review.id,f.owner.publicKey).state,'UNKNOWN');f.restart();f.advance();assert.equal((await f.status()).state,'ACTION_REQUIRED');await f.client.confirm({id:q.review.id});assert.equal(f.sim.control.posts,0);
});
test('abrupt process exit after native outgoing commit preserves funding ID before any broadcast',async t=>{
  const f=await fixture(t),q=await f.quote();await f.client.confirm({id:q.review.id});f.advance();await f.status();const review=await f.client.fundingReview({id:q.review.id,unitScale:'1'});
  const script=join(f.dir,'crash.mjs'),walletUrl=new URL('../wallet.mjs',import.meta.url).href;
  // Child uses the real Wallet prepare transaction with a verified fixture state; no network I/O.
  const stored=f.wallet.db.prepare('SELECT pin,review FROM wallet_broker_funding WHERE id=?').get(q.review.id);
  const config=f.wallet.client.config;const input={owner:f.owner,config,home:join(f.dir,'wallet'),review,pin:stored.pin,id:q.review.id,raw:stored.review};writeFileSync(join(f.dir,'input.json'),JSON.stringify(input));
  writeFileSync(script,`import {readFileSync} from 'node:fs';import {Wallet} from ${JSON.stringify(walletUrl)};const x=JSON.parse(readFileSync(new URL('./input.json',import.meta.url)));const w=new Wallet({key:x.owner,home:x.home,client:{config:x.config,sync:async()=>({state:{money:x.config.initial}})},routes:Object.fromEntries(Object.keys(x.config.initial.nodes).map(n=>[n,'http://127.0.0.1:1'])),url:'http://127.0.0.1:1',checkpoint:{}});await w.prepareTokens(x.review.request,p=>{w.db.prepare('UPDATE wallet_broker_funding SET pid=? WHERE pin=? AND id=? AND pid IS NULL').run(p.pid,x.pin,x.id);});process.exit(73);`);
  const child=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:20000});assert.equal(child.status,73,child.stderr);f.restart();const pid=f.client.cached()[0].fundingPid;assert(pid);assert.equal((await f.client.fund({id:q.review.id})).pid,pid);assert.equal(f.broadcasts,0);assert.equal(f.wallet.db.prepare('SELECT count(*) n FROM outgoing').get().n,1);
});
