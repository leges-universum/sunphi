import test from 'node:test';import assert from 'node:assert/strict';
import {hash,digest} from '../crypto.mjs';
import {resolutionFixture} from './helpers/exchange-resolution-fixture.mjs';
import {observeExchangeResolution} from '../research/exchange-observer-v2.mjs';
import {bitcoinExchangeScript} from '../research/exchange-bitcoin-script.mjs';
function fixture(direction,asset,kind){
 const f=resolutionFixture(600000000),o=f.order(direction,asset),q=o.q,plan=o.plan,transaction=hash(['external',asset,kind]),block=hash('block'),time=kind==='PAYOUT'?600000020:q.externalUntil+1;
 const recipient=kind==='PAYOUT'?q.externalRecipient:q.externalRefund,script=asset==='BTC'?bitcoinExchangeScript({network:f.p.routes.BTC.network,hashlock:q.hashlock,claimKey:plan.claimKey,refundKey:plan.refundKey,refundAt:q.externalUntil}):null;
 const word=n=>BigInt(n).toString(16).padStart(64,'0'),addr=a=>a.slice(2).padStart(64,'0'),hex=n=>'0x'+n.toString(16),data={};
 let rpc;
 if(asset==='BTC'){
  data.funding={txid:plan.fundingTransaction,vin:[{txid:hash('funding input'),vout:0}],vout:[{n:plan.index,value:Number(BigInt(q.externalAtomic)+1000n)/1e8,scriptPubKey:{hex:script.scriptPubKey}}]};
  data.tx={txid:transaction,blockhash:block,locktime:q.externalUntil,vin:[{txid:plan.fundingTransaction,vout:plan.index,txinwitness:kind==='PAYOUT'?['signature',o.secret,'01',script.witnessScript]:['signature','',script.witnessScript]}],vout:[{value:Number(q.externalAtomic)/1e8,scriptPubKey:{address:recipient}}]};
  data.header={height:10,time};data.tip=11;data.canonical=block;data.genesis=f.p.routes.BTC.genesis;
  if(kind==='CANCELLED')data.tx.vin=[{...data.funding.vin[0]}];
  rpc=async(method,args)=>{switch(method){case 'decoderawtransaction':return data.funding;case 'getblockchaininfo':return {chain:'regtest'};case 'getblockhash':return args[0]===0?data.genesis:data.canonical;case 'getrawtransaction':return args[0]===plan.fundingTransaction?data.funding:data.tx;case 'getblockheader':return data.header;case 'getblockcount':return data.tip;default:throw Error(method);}};
 }else{
  const code='0x6000';plan.codeHash=digest(Buffer.from(code.slice(2),'hex'));o.arm=f.arm(q,plan);
  const topics={PAYOUT:'0x38d6042dbdae8e73a7f6afbabd3fbe0873f9f5ed3cd71294591c3908c2e65fee',REFUND:'0xfe509803c09416b28ff3d8f690c8b0c61462a892c46d5430c8fb20abe472daf0',CANCELLED:'0xbaa1eb22f2a492ba1a5fea61b8df4d27c6c8b5f3971e63bb58fa14ff72eedb70'},base={removed:false,transactionHash:'0x'+transaction,blockHash:'0x'+block};
  data.receipt={status:'0x1',transactionHash:'0x'+transaction,to:plan.escrow,blockHash:'0x'+block,blockNumber:'0xa',logs:[{...base,address:plan.escrow,topics:[topics[kind],'0x'+o.id],data:kind==='PAYOUT'?'0x'+o.secret:'0x'},{...base,address:q.contract,topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef','0x'+addr(plan.escrow),'0x'+addr(recipient)],data:'0x'+word(q.externalAtomic)}]};
  // The token identity is supplied by the pinned policy, not the order label.
  data.receipt.logs[1].address=f.p.routes.USDC.contract;
  if(kind==='CANCELLED')data.receipt.logs.pop();
  data.terms='0x'+addr(q.externalRefund)+addr(q.externalRecipient)+word(q.externalAtomic)+q.hashlock+word(q.externalUntil)+word(kind==='PAYOUT'?2:kind==='REFUND'?3:5);
  data.code=code;data.canonical='0x'+block;data.tip=11;data.genesis='0x'+f.p.routes.USDC.genesis;
  rpc=async(method,args)=>{switch(method){case 'eth_chainId':return '0x7a69';case 'eth_getCode':return data.code;case 'eth_getTransactionReceipt':return data.receipt;case 'eth_call':return args[0].data==='0xfc0c546a'?'0x'+addr(f.p.routes.USDC.contract):data.terms;case 'eth_getBlockByNumber':return args[0]==='0x0'?{hash:data.genesis}:args[0]==='latest'?{number:hex(data.tip)}:{hash:data.canonical,timestamp:hex(time)};default:throw Error(method);}};
 }
 const request={kind,quote:q,providerSignature:o.lock.providerSignature,userSignature:o.lock.userSignature,arm:o.arm,transaction};
 if(kind==='CANCELLED'&&asset==='BTC')request.fundingRaw='00';
 return {data,request,run:(override=rpc)=>observeExchangeResolution({policy:f.p,pins:{confirmations:2,escrow:plan.escrow,codeHash:plan.codeHash},rpc:override,request,now:600005000}),rpc,recipient};
}
for(const direction of ['BUY_DUBYT','SELL_DUBYT'])for(const asset of ['BTC','USDC'])for(const kind of ['PAYOUT','REFUND','CANCELLED'])test(direction+' '+asset+' observes confirmed '+kind+' after outage',async()=>{const f=fixture(direction,asset,kind),r=await f.run();assert.equal(r.status,kind);assert.equal(r.recipient,f.recipient);assert.equal(r.observedAt,600005000);assert(r.executedAt<r.observedAt);});

test('BTC cancellation needs the exact funding identity and a canonical conflicting input',async()=>{
 for(const mutate of [d=>d.funding.txid=hash('different'),d=>d.funding.vin=[],d=>d.tx.vin[0].vout++,d=>delete d.tx.blockhash,d=>d.tip=10,d=>d.canonical=hash('reorg'),d=>d.funding.vout[0].value=1]){const f=fixture('BUY_DUBYT','BTC','CANCELLED');mutate(f.data);await assert.rejects(f.run);}
 const f=fixture('SELL_DUBYT','BTC','CANCELLED');delete f.request.fundingRaw;await assert.rejects(f.run);
});
test('USDC cancellation rejects absent event, live funding state and conflicting terminal event',async()=>{
 for(const mutate of [d=>d.terms=d.terms.slice(0,-1)+'1',d=>d.receipt.logs=[],d=>d.receipt.logs.push({...d.receipt.logs[0],topics:['0xfe509803c09416b28ff3d8f690c8b0c61462a892c46d5430c8fb20abe472daf0',d.receipt.logs[0].topics[1]]}),d=>d.receipt.status='0x0',d=>d.tip=10]){const f=fixture('SELL_DUBYT','USDC','CANCELLED');mutate(f.data);await assert.rejects(f.run);}
});
test('BTC observer rejects wrong chain, reorg, insufficient depth and changed spend',async()=>{
 for(const mutate of [d=>d.genesis=hash('wrong'),d=>d.canonical=hash('reorg'),d=>d.tip=10,d=>d.tx.vin[0].vout++,d=>d.tx.vout[0].value+=0.1,d=>d.tx.vout[0].scriptPubKey.address='wrong',d=>d.tx.vin[0].txinwitness[1]='00'.repeat(32),d=>d.funding.vout[0].scriptPubKey.hex='00']){const f=fixture('SELL_DUBYT','BTC','PAYOUT');mutate(f.data);await assert.rejects(f.run);}
 const f=fixture('BUY_DUBYT','BTC','REFUND');f.data.tx.vin[0].txinwitness[1]='01';await assert.rejects(f.run);
});
test('USDC observer rejects failed transfers, changed token, recipient, amount and final state',async()=>{
 for(const mutate of [d=>d.receipt.status='0x0',d=>d.code='0x6001',d=>d.genesis=hash('wrong'),d=>d.canonical=hash('reorg'),d=>d.tip=10,d=>d.receipt.logs[1].address='0x'+'9'.repeat(40),d=>d.receipt.logs[1].topics[2]='0x'+'0'.repeat(64),d=>d.receipt.logs[1].data='0x01',d=>d.receipt.logs[0].removed=true,d=>d.receipt.logs.splice(1),d=>d.terms=d.terms.slice(0,-1)+'3']){const f=fixture('BUY_DUBYT','USDC','PAYOUT');mutate(f.data);await assert.rejects(f.run);}
});

test('USDC exact code and terms are read at the receipt block; unavailable history is not latest',async()=>{
 const f=fixture('BUY_DUBYT','USDC','PAYOUT'),reads=[];
 await f.run(async(m,p)=>{if(m==='eth_getCode'||m==='eth_call'){assert.equal(p[1],f.data.receipt.blockNumber);reads.push(m);}return f.rpc(m,p);});
 assert.deepEqual(reads,['eth_getCode','eth_call','eth_call']);
 await assert.rejects(()=>f.run(async(m,p)=>{if(m==='eth_call')throw Error('historical state unavailable');return f.rpc(m,p);}));
});
