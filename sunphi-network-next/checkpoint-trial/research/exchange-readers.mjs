// Bounded read-only transports. Source agreement is not an exchange settlement
// proof: exact order/escrow inspection and signed observer quorum remain required.
import assert from 'node:assert/strict';
import {hash,hex,integer} from '../crypto.mjs';
import {bitcoinFinality,baseFinality,baseRevertFinality,ethereumFinality,ethereumRevertFinality} from './exchange-finality.mjs';

const methods={BTC:new Set(['getblockchaininfo','getblockhash','getblockheader','getrawtransaction','getblockcount','gettxout','decoderawtransaction']),BASE:new Set(['eth_chainId','eth_getBlockByNumber','eth_getTransactionReceipt','eth_getCode','eth_call'])};
methods.ETHEREUM=methods.BASE;
export function readOnlyRpc(endpoint,{chain,headers={},timeoutMs=5000,maxBytes=2097152,isolated=false,fetcher=fetch}={}){
 const url=new URL(endpoint);assert(methods[chain]);assert(!url.username&&!url.password&&!url.hash&&!url.search,'RPC URL credentials/query forbidden');
 assert(url.protocol==='https:'||(isolated&&url.protocol==='http:'&&url.hostname==='127.0.0.1'),'TLS or isolated loopback required');
 integer(timeoutMs,10);assert(timeoutMs<=30000);integer(maxBytes,128);assert(maxBytes<=2097152);let sequence=0;
 return async(method,params=[],{signal}={})=>{
  assert(methods[chain].has(method),'read-only RPC method required');assert(Array.isArray(params));
  if(method==='decoderawtransaction')assert(params.length===1&&typeof params[0]==='string'&&/^(?:[a-f0-9]{2})+$/.test(params[0])&&params[0].length<=200000,'bounded raw transaction');
  else assert(JSON.stringify(params).length<=4096);
  const id=++sequence,controller=new AbortController(),signals=[controller.signal,...(signal?[signal]:[])],abort=AbortSignal.any(signals),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const r=await fetcher(url,{method:'POST',redirect:'error',signal:abort,headers:{...(typeof headers==='function'?headers():headers),'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
   assert(r.ok&&r.body,'RPC unavailable');const length=r.headers.get('content-length');if(length!==null)assert(/^\d+$/.test(length)&&Number(length)<=maxBytes,'RPC response bound');
   let total=0;const parts=[];for await(const part of r.body){total+=part.length;assert(total<=maxBytes,'RPC response bound');parts.push(part);}
   const v=JSON.parse(Buffer.concat(parts).toString('utf8'));assert(v&&v.id===id&&!v.error&&Object.hasOwn(v,'result'),'RPC response rejected');return v.result;
  }catch{throw Error('read-only source unavailable or invalid');}
  finally{clearTimeout(timer);controller.abort();}
 };
}

// Operator labels are admission metadata, not proof of independent ownership.
// Never count aliases of the same configured operator or endpoint as extra votes.
export function independentReaders(sources,{chain,isolated=false,...options}={}){
 assert(Array.isArray(sources)&&sources.length===3);const ids=new Set(),operators=new Set(),origins=new Set();
 return sources.map(s=>{
  assert(/^[a-z0-9-]{1,64}$/.test(s.id)&&/^[a-z0-9-]{1,64}$/.test(s.operator));const u=new URL(s.url),origin=isolated?u.origin:u.hostname;
  assert(!ids.has(s.id)&&!operators.has(s.operator)&&!origins.has(origin),'duplicate source or operator');ids.add(s.id);operators.add(s.operator);origins.add(origin);
  return {id:s.id,operator:s.operator,rpc:readOnlyRpc(s.url,{...options,chain,isolated,headers:s.headers??{}})};
 });
}

export async function readFinalityQuorum(readers,{chain,transaction,genesis,now,outcome='SUCCESS',timeoutMs=12000,bitcoinChain='main'}){
 assert(Array.isArray(readers)&&readers.length===3);assert(new Set(readers.map(r=>r.id)).size===3&&new Set(readers.map(r=>r.operator)).size===3);
 assert(['BTC','BASE','ETHEREUM'].includes(chain));assert(outcome==='SUCCESS'||(chain!=='BTC'&&outcome==='REVERT'));hex(transaction);hex(genesis);integer(now);integer(timeoutMs,10);assert(timeoutMs<=30000);
 return new Promise((resolve,reject)=>{
  const controller=new AbortController(),groups=new Map();let done=false,remaining=3;
  const finish=value=>{if(done)return;done=true;clearTimeout(timer);controller.abort();value?resolve(value):reject(Error('independent finality quorum unavailable'));};
  const timer=setTimeout(()=>finish(),timeoutMs);
  for(const reader of readers)Promise.resolve().then(async()=>{
   const rpc=(m,p)=>reader.rpc(m,p,{signal:controller.signal});
   const evm=chain==='ETHEREUM'?(outcome==='REVERT'?ethereumRevertFinality:ethereumFinality):(outcome==='REVERT'?baseRevertFinality:baseFinality);
   const proof=chain==='BTC'?await bitcoinFinality(rpc,{transaction,genesis,now,chain:bitcoinChain}):await evm(rpc,{transaction,genesis,now});
   if(done)return;const key=hash({transaction:proof.transaction,block:proof.block,height:String(proof.height),outcome}),g=groups.get(key)??[];g.push({source:reader.id,operator:reader.operator,proof});groups.set(key,g);
   if(g.length>=2)finish({kind:'SOURCE_FINALITY_AGREEMENT',chain,transaction,block:proof.block,height:String(proof.height),outcome,sources:g});
  }).catch(()=>{}).finally(()=>{if(--remaining===0&&!done)finish();});
 });
}
