import test from 'node:test';
import assert from 'node:assert/strict';
import {ChangeNowDiscovery,ChangeNowDiscoveryError,parseChangeNowJson,changeNowAmount} from '../exchange-changenow-discovery.mjs';
const requested={fromCurrency:'btc',fromNetwork:'btc',toCurrency:'usdt',toNetwork:'eth',flow:'standard'};
const catalog=[{ticker:'btc',network:'btc',sell:true,supportsFixedRate:true},{ticker:'usdt',network:'eth',buy:true,supportsFixedRate:true}];
const credentials=async()=>({environment:'production',key:'test-key-not-real'});
const reply=x=>new Response(typeof x==='string'?x:JSON.stringify(x),{headers:{'Content-Type':'application/json'}});
function fixture(responses) {
  const calls=[];const client=new ChangeNowDiscovery({credentials,clock:()=>1800000000000,fetchImpl:async(url,options)=>{
    calls.push({url,options});const next=responses.shift();if(next instanceof Error)throw next;return next;
  }});return {client,calls};
}
test('JSON monetary tokens survive large integers, fractions and exponents without Number rounding',()=>{
  const x=parseChangeNowJson('{"large":9007199254740993.123456789012345678,"tiny":1e-12,"text":"1e-12","ok":true}');
  assert.equal(x.large,'9007199254740993.123456789012345678');assert.equal(x.tiny,'1e-12');assert.equal(x.ok,true);
  assert.equal(changeNowAmount(x.large),x.large);assert.equal(changeNowAmount(x.tiny),'0.000000000001');
  assert.equal(changeNowAmount('1.2300e2'),'123');assert.equal(changeNowAmount('0.0000'),'0');
  for(const bad of [0.1,'-1','NaN','1e-19','1e101','1e40','01','1.2x'])assert.throws(()=>changeNowAmount(bad));
});
test('discovery requires exact network and direction, performs only bounded GETs, never admits trading',async()=>{
  const raw='{"fromCurrency":"btc","fromNetwork":"btc","toCurrency":"usdt","toNetwork":"eth","flow":"standard","minAmount":1e-8,"maxAmount":9007199254740993.12345678}';
  const {client,calls}=fixture([reply(catalog),reply(raw)]);
  const r=await client.inspectRoute(requested);
  assert.equal(r.minAmount,'0.00000001');assert.equal(r.maxAmount,'9007199254740993.12345678');
  assert.equal(r.executionEnabled,false);assert.equal(r.admissionRequired,true);assert.equal(r.financialCommandsSent,0);
  assert.equal(calls.length,2);
  for(const {url,options} of calls){assert.equal(new URL(url).origin,'https://api.changenow.io');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.body,undefined);assert(options.signal);}
});
test('wrong network, missing native asset, disabled direction or fixed-rate never fall back to another network',async()=>{
  for(const data of [catalog.filter(x=>x.ticker!=='usdt'),[catalog[0],{...catalog[1],network:'trx'}],[{...catalog[0],sell:false},catalog[1]]]){
    const {client,calls}=fixture([reply(data)]);assert.equal((await client.inspectRoute(requested)).available,false);assert.equal(calls.length,1);
  }
  const {client,calls}=fixture([reply(catalog)]);
  assert.equal((await client.inspectRoute({...requested,fromCurrency:'dubyt',fromNetwork:'dubyt'})).available,false);assert.equal(calls.length,1);
  const f=fixture([reply([{...catalog[0],supportsFixedRate:false},catalog[1]])]);
  assert.equal((await f.client.inspectRoute({...requested,flow:'fixed-rate'})).available,false);
});
test('ambiguous catalog and mismatched or reversed monetary ranges fail closed',async()=>{
  await assert.rejects(fixture([reply([...catalog,catalog[0]])]).client.inspectRoute(requested),/ambiguous/);
  for(const r of [{...requested,toNetwork:'trx',minAmount:'1',maxAmount:null},{...requested,minAmount:'2',maxAmount:'1'},{...requested,minAmount:null,maxAmount:null}])
    await assert.rejects(fixture([reply(catalog),reply(r)]).client.inspectRoute(requested));
});
test('429 honors retry metadata without automatic retries and sanitizes provider body',async()=>{
  const {client,calls}=fixture([new Response('secret-key-do-not-log',{status:429,headers:{'Retry-After':'120'}})]);
  await assert.rejects(client.inspectRoute(requested),e=>e.status===429&&e.retryAfterMs===120000&&!e.message.includes('secret'));
  assert.equal(calls.length,1);
});
test('transport failures, invalid JSON/UTF8 and oversized replies are sanitized; no mutations or retry',async()=>{
  const bad=[new Error('secret from transport'),reply('{broken'),new Response('html'),reply(' '.repeat(4*1024*1024+1)),new Response(new Uint8Array([0xff]),{headers:{'Content-Type':'application/json'}})];
  for(const r of bad){const f=fixture([r]);await assert.rejects(f.client.inspectRoute(requested),e=>e instanceof ChangeNowDiscoveryError&&!e.message.includes('secret'));assert.equal(f.calls.length,1);assert.equal(f.client.busy,false);}
  const f=fixture([]);await assert.rejects(f.client.get('exchange',requested));assert.equal(f.calls.length,0);
});
test('credential environment cannot be relabelled sandbox and invalid routes never reach the network',async()=>{
  let calls=0;const client=new ChangeNowDiscovery({credentials:async()=>({environment:'sandbox',key:'test'}),fetchImpl:async()=>{calls++;return reply([]);}});
  await assert.rejects(client.inspectRoute(requested));assert.equal(calls,0);
  for(const r of [{...requested,toNetwork:''},{...requested,extra:'ignored'},{...requested,toNetwork:'https://evil.invalid'},{...requested,flow:'auto'}])await assert.rejects(client.inspectRoute(r));
  assert.equal(calls,0);
});
test('parallel discovery requests are bounded and a failed request releases its slot',async()=>{
  let release;const waiting=new Promise(resolve=>{release=resolve;});let calls=0;
  const client=new ChangeNowDiscovery({credentials,fetchImpl:async()=>{calls++;await waiting;throw new Error('offline');}});
  const first=client.get('currencies',{active:'true',flow:'standard'});
  await assert.rejects(client.get('currencies',{active:'true',flow:'standard'}),/in progress/);
  release();await assert.rejects(first);assert.equal(calls,1);assert.equal(client.busy,false);
});
