// Trusted local full-node observation, NOT an SPV/consensus proof.
// Only regtest/local EVM are admitted. Each attester must use its own node.
import assert from 'node:assert/strict';
import {PURCHASE,orderId} from './purchase-contract.mjs';
import {hash,hex,integer,sign} from '../crypto.mjs';
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const quantity=x=>{assert(typeof x==='string'&&/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(x),'canonical RPC quantity');const n=Number(BigInt(x));integer(n);return n;};
const address=x=>{assert(typeof x==='string'&&/^0x[0-9a-f]{40}$/.test(x),'canonical EVM address');return x;};
const h256=x=>{assert(typeof x==='string'&&/^0x[0-9a-f]{64}$/.test(x),'RPC hash');return x;};
export function bitcoinAtomic(value){
 assert(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=21000000,'BTC value');
 const text=value.toFixed(8);assert.equal(Number(text),value,'BTC precision');return String(BigInt(text.replace('.','')));
}
export function localRpc(url,{fetcher=fetch,headers={}}={}){
 const u=new URL(url);assert(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password,'laboratory loopback RPC only');let sequence=0;
 return async(method,params=[])=>{
  const id=++sequence,r=await fetcher(u,{method:'POST',headers:{'content-type':'application/json',...(typeof headers==='function'?headers():headers)},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),redirect:'error',signal:AbortSignal.timeout(5000)});
  assert(r.ok,'external node unavailable');let bytes=0,parts=[];for await(const part of r.body){bytes+=part.length;assert(bytes<=2*1024*1024,'RPC response bound');parts.push(part);}
  const result=JSON.parse(Buffer.concat(parts).toString());assert.equal(result.id,id,'RPC response identity');assert(!result.error,'external node rejected request');return result.result;
 };
}
export async function observeExternal({rpc,policy,offer,txid,index,pins,now,kind='PAYMENT',refunds=[]}){
 assert(['PAYMENT','REFUND'].includes(kind));hex(txid);integer(index);integer(now,1);
 if(policy.rpcPins)assert.deepEqual(pins,policy.rpcPins[offer.route],'signed observer chain and asset pins');
 const route=policy.routes[offer.route],destination=kind==='REFUND'?offer.refundDestination:offer.destination;
 let amountAtomic,confirmations,paidAt;
 if(offer.route==='BTC'){
  assert.equal(route.network,'bitcoin-regtest');assert.equal(route.asset,'native');hex(pins.genesis);
  assert.equal((await rpc('getblockchaininfo')).chain,'regtest');assert.equal(await rpc('getblockhash',[0]),pins.genesis,'BTC chain pin');
  const tx=await rpc('getrawtransaction',[txid,true]);assert.equal(tx.txid,txid);hex(tx.blockhash);assert(tx.in_active_chain===true||tx.in_active_chain===undefined,'inactive BTC transaction');
  const header=await rpc('getblockheader',[tx.blockhash,true]);integer(header.height,1);integer(header.time,1);
  assert.equal(header.hash,tx.blockhash);assert.equal(await rpc('getblockhash',[header.height]),tx.blockhash,'BTC canonical inclusion');
  const tip=await rpc('getblockcount');integer(tip,header.height);const o=tx.vout?.find(v=>v.n===index);assert(o&&tx.vout.filter(v=>v.n===index).length===1,'exact BTC output');
  assert.equal(o.scriptPubKey?.address,destination,'BTC recipient');amountAtomic=bitcoinAtomic(o.value);paidAt=header.time;confirmations=tip-header.height+1;
  assert.equal(await rpc('getblockhash',[header.height]),tx.blockhash,'BTC reorg during observation');
 }else{
  assert.equal(offer.route,'USDC');assert.equal(route.network,'ethereum-local');assert.equal(route.asset,'test-usdc');
  assert.equal(await rpc('eth_chainId'),pins.chainId);h256(pins.genesis);address(pins.contract);
  assert.equal((await rpc('eth_getBlockByNumber',['0x0',false])).hash,pins.genesis,'EVM chain pin');
  const txHash='0x'+txid,r=await rpc('eth_getTransactionReceipt',[txHash]);assert(r&&r.status==='0x1','successful EVM receipt required');assert.equal(r.transactionHash,txHash);h256(r.blockHash);
  const height=quantity(r.blockNumber),b=await rpc('eth_getBlockByNumber',[r.blockNumber,false]);assert.equal(b.hash,r.blockHash,'EVM canonical inclusion');assert.equal(b.number,r.blockNumber);
  const l=r.logs?.find(l=>quantity(l.logIndex)===index);assert(l&&r.logs.filter(l=>quantity(l.logIndex)===index).length===1,'exact transfer log');
  assert.equal(l.removed,false);assert.equal(l.address,pins.contract,'pinned USDC contract');assert.equal(l.transactionHash,txHash);assert.equal(l.blockHash,r.blockHash);assert.equal(l.blockNumber,r.blockNumber);
  assert(l.topics.length===3&&l.topics[0]===transfer,'ERC20 Transfer event');assert(/^0x0{24}[0-9a-f]{40}$/.test(l.topics[1]));assert.equal(l.topics[2],'0x'+'0'.repeat(24)+address(destination).slice(2),'USDC recipient');
  if(kind==='REFUND')assert.equal(l.topics[1],'0x'+'0'.repeat(24)+address(offer.destination).slice(2),'USDC refund must come from the reserved deposit account');
  h256(l.data);amountAtomic=String(BigInt(l.data));paidAt=quantity(b.timestamp);
  const tip=await rpc('eth_getBlockByNumber',['latest',false]),final=await rpc('eth_getBlockByNumber',['finalized',false]);const top=quantity(tip.number),stable=quantity(final.number);assert(top>=height&&top>=stable);
  confirmations=stable>=height?top-height+1:0;
  assert.equal((await rpc('eth_getBlockByNumber',[r.blockNumber,false])).hash,r.blockHash,'EVM reorg during observation');
 }
 assert(paidAt<=now&&BigInt(amountAtomic)>0n);
 return {domain:PURCHASE+'/EVIDENCE',policyHash:hash(policy),network:policy.network,orderId:orderId(offer),kind,observedAt:now,externalNetwork:route.network,asset:route.asset,destination,amountAtomic,txid,index,confirmations,paidAt,reference:kind==='REFUND'?orderId(offer):null,refunds};
}
export function signObservation(body,key,policy){assert(policy.attesters.includes(key.publicKey));return {key:key.publicKey,signature:sign(body,key.privateKey)};}
