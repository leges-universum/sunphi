import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {keys,sign,hash} from '../crypto.mjs';
import {ProviderExchange,providerConsent} from '../exchange-provider.mjs';
import {ExchangeBrokerAPI,exchangeBrokerServer,BROKER_API} from '../exchange-broker-api.mjs';
import {WalletBroker,brokerTransport} from '../wallet-broker.mjs';
import {bindingAdmission} from '../exchange-broker-run.mjs';
async function fixture(t) {
  let now=1800000000000,n=0,lose=false;const signer=keys(),owner=keys(),counts={one:0,two:0},all=[];
  const db=()=>{const d=new DatabaseSync(':memory:');all.push(d);return d;};
  const providers=['one','two'].map(id=>{
    const qs=new Map();const adapter={identity:'fixture:'+id,
      authorize:async c=>{assert.equal(c.account,'account-'+id);assert.equal(c.owner,owner.publicKey);},
      review:async({request})=>{const q='quote-'+ ++n,terms={from:{symbol:request.from,amount:request.amount},to:{symbol:request.to,amount:'1.25'},tradeFee:{symbol:request.to,amount:'0.01'}};qs.set(q,terms);return {reference:q,expiresAt:now+60000,terms,payload:{q}};},
      execute:async()=>{counts[id]++;return {state:'EXECUTING'};},reconcile:async()=>({state:'TRADED'})};
    const engine=new ProviderExchange(db(),{adapter,scope:id,storageKey:Buffer.alloc(32,4),signingKey:signer,clock:()=>now});
    return {id,label:'Fixture '+id,environment:'sandbox',engine,binding:async o=>o===owner.publicKey?{account:'account-'+id,expiresAt:now+60000,routes:[{from:'DUBYT',to:'BTC'}],destinations:[]}:null};
  });
  const api=new ExchangeBrokerAPI({db:db(),scope:'test-broker',signer,providers,clock:()=>now});
  const server=exchangeBrokerServer(api);server.listen(0,'127.0.0.1');await once(server,'listening');
  const profile={url:`http://127.0.0.1:${server.address().port}/exchange/v1`,scope:'test-broker',key:signer.publicKey,providers:providers.map(p=>({id:p.id,label:p.label,scope:p.engine.scope,identity:p.engine.adapter.identity,reviewKey:signer.publicKey}))};
  const transport=brokerTransport(profile,{testLoopback:true});
  const request=async m=>{const r=await transport(m);if(lose&&m.body.action==='accept')throw new Error('lost HTTP response');return r;};
  const wallet={key:owner,db:db()},options={profile,request,clock:()=>now};const client=new WalletBroker(wallet,options);
  t.after(async()=>{await new Promise(r=>server.close(r));all.forEach(d=>d.close());});
  return {api,server,providers,profile,wallet,options,client,owner,counts,advance:()=>now+=31000,lose:()=>lose=true,
    quote:(provider='one')=>client.review({provider,request:{kind:'trade',from:'DUBYT',to:'BTC',amount:'1'},parent:null}),
    message:(action,payload)=>{const body={domain:BROKER_API,scope:'test-broker',owner:owner.publicKey,at:now,nonce:hash(++n),action,payload};return {body,signature:sign(body,owner.privateKey)};}};
}
test('wallet -> signed HTTP API -> account-bound provider, replay isolation and two-provider routing',async t=>{
  const f=await fixture(t);assert.equal((await f.client.availability()).providers.length,2);
  const m=f.message('review',{provider:'one',request:{kind:'trade',from:'DUBYT',to:'BTC',amount:'1'},parent:null});
  const a=await f.api.call(m),b=await f.api.call(m);assert.deepEqual(a,b);
  const o=await f.quote('two');assert.equal(o.review.account,'account-two');await f.client.confirm({id:o.review.id});
  assert.deepEqual(f.counts,{one:0,two:1});
  await assert.rejects(()=>f.quote('one'),/Resolve/);f.advance();await f.api.recover();
  const status=await f.client.status({provider:'two',offset:0});assert.equal(status.orders[0].state,'TRADED');
  assert.equal((await f.client.status({provider:'one',offset:0})).orders[0].review.account,'account-one');
});
test('lost HTTP reply and wallet reopen retain provider and consent; status recovers without resubmission',async t=>{
  const f=await fixture(t),o=await f.quote();f.lose();assert.equal((await f.client.confirm({id:o.review.id})).state,'UNKNOWN');
  f.client.close();const reopened=new WalletBroker(f.wallet,f.options);
  assert.equal(reopened.cached()[0].provider,'one');assert.equal(reopened.cached()[0].state,'UNKNOWN');
  f.advance();await f.api.recover();const status=await reopened.status({provider:'one',offset:0});assert.equal(status.orders[0].state,'TRADED');
  assert.equal(f.counts.one,1);assert.equal(f.counts.two,0);
});
test('wallet/auth/nonce/provider substitution and account injection are rejected',async t=>{
  const f=await fixture(t),m=f.message('availability',{});m.body.owner=keys().publicKey;await assert.rejects(()=>f.api.call(m),/authentication/);
  await assert.rejects(()=>f.api.call(f.message('review',{provider:'one',account:'someone-else',request:{kind:'trade',from:'DUBYT',to:'BTC',amount:'1'},parent:null})),/exact fields/);
  await assert.rejects(()=>f.client.review({provider:'unknown',request:{kind:'trade'},parent:null}),/not trusted/);
  const key=keys(),body={...f.message('availability',{}).body,owner:key.publicKey};
  const r=await f.api.call({body,signature:sign(body,key.privateKey)});assert(r.body.result.providers.every(p=>!p.admitted));
  const malicious=new WalletBroker(f.wallet,{...f.options,request:async()=>({body:{domain:BROKER_API+'/REPLY',requestHash:'x',result:{}},signature:'x'})});
  await assert.rejects(()=>malicious.availability());
  assert.throws(()=>brokerTransport(f.profile),/URL/); // plaintext only in explicit isolated test transport
});
test('wallet changed during request cannot save the old account response',async t=>{
  const f=await fixture(t);let finish;const request=m=>new Promise(r=>finish=async()=>r(await f.api.call(m)));
  const c=new WalletBroker(f.wallet,{...f.options,request});const p=c.availability();c.close();await finish();await assert.rejects(()=>p,/changed/);
});
test('server admission excludes expired account, wrong chain/address and undeclared pairs',async()=>{
  const b={owner:'a',account:'acct',expiresAt:100,routes:[{from:'DUBYT',to:'USDT'}],destinations:[{symbol:'USDT',methodId:'m',network:'ethereum',addressId:'id',address:'a',tag:'',memo:''}]};
  const admit=bindingAdmission([b],()=>50),context={owner:'a',account:'acct'};
  assert(await admit({...context,request:{kind:'trade',from:'DUBYT',to:'USDT'}}));
  assert(!await admit({...context,request:{kind:'trade',from:'DUBYT',to:'XMR'}}));
  assert(!await admit({...context,request:{kind:'withdraw',...b.destinations[0],network:'tron'}}));
  assert(!await bindingAdmission([b],()=>101)({...context,request:{kind:'trade',from:'DUBYT',to:'USDT'}}));
});

test('closing wallet while confirmation is in flight preserves consent without writing to a closed database',async t=>{
 const f=await fixture(t),o=await f.quote();let finish;
 const c=new WalletBroker(f.wallet,{...f.options,request:m=>new Promise(r=>finish=async()=>r(await f.api.call(m)))});
 const pending=c.confirm({id:o.review.id});c.close();await finish();await assert.rejects(()=>pending,/changed/);
 assert.equal(f.wallet.db.prepare('SELECT count(*) n FROM wallet_broker_outbox WHERE consent IS NOT NULL').get().n,1);
 const reopened=new WalletBroker(f.wallet,f.options);assert.equal((await reopened.status({provider:'one'})).orders[0].state,'EXECUTING');assert.equal(f.counts.one,1);
});

test('pagination stays owner-scoped and expired unaccepted reviews never dispatch',async t=>{
 const f=await fixture(t);for(let i=0;i<21;i++)await f.quote();
 const first=await f.client.status({provider:'one',offset:0}),second=await f.client.status({provider:'one',offset:20});
 assert.equal(first.orders.length,20);assert.equal(first.hasMore,true);assert.equal(second.orders.length,1);assert.equal(second.hasMore,false);
 assert(!first.orders.some(o=>o.review.id===second.orders[0].review.id));
 const stranger=keys(),m=f.message('status',{provider:'one',offset:0});m.body.owner=stranger.publicKey;m.signature=sign(m.body,stranger.privateKey);
 assert.equal((await f.api.call(m)).body.result.orders.length,0);
 f.advance();f.advance();assert.equal((await f.client.status({provider:'one'})).orders[0].state,'EXPIRED');
 await assert.rejects(()=>f.client.confirm({id:first.orders[0].review.id}),/expired/);assert.equal(f.counts.one,0);
});

test('unresolved consent beyond the visible history window still blocks a different provider',async t=>{
 const f=await fixture(t),o=await f.quote();await f.client.confirm({id:o.review.id});
 const row=f.wallet.db.prepare('SELECT * FROM wallet_broker_outbox WHERE id=?').get(o.review.id);
 for(let i=0;i<81;i++)f.wallet.db.prepare('INSERT INTO wallet_broker_outbox VALUES(?,?,?,?,NULL,?)').run(row.pin,'fixture-old-'+i,row.provider,row.review,JSON.stringify({...JSON.parse(row.view),state:'EXPIRED'}));
 assert(!f.client.cached().some(v=>v.hasConsent));await assert.rejects(()=>f.quote('two'),/Resolve/);assert.equal(f.counts.two,0);
});

test('concurrent confirmations at different providers cannot bypass owner pending-operation fence',async t=>{
 const f=await fixture(t),one=await f.quote('one'),two=await f.quote('two');
 const requests=[['one',one],['two',two]].map(([provider,v])=>f.message('accept',{provider,id:v.review.id,consent:sign(providerConsent(v.review),f.owner.privateKey)}));
 const results=await Promise.allSettled(requests.map(m=>f.api.call(m)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.counts.one+f.counts.two,1);
});
