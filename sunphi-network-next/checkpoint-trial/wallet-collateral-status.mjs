// Read-only presentation of authenticated funding provenance. Payout links do
// not confer ownership; historical deposits do not prove a surviving balance.
import {formatToken} from './token-units.mjs';
import {V3_BALLOT,NOTICE_SECONDS,ordinaryIssueTarget,nextMinimum} from './bonded-schedule-v3.mjs';
import {lockedSupport} from './support-accounting.mjs';
import {availableWorkingStake,outsideCollateralPilot,preparedVotingMinimum} from './worker-collateral.mjs';
export {outsideCollateralPilot};
const min=(a,b)=>a<b?a:b,max=(a,b)=>a>b?a:b;
const bondedNetwork='5a6af5048049049bee003078f845ccea883140f291897f950007c5ba113a807c';
const wholeMicro=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value);
export function votingBondSchedule(s){
 if(s.configHash!==bondedNetwork||s.money.unitScale!=='1000000')return null;
 const p=s.authority?.bondedAdmission;
 if(!p)return {status:'proposed',target:null};
 if(p.version!==3||p.ballot!==V3_BALLOT||!wholeMicro(p.ordinaryIssuedMicro))return {status:'unavailable'};
 const target=ordinaryIssueTarget(p.ordinaryIssuedMicro);
 const current=p.minimumMicro,next=p.next;
 if(!wholeMicro(current)||BigInt(current)%1000000n!==0n)return {status:'unavailable'};
 const minimum=Number(BigInt(current)/1000000n);
 if(minimum<100||minimum>target)return {status:'unavailable'};
 if(next!==null&&(!next||!wholeMicro(next.minimumMicro)||BigInt(next.minimumMicro)%1000000n!==0n||
   BigInt(next.minimumMicro)<=BigInt(current)||BigInt(next.minimumMicro)>BigInt(nextMinimum(minimum,target))*1000000n||
   !Number.isSafeInteger(s.money.time)||!Number.isSafeInteger(next.announcedAt)||next.announcedAt<=0||next.announcedAt>s.money.time||
   !Number.isSafeInteger(next.effectiveAt)||next.effectiveAt>253402300799||
   next.effectiveAt-next.announcedAt<NOTICE_SECONDS))return {status:'unavailable'};
 return {status:'active',target:String(target),minimum:String(minimum),
   next:next&&{minimum:formatToken(next.minimumMicro,s.money.unitScale),announcedAt:next.announcedAt,effectiveAt:next.effectiveAt}};
}
export function votingBondNotice(s,id,owner,schedule){
 if(schedule?.status!=='active')return null;
 const bond=s.money.nodes[id]?.votingBond;
 if(!bond||bond.owner!==owner||!wholeMicro(bond.heldMicro))return null;
 const held=BigInt(bond.heldMicro),policy=s.authority.bondedAdmission;
 const now=BigInt(policy.minimumMicro),next=policy.next;
 if(held<now)return {amount:formatToken(String(now-held),s.money.unitScale),effectiveAt:null};
 if(next&&held<BigInt(next.minimumMicro))return {amount:formatToken(String(BigInt(next.minimumMicro)-held),s.money.unitScale),effectiveAt:next.effectiveAt};
 return null;
}
export function validatorParticipation(s,id,schedule){
 if(!schedule||schedule.status==='unavailable')return null;
 const node=s.money.nodes[id];
 if(!node)return null;
 const bond=node.votingBond;
 const held=bond?.heldMicro??'0';
 if(!wholeMicro(held))return null;
 const minimum=schedule.status==='proposed'?100000000n:BigInt(s.authority.bondedAdmission.minimumMicro);
 const gap=max(0n,minimum-BigInt(held));
 const roster=s.authority?.bondedAdmission?.activeValidators;
 const included=Array.isArray(roster)&&typeof bond?.validator==='string'&&roster.some(v=>v.node===id&&v.key===bond.validator&&v.power===1);
 const status=schedule.status==='proposed'?'beforeActivation':gap>0n?'shortfall':included?'active':'awaitingAdmission';
 return {status,gap:formatToken(String(gap),'1000000'),held:formatToken(held,'1000000'),height:s.height};
}
export function nodeCollateralStatus(s,id,owner){
 const n=s.money.nodes[id];if(!n)return null;
 const a=s.workerFunding?.accounts[id],owned=!!a&&a.owner===owner,tracked=owned&&Object.hasOwn(a,'initialStakeMicro');
 const stake=BigInt(n.stake),support=lockedSupport(s,id),deposited=owned?BigInt(a.depositedMicro):0n,withdrawn=owned?BigInt(a.withdrawnMicro??'0'):0n;
 const remaining=tracked?min(deposited-withdrawn,max(0n,stake-support-BigInt(a.initialStakeMicro))):owned?null:0n;
 const raw={total:stake,support,deposited,withdrawn,remaining,consensus:BigInt(n.consensusHeld),tasks:BigInt(n.taskHeld),capacity:max(0n,stake-BigInt(n.consensusHeld)-BigInt(n.taskHeld))};
 const display=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,v===null?null:formatToken(String(v),s.money.unitScale??'1')]));
 if(tracked)display.working= formatToken(String(availableWorkingStake(s,id)),s.money.unitScale??'1');
 const minimum=preparedVotingMinimum(s);
 const reviewVotingBond=Boolean(minimum && tracked && !a.release && remaining>=BigInt(minimum));
 return {owned,tracked,display,...(minimum?{reviewVotingBond}:{}),outsidePilot:outsideCollateralPilot(s,id),release:owned&&a.release?{amount:formatToken(a.release.valueMicro,s.money.unitScale??'1'),readyAt:a.release.readyAt}:null};
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
