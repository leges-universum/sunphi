// Real local-chain adapter. No production endpoints or operational signer keys.
import assert from 'node:assert/strict';
import {hash} from '../../crypto.mjs';
import {bitcoinExchangeScript} from '../../research/exchange-bitcoin-script.mjs';
import {bitcoinAtomic} from '../../research/purchase-observer.mjs';
export function recoveryAdapter({f,orders,joint,btc,evm,abi,watchers,request}){
 const E=evm.ethers,chainId=evm.chainId??31337;assert([1,31337].includes(chainId));const find=p=>{const o=orders.find(o=>o.id===hash(p.quote));assert(o);return o;};
 const calls={prepared:0,broadcast:0,submitted:0};
 return {calls,
  native:async id=>({configHash:hash(f.c),now:joint.net.state().money.time,order:joint.net.state().exchangeBook.orders[id]}),
  async discover(p){const o=find(p);
   if(o.q.asset==='USDC'){
    const logs=await evm.rpc('eth_getLogs',[{address:o.plan.escrow,fromBlock:'0x0',toBlock:'latest'}]);
    const terminal=logs.map(l=>{try{return {event:abi.parseLog(l),transaction:l.transactionHash.slice(2)};}catch{return null;}}).filter(l=>l&&['Claimed','Refunded','Cancelled'].includes(l.event.name));assert(terminal.length<=1);
    return terminal.length?{kind:{Claimed:'PAYOUT',Refunded:'REFUND',Cancelled:'CANCELLED'}[terminal[0].event.name],transaction:terminal[0].transaction}:null;
   }
   // All admitted signed spends are retained in this disposable laboratory.
   for(const [kind,raw]of [['PAYOUT',o.claimRaw],['REFUND',o.refundRaw],['CANCELLED',o.cancelRaw]])if(raw){const txid=(await btc.rpc('decoderawtransaction',[raw])).txid;try{const tx=await btc.rpc('getrawtransaction',[txid,true]);assert.equal(tx.txid,txid);return {kind,transaction:txid};}catch(e){if(e.rpcCode!==-5)throw e;}}
   // A known mempool spend is pending, not proof. Attestation still requires
   // canonical confirmation, and a dropped spend can be rebroadcast unchanged.
   return null;
  },
  async authorize(p){const view=await this.native(hash(p.quote));assert.equal(view.configHash,hash(f.c));assert.equal(view.order.status,'LOCKED');assert.deepEqual(view.order.quote,p.quote);assert.deepEqual(view.order.plan,p.arm.plan);assert(view.now>=p.quote.externalUntil);assert.equal(await this.discover(p),null);},
  async plan(p){const o=find(p);assert.equal(p.recoveryKind,o.outcome);assert(['REFUND','CANCELLED'].includes(p.recoveryKind));
   if(o.q.asset==='BTC'){const raw=p.recoveryKind==='REFUND'?o.refundRaw:o.cancelRaw,tx=await btc.rpc('decoderawtransaction',[raw]);return {resources:tx.vin.map(v=>'btc-regtest:'+v.txid+':'+v.vout),transaction:tx.txid};}
   const w=evm.wallets[3],block=await evm.rpc('eth_getBlockByNumber',['latest',false]);
   const nonce=Number(BigInt(await evm.rpc('eth_getTransactionCount',[w.address,'pending'])));
   return {resources:['evm:'+chainId+':'+w.address.toLowerCase()+':'+nonce],unsigned:{type:2,chainId,nonce,to:o.plan.escrow,data:abi.encodeFunctionData(p.recoveryKind==='REFUND'?'refund':'cancelUnfunded',['0x'+o.id]),value:'0',gasLimit:'300000',maxFeePerGas:(BigInt(block.baseFeePerGas)*2n+1000000000n).toString(),maxPriorityFeePerGas:'1000000000'}};
  },
  async sign(p,plan){calls.prepared++;const o=find(p);if(o.q.asset==='BTC'){const raw=p.recoveryKind==='REFUND'?o.refundRaw:o.cancelRaw;assert.equal((await btc.rpc('decoderawtransaction',[raw])).txid,plan.transaction);return {raw,transaction:plan.transaction};}
   const raw=await evm.wallets[3].signTransaction(plan.unsigned);return {raw:raw.slice(2),transaction:E.keccak256(raw).slice(2)};
  },
  async prepare(p){return this.sign(p,await this.plan(p));},
  async inspectPlan(p,s,plan){await this.inspect(p,s);if(p.quote.asset==='BTC'){const tx=await btc.rpc('decoderawtransaction',[s.raw]);assert.equal(tx.txid,plan.transaction);assert.deepEqual(plan.resources,tx.vin.map(v=>'btc-regtest:'+v.txid+':'+v.vout));return;}
   const tx=E.Transaction.from('0x'+s.raw),u=plan.unsigned;assert.equal(tx.nonce,u.nonce);assert.equal(tx.maxFeePerGas.toString(),u.maxFeePerGas);assert.equal(tx.maxPriorityFeePerGas.toString(),u.maxPriorityFeePerGas);assert.deepEqual(plan.resources,['evm:'+chainId+':'+tx.from.toLowerCase()+':'+tx.nonce]);
  },
  async failed(p,s){const o=find(p);assert.equal(o.q.asset,'USDC');
   const r=await evm.rpc('eth_getTransactionReceipt',['0x'+s.transaction]);if(!r||r.status==='0x1')return null;
   assert.equal(r.status,'0x0');assert.equal(r.transactionHash,'0x'+s.transaction);assert.equal(r.to.toLowerCase(),o.plan.escrow);
   const tip=await evm.rpc('eth_getBlockByNumber',['latest',false]);if(BigInt(tip.number)-BigInt(r.blockNumber)+1n<2n)return null;
   assert.equal((await evm.rpc('eth_getBlockByNumber',[r.blockNumber,false])).hash,r.blockHash);
   return {transaction:s.transaction,block:r.blockHash.slice(2)};
  },
  async inspect(p,s){const o=find(p);assert(['REFUND','CANCELLED'].includes(p.recoveryKind));
   if(o.q.asset==='USDC'){const tx=E.Transaction.from('0x'+s.raw);assert.equal(tx.hash.slice(2),s.transaction);assert.equal(tx.chainId,BigInt(chainId));assert.equal(tx.to.toLowerCase(),o.plan.escrow);assert.equal(tx.value,0n);assert.equal(tx.from.toLowerCase(),evm.wallets[3].address.toLowerCase());assert(tx.gasLimit<=300000n&&tx.maxFeePerGas<=100000000000n);assert.equal(tx.data,abi.encodeFunctionData(p.recoveryKind==='REFUND'?'refund':'cancelUnfunded',['0x'+o.id]));return;}
   const tx=await btc.rpc('decoderawtransaction',[s.raw]);assert.equal(tx.txid,s.transaction);assert.equal(tx.vout.length,1);assert.equal(tx.vout[0].scriptPubKey.address,o.q.externalRefund);
   if(p.recoveryKind==='REFUND'){assert.equal(tx.vin.length,1);assert.equal(tx.vin[0].txid,o.plan.fundingTransaction);assert.equal(tx.vin[0].vout,o.plan.index);assert.equal(tx.locktime,o.q.externalUntil);const script=bitcoinExchangeScript({network:'bitcoin-regtest',hashlock:o.q.hashlock,claimKey:o.plan.claimKey,refundKey:o.plan.refundKey,refundAt:o.q.externalUntil});assert.equal(tx.vin[0].txinwitness.length,3);assert.equal(tx.vin[0].txinwitness[1],'');assert.equal(tx.vin[0].txinwitness[2],script.witnessScript);assert.equal(bitcoinAtomic(tx.vout[0].value),o.q.externalAtomic);}
   else{const funding=await btc.rpc('decoderawtransaction',[o.fundingRaw]);assert.equal(funding.txid,o.plan.fundingTransaction);assert.deepEqual(tx.vin.map(v=>[v.txid,v.vout]),funding.vin.map(v=>[v.txid,v.vout]));let total=0n;for(const v of tx.vin){const prev=await btc.rpc('getrawtransaction',[v.txid,true]);total+=BigInt(bitcoinAtomic(prev.vout.find(x=>x.n===v.vout).value));}assert.equal(total-BigInt(bitcoinAtomic(tx.vout[0].value)),2000n);}
  },
  async broadcast(p,s){calls.broadcast++;find(p);if(p.quote.asset==='BTC'){await btc.rpc('setmocktime',[Math.floor(Date.now()/1000)]);await btc.rpc('generatetoaddress',[12,p.quote.externalRefund]);const id=await btc.rpc('sendrawtransaction',[s.raw]);await btc.mine(2);return id;}
   await evm.rpc('evm_setTime',[Date.now()]);const receipt=await evm.receipt(await evm.rpc('eth_sendRawTransaction',['0x'+s.raw]));assert.equal(receipt.status,'0x1');return receipt.transactionHash.slice(2);
  },
  async attest(p,external){const o=find(p),w=watchers();assert(w.children.filter(c=>c.connected).length>=2,'observer quorum offline');return w.receipt(request(o,external.transaction,external.kind));},
  // Queue acceptance is not completion. The worker checks authoritative native
  // state on its next cycle; one order must not block all other recoveries while
  // waiting for a ten-second block and its RPC transaction index.
  async submit(command){calls.submitted++;await joint.net.broadcast(f.wire(command));}
 };
}
