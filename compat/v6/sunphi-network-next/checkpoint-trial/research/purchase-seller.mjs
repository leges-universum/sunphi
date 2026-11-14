// Seller coordination has no private signing key. Test-network admission only.
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {hash} from '../crypto.mjs';
import {isolatedPurchaseConfig} from './purchase-api.mjs';

export async function startSellerSigner(options){
 const child=fork(fileURLToPath(new URL('./purchase-seller-signer.mjs',import.meta.url)),[],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],execArgv:[]});let sequence=0,closed=false;const pending=new Map();
 const fail=()=>{closed=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Seller signer unavailable.'));}pending.clear();};
 child.on('error',fail);child.on('exit',fail);child.on('message',m=>{const p=pending.get(m.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.result);});
 const call=(action,payload)=>new Promise((resolve,reject)=>{if(closed)return reject(Error('Seller signer closed.'));const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Seller signer timeout.'));child.kill();},15000);pending.set(id,{resolve,reject,timer});child.send({id,action,payload},e=>{if(e){clearTimeout(timer);pending.delete(id);reject(Error('Seller signer unavailable.'));}});});
 const close=async()=>{if(closed||child.exitCode!==null||child.signalCode!==null)return;const done=new Promise(r=>child.once('exit',r));if(child.connected)child.disconnect();await done;};
 try{await call('unlock',options);}catch(e){await close();throw e;}
 return {quote:p=>call('quote',p),prepare:p=>call('prepare',p),close};
}

export class FundedPurchaseSeller {
 constructor({config,signer,state,bitcoinRpc,btcDestinations,usdcDestinations,usedDestinations}){
  this.policy=isolatedPurchaseConfig(config);Object.assign(this,{config,signer,state,bitcoinRpc,btcDestinations,usdcDestinations,usedDestinations});
 }
 inventory(value){
  const s=this.state();assert.equal(s.configHash,hash(this.config));assert.equal(s.money.unitScale,'1000000');
  const need=BigInt(value)+BigInt(this.config.purchaseLab.feeMicro);let total=0n;const ids=[];
  const rows=Object.entries(s.money.outputs).filter(([,o])=>o.owner===this.policy.seller&&o.unlock<=s.money.time).sort((a,b)=>BigInt(a[1].value)>BigInt(b[1].value)?-1:BigInt(a[1].value)<BigInt(b[1].value)?1:a[0].localeCompare(b[0]));
  for(const [id,o] of rows.slice(0,8)){ids.push(id);total+=BigInt(o.value);if(total>=need)break;}
  assert(total>=need,'seller inventory unavailable');return ids.sort();
 }
 async quote(p){
  this.inventory(p.dubytMicro);let destination;
  if(p.route==='BTC'){
   assert.equal((await this.bitcoinRpc('getblockchaininfo')).chain,'regtest','isolated Bitcoin network required');
   assert.equal(await this.bitcoinRpc('getblockhash',[0]),this.policy.rpcPins.BTC.genesis,'Bitcoin genesis pin');
   assert((await this.bitcoinRpc('validateaddress',[p.refundDestination])).isvalid,'invalid Bitcoin refund address');
   assert(Array.isArray(this.btcDestinations),'provisioned Bitcoin deposit pool required');
   const used=new Set(this.usedDestinations());destination=this.btcDestinations.find(a=>!used.has(a));assert(destination,'provisioned deposit pool exhausted');
   assert((await this.bitcoinRpc('getaddressinfo',[destination])).ismine,'deposit address must belong to seller');
  }else{assert.equal(p.route,'USDC');const used=new Set(this.usedDestinations());destination=this.usdcDestinations.find(a=>!used.has(a));assert(destination,'provisioned deposit pool exhausted');}
  return this.signer.quote({...p,destination});
 }
 async prepare(command){return Buffer.from(JSON.stringify(await this.signer.prepare({command,inputs:this.inventory(command.offer.dubytMicro)})));}
}
