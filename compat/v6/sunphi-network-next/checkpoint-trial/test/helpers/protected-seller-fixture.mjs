import {hash,sign} from '../../crypto.mjs';
import {acceptance} from '../../research/purchase-contract.mjs';
import {sealPurchaseCustody} from '../../research/purchase-custody.mjs';
import {RefundOutbox} from '../../research/purchase-refund-worker.mjs';
import {SELLER_PROFILE} from '../../research/purchase-seller-protected.mjs';
import {nativeFixture} from './purchase-native-fixture.mjs';
export function protectedSellerFixture(time=1000){
 const f=nativeFixture(time),password='synthetic-protected-seller-only',box=new RefundOutbox(':memory:'),outbox=box.snapshot(hash(f.c));box.close();
 const bundle=sealPurchaseCustody({configHash:hash(f.c),policyHash:hash(f.policy),outbox,secrets:[{name:'seller',kind:'ed25519-private-key',data:Buffer.from(f.seller.privateKey).toString('base64')}]},password);
 const btcDestinations=['bcrt1q'+'a'.repeat(38),'bcrt1q'+'c'.repeat(38)],usdcDestinations=['0x'+'11'.repeat(20),'0x'+'33'.repeat(20)];
 const profile={domain:SELLER_PROFILE,operator:'Ledges Universum LLC - isolated qualification',config:f.c,vaultHash:hash(bundle),btcDestinations,dailyLimitMicro:'20000000',settings:{minOrderMicro:'1',maxOrderMicro:'20000000',quoteSeconds:60,paymentSeconds:600,rates:{BTC:{numerator:'1',denominator:'1000',feeAtomic:'0'},USDC:{numerator:'1',denominator:'1',feeAtomic:'0'}},usdcDestinations}};
 const request=(route='BTC',dubytMicro='10000000',i=0)=>({buyer:f.buyer.publicKey,route,dubytMicro,refundDestination:route==='BTC'?'bcrt1q'+'d'.repeat(38):'0x'+'22'.repeat(20),destination:route==='BTC'?btcDestinations[i]:usdcDestinations[i]});
 const accepted=q=>({command:{type:'RESERVE',...q,buyerSignature:sign(acceptance(f.policy,q.offer),f.buyer.privateKey)},inputs:[f.input]});
 return {...f,profile,bundle,password,request,accepted};
}
