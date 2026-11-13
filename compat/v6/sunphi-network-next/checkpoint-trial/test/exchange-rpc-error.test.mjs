import test from 'node:test';import assert from 'node:assert/strict';
import {localRpc} from '../research/purchase-observer.mjs';
import {recoveryAdapter} from '../qa/helpers/exchange-recovery-adapter.mjs';import {hash} from '../crypto.mjs';
test('Bitcoin HTTP 500 retains only the typed RPC error, never remote text',async()=>{
 const rpc=localRpc('http://127.0.0.1:1',{fetcher:async()=>new Response(JSON.stringify({id:1,error:{code:-5,message:'private server detail'}}),{status:500})});
 await assert.rejects(()=>rpc('getrawtransaction',['a'.repeat(64),true]),e=>e.rpcCode===-5&&!e.message.includes('private server detail'));
});
test('authentication, malformed replies and missing correlation are not transaction absence',async()=>{
 for(const [status,body]of [[401,{id:1,error:{code:-5}}],[500,{id:2,error:{code:-5}}],[500,{id:1,error:{code:'-5'}}],[500,{id:1,result:null}],[503,{id:1,error:{code:-5}}]]){
  const rpc=localRpc('http://127.0.0.1:1',{fetcher:async()=>new Response(JSON.stringify(body),{status})});await assert.rejects(()=>rpc('getrawtransaction',['a'.repeat(64),true]),e=>e.rpcCode!==-5);
 }
});
test('recovery discovery recognizes pending Bitcoin spends without confirmation fields',async()=>{
 const quote={asset:'BTC'},tx=hash('pending'),order={id:hash(quote),q:quote,claimRaw:'11'},p={quote};let mode='pending';
 const a=recoveryAdapter({orders:[order],evm:{ethers:{}},btc:{rpc:async method=>{if(method==='decoderawtransaction')return {txid:tx};if(mode==='absent')throw Object.assign(Error('missing'),{rpcCode:-5});if(mode==='offline')throw Object.assign(Error('initializing'),{rpcCode:-28});return {txid:mode==='wrong'?hash('wrong'):tx};}}});
 assert.deepEqual(await a.discover(p),{kind:'PAYOUT',transaction:tx});mode='absent';assert.equal(await a.discover(p),null);for(mode of ['offline','wrong'])await assert.rejects(()=>a.discover(p));assert.equal(a.calls.prepared,0);assert.equal(a.calls.submitted,0);
});
