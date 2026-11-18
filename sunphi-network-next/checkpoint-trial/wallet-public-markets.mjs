import assert from 'node:assert/strict';
import {assetDecimal} from './wallet-assets.mjs';
import {ETHEREUM_USDC,ETHEREUM_USDT} from './research/exchange-evm-networks.mjs';

const pairs={BTC:['XBTUSD','XXBTZUSD'],USDC:['USDCUSD','USDCUSD'],USDT:['USDTUSD','USDTZUSD']};
const transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const receipts={
 'btc-bitcoin':{asset:'BTC',network:'Bitcoin',source:'Blockstream Esplora'},
 'usdc-ethereum':{asset:'USDC',network:'Ethereum',source:'PublicNode',contract:ETHEREUM_USDC},
 'usdt-ethereum':{asset:'USDT',network:'Ethereum',source:'PublicNode',contract:ETHEREUM_USDT}
};

async function read(url,options={}){
 const response=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(8000)});
 if(response.status===404&&url.startsWith('https://blockstream.info/api/tx/'))return null;
 assert(response.ok,'External source unavailable');
 const chunks=[];let bytes=0;
 for await(const chunk of response.body){
  bytes+=chunk.length;assert(bytes<=2097152,'External response too large');chunks.push(chunk);
 }
 return Buffer.concat(chunks).toString('utf8');
}

const priceSources=[
 {name:'Kraken spot',async latest(asset,reader){
  const [pair,key]=pairs[asset];
  const data=JSON.parse(await reader('https://api.kraken.com/0/public/Trades?count=1&pair='+pair));
  assert.deepEqual(data.error,[]);
  const [price,,seconds]=data.result[key].at(-1);
  return {price,quotedAt:Math.floor(seconds*1000)};
 }},
 {name:'Bitstamp spot',async latest(asset,reader){
  const trades=JSON.parse(await reader('https://www.bitstamp.net/api/v2/transactions/'+asset.toLowerCase()+'usd/?time=hour'));
  assert(Array.isArray(trades)&&trades.length);
  const last=trades.reduce((a,b)=>Number(a.date)>Number(b.date)||a.date===b.date&&Number(a.tid)>Number(b.tid)?a:b);
  return {price:last.price,quotedAt:Number(last.date)*1000};
 }}
];
async function referencePrice(asset,reader,now){
 let previous=null;
 for(const source of priceSources){
  try{
   const {price,quotedAt}=await source.latest(asset,reader);
   assert(typeof price==='string'&&/^\d+(\.\d+)?$/.test(price)&&Number(price)>0&&Number.isFinite(Number(price)));
   assert(Number.isSafeInteger(quotedAt)&&quotedAt>0&&quotedAt<=now()+30000);
   const status=now()-quotedAt>300000?'stale':'available';
   const row={asset,source:source.name,currency:'USD',price,quotedAt,status};
   if(status==='available')return row;
   if(!previous||quotedAt>previous.quotedAt)previous=row;
  }catch{continue;}
 }
 return previous??{asset,currency:'USD',source:priceSources.map(s=>s.name).join(' / '),status:'unavailable'};
}
export function referencePriceFeed(reader=read,now=Date.now){
 let nextRefresh=0,rows=[],inFlight;
 return async()=>{
  if(now()<nextRefresh)return rows;
  if(inFlight)return inFlight;
  inFlight=Promise.all(Object.keys(pairs).map(asset=>referencePrice(asset,reader,now)))
   .then(result=>{rows=result;nextRefresh=now()+60000;return rows;}).finally(()=>{inFlight=null;});
  return inFlight;
 };
}

async function bitcoinReceipt(txid,address,reader){
 const base='https://blockstream.info/api/';
 const raw=await reader(base+'tx/'+txid);
 if(raw===null)return {status:'not-seen'};
 const tx=JSON.parse(raw);
 assert.equal(tx.txid,txid);
 const amount=tx.vout.filter(v=>v.scriptpubkey_address===address).reduce((sum,v)=>{
  assert(Number.isSafeInteger(v.value)&&v.value>=0);return sum+BigInt(v.value);
 },0n);
 if(!amount)return {status:'no-match'};
 const received=assetDecimal(amount.toString(),8);
 let confirmations=0;
 assert(typeof tx.status?.confirmed==='boolean');
 if(tx.status.confirmed){
  const height=tx.status.block_height;
  assert(Number.isSafeInteger(height)&&height>0&&/^[0-9a-f]{64}$/.test(tx.status.block_hash));
  const tip=Number(await reader(base+'blocks/tip/height'));
  assert(Number.isSafeInteger(tip)&&tip>=height);
  assert.equal((await reader(base+'block-height/'+height)).trim(),tx.status.block_hash);
  confirmations=tip-height+1;
 }
 return {status:confirmations>=6?'confirmed':'confirming',received,confirmations,required:6};
}

async function ethereumReceipt(txid,address,contract,reader){
 async function rpc(method,params){
  const data=JSON.parse(await reader('https://ethereum-rpc.publicnode.com',{
   method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})
  }));
  assert(data.id===1&&!data.error&&Object.hasOwn(data,'result'));return data.result;
 }
 assert.equal(await rpc('eth_chainId',[]),'0x1');
 const tx=await rpc('eth_getTransactionReceipt',[txid]);
 if(tx===null){
  const pending=await rpc('eth_getTransactionByHash',[txid]);
  if(pending===null)return {status:'not-seen'};
  assert.equal(pending.hash,txid);return {status:'pending'};
 }
 assert.equal(tx.transactionHash,txid);
 assert(/^0x[0-9a-f]{64}$/.test(tx.blockHash)&&/^0x[0-9a-f]+$/.test(tx.blockNumber));
 const final=await rpc('eth_getBlockByNumber',['finalized',false]);
 const block=await rpc('eth_getBlockByNumber',[tx.blockNumber,false]);
 assert.equal(block.hash,tx.blockHash);assert.equal(block.number,tx.blockNumber);
 if(tx.status==='0x0')return {status:'failed'};
 assert.equal(tx.status,'0x1');
 const recipient='0x'+'0'.repeat(24)+address.slice(2);
 let amount=0n;
 for(const log of tx.logs){
  if(log.removed||log.address.toLowerCase()!==contract||log.topics.length!==3||log.topics[0]!==transferTopic||log.topics[2]!==recipient)continue;
  assert.equal(log.blockHash,tx.blockHash);assert.equal(log.transactionHash,txid);
  assert(/^0x[0-9a-f]{64}$/.test(log.data));amount+=BigInt(log.data);
 }
 if(!amount)return {status:'no-match'};
 assert(/^0x[0-9a-f]+$/.test(final.number));
 return {status:BigInt(final.number)>=BigInt(tx.blockNumber)?'confirmed':'confirming',received:assetDecimal(amount.toString(),6)};
}

export async function checkPublicReceipt({route,txid,address},reader=read){
 assert(Object.hasOwn(receipts,route),'Select an asset and network.');
 const {asset,network,source,contract}=receipts[route];
 assert(typeof txid==='string'&&typeof address==='string','Enter the transaction ID and receiving address.');
 if(contract){
  assert(/^0x[0-9a-fA-F]{64}$/.test(txid)&&/^0x[0-9a-fA-F]{40}$/.test(address),'Enter an Ethereum transaction hash and receiving address.');
  address=address.toLowerCase();
 }else{
  assert(/^[0-9a-fA-F]{64}$/.test(txid),'Enter a Bitcoin transaction ID.');
  if(/^bc1/i.test(address)){
   assert(address===address.toLowerCase()||address===address.toUpperCase(),'Invalid mixed-case Bitcoin address.');
   address=address.toLowerCase();
  }
  assert(/^(?:bc1[ac-hj-np-z02-9]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(address),'Enter a Bitcoin mainnet receiving address.');
 }
 txid=txid.toLowerCase();
 let result;
 try{result=contract?await ethereumReceipt(txid,address,contract,reader):await bitcoinReceipt(txid,address,reader);}
 catch{result={status:'unavailable'};}
 return {asset,network,source,...result,checkedAt:Date.now()};
}
