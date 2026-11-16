// Isolated full-node observations. RPC trust is not a cryptographic chain proof.
import assert from 'node:assert/strict';
import {hash,digest,hex,integer,verify,sign,exact} from '../crypto.mjs';
import {EXCHANGE,checkExchangeQuote,exchangeAcceptance} from './exchange-escrow.mjs';
import {bitcoinExchangeScript} from './exchange-bitcoin-script.mjs';
import {bitcoinAtomic} from './purchase-observer.mjs';
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const locked='0x4f6c8ec9481d8619704296e9db3aa775fd920d534ec45ef9e9e0fee3d20e11de';
const claimed='0x38d6042dbdae8e73a7f6afbabd3fbe0873f9f5ed3cd71294591c3908c2e65fee';
const words=s=>{assert(/^0x(?:[a-f0-9]{64})+$/.test(s),'ABI words');return s.slice(2).match(/.{64}/g);};
const address=w=>{assert(/^0{24}[a-f0-9]{40}$/.test(w));return '0x'+w.slice(24);};
const qty=s=>{assert(/^0x(?:0|[1-9a-f][a-f0-9]*)$/.test(s));return integer(Number(BigInt(s)));};
export const bitcoinDescriptor=(q,claimKey,refundKey)=>({domain:EXCHANGE+'/BTC_DESCRIPTOR',order:hash(q),claimKey,refundKey,feeAtomic:'1000'});
export async function observeExchange({policy:p,pins,rpc,request:r,now}){
 exact(r,['kind','quote','providerSignature','userSignature','transaction','descriptor']);
 const q=r.quote,id=hash(q),route=p.routes[q.asset];integer(now,1);hex(r.transaction);
 checkExchangeQuote(p,q,q.createdAt);
 assert(now>=q.createdAt&&now<q.dubytUntil,'observation outside claim window');
 assert(verify(q,r.providerSignature,p.provider),'seller signature');
 assert(verify(exchangeAcceptance(q),r.userSignature,q.user),'buyer acceptance');
 assert(r.kind===(q.direction==='BUY_DUBYT'?'FUNDING':'SETTLEMENT'),'direction evidence');
 assert(Number.isSafeInteger(pins.confirmations)&&pins.confirmations>=2);
 let block,reference;
 if(q.asset==='USDC'){
  assert.equal(r.descriptor,null);assert.equal(await rpc('eth_chainId',[]),'0x7a69');
  assert.equal((await rpc('eth_getBlockByNumber',['0x0',false])).hash,'0x'+route.genesis);
  assert(/^0x[a-f0-9]{40}$/.test(pins.escrow));hex(pins.codeHash);
  assert.equal(digest(Buffer.from((await rpc('eth_getCode',[pins.escrow,'latest'])).slice(2),'hex')),pins.codeHash,'escrow bytecode pin');
  assert.equal(address(words(await rpc('eth_call',[{to:pins.escrow,data:'0xfc0c546a'},'latest']))[0]),route.contract,'escrow token pin');
  const tx='0x'+r.transaction,receipt=await rpc('eth_getTransactionReceipt',[tx]);
  assert(receipt&&receipt.status==='0x1','successful external receipt required');assert.equal(receipt.transactionHash,tx);assert.equal(receipt.to,pins.escrow);
  const canonical=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);assert.equal(canonical.hash,receipt.blockHash,'canonical receipt');
  assert(qty(canonical.timestamp)>=q.createdAt&&qty(canonical.timestamp)<q.externalUntil,'external execution deadline');
  const tip=await rpc('eth_getBlockByNumber',['latest',false]);assert(qty(tip.number)-qty(receipt.blockNumber)+1>=pins.confirmations,'external confirmations');
  const terms=words(await rpc('eth_call',[{to:pins.escrow,data:'0xed5e8437'+id},'latest']));assert.equal(terms.length,6);
  assert.equal(address(terms[0]),q.externalRefund);assert.equal(address(terms[1]),q.externalRecipient);assert.equal(BigInt('0x'+terms[2]).toString(),q.externalAtomic);assert.equal(terms[3],q.hashlock);assert.equal(BigInt('0x'+terms[4]),BigInt(q.externalUntil));
  assert.equal(BigInt('0x'+terms[5]),r.kind==='FUNDING'?1n:2n,'escrow state');
  const events=receipt.logs.filter(l=>l.address===pins.escrow&&l.topics[0]===(r.kind==='FUNDING'?locked:claimed)&&l.topics[1]==='0x'+id);assert.equal(events.length,1,'exact order event');
  for(const l of receipt.logs){assert.equal(l.removed,false);assert.equal(l.transactionHash,tx);assert.equal(l.blockHash,receipt.blockHash);}
  const event=words(events[0].data);
  if(r.kind==='FUNDING')assert.deepEqual(event,terms.slice(0,5));
  else{
   assert.equal(event.length,1);assert.equal(digest(Buffer.from(event[0],'hex')),q.hashlock);
   const payments=receipt.logs.filter(l=>l.address===route.contract&&l.topics.length===3&&l.topics[0]===transfer&&l.topics[1]==='0x'+'0'.repeat(24)+pins.escrow.slice(2)&&l.topics[2]==='0x'+'0'.repeat(24)+q.externalRecipient.slice(2));
   assert.equal(payments.length,1,'exact escrow payout');assert.equal(BigInt(payments[0].data).toString(),q.externalAtomic);
  }
  assert.equal((await rpc('eth_getBlockByNumber',[receipt.blockNumber,false])).hash,receipt.blockHash,'reorg during observation');
  block=receipt.blockHash.slice(2);reference=pins.escrow+':'+id;
 }else{
  assert.equal(q.asset,'BTC');assert.equal((await rpc('getblockchaininfo',[])).chain,'regtest');assert.equal(await rpc('getblockhash',[0]),route.genesis);
  const d=r.descriptor;exact(d,['body','providerSignature','userSignature','fundingTransaction','index']);hex(d.fundingTransaction);integer(d.index);assert(d.index<1000000);
  assert.deepEqual(d.body,bitcoinDescriptor(q,d.body.claimKey,d.body.refundKey));
  assert(verify(d.body,d.providerSignature,q.provider)&&verify(d.body,d.userSignature,q.user),'both parties must accept Bitcoin script keys');
  const script=bitcoinExchangeScript({network:route.network,hashlock:q.hashlock,claimKey:d.body.claimKey,refundKey:d.body.refundKey,refundAt:q.externalUntil});
  const funding=await rpc('getrawtransaction',[d.fundingTransaction,true]),output=funding.vout.find(x=>x.n===d.index);assert(output);assert.equal(output.scriptPubKey.hex,script.scriptPubKey);assert.equal(bitcoinAtomic(output.value),String(BigInt(q.externalAtomic)+BigInt(d.body.feeAtomic)));
  const tx=await rpc('getrawtransaction',[r.transaction,true]);assert.equal(tx.txid,r.transaction);hex(tx.blockhash);
  const header=await rpc('getblockheader',[tx.blockhash,true]);assert.equal(await rpc('getblockhash',[header.height]),tx.blockhash);assert(header.time>=q.createdAt&&header.time<q.externalUntil);assert((await rpc('getblockcount',[]))-header.height+1>=pins.confirmations);
  if(r.kind==='FUNDING'){
   assert.equal(r.transaction,d.fundingTransaction);const unspent=await rpc('gettxout',[r.transaction,d.index,true]);assert(unspent&&unspent.confirmations>=pins.confirmations,'funding is spent or unconfirmed');assert.equal(unspent.scriptPubKey.hex,script.scriptPubKey);assert.equal(bitcoinAtomic(unspent.value),bitcoinAtomic(output.value));
  }else{
   assert.equal(tx.vin.length,1);assert.equal(tx.vin[0].txid,d.fundingTransaction);assert.equal(tx.vin[0].vout,d.index);
   const witness=tx.vin[0].txinwitness;assert(witness&&witness.length===4&&witness[2]==='01'&&witness[3]===script.witnessScript,'claim branch required');hex(witness[1]);assert.equal(digest(Buffer.from(witness[1],'hex')),q.hashlock);
   assert.equal(tx.vout.length,1);assert.equal(tx.vout[0].scriptPubKey.address,q.externalRecipient);assert.equal(bitcoinAtomic(tx.vout[0].value),q.externalAtomic);
  }
  assert.equal(await rpc('getblockhash',[header.height]),tx.blockhash,'reorg during observation');block=tx.blockhash;reference=d.fundingTransaction+':'+d.index;
 }
 const body={domain:EXCHANGE+'/'+r.kind,policyHash:hash(p),order:id,asset:q.asset,network:route.network,transaction:r.transaction,block,amountAtomic:q.externalAtomic,recipient:q.externalRecipient,observedAt:now,expiresAt:now+120};
 if(r.kind==='FUNDING')Object.assign(body,{genesis:route.genesis,contract:route.contract,escrow:reference,refundAddress:q.externalRefund,hashlock:q.hashlock,refundAt:q.externalUntil,status:'FUNDED'});
 return body;
}
export async function attestExchange(args,key){assert(args.policy.observers.includes(key.publicKey));const body=await observeExchange(args);return {body,signature:{observer:key.publicKey,signature:sign(body,key.privateKey)}};}
