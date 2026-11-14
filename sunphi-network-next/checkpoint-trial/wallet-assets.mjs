// Unified presentation, not a synthetic cross-chain ledger. Unknown is never zero.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {exact,hex,integer} from './crypto.mjs';
import {localRpc,bitcoinAtomic} from './research/purchase-observer.mjs';
import {atomic} from './research/exchange-escrow.mjs';
import {checkEthereumAccount,observeEthereumAccount} from './research/ethereum-wallet.mjs';
export function assetDecimal(value,decimals){const n=atomic(value),scale=10n**BigInt(decimals),fraction=String(n%scale).padStart(decimals,'0').replace(/0+$/,'');return String(n/scale)+(fraction?'.'+fraction:'');}
export function portfolio({owner,chain,balance,scale='1000000',checkedAt,error,external=[],now=Date.now()}){
 assert(['1','1000000'].includes(scale),'supported unit scale');
 const ready=!!balance&&Number.isSafeInteger(checkedAt)&&checkedAt<=now&&now-checkedAt<=60000&&!error;
 const native={asset:'DUBYT',network:chain,address:owner,status:ready?'verified':'unavailable',available:ready?assetDecimal(String(balance.available),scale==='1'?0:6):null,checkedAt:checkedAt??null};
 const assets=[native];
 for(const asset of ['BTC','USDC']){
  const x=external.find(x=>x.asset===asset);if(!x){assets.push({asset,status:'not-connected',available:null,network:null,address:null,checkedAt:null});continue;}
  const fresh=x.status==='observed'&&Number.isSafeInteger(x.checkedAt)&&x.checkedAt<=now&&now-x.checkedAt<=60000;
  assets.push({...x,status:fresh?'observed':x.status==='unavailable'?'unavailable':'stale',available:fresh?assetDecimal(x.availableAtomic,asset==='BTC'?8:6):null,pending:fresh?assetDecimal(x.pendingAtomic,asset==='BTC'?8:6):null});
 }
 return {assets,combinedFiatValue:null,message:'Balances belong to separate networks. External accounts are observed, not verified by DueByte consensus.'};
}
export function checkAssetProfile(p,owner,chain){
 if(p?.version===2){exact(p,['version','isolated','owner','chain','accounts']);assert.equal(p.isolated,false);assert.equal(p.owner,owner);assert.equal(p.chain,chain);assert(Array.isArray(p.accounts)&&p.accounts.length===1);checkEthereumAccount(p.accounts[0]);return p;}
 exact(p,['version','isolated','owner','chain','accounts']);assert.equal(p.version,1);assert.equal(p.isolated,true);assert(/^duebyte-exchange-lab-/.test(chain),'external accounts are isolated-only');assert.equal(p.chain,chain);assert.equal(p.owner,owner);assert(Array.isArray(p.accounts)&&p.accounts.length<=2);
 assert.equal(new Set(p.accounts.map(a=>a.asset)).size,p.accounts.length);
 for(const a of p.accounts){exact(a,['asset','network','address','rpc','genesis','contract','confirmations',...(a.rpcCookieFile!==undefined?['rpcCookieFile']:[])]);assert(['BTC','USDC'].includes(a.asset));const u=new URL(a.rpc);assert.equal(u.protocol,'http:');assert.equal(u.hostname,'127.0.0.1');assert(!u.username&&!u.password&&!u.search&&!u.hash);hex(a.genesis);integer(a.confirmations,1);assert(a.confirmations<=100);
  if(a.rpcCookieFile!==undefined){assert.equal(a.asset,'BTC');assert(/^(?:F:[\\/]DueByteWork[\\/]exchange-[a-z0-9-]+[\\/]btc[\\/]regtest[\\/]|\/tmp\/duebyte-exchange54-[a-z0-9-]+\/btc\/regtest\/)\.cookie$/.test(a.rpcCookieFile),'disposable lab cookie only');}
  if(a.asset==='BTC'){assert.equal(a.network,'bitcoin-regtest');assert.equal(a.contract,'native');assert(/^bcrt1[a-z0-9]+$/.test(a.address));}
  else{assert.equal(a.network,'ethereum-local');assert(/^0x[a-f0-9]{40}$/.test(a.address));assert(/^0x[a-f0-9]{40}$/.test(a.contract));}
 }return p;
}
export async function observeAsset(a,rpc=assetRpc(a)){
 let available=0n,pending=0n,block;
 if(a.asset==='BTC'){
  assert.equal((await rpc('getblockchaininfo')).chain,'regtest');assert.equal(await rpc('getblockhash',[0]),a.genesis);assert((await rpc('validateaddress',[a.address])).isvalid,'invalid BTC address');
  const start=await rpc('getbestblockhash'),info=await rpc('getaddressinfo',[a.address]);assert(info.ismine||info.iswatchonly,'address not tracked by this Bitcoin wallet');
  const outputs=await rpc('listunspent',[0,9999999,[a.address],true]);assert(outputs.length<=10000);const seen=new Set();
  for(const o of outputs){assert.equal(o.address,a.address);hex(o.txid);integer(o.vout);integer(o.confirmations);const id=o.txid+':'+o.vout;assert(!seen.has(id));seen.add(id);const n=BigInt(bitcoinAtomic(o.amount));if(o.confirmations>=a.confirmations)available+=n;else pending+=n;}
  assert.equal(await rpc('getbestblockhash'),start,'BTC tip changed during observation');block=start;
 }else{
  assert.equal(a.asset,'USDC');assert.equal(await rpc('eth_chainId'),'0x7a69');assert.equal((await rpc('eth_getBlockByNumber',['0x0',false])).hash,'0x'+a.genesis);
  const b=await rpc('eth_getBlockByNumber',['finalized',false]);assert(b&&/^0x[a-f0-9]{64}$/.test(b.hash),'finalized block unavailable');
  const number=BigInt(b.number),tip=await rpc('eth_getBlockByNumber',['latest',false]);assert(BigInt(tip.number)-number+1n>=BigInt(a.confirmations),'insufficient finalized depth');
  const call=(data)=>rpc('eth_call',[{to:a.contract,data},b.number]);assert.equal(BigInt(await call('0x313ce567')),6n,'USDC precision');
  const value=await call('0x70a08231'+'0'.repeat(24)+a.address.slice(2));assert(/^0x[a-f0-9]{64}$/.test(value));available=BigInt(value);
  assert.equal((await rpc('eth_getBlockByNumber',[b.number,false])).hash,b.hash,'USDC canonical block changed');block=b.hash;
 }
 return {asset:a.asset,network:a.network,address:a.address,contract:a.contract,status:'observed',availableAtomic:String(available),pendingAtomic:String(pending),pendingScope:a.asset==='BTC'?'Unconfirmed tracked outputs':'Pending contract transfers are not included',checkedAt:Date.now(),block,scope:'Read-only external address balance; not a trading authorization or proof of ownership'};
}
export function assetRpc(a){return localRpc(a.rpc,a.rpcCookieFile?{headers:()=>{const cookie=readFileSync(a.rpcCookieFile,'utf8').trim();assert(cookie.length<=512&&/^[^:\s]+:[^\s]+$/.test(cookie),'lab RPC authentication unavailable');return {Authorization:'Basic '+Buffer.from(cookie).toString('base64')};}}:{});}
export async function observePortfolio(profile,{rpcFor=assetRpc,ethereumOptions}={}){
 return Promise.all(profile.accounts.map(async a=>{try{return profile.version===2?await observeEthereumAccount(a,ethereumOptions):await observeAsset(a,rpcFor(a));}catch{return {asset:a.asset,network:a.network,address:a.address,status:'unavailable',availableAtomic:null,pendingAtomic:null,checkedAt:null};}}));
}
