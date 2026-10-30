import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { validateNodeLaunch } from '../src/node-launch-policy.mjs';
import { lockController } from '../src/controller-lock.mjs';
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
const children=[];let stopping=false;
function stop(){if(stopping)return;stopping=true;for(const p of children)p.kill('SIGTERM');setTimeout(()=>{for(const p of children)if(p.exitCode===null)p.kill('SIGKILL');},3000).unref();}
function launch(bin,args){const p=spawn(bin,args,{stdio:'inherit',windowsHide:true,env:{...process.env,O1JS_BACKEND:process.env.O1JS_BACKEND??(process.platform==='linux'?'native':'wasm'),RAYON_NUM_THREADS:process.env.RAYON_NUM_THREADS??'1',SUNPHI_PROVER_WORKERS:process.env.SUNPHI_PROVER_WORKERS??'1'}});children.push(p);p.on('error',()=>{process.exitCode=1;stop();});p.on('exit',()=>{if(!stopping){process.exitCode=1;stop();}});return p;}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
// Windows has no POSIX graceful SIGTERM. The owning desktop uses private IPC.
if(process.send){process.on('message',m=>{if(m?.command==='stop')stop();});process.on('disconnect',stop);process.channel.unref();}
launch(process.execPath,[resolve('tools/abci-app.mjs'),home,String(base+3)]);
let ready=false;for(let i=0;i<180&&!stopping;i++){
 try{const r=await fetch(`http://127.0.0.1:${base+3}`,{method:'POST',body:'{"method":"info"}',signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}}catch{}
 await new Promise(r=>setTimeout(r,500));
}
if(!ready){stop();throw new Error('application did not finish verified replay');}
const ext=process.platform==='win32'?'.exe':'';
launch(join(runtime,'bin/sunphi-abci'+ext),['-port',String(base+2),'-app',String(base+3)]);
await new Promise(r=>setTimeout(r,500));
if(!stopping)launch(join(runtime,'bin/cometbft'+ext),['start','--home',home]);
