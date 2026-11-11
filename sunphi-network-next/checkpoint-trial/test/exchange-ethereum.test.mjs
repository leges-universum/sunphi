import test from 'node:test';import assert from 'node:assert/strict';
import {hash} from '../crypto.mjs';
import {ethereumFinality,ethereumRevertFinality} from '../research/exchange-finality.mjs';
import {ETHEREUM_GENESIS,ETHEREUM_USDC,evmNetwork} from '../research/exchange-evm-networks.mjs';
import {readFinalityQuorum,readOnlyRpc} from '../research/exchange-readers.mjs';
import {readAnchorQuorum} from '../research/exchange-source-anchor.mjs';
import {verifyObservationFinality} from '../research/exchange-observer-quorum.mjs';
import {sampleSource} from '../research/exchange-source-watch.mjs';
const tx=hash('ethereum-tx'),block=hash('ethereum-block'),now=20000;
function fixture(){
 const d={chain:'0x1',genesis:ETHEREUM_GENESIS,head:{number:'0x20',timestamp:'0x4dc0',hash:'0x'+block},receipt:{transactionHash:'0x'+tx,blockHash:'0x'+block,blockNumber:'0x20',status:'0x1'},canonical:'0x'+block};
 const rpc=async(m,p)=>{if(m==='eth_chainId')return d.chain;if(m==='eth_getTransactionReceipt')return d.receipt;if(m==='eth_getBlockByNumber')return p[0]==='0x0'?{hash:'0x'+d.genesis}:p[0]==='finalized'?d.head:{...d.head,hash:d.canonical};throw Error('unexpected method');};
 const options={transaction:tx,genesis:ETHEREUM_GENESIS,now};return {d,rpc,options,run:()=>ethereumFinality(rpc,options)};
}
test('Ethereum accepts only canonical finalized success; Base, wrong genesis and stale or absent finality fail',async()=>{
 await fixture().run();for(const edit of [d=>d.chain='0x2105',d=>d.genesis=hash('other'),d=>d.head=null,d=>d.head.number='0x1f',d=>d.head.timestamp='0x1',d=>d.receipt.status='0x0',d=>d.canonical='0x'+hash('fork'),d=>d.receipt.transactionHash='0x'+hash('other')]){const f=fixture();edit(f.d);await assert.rejects(f.run);}
 const f=fixture();f.options.genesis=hash('custom');await assert.rejects(f.run);
});
test('Ethereum revert evidence is separate from successful settlement',async()=>{const f=fixture();await assert.rejects(()=>ethereumRevertFinality(f.rpc,f.options));f.d.receipt.status='0x0';assert.equal((await ethereumRevertFinality(f.rpc,f.options)).outcome,'REVERT');await assert.rejects(f.run);f.d.receipt=null;await assert.rejects(()=>ethereumRevertFinality(f.rpc,f.options));});
test('Ethereum observers bind native USDC, network, genesis and exact transaction block',async()=>{const f=fixture(),body={asset:'USDC',network:'ethereum-mainnet',contract:ETHEREUM_USDC,genesis:ETHEREUM_GENESIS,transaction:tx,block};const run=()=>verifyObservationFinality({body,rpc:f.rpc,now,genesis:ETHEREUM_GENESIS});await run();for(const [key,value] of [['network','base-mainnet'],['contract',evmNetwork('BASE').contract],['genesis',hash('other')],['block',hash('other')]]){const before=body[key];body[key]=value;await assert.rejects(run);body[key]=before;}});
test('two independent Ethereum readers agree; a Base reader cannot join the quorum',async()=>{const f=fixture(),base=fixture();base.d.chain='0x2105';const readers=[f,f,base].map((x,i)=>({id:'reader-'+i,operator:'operator-'+i,rpc:x.rpc})),options={chain:'ETHEREUM',...f.options,timeoutMs:1000};assert.equal((await readFinalityQuorum(readers,options)).sources.length,2);assert.equal((await readAnchorQuorum(readers,options)).settlementAuthorized,false);readers[1].rpc=base.rpc;await assert.rejects(()=>readFinalityQuorum(readers,options));await assert.rejects(()=>readAnchorQuorum(readers,options));});
test('Ethereum diagnostics never authorize settlement and reject source substitution',async()=>{const f=fixture(),source={id:'ethereum-qa',operator:'qa',chain:'ETHEREUM',url:'https://qa.invalid'},fetcher=async(u,o)=>{const q=JSON.parse(o.body);return new Response(JSON.stringify({id:q.id,result:await f.rpc(q.method,q.params)}));};const r=await sampleSource(source,{now,fetcher});assert(r.available);assert.equal(r.genesis,ETHEREUM_GENESIS);assert.equal(r.settlementAuthorized,false);f.d.chain='0x2105';assert(!(await sampleSource(source,{now,fetcher})).available);});
test('Ethereum read transport refuses signing and transaction submission',async()=>{const rpc=readOnlyRpc('https://qa.invalid',{chain:'ETHEREUM',fetcher:()=>{throw Error('must not call');}});for(const m of ['eth_sendRawTransaction','eth_sign','personal_unlockAccount'])await assert.rejects(()=>rpc(m,[]));});
