// Wallet links are payout instructions, not collateral ownership or node identity.
import {controllerContext} from './controller-context.mjs';
import {formatToken} from './token-units.mjs';
import {nodeCollateralStatus} from './wallet-collateral-status.mjs';
export function nodeLinkBlockers(s,id){
 const r=s.rewards?.nodes[id],messages=[];if(!r)return ['Node reward registration is not active.'];
 if(BigInt(r.earned)>BigInt(r.paid))messages.push('Previously earned rewards are awaiting payment.');
 const work=s.rewards.period.work[id];if(work&&Object.values(work).some(n=>BigInt(n)>0n))messages.push('Accepted work awaits period settlement.');
 const active=controllerContext(s.money)?.activeRequests?.()??Object.values(s.money.requests).filter(r=>['RESERVED','SCHEDULED'].includes(r.status));
 if(active.some(r=>r.intent.parts.some(p=>p.nodes.includes(id))))messages.push('Accepted payments have not finished.');
 if(s.centurySubsidy?.pending?.owners&&Object.hasOwn(s.centurySubsidy.pending.owners,id))messages.push('The current paid-work interval has not closed.');
 if(s.centurySubsidy?.pending?.home?.jobs?.[id]?.status==='accepted')messages.push('An accepted Home response awaits reward settlement.');
 if(s.rewards.fundedWork&&!s.rewards.fundedWork.closed&&Object.hasOwn(s.rewards.fundedWork.book.owners,id))messages.push('The funded-work period has not closed.');
 return messages;
}
export function nodeWalletStatus(s,id,owner=null){
 const r=s.rewards?.nodes[id],n=s.money.nodes[id],scale=s.money.unitScale??'1',payouts=r?.payouts??[],alerts=[];
 if(!payouts.length)alerts.push({code:'NO_PAYOUT_WALLET',message:'No payout wallet is linked. Confirmed earnings remain with the node.',action:'Link wallet'});
 const stake=BigInt(n?.stake??'0'),held=BigInt(n?.consensusHeld??'0')+BigInt(n?.taskHeld??'0'),free=stake>held?stake-held:0n;
 if(n&&stake===0n)alerts.push({code:'NO_COLLATERAL',message:'No collateral. New secured payment jobs are unavailable.',action:'Add collateral'});
 else if(n&&(free===0n||BigInt(n.tier)===0n||BigInt(n.consensusHeld)===0n))alerts.push({code:'COVERAGE_UNAVAILABLE',message:'Secured payment capacity is unavailable. Existing obligations remain.',action:'Review collateral'});
 return {id,kind:n?'server':'home',payouts,alerts,earned:r?.earned??'0',paid:r?.paid??'0',collateral:nodeCollateralStatus(s,id,owner),display:{stake:formatToken(String(stake),scale),free:formatToken(String(free),scale),pending:formatToken(String(BigInt(r?.earned??'0')-BigInt(r?.paid??'0')),scale)},changeBlockers:nodeLinkBlockers(s,id)};
}
