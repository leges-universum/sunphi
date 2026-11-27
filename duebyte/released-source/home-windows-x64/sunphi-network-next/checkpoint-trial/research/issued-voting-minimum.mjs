import {consensusAddress} from '../consensus-context.mjs';
import {V3_BALLOT,initialSchedule,advanceSchedule,ordinaryIssueTarget} from '../bonded-schedule-v3.mjs';
import {signingKey} from './bounded-pos-records.mjs';
import {calendarServiceIssued} from './calendar-service-custody.mjs';

export const ordinaryIssued=s=>String(calendarServiceIssued(s)+BigInt(s.centurySubsidy?.totalMintedMicro??'0'));
const micro=n=>String(BigInt(n)*1000000n);
const whole=n=>Number(BigInt(n)/1000000n);

export function advanceVotingMinimum(tx,s,request,ordinaryMicro,jailed){
 const roster=s.authority.posSlashing.voting,prior=s.authority.bondedAdmission,time=request.time;
 const signed=new Set(request.consensus.votes.filter(v=>v.flag===2).map(v=>v.address));
 const activeValidators=roster.validators.map(({key,power})=>{
  const r=tx.get(signingKey(consensusAddress(key)));
  const account=s.workerFunding.accounts[r.node];
  if(!account.votingBond)account.votingBond={validator:key,heldMicro:r.signing.bond};
  return {key,power,node:r.node};
 });
 const ready=minimum=>{
  if(roster.pending||roster.posNext||jailed.length)return false;
  let total=0,sufficient=0;
  for(const v of activeValidators){
   total+=v.power;
   if(signed.has(consensusAddress(v.key))&&BigInt(s.workerFunding.accounts[v.node].votingBond.heldMicro)>=BigInt(micro(minimum)))sufficient+=v.power;
  }
  return 3*sufficient>2*total;
 };
 const previous=prior?{current:whole(prior.minimumMicro),boundary:prior.boundary,next:prior.next?whole(prior.next.minimumMicro):null}:initialSchedule(time);
 const schedule=advanceSchedule(previous,time,ordinaryMicro,ready);
 const next=schedule===previous?(prior?.next??null):schedule.next===null?null:
  {minimumMicro:micro(schedule.next),announcedAt:time,effectiveAt:schedule.boundary};
 const deferred=schedule===previous?(prior?.deferred??null):
  schedule.next===null&&schedule.current<ordinaryIssueTarget(ordinaryMicro)?
   (roster.pending||roster.posNext||jailed.length?'ROSTER_CHANGING':'QUORUM_NOT_READY'):null;
 s.authority.bondedAdmission={version:3,ballot:V3_BALLOT,minimumMicro:micro(schedule.current),
  ordinaryIssuedMicro:ordinaryMicro,boundary:schedule.boundary,next,deferred,activeValidators};
 if(schedule.current>previous.current)
  return activeValidators.filter(v=>BigInt(s.workerFunding.accounts[v.node].votingBond.heldMicro)<BigInt(micro(schedule.current))).map(v=>v.key);
 return [];
}
