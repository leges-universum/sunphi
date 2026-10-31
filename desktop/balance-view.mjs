// Historical display data never grants payment authority. The backend still
// checks its monotonic freshness lease, signatures and discovery completeness.
export function balanceView(state,last=null,now=Date.now()){
 const b=state?.balance,n=state?.network;
 const fresh=!!n?.ready&&!!b?.complete&&now>=b.checkedAt&&now<b.validUntil&&now>=n.checkedAt&&now<n.validUntil;
 if(last?.address!==state?.address)last=null;
 if(fresh)last={address:state.address,available:b.available,height:b.height,checkedAt:b.checkedAt};
 return {fresh,last,value:fresh?b.available:last?.available??null,label:fresh?'Available balance':last?'Last verified balance':'Available balance',historical:!fresh&&!!last};
}
