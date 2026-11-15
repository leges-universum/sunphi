// Isolated chain qualification only. Never use this adapter for mainnet.
import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire} from 'node:module';
import {hash} from '../../crypto.mjs';import {VerifiedClient} from '../../client.mjs';
import {localRpc} from '../../research/purchase-observer.mjs';
import {recoveryAdapter} from './exchange-recovery-adapter.mjs';
import {bitcoinExchangeScript} from '../../research/exchange-bitcoin-script.mjs';
import {bitcoinSpend} from './exchange-bitcoin-spend.mjs';
export async function createBackend(c,secrets){
 const E=createRequire(c.tools+'/package.json')('ethers'),client=new VerifiedClient(c.verifier);
 const cookie=fs.readFileSync(c.bitcoin.cookieFile,'utf8'),rawBTC=localRpc(c.bitcoin.url,{headers:{Authorization:'Basic '+Buffer.from(cookie).toString('base64')}});
 assert.equal(new URL(c.bitcoin.url).hostname,'127.0.0.1');assert.equal(new URL(c.evmUrl).hostname,'127.0.0.1');
 const btc={rpc:(m,p)=>{assert(['getblockchaininfo','getblockhash','getrawtransaction','decoderawtransaction','validateaddress','gettxout','testmempoolaccept'].includes(m));return rawBTC(m,p);}};
 const chainId=c.chainId??31337;assert([1,31337].includes(chainId));assert.equal(c.config.exchangeLab.policy.routes.USDC.network,'ethereum-local');const rawEVM=localRpc(c.evmUrl),evm={chainId,ethers:E,wallets:[null,null,null,new E.Wallet(secrets.evmKey)],rpc:(m,p)=>{assert(['eth_chainId','eth_getLogs','eth_getBlockByNumber','eth_getTransactionCount','eth_getTransactionReceipt','eth_getCode','eth_call'].includes(m));return rawEVM(m,p);}};
 assert.equal((await btc.rpc('getblockchaininfo')).chain,'regtest');assert.equal(await btc.rpc('getblockhash',[0]),c.config.exchangeLab.policy.routes.BTC.genesis);assert.equal(await evm.rpc('eth_chainId'), '0x'+chainId.toString(16));assert.equal((await evm.rpc('eth_getBlockByNumber',['0x0',false])).hash.slice(2),c.config.exchangeLab.policy.routes.USDC.genesis);
 const orders=c.orders.map(o=>({...o,...secrets.bitcoin[o.id]})),abi=new E.Interface(c.abi),adapter=recoveryAdapter({f:{c:c.config},orders,btc,evm,abi});
 adapter.native=async id=>{const {state}=await client.sync(c.checkpoint,c.nativeUrl,{service:true});return {configHash:state.configHash,now:state.money.time,order:state.exchangeBook.orders[id]};};
 const oldAuthorize=adapter.authorize.bind(adapter);
 adapter.authorize=async p=>{await oldAuthorize(p);if(p.quote.asset==='USDC')assert.equal(E.sha256(await evm.rpc('eth_getCode',[p.arm.plan.escrow,'latest'])).slice(2),p.arm.plan.codeHash);};
 const refundTerms=new Map();
 for(const o of orders)if(o.q.asset==='BTC'&&o.outcome==='REFUND'){
  const script=bitcoinExchangeScript({network:'bitcoin-regtest',hashlock:o.q.hashlock,claimKey:o.plan.claimKey,refundKey:o.plan.refundKey,refundAt:o.q.externalUntil});
  const terms={txid:o.plan.fundingTransaction,index:o.plan.index,amount:String(BigInt(o.q.externalAtomic)+1000n),output:(await btc.rpc('validateaddress',[o.q.externalRefund])).scriptPubKey,script:script.witnessScript,refundAt:o.q.externalUntil};refundTerms.set(o.id,terms);
  // SegWit txid excludes witness. An empty witness permits planning without
  // invoking the refund key before the authority reserves the input durably.
  o.refundRaw=bitcoinSpend(E,terms);
 }
 const oldSign=adapter.sign.bind(adapter);adapter.sign=async(p,plan)=>{
  const o=orders.find(o=>o.id===hash(p.quote));
  if(refundTerms.has(o.id))o.refundRaw=bitcoinSpend(E,{...refundTerms.get(o.id),key:o.refundKey});
  if(o.cancelUnsigned){
   assert.equal(p.recoveryKind,'CANCELLED');const tx=await btc.rpc('decoderawtransaction',[o.cancelUnsigned]);assert.equal(tx.txid,plan.transaction);
   for(const input of tx.vin)assert(await btc.rpc('gettxout',[input.txid,input.vout,true]),'funding input already spent');
   // Disposable Core wallet only. Called after the independent reservation.
   const wallet=localRpc(c.bitcoin.url+'/wallet/'+(o.externalPayer?'seller':'buyer'),{headers:{Authorization:'Basic '+Buffer.from(cookie).toString('base64')}});
   const signed=await wallet('signrawtransactionwithwallet',[o.cancelUnsigned]);assert(signed.complete);o.cancelRaw=signed.hex;
  }
  const signed=await oldSign(p,plan);if(o.cancelUnsigned)assert.equal((await btc.rpc('testmempoolaccept',[[signed.raw]]))[0].allowed,true,'Bitcoin cancellation signature rejected');return signed;
 };
 const backend=Object.fromEntries(['authorize','plan','sign','failed'].map(k=>[k,adapter[k].bind(adapter)]));backend.inspect=adapter.inspectPlan.bind(adapter);
 // QA diagnostics contain only method/type/source frame, never arguments or messages.
 for(const name of ['authorize','plan','sign','inspect','failed']){const method=backend[name];backend[name]=async(...args)=>{try{return await method(...args);}catch(e){process.stderr.write(JSON.stringify({stage:name,type:e.name,frame:e.stack?.split('\n').find(x=>x.trim().startsWith('at '))??'unknown'})+'\n');throw e;}};}
 backend.close=()=>client.close();return backend;
}
