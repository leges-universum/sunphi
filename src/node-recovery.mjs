import {readFileSync} from 'node:fs';
import {digest} from './protocol.mjs';
import {WalletNetwork} from './wallet-network.mjs';

export function validateRecoveryProfile(app,genesis,profile){
 if(app.mode!=='isolated'||profile.mode!=='isolated'||!genesis.chain_id?.startsWith('sunphi-lab-')||app.chainId!==genesis.chain_id||profile.policy?.chainId!==genesis.chain_id||digest(genesis.app_state)!==digest(app)||profile.policy.genesis!==digest(app)||digest(profile.policy.history)!==digest(app.history))throw Error('node recovery profile/genesis mismatch');
 const supplied=JSON.parse(readFileSync(profile.genesis));if(digest(supplied)!==digest(genesis))throw Error('node recovery genesis substitution');
 return true;
}

// Bounded driver. Only WalletNetwork's independent quorum/freshness check can
// finish this preflight; the persisted historical cursor cannot do so.
export async function driveRecovery(network,{batches=1,signal,onProgress=()=>{}}={}){
 if(!Number.isInteger(batches)||batches<1||batches>4096)throw Error('recovery batch budget');
 let result;
 for(let i=0;i<batches;i++){
  signal?.throwIfAborted();result=await network.recover();signal?.throwIfAborted();
  await onProgress({batch:i+1,ready:result.ready===true,checkpointEpoch:result.checkpointEpoch,verifiedHeight:result.verifiedHeight,recoveryHeight:result.recovery?.height??0,reason:result.reason});
  if(result.ready===true&&network.status.ready===true)return {ready:true,batches:i+1};
  // Yield to cancellation and other local work between bounded batches.
  await new Promise(r=>setTimeout(r,25));
 }
 return {ready:false,batches,reason:result?.reason??'fresh-quorum-required'};
}

export async function recoverNode(app,genesis,profile,options){
 validateRecoveryProfile(app,genesis,profile);const network=await WalletNetwork.open(profile);
 try{return await driveRecovery(network,options);}finally{network.close();}
}
