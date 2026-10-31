import {fork,spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {deviceRequest,loadTrust,prepareFollower,transportArgs,trialBase} from '../src/trial-device.mjs';
import {lockController} from '../src/controller-lock.mjs';
const root=resolve(import.meta.dirname,'..'),[mode,stateArg]=process.argv.slice(2),state=resolve(stateArg??'.');
const progress=value=>{if(process.connected)process.send?.({progress:value});};
if(!stateArg)throw Error('Device state directory required');
const request=deviceRequest(root,state);
if(mode==='request'){console.log(JSON.stringify(request));process.exit(0);}
if(mode!=='connect')throw Error('Use request or connect');
const trust=loadTrust(root),release=lockController([join(state,'transport.lock')]);
process.on('exit',release);
// Refuse to attach to someone else's listener, including an older instance.
for(const p of [...trust.hosts.flatMap(h=>h.forwards.map(f=>f[0])),trialBase,trialBase+1,trialBase+2,trialBase+3])await new Promise((ok,no)=>{const s=createServer();s.once('error',()=>no(Error('Required local port is already in use: '+p)));s.listen(p,'127.0.0.1',()=>s.close(ok));});
const home=prepareFollower(root,state),links=new Map(),timers=new Set();let stopped=false,node=null;
progress('connecting');
function stop(){if(stopped)return;stopped=true;for(const t of timers)clearTimeout(t);for(const p of links.values())p.kill();if(node?.connected)node.send({command:'stop'});}
process.on('SIGINT',stop);process.on('SIGTERM',stop);if(process.send){process.on('message',m=>{if(m?.command==='stop')stop();});process.on('disconnect',stop);process.channel.unref();}
function connect(i){if(stopped)return;const p=spawn('ssh'+(process.platform==='win32'?'.exe':''),transportArgs(trust,i,state),{windowsHide:true,stdio:['ignore','ignore','pipe']});links.set(i,p);let error='';p.stderr.on('data',b=>error=(error+b).slice(-2000));p.on('error',()=>{error='OpenSSH client could not start';progress('ssh-missing');});p.on('close',()=>{links.delete(i);if(stopped)return;if(error.includes('Permission denied'))progress(trust.access==='automatic-follower'?'transport-unavailable':'approval');console.log(`Connection ${i+1} unavailable. ${error.includes('Permission denied')?(trust.access==='automatic-follower'?'Public transport authentication unavailable; retrying.':'Device approval is required.'):error.includes('could not start')?error:'Retrying pinned transport.'}`);const t=setTimeout(()=>{timers.delete(t);connect(i);},10000);timers.add(t);});}
for(let i=0;i<3;i++)connect(i);
console.log(trust.access==='automatic-follower'?'Connecting automatically as a non-voting follower. No administrator approval is required.':'Connecting to the trial. If approval is pending, send your public connection request to the operator.');
while(!stopped&&!node){
 for(const h of trust.hosts){try{const r=await fetch(`http://127.0.0.1:${h.rpc}/status`,{signal:AbortSignal.timeout(1000)}),j=await r.json();if(j.result.node_info.network!==trust.chain)throw Error('chain');
  if(stopped)break;progress('replay');node=fork(join(root,'tools/run-node.mjs'),[home,join(root,'runtime'),String(trialBase)],{cwd:root,execPath:process.execPath,windowsHide:true,stdio:['ignore','inherit','inherit','ipc'],env:{...process.env,SUNPHI_PROVER_WORKERS:'1',RAYON_NUM_THREADS:'1'}});node.on('error',()=>{process.exitCode=1;stop();});node.on('exit',()=>{if(!stopped){process.exitCode=1;stop();}});console.log('Transport connected. Replaying and verifying chain history; voting power remains zero.');break;
 }catch{}}
 if(!node&&!stopped)await new Promise(r=>setTimeout(r,1500));
}
