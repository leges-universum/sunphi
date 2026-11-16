// Read-only source readiness. An anchor is NOT evidence that an exchange paid.
// Reader operator identities must be checked operationally before admission.
import assert from 'node:assert/strict';
import {hex,integer} from '../crypto.mjs';
import {evmNetwork} from './exchange-evm-networks.mjs';

const quantity=v=>{assert(typeof v==='string'&&/^0x(?:0|[1-9a-f][a-f0-9]*)$/.test(v));return BigInt(v);};
const strip=v=>{assert(typeof v==='string'&&v.startsWith('0x'));return hex(v.slice(2));};
function fresh(time,now,maxAge){integer(time);assert(time<=now+120&&now-time<=maxAge,'source anchor stale');}

export async function readAnchorQuorum(readers,{chain,genesis,now,bitcoinChain='main',maxAge=7200,timeoutMs=12000}){
 assert(Array.isArray(readers)&&readers.length===3);assert(new Set(readers.map(r=>r.id)).size===3&&new Set(readers.map(r=>r.operator)).size===3);
 assert(['BTC','BASE','ETHEREUM'].includes(chain));assert(['main','regtest'].includes(bitcoinChain));hex(genesis);integer(now);integer(maxAge,1);assert(maxAge<=7200);integer(timeoutMs,10);assert(timeoutMs<=30000);
 if(chain==='ETHEREUM')assert.equal(genesis,evmNetwork(chain).genesis);
 const controller=new AbortController();let timer;
 const work=async()=>{
  const sources=await Promise.allSettled(readers.map(async reader=>{
   const local=new AbortController();let sourceTimer;
   const observe=async()=>{
   const rpc=(m,p)=>reader.rpc(m,p,{signal:AbortSignal.any([controller.signal,local.signal])});let height,initial;
   const block=async h=>{
    if(chain==='BTC'){assert(h<=BigInt(Number.MAX_SAFE_INTEGER));const id=hex(await rpc('getblockhash',[Number(h)])),b=await rpc('getblockheader',[id,true]);assert.equal(b.hash,id);assert.equal(BigInt(integer(b.height)),h);assert(b.confirmations>=6);fresh(b.time,now,maxAge);return {height:h.toString(),hash:id,time:b.time};}
    const b=await rpc('eth_getBlockByNumber',['0x'+h.toString(16),false]);assert(b);assert.equal(quantity(b.number),h);const time=Number(quantity(b.timestamp));fresh(time,now,maxAge);return {height:h.toString(),hash:strip(b.hash),time};
   };
   if(chain==='BTC'){
    assert.equal(await rpc('getblockhash',[0]),genesis);const info=await rpc('getblockchaininfo',[]);assert.equal(info.chain,bitcoinChain);assert.equal(info.initialblockdownload,false);integer(info.blocks,6);integer(info.headers,info.blocks);assert(info.headers-info.blocks<=2);const tip=await rpc('getblockheader',[hex(info.bestblockhash),true]);assert.equal(tip.hash,info.bestblockhash);assert.equal(tip.height,info.blocks);fresh(tip.time,now,maxAge);height=BigInt(info.blocks-5);
   }else{
    assert.equal(await rpc('eth_chainId',[]),evmNetwork(chain).chainId);const first=await rpc('eth_getBlockByNumber',['0x0',false]);assert(first);assert.equal(strip(first.hash),genesis);const head=await rpc('eth_getBlockByNumber',['finalized',false]);assert(head);height=quantity(head.number);initial=await block(height);assert.equal(initial.hash,strip(head.hash));assert.equal(initial.time,Number(quantity(head.timestamp)));
   }
   const head=await block(height);if(initial)assert.deepEqual(head,initial,'initial finalized head changed');return {reader,height,block,head};
   };
   try{return await Promise.race([observe(),new Promise((_,reject)=>{sourceTimer=setTimeout(()=>{local.abort();reject(Error('source timeout'));},Math.max(1,Math.floor(timeoutMs/2)));})]);}finally{clearTimeout(sourceTimer);}
  }));
  const live=sources.filter(r=>r.status==='fulfilled').map(r=>r.value),pairs=[];
  for(let a=0;a<live.length;a++)for(let b=a+1;b<live.length;b++)pairs.push([live[a],live[b]]);
  return Promise.any(pairs.map(async([a,b])=>{
   const height=a.height<b.height?a.height:b.height;
   const first=await Promise.all([a.block(height),b.block(height)]);assert.deepEqual(first[0],first[1]);
   const again=await Promise.all([a.block(height),b.block(height)]);assert.deepEqual(again,first,'source anchor changed');
   assert.deepEqual(await a.block(a.height),a.head,'first source head changed');assert.deepEqual(await b.block(b.height),b.head,'second source head changed');
   return {kind:'SOURCE_ANCHOR_AGREEMENT',chain,genesis,...first[0],sources:[a.reader,b.reader].map(r=>({id:r.id,operator:r.operator})),settlementAuthorized:false};
  }));
 };
 try{return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('source anchor quorum timeout'));},timeoutMs);})]);}
 finally{clearTimeout(timer);controller.abort();}
}
