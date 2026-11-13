// Synthetic observer evidence. Never use this helper as an external observer.
import {hash,sign} from '../../crypto.mjs';
import {EXCHANGE} from '../../research/exchange-escrow.mjs';
export function fundingFixture(p,q,observers,observedAt){
 const transaction=hash(['funding',hash(q)]),body={domain:EXCHANGE+'/FUNDING',policyHash:hash(p),order:hash(q),asset:q.asset,network:p.routes[q.asset].network,genesis:p.routes[q.asset].genesis,contract:p.routes[q.asset].contract,transaction,block:hash(['funding block',hash(q)]),escrow:q.asset==='BTC'?transaction+':0':'0x'+'6'.repeat(40)+':'+hash(q),amountAtomic:q.externalAtomic,recipient:q.externalRecipient,refundAddress:q.externalRefund,hashlock:q.hashlock,refundAt:q.externalUntil,status:'FUNDED',observedAt,expiresAt:observedAt+180};
 return {body,signatures:observers.slice(0,2).map(k=>({observer:k.publicKey,signature:sign(body,k.privateKey)}))};
}
