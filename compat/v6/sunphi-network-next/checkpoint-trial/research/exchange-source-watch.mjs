// Read-only operational telemetry. Never admitted as a payment/settlement proof.
import assert from 'node:assert/strict';
import {setTimeout as pause} from 'node:timers/promises';
import {readOnlyRpc} from './exchange-readers.mjs';
import {BTC_GENESIS} from './exchange-finality.mjs';
import {evmNetwork} from './exchange-evm-networks.mjs';
const hash=v=>{assert(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v));return v;};
function fresh(t,now,maxAge=7200){assert(Number.isSafeInteger(t)&&t<=now+120&&now-t<=maxAge);}
export async function sampleSource(source,{now=Math.floor(Date.now()/1000),fetcher=fetch,timeoutMs=10000}={}){
 assert(source&&/^[a-z0-9-]{1,64}$/.test(source.id)&&/^[a-z0-9-]{1,64}$/.test(source.operator));
 assert(['BTC','BASE','ETHEREUM'].includes(source.chain));const url=new URL(source.url);assert(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&!url.search);
 assert(Number.isSafeInteger(timeoutMs)&&timeoutMs>=10&&timeoutMs<=30000);assert(Number.isSafeInteger(now));
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 const report={id:source.id,operator:source.operator,chain:source.chain,checkedAt:now,available:false,productionAdmitted:false,settlementAuthorized:false};
 const get=async suffix=>{if(source.api==='blockcypher')await pause(400,undefined,{signal:controller.signal});const r=await fetcher(source.url+suffix,{redirect:'error',signal:controller.signal});assert(r.ok&&r.body);let total=0;const parts=[];for await(const part of r.body){total+=part.length;assert(total<=65536);parts.push(part);}return Buffer.concat(parts).toString('utf8').trim();};
 try{
  if(source.chain==='BTC'){
   if(source.api==='blockcypher'){
    const block=async height=>JSON.parse(await get('/blocks/'+height+'?txstart=1&limit=1'));
    assert.equal((await block(0)).hash,BTC_GENESIS);const tip=JSON.parse(await get(''));assert.equal(tip.name,'BTC.main');assert(Number.isSafeInteger(tip.height)&&tip.height>=6);
    const height=tip.height-5,b=await block(height);assert.equal(b.height,height);assert.equal(b.chain,'BTC.main');hash(b.hash);const time=Date.parse(b.time)/1000;fresh(time,now);
    const again=await block(height);assert.equal(again.hash,b.hash);assert.equal(again.height,height);assert.equal(again.time,b.time);
    return {...report,available:true,height:String(height),block:b.hash,blockTime:time,genesis:BTC_GENESIS};
   }
   assert(source.api===undefined||source.api==='esplora');
   assert.equal(await get('/block-height/0'),BTC_GENESIS);const tip=Number(await get('/blocks/tip/height'));assert(Number.isSafeInteger(tip)&&tip>=6);
   const height=tip-5,id=hash(await get('/block-height/'+height)),b=JSON.parse(await get('/block/'+id));
   assert.equal(b.id,id);assert.equal(b.height,height);fresh(b.timestamp,now);
   assert.equal(await get('/block-height/'+height),id);const status=JSON.parse(await get('/block/'+id+'/status'));assert.equal(status.in_best_chain,true);
   return {...report,available:true,height:String(height),block:id,blockTime:b.timestamp,genesis:BTC_GENESIS};
  }
  const network=evmNetwork(source.chain),rpc=readOnlyRpc(source.url,{chain:source.chain,fetcher,timeoutMs}),call=(m,p)=>rpc(m,p,{signal:controller.signal});
  assert.equal(await call('eth_chainId',[]),network.chainId);assert.equal((await call('eth_getBlockByNumber',['0x0',false]))?.hash,'0x'+network.genesis);
  const head=await call('eth_getBlockByNumber',['finalized',false]);assert(head&&/^0x(?:0|[1-9a-f][a-f0-9]*)$/.test(head.number)&&/^0x[a-f0-9]+$/.test(head.timestamp));
  const block=hash(head.hash.slice(2)),time=Number(BigInt(head.timestamp));fresh(time,now,1800);
  const repeated=await call('eth_getBlockByNumber',[head.number,false]);assert.equal(repeated?.hash,head.hash);assert.equal(repeated?.number,head.number);assert.equal(repeated?.timestamp,head.timestamp);
  return {...report,available:true,height:BigInt(head.number).toString(),block,blockTime:time,genesis:network.genesis};
 }catch{return {...report,reason:'SOURCE_UNAVAILABLE_OR_INVALID'};}finally{clearTimeout(timer);controller.abort();}
}
