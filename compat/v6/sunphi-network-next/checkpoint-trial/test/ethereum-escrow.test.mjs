import test from 'node:test';import assert from 'node:assert/strict';
import {digest,hash} from '../crypto.mjs';import {ETHEREUM_GENESIS,ETHEREUM_USDC} from '../research/exchange-evm-networks.mjs';
import {verifyEthereumEscrowOutcome,readEthereumEscrowQuorum} from '../research/ethereum-escrow.mjs';
const word=n=>BigInt(n).toString(16).padStart(64,'0'),addr=n=>'0x'+n.repeat(40),aWord=a=>a.slice(2).padStart(64,'0');
const event={PAYOUT:'0x38d6042dbdae8e73a7f6afbabd3fbe0873f9f5ed3cd71294591c3908c2e65fee',REFUND:'0xfe509803c09416b28ff3d8f690c8b0c61462a892c46d5430c8fb20abe472daf0',CANCELLED:'0xbaa1eb22f2a492ba1a5fea61b8df4d27c6c8b5f3971e63bb58fa14ff72eedb70'},transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function fixture(kind='PAYOUT'){
 const secret='a'.repeat(64),code='0x60006000',e={order:hash('order'),escrow:addr('1'),codeHash:digest(Buffer.from(code.slice(2),'hex')),payer:addr('2'),recipient:addr('3'),amountAtomic:'1234567',hashlock:digest(Buffer.from(secret,'hex')),createdAt:1000,refundAt:2000,kind,transaction:hash('tx'),block:hash('block'),now:2500};
 const d={chain:'0x1',genesis:ETHEREUM_GENESIS,code,token:ETHEREUM_USDC,terms:[aWord(e.payer),aWord(e.recipient),word(e.amountAtomic),e.hashlock,word(e.refundAt),word({PAYOUT:2,REFUND:3,CANCELLED:5}[kind])],head:{hash:'0x'+hash('head'),number:'0x21',timestamp:'0x8fc'},block:{hash:'0x'+e.block,number:'0x20',timestamp:kind==='PAYOUT'?'0x7cf':'0x7d0'}};
 const log=(address,topics,data)=>({address,topics,data,transactionHash:'0x'+e.transaction,blockHash:'0x'+e.block,removed:false});
 d.receipt={status:'0x1',transactionHash:'0x'+e.transaction,blockHash:'0x'+e.block,blockNumber:'0x20',to:e.escrow,logs:[log(e.escrow,[event[kind],'0x'+e.order],kind==='PAYOUT'?'0x'+secret:'0x')]};
 if(kind!=='CANCELLED')d.receipt.logs.unshift(log(ETHEREUM_USDC,[transfer,'0x'+aWord(e.escrow),'0x'+aWord(kind==='PAYOUT'?e.recipient:e.payer)],'0x'+word(e.amountAtomic)));
 const rpc=async(m,p)=>{
  if(m==='eth_chainId')return d.chain;if(m==='eth_getTransactionReceipt')return d.receipt;if(m==='eth_getCode')return d.code;
  if(m==='eth_getBlockByNumber')return p[0]==='0x0'?{hash:'0x'+d.genesis}:p[0]==='0x20'?d.block:d.head;
  if(m==='eth_call')return p[0].data==='0xfc0c546a'?'0x'+aWord(d.token):'0x'+d.terms.join('');throw Error('unexpected RPC');
 };return {e,d,rpc,run:()=>verifyEthereumEscrowOutcome(rpc,e)};
}
test('Ethereum exact payout, refund and unfunded cancellation remain non-authorizing evidence',async()=>{for(const k of Object.keys(event)){const f=fixture(k),r=await f.run();assert.equal(r.kind,k);assert.equal(r.settlementAuthorized,false);assert.equal(r.contract,ETHEREUM_USDC);}});
test('Ethereum escrow rejects wrong network, contract, terms, receipt, timestamp and forged transfer',async()=>{
 const edits=[d=>d.chain='0x2105',d=>d.genesis=hash('other'),d=>d.code='0x6001',d=>d.token=addr('9'),d=>d.terms[0]=aWord(addr('9')),d=>d.terms[1]=aWord(addr('9')),d=>d.terms[2]=word(1),d=>d.terms[3]=hash('wrong'),d=>d.terms[4]=word(3000),d=>d.terms[5]=word(3),d=>d.receipt.status='0x0',d=>d.receipt.to=addr('9'),d=>d.receipt.logs[0].address=addr('9'),d=>d.receipt.logs[0].topics[2]='0x'+aWord(addr('9')),d=>d.receipt.logs[0].data='0x'+word(1),d=>d.receipt.logs[0].removed=true,d=>d.receipt.logs[1].data='0x'+'b'.repeat(64),d=>d.receipt.logs.push({...d.receipt.logs[0]}),d=>d.receipt.logs[1].topics[1]='0x'+hash('other'),d=>d.receipt.logs[1].transactionHash='0x'+hash('other'),d=>d.block.timestamp='0x7d0',d=>d.block.timestamp='0x1',d=>d.head.number='0x1f',d=>d.head.timestamp='0x1'];
 for(const change of edits){const f=fixture();change(f.d);await assert.rejects(f.run);}
});
test('refund cannot precede deadline; cancellation cannot contain a transfer',async()=>{const f=fixture('REFUND');f.d.block.timestamp='0x7cf';await assert.rejects(f.run);const c=fixture('CANCELLED');c.d.receipt.logs.push(fixture().d.receipt.logs[0]);await assert.rejects(c.run);});
test('finalized head may advance during inspection but may not regress or change the receipt block',async()=>{
 for(const regress of [false,true]){const f=fixture();let calls=0;const rpc=async(m,p)=>{if(m==='eth_getBlockByNumber'&&p[0]==='finalized'&&++calls===2)f.d.head.number=regress?'0x20':'0x22';return f.rpc(m,p);};if(regress)await assert.rejects(()=>verifyEthereumEscrowOutcome(rpc,f.e));else assert.equal((await verifyEthereumEscrowOutcome(rpc,f.e)).finalized,'34');}
});
test('two complete independent Ethereum observations required; finality alone and duplicate operators never suffice',async()=>{
 const f=fixture(),bad=fixture();bad.d.receipt.logs[0].data='0x'+word(1);const readers=[f,f,bad].map((r,i)=>({id:'source-'+i,operator:'operator-'+i,rpc:r.rpc}));
 const result=await readEthereumEscrowQuorum(readers,f.e);assert.equal(result.sources.length,2);assert.equal(result.settlementAuthorized,false);
 readers[1].rpc=bad.rpc;await assert.rejects(()=>readEthereumEscrowQuorum(readers,f.e));readers[1].operator=readers[0].operator;await assert.rejects(()=>readEthereumEscrowQuorum(readers,f.e));
});
test('unresponsive sources time out without authorizing settlement',async()=>{const f=fixture(),readers=[0,1,2].map(i=>({id:'source-'+i,operator:'operator-'+i,rpc:i===0?f.rpc:()=>new Promise(()=>{})}));await assert.rejects(()=>readEthereumEscrowQuorum(readers,f.e,{timeoutMs:20}));});
