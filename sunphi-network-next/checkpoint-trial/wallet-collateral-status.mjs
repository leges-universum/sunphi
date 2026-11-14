// Read-only presentation of authenticated funding provenance. Payout links do
// not confer ownership; historical deposits do not prove a surviving balance.
import {formatToken} from './token-units.mjs';
import {lockedSupport} from './support-accounting.mjs';
const min=(a,b)=>a<b?a:b,max=(a,b)=>a>b?a:b;
export function nodeCollateralStatus(s,id,owner){
 const n=s.money.nodes[id];if(!n)return null;
 const a=s.workerFunding?.accounts[id],owned=!!a&&a.owner===owner,tracked=owned&&Object.hasOwn(a,'initialStakeMicro');
 const stake=BigInt(n.stake),support=lockedSupport(s,id),deposited=owned?BigInt(a.depositedMicro):0n,withdrawn=owned?BigInt(a.withdrawnMicro??'0'):0n;
 const remaining=tracked?min(deposited-withdrawn,max(0n,stake-support-BigInt(a.initialStakeMicro))):owned?null:0n;
 const raw={total:stake,support,deposited,withdrawn,remaining,consensus:BigInt(n.consensusHeld),tasks:BigInt(n.taskHeld),capacity:max(0n,stake-BigInt(n.consensusHeld)-BigInt(n.taskHeld))};
 const display=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,v===null?null:formatToken(String(v),s.money.unitScale??'1')]));
 return {owned,tracked,display,release:owned&&a.release?{amount:formatToken(a.release.valueMicro,s.money.unitScale??'1'),readyAt:a.release.readyAt}:null};
}
export function walletCollateralSummary(s,owner){
 const ids=Object.keys(s.workerFunding?.accounts??{}).filter(id=>s.workerFunding.accounts[id].owner===owner);
 let deposited=0n,withdrawn=0n,remaining=0n,complete=true;
 for(const id of ids){const a=s.workerFunding.accounts[id],n=s.money.nodes[id];deposited+=BigInt(a.depositedMicro);withdrawn+=BigInt(a.withdrawnMicro??'0');
  if(!n||!Object.hasOwn(a,'initialStakeMicro')){complete=false;continue;}
  remaining+=min(BigInt(a.depositedMicro)-BigInt(a.withdrawnMicro),max(0n,BigInt(n.stake)-lockedSupport(s,id)-BigInt(a.initialStakeMicro)));
 }
 const fmt=v=>formatToken(String(v),s.money.unitScale??'1'),f=s.centuryFunds?.manifest?.founder,x=s.centuryFunds?.execution;
 const founder=f?.recipient===owner?{total:fmt(f.totalMicro),released:fmt(x?.founderReleasedMicro??'0'),remaining:fmt(BigInt(f.totalMicro)-BigInt(x?.founderReleasedMicro??'0')),fullyIssued:!!x&&!x.partialWarmupMicro}:null;
 return {nodes:ids.length,deposited:fmt(deposited),withdrawn:fmt(withdrawn),remaining:complete?fmt(remaining):null,founder};
}
