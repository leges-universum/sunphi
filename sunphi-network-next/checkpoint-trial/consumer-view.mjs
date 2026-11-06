// Connection display is not payment authorization; the wallet verifies independently.
export function consumerView(s,now=Date.now()){
 const base={active:['connecting','reconnecting','checking-history','running','stopping'].includes(s.progress),working:false,connected:false,stage:'setup',title:'Ready to connect',message:'Connect this computer. Your device creates and keeps its own connection key.',button:'Connect'};
 if(s.statusUnavailable)return {...base,title:'Status unavailable',message:'The latest node status could not be read. Checking again automatically.'};
 if(s.configured===false)return {...base,title:'Connection setup unavailable',message:'Reopen DueByte from its complete installation folder.'};
 if(s.progress==='failed')return {...base,title:'Connection needs attention',message:s.error||'Your saved keys and history are retained. Select Retry.',button:'Retry'};
 if(s.progress==='stopped')return {...base,title:'Connection stopped',message:'Your keys and history are saved. Select Connect to reconnect.'};
 if(s.progress==='stopping')return {...base,working:true,title:'Disconnecting',message:'Saving node state and stopping background services.'};
 if(s.progress==='connecting'||s.progress==='reconnecting')return {...base,working:true,stage:'review',title:s.progress==='reconnecting'?'Reconnecting':'Connecting',message:'Opening secure connections. Connection settings are handled automatically.'};
 if(s.progress==='checking-history'||s.progress==='running'){
  const r=s.rpc;if(r&&(r.chain!==s.network||String(r.votingPower)!=='0'))return {...base,title:'Unexpected node identity',message:'Disconnect this node. Its network or voting role does not match this installation.'};
  const age=r?now-Date.parse(r.time):NaN;
  if(s.error)return {...base,working:true,stage:'connect',title:'Checking connection',message:'Waiting for a current update from your local node.'};
  if(r&&!r.catchingUp&&r.peers>0&&age>=-30000&&age<=90000)return {...base,connected:true,stage:'connect',title:'Connected',message:'Your node is following the network. The wallet verifies balances and payments independently.'};
  return {...base,working:true,stage:'connect',title:'Checking history',message:'Verifying and saving network history. You can keep using this window while verification continues.'};
 }
 return base;
}

// User-facing facts derived only from the existing local status contract.
// A verified history height is not a paid-work receipt or a wallet balance.
export function consumerDashboard(s,now=Date.now()){
 const v=consumerView(s,now),r=s.rpc;
 const d={...v,health:'Not connected',workTitle:'Waiting to start',workMessage:'Connect this computer to begin checking network history.',actionTitle:'Connect your computer',actionMessage:'Select Connect. DueByte will set up the connection and check network history automatically.',waiting:false};
 if(s.statusUnavailable)return {...d,waiting:['connecting','reconnecting','checking-history','running'].includes(s.progress),health:'Status unavailable',workTitle:'Waiting for a status update',workMessage:'Current activity cannot be confirmed until the local node responds.',actionTitle:'Wait for the status to refresh',actionMessage:'DueByte is checking again automatically. If this message remains, open Connection details for the error.'};
 if(s.configured===false)return {...d,actionTitle:'Check your installation',actionMessage:'Reopen DueByte from its complete installation folder. Connection settings must be available before you can start.'};
 if(s.progress==='failed')return {...d,health:'Needs attention',workTitle:'Work interrupted',workMessage:'Current verification is not confirmed. Your saved history is retained.',actionTitle:'Check the connection and retry',actionMessage:'Check your internet connection, then select Retry. Connection details contains the reported error.'};
 if(v.title==='Unexpected node identity')return {...d,health:'Needs attention',workTitle:'Verification cannot be confirmed',workMessage:'This node does not match the expected network or role.',actionTitle:'Disconnect this node',actionMessage:'Select Disconnect and check Connection details before reconnecting.'};
 if(s.progress==='stopping')return {...d,health:'Stopping',workTitle:'Finishing this session',workMessage:'Saving node state before stopping background services.',actionTitle:'Please wait',actionMessage:'Wait for the node to stop before closing the application.'};
 if(s.progress==='stopped')return {...d,workTitle:'Verification paused',workMessage:'Saved history is retained for the next connection.',actionTitle:'Reconnect when you are ready',actionMessage:'Select Connect to resume checking network history.'};
 if(v.connected)return {...d,health:'Up to date',title:'Your node is running',message:'Your computer is following the network and checking new generations.',workTitle:'Checking new network history',workMessage:'Your computer maintains a verified local history and checks new generations as they arrive.',actionTitle:'Checking new generations',actionMessage:''};
 if(v.active){
  const matching=r&&r.chain===s.network&&String(r.votingPower)==='0';
  const age=matching?now-Date.parse(r.time):NaN;
  const interrupted=s.progress==='reconnecting'||s.error||(matching&&(r.peers===0||(!r.catchingUp&&(!Number.isFinite(age)||age>90000||age< -30000))));
  if(interrupted)return {...d,waiting:true,health:'Checking connection',title:'Restoring current updates',message:'Your node is waiting for a current network update. Automatic checks continue.',workTitle:'Waiting for current network data',workMessage:'New verification cannot be confirmed yet. Saved history is retained.',actionTitle:'Please wait — connection in progress',actionMessage:'Keep DueByte open while your node connects and synchronises network history. This screen will update automatically.'};
  return {...d,health:'In progress',waiting:true,workTitle:matching?'Checking saved network history':'Preparing verification',workMessage:matching?'Your computer is downloading and verifying network history before following new updates.':'Verification begins after a connection to the network is established.',actionTitle:'Please wait — connection in progress',actionMessage:'Keep DueByte open while your node connects and synchronises network history. This screen will update automatically.'};
 }
 return d;
}

// Bounded session-only observations of an already synchronised, verified chain.
// No peer count, catch-up speed, payment volume or network-size inference.
export class NetworkActivity {
 constructor(){this.reset();}
 reset(){this.baseline=null;this.points=[];this.visible=false;this.revision=(this.revision||0)+1;}
 observe(s,now=Date.now()){
  if(!consumerView(s,now).connected){if(this.visible)this.reset();return;}
  const height=Number(s.rpc.height),time=Date.parse(s.rpc.time);
  if(!Number.isSafeInteger(height)||height<0||!Number.isFinite(time)){this.reset();return;}
  this.visible=true;
  if(!this.baseline){this.baseline={height,time,now};return;}
  const b=this.baseline,elapsed=now-b.now,delta=height-b.height;
  // Resume after a suspended renderer starts a new observation window.
  if(elapsed<0||elapsed>45000||delta<0||time<b.time||(delta>0&&time===b.time)){
   this.reset();this.visible=true;this.baseline={height,time,now};return;
  }
  if(elapsed<15000)return;
  const traffic=direction=>{const value=s.rpc.traffic?.[direction];return typeof value==='number'&&Number.isFinite(value)&&value>=0?value/1024:null;};
  this.points.push({at:now,rate:delta*60000/elapsed,interval:delta>0?(time-b.time)/delta/1000:null,incoming:traffic('incoming'),outgoing:traffic('outgoing'),generations:delta,seconds:elapsed/1000});
  this.points=this.points.filter(p=>now-p.at<300000).slice(-20);
  this.baseline={height,time,now};this.revision++;
 }
}
