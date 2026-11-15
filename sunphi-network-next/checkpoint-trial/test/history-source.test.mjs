import test from 'node:test';
import assert from 'node:assert/strict';
import {selectHistorySource} from '../history-source.mjs';
import {hash} from '../crypto.mjs';
const local='http://127.0.0.1:20001',remote='http://127.0.0.1:20002',anchor={height:4,blockHash:hash('retained')};
const header=(height,blockHash=anchor.blockHash)=>({signed_header:{header:{height:String(height)},commit:{block_id:{hash:blockHash.toUpperCase()}}}});

test('schema boundary is read through fallback and remains bound to its certified root',async()=>{
 const boundary={height:5,appHash:hash('source')},block={block_id:{hash:hash('boundary')},block:{header:{height:'5',app_hash:boundary.appHash}}};
 const options={local,remote,anchor,minHeight:18,boundary};
 for(const mode of ['pruned-anchor','pruned-boundary']){
  const result=await selectHistorySource({...options,request:async(u,m,p)=>{if(u===local&&((mode==='pruned-anchor'&&p)||(mode==='pruned-boundary'&&m==='block')))throw Error('pruned');return m==='block'?block:header(p?4:20);}});
  assert.equal(result.url,remote);assert.deepEqual(result.boundary,block);
 }
 for(const headerChange of [{height:'6'},{app_hash:hash('wrong-root')}]){
  let remoteCalls=0;
  await assert.rejects(()=>selectHistorySource({...options,request:async(u,m,p)=>{if(u===remote)remoteCalls++;return m==='block'?{...block,block:{header:{...block.block.header,...headerChange}}}:header(p?4:20);}}),/schema boundary .* conflict/);
  assert.equal(remoteCalls,0);
 }
});
test('indexed wallet falls back from pruned local headers without changing its retained anchor',async()=>{
 const calls=[],request=async(url,_method,params)=>{calls.push([url,params]);if(url===local&&params)throw Error('height pruned');return header(params?Number(params.height):20);};
 assert.deepEqual(await selectHistorySource({local,remote,anchor,minHeight:18,request}),{url:remote,latest:20});assert.deepEqual(calls[1][1],{height:'4'});assert.deepEqual(calls[3][1],{height:'4'});
});
test('available local history stays preferred; lag and outage can use the pinned remote route',async()=>{
 assert.equal((await selectHistorySource({local,remote,anchor,minHeight:18,request:async(_u,_m,p)=>header(p?4:20)})).url,local);
 for(const mode of ['lag','offline'])assert.equal((await selectHistorySource({local,remote,anchor,minHeight:18,request:async(u,_m,p)=>{if(u===local){if(mode==='offline')throw Error('offline');return header(3);}return header(p?4:20);}})).url,remote);
});
test('conflicting history fails closed rather than concealing a fork through fallback',async()=>{
 let remoteCalls=0;await assert.rejects(()=>selectHistorySource({local,remote,anchor,minHeight:18,request:async(u,_m,p)=>{if(u===remote)remoteCalls++;return header(p?4:20,p?hash('fork'):anchor.blockHash);}}),/retained history conflict/);assert.equal(remoteCalls,0);
 await assert.rejects(()=>selectHistorySource({local,remote,anchor,minHeight:18,request:async()=>{throw Error('unavailable');}}),/Saved verification progress/);
 await assert.rejects(()=>selectHistorySource({remote:'https://example.com',anchor,minHeight:18,request:async()=>header(20)}),/local history route/);
});
