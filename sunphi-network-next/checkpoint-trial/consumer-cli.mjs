// Linux consumer entry point: one owned runner, pinned profile, persistent keys.
import {fork} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import assert from 'node:assert/strict';
import {validateConsumerProfile} from './consumer-profile.mjs';
import {HomeUpdates,forwardHome,reportHomeBoot} from './home-updates.mjs';
import {homeRuntimeHealthy} from './home-boot-health.mjs';
import {setAutomaticUpdates} from './update-core.mjs';
const here=import.meta.dirname,root=resolve(here,'../..');
const pin=JSON.parse(readFileSync(join(root,'connection-pin.json'))).sha256,p=validateConsumerProfile(JSON.parse(readFileSync(join(root,'connection-profile.json'))),pin);
const state=join(process.env.XDG_STATE_HOME||join(homedir(),'.local/state'),'duebyte',p.config.chainId);mkdirSync(state,{recursive:true,mode:0o700});
for(const arg of process.argv.slice(2))if(arg.startsWith('--automatic-updates=')){const v=arg.split('=')[1];assert(['on','off'].includes(v));setAutomaticUpdates(state,v==='on');}
if(process.argv.includes('--stop')){if(existsSync(join(state,'node/run-settings.json')))writeFileSync(join(state,'node/stop.request'),'stop');console.log('Stop requested. Wallet and signing state retained.');process.exit(0);}
if(forwardHome(root,state,{connect:true}))process.exit(0);
const lock=join(state,'consumer.pid');if(existsSync(lock)){const pid=Number(readFileSync(lock));let alive=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}assert(!alive,'DueByte is already running; use the existing process');unlinkSync(lock);}writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
const runner=fork(join(here,'consumer-runner.mjs'),[join(root,'connection-profile.json'),pin,state],{stdio:['ignore','inherit','inherit','ipc']});let stopping=false,last='';
let stopped;const done=new Promise(r=>{stopped=r;}),requests=new Map();
const updates=new HomeUpdates({root,state,connected:()=>!stopping,prepare:()=>new Promise(resolve=>{const request=String(Date.now()),finish=ready=>{clearTimeout(timer);requests.delete(request);resolve(ready);},timer=setTimeout(()=>finish(false),5000);requests.set(request,finish);if(runner.connected)runner.send({command:'prepare-update',request});else finish(false);}),stop:async()=>{stop();await done;},quit:()=>process.exit(0)});
for(const arg of process.argv.slice(2))if(arg.startsWith('--automatic-updates=')){const v=arg.split('=')[1];assert(['on','off'].includes(v));updates.setAutomatic(v==='on');}
updates.start();let announcedUpdate='';const updateNotice=setInterval(()=>{const s=updates.snapshot(),label=s.phase+' '+s.message;if(label!==announcedUpdate){announcedUpdate=label;console.log('DueByte Home updates: '+s.message);}},10000);updateNotice.unref();
runner.on('message',m=>{if(m?.updateRequest)requests.get(m.updateRequest)?.(m.ready===true);if(homeRuntimeHealthy(m,p.config.chainId))reportHomeBoot(root,state);});
runner.on('message',m=>{if(m.progress!==last){last=m.progress;console.log('DueByte: '+last+(m.error?' — '+m.error:''));}if(m.walletReady&&!stopping&&!globalThis.walletAnnounced){globalThis.walletAnnounced=true;console.log('Wallet (this computer only): http://127.0.0.1:'+p.walletPort+'/');}});
const stop=()=>{if(!stopping){stopping=true;if(runner.connected)runner.send({command:'stop'});}};process.on('SIGINT',stop);process.on('SIGTERM',stop);
runner.on('error',e=>{console.error(e.message);process.exitCode=1;});runner.on('close',code=>{if(existsSync(lock)&&readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);process.exitCode=code??1;stopped();});
