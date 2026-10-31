// Display policy only. Never grants freshness, changes a balance or authorizes a payment.
export function verificationNotice(previous,{fresh=false,retry=false,attention=false}={},now=Date.now()){
 if(fresh)return {since:null,failures:0,attention:false};
 const s=previous??{since:null,failures:0,attention:false};
 return {since:retry||attention?s.since??now:s.since,failures:s.failures+(retry||attention?1:0),attention:s.attention||attention};
}
export function verificationNeedsAttention(s,now=Date.now()){
 return !!s?.attention||s?.since!=null&&s.failures>=3&&now-s.since>=120000;
}
