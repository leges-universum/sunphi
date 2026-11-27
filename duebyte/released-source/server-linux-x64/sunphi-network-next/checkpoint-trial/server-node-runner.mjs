// Full-history, non-voting Server participant. Reuses the existing authenticated
// profile, transport, bootstrap and operator; never starts Home reward admission.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {consumerRuntime} from './runtime-compatibility.mjs';
import {homeLaunchProfile,rememberHomeTransition} from './consumer-launch-profile.mjs';
import {stageTransitionProfile,verifiedTransitionDelivery} from './profile-delivery.mjs';
import {consumerTransportArgs} from './consumer-profile.mjs';
import {authenticateConsumerIndexedCheckpoint} from './consumer-indexed.mjs';
import {consumerNodeHome} from './consumer-home.mjs';
import {readBootstrapProgress} from './bootstrap-progress.mjs';
import {BoundedProcessLog,captureChildLog} from './bounded-process-log.mjs';
import {acquireStateAccess} from './state-access.mjs';
import {loadRelease,writeJSON} from './update-core.mjs';
import {verifyCheckpoint} from './checkpoint.mjs';
import {rpc} from './client.mjs';

export async function runServerNode(root,state){
 root=resolve(root);state=resolve(state);assert.equal(loadRelease(root).edition,'server');
 fs.mkdirSync(state,{recursive:true,mode:0o700});const unlock=acquireStateAccess(state),children=new Set(),controller=new AbortController();let stopping=false,node=null;
 const report=(phase,extra={})=>writeJSON(join(state,'server-progress.json'),{phase,updatedAt:Date.now(),...extra});
 const delay=ms=>new Promise(r=>setTimeout(r,ms));
 function launch(name,exe,args){const log=new BoundedProcessLog(join(state,name+'.log'));let child;try{child=spawn(exe,args,{stdio:['ignore','pipe','pipe']});}catch(e){log.close();throw e;}captureChildLog(child,log);children.add(child);child.once('error',()=>{});child.once('close',()=>children.delete(child));return child;}
 async function stop(){if(stopping)return;stopping=true;controller.abort(Error('node shutdown'));for(const c of children)c.kill('SIGTERM');}
 const term=()=>void stop();process.on('SIGTERM',term);process.on('SIGINT',term);
 try{
  let selected=homeLaunchProfile(root,state),runtime=await consumerRuntime(root,selected.profile,selected.pin),p=runtime.profile;
  let setup=await runtime.load('consumer-setup');setup.consumerIdentity(state,p,selected.pin);
  let delivery=null,candidate=null;
  if(selected.pin===loadRelease(root).networkPin){
   while(!stopping){
    try{
     delivery=await stageTransitionProfile({root,state});
     candidate=verifiedTransitionDelivery(delivery).profile;
     break;
    }catch(error){
     if(runtime.kind==='current')break;
     const expired=String(error.message).includes('expired/future profile');
     report('connecting',{message:expired?'Waiting for a renewed, signed network profile. Retrying automatically.':'Fetching the signed network profile. Retrying automatically.'});
     await new Promise(resolve=>{
      const finish=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',finish);resolve();};
      const timer=setTimeout(finish,10000);
      controller.signal.addEventListener('abort',finish,{once:true});
      if(controller.signal.aborted)finish();
     });
    }
   }
   if(stopping)return;
  }
  const transports=candidate??p;
  fs.writeFileSync(join(state,'known_hosts'),transports.hosts.map(h=>`[${h.ip}]:${h.port} ${h.pin}`).join('\n')+'\n',{mode:0o600});
  const links=transports.hosts.map(async(h,i)=>{while(!stopping){const child=launch('transport-'+i,'ssh',consumerTransportArgs(h,state));await new Promise(r=>child.once('close',r));if(!stopping)await delay(5000);}});
  let configured=false;
  while(!stopping&&!configured){
   report('connecting',{message:'Checking the signed network profile and current checkpoint.'});
   for(const url of p.rpcServers){if(stopping)break;try{
    const response=await rpc(url,'abci_query',{path:'/checkpoint'});assert(!response.response.code);const checkpoint=JSON.parse(Buffer.from(response.response.value,'base64'));verifyCheckpoint(checkpoint,p.policy);
    let evidence;
    if(candidate){try{evidence=await authenticateConsumerIndexedCheckpoint(candidate,checkpoint);}catch{continue;}selected=rememberHomeTransition(root,state,delivery);runtime=await consumerRuntime(root,selected.profile,selected.pin);p=runtime.profile;setup=await runtime.load('consumer-setup');setup.consumerIdentity(state,p,selected.pin);candidate=null;}
    // A new archive participant must use the current independently authenticated
    // schema. Never populate an obsolete V6 database while awaiting transition.
    assert.equal(runtime.kind,'current','Waiting for current signed network profile');
    assert(p.schemaUpgrade||p.fresh,'current archive profile required');
    evidence??=await authenticateConsumerIndexedCheckpoint(p,checkpoint);
    const homes=setup.prepareConsumer(state,p,selected.pin,checkpoint,evidence);
    report('synchronizing',{network:p.config.chainId,message:'Downloading and verifying complete network history.'});
    node=launch('node-supervisor',process.execPath,[join(import.meta.dirname,'operator.mjs'),'run',homes.node]);configured=true;break;
   }catch{}}
   if(!configured&&!stopping)await delay(5000);
  }
  while(!stopping&&node){
   assert(children.has(node),'Node process stopped; saved history and keys retained');
   assert.notEqual(readBootstrapProgress(consumerNodeHome(state))?.phase,'failed','History verification failed; saved data retained');
   try{const s=await rpc('http://127.0.0.1:'+(p.basePort+1),'status');assert.equal(s.node_info.network,p.config.chainId);assert.equal(String(s.validator_info.voting_power),'0','ordinary archive participant must not vote');
    const height=Number(s.sync_info.latest_block_height),age=Date.now()-Date.parse(s.sync_info.latest_block_time),ready=!s.sync_info.catching_up&&height>0&&age>=-30000&&age<180000;
    report(ready?'ready':'synchronizing',{network:p.config.chainId,height,peerId:s.node_info.id,bootstrap:readBootstrapProgress(consumerNodeHome(state)),message:ready?'Full-history node is connected. Paid work and validator admission retain their separate network requirements.':'Downloading and verifying complete network history.'});
   }catch{report('synchronizing',{network:p.config.chainId,bootstrap:readBootstrapProgress(consumerNodeHome(state)),message:'Waiting for the verified local node.'});}
   await delay(1500);
  }
  await stop();await Promise.all(links);
 }catch(e){report('failed',{message:'Node startup stopped. Saved keys and history are retained; review the local diagnostic log.'});throw e;}
 finally{
  await stop();const until=Date.now()+15000;while(children.size&&Date.now()<until)await delay(100);
  for(const child of children)child.kill('SIGKILL');
  while(children.size)await delay(25);process.off('SIGTERM',term);process.off('SIGINT',term);unlock();
 }
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){assert.equal(process.argv[2],'run');await runServerNode(resolve(import.meta.dirname,'../..'),process.argv[3]);}
