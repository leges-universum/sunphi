import {purchaseFixture} from './purchase-fixture.mjs';
import {keys,hash,sign} from '../../crypto.mjs';
import {PURCHASE} from '../../research/purchase-contract.mjs';
import {PROFILE,origin,envelope} from '../../core.mjs';
import {DOMAIN,policyId} from '../../payment-model.mjs';
import {UTC_OBLIGATIONS} from '../../obligation-clock.mjs';
import {PURCHASE_ACTION} from '../../research/purchase-native.mjs';
export function nativeFixture(time=1000,validators=Array.from({length:10},keys)){
 const f=purchaseFixture(),members=Array.from({length:4},keys),input=hash('synthetic inventory');
 f.policy.rpcPins={BTC:{genesis:hash('genesis')},USDC:{genesis:'0x'+hash('genesis'),chainId:'0x7a69',contract:'0x'+'34'.repeat(20)}};
 const c={profile:PROFILE,chainId:'duebyte-trial-purchase-lab-v1',trialOnly:true,obligationClock:UTC_OBLIGATIONS,
  initial:{domain:DOMAIN,policy:policyId,height:0,epoch:0,time,supply:'100000000',fees:'0',unitScale:'1000000',precisionHeight:1,outputs:{[input]:{owner:f.seller.publicKey,value:'100000000',unlock:0}},requests:{},nodes:{}},
  control:{validators:validators.map((k,i)=>({key:k.publicKey,group:hash(['validator',i])})),policy:{version:1,members:members.map((k,i)=>({key:k.publicKey,group:hash(['policy',i])})),threshold:3,maxAge:3600,notAfter:time+86400}},purchaseLab:{policy:f.policy,feeMicro:'1000'}};
 const wire=(command,inputs=[],key=command.type==='RESERVE'?f.seller:f.attesters[0])=>Buffer.from(JSON.stringify(envelope(c,{type:PURCHASE_ACTION,command,inputs},key)));
 const refundIntent=(order,time)=>{const body={domain:PURCHASE+'/REFUND_INTENT',policyHash:hash(f.policy),network:f.policy.network,orderId:hash(order.offer),kind:'REFUND_INTENT',observedAt:time,destination:order.offer.refundDestination,amountAtomic:String(order.received.reduce((n,x)=>n+BigInt(x.amountAtomic),0n)),refunds:order.received.map(x=>x.event).sort()};return {type:'EVIDENCE',body,approvals:f.attesters.slice(0,2).map(k=>({key:k.publicKey,signature:sign(body,k.privateKey)}))};};
 return {...f,c,input,validators,s:origin(c),wire,refundIntent};
}
