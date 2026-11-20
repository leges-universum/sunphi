// All public amounts here are whole DUBYT except the explicit issuance counter.
import assert from 'node:assert/strict';

export const V3_BALLOT='0eb6f080bddd352c980ddd920b8aec6d92b10646e5285fc15374e2a7e0f9bd01';
export const NOTICE_SECONDS=30*86400;
const spanMicro=1980000000n*1000000n;

export function ordinaryIssueTarget(ordinaryMicro){
  assert(typeof ordinaryMicro==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(ordinaryMicro),'ordinary issuance counter');
  const issued=BigInt(ordinaryMicro),x=issued<spanMicro?issued:spanMicro;
  return 100+Number(9900n*x*(2n*spanMicro-x)/(spanMicro*spanMicro));
}

export function nextMinimum(current,target){
  assert(Number.isInteger(current)&&current>=100&&current<=10000);
  assert(Number.isInteger(target)&&target>=100&&target<=10000);
  return current+Math.max(0,Math.min(target-current,Math.floor(current*3/100),15));
}

export function initialSchedule(time){
  assert(Number.isSafeInteger(time)&&time>0);
  return {current:100,boundary:time+NOTICE_SECONDS,next:null};
}

// Call on the first finalized block at or after a boundary using previous-state
// issuance and authenticated readiness for each prospective minimum.
export function advanceSchedule(state,time,ordinaryMicro,ready){
  assert(Number.isSafeInteger(time)&&time>0);
  if(time<state.boundary)return state;
  let current=state.current;
  const boundary=time+NOTICE_SECONDS;
  if(state.next!==null){
    if(!ready(state.next))return {current,boundary,next:null};
    current=state.next;
  }
  const step=nextMinimum(current,ordinaryIssueTarget(ordinaryMicro));
  return {current,boundary,next:step>current&&ready(step)?step:null};
}
