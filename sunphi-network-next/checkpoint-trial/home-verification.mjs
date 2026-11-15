// Presentation of an already verified client result, never an authorization.
// Comet signatures, retained ancestry and record proofs are checked by the
// existing VerifiedClient before this owned-process IPC message is constructed.
const assert=value=>{if(!value)throw Error('invalid verified Home observation');};
export const BOUNDED_HOME='bounded-verifier-v1';
export function homeVerification(view,network){
 const v=view.certificate,s=view.state;assert(s.height===v.appHeight);assert(v.height===v.appHeight+1);
 assert(Number.isSafeInteger(v.height)&&v.height>0&&/^[a-f0-9]{64}$/.test(v.blockHash)&&/^[a-f0-9]{64}$/.test(v.appHash));
 assert(Number.isSafeInteger(s.money.time)&&s.money.time>0);
 return {network,height:v.height,appHeight:v.appHeight,blockHash:v.blockHash,root:v.appHash,time:s.money.time*1000};
}
export function boundedHomeObservation(s,now=Date.now()){
 if(s.homeVerification!==BOUNDED_HOME)return null;const v=s.verification;
 if(!v||v.network!==s.network||!Number.isSafeInteger(v.height)||v.height<=0||v.appHeight!==v.height-1||!Number.isSafeInteger(v.time)||v.time<=0||!/^[a-f0-9]{64}$/.test(v.blockHash)||!/^[a-f0-9]{64}$/.test(v.root))return null;
 return {...v,current:now-v.time>=-30000&&now-v.time<=90000};
}
