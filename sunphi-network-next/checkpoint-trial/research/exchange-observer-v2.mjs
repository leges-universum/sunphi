// Independent terminal-outcome observations for the isolated V2 protocol.
import assert from 'node:assert/strict';
import {hash,digest,hex,integer,verify,sign,exact} from '../crypto.mjs';
import {checkExchangeQuote,exchangeAcceptance} from './exchange-escrow.mjs';
import {EXCHANGE_V2,checkExchangeArm} from './exchange-resolution.mjs';
import {bitcoinExchangeScript} from './exchange-bitcoin-script.mjs';
import {bitcoinAtomic} from './purchase-observer.mjs';
import {observeEthereumExchange} from './ethereum-exchange-observer.mjs';
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const claimed='0x38d6042dbdae8e73a7f6afbabd3fbe0873f9f5ed3cd71294591c3908c2e65fee';
const refunded='0xfe509803c09416b28ff3d8f690c8b0c61462a892c46d5430c8fb20abe472daf0';
const cancelled='0xbaa1eb22f2a492ba1a5fea61b8df4d27c6c8b5f3971e63bb58fa14ff72eedb70';
const words=s=>{assert(/^0x(?:[a-f0-9]{64})+$/.test(s));return s.slice(2).match(/.{64}/g);};
const address=w=>{assert(/^0{24}[a-f0-9]{40}$/.test(w));return '0x'+w.slice(24);};
const qty=s=>{assert(/^0x(?:0|[1-9a-f][a-f0-9]*)$/.test(s));return integer(Number(BigInt(s)));};
export async function observeExchangeResolution({policy:p,pins,rpc,request:r,now}){
 if(r.quote?.asset==='USDC'&&p.routes?.USDC?.network==='ethereum-mainnet')return observeEthereumExchange({policy:p,pins,rpc,request:r,now});
 exact(r,['kind','quote','providerSignature','userSignature','arm','transaction',...(r.kind==='CANCELLED'&&r.quote?.asset==='BTC'?['fundingRaw']:[])]);assert.equal(p.domain,EXCHANGE_V2);assert(['PAYOUT','REFUND','CANCELLED'].includes(r.kind));
 const q=r.quote,id=hash(q),route=p.routes[q.asset];checkExchangeQuote(p,q,q.createdAt);checkExchangeArm(q,r.arm);const plan=r.arm.plan;
 assert(verify(q,r.providerSignature,p.provider));assert(verify(exchangeAcceptance(q),r.userSignature,q.user));hex(r.transaction);integer(now,q.createdAt);
 assert(Number.isSafeInteger(pins.confirmations)&&pins.confirmations>=2);
 const recipient=r.kind==='PAYOUT'?q.externalRecipient:q.externalRefund;let block,executedAt,escrow;
 if(q.asset==='USDC'){
  assert.equal(await rpc('eth_chainId',[]),'0x7a69');assert.equal((await rpc('eth_getBlockByNumber',['0x0',false])).hash,'0x'+route.genesis);
  assert((pins.escrows??[pins.escrow]).includes(plan.escrow),'pinned escrow');assert.equal(plan.codeHash,pins.codeHash);
  const tx='0x'+r.transaction,receipt=await rpc('eth_getTransactionReceipt',[tx]);assert(receipt&&receipt.status==='0x1','successful external receipt required');assert.equal(receipt.transactionHash,tx);assert.equal(receipt.to,plan.escrow);
  // Inspect one confirmed state, not independently moving latest responses.
  // An RPC unable to serve that historical state must refuse the observation.
  qty(receipt.blockNumber);
  assert.equal(digest(Buffer.from((await rpc('eth_getCode',[plan.escrow,receipt.blockNumber])).slice(2),'hex')),plan.codeHash);
  assert.equal(address(words(await rpc('eth_call',[{to:plan.escrow,data:'0xfc0c546a'},receipt.blockNumber]))[0]),route.contract);
  const canonical=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);assert.equal(canonical.hash,receipt.blockHash);executedAt=qty(canonical.timestamp);
  const tip=await rpc('eth_getBlockByNumber',['latest',false]);assert(qty(tip.number)-qty(receipt.blockNumber)+1>=pins.confirmations,'external confirmations');
  const terms=words(await rpc('eth_call',[{to:plan.escrow,data:'0xed5e8437'+id},receipt.blockNumber]));assert.equal(terms.length,6);
  assert.equal(address(terms[0]),q.externalRefund);assert.equal(address(terms[1]),q.externalRecipient);assert.equal(BigInt('0x'+terms[2]).toString(),q.externalAtomic);assert.equal(terms[3],q.hashlock);assert.equal(BigInt('0x'+terms[4]),BigInt(q.externalUntil));assert.equal(BigInt('0x'+terms[5]),r.kind==='PAYOUT'?2n:r.kind==='REFUND'?3n:5n);
  for(const l of receipt.logs){assert.equal(l.removed,false);assert.equal(l.transactionHash,tx);assert.equal(l.blockHash,receipt.blockHash);}
  const events=receipt.logs.filter(l=>l.address===plan.escrow&&l.topics.length===2&&[claimed,refunded,cancelled].includes(l.topics[0])&&l.topics[1]==='0x'+id);assert.equal(events.length,1,'exact terminal event');assert.equal(events[0].topics[0],r.kind==='PAYOUT'?claimed:r.kind==='REFUND'?refunded:cancelled);
  if(r.kind==='PAYOUT'){const event=words(events[0].data);assert.equal(event.length,1);assert.equal(digest(Buffer.from(event[0],'hex')),q.hashlock);}else assert.equal(events[0].data,'0x');
  const payments=receipt.logs.filter(l=>l.address===route.contract&&l.topics.length===3&&l.topics[0]===transfer&&l.topics[1]==='0x'+'0'.repeat(24)+plan.escrow.slice(2)&&l.topics[2]==='0x'+'0'.repeat(24)+recipient.slice(2));
  if(r.kind==='CANCELLED')assert.equal(payments.length,0,'unfunded cancellation is not a token refund');else{assert.equal(payments.length,1,'successful terminal token transfer');assert.equal(BigInt(payments[0].data).toString(),q.externalAtomic);}
  assert.equal((await rpc('eth_getBlockByNumber',[receipt.blockNumber,false])).hash,receipt.blockHash,'reorg during observation');block=receipt.blockHash.slice(2);escrow=plan.escrow+':'+id;
 }else{
  assert.equal(q.asset,'BTC');assert.equal((await rpc('getblockchaininfo',[])).chain,'regtest');assert.equal(await rpc('getblockhash',[0]),route.genesis);
  const script=bitcoinExchangeScript({network:route.network,hashlock:q.hashlock,claimKey:plan.claimKey,refundKey:plan.refundKey,refundAt:q.externalUntil});
  if(r.kind==='CANCELLED')assert(typeof r.fundingRaw==='string'&&/^(?:[a-f0-9]{2})+$/.test(r.fundingRaw)&&r.fundingRaw.length<=200000,'bounded exact funding transaction');
  const funding=r.kind==='CANCELLED'?await rpc('decoderawtransaction',[r.fundingRaw]):await rpc('getrawtransaction',[plan.fundingTransaction,true]);
  if(r.kind==='CANCELLED')assert.equal(funding.txid,plan.fundingTransaction,'signed plan funding identity');
  const output=funding.vout.find(x=>x.n===plan.index);assert(output);assert.equal(output.scriptPubKey.hex,script.scriptPubKey);assert.equal(bitcoinAtomic(output.value),String(BigInt(q.externalAtomic)+BigInt(plan.feeAtomic)));
  const tx=await rpc('getrawtransaction',[r.transaction,true]);assert.equal(tx.txid,r.transaction);hex(tx.blockhash);const header=await rpc('getblockheader',[tx.blockhash,true]);assert.equal(await rpc('getblockhash',[header.height]),tx.blockhash);assert((await rpc('getblockcount',[]))-header.height+1>=pins.confirmations);executedAt=header.time;
  if(r.kind==='CANCELLED'){
   assert.notEqual(tx.txid,plan.fundingTransaction,'funding is not cancellation');
   assert(Array.isArray(funding.vin)&&funding.vin.length>0&&funding.vin.every(v=>typeof v.txid==='string'&&/^[a-f0-9]{64}$/.test(v.txid)&&Number.isSafeInteger(v.vout)&&v.vout>=0),'funding inputs');
   assert(tx.vin.some(v=>funding.vin.some(f=>v.txid===f.txid&&v.vout===f.vout)),'confirmed conflicting input required');
  }else{
  assert.equal(tx.vin.length,1);assert.equal(tx.vin[0].txid,plan.fundingTransaction);assert.equal(tx.vin[0].vout,plan.index);const w=tx.vin[0].txinwitness;
  if(r.kind==='PAYOUT'){assert(w&&w.length===4&&w[2]==='01'&&w[3]===script.witnessScript);hex(w[1]);assert.equal(digest(Buffer.from(w[1],'hex')),q.hashlock);}
  else{assert(w&&w.length===3&&w[1]===''&&w[2]===script.witnessScript,'refund branch');assert(tx.locktime>=q.externalUntil&&tx.locktime<5000000000);}
  assert.equal(tx.vout.length,1);assert.equal(tx.vout[0].scriptPubKey.address,recipient);assert.equal(bitcoinAtomic(tx.vout[0].value),q.externalAtomic);
  }
  assert.equal(await rpc('getblockhash',[header.height]),tx.blockhash,'reorg during observation');block=tx.blockhash;escrow=plan.fundingTransaction+':'+plan.index;
 }
 assert(executedAt>=q.createdAt&&executedAt<=now,'execution time');if(r.kind==='REFUND')assert(executedAt>=q.externalUntil);else if(q.asset==='USDC'&&r.kind==='PAYOUT')assert(executedAt<q.externalUntil);
 return {domain:EXCHANGE_V2+'/RESOLUTION',policyHash:hash(p),order:id,planHash:hash(plan),asset:q.asset,network:route.network,genesis:route.genesis,contract:route.contract,escrow,status:r.kind,transaction:r.transaction,block,amountAtomic:q.externalAtomic,recipient,refundAddress:q.externalRefund,executedAt,observedAt:now,expiresAt:now+120};
}
export async function attestExchangeResolution(args,key){assert(args.policy.observers.includes(key.publicKey));const body=await observeExchangeResolution(args);return {body,signature:{observer:key.publicKey,signature:sign(body,key.privateKey)}};}
