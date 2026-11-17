// Synthetic RPC transcript only; no Ethereum finality or real funds claimed.
import {hash,digest,sign} from '../../crypto.mjs';
import {origin} from '../../core.mjs';
import {resolutionFixture} from './exchange-resolution-fixture.mjs';
import {exchangeAcceptance} from '../../research/exchange-escrow.mjs';
import {ETHEREUM_GENESIS,ETHEREUM_USDC} from '../../research/exchange-evm-networks.mjs';
const word=n=>BigInt(n).toString(16).padStart(64,'0'),aw=a=>a.slice(2).padStart(64,'0');
const event={PAYOUT:'0x38d6042dbdae8e73a7f6afbabd3fbe0873f9f5ed3cd71294591c3908c2e65fee',REFUND:'0xfe509803c09416b28ff3d8f690c8b0c61462a892c46d5430c8fb20abe472daf0',CANCELLED:'0xbaa1eb22f2a492ba1a5fea61b8df4d27c6c8b5f3971e63bb58fa14ff72eedb70'};
export function ethereumConsensusFixture(direction='BUY_DUBYT',kind='PAYOUT',{at=1000,observedAt=at+11000,payoutAt=at+1000}={}){
 const f=resolutionFixture(at);f.p.minGap=3600;f.p.routes.USDC={network:'ethereum-mainnet',genesis:ETHEREUM_GENESIS,contract:ETHEREUM_USDC,decimals:6};
 const old=f.order(direction,'USDC'),q={...old.q,policyHash:hash(f.p),dubytUntil:at+(direction==='BUY_DUBYT'?4000:8000),externalUntil:at+(direction==='BUY_DUBYT'?8000:4000)};
 const id=hash(q),code='0x60006000',plan={...old.plan,order:id,codeHash:digest(Buffer.from(code.slice(2),'hex'))};
 const lock={type:'LOCK',quote:q,providerSignature:sign(q,f.provider.privateKey),userSignature:sign(exchangeAcceptance(q),f.user.privateKey)};
 const arm=f.arm(q,plan),transaction=hash([id,kind]),block=hash(['block',id,kind]),now=observedAt,executedAt=kind==='PAYOUT'?payoutAt:q.externalUntil;
 const request={kind,quote:q,providerSignature:lock.providerSignature,userSignature:lock.userSignature,arm,transaction};
 const d={code,chain:'0x1',genesis:ETHEREUM_GENESIS,token:ETHEREUM_USDC,head:{hash:'0x'+hash('head'),number:'0x21',timestamp:'0x'+(now-16).toString(16)},header:{hash:'0x'+block,number:'0x20',timestamp:'0x'+executedAt.toString(16)},terms:[aw(q.externalRefund),aw(q.externalRecipient),word(q.externalAtomic),q.hashlock,word(q.externalUntil),word({PAYOUT:2,REFUND:3,CANCELLED:5}[kind])]};
 const log=(address,topics,data)=>({address,topics,data,transactionHash:'0x'+transaction,blockHash:'0x'+block,blockNumber:'0x20',removed:false});
 const logs=[];
 if(kind!=='CANCELLED')logs.push(log(ETHEREUM_USDC,['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef','0x'+aw(plan.escrow),'0x'+aw(kind==='PAYOUT'?q.externalRecipient:q.externalRefund)],'0x'+word(q.externalAtomic)));
 logs.push(log(plan.escrow,[event[kind],'0x'+id],kind==='PAYOUT'?'0x'+old.secret:'0x'));logs.forEach((l,i)=>l.logIndex='0x'+i.toString(16));
 d.receipt={status:'0x1',transactionHash:'0x'+transaction,blockHash:'0x'+block,blockNumber:'0x20',to:plan.escrow,logs};
 const rpc=async(m,p)=>{
  if(m==='eth_chainId')return d.chain;if(m==='eth_getTransactionReceipt')return d.receipt;if(m==='eth_getCode')return d.code;
  if(m==='eth_getBlockByNumber')return p[0]==='0x0'?{hash:'0x'+d.genesis}:p[0]==='0x20'?d.header:d.head;
  if(m==='eth_call')return p[0].data==='0xfc0c546a'?'0x'+aw(d.token):'0x'+d.terms.join('');throw Error('unexpected RPC');
 };
 return {...f,s:origin(f.c),o:{...old,q,id,plan,arm,lock},d,args:{policy:f.p,pins:{escrows:[plan.escrow],codeHash:plan.codeHash},request,rpc,now}};
}
