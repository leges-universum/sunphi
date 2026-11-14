// Owned background processes for the ordinary non-voting installation.
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,openSync,closeSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {validateConsumerProfile,consumerTransportArgs} from './consumer-profile.mjs';
import {consumerIdentity,prepareConsumer} from './consumer-setup.mjs';
import {consumerNodeHome} from './consumer-home.mjs';
import {authenticateConsumerIndexedCheckpoint} from './consumer-indexed.mjs';
import {rpc} from './client.mjs';
import {verifyCheckpoint} from './checkpoint.mjs';
import {BootstrapRecovery} from './bootstrap-recovery.mjs';
import {CatchupRecovery,corroboratesCatchup} from './catchup-recovery.mjs';
import {advertiseConsumerVersion} from './consumer-version.mjs';
import {nodeLogOffsets,nodeFailureMessage,bootstrapFailed} from './consumer-errors.mjs';
const [profileFile,expectedHash,stateArg]=process.argv.slice(2),state=resolve(stateArg),p=validateConsumerProfile(JSON.parse(readFileSync(profileFile)),expectedHash),here=import.meta.dirname;
const device=consumerIdentity(state,p,expectedHash),children=new Set(),links=new Map();let stopping=false,ready=false,walletReady=false,nodeProcess=null,walletProcess=null;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const recovery=new BootstrapRecovery(),catchupRecovery=new CatchupRecovery();let restartingNode=false,bootstrapOffsets={};
const report=(progress,extra={})=>process.send?.({progress,network:p.config.chainId,deviceId:device.id,walletReady,...extra});
function launch(name,exe,args,ipc=false){const fd=openSync(join(state,name+'.log'),'a',0o600);const c=spawn(exe,args,{windowsHide:true,stdio:ipc?['ignore',fd,fd,'ipc']:['ignore',fd,fd],env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});closeSync(fd);children.add(c);c.once('error',()=>{});c.once('close',()=>children.delete(c));return c;}
function startNode(home){const offsets=nodeLogOffsets(state);bootstrapOffsets=offsets;nodeProcess=launch('node-supervisor',process.execPath,[join(here,'operator.mjs'),'run',home]);nodeProcess.once('close',(code,signal)=>{if(!stopping&&!restartingNode){report('failed',{error:nodeFailureMessage(state,offsets,code,signal)});void stop();}});}
async function retryBootstrap(catchup=false){
 restartingNode=true;report('checking-history',{error:catchup?'Resuming fast history synchronization. Keys and verified data are retained.':'Retrying the initial history download. Keys and verified data are retained.'});
 const old=nodeProcess,closed=new Promise(r=>old.once('close',r));writeFileSync(join(consumerNodeHome(state),'stop.request'),'stop');
 await Promise.race([closed,delay(15000)]);assert(!children.has(old),'Node did not stop safely; retry cancelled');
 restartingNode=false;if(!stopping)startNode(consumerNodeHome(state));
}
async function stop(){if(stopping)return;stopping=true;report('stopping');
 if(nodeProcess&&existsSync(join(consumerNodeHome(state),'run-settings.json')))writeFileSync(join(consumerNodeHome(state),'stop.request'),'stop');
 for(const c of children)if(c!==nodeProcess)c.kill('SIGTERM');
 const until=Date.now()+15000;while(children.size&&Date.now()<until)await delay(100);
 for(const c of children)c.kill('SIGKILL');
 report('stopped');process.exit(0);
}
process.on('message',m=>{if(m?.command==='stop')void stop();else if(m?.command==='prepare-update'){if(walletProcess?.connected)walletProcess.send(m);else process.send?.({updateRequest:m.request,ready:!walletProcess});}else if(m?.command==='reward-wallets'){if(walletProcess?.connected)walletProcess.send(m);else process.send?.({rewardRequest:m.request,ok:false,error:'Wait for the wallet service to start.'});}});process.on('disconnect',()=>void stop());process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
async function link(index){while(!stopping){const c=launch('transport-'+index,'ssh'+(process.platform==='win32'?'.exe':''),consumerTransportArgs(p.hosts[index],state));links.set(index,c);await new Promise(r=>c.once('close',r));links.delete(index);if(!stopping){report('reconnecting');await delay(5000);}}}
for(let i=0;i<p.hosts.length;i++)void link(i);
report('connecting');
while(!stopping&&!ready){try{
 let checkpoint,evidence;for(const url of p.rpcServers){try{const r=await rpc(url,'abci_query',{path:'/checkpoint'});assert(!r.response.code);const doc=JSON.parse(Buffer.from(r.response.value,'base64'));verifyCheckpoint(doc,p.policy);const proof=p.indexed||p.fresh?await authenticateConsumerIndexedCheckpoint(p,doc):null;checkpoint=doc;evidence=proof;break;}catch{}}
 if(!checkpoint){report('reconnecting');await delay(5000);continue;}
 const homes=prepareConsumer(state,p,expectedHash,checkpoint,evidence);
 const releaseFile=resolve(here,'../../release-config.json');
 if(existsSync(releaseFile))advertiseConsumerVersion(homes.node,JSON.parse(readFileSync(releaseFile)).version);
 report('checking-history');
 startNode(homes.node);
 walletProcess=launch('wallet',process.execPath,[join(here,'wallet-server.mjs'),homes.wallet,String(p.walletPort),homes.trustHash,`http://127.0.0.1:${p.basePort+1}`],true);
 walletProcess.on('message',m=>{if(m?.ready===p.walletPort){walletReady=true;report('running',{walletPort:p.walletPort,nodePort:p.basePort+1});}else if(m?.rewardRequest||m?.updateRequest)process.send?.(m);else if(m&&Object.hasOwn(m,'rewards'))report('running',{rewards:m.rewards,rewardWallets:m.rewardWallets});});
 walletProcess.once('close',()=>{if(!stopping){report('failed',{error:'The wallet service stopped. Saved files are retained.'});void stop();}});
 ready=true;report('running',{walletPort:p.walletPort,nodePort:p.basePort+1});
 }catch(e){report('failed',{error:e.message});await stop();}}
while(!stopping){try{
 const r=await rpc(`http://127.0.0.1:${p.basePort+1}`,'status'),n=await rpc(`http://127.0.0.1:${p.basePort+1}`,'net_info');
 assert.equal(r.node_info.network,p.config.chainId,'unexpected running network');assert.equal(String(r.validator_info.voting_power),'0','ordinary node must not vote');
 // Existing local RPC observation only; no external telemetry or peer identities
 // are passed to the dashboard. Missing counters are unavailable, never zero.
 const trafficRate=direction=>{
  if(!Array.isArray(n.peers)||n.peers.length!==Number(n.n_peers))return null;
  const values=n.peers.map(peer=>peer.connection_status?.[direction]?.CurRate);
  if(values.some(v=>!['number','string'].includes(typeof v)||String(v).trim()===''||!Number.isSafeInteger(Number(v))||Number(v)<0))return null;
  const total=values.reduce((sum,v)=>sum+Number(v),0);return Number.isSafeInteger(total)?total:null;
 };
 const current={chain:r.node_info.network,height:r.sync_info.latest_block_height,time:r.sync_info.latest_block_time,catchingUp:r.sync_info.catching_up,votingPower:r.validator_info.voting_power,peers:Number(n.n_peers),traffic:{incoming:trafficRate('RecvMonitor'),outgoing:trafficRate('SendMonitor')}};
 const initialAction=recovery.observe(current,performance.now(),Number(current.height)===0&&bootstrapFailed(state,bootstrapOffsets)),catchupAction=catchupRecovery.observe(current),action=initialAction==='continue'?catchupAction:initialAction;
 if(action==='stop'){report('failed',{error:'Initial history download could not complete. Check your connection and select Connect to retry. Saved files are retained.'});await stop();}
 if(action==='restart'){
  // Existing authenticated transports corroborate that the network has moved
  // ahead. This is only a liveness hint, never a substitute for verification.
  const tips=catchupAction==='restart'?await Promise.allSettled(p.rpcServers.map(url=>rpc(url,'status'))):[];
  const confirmed=catchupAction!=='restart'||tips.some(t=>t.status==='fulfilled'&&corroboratesCatchup(current,t.value));
  if(confirmed){try{await retryBootstrap(catchupAction==='restart');}catch(e){report('failed',{error:e.message});await stop();}continue;}
 }
 report('running',{walletPort:p.walletPort,nodePort:p.basePort+1,error:null,rpc:current});
 }catch(e){catchupRecovery.interrupted();report('checking-history',{walletPort:p.walletPort,error:'Waiting for a verified local node.'});}await delay(1500);}
