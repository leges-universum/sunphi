// Installation health is local runtime health, not completion of network catch-up.
// Only accept a fresh verified RPC report from the owned runner; opening a window
// or receiving an old wallet-ready event is insufficient.
export function homeRuntimeHealthy(message,chainId){
 const rpc=message?.rpc;
 return typeof chainId==='string'&&chainId.length>0&&message?.progress==='running'&&
  message.walletReady===true&&!message.error&&rpc?.chain===chainId&&
  rpc.votingPower==='0'&&typeof rpc.height==='string'&&/^[1-9][0-9]*$/.test(rpc.height)&&
  typeof rpc.catchingUp==='boolean';
}
