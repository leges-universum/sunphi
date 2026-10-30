export function distributionPolicy(value,{nodeRequested=false,trialChain=null}={}){
 if(!value||value.version!==1||!['coin','network'].includes(value.defaultDirection)||!['native-trial',null].includes(value.nodeComponent))throw Error('Invalid distribution identity');
 if(value.nodeComponent==='native-trial'&&(value.nodeNetwork!=='sunphi-lab-wan-20261030-a'||trialChain!==value.nodeNetwork))throw Error('Node package and network profile differ');
 if(value.nodeComponent===null&&value.nodeNetwork!==null)throw Error('Wallet-only package cannot select a node network');
 if(nodeRequested&&value.nodeComponent!=='native-trial')throw Error('This wallet package has no node component. Obtain the node for your intended network.');
 return {nodeEdition:nodeRequested,defaultDirection:value.defaultDirection,nodeNetwork:value.nodeNetwork};
}
