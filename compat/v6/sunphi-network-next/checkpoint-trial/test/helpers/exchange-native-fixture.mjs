import {keys,hash,digest,sign} from '../../crypto.mjs';
import {PROFILE,origin,envelope} from '../../core.mjs';
import {DOMAIN,policyId} from '../../payment-model.mjs';
import {UTC_OBLIGATIONS} from '../../obligation-clock.mjs';
import {EXCHANGE,exchangeAcceptance} from '../../research/exchange-escrow.mjs';
import {EXCHANGE_ACTION} from '../../research/exchange-native.mjs';
import {fundingFixture} from './exchange-funding-fixture.mjs';
export function exchangeFixture(time=1000,validators=Array.from({length:10},keys)){
 const provider=keys(),user=keys(),observers=Array.from({length:3},keys),members=Array.from({length:4},keys);
 const p={domain:EXCHANGE,isolated:true,chain:'duebyte-exchange-lab-native',provider:provider.publicKey,observers:observers.map(k=>k.publicKey),minGap:60,maxDuration:86400,routes:{BTC:{network:'bitcoin-regtest',genesis:hash('btc'),contract:'native',decimals:8},USDC:{network:'ethereum-local',genesis:hash('evm'),contract:'0x'+'3'.repeat(40),decimals:6}}};
 const inputs={provider:hash('provider inventory'),user:hash('user inventory')};
 const c={profile:PROFILE,chainId:'duebyte-trial-exchange-lab-native',trialOnly:true,obligationClock:UTC_OBLIGATIONS,
  initial:{domain:DOMAIN,policy:policyId,height:0,epoch:0,time,supply:'200000000',fees:'0',unitScale:'1000000',precisionHeight:1,outputs:{[inputs.provider]:{owner:provider.publicKey,value:'100000000',unlock:0},[inputs.user]:{owner:user.publicKey,value:'100000000',unlock:0}},requests:{},nodes:{}},
  control:{validators:validators.map((k,i)=>({key:k.publicKey,group:hash(['validator',i])})),policy:{version:1,members:members.map((k,i)=>({key:k.publicKey,group:hash(['policy',i])})),threshold:3,maxAge:3600,notAfter:time+86400}},exchangeLab:{policy:p,feeMicro:'1000'}};
 let serial=0;
 function order(direction='BUY_DUBYT',asset='BTC',at=time){
  const secret=hash(['secret',++serial]),q={domain:EXCHANGE+'/QUOTE',policyHash:hash(p),chain:p.chain,nonce:hash(['nonce',serial]),provider:provider.publicKey,user:user.publicKey,direction,asset,dubytAtomic:'10000001',externalAtomic:'123456',hashlock:digest(Buffer.from(secret,'hex')),createdAt:at,quoteUntil:at+300,dubytUntil:at+(direction==='BUY_DUBYT'?600:900),externalUntil:at+(direction==='BUY_DUBYT'?900:600),externalRecipient:asset==='BTC'?'bcrt1q'+'q'.repeat(40):'0x'+'4'.repeat(40),externalRefund:asset==='BTC'?'bcrt1q'+'p'.repeat(40):'0x'+'5'.repeat(40)};
  const id=hash(q),lock={type:'LOCK',quote:q,providerSignature:sign(q,provider.privateKey),userSignature:sign(exchangeAcceptance(q),user.privateKey)};
  const claim=(observedAt=at+20)=>{const body={domain:EXCHANGE+'/SETTLEMENT',policyHash:hash(p),order:id,asset,network:p.routes[asset].network,transaction:hash(['tx',id]),block:hash(['block',id]),amountAtomic:q.externalAtomic,recipient:q.externalRecipient,observedAt,expiresAt:observedAt+180};return {type:'CLAIM',id,secret,...(direction==='SELL_DUBYT'?{settlement:{body,signatures:observers.slice(0,2).map(k=>({observer:k.publicKey,signature:sign(body,k.privateKey)}))}}:{funding:fundingFixture(p,q,observers,observedAt)})};};
  return {q,id,secret,lock,claim,payer:direction==='BUY_DUBYT'?provider:user,input:inputs[direction==='BUY_DUBYT'?'provider':'user']};
 }
 const wire=(command,funding=[],key=user)=>Buffer.from(JSON.stringify(envelope(c,{type:EXCHANGE_ACTION,command,inputs:funding},key)));
 return {provider,user,observers,validators,p,c,inputs,s:origin(c),order,wire};
}
