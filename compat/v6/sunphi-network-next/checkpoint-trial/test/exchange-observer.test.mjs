import test from 'node:test';
import assert from 'node:assert/strict';
import {exchangeFixture} from './helpers/exchange-native-fixture.mjs';
import {observeExchange,attestExchange} from '../research/exchange-observer.mjs';
import {hash,sign,digest,verify} from '../crypto.mjs';
import {exchangeAcceptance} from '../research/exchange-escrow.mjs';
function rig(){
 const f=exchangeFixture(),o=f.order('SELL_DUBYT','USDC'),q=o.q,escrow='0x'+'6'.repeat(40),tx='0x'+hash('settlement'),block='0x'+hash('canonical'),code='0x60006000';
 const word=v=>BigInt(v).toString(16).padStart(64,'0'),addr=a=>a.slice(2).padStart(64,'0'),terms='0x'+[addr(q.externalRefund),addr(q.externalRecipient),word(q.externalAtomic),q.hashlock,word(q.externalUntil),word(2)].join('');
 const log=(address,topics,data)=>({address,topics,data,removed:false,transactionHash:tx,blockHash:block});
 const receipt={status:'0x1',transactionHash:tx,to:escrow,blockNumber:'0xa',blockHash:block,logs:[log(escrow,['0x38d6042dbdae8e73a7f6afbabd3fbe0873f9f5ed3cd71294591c3908c2e65fee','0x'+o.id],'0x'+o.secret),log(f.p.routes.USDC.contract,['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef','0x'+addr(escrow),'0x'+addr(q.externalRecipient)],'0x'+word(q.externalAtomic))]};
 let reorg=false,reads=0;
 const rpc=async(method,params)=>{
  if(method==='eth_chainId')return '0x7a69';
  if(method==='eth_getCode')return code;
  if(method==='eth_call')return params[0].data==='0xfc0c546a'?'0x'+addr(f.p.routes.USDC.contract):terms;
  if(method==='eth_getTransactionReceipt')return receipt;
  if(method==='eth_getBlockByNumber')return params[0]==='0x0'?{hash:'0x'+f.p.routes.USDC.genesis}:params[0]==='latest'?{number:'0xb'}:{hash:reorg&&++reads>1?'0x'+hash('fork'):block,number:'0xa',timestamp:'0x3fc'};
  throw Error('unexpected RPC');
 };
 const args={policy:f.p,pins:{escrow,codeHash:digest(Buffer.from(code.slice(2),'hex')),confirmations:2},rpc,now:1030,request:{kind:'SETTLEMENT',quote:q,providerSignature:sign(q,f.provider.privateKey),userSignature:sign(exchangeAcceptance(q),f.user.privateKey),transaction:tx.slice(2),descriptor:null}};
 return {f,o,args,receipt,reorg(){reorg=true;}};
}
test('observer signs only the independently read successful exact payout',async()=>{const r=rig(),result=await attestExchange(r.args,r.f.observers[0]);assert(verify(result.body,result.signature.signature,result.signature.observer));assert.equal(result.body.amountAtomic,r.o.q.externalAtomic);assert.equal(result.body.transaction,r.args.request.transaction);});
for(const [name,mutate]of [
 ['failed transfer with exposed secret',r=>{r.receipt.status='0x0';}],
 ['wrong recipient',r=>{r.receipt.logs[1].topics[2]='0x'+'0'.repeat(24)+'9'.repeat(40);}],
 ['wrong token',r=>{r.receipt.logs[1].address='0x'+'9'.repeat(40);}],
 ['wrong escrow code',r=>{r.args.pins.codeHash=hash('different code');}],
 ['removed log',r=>{r.receipt.logs[1].removed=true;}],
 ['duplicate payout log',r=>{r.receipt.logs.push({...r.receipt.logs[1]});}],
 ['wrong order event',r=>{r.receipt.logs[0].topics[1]='0x'+hash('another order');}],
 ['forged consent',r=>{r.args.request.userSignature=r.args.request.providerSignature;}],
 ['insufficient confirmations',r=>{r.args.pins.confirmations=3;}],
 ['reorg during read',r=>r.reorg()],
 ['claim window expired',r=>{r.args.now=r.o.q.dubytUntil;}],
])test('observer refuses '+name,async()=>{const r=rig();mutate(r);await assert.rejects(()=>observeExchange(r.args));});
