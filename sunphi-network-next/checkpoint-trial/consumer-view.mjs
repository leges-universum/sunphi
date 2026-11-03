// Connection display is not payment authorization; the wallet verifies independently.
export function consumerView(s,now=Date.now()){
 const base={active:['connecting','reconnecting','checking-history','running','stopping'].includes(s.progress),working:false,connected:false,stage:'setup',title:'Ready to connect',message:'Connect this computer. Your device creates and keeps its own connection key.',button:'Connect'};
 if(s.progress==='failed')return {...base,title:'Connection needs attention',message:s.error||'Your saved keys and history are retained. Select Retry.',button:'Retry'};
 if(s.progress==='stopped')return {...base,title:'Connection stopped',message:'Your keys and history are saved. Select Connect to reconnect.'};
 if(s.progress==='stopping')return {...base,working:true,title:'Disconnecting',message:'Saving node state and stopping background services.'};
 if(s.progress==='connecting'||s.progress==='reconnecting')return {...base,working:true,stage:'review',title:s.progress==='reconnecting'?'Reconnecting':'Connecting',message:'Opening secure connections. Connection settings are handled automatically.'};
 if(s.progress==='checking-history'||s.progress==='running'){
  const r=s.rpc;if(r&&(r.chain!==s.network||String(r.votingPower)!=='0'))return {...base,title:'Unexpected node identity',message:'Disconnect this node. Its network or voting role does not match this installation.'};
  const age=r?now-Date.parse(r.time):NaN;
  if(r&&!r.catchingUp&&r.peers>0&&age>=-30000&&age<=90000)return {...base,connected:true,stage:'connect',title:'Connected',message:'Your node is following the network. The wallet verifies balances and payments independently.'};
  return {...base,working:true,stage:'connect',title:'Checking history',message:'Verifying and saving network history. You can keep using this window while verification continues.'};
 }
 return base;
}
