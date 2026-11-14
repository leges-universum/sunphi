import test from 'node:test';
import assert from 'node:assert/strict';
import {hash} from '../crypto.mjs';
import {baseFinality,baseRevertFinality} from '../research/exchange-finality.mjs';

function fixture(){
 const transaction=hash('reverted-transaction'),genesis=hash('base-genesis'),block='0x'+hash('receipt-block');
 const d={chain:'0x2105',receipt:{transactionHash:'0x'+transaction,status:'0x0',blockHash:block,blockNumber:'0x1f'},head:{hash:'0x'+hash('finalized'),number:'0x20',timestamp:'0x2700'},canonical:block,reads:0};
 const rpc=async(method,args)=>{
  if(method==='eth_chainId')return d.chain;
  if(method==='eth_getTransactionReceipt')return d.receipt;
  if(method==='eth_getBlockByNumber'){
   if(args[0]==='0x0')return {hash:'0x'+genesis};
   if(args[0]==='finalized')return d.head;
   if(args[0]===d.head?.number)return {hash:d.head.hash};
   d.reads++;return {hash:d.reorg&&d.reads>1?'0x'+hash('reorg'):d.canonical};
  }
  throw Error('unexpected read');
 };
 const options={transaction,genesis,now:10000};
 return {d,rpc,options,run:()=>baseRevertFinality(rpc,options)};
}
test('canonical finalized Base revert is distinct from successful payout evidence',async()=>{
 const f=fixture(),proof=await f.run();assert.equal(proof.outcome,'REVERT');assert.equal(proof.transaction,f.options.transaction);
 await assert.rejects(()=>baseFinality(f.rpc,f.options));
});
for(const [name,change]of [
 ['successful transaction',d=>d.receipt.status='0x1'],
 ['missing transaction',d=>d.receipt=null],
 ['unfinalized transaction',d=>d.head.number='0x1e'],
 ['missing finalized head',d=>d.head=null],
 ['stale finalized head',d=>d.head.timestamp='0x1'],
 ['wrong transaction identity',d=>d.receipt.transactionHash='0x'+hash('other')],
 ['wrong chain',d=>d.chain='0x1'],
 ['different canonical block',d=>d.canonical='0x'+hash('other')],
 ['reorg between reads',d=>d.reorg=true]
])test('Base revert rejects '+name,async()=>{const f=fixture();change(f.d);await assert.rejects(f.run);});
test('Base revert reader outage never becomes permission for a replacement',async()=>{
 const f=fixture();await assert.rejects(()=>baseRevertFinality(async()=>{throw Error('reader unavailable');},f.options));
});
