// Read-only admission predicates. They do not enable a production exchange route.
import assert from 'node:assert/strict';
import {hex,integer} from '../crypto.mjs';
import {evmNetwork,ETHEREUM_GENESIS} from './exchange-evm-networks.mjs';
export const BASE_USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const BTC_GENESIS='000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
const quantity=x=>{assert(/^0x(?:0|[1-9a-f][a-f0-9]*)$/.test(x));return BigInt(x);};
const evmHash=x=>{assert(typeof x==='string'&&/^0x[a-f0-9]{64}$/.test(x));return x;};
export async function bitcoinFinality(rpc,{transaction,now,confirmations=6,maxTipAge=7200,genesis=BTC_GENESIS,chain='main'}){
 hex(transaction);hex(genesis);integer(now);integer(confirmations,6);integer(maxTipAge,1);assert(['main','regtest'].includes(chain));
 const info=await rpc('getblockchaininfo',[]);assert.equal(info.chain,chain);assert.equal(await rpc('getblockhash',[0]),genesis);assert.equal(info.initialblockdownload,false,'Bitcoin reader is synchronizing');
 integer(info.blocks);integer(info.headers);assert(info.headers>=info.blocks&&info.headers-info.blocks<=2,'Bitcoin reader is behind');
 const tip=await rpc('getblockheader',[info.bestblockhash,true]);assert(tip.time<=now+120&&now-tip.time<=maxTipAge,'Bitcoin tip freshness');
 const tx=await rpc('getrawtransaction',[transaction,true]);assert.equal(tx.txid,transaction);hex(tx.blockhash);
 const block=await rpc('getblockheader',[tx.blockhash,true]);integer(block.height);assert.equal(block.hash,tx.blockhash);assert(block.confirmations>=confirmations&&info.blocks-block.height+1>=confirmations,'Bitcoin confirmation depth');
 assert.equal(await rpc('getblockhash',[block.height]),tx.blockhash,'Bitcoin canonical block');
 assert.equal(await rpc('getblockhash',[block.height]),tx.blockhash,'Bitcoin reorg during observation');
 return {transaction,block:tx.blockhash,height:block.height,confirmations:Math.min(block.confirmations,info.blocks-block.height+1)};
}
export async function baseFinality(rpc,{transaction,genesis,now,maxFinalizedAge=7200}){
 return evmReceiptFinality(rpc,{transaction,genesis,now,maxFinalizedAge,chain:'BASE'},'0x1');
}
export async function ethereumFinality(rpc,{transaction,genesis=ETHEREUM_GENESIS,now,maxFinalizedAge=1800}){
 assert.equal(genesis,ETHEREUM_GENESIS,'Ethereum mainnet genesis required');
 return evmReceiptFinality(rpc,{transaction,genesis,now,maxFinalizedAge,chain:'ETHEREUM'},'0x1');
}
export async function ethereumRevertFinality(rpc,{transaction,genesis=ETHEREUM_GENESIS,now,maxFinalizedAge=1800}){
 assert.equal(genesis,ETHEREUM_GENESIS,'Ethereum mainnet genesis required');
 return {...await evmReceiptFinality(rpc,{transaction,genesis,now,maxFinalizedAge,chain:'ETHEREUM'},'0x0'),outcome:'REVERT'};
}
// A failed broadcast or missing receipt is never a proved revert. This separate
// predicate cannot be used as successful payout/refund evidence.
export async function baseRevertFinality(rpc,{transaction,genesis,now,maxFinalizedAge=7200}){
 const proof=await evmReceiptFinality(rpc,{transaction,genesis,now,maxFinalizedAge,chain:'BASE'},'0x0');
 return {...proof,outcome:'REVERT'};
}
async function evmReceiptFinality(rpc,{transaction,genesis,now,maxFinalizedAge,chain},status){
 hex(transaction);hex(genesis);integer(now);integer(maxFinalizedAge,1);
 assert.equal(await rpc('eth_chainId',[]),evmNetwork(chain).chainId,'EVM mainnet identity');assert.equal((await rpc('eth_getBlockByNumber',['0x0',false])).hash,'0x'+genesis);
 const receipt=await rpc('eth_getTransactionReceipt',['0x'+transaction]);assert(receipt&&receipt.status===status,'required Base receipt outcome');assert.equal(receipt.transactionHash,'0x'+transaction);evmHash(receipt.blockHash);
 const finalized=await rpc('eth_getBlockByNumber',['finalized',false]);assert(finalized,'finalized head unavailable');evmHash(finalized.hash);
 assert(quantity(receipt.blockNumber)<=quantity(finalized.number),'Base outcome not finalized');const time=quantity(finalized.timestamp);assert(time<=BigInt(now+120)&&BigInt(now)-time<=BigInt(maxFinalizedAge),'Base finalized head stale');
 assert.equal((await rpc('eth_getBlockByNumber',[receipt.blockNumber,false])).hash,receipt.blockHash,'Base canonical receipt');
 assert.equal((await rpc('eth_getBlockByNumber',[finalized.number,false])).hash,finalized.hash,'Base finalized head changed');
 assert.equal((await rpc('eth_getBlockByNumber',[receipt.blockNumber,false])).hash,receipt.blockHash,'Base reorg during observation');
 return {transaction,block:receipt.blockHash.slice(2),height:quantity(receipt.blockNumber).toString(),finalized:quantity(finalized.number).toString()};
}
