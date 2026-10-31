// Display status is never payment authorisation. Wallet freshness gates remain separate.
export function nodeView(s,now=Date.now()){
 const active=['starting','running','stopping'].includes(s.phase),r=s.rpc;
 const automatic=s.access==='automatic-follower';
 const base={active,stage:'setup',title:'Ready to connect',message:automatic?'Connect automatically, then verify network history. No administrator approval is required.':'This older connection profile requires operator admission. Use the current Network release for automatic connection.',button:'Connect to Network',working:false,connected:false};
 if(s.phase==='stopping')return {...base,stage:'connect',title:'Disconnecting',message:'Stopping this node safely. Your keys and verified history are retained.',working:true};
 if(s.phase==='failed')return {...base,title:'Action required',message:'The connection could not start. Open Connection details for the reason, then select Retry.',button:'Retry'};
 if(!active)return {...base,...(s.phase==='stopped'?{title:'Connection stopped',message:'Your keys and verified history are saved. Select Connect to reconnect.',button:'Connect'}:{})};
 if(r){
  if(r.chain!=='sunphi-lab-wan-20261030-a'||String(r.votingPower)!=='0')return {...base,title:'Action required',message:'Unexpected node identity or network. Disconnect and contact the operator.'};
  const age=now-Date.parse(r.time),fresh=Number.isFinite(age)&&age>=-30000&&age<=90000;
  if(r.catchingUp)return {...base,stage:'connect',title:'Synchronizing',message:'Connected to the network. Checking and saving the missing history. You can keep this window open while it catches up.',working:true};
  if(!fresh||!r.peers)return {...base,stage:'connect',title:'Waiting for the network',message:'Your local history is retained. Waiting for peers and a recent block; reconnection is automatic.',working:true};
  return {...base,stage:'connect',title:'Connected',message:'Your computer is connected and following the network. Keep the app running and the computer online.',connected:true};
 }
 if(s.progress==='approval')return {...base,stage:'review',title:'Approval required',message:'This computer has not been admitted by the server. Save the public connection request and send it to SunPhi. Approval is checked automatically while this window is open.',working:true};
 if(s.progress==='ssh-missing')return {...base,title:'Windows component required',message:'OpenSSH Client could not start. Install OpenSSH Client in Windows Optional features, then reconnect.'};
 if(s.progress==='transport-unavailable')return {...base,stage:'review',title:'Reconnecting',message:'The network connection is temporarily unavailable. Retrying automatically; your saved history is retained.',working:true};
 return {...base,stage:s.progress==='replay'?'connect':'review',title:s.progress==='replay'?'Checking your history':'Connecting',message:s.progress==='replay'?'Connected. Starting the node and checking saved history. This can take several minutes.':'Opening secure network connections. The status updates automatically.',working:true};
}
