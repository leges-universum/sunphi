import test from 'node:test';import assert from 'node:assert/strict';
import {digest,hash} from '../crypto.mjs';
import {ETHEREUM_USDC,ETHEREUM_GENESIS} from '../research/exchange-evm-networks.mjs';
import {verifyEthereumEscrowFunding,readEthereumFundingQuorum} from '../research/ethereum-escrow-funding.mjs';
const word=n=>BigInt(n).toString(16).padStart(64,'0'),addr=n=>'0x'+n.repeat(40),aw=a=>a.slice(2).padStart(64,'0');
const locked='0x3223c64d0518f39e3854050c1ea77cb9f25539e39168510c5a0cc7aad992b306',transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function fixture(){
 const code='0x60006000',e={order:hash('order'),escrow:addr('1'),codeHash:digest(Buffer.from(code.slice(2),'hex')),payer:addr('2'),recipient:addr('3'),amountAtomic:'1234567',hashlock:hash('secret'),createdAt:1000,refundAt:6000,transaction:hash('funding'),block:hash('block'),now:2500,minClaimWindowSeconds:1800};
 const terms=[aw(e.payer),aw(e.recipient),word(e.amountAtomic),e.hashlock,word(e.refundAt),word(1)];
 const d={code,chain:'0x1',genesis:ETHEREUM_GENESIS,token:ETHEREUM_USDC,terms,headTerms:[...terms],balance:e.amountAtomic,headBalance:e.amountAtomic,block:{number:'0x20',hash:'0x'+e.block,timestamp:'0x7cf'},head:{number:'0x21',hash:'0x'+hash('head'),timestamp:'0x8fc'}};
 const log=(address,topics,data,i)=>({address,topics,data,transactionHash:'0x'+e.transaction,blockHash:'0x'+e.block,blockNumber:'0x20',logIndex:'0x'+i,removed:false});
 d.receipt={status:'0x1',transactionHash:'0x'+e.transaction,blockHash:'0x'+e.block,blockNumber:'0x20',to:e.escrow,from:e.payer,logs:[log(ETHEREUM_USDC,[transfer,'0x'+aw(e.payer),'0x'+aw(e.escrow)],'0x'+word(e.amountAtomic),0),log(e.escrow,[locked,'0x'+e.order],'0x',1)]};
 const rpc=async(m,p)=>{
  if(m==='eth_chainId')return d.chain;if(m==='eth_getTransactionReceipt')return d.receipt;if(m==='eth_getCode')return d.code;
  if(m==='eth_getBlockByNumber')return p[0]==='0x0'?{hash:'0x'+d.genesis}:p[0]==='0x20'?d.block:d.head;
  if(m==='eth_call'){if(p[0].data==='0xfc0c546a')return '0x'+aw(d.token);if(p[0].data.startsWith('0x70a08231'))return '0x'+word(p[1]==='0x20'?d.balance:d.headBalance);return '0x'+(p[1]==='0x20'?d.terms:d.headTerms).join('');}throw Error('unexpected RPC');
 };return {e,d,rpc,run:()=>verifyEthereumEscrowFunding(rpc,e)};
}
test('exact funded USDC evidence includes locked state and cannot authorize settlement',async()=>{const f=fixture(),p=await f.run();assert.equal(p.amountAtomic,'1234567');assert.equal(p.fundingAuthorized,false);assert.equal(p.settlementAuthorized,false);assert.equal(p.stateAnchor.number,'0x21');});
test('funding rejects wrong route, receipt, event, parties, amount, code and order',async()=>{
 const changes=[d=>d.chain='0x2105',d=>d.genesis=hash('fake'),d=>d.token=addr('9'),d=>d.code='0x6001',d=>d.receipt.status='0x0',d=>d.receipt.from=addr('9'),d=>d.receipt.to=addr('9'),d=>d.receipt.transactionHash='0x'+hash('other'),d=>d.terms[0]=aw(addr('9')),d=>d.terms[1]=aw(addr('9')),d=>d.terms[2]=word(1),d=>d.terms[3]=hash('other'),d=>d.terms[4]=word(6001),d=>d.receipt.logs[0].address=addr('9'),d=>d.receipt.logs[0].topics[1]='0x'+aw(addr('9')),d=>d.receipt.logs[0].data='0x'+word(1),d=>d.receipt.logs[0].removed=true,d=>d.receipt.logs[0].blockNumber='0x19',d=>d.receipt.logs[1].topics[1]='0x'+hash('other'),d=>d.receipt.logs[1].data='0x00',d=>d.receipt.logs[1].logIndex='0x0',d=>d.receipt.logs.push({...d.receipt.logs[0],logIndex:'0x2'}),d=>d.balance='1234566'];
 for(const change of changes){const f=fixture();change(f.d);await assert.rejects(f.run);}
});
test('old funding cannot be reused after payout, refund, cancellation or loss of locked balance',async()=>{for(const status of [2,3,4,5]){const f=fixture();f.d.headTerms[5]=word(status);await assert.rejects(f.run);}const f=fixture();f.d.headBalance='0';await assert.rejects(f.run);});
test('funding requires a sufficient explicit UTC window and cannot have been made at expiry',async()=>{
 for(const edit of [f=>f.e.minClaimWindowSeconds=3501,f=>delete f.e.minClaimWindowSeconds,f=>f.d.block.timestamp='0x1770',f=>f.d.block.timestamp='0x1',f=>f.d.head.timestamp='0x1']){const f=fixture();edit(f);await assert.rejects(f.run);}
 const f=fixture();f.e.minClaimWindowSeconds=3500;await f.run();
});
test('a reorganization or moving finality anchor requires a fresh funding observation',async()=>{
 for(const mode of ['advance','reorg']){const f=fixture();let calls=0;const rpc=async(m,p)=>{if(m==='eth_getBlockByNumber'&&p[0]==='finalized'&&++calls===2){if(mode==='advance')f.d.head.number='0x22';else f.d.head.hash='0x'+hash('replacement');}return f.rpc(m,p);};await assert.rejects(()=>verifyEthereumEscrowFunding(rpc,f.e));}
});
test('two complete observations suffice with a hung third; one observation and duplicate operators do not',async()=>{
 const f=fixture(),readers=[0,1,2].map(i=>({id:'source-'+i,operator:'operator-'+i,rpc:i===2?()=>new Promise(()=>{}):f.rpc}));
 const p=await readEthereumFundingQuorum(readers,f.e,{timeoutMs:1000});assert.equal(p.sources.length,2);assert.equal(p.settlementAuthorized,false);
 readers[1].rpc=readers[2].rpc;await assert.rejects(()=>readEthereumFundingQuorum(readers,f.e,{timeoutMs:20}));
 readers[1].operator=readers[0].operator;await assert.rejects(()=>readEthereumFundingQuorum(readers,f.e));
});
