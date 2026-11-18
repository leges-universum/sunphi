// Server-side countersignature using independently verified local network state.
// Does not submit, move funds, expose a wallet, or accept a remote shell command.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {hash} from './crypto.mjs';
import {VerifiedClient,rpc} from './client.mjs';
import {stateHash} from './core.mjs';
import {readWalletProfile} from './wallet-profile.mjs';
import {assertBoundedServiceView,isBoundedServiceView} from './research/bounded-wallet-view.mjs';
import {verifyNodeLink,approveNodeLink,pairingCode} from './node-wallet-link.mjs';
import {NODE_ALERTS,verifyNodeAlertConsent,approveNodeAlerts,alertPairingCode} from './node-alerts.mjs';
const [home,profile,url,binary,keyFile,policyPin,requestFile,output]=process.argv.slice(2);
assert(home&&profile&&url&&binary&&keyFile&&policyPin&&requestFile&&output,'HOME PROFILE LOOPBACK_RPC VERIFIER MANAGEMENT_KEY_FILE POLICY_HASH REQUEST_FILE OUTPUT_FILE required');
const endpoint=new URL(url);assert(endpoint.protocol==='http:'&&endpoint.hostname==='127.0.0.1'&&!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash&&endpoint.pathname==='/','Use the server local RPC only.');
const read=f=>JSON.parse(readFileSync(join(profile,f))),policy=read('trust-policy.json');assert.equal(hash(policy),policyPin,'Independent policy hash required.');
const raw=readFileSync(requestFile);assert(raw.length<=12000,'Pairing request too large.');const request=JSON.parse(raw),bounded=readWalletProfile(profile);
const client=new VerifiedClient({home,config:read('app-config.json'),policy,genesisFile:join(profile,'genesis.json'),binary,...(bounded?{bounded}:{})});
async function current(){const q=await rpc(url,'abci_query',{path:'/checkpoint'});assert(!q.response.code,'Checkpoint unavailable.');const v=await client.sync(JSON.parse(Buffer.from(q.response.value,'base64')),url,bounded?{service:true}:{});
 if(isBoundedServiceView(v.state))assertBoundedServiceView(v.state,v.certificate,client.config);else assert.equal(stateHash(v.state,client.config),v.certificate.appHash);
 assert.equal(v.state.height,v.certificate.appHeight);return v.state;
}
try{const alerts=request.body?.domain===NODE_ALERTS,state=await current(),body=alerts?verifyNodeAlertConsent(request,{root:{network:client.config.chainId},configHash:hash(client.config)},Math.floor(Date.now()/1000)):verifyNodeLink(state,request),matching=alerts?alertPairingCode(body):pairingCode(body);
 if(alerts){assert.equal(state.rewards?.nodes[body.node]?.management,body.management);console.log('Enable server notices for Sun-Phi account: '+body.account+'\nThis survives payout-wallet unlink. It cannot approve payments or spend funds.');}
 console.log('DueByte server '+(alerts?'alerts':('wallet '+body.operation))+'\nNode: '+body.node+'\nWallet: '+body.wallet+'\nMatch this code in your wallet: '+matching+'\nCollateral ownership and existing balances do not change.');
 if(!alerts&&!body.payouts.length)console.log('No payout wallet will remain. Confirmed future earnings will wait for a new link.');
 assert(process.stdin.isTTY,'Interactive operator confirmation required.');const input=createInterface({input:process.stdin,output:process.stdout});let code;try{code=(await input.question('Enter the matching code to approve, or press Enter to cancel: ')).trim();}finally{input.close();}
 assert.equal(code,matching,'Cancelled or incorrect code.');
 const fresh=await current(),key=JSON.parse(readFileSync(keyFile)),action=alerts?approveNodeAlerts(fresh,client.config.chainId,request,key,code,Math.floor(Date.now()/1000)):approveNodeLink(fresh,request,key,code);
 writeFileSync(output,JSON.stringify(action,null,2),{flag:'wx',mode:0o600});console.log('Approval saved. Import it in the wallet. Nothing submitted to the network.');
}finally{client.close();}
