// Progress is presentation only, never evidence that a balance is spendable.
export function recoveryObservation(value,now=Date.now()){
 if(!value||!['checkpoint','headers','state','retry','complete'].includes(value.phase))return null;
 const {height,target,startedAt,updatedAt}=value;
 if(![height,target,startedAt,updatedAt].every(Number.isSafeInteger)||height<0||target<height||startedAt<=0||updatedAt<startedAt||updatedAt>now+30000)return null;
 return {phase:now-updatedAt>45000&&value.phase!=='complete'?'retry':value.phase,height,target,startedAt,updatedAt};
}
export function recoveryPresentation(value,now=Date.now()){
 const r=recoveryObservation(value,now);if(!r||r.phase==='complete')return null;
 const remaining=r.target-r.height;
 const title={checkpoint:'Checking for current network data',headers:'Verifying recent history',state:'Checking balances and rewards',retry:'Reconnecting — progress saved'}[r.phase];
 const detail=r.phase==='headers'?`Verified through block ${r.height.toLocaleString('en-US')} · ${remaining.toLocaleString('en-US')} remaining`:r.phase==='state'?'History verified. Checking the matching network records.':r.phase==='retry'?'Automatic retry continues. Previously verified progress is retained.':'Requesting a fresh signed network checkpoint.';
 return {...r,title,detail,waiting:true};
}
