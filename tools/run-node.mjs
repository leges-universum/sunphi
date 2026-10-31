import { spawn } from 'node:child_process';
import { readFileSync,existsSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { validateNodeLaunch } from '../src/node-launch-policy.mjs';
import { lockController } from '../src/controller-lock.mjs';
import {CertifiedSnapshot} from '../src/certified-snapshot.mjs';
import {validateBootstrapConfig} from '../src/snapshot-node-policy.mjs';
import {runVerifier} from '../src/history-io.mjs';
import {recoverNode} from '../src/node-recovery.mjs';
import {ReplayWatchdog} from './replay-watchdog.mjs';
// Start one PREPARED isolated node. Never generates/replaces a signing key.
const [homeArg,runtimeArg,baseArg]=process.argv.slice(2),base=Number(baseArg);
if(!homeArg||!runtimeArg||!Number.isInteger(base)||base<1024||base>65530)throw new Error('prepared node home, runtime directory, base port required');
const home=resolve(homeArg),runtime=resolve(runtimeArg);
const cfg=JSON.parse(readFileSync(join(home,'app-config.json'),'utf8'));
if(cfg.mode!=='isolated'||!cfg.chainId.startsWith('sunphi-lab-'))throw new Error('isolated chain only');
const toml=readFileSync(join(home,'config/config.toml'),'utf8');
validateNodeLaunch(cfg,toml,base);
// Cooperative single ownership before opening the application or signing state.
// Old binaries bypassing this guard must not be run against the same home.
const releaseOwner=lockController([join(home,'application.sqlite'),join(home,'data/priv_validator_state.json')]);
process.on('exit',releaseOwner);
const ext=process.platform==='win32'?'.exe':'',bin=join(runtime,'bin/sunphi-abci'+ext);
// Explicitly installed local profile only. Keep the original full-replay path
// for existing homes; never create a recovery anchor or reset signing state.
if(existsSync(join(home,'recovery-profile.json'))){
 const recovery=JSON.parse(readFileSync(join(home,'recovery-profile.json'))),genesis=JSON.parse(readFileSync(join(home,'config/genesis.json'))),abort=new AbortController();
 const cancel=()=>abort.abort(),ipc=m=>{if(m?.command==='stop')cancel();};process.on('SIGINT',cancel);process.on('SIGTERM',cancel);if(process.send){process.on('message',ipc);process.on('disconnect',cancel);}
 try{
  const result=await recoverNode(cfg,genesis,{...recovery.profile,verifier:bin},{batches:recovery.batches??1,signal:abort.signal,onProgress:p=>console.log(JSON.stringify({nodeRecovery:p}))});
  if(!result.ready)throw Error('node recovery incomplete; saved progress retained; fresh quorum required before launch');
 }finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);if(process.send){process.removeListener('message',ipc);process.removeListener('disconnect',cancel);}}
}
let consensusHeight;
if(existsSync(join(home,'bootstrap.json'))){
 const certified=await CertifiedSnapshot.open({bundlePath:join(home,'bootstrap.json'),genesisPath:join(home,'config/genesis.json'),bin,temporary:join(home,'bootstrap-verification')});
 validateBootstrapConfig(toml,certified,JSON.parse(readFileSync(join(home,'config/priv_validator_key.json'))).pub_key.value);
 consensusHeight=Number((await runVerifier(bin,['-bootstrap-state-height',home])).toString().trim());
 if(!Number.isSafeInteger(consensusHeight)||consensusHeight<0)throw Error('invalid consensus state height');
}
const children=[];let stopping=false;
function stop(){if(stopping)return;stopping=true;for(const p of children)p.kill('SIGTERM');setTimeout(()=>{for(const p of children)if(p.exitCode===null)p.kill('SIGKILL');},3000).unref();}
function launch(bin,args,ipc=false){const p=spawn(bin,args,{stdio:ipc?['inherit','inherit','inherit','ipc']:'inherit',windowsHide:true,env:{...process.env,O1JS_BACKEND:process.env.O1JS_BACKEND??(process.platform==='linux'?'native':'wasm'),RAYON_NUM_THREADS:process.env.RAYON_NUM_THREADS??'1',SUNPHI_PROVER_WORKERS:process.env.SUNPHI_PROVER_WORKERS??'1'}});children.push(p);p.on('error',()=>{process.exitCode=1;stop();});p.on('exit',()=>{if(!stopping){process.exitCode=1;stop();}});return p;}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
// Windows has no POSIX graceful SIGTERM. The owning desktop uses private IPC.
if(process.send){process.on('message',m=>{if(m?.command==='stop')stop();});process.on('disconnect',stop);process.channel.unref();}
const replay=new ReplayWatchdog();
const application=launch(process.execPath,[resolve('tools/abci-app.mjs'),home,String(base+3),bin,...(consensusHeight===undefined?[]:[String(consensusHeight)])],true);
application.on('message',m=>{if(!stopping&&m?.type==='verified-replay'&&replay.observe(m.height))console.log(JSON.stringify({verifiedReplayHeight:m.height}));});
let ready=false;while(!stopping&&!replay.expired){
 try{const r=await fetch(`http://127.0.0.1:${base+3}`,{method:'POST',body:'{"method":"info"}',signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}}catch{}
 await new Promise(r=>setTimeout(r,500));
}
if(!ready){stop();throw new Error('application did not finish verified replay within the progress/stall limit');}
launch(join(runtime,'bin/sunphi-abci'+ext),['-port',String(base+2),'-app',String(base+3)]);
await new Promise(r=>setTimeout(r,500));
if(!stopping)launch(join(runtime,'bin/cometbft'+ext),['start','--home',home]);
