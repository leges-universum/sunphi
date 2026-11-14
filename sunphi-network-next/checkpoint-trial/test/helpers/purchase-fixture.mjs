// Synthetic balances and external evidence. Never connects to public networks.
import {keys,hash,sign} from '../../crypto.mjs';
import {PURCHASE,purchaseGenesis,acceptance,orderId,applyPurchase} from '../../research/purchase-contract.mjs';
export function purchaseFixture(){
 const seller=keys(),buyer=keys(),attesters=Array.from({length:3},keys);
 const policy={domain:PURCHASE,isolated:true,network:'duebyte-purchase-lab-v1',seller:seller.publicKey,sellerName:'Isolated test seller',attesters:attesters.map(x=>x.publicKey),threshold:2,routes:{BTC:{network:'bitcoin-regtest',asset:'native',decimals:8,confirmations:6},USDC:{network:'ethereum-local',asset:'test-usdc',decimals:6,confirmations:12}}};
 let serial=0;
 const reserve=(patch={},now=1000)=>{
  const offer={domain:PURCHASE+'/OFFER',policyHash:hash(policy),network:policy.network,nonce:hash(++serial),seller:seller.publicKey,buyer:buyer.publicKey,route:'BTC',dubytMicro:'10000000',payAtomic:'10000',feeAtomic:'100',destination:'lab-deposit-'+serial,refundDestination:'lab-buyer-refund',createdAt:now,quoteUntil:now+60,payUntil:now+600,...patch};
  return {type:'RESERVE',offer,sellerSignature:sign(offer,seller.privateKey),buyerSignature:sign(acceptance(policy,offer),buyer.privateKey)};
 };
 const evidence=(cmd,patch={},now=1010)=>{
  const q=cmd.offer,r=policy.routes[q.route],body={domain:PURCHASE+'/EVIDENCE',policyHash:hash(policy),network:policy.network,orderId:orderId(q),kind:'PAYMENT',observedAt:now,externalNetwork:r.network,asset:r.asset,destination:q.destination,amountAtomic:q.payAtomic,txid:hash('external-'+q.nonce),index:0,confirmations:r.confirmations,paidAt:now,reference:null,refunds:[],...patch};
  return {type:'EVIDENCE',body,approvals:attesters.slice(0,2).map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)}))};
 };
 return {seller,buyer,attesters,policy,reserve,evidence,genesis:()=>purchaseGenesis(policy,'100000000'),apply:applyPurchase};
}
