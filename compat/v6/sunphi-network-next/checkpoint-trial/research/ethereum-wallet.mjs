// Read-only native Ethereum USDC. No seed, key, signer or synthetic token balance.
import assert from 'node:assert/strict';import {exact,integer} from '../crypto.mjs';
import {ETHEREUM_USDC,ETHEREUM_GENESIS} from './exchange-evm-networks.mjs';
import {independentReaders} from './exchange-readers.mjs';import {readAnchorQuorum} from './exchange-source-anchor.mjs';
export function checkEthereumAccount(a){
 exact(a,['asset','network','address','genesis','contract','sources']);assert.equal(a.asset,'USDC');assert.equal(a.network,'ethereum-mainnet');assert.equal(a.genesis,ETHEREUM_GENESIS);assert.equal(a.contract,ETHEREUM_USDC);
 assert(/^0x[a-f0-9]{40}$/.test(a.address)&&a.address!=='0x'+'0'.repeat(40));
 for(const s of a.sources??[])exact(s,['id','operator','url']);independentReaders(a.sources,{chain:'ETHEREUM'});return a;
}
export async function observeEthereumAccount(a,{readers=independentReaders(a.sources,{chain:'ETHEREUM'}),now=Math.floor(Date.now()/1000),timeoutMs=12000}={}){
 checkEthereumAccount(a);integer(now);integer(timeoutMs,10);assert(timeoutMs<=30000);
 const anchor=await readAnchorQuorum(readers,{chain:'ETHEREUM',genesis:ETHEREUM_GENESIS,now,maxAge:1800,timeoutMs});
 const at='0x'+BigInt(anchor.height).toString(16),controller=new AbortController();let timer;
 const work=async()=>{
  const tasks=readers.map(async r=>{
   const rpc=(m,p)=>r.rpc(m,p,{signal:controller.signal});assert.equal(await rpc('eth_chainId',[]),'0x1');assert.equal((await rpc('eth_getBlockByNumber',['0x0',false])).hash,'0x'+ETHEREUM_GENESIS);
   const head=await rpc('eth_getBlockByNumber',['finalized',false]);assert(head&&BigInt(head.number)>=BigInt(anchor.height));const time=Number(BigInt(head.timestamp));integer(time);assert(time<=now+120&&now-time<=1800);
   const block=await rpc('eth_getBlockByNumber',[at,false]);assert.equal(block.hash,'0x'+anchor.hash);assert.equal(BigInt(block.number).toString(),anchor.height);
   const call=data=>rpc('eth_call',[{to:ETHEREUM_USDC,data},at]);assert.equal(BigInt(await call('0x313ce567')),6n);
   const raw=await call('0x70a08231'+'0'.repeat(24)+a.address.slice(2));assert(/^0x[a-f0-9]{64}$/.test(raw));
   assert.equal((await rpc('eth_getBlockByNumber',[at,false])).hash,block.hash);assert.equal((await rpc('eth_getBlockByNumber',[head.number,false])).hash,head.hash);
   return {value:BigInt(raw).toString(),source:r.id,operator:r.operator};
  });
  const agreed=await new Promise((resolve,reject)=>{const groups=new Map();let remaining=3;for(const task of tasks)task.then(v=>{const group=groups.get(v.value)??[];group.push(v);groups.set(v.value,group);if(group.length>=2)resolve(group);}).catch(()=>{}).finally(()=>{if(--remaining===0)reject(Error('Ethereum balance quorum unavailable'));});});
  return {asset:'USDC',network:'ethereum-mainnet',address:a.address,contract:ETHEREUM_USDC,status:'observed',availableAtomic:agreed[0].value,pendingAtomic:'0',pendingScope:'Finalized balance only; unfinalized transfers are not included',checkedAt:now*1000,block:'0x'+anchor.hash,sources:agreed.map(x=>({id:x.source,operator:x.operator})),scope:'Read-only balance agreed by external sources; not DueByte consensus or spending authorization'};
 };
 try{return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Ethereum balance timeout')),timeoutMs);})]);}finally{clearTimeout(timer);controller.abort();}
}
