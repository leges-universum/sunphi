// Bitcoin Core REGTEST wallet adapter; never connects to mainnet/testnet.
import assert from 'node:assert/strict';
import {bitcoinAtomic} from './purchase-observer.mjs';
import {hex} from '../crypto.mjs';
export function bitcoinRefundAdapter({rpc,genesis,maxFeeAtomic='5000'}){
 hex(genesis);assert(/^[1-9][0-9]*$/.test(maxFeeAtomic));const cap=BigInt(maxFeeAtomic);
 const check=async()=>{assert.equal((await rpc('getblockchaininfo')).chain,'regtest');assert.equal(await rpc('getblockhash',[0]),genesis);};
 const inspect=async(raw)=>{
  await check();const tx=await rpc('decoderawtransaction',[raw]);hex(tx.txid);assert(tx.vin.length>0&&tx.vin.length<=16&&tx.vout.length>=1&&tx.vout.length<=2);
  let input=0n;for(const v of tx.vin){hex(v.txid);const prev=await rpc('getrawtransaction',[v.txid,true]),o=prev.vout.find(o=>o.n===v.vout);assert(o?.scriptPubKey?.address);assert.equal((await rpc('getaddressinfo',[o.scriptPubKey.address])).ismine,true,'refund input must belong to seller');input+=BigInt(bitcoinAtomic(o.value));}
  const outputs=tx.vout.map(o=>({destination:o.scriptPubKey?.address,amountAtomic:bitcoinAtomic(o.value)}));assert(outputs.every(o=>typeof o.destination==='string'));
  const fee=input-outputs.reduce((n,o)=>n+BigInt(o.amountAtomic),0n);assert(fee>=0n&&fee<=cap,'refund fee bound');return {tx,outputs};
 };
 // One adapter instance handles one immutable refund scope. On recovery, bind
 // it to the same committed scope before outbox.execute; no new signing needed.
 return {scope:null,
  bind(scope){this.scope=scope;return this;},
  async prepare(scope){this.bind(scope);await check();const i=scope.intent,value=BigInt(i.amountAtomic);assert(value>0n&&value<=2100000000000000n);
   assert(!(await rpc('getaddressinfo',[i.destination])).ismine,'refund destination must not be the seller wallet');
   const change=await rpc('getnewaddress',['duebyte-refund-change']),funded=await rpc('walletcreatefundedpsbt',[[],[{[i.destination]:Number(value)/1e8}],0,{fee_rate:2,lockUnspents:true,changeAddress:change}]);
   assert(BigInt(bitcoinAtomic(funded.fee))<=cap,'refund fee bound');const signed=await rpc('walletprocesspsbt',[funded.psbt]);assert(signed.complete);const final=await rpc('finalizepsbt',[signed.psbt]);assert(final.complete);
   const decoded=await inspect(final.hex);return {raw:final.hex,txid:decoded.tx.txid};
  },
  async inspect(raw){assert(this.scope,'bind committed refund scope first');const d=await inspect(raw),i=this.scope.intent,matched=d.outputs.filter(o=>o.destination===i.destination);assert.equal(matched.length,1);assert.equal(matched[0].amountAtomic,i.amountAtomic);
   for(const o of d.outputs)if(o.destination!==i.destination)assert.equal((await rpc('getaddressinfo',[o.destination])).ismine,true,'unexpected refund output');
   return {txid:d.tx.txid,...matched[0],network:'bitcoin-regtest',asset:'native'};
  },
  async known(txid){try{const tx=await rpc('getrawtransaction',[txid,true]);return tx.txid===txid;}catch{return false;}},
  async broadcast(raw){await this.inspect(raw);return rpc('sendrawtransaction',[raw]);}
 };
}
