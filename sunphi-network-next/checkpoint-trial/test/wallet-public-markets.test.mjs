import test from 'node:test';
import assert from 'node:assert/strict';
import {referencePriceFeed,checkPublicReceipt} from '../wallet-public-markets.mjs';
import {ETHEREUM_USDC,ETHEREUM_USDT} from '../research/exchange-evm-networks.mjs';

test('two consumers share one refresh, fallback quotes identify venue and trade time',async()=>{
 const now=1700000000000;let calls=0;
 const feed=referencePriceFeed(async url=>{
  calls++;
  if(url.includes('kraken.com'))throw Error();
  if(url.includes('usdtusd'))return '[]';
  return JSON.stringify([{price:'0.9997',date:String(now/1000-8),tid:'42'}]);
 },()=>now);
 const [a,b]=await Promise.all([feed(),feed()]);
 assert.deepEqual(a,b);assert.equal(calls,6);await feed();assert.equal(calls,6);
 assert.equal(a[1].source,'Bitstamp spot');assert.equal(a[1].quotedAt,now-8000);assert.equal(a[1].price,'0.9997');
 assert.equal(a[2].status,'unavailable');assert.equal(a[2].price,undefined);
});

const txid='a'.repeat(64),blockHash='b'.repeat(64),address='bc1q'+'c'.repeat(38);
test('Bitcoin matches exact outputs, includes mempool and enforces depth and canonical block',async()=>{
 let to=address,confirmed=false,tip=103,canonical=blockHash;
 const reader=async url=>{
  if(url.endsWith('tip/height'))return String(tip);
  if(url.includes('/block-height/'))return canonical;
  return JSON.stringify({txid,vout:[{scriptpubkey_address:to,value:124},{scriptpubkey_address:to,value:1}],status:{confirmed,block_height:100,block_hash:blockHash}});
 };
 const input={route:'btc-bitcoin',txid,address},check=()=>checkPublicReceipt(input,reader);
 assert.equal((await check()).received,'0.00000125');assert.equal((await check()).confirmations,0);
 confirmed=true;assert.equal((await check()).status,'confirming');
 tip=105;assert.equal((await check()).status,'confirmed');
 canonical=txid;assert.equal((await check()).status,'unavailable');
 to='other';assert.equal((await check()).status,'no-match');
 assert.equal((await checkPublicReceipt(input,async()=>null)).status,'not-seen');
});

test('Ethereum distinguishes failed, pending and finalized and checks token, recipient and canonical block',async()=>{
 const hash='0x'+txid,block='0x'+blockHash,owner='0x'+'1'.repeat(40);
 const input={route:'usdc-ethereum',txid:hash,address:owner};
 const log={blockHash:block,transactionHash:hash,address:ETHEREUM_USDC,data:'0x'+'1'.padStart(64,'0'),
  topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef','0x'+'0'.repeat(64),'0x'+'0'.repeat(24)+owner.slice(2)]};
 let tx={blockNumber:'0x5',blockHash:block,transactionHash:hash,status:'0x1',logs:[log]},final='0x4',canonical=block;
 const reader=async(url,options)=>{
  const {method,params}=JSON.parse(options.body);
  const result=method==='eth_chainId'?'0x1':method==='eth_getTransactionReceipt'?tx:method==='eth_getTransactionByHash'?{hash}:params[0]==='finalized'?{number:final}:{hash:canonical,number:'0x5'};
  return JSON.stringify({result,id:1});
 };
 const check=()=>checkPublicReceipt(input,reader);
 assert.equal((await check()).status,'confirming');final='0x5';assert.equal((await check()).status,'confirmed');
 assert.equal((await check()).received,'0.000001');
 log.address=ETHEREUM_USDT;assert.equal((await check()).status,'no-match');
 log.address=ETHEREUM_USDC;input.address='0x'+'2'.repeat(40);assert.equal((await check()).status,'no-match');
 tx.status='0x0';assert.equal((await check()).status,'failed');
 canonical=hash;assert.equal((await check()).status,'unavailable');
 tx=null;assert.equal((await check()).status,'pending');
 await assert.rejects(checkPublicReceipt({...input,route:'usdt-tron'},reader));
});
