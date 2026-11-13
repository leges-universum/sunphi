import {exchangeFixture} from './exchange-native-fixture.mjs';
import {origin} from '../../core.mjs';
import {hash,sign} from '../../crypto.mjs';
import {exchangeAcceptance} from '../../research/exchange-escrow.mjs';
import {EXCHANGE_V2,armAcceptance} from '../../research/exchange-resolution.mjs';
export function resolutionFixture(time=1000){
 const f=exchangeFixture(time);f.p.domain=EXCHANGE_V2;f.s=origin(f.c);const oldOrder=f.order;
 f.arm=(q,plan)=>({type:'ARM',id:hash(q),plan,providerSignature:sign(armAcceptance(q,plan),f.provider.privateKey),userSignature:sign(armAcceptance(q,plan),f.user.privateKey)});
 f.signReceipt=body=>({body,signatures:f.observers.slice(0,2).map(k=>({observer:k.publicKey,signature:sign(body,k.privateKey)}))});
 f.order=(direction='BUY_DUBYT',asset='BTC',at=time)=>{
  const old=oldOrder(direction,asset,at),q={...old.q,domain:EXCHANGE_V2+'/QUOTE',policyHash:hash(f.p)},id=hash(q);
  const plan={domain:EXCHANGE_V2+'/PLAN',order:id,asset,...(asset==='BTC'?{fundingTransaction:hash(['fund',id]),index:0,claimKey:'02'+'11'.repeat(32),refundKey:'03'+'22'.repeat(32),feeAtomic:'1000'}:{escrow:'0x'+'6'.repeat(40),codeHash:hash('code')})};
  const lock={type:'LOCK',quote:q,providerSignature:sign(q,f.provider.privateKey),userSignature:sign(exchangeAcceptance(q),f.user.privateKey)};
  return {...old,q,id,plan,lock,arm:f.arm(q,plan),resolve(status='PAYOUT',now=at+1000){const body={domain:EXCHANGE_V2+'/RESOLUTION',policyHash:hash(f.p),order:id,planHash:hash(plan),asset,network:f.p.routes[asset].network,genesis:f.p.routes[asset].genesis,contract:f.p.routes[asset].contract,escrow:asset==='BTC'?plan.fundingTransaction+':0':plan.escrow+':'+id,status,transaction:hash([id,status]),block:hash(['block',id,status]),amountAtomic:q.externalAtomic,recipient:status==='PAYOUT'?q.externalRecipient:q.externalRefund,refundAddress:q.externalRefund,executedAt:status==='PAYOUT'?at+20:q.externalUntil+1,observedAt:now,expiresAt:now+120};return {type:'RESOLVE',id,receipt:f.signReceipt(body)};}};
 };
 return f;
}
